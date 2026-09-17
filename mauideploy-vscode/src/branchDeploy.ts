import * as vscode from 'vscode';
import * as path from 'path';
import { buildAndDeploy, BuildResult } from './deployer';
import { detectPlatforms, detectAllDevices, bootSimulator } from './devices';
import { BranchDeployProfile, readBranchProfile, readBranchProfiles, resolveDeploymentProject } from './branchProfiles';
import {
    BranchReference, PullRequestReference, parseRepositoryUrl, parsePullRequestUrl, sameRepository,
    listBranches, resolveBranchCommit, getPullRequestHead, fetchPullRequestCommit
} from './branchSources';
import { getGitRepository, GitRepository, runGit, withDeploymentWorktree } from './worktrees';

type DeploymentSource = { branch: BranchReference } | { pullRequest: PullRequestReference };
type ReportProgress = (message: string, elapsedMs?: number, percent?: number) => void;

interface BranchPickItem extends vscode.QuickPickItem {
    source?: DeploymentSource;
}

export function registerBranchSetup(context: vscode.ExtensionContext): void {
    const environment = context.environmentVariableCollection;
    environment.prepend('PATH', `${context.asAbsolutePath('cli')}${path.delimiter}`);
    environment.replace('MAUIDEPLOY_NODE', process.execPath);
    environment.replace('MAUIDEPLOY_CLI', context.asAbsolutePath('out/branchSetup.js'));
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.setupBranchDeploy', () => {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showErrorMessage('Trust this workspace before configuring branch deployment.');
            return;
        }
        const terminal = vscode.window.createTerminal({
            name: 'MAUI Deploy - Setup',
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            iconPath: new vscode.ThemeIcon('settings-gear')
        });
        terminal.show();
        terminal.sendText('mauideploy setup');
    }));
}

export async function deployBranch(
    context: vscode.ExtensionContext,
    token: vscode.CancellationToken,
    report: ReportProgress,
    currentProject?: string,
    pullRequest?: PullRequestReference
): Promise<BuildResult | undefined> {
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before deploying a branch or PR.'); }
    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    if (token.isCancellationRequested) { abort.abort(); }
    try {
        abort.signal.throwIfAborted();
        const { repository, profile } = await selectDeploymentProfile(currentProject, pullRequest);
        const actualRemote = parseRepositoryUrl(await runGit(repository.root, ['remote', 'get-url', profile.remote], abort.signal));
        if (!sameRepository(actualRemote, parseRepositoryUrl(profile.repositoryUrl))) {
            throw new Error('The configured Git remote has changed. Run mauideploy setup again.');
        }
        const source = pullRequest ? { pullRequest } : await pickBranch(context, repository, profile, abort.signal);
        if (!source) { return undefined; }
        abort.signal.throwIfAborted();
        let commit: string;
        let label: string;
        if ('pullRequest' in source) {
            const reference = source.pullRequest;
            if (!sameRepository(reference.repository, actualRemote)) {
                throw new Error('This PR belongs to a different repository. Open or configure its repository first.');
            }
            report(`Reading PR #${reference.number}`);
            const head = await getPullRequestHead(reference, abort.signal);
            if (!profile.allowAutomaticPullRequests || !sameRepository(head.repository, actualRemote)) {
                const answer = await vscode.window.showWarningMessage(
                    `Build and deploy PR #${reference.number} from ${head.repository.url} to ${profile.device.name}? ` +
                    'Restore and build can execute code on this machine. The installed app with the same ID will be replaced.',
                    { modal: true }, 'Build & Deploy'
                );
                if (answer !== 'Build & Deploy') { return undefined; }
            }
            report(`Fetching PR #${reference.number}`);
            commit = await fetchPullRequestCommit(repository, profile.remote, reference, head, abort.signal);
            label = `PR #${reference.number}`;
        } else {
            report(`Fetching ${source.branch.name}`);
            commit = await resolveBranchCommit(repository, source.branch, abort.signal);
            label = source.branch.name;
            await context.globalState.update(`mauideploy.branch.${repository.commonDirectory}`, source.branch);
        }
        report(`Preparing ${label} (${commit.slice(0, 8)})`);
        return await withDeploymentWorktree(repository, commit, async directory => {
            const project = await resolveDeploymentProject(directory, profile.projectPath);
            const platforms = detectPlatforms(project);
            const platform = platforms.find(candidate => candidate.name === profile.device.platform);
            if (!platform) { throw new Error(`${profile.projectPath} does not target ${profile.device.platform} in this branch.`); }
            report(`Connecting to ${profile.device.name}`);
            const devices = await detectAllDevices([platform]);
            const device = devices.find(candidate => candidate.id === profile.device.id && candidate.type === profile.device.type);
            if (!device || device.available === false) {
                throw new Error(`${profile.device.name} is unavailable. Connect it, or run mauideploy setup to choose another device.`);
            }
            abort.signal.throwIfAborted();
            if (device.platform === 'iOS' && device.type === 'simulator' && device.state === 'Shutdown') {
                report(`Starting ${device.name}`);
                if (!await bootSimulator(device.id)) { throw new Error(`Could not start ${device.name}.`); }
            }
            abort.signal.throwIfAborted();
            const title = `${label} (${commit.slice(0, 8)}) / ${profile.configuration} / ${device.name}`;
            report(`Building ${title}`);
            const result = await buildAndDeploy(project, platform, device, profile.configuration, token,
                (elapsedMs, percent) => report(title, elapsedMs, percent), 'MAUI Deploy - Branch');
            if (result.success) { void vscode.window.showInformationMessage(`Deployed ${title}`); }
            return result;
        }, abort.signal);
    } finally {
        cancellation.dispose();
        abort.abort();
    }
}

async function selectDeploymentProfile(currentProject?: string, pullRequest?: PullRequestReference): Promise<{
    repository: GitRepository;
    profile: BranchDeployProfile;
}> {
    if (pullRequest) {
        const profiles = (await readBranchProfiles()).filter(profile =>
            sameRepository(parseRepositoryUrl(profile.repositoryUrl), pullRequest.repository));
        if (profiles.length === 0) { throw new Error('No deployment setup for this PR repository. Run mauideploy setup in its local clone first.'); }
        let profile = profiles[0];
        if (profiles.length > 1) {
            const choice = await vscode.window.showQuickPick(profiles.map(candidate => ({
                label: path.basename(candidate.repositoryRoot), description: candidate.repositoryRoot, profile: candidate
            })), { title: 'Deploy PR: Repository', matchOnDescription: true });
            if (!choice) { throw new vscode.CancellationError(); }
            profile = choice.profile;
        }
        const repository = await getGitRepository(profile.repositoryRoot);
        if (repository.commonDirectory !== profile.commonDirectory) { throw new Error('The configured local repository has changed. Run mauideploy setup again.'); }
        return { repository, profile };
    }
    let directory = currentProject ? path.dirname(currentProject) : undefined;
    if (!directory) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 1) { directory = folders[0].uri.fsPath; }
        if (folders.length > 1) {
            const choice = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Repository to deploy from' });
            directory = choice?.uri.fsPath;
        }
    }
    if (!directory) { throw new Error('Open your application repository and run mauideploy setup first.'); }
    const repository = await getGitRepository(directory);
    const profile = await readBranchProfile(repository);
    if (!profile) { throw new Error('Run mauideploy setup in a new VS Code terminal to select a project, configuration and device.'); }
    return { repository, profile };
}

async function pickBranch(
    context: vscode.ExtensionContext,
    repository: GitRepository,
    profile: BranchDeployProfile,
    signal: AbortSignal
): Promise<DeploymentSource | undefined> {
    const picker = vscode.window.createQuickPick<BranchPickItem>();
    picker.title = `Deploy Branch: ${profile.projectPath} / ${profile.configuration} / ${profile.device.name}`;
    picker.placeholder = 'Search branches or paste a GitHub PR URL';
    picker.matchOnDescription = true;
    picker.ignoreFocusOut = true;
    picker.busy = true;
    const previous = context.globalState.get<BranchReference>(`mauideploy.branch.${repository.commonDirectory}`);
    let branches: BranchReference[] = [];
    let closed = false;
    const refresh = () => {
        const input = picker.value.trim();
        if (input.startsWith('https://')) {
            try {
                const pullRequest = parsePullRequestUrl(input);
                picker.items = [{ label: input, description: `PR #${pullRequest.number}`, source: { pullRequest } }];
            } catch {
                picker.items = [{ label: input, description: 'Invalid GitHub PR URL' }];
            }
            return;
        }
        const items: BranchPickItem[] = branches.map(branch => ({
            label: `$(git-branch) ${branch.name}`, description: branch.remote ?? 'local', source: { branch }
        }));
        if (input && !branches.some(branch => branch.name === input && branch.remote === profile.remote)) {
            items.push({ label: input, description: `Fetch from ${profile.remote}`, source: { branch: { name: input, remote: profile.remote } } });
        }
        picker.items = items;
    };
    return new Promise<DeploymentSource | undefined>((resolve, reject) => {
        const subscriptions: vscode.Disposable[] = [];
        const finish = (source?: DeploymentSource, error?: unknown) => {
            if (closed) { return; }
            closed = true;
            signal.removeEventListener('abort', cancel);
            subscriptions.forEach(subscription => subscription.dispose());
            picker.dispose();
            if (error) { reject(error); } else { resolve(source); }
        };
        const cancel = () => finish();
        signal.addEventListener('abort', cancel, { once: true });
        subscriptions.push(
            picker.onDidHide(() => finish()),
            picker.onDidChangeValue(refresh),
            picker.onDidAccept(() => {
                const source = picker.selectedItems[0]?.source;
                if (source) { finish(source); }
            })
        );
        if (signal.aborted) { finish(); return; }
        picker.show();
        void listBranches(repository, profile.remote, signal).then(result => {
            if (closed) { return; }
            branches = result;
            if (previous) {
                const index = branches.findIndex(branch => branch.name === previous.name && branch.remote === previous.remote);
                if (index >= 0) { branches.unshift(...branches.splice(index, 1)); }
            }
            picker.busy = false;
            refresh();
        }, async error => {
            if (closed) { return; }
            try {
                const local = await runGit(repository.root, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/'], signal);
                if (closed) { return; }
                branches = local.split('\n').filter(Boolean).map(name => ({ name }));
                picker.busy = false;
                picker.title = `${picker.title} (remote unavailable)`;
                refresh();
            } catch {
                finish(undefined, error);
            }
        });
    });
}