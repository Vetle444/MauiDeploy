import * as vscode from 'vscode';
import * as path from 'path';
import { buildAndDeploy, BuildResult } from './deployer';
import { detectPlatforms, detectAllDevices, bootSimulator, Device, Platform } from './devices';
import { BranchDeployProfile, readBranchProfile, readBranchProfiles, resolveDeploymentProject, saveBranchProfile } from './branchProfiles';
import { configureBranchDeploy } from './branchSetup';
import {
    BranchReference, PullRequestReference, parseRepositoryUrl, parsePullRequestUrl, sameRepository,
    listBranches, listMatchingRemotes, resolveBranchCommit, getPullRequestHead, fetchPullRequestCommit
} from './branchSources';
import { getGitRepository, GitRepository, runGit, withDeploymentWorktree } from './worktrees';

type DeploymentSource = { branch: BranchReference } | { pullRequest: PullRequestReference };
type ReportProgress = (message: string, elapsedMs?: number, percent?: number) => void;

interface BranchPickItem extends vscode.QuickPickItem {
    source?: DeploymentSource;
}

export function registerBranchSetup(context: vscode.ExtensionContext, currentProject: () => string | undefined): void {
    const environment = context.environmentVariableCollection;
    environment.prepend('PATH', `${context.asAbsolutePath('cli')}${path.delimiter}`);
    environment.replace('MAUIDEPLOY_NODE', process.execPath);
    environment.replace('MAUIDEPLOY_CLI', context.asAbsolutePath('out/branchSetup.js'));
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.setupBranchDeploy', async () => {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showErrorMessage('Trust this workspace before configuring branch deployment.');
            return;
        }
        const abort = new AbortController();
        try {
            const repository = await selectWorkspaceRepository(currentProject());
            const profile = await setupDeploymentProfile(repository, abort.signal);
            void vscode.window.showInformationMessage(`Branch deployment configured: ${profile.projectPath} / ${profile.configuration}`);
        } catch (error) {
            if (!(error instanceof vscode.CancellationError)) {
                void vscode.window.showErrorMessage(`MAUI Deploy: ${error instanceof Error ? error.message : String(error)}`);
            }
        } finally {
            abort.abort();
        }
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
        const { repository, profile } = await selectDeploymentProfile(abort.signal, currentProject, pullRequest);
        abort.signal.throwIfAborted();
        const actualRemote = parseRepositoryUrl(await runGit(repository.root, ['remote', 'get-url', profile.remote], abort.signal));
        if (!sameRepository(actualRemote, parseRepositoryUrl(profile.repositoryUrl))) {
            throw new Error('The configured Git remote has changed. Use MAUI Deploy: Set Up Branch Deployment to configure it again.');
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
            if (!sameRepository(head.repository, actualRemote)) {
                const answer = await vscode.window.showWarningMessage(
                    `Build and deploy PR #${reference.number} from ${head.repository.url}? ` +
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
            report(`Selecting device for ${label}`);
            const device = await pickDeploymentDevice(platforms, profile, label, token);
            const platform = platforms.find(candidate => candidate.name === device.platform)!;
            await saveBranchProfile({
                ...profile,
                device: { id: device.id, name: device.name, platform: device.platform, type: device.type }
            });
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

async function pickDeploymentDevice(
    platforms: Platform[],
    profile: BranchDeployProfile,
    label: string,
    token: vscode.CancellationToken
): Promise<Device> {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    if (platforms.length === 0) { throw new Error('This project does not target iOS or Android in the selected branch.'); }
    const devices = (await detectAllDevices(platforms)).filter(device => device.available !== false);
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    if (devices.length === 0) { throw new Error('No available devices for this project. Connect a device or create an iOS simulator and try again.'); }
    const previous = devices.find(device => device.id === profile.device?.id &&
        device.platform === profile.device.platform && device.type === profile.device.type);
    const itemForDevice = (device: Device) => ({
        label: `$(${device.type === 'simulator' ? 'vm' : 'device-mobile'}) ${device.display}`,
        description: device.state, device
    });
    const items: (vscode.QuickPickItem & { device?: Device })[] = [];
    if (previous) {
        items.push({ label: 'Last Used', kind: vscode.QuickPickItemKind.Separator }, itemForDevice(previous));
    }
    for (const platform of platforms) {
        const group = devices.filter(device => device.platform === platform.name && device !== previous);
        if (group.length > 0) {
            items.push({ label: platform.name, kind: vscode.QuickPickItemKind.Separator }, ...group.map(itemForDevice));
        }
    }
    const choice = await vscode.window.showQuickPick(items, {
        title: `Deploy ${label}: Device`, placeHolder: `${profile.projectPath} / ${profile.configuration}`,
        matchOnDescription: true, ignoreFocusOut: true
    }, token);
    if (!choice?.device || token.isCancellationRequested) { throw new vscode.CancellationError(); }
    return choice.device;
}

async function selectDeploymentProfile(
    signal: AbortSignal,
    currentProject?: string,
    pullRequest?: PullRequestReference
): Promise<{
    repository: GitRepository;
    profile: BranchDeployProfile;
}> {
    if (pullRequest) {
        const profiles = (await readBranchProfiles()).filter(profile =>
            sameRepository(parseRepositoryUrl(profile.repositoryUrl), pullRequest.repository));
        if (profiles.length === 0) {
            const repository = await findPullRequestRepository(pullRequest, signal, currentProject);
            const profile = await setupDeploymentProfile(repository, signal, pullRequest.repository.url);
            return { repository, profile };
        }
        let profile = profiles[0];
        if (profiles.length > 1) {
            const choice = await vscode.window.showQuickPick(profiles.map(candidate => ({
                label: path.basename(candidate.repositoryRoot), description: candidate.repositoryRoot, profile: candidate
            })), { title: 'Deploy PR: Repository', matchOnDescription: true });
            if (!choice) { throw new vscode.CancellationError(); }
            profile = choice.profile;
        }
        const repository = await getGitRepository(profile.repositoryRoot);
        if (repository.commonDirectory !== profile.commonDirectory) { throw new Error('The configured local repository has changed. Use MAUI Deploy: Set Up Branch Deployment to configure it again.'); }
        return { repository, profile };
    }
    const repository = await selectWorkspaceRepository(currentProject);
    const profile = await readBranchProfile(repository) ?? await setupDeploymentProfile(repository, signal);
    return { repository, profile };
}

async function selectWorkspaceRepository(currentProject?: string): Promise<GitRepository> {
    let directory = currentProject ? path.dirname(currentProject) : undefined;
    if (!directory) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 1) { directory = folders[0].uri.fsPath; }
        if (folders.length > 1) {
            const choice = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Repository to deploy from' });
            if (!choice) { throw new vscode.CancellationError(); }
            directory = choice?.uri.fsPath;
        }
    }
    if (!directory) { throw new Error('Open your application repository to configure branch deployment.'); }
    return getGitRepository(directory);
}

async function findPullRequestRepository(
    reference: PullRequestReference,
    signal: AbortSignal,
    currentProject?: string
): Promise<GitRepository> {
    const directories = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    if (currentProject) { directories.unshift(path.dirname(currentProject)); }
    const repositories = new Map<string, GitRepository>();
    for (const directory of new Set(directories)) {
        signal.throwIfAborted();
        try {
            const repository = await getGitRepository(directory);
            const remotes = await listMatchingRemotes(repository, reference.repository, signal);
            if (remotes.length > 0) {
                repositories.set(repository.commonDirectory, repository);
            }
        } catch (error) {
            if (signal.aborted) { throw error; }
        }
    }
    if (repositories.size === 1) { return [...repositories.values()][0]; }
    if (repositories.size > 1) {
        const choice = await vscode.window.showQuickPick([...repositories.values()].map(repository => ({
            label: `$(repo) ${path.basename(repository.root)}`, description: repository.root, repository
        })), { title: 'Set Up PR Deployment: Repository', matchOnDescription: true });
        if (!choice) { throw new vscode.CancellationError(); }
        return choice.repository;
    }
    signal.throwIfAborted();
    const selected = await vscode.window.showOpenDialog({
        title: `Select a local clone of ${reference.repository.owner}/${reference.repository.name}`,
        openLabel: 'Set Up Deployment', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    });
    if (!selected?.[0]) { throw new vscode.CancellationError(); }
    signal.throwIfAborted();
    const repository = await getGitRepository(selected[0].fsPath);
    const remotes = await listMatchingRemotes(repository, reference.repository, signal);
    if (remotes.length === 0) {
        throw new Error(`The selected folder has no Git remote for ${reference.repository.url}. Select its local clone.`);
    }
    return repository;
}

async function setupDeploymentProfile(
    repository: GitRepository,
    signal: AbortSignal,
    expectedRepositoryUrl?: string
): Promise<BranchDeployProfile> {
    signal.throwIfAborted();
    const cancellation = new vscode.CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
        return await configureBranchDeploy(repository, async (title, choices, preferredIndex) => {
            const ordered = [...choices];
            if (preferredIndex > 0) { ordered.unshift(...ordered.splice(preferredIndex, 1)); }
            const icons: Record<string, string> = { 'Git Remote': 'repo', Project: 'file-code' };
            const selection = await vscode.window.showQuickPick(ordered.map(choice => ({
                label: `$(${icons[title]}) ${choice.label}`, description: choice.description, choice
            })), {
                title: `Branch Deployment: ${title}`, placeHolder: repository.root,
                matchOnDescription: true, ignoreFocusOut: true
            }, cancellation.token);
            if (!selection) { throw new vscode.CancellationError(); }
            return selection.choice.value;
        }, expectedRepositoryUrl, signal);
    } finally {
        signal.removeEventListener('abort', cancel);
        cancellation.dispose();
    }
}

async function pickBranch(
    context: vscode.ExtensionContext,
    repository: GitRepository,
    profile: BranchDeployProfile,
    signal: AbortSignal
): Promise<DeploymentSource | undefined> {
    const picker = vscode.window.createQuickPick<BranchPickItem>();
    picker.title = `Deploy Branch: ${profile.projectPath} / ${profile.configuration}`;
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