import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { MemoryDiagnosticsError, readDeviceMemoryDiagnostics, MemoryDiagnosticsTarget } from './memoryDiagnostics';

interface InspectorSession {
    panel: vscode.WebviewPanel;
    ready: boolean;
    closed: boolean;
    requestId: number;
    controller?: AbortController;
}

export function registerMemoryInspector(
    context: vscode.ExtensionContext,
    getTarget: (signal: AbortSignal) => Promise<MemoryDiagnosticsTarget | undefined>,
): void {
    let session: InspectorSession | undefined;
    const assets = vscode.Uri.joinPath(context.extensionUri, 'out', 'memory-inspector');

    async function importFromDevice(current: InspectorSession): Promise<void> {
        current.controller?.abort();
        const controller = new AbortController();
        current.controller = controller;
        const requestId = ++current.requestId;
        const isCurrent = () => !current.closed && current.requestId === requestId;
        const send = (message: object) => {
            if (isCurrent()) void current.panel.webview.postMessage({ ...message, requestId });
        };
        send({ type: 'deviceImportLoading' });
        try {
            if (!vscode.workspace.isTrusted) {
                throw new MemoryDiagnosticsError('Trust this workspace before reading diagnostics from a device. Manual file import is still available.');
            }
            const target = await getTarget(controller.signal);
            if (!isCurrent()) return;
            controller.signal.throwIfAborted();
            if (!target) {
                send({ type: 'deviceImportError', message: 'No app and device selected. Existing files have not changed.' });
                return;
            }
            const origin = {
                id: JSON.stringify([target.device.platform, target.device.id, target.applicationId]),
                label: `${target.applicationId} / ${target.device.name}`,
            };
            send({ type: 'deviceImportLoading', origin });
            const files = await readDeviceMemoryDiagnostics(target, controller.signal);
            if (!controller.signal.aborted) send({ type: 'deviceImportLoaded', origin, files });
        } catch (error) {
            if (controller.signal.aborted) {
                send({ type: 'deviceImportError', message: 'Device import cancelled. Existing files have not changed.' });
            } else {
                const message = error instanceof MemoryDiagnosticsError ? error.message : 'Could not load device diagnostics. Check the selected app and device, or import exported files.';
                send({ type: 'deviceImportError', message: `${message} Existing files have not changed.` });
            }
        } finally {
            if (current.controller === controller) current.controller = undefined;
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.memoryDiagnostics', () => {
        if (session) {
            session.panel.reveal();
            if (session.ready) return importFromDevice(session);
            return;
        }
        const hasAssets = ['inspector.js', 'inspector.css'].every(name =>
            fs.existsSync(vscode.Uri.joinPath(assets, name).fsPath));
        if (!hasAssets) {
            void vscode.window.showErrorMessage('DUI Memory Diagnostics is missing its UI assets. Rebuild or reinstall MAUI Deploy.');
            return;
        }

        const opened = vscode.window.createWebviewPanel(
            'mauideploy.memoryDiagnostics', 'DUI Memory Diagnostics', vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [assets], retainContextWhenHidden: true }
        );
        const current: InspectorSession = { panel: opened, ready: false, closed: false, requestId: 0 };
        session = current;
        const received = opened.webview.onDidReceiveMessage(message => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'deviceImportReady' && !current.ready) {
                current.ready = true;
                return importFromDevice(current);
            }
            if (message.type === 'deviceImportRefresh' && current.ready) return importFromDevice(current);
            if (message.type === 'deviceImportCancel') current.controller?.abort();
        });
        const closed = opened.onDidDispose(() => {
            current.closed = true;
            current.controller?.abort();
            received.dispose();
            if (session === current) session = undefined;
            closed.dispose();
        });
        opened.webview.html = memoryInspectorHtml(opened.webview, assets);
    }));
    context.subscriptions.push({ dispose: () => { session?.panel.dispose(); session = undefined; } });
}

export function memoryInspectorHtml(webview: vscode.Webview, assets: vscode.Uri): string {
    const nonce = randomBytes(24).toString('hex');
    const script = escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(assets, 'inspector.js')).toString());
    const style = escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(assets, 'inspector.css')).toString());
    const source = escapeAttribute(webview.cspSource);
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${source}; font-src ${source}; img-src ${source} data:; connect-src 'none'; base-uri 'none'; form-action 'none';">
    <title>DUI Memory Diagnostics</title>
    <link rel="stylesheet" href="${style}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${script}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}