import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { createToolboxSnapshot, ToolboxContext, ToolboxToolId } from './toolboxModel';
import { cancelToolProgress, getToolProgress, registerToolProgress } from './toolProgress';
import { cancelToolPickers, getToolPicker, handleToolPickerMessage, registerToolPickers } from './toolPicker';

export interface Toolbox {
    update(): void;
}

export function registerToolbox(context: vscode.ExtensionContext, getContext: () => ToolboxContext): Toolbox {
    let view: vscode.WebviewView | undefined;
    const pending = new Set<ToolboxToolId>();
    const assets = vscode.Uri.joinPath(context.extensionUri, 'out', 'toolbox');
    const snapshot = () => createToolboxSnapshot({ ...getContext(), progress: getToolProgress(), picker: getToolPicker() }, pending);
    const update = () => {
        if (view) void view.webview.postMessage({ type: 'toolboxState', state: snapshot() });
    };
    context.subscriptions.push(registerToolProgress({ isVisible: () => view?.visible === true, update }));
    context.subscriptions.push(registerToolPickers({
        reveal: () => vscode.commands.executeCommand('mauideploy.tools.focus'), update,
    }));

    async function execute(id: string, opened: vscode.WebviewView): Promise<void> {
        const action = snapshot().actions.find(item => item.id === id);
        if (!action?.enabled) return;
        if (!action.stopping) pending.add(action.id);
        update();
        try {
            await vscode.commands.executeCommand(action.command);
        } catch {
            if (view === opened) void opened.webview.postMessage({ type: 'toolboxError', message: 'The action could not be completed. Check the VS Code notification or output and retry.' });
        } finally {
            if (!action.stopping) pending.delete(action.id);
            update();
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.openTools', () =>
        vscode.commands.executeCommand('mauideploy.tools.focus')));
    function resolveWebviewView(opened: vscode.WebviewView): void {
        view = opened;
        opened.webview.options = { enableScripts: true, localResourceRoots: [assets] };
        if (!['toolbox.js', 'toolbox.css'].every(name => fs.existsSync(vscode.Uri.joinPath(assets, name).fsPath))) {
            void vscode.window.showErrorMessage('MAUI Deploy tools are missing their UI assets. Rebuild or reinstall the extension.');
            cancelToolPickers();
            return;
        }
        const listener = opened.webview.onDidReceiveMessage(message => {
            if (view !== opened || !message || typeof message !== 'object') return;
            if (message.type === 'toolboxReady') update();
            handleToolPickerMessage(message);
            if (message.type === 'toolboxCancelProgress' && typeof message.id === 'string') cancelToolProgress(message.id);
            if (message.type === 'toolboxAction' && typeof message.id === 'string') return execute(message.id, opened);
        });
        const visibility = opened.onDidChangeVisibility(() => {
            if (opened.visible) update();
        });
        const closed = opened.onDidDispose(() => {
            if (view === opened) { view = undefined; cancelToolPickers(); }
            listener.dispose();
            visibility.dispose();
            closed.dispose();
        });
        const nonce = randomBytes(24).toString('hex');
        const script = opened.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'toolbox.js'));
        const style = opened.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'toolbox.css'));
        opened.webview.html = `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${opened.webview.cspSource}; font-src ${opened.webview.cspSource}; img-src ${opened.webview.cspSource} data:; connect-src 'none'; base-uri 'none'; form-action 'none';">
<title>MAUI Deploy</title><link rel="stylesheet" href="${style}">
</head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
    }
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('mauideploy.tools', {
        resolveWebviewView,
    }, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push({ dispose: () => { view = undefined; } });
    return { update };
}