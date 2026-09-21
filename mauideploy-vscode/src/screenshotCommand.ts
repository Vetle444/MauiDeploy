import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Device, detectScreenshotDevices } from './devices';
import { captureScreenshot, copyScreenshot } from './screenshots';
import { captureVideo, RecordingError, VideoCaptureStage, VideoRecording, videoCaptureMessages, videoDurationLimitMs } from './recordings';
import { installScreenshotTools, screenshotPythonPath, screenshotToolsReady } from './screenshotTools';

export type VideoRecordingState = VideoCaptureStage | 'idle' | 'findingDevices' | 'choosingDevice' | 'preparing'
    | 'recording' | 'finalizing' | 'previewing' | 'saving' | 'cancelling';

export function formatRecordingTime(elapsedMs: number): string {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function registerScreenshotCommand(context: vscode.ExtensionContext, selectedDevice: () => string | undefined, setBusy: (busy: boolean) => void,
    setVideoState: (state: VideoRecordingState, message?: string, elapsedMs?: number) => void = () => {}): void {
    let controller: AbortController | undefined;
    let stop: AbortController | undefined;
    let cancelVideo: (() => void) | undefined;
    const panels = new Set<vscode.WebviewPanel>();
    const recordings = new Map<vscode.WebviewPanel, VideoRecording>();
    const screenshotOutput = vscode.window.createOutputChannel('MAUI Deploy - Screenshots');
    const recordingOutput = vscode.window.createOutputChannel('MAUI Deploy - Recordings');
    const discard = (video: VideoRecording) => video.dispose().catch(() => {
        recordingOutput.appendLine('Could not remove a temporary video from MAUI Deploy recording storage.');
    });
    const saveVideo = async (video: VideoRecording, signal?: AbortSignal, report?: (message: string) => void): Promise<boolean> => {
        report?.('Recording ready. Choose a location for the MP4...');
        const destination = await vscode.window.showSaveDialog({
            title: 'Save Video Recording', saveLabel: 'Save Video', filters: { 'MP4 Video': ['mp4'] },
            defaultUri: vscode.Uri.file(path.join(os.homedir(), `mauideploy-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`)),
        });
        if (!destination || signal?.aborted) {
            recordingOutput.appendLine('Save declined or cancelled; preview retained.');
            vscode.window.setStatusBarMessage('Recording ready (not saved).', 5000);
            return false;
        }
        report?.('Saving MP4...');
        await vscode.workspace.fs.copy(vscode.Uri.file(video.path), destination, { overwrite: true });
        recordingOutput.appendLine('Video saved.');
        vscode.window.setStatusBarMessage('Video saved.', 5000);
        if (destination.scheme === 'file' && !signal?.aborted) {
            report?.('Opening Finder...');
            try {
                await vscode.commands.executeCommand('revealFileInOS', destination);
                recordingOutput.appendLine('Saved video revealed in Finder.');
            } catch {
                recordingOutput.appendLine('Video saved, but opening Finder failed.');
                void vscode.window.showWarningMessage('The video was saved, but Finder could not be opened.');
            }
        }
        return true;
    };
    context.subscriptions.push(screenshotOutput, recordingOutput);
    context.subscriptions.push({ dispose: () => {
        controller?.abort();
        for (const panel of panels) { panel.dispose(); }
        panels.clear();
    } });
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.stopRecording', () => stop?.abort()));
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.cancelRecording', () => cancelVideo?.()));
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.saveRecording', async () => {
        const video = [...recordings].find(([panel]) => panel.active)?.[1];
        if (!video) { return; }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification, title: 'MAUI Deploy: Save Recording', cancellable: false,
            }, progress => saveVideo(video, undefined, message => progress.report({ message })));
        } catch {
            await vscode.window.showErrorMessage('Could not save the video. Choose a writable destination and try Save Recording again.');
        }
    }));
    const capture = async (kind: 'screenshot' | 'video') => {
        if (controller) {
            if (kind === 'video') { stop?.abort(); }
            return;
        }
        if (process.platform !== 'darwin') {
            await vscode.window.showInformationMessage('Device screenshots and video recording currently require macOS.');
            return;
        }
        if (!vscode.workspace.isTrusted) {
            await vscode.window.showWarningMessage('Trust this workspace before running device tools.');
            return;
        }
        controller = new AbortController();
        const signal = controller.signal;
        const label = kind === 'video' ? 'Video' : 'Screenshot';
        const output = kind === 'video' ? recordingOutput : screenshotOutput;
        const outputName = kind === 'video' ? 'MAUI Deploy - Recordings' : 'MAUI Deploy - Screenshots';
        let videoProgress: vscode.Progress<{ message?: string }> | undefined;
        let videoCancellation: vscode.CancellationToken | undefined;
        let completionMessage = 'Recording not started.';
        let previewReady = false;
        const reportVideo = (state: VideoRecordingState, message: string, elapsedMs?: number) => {
            if (kind !== 'video' || (signal.aborted && state !== 'cancelling')) { return; }
            setVideoState(state, message, elapsedMs);
            videoProgress?.report({ message });
            if (elapsedMs === undefined) { output.appendLine(message); }
        };
        const cancel = () => {
            if (signal.aborted) { return; }
            reportVideo('cancelling', previewReady ? 'Cancelling save; recording preview retained.'
                : 'Cancelling recording and removing temporary video...');
            controller?.abort();
        };
        if (kind === 'video') { cancelVideo = cancel; } else { setBusy(true); }
        let stage = 'find devices';
        output.appendLine(`${label} requested.`);
        const performCapture = async () => {
            reportVideo('findingDevices', 'Finding available devices...');
            const device = await chooseScreenshotDevice(selectedDevice(), kind === 'video' ? 'Record Video' : 'Take Screenshot', videoCancellation,
                () => reportVideo('choosingDevice', 'Waiting for device selection...'));
            if (!device || signal.aborted) {
                output.appendLine('No device selected, or request cancelled.');
                return;
            }
            output.appendLine(`Device selected: ${device.platform} ${device.type}.`);
            reportVideo('preparing', 'Preparing video recording...');
            const storage = path.join(context.globalStorageUri.fsPath, kind === 'video' ? 'recordings' : 'screenshots');
            await fs.mkdir(storage, { recursive: true, mode: 0o700 });
            let python: string | undefined;
            if (kind === 'screenshot' && device.platform === 'iOS' && device.type === 'physical') {
                stage = 'prepare the iPhone helper';
                python = await prepareIphoneHelper(storage, signal, () => controller?.abort());
                if (!python || signal.aborted) {
                    output.appendLine('Helper setup declined or cancelled.');
                    return;
                }
                output.appendLine('iPhone helper ready.');
            }
            stage = kind === 'video' ? 'record the video' : 'capture the screenshot';
            const captureDevice = async (progress: vscode.Progress<{ message?: string }>, cancellation: vscode.CancellationToken) => {
                const subscription = kind === 'screenshot' ? cancellation.onCancellationRequested(() => controller?.abort()) : undefined;
                if (cancellation.isCancellationRequested) { controller?.abort(); }
                try {
                    if (kind === 'video') {
                        stop = new AbortController();
                        const video = await captureVideo(device, {
                            signal, stop: stop.signal, storage, extensionPath: context.extensionPath,
                            onStage: nextStage => reportVideo(nextStage, videoCaptureMessages[nextStage]),
                            onStarted: () => {
                                output.appendLine('Native recording started.');
                                reportVideo('recording', `Recording ${device.name}: 00:00 / ${formatRecordingTime(videoDurationLimitMs)}`, 0);
                            },
                            onProgress: elapsedMs => reportVideo('recording',
                                `Recording ${device.name}: ${formatRecordingTime(elapsedMs)} / ${formatRecordingTime(videoDurationLimitMs)}`, elapsedMs),
                            onFinalizing: () => {
                                stop = undefined;
                                stage = 'finalize the video';
                                reportVideo('finalizing', 'Finalizing MP4...');
                            },
                            onWarning: message => {
                                output.appendLine(message);
                                void vscode.window.showWarningMessage(message);
                            },
                        });
                        if (!video) { completionMessage = 'Recording stopped before capture started.'; return; }
                        if (signal.aborted) { await discard(video); return; }
                        stage = 'open the video preview';
                        reportVideo('previewing', 'Opening video preview...');
                        let panel: vscode.WebviewPanel;
                        try {
                            panel = vscode.window.createWebviewPanel(
                                'mauideploy.recording', `Recording - ${device.name} - ${new Date().toLocaleTimeString()}`,
                                vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [vscode.Uri.file(path.dirname(video.path))] },
                            );
                        } catch (error) { await discard(video); throw error; }
                        panels.add(panel);
                        recordings.set(panel, video);
                        panel.onDidDispose(() => {
                            panels.delete(panel);
                            recordings.delete(panel);
                            void discard(video);
                        });
                        panel.webview.html = videoHtml(panel.webview.asWebviewUri(vscode.Uri.file(video.path)).toString(), panel.webview.cspSource);
                        panel.reveal(vscode.ViewColumn.Active, false);
                        previewReady = true;
                        output.appendLine('Video preview opened.');
                        stage = 'save the video';
                        completionMessage = 'Recording ready (not saved).';
                        if (await saveVideo(video, signal, message => reportVideo('saving', message))) {
                            completionMessage = 'Video saved.';
                        }
                        return;
                    }
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
                } finally { subscription?.dispose(); }
            };
            if (kind === 'video') {
                await captureDevice(videoProgress!, videoCancellation!);
            } else {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification, title: `${label}: ${device.name}`, cancellable: true,
                }, captureDevice);
            }
        };
        try {
            if (kind === 'video') {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification, title: 'MAUI Deploy: Record Video', cancellable: true,
                }, async (progress, cancellation) => {
                    videoProgress = progress;
                    const pickerCancellation = new vscode.CancellationTokenSource();
                    videoCancellation = pickerCancellation.token;
                    const cancelPicker = () => pickerCancellation.cancel();
                    signal.addEventListener('abort', cancelPicker, { once: true });
                    const subscription = cancellation.onCancellationRequested(cancel);
                    try {
                        if (cancellation.isCancellationRequested) { cancel(); }
                        if (!signal.aborted) { await performCapture(); }
                    } finally {
                        signal.removeEventListener('abort', cancelPicker);
                        subscription.dispose();
                        pickerCancellation.dispose();
                    }
                });
            } else {
                await performCapture();
            }
        } catch (error) {
            completionMessage = previewReady ? 'Recording ready, but saving failed.' : 'Recording failed.';
            const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
            const details = `code=${failure?.code ?? 'none'}, name=${failure?.name ?? 'unknown'}, killed=${!!failure?.killed}, signal=${failure?.signal ?? 'none'}`;
            output.appendLine(`Failed to ${stage}: ${details}`);
            if (!signal.aborted) {
                const code = (error as NodeJS.ErrnoException)?.code;
                let action = 'Check that the device is reachable and unlocked, then try again.';
                if (error instanceof RecordingError) {
                    action = error.message;
                } else if (stage === 'save the video') {
                    action = 'The preview is still open. Choose a writable destination using Save Recording.';
                } else if (stage === 'prepare the iPhone helper') {
                    action = 'Check your internet connection and Xcode command line tools, then retry. Installation resumes in an isolated environment.';
                } else if (code === 'ENOENT') {
                    action = 'Install the Xcode command line tools or Android SDK platform tools for the selected device.';
                }
                if (failure?.killed) {
                    action = 'The operation timed out. Check the device connection and try again.';
                }
                output.show(true);
                await vscode.window.showErrorMessage(`Could not ${stage}. ${action} See ${outputName} in Output.`);
            }
        } finally {
            const cancelledCapture = signal.aborted && !previewReady;
            output.appendLine(cancelledCapture ? `${label} cancelled.` : `${label} operation finished.`);
            stop = undefined;
            controller = undefined;
            if (kind === 'video') {
                cancelVideo = undefined;
                setVideoState('idle');
                vscode.window.setStatusBarMessage(cancelledCapture ? 'Recording cancelled.' : completionMessage, 5000);
            } else { setBusy(false); }
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.screenshot', () => capture('screenshot')));
    context.subscriptions.push(vscode.commands.registerCommand('mauideploy.recordVideo', () => capture('video')));
}

async function chooseScreenshotDevice(selectedId?: string, title = 'Take Screenshot', cancellation?: vscode.CancellationToken,
    onChoosing?: () => void): Promise<Device | undefined> {
    const devices = cancellation ? await detectScreenshotDevices() : await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window, title: 'Finding screenshot devices...',
    }, () => detectScreenshotDevices());
    if (cancellation?.isCancellationRequested) { return undefined; }
    devices.sort((left, right) => {
        if (left.id === selectedId && right.id !== selectedId) { return -1; }
        if (right.id === selectedId && left.id !== selectedId) { return 1; }
        return left.platform.localeCompare(right.platform) || left.name.localeCompare(right.name);
    });
    if (devices.length === 0) {
        await vscode.window.showInformationMessage(title === 'Record Video'
            ? 'No recording devices found. Connect and unlock a paired iPhone by USB, or start a simulator/emulator.'
            : 'No screenshot devices found. Connect a paired phone or start a simulator/emulator.');
        return undefined;
    }
    const itemForDevice = (device: Device) => ({
        label: `$(device-mobile) ${device.name}`,
        description: [device.runtime || device.platform, device.type, device.transport,
            title === 'Record Video' && device.platform === 'iOS' && device.type === 'physical' ? 'USB required' : undefined,
        ].filter(Boolean).join(' - '),
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
    onChoosing?.();
    const choice = await vscode.window.showQuickPick(items, { title, placeHolder: 'Select a device', matchOnDescription: true }, cancellation);
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

export function videoHtml(source: string, cspSource: string): string {
    const escaped = source.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${cspSource}; style-src 'unsafe-inline';">
<style>html,body{margin:0;height:100%;background:var(--vscode-editor-background)}body{display:flex;align-items:center;justify-content:center}video{display:block;max-width:100%;max-height:100%;object-fit:contain}</style>
</head><body><video aria-label="Device recording" src="${escaped}" controls autoplay muted playsinline></video></body></html>`;
}