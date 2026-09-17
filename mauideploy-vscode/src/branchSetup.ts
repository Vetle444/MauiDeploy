import * as path from 'path';
import { createInterface, Interface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { detectAllDevices, detectPlatforms, isMauiProject } from './devices';
import { BranchDeployProfile, readBranchProfile, saveBranchProfile } from './branchProfiles';
import { createPullRequestLink, parseRepositoryUrl } from './branchSources';
import { getGitRepository, runGit } from './worktrees';

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

export async function setupBranchDeploy(directory: string): Promise<void> {
    const repository = await getGitRepository(directory);
    const previous = await readBranchProfile(repository);
    const input = createInterface({ input: stdin, output: stdout });
    try {
        stdout.write(`MauiDeploy branch deployment setup\nRepository: ${repository.root}\n`);
        const remotes = (await runGit(repository.root, ['remote'])).split('\n').filter(Boolean);
        const remote = await choose(input, 'Git remote', remotes, name => name,
            remotes.indexOf(previous?.remote ?? 'origin'));
        const repositoryUrl = parseRepositoryUrl(await runGit(repository.root, ['remote', 'get-url', remote])).url;
        const tracked = await runGit(repository.root, ['ls-files', '--cached', '--recurse-submodules', '-z', '--', '*.csproj']);
        const projects = tracked.split('\0').filter(filename => filename.endsWith('.csproj'))
            .filter(filename => isMauiProject(path.join(repository.root, filename))).sort();
        if (projects.length === 0) { throw new Error('No tracked MAUI projects found. Run setup from your MAUI application repository.'); }
        const projectPath = await choose(input, 'Project', projects, filename => filename,
            projects.indexOf(previous?.projectPath ?? ''));
        const configurations: BranchDeployProfile['configuration'][] = ['Debug', 'Release'];
        const configuration = await choose(input, 'Configuration', configurations, name => name,
            configurations.indexOf(previous?.configuration ?? 'Debug'));
        stdout.write('\nDetecting devices...\n');
        const devices = (await detectAllDevices(detectPlatforms(path.join(repository.root, projectPath))))
            .filter(device => device.available !== false);
        if (devices.length === 0) { throw new Error('No available devices. Connect a device or create an iOS simulator, then run setup again.'); }
        const device = await choose(input, 'Device', devices,
            value => `${value.platform} / ${value.display} (${value.state})`,
            devices.findIndex(value => value.id === previous?.device.id));
        stdout.write('\nPR links can automatically fetch, build and run code on this machine.\n');
        stdout.write('Only PRs whose source repository matches the configured repository are eligible. Forks require separate confirmation.\n');
        const answer = await input.question('Allow automatic deployment from PR links for this repository? [y/N]: ');
        const allowAutomaticPullRequests = /^(y|yes)$/i.test(answer.trim());
        await saveBranchProfile({
            version: 1,
            repositoryRoot: repository.root,
            commonDirectory: repository.commonDirectory,
            remote, repositoryUrl, projectPath, configuration,
            device: { id: device.id, name: device.name, platform: device.platform, type: device.type },
            allowAutomaticPullRequests
        });
        stdout.write(`\nSaved: ${projectPath} / ${configuration} / ${device.name}\n`);
        stdout.write(`Deployment worktree: ${repository.worktreePath}\n`);
        stdout.write('Use Deploy Branch in the VS Code status bar. Your ordinary Run/Debug selections are unchanged.\n');
    } finally {
        input.close();
    }
}

if (require.main === module) {
    const [command, value, ...extra] = process.argv.slice(2);
    if (command === 'setup' && extra.length === 0) {
        setupBranchDeploy(path.resolve(value ?? process.cwd())).catch(error => {
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
        stdout.write('Usage: mauideploy setup [repository-directory]\n');
        stdout.write('       mauideploy pr-link <PR-URL> [--bridge <HTTPS-URL>] [--insiders]\n');
        if (command && !['--help', '-h'].includes(command)) { process.exitCode = 1; }
    }
}