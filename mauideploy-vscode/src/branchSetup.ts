import * as path from 'path';
import { createInterface, Interface } from 'readline/promises';
import { parseArgs } from 'util';
import { stdin, stdout } from 'process';
import { isMauiProject } from './devices';
import { BranchDeployProfile, readBranchProfile, saveBranchProfile } from './branchProfiles';
import { createPullRequestLink, listMatchingRemotes, parseRepositoryUrl } from './branchSources';
import { getGitRepository, GitRepository, runGit } from './worktrees';

export interface BranchSetupChoice<Value> {
    value: Value;
    label: string;
    description?: string;
}

export type BranchSetupPrompt = <Value>(
    title: string,
    choices: BranchSetupChoice<Value>[],
    preferredIndex: number
) => Promise<Value>;

async function selectSetupChoice<Value>(
    prompt: BranchSetupPrompt,
    title: string,
    choices: BranchSetupChoice<Value>[],
    preferredIndex: number,
    signal?: AbortSignal
): Promise<Value> {
    signal?.throwIfAborted();
    if (choices.length === 0) { throw new Error(`No choices available for ${title}.`); }
    if (choices.length === 1) { return choices[0].value; }
    const value = await prompt(title, choices, Math.max(0, preferredIndex));
    signal?.throwIfAborted();
    return value;
}

export async function configureBranchDeploy(
    repository: GitRepository,
    prompt: BranchSetupPrompt,
    expectedRepositoryUrl?: string,
    signal?: AbortSignal
): Promise<BranchDeployProfile> {
    signal?.throwIfAborted();
    const previous = await readBranchProfile(repository);
    const expected = expectedRepositoryUrl ? parseRepositoryUrl(expectedRepositoryUrl) : undefined;
    const remotes = expected
        ? await listMatchingRemotes(repository, expected, signal)
        : (await runGit(repository.root, ['remote'], signal)).split('\n').filter(Boolean);
    if (expected && remotes.length === 0) { throw new Error(`No Git remote matches ${expected.url}.`); }
    const remote = await selectSetupChoice(prompt, 'Git Remote',
        remotes.map(value => ({ value, label: value })), remotes.indexOf(previous?.remote ?? 'origin'), signal);
    const repositoryUrl = parseRepositoryUrl(await runGit(repository.root, ['remote', 'get-url', remote], signal)).url;

    const tracked = await runGit(repository.root, ['ls-files', '--cached', '--recurse-submodules', '-z', '--', '*.csproj'], signal);
    const projects = tracked.split('\0').filter(filename => filename.endsWith('.csproj'))
        .filter(filename => isMauiProject(path.join(repository.root, filename))).sort();
    if (projects.length === 0) { throw new Error('No tracked MAUI projects found in this repository.'); }
    const projectPath = await selectSetupChoice(prompt, 'Project', projects.map(value => ({
        value, label: path.basename(value, '.csproj'), description: value
    })), projects.indexOf(previous?.projectPath ?? ''), signal);

    signal?.throwIfAborted();
    const profile: BranchDeployProfile = {
        version: 1,
        repositoryRoot: repository.root,
        commonDirectory: repository.commonDirectory,
        remote, repositoryUrl, projectPath,
        configuration: 'Debug',
        device: previous?.device
    };
    await saveBranchProfile(profile);
    return profile;
}

async function choose<Value>(
    input: Interface,
    title: string,
    values: Value[],
    label: (value: Value) => string,
    preferredIndex = 0
): Promise<Value> {
    if (values.length === 0) { throw new Error(`No choices available for ${title}.`); }
    if (values.length === 1) {
        stdout.write(`${title}: ${label(values[0])}\n`);
        return values[0];
    }
    const defaultIndex = Math.max(0, preferredIndex);
    stdout.write(`\n${title}\n`);
    values.forEach((value, index) => stdout.write(`  ${index + 1}. ${label(value)}\n`));
    for (;;) {
        const answer = (await input.question(`Select [${defaultIndex + 1}]: `)).trim();
        const selected = answer ? Number(answer) - 1 : defaultIndex;
        if (Number.isInteger(selected) && selected >= 0 && selected < values.length) { return values[selected]; }
        stdout.write('Enter one of the listed numbers.\n');
    }
}

export async function setupBranchDeploy(directory: string, expectedRepositoryUrl?: string): Promise<void> {
    const repository = await getGitRepository(directory);
    const input = createInterface({ input: stdin, output: stdout });
    try {
        stdout.write(`MauiDeploy branch deployment setup\nRepository: ${repository.root}\n`);
        const profile = await configureBranchDeploy(repository, async (title, choices, preferredIndex) => {
            const choice = await choose(input, title, choices,
                value => [value.label, value.description].filter(Boolean).join(' / '), preferredIndex);
            return choice.value;
        }, expectedRepositoryUrl);
        stdout.write(`\nSaved: ${profile.projectPath} / ${profile.configuration}\n`);
        stdout.write(`Deployment worktree: ${repository.worktreePath}\n`);
        stdout.write('Choose a device in VS Code before each branch or PR deployment.\n');
        stdout.write('Use Deploy Branch in the VS Code status bar. Your ordinary Run/Debug selections are unchanged.\n');
    } finally {
        input.close();
    }
}

async function runSetupCommand(args: string[]): Promise<void> {
    const { positionals, values } = parseArgs({
        args, allowPositionals: true, options: { repository: { type: 'string' } }
    });
    if (positionals.length > 1) { throw new Error('Specify only one local repository directory.'); }
    await setupBranchDeploy(path.resolve(positionals[0] ?? process.cwd()), values.repository);
}

if (require.main === module) {
    const [command, value, ...extra] = process.argv.slice(2);
    if (command === 'setup') {
        runSetupCommand(process.argv.slice(3)).catch(error => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        });
    } else if (command === 'pr-link' && value) {
        try {
            let bridge: string | undefined;
            let insiders = false;
            while (extra.length > 0) {
                const option = extra.shift();
                if (option === '--insiders') { insiders = true; }
                else if (option === '--bridge' && extra[0]) { bridge = extra.shift(); }
                else { throw new Error(`Unknown or incomplete option: ${option}`); }
            }
            stdout.write(`[Test with MauiDeploy](${createPullRequestLink(value, bridge, insiders)})\n`);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    } else {
        stdout.write('Usage: mauideploy setup [repository-directory] [--repository <HTTPS-URL>]\n');
        stdout.write('       mauideploy pr-link <PR-URL> [--bridge <HTTPS-URL>] [--insiders]\n');
        if (command && !['--help', '-h'].includes(command)) { process.exitCode = 1; }
    }
}