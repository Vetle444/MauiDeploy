import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Device, detectScreenshotDevices } from './devices';
import { captureScreenshot, copyScreenshot } from './screenshots';
import { installScreenshotTools, screenshotPythonPath, screenshotToolsReady } from './screenshotTools';

export function registerScreenshotCommand(context: vscode.ExtensionContext, selectedDevice: () => string | undefined, setBusy: (busy: boolean) => void): void {
    let controller: AbortController | undefined;
    const panels = new Set<vscode.WebviewPanel>();
    const output = vscode.window.createOutputChannel('MAUI Deploy - Screenshots');
    context.subscriptions.push(output);
    context.subscriptions.push({ dispose: () => {
        controller?.abort();
        for (const panel of panels) { panel.dispose(); }
        panels.clear();
    } });
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.screenshot', async () => {
        if (controller) { return; }
        if (process.platform !== 'darwin') {
            await vscode.window.showInformationMessage('Device screenshots currently require macOS.');
            return;
        }
        if (!vscode.workspace.isTrusted) {
            await vscode.window.showWarningMessage('Trust this workspace before running device tools.');
            return;
        }
        controller = new AbortController();
        const signal = controller.signal;
        setBusy(true);
        let stage = 'find devices';
        output.appendLine('Screenshot requested.');
        try {
            const device = await chooseScreenshotDevice(selectedDevice());
            if (!device || signal.aborted) {
                output.appendLine('No device selected, or request cancelled.');
                return;
            }
            output.appendLine(`Device selected: ${device.platform} ${device.type}.`);
            const storage = path.join(context.globalStorageUri.fsPath, 'screenshots');
            await fs.mkdir(storage, { recursive: true, mode: 0o700 });
            let python: string | undefined;
            if (device.platform === 'iOS' && device.type === 'physical') {
                stage = 'prepare the iPhone helper';
                python = await prepareIphoneHelper(storage, signal, () => controller?.abort());
                if (!python || signal.aborted) {
                    output.appendLine('Helper setup declined or cancelled.');
                    return;
                }
                output.appendLine('iPhone helper ready.');
            }
            stage = 'capture the screenshot';
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Screenshot: ${device.name}`, cancellable: true,
            }, async (progress, cancellation) => {
                const subscription = cancellation.onCancellationRequested(() => controller?.abort());
                try {
                    progress.report({ message: 'Capturing...' });
                    output.appendLine('Capturing PNG (timeout: 45 seconds).');
                    const image = await captureScreenshot(device, signal, python, storage);
                    if (signal.aborted) { return; }
                    output.appendLine(`PNG received: ${image.length} bytes.`);
                    stage = 'open the screenshot preview';
                    const panel = vscode.window.createWebviewPanel(
                        'mauideploy.screenshot', `Screenshot - ${device.name} - ${new Date().toLocaleTimeString()}`,
                        vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] },
                    );
                    panels.add(panel);
                    panel.onDidDispose(() => panels.delete(panel));
                    panel.webview.html = screenshotHtml(image);
                    panel.reveal(vscode.ViewColumn.Active, false);
                    output.appendLine('Preview opened.');
                    progress.report({ message: 'Copying image to clipboard...' });
                    try {
                        await copyScreenshot(image, signal);
                        output.appendLine('Image copied to clipboard.');
                        vscode.window.setStatusBarMessage('Screenshot copied to clipboard.', 5000);
                    } catch {
                        output.appendLine('Clipboard copy failed or was cancelled; preview retained.');
                        if (!signal.aborted) {
                            await vscode.window.showWarningMessage('The screenshot is open, but copying the image to the clipboard failed.');
                        }
                    }
                } finally { subscription.dispose(); }
            });
        } catch (error) {
            const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
            const details = `code=${failure?.code ?? 'none'}, name=${failure?.name ?? 'unknown'}, killed=${!!failure?.killed}, signal=${failure?.signal ?? 'none'}`;
            output.appendLine(`Failed to ${stage}: ${details}`);
            if (!signal.aborted) {
                const code = (error as NodeJS.ErrnoException)?.code;
                let action = 'Check that the device is reachable and unlocked, then try again.';
                if (stage === 'prepare the iPhone helper') {
                    action = 'Check your internet connection and Xcode command line tools, then retry. Installation resumes in an isolated environment.';
                } else if (code === 'ENOENT') {
                    action = 'Install the Xcode command line tools or Android SDK platform tools for the selected device.';
                }
                if (failure?.killed) {
                    action = 'The operation timed out. Check the device connection and try again.';
                }
                output.show(true);
                await vscode.window.showErrorMessage(`Could not ${stage}. ${action} See MAUI Deploy - Screenshots in Output.`);
            }
        } finally {
            output.appendLine(signal.aborted ? 'Screenshot cancelled.' : 'Screenshot operation finished.');
            controller = undefined;
            setBusy(false);
        }
    }));
}

async function chooseScreenshotDevice(selectedId?: string): Promise<Device | undefined> {
    const devices = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window, title: 'Finding screenshot devices...',
    }, () => detectScreenshotDevices());
    devices.sort((left, right) => {
        if (left.id === selectedId && right.id !== selectedId) { return -1; }
        if (right.id === selectedId && left.id !== selectedId) { return 1; }
        return left.platform.localeCompare(right.platform) || left.name.localeCompare(right.name);
    });
    if (devices.length === 0) {
        await vscode.window.showInformationMessage('No screenshot devices found. Connect a paired phone or start a simulator/emulator.');
        return undefined;
    }
    const itemForDevice = (device: Device) => ({
        label: `$(device-mobile) ${device.name}`,
        description: [device.runtime || device.platform, device.type, device.transport].filter(Boolean).join(' - '),
        device,
    });
    const items: (vscode.QuickPickItem & { device?: Device })[] = [];
    const selected = devices.find(device => device.id === selectedId);
    if (selected) {
        items.push({ label: 'Current deployment target', kind: vscode.QuickPickItemKind.Separator }, itemForDevice(selected));
    }
    for (const platform of ['iOS', 'Android']) {
        const group = devices.filter(device => device.platform === platform && device !== selected);
        if (group.length > 0) {
            items.push({ label: platform, kind: vscode.QuickPickItemKind.Separator }, ...group.map(itemForDevice));
        }
    }
    const choice = await vscode.window.showQuickPick(items, { title: 'Take Screenshot', placeHolder: 'Select a device', matchOnDescription: true });
    return choice?.device;
}

async function prepareIphoneHelper(storage: string, signal: AbortSignal, cancel: () => void): Promise<string | undefined> {
    if (await screenshotToolsReady(storage, signal)) { return screenshotPythonPath(storage); }
    const install = 'Install and Continue';
    const choice = await vscode.window.showInformationMessage(
        'iPhone screenshots need an additional helper.',
        { modal: true, detail: 'Download Python, uv and pymobiledevice3 into MAUI Deploy storage. No project files or global Python packages are changed. Internet access is required. pymobiledevice3 is third-party software licensed under GPL-3.0-or-later.' },
        install,
    );
    if (choice !== install || signal.aborted) { return undefined; }
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Installing iPhone screenshot tools', cancellable: true,
    }, async (progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(cancel);
        try {
            return await installScreenshotTools(storage, signal, message => progress.report({ message }));
        } finally { subscription.dispose(); }
    });
}

export function screenshotHtml(image: Buffer): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">
<style>html,body{margin:0;height:100%;background:var(--vscode-editor-background)}body{display:flex;align-items:center;justify-content:center}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style>
</head><body><img alt="Device screenshot" src="data:image/png;base64,${image.toString('base64')}"></body></html>`;
}