import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitRepository {
    root: string;
    commonDirectory: string;
    worktreePath: string;
}

export async function runGit(directory: string, args: string[], signal?: AbortSignal): Promise<string> {
    const result = await execFileAsync('git', ['--no-optional-locks', '-C', directory, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        signal
    });
    return result.stdout.trimEnd();
}

export async function getGitRepository(directory: string): Promise<GitRepository> {
    const root = await runGit(directory, ['rev-parse', '--show-toplevel']);
    const commonDirectory = await fs.promises.realpath(await runGit(root, [
        'rev-parse', '--path-format=absolute', '--git-common-dir'
    ]));
    const worktrees = await runGit(root, ['worktree', 'list', '--porcelain', '-z']);
    const primary = worktrees.split('\0').find(field => field.startsWith('worktree '));
    if (!primary) { throw new Error('Could not locate the primary Git worktree.'); }
    const primaryRoot = primary.slice('worktree '.length);
    return {
        root,
        commonDirectory,
        worktreePath: path.join(path.dirname(primaryRoot), `${path.basename(primaryRoot)}-mauideploy`)
    };
}

export async function resolveCommit(repository: GitRepository, reference: string, signal?: AbortSignal): Promise<string> {
    const commit = await runGit(repository.root, [
        'rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`
    ], signal);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) { throw new Error('Git did not return a valid commit.'); }
    return commit;
}

export async function withDeploymentWorktree<Result>(
    repository: GitRepository,
    commit: string,
    deploy: (directory: string) => Promise<Result>,
    signal?: AbortSignal
): Promise<Result> {
    if (!/^[a-f0-9]{40,64}$/.test(commit)) { throw new Error('A resolved commit is required.'); }
    const lockPath = path.join(repository.commonDirectory, 'mauideploy.lock');
    let lock: fs.promises.FileHandle;
    try {
        lock = await fs.promises.open(lockPath, 'wx');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        throw new Error(`MauiDeploy is already using this repository. If a previous process crashed, close its deployment before removing ${lockPath}.`);
    }
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, worktree: repository.worktreePath }));
        signal?.throwIfAborted();
        await prepareWorktree(repository, commit, signal);
        signal?.throwIfAborted();
        return await deploy(repository.worktreePath);
    } finally {
        await lock.close();
        await fs.promises.unlink(lockPath);
    }
}

async function prepareWorktree(repository: GitRepository, commit: string, signal?: AbortSignal): Promise<void> {
    const markerPath = path.join(repository.commonDirectory, 'mauideploy-worktree.json');
    if (!fs.existsSync(repository.worktreePath)) {
        await createDeploymentWorktree(repository, commit, signal);
        await fs.promises.writeFile(markerPath, JSON.stringify({ path: repository.worktreePath }));
    } else {
        await validateWorktreeOwnership(repository);
        const existing = await getGitRepository(repository.worktreePath);
        if (existing.commonDirectory !== repository.commonDirectory || existing.root !== repository.worktreePath) {
            throw new Error('The deployment directory is not a worktree of the configured repository.');
        }
        const branch = await runGit(repository.worktreePath, ['branch', '--show-current'], signal);
        if (branch) { throw new Error('The deployment worktree is no longer detached. No changes were made.'); }
        const changes = await runGit(repository.worktreePath, [
            'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'
        ], signal);
        if (changes) {
            throw new Error(`The deployment worktree has local changes. Preserve or remove them before deploying: ${repository.worktreePath}`);
        }
        await runGit(repository.worktreePath, ['checkout', '--detach', '--no-overwrite-ignore', commit], signal);
    }
    if (fs.existsSync(path.join(repository.worktreePath, '.gitmodules'))) {
        await runGit(repository.worktreePath, ['submodule', 'update', '--init', '--recursive'], signal);
    }
}

async function createDeploymentWorktree(repository: GitRepository, commit: string, signal?: AbortSignal): Promise<void> {
    const worktrees = await runGit(repository.root, ['worktree', 'list', '--porcelain', '-z'], signal);
    const registration = worktrees.split('\0\0')
        .map(record => record.split('\0'))
        .find(fields => fields.includes(`worktree ${repository.worktreePath}`));
    const args = ['worktree', 'add', '--detach'];
    if (registration) {
        const locked = registration.some(field => field === 'locked' || field.startsWith('locked '));
        if (locked) {
            throw new Error(`The missing deployment worktree is locked: ${repository.worktreePath}. If it was moved, run 'git worktree repair' from its new location. Otherwise, restore its availability or explicitly unlock it before deploying.`);
        }
        await validateWorktreeOwnership(repository);
        if (!registration.includes('detached')) {
            throw new Error('The missing deployment worktree is no longer detached. No changes were made. If it was moved, run \'git worktree repair\' from its new location.');
        }
        args.push('--force');
    }
    await runGit(repository.root, [...args, '--', repository.worktreePath, commit], signal);
}

async function validateWorktreeOwnership(repository: GitRepository): Promise<void> {
    const markerPath = path.join(repository.commonDirectory, 'mauideploy-worktree.json');
    let marker: { path?: string } | null;
    try {
        marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
    } catch {
        throw new Error(`Refusing to reuse an unmanaged directory: ${repository.worktreePath}. If this worktree was moved, run 'git worktree repair' from its new location.`);
    }
    if (marker?.path !== repository.worktreePath) {
        throw new Error(`The MauiDeploy worktree location has changed: ${repository.worktreePath}. If this worktree was moved, run 'git worktree repair' from its new location.`);
    }
}