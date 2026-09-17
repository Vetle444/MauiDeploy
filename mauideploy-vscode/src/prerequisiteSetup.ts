import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Platform } from './devices';
import {
    inspectGitPrerequisites, inspectGitHubPrerequisites, inspectXcodePrerequisites,
    inspectIosSdkPrerequisites, installPrerequisite, PrerequisiteIssue, PrerequisiteCommand
} from './prerequisites';

interface PrerequisiteAction extends vscode.QuickPickItem {
    action: 'install' | 'manual' | 'documentation' | 'recheck' | 'alternative';
    issue?: PrerequisiteIssue;
}

export class BranchPrerequisites {
    private readonly storage: string;
    private readonly checkedHosts = new Set<string>();

    constructor(
        context: vscode.ExtensionContext,
        private readonly token: vscode.CancellationToken,
        private readonly signal: AbortSignal,
        private readonly report: (message: string) => void
    ) {
        this.storage = path.join(context.globalStorageUri.fsPath, 'prerequisites');
    }

    async ensureSourceTools(host?: string): Promise<void> {
        this.signal.throwIfAborted();
        await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
        await this.ensure('Repository tools', async () => {
            const issues = await inspectGitPrerequisites(this.storage, this.signal);
            if (host) { issues.push(...await inspectGitHubPrerequisites(host, this.storage, this.signal)); }
            return issues;
        });
        if (host) { this.checkedHosts.add(host); }
    }

    async ensureGitHub(host: string): Promise<void> {
        if (this.checkedHosts.has(host)) { return; }
        await this.ensure('GitHub access', () => inspectGitHubPrerequisites(host, this.storage, this.signal));
        this.checkedHosts.add(host);
    }

    async prepareDevicePlatforms(platforms: Platform[]): Promise<Platform[]> {
        if (!platforms.some(platform => platform.name === 'iOS') || process.platform !== 'darwin') { return platforms; }
        const alternatives = platforms.filter(platform => platform.name !== 'iOS');
        const alternativeLabel = alternatives.length > 0 ? 'Use Android for this deployment' : undefined;
        const ready = await this.ensure('iOS device tools', () => inspectXcodePrerequisites(this.storage, this.signal), alternativeLabel);
        return ready ? platforms : alternatives;
    }

    async ensureBuildTools(projectPath: string, platform: Platform): Promise<string | undefined> {
        if (platform.name !== 'iOS' || process.platform !== 'darwin') { return undefined; }
        let executable: string | undefined;
        await this.ensure('iOS build tools', async () => {
            const xcode = await inspectXcodePrerequisites(this.storage, this.signal);
            const sdk = await inspectIosSdkPrerequisites(projectPath, platform.framework, this.storage, this.signal);
            executable = sdk.executable;
            return [...xcode, ...sdk.issues];
        });
        if (!executable) { throw new Error('The .NET SDK could not be selected.'); }
        return executable;
    }

    private async ensure(title: string, inspect: () => Promise<PrerequisiteIssue[]>, alternative?: string): Promise<boolean> {
        for (;;) {
            this.signal.throwIfAborted();
            this.report(`Checking ${title.toLowerCase()}`);
            const issues = await inspect();
            this.signal.throwIfAborted();
            if (issues.length === 0) { return true; }
            const installations = issues.filter(issue => issue.install || issue.sdkInstall);
            const actions: PrerequisiteAction[] = [];
            if (installations.length > 0) {
                actions.push({
                    label: '$(cloud-download) Install missing dependencies', action: 'install',
                    description: installations.map(issue => issue.title).join(', '),
                    detail: 'Only the listed dependencies will be installed. Existing SDKs and project files are retained.'
                });
            }
            for (const issue of issues) {
                if (issue.manualCommand) {
                    actions.push({ label: `$(terminal) ${issue.title}`, action: 'manual', issue, detail: issue.detail });
                }
                actions.push({ label: `$(link-external) ${issue.title}`, action: 'documentation', issue, detail: issue.detail });
            }
            actions.push({ label: '$(refresh) Recheck prerequisites', action: 'recheck' });
            if (alternative) { actions.push({ label: `$(device-mobile) ${alternative}`, action: 'alternative' }); }
            this.report(`${title}: action required`);
            const selection = await vscode.window.showQuickPick(actions, {
                title: `MAUI Deploy: ${title}`, placeHolder: issues.map(issue => issue.title).join(' / '),
                matchOnDescription: true, ignoreFocusOut: true
            }, this.token);
            if (!selection || this.token.isCancellationRequested) { throw new vscode.CancellationError(); }
            this.signal.throwIfAborted();
            if (selection.action === 'alternative') { return false; }
            if (selection.action === 'documentation') {
                await vscode.env.openExternal(vscode.Uri.parse(selection.issue!.documentation));
            } else if (selection.action === 'manual') {
                await this.openSetupTerminal(selection.issue!.manualCommand!);
            } else if (selection.action === 'install') {
                const accepted = await vscode.window.showWarningMessage('Install the missing deployment dependencies?', {
                    modal: true,
                    detail: installations.map(issue => `${issue.title}\n${issue.detail}`).join('\n\n')
                }, 'Install');
                this.signal.throwIfAborted();
                if (accepted !== 'Install') { throw new vscode.CancellationError(); }
                for (const issue of installations) {
                    this.report(`Installing: ${issue.title}`);
                    try {
                        await installPrerequisite(issue, this.storage, this.signal);
                    } catch (error) {
                        this.signal.throwIfAborted();
                        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Dependency installation failed. Recheck or use the setup instructions.');
                        break;
                    }
                }
            }
        }
    }

    private async openSetupTerminal(command: PrerequisiteCommand): Promise<void> {
        this.signal.throwIfAborted();
        const terminal = vscode.window.createTerminal({
            name: 'MAUI Deploy - Prerequisites', cwd: command.cwd,
            shellPath: command.executable, shellArgs: command.args,
            env: { ...command.env, PATH: command.env?.PATH ?? process.env.PATH, GH_PROMPT_DISABLED: null, GH_PAGER: 'cat' },
            iconPath: new vscode.ThemeIcon('tools')
        });
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                this.signal.removeEventListener('abort', cancel);
                subscription.dispose();
            };
            const cancel = () => {
                cleanup();
                terminal.dispose();
                reject(new vscode.CancellationError());
            };
            const subscription = vscode.window.onDidCloseTerminal(closed => {
                if (closed !== terminal) { return; }
                cleanup();
                if (closed.exitStatus?.reason === vscode.TerminalExitReason.User || closed.exitStatus?.code === 130) {
                    reject(new vscode.CancellationError());
                } else { resolve(); }
            });
            this.signal.addEventListener('abort', cancel, { once: true });
            if (this.signal.aborted) { cancel(); return; }
            terminal.show();
        });
    }
}