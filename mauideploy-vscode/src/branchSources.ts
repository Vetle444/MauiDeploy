import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitRepository, resolveCommit, runGit } from './worktrees';

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
    host: string;
    owner: string;
    name: string;
    url: string;
}

export interface PullRequestReference {
    repository: RepositoryIdentity;
    number: number;
}

export interface PullRequestHead {
    commit: string;
    repository: RepositoryIdentity;
}

export interface BranchReference {
    name: string;
    remote?: string;
}

export function parseRepositoryUrl(value: string): RepositoryIdentity {
    const scp = /^[^@\s/:]+@([^/\s:]+):(.+)$/.exec(value);
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.search || url.hash) {
        throw new Error('Use an HTTPS or SSH GitHub repository URL.');
    }
    const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length !== 2 || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '..' || part === '.')) {
        throw new Error('The repository URL must contain an owner and repository name.');
    }
    const host = url.hostname.toLowerCase();
    const owner = parts[0];
    const name = parts[1];
    return { host, owner, name, url: `https://${host}/${owner}/${name}` };
}

export function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
    return left.url.toLowerCase() === right.url.toLowerCase();
}

export async function listMatchingRemotes(
    repository: GitRepository,
    expected: RepositoryIdentity,
    signal?: AbortSignal
): Promise<string[]> {
    const names = (await runGit(repository.root, ['remote'], signal)).split('\n').filter(Boolean);
    const matches: string[] = [];
    for (const remote of names) {
        const url = await runGit(repository.root, ['remote', 'get-url', remote], signal);
        let identity: RepositoryIdentity;
        try {
            identity = parseRepositoryUrl(url);
        } catch {
            continue;
        }
        if (sameRepository(identity, expected)) { matches.push(remote); }
    }
    return matches;
}

export function parsePullRequestUrl(value: string): PullRequestReference {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('Use an HTTPS GitHub pull request URL without credentials.');
    }
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits|checks))?\/?$/.exec(url.pathname);
    if (!match) { throw new Error('Use a GitHub pull request URL such as https://github.com/owner/repo/pull/123.'); }
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number)) { throw new Error('Invalid pull request number.'); }
    return { repository: parseRepositoryUrl(`https://${url.host}/${match[1]}/${match[2]}`), number };
}

export function parseDeployLink(value: string, scheme: string): PullRequestReference {
    const url = new URL(value);
    if (url.protocol !== `${scheme}:` || url.host.toLowerCase() !== 'finstadproductions.maui-deploy' ||
        url.pathname !== '/deploy-pr' || url.username || url.password || url.hash) {
        throw new Error('Unsupported MauiDeploy link.');
    }
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || !keys.includes('repo') || !keys.includes('pr')) {
        throw new Error('A deploy link must contain only repo and pr parameters.');
    }
    const repository = parseRepositoryUrl(url.searchParams.get('repo')!);
    return parsePullRequestUrl(`${repository.url}/pull/${url.searchParams.get('pr')}`);
}

export function createPullRequestLink(
    value: string,
    bridge = 'https://vetle444.github.io/MauiDeploy/deploy/',
    insiders = false
): string {
    const reference = parsePullRequestUrl(value);
    const url = new URL(bridge);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('The PR link bridge must be an HTTPS URL without credentials, query or fragment.');
    }
    const parameters = new URLSearchParams({ repo: reference.repository.url, pr: String(reference.number) });
    if (insiders) { parameters.set('editor', 'vscode-insiders'); }
    url.hash = parameters.toString();
    return url.toString();
}

export async function listBranches(repository: GitRepository, remote: string, signal?: AbortSignal): Promise<BranchReference[]> {
    const local = await runGit(repository.root, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/'], signal);
    const branches: BranchReference[] = local.split('\n').filter(Boolean).map(name => ({ name }));
    const advertised = await runGit(repository.root, ['ls-remote', '--heads', '--refs', '--', remote], signal);
    for (const line of advertised.split('\n')) {
        const reference = line.split('\t')[1];
        if (reference?.startsWith('refs/heads/')) {
            branches.push({ name: reference.slice('refs/heads/'.length), remote });
        }
    }
    return branches.sort((left, right) => {
        const nameOrder = left.name.localeCompare(right.name);
        if (nameOrder !== 0) { return nameOrder; }
        if (left.remote && !right.remote) { return -1; }
        if (!left.remote && right.remote) { return 1; }
        return 0;
    });
}

export async function resolveBranchCommit(repository: GitRepository, branch: BranchReference, signal?: AbortSignal): Promise<string> {
    if (branch.name.startsWith('-')) { throw new Error('Invalid branch name.'); }
    const reference = `refs/heads/${branch.name}`;
    await runGit(repository.root, ['check-ref-format', reference], signal);
    if (branch.remote) { return fetchCommit(repository, branch.remote, reference, signal); }
    return resolveCommit(repository, reference, signal);
}

export async function fetchCommit(repository: GitRepository, remote: string, reference: string, signal?: AbortSignal): Promise<string> {
    await runGit(repository.root, ['check-ref-format', reference], signal);
    const privateReference = `refs/mauideploy/fetch/${randomUUID()}`;
    try {
        await runGit(repository.root, [
            'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', '--', remote,
            `+${reference}:${privateReference}`
        ], signal);
        return await resolveCommit(repository, privateReference, signal);
    } finally {
        await runGit(repository.root, ['update-ref', '-d', privateReference]);
    }
}

export async function getPullRequestHead(reference: PullRequestReference, signal?: AbortSignal): Promise<PullRequestHead> {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync('gh', [
            'api', '--hostname', reference.repository.host,
            `repos/${reference.repository.owner}/${reference.repository.name}/pulls/${reference.number}`
        ], {
            encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal,
            env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
        }));
    } catch (error) {
        if (signal?.aborted) { throw error; }
        throw new Error(`Cannot read PR #${reference.number}. Install GitHub CLI and run gh auth login --hostname ${reference.repository.host}.`);
    }
    const data = JSON.parse(stdout);
    if (!sameRepository(parseRepositoryUrl(data.base?.repo?.html_url), reference.repository) ||
        !/^[a-f0-9]{40,64}$/.test(data.head?.sha)) {
        throw new Error('GitHub returned an unexpected pull request repository or commit.');
    }
    return { commit: data.head.sha, repository: parseRepositoryUrl(data.head?.repo?.html_url) };
}

export async function fetchPullRequestCommit(
    repository: GitRepository,
    remote: string,
    reference: PullRequestReference,
    head: PullRequestHead,
    signal?: AbortSignal
): Promise<string> {
    const commit = await fetchCommit(repository, remote, `refs/pull/${reference.number}/head`, signal);
    if (commit !== head.commit) {
        throw new Error('The PR changed while it was being fetched. Deploy again to use its new commit.');
    }
    return commit;
}