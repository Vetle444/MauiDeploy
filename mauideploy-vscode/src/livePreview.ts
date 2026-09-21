import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { Device } from './devices';
import { installPrerequisite } from './prerequisites';
import { createUsbScreenSelection, prepareVideoHelper, RecordingError, UsbScreenSource, validateVideoRecording, VideoRecording, videoDurationLimitMs } from './recordings';

const execFileAsync = promisify(execFile);

export const livePreviewMessages = {
    findingDevices: 'Finding available devices...',
    choosingDevice: 'Waiting for device selection...',
    checkingHelper: 'Checking the macOS live-preview helper...',
    buildingHelper: 'Building the macOS live-preview helper...',
    checkingScrcpy: 'Checking scrcpy for Android preview...',
    waitingForScrcpyInstall: 'Waiting for permission to install scrcpy...',
    installingScrcpy: 'Installing scrcpy with Homebrew. This may take a few minutes...',
    starting: 'Opening the device preview...',
    waitingForUsb: 'Waiting for USB iPhone. Connect and unlock the selected phone, then trust this Mac.',
    choosingUsbScreen: 'Resolving USB screen...',
    waitingForPermission: 'Waiting for camera permission. Allow access in the macOS permission prompt.',
    live: 'Device preview is live.',
    paused: 'Device preview is paused.',
    recording: 'Recording video in the live preview.',
    finalizingRecording: 'Finalizing the preview recording...',
    disconnected: 'Device disconnected. Close the preview and reconnect the selected device.',
    simulatorOpened: 'Simulator window opened.',
    stopping: 'Closing the device preview...',
} as const;

export type LivePreviewState = keyof typeof livePreviewMessages | 'idle';

const previewErrors: Record<string, string> = {
    SCRCPY_UNAVAILABLE: 'Android live preview requires scrcpy 3 or newer and Android SDK platform tools. Install scrcpy with Homebrew: brew install scrcpy.',
    HOMEBREW_UNAVAILABLE: 'Automatic scrcpy setup requires Homebrew. Install Homebrew from https://brew.sh, then retry Live Device Preview.',
    SCRCPY_INSTALL_FAILED: 'Could not install or verify scrcpy 3 or newer. Check your connection and Homebrew setup, or run brew install scrcpy (brew upgrade scrcpy for an older installation), then retry.',
    PREVIEW_FAILED: 'Could not open the live device preview. Check the selected device connection and permissions, then try again.',
    START_TIMEOUT: 'The device preview did not start. Unlock the selected device and check its connection.',
    USB_DEVICE_UNAVAILABLE: 'The selected iPhone was not available over USB. Connect and unlock it, trust this Mac, then retry.',
    DEVICE_DISCONNECTED: 'The device disconnected. Reconnect it and start Live Device Preview again.',
};

export class LivePreviewError extends Error {
    constructor(readonly code: string) {
        super(previewErrors[code] || previewErrors.PREVIEW_FAILED);
        this.name = 'LivePreviewError';
    }
}

export interface LivePreviewOptions {
    signal: AbortSignal;
    storage: string;
    extensionPath: string;
    alwaysOnTop?: boolean;
    confirmScrcpyInstall?: (action: 'install' | 'upgrade') => Promise<boolean>;
    selectUsbScreen?: (sources: UsbScreenSource[], signal: AbortSignal) => Promise<string | undefined>;
    onScreenshot?: (image: Buffer, signal: AbortSignal) => Promise<void>;
    onRecordingReady?: (video: VideoRecording) => Promise<void>;
    onCaptureError?: (message: string) => void;
    onState: (state: Exclude<LivePreviewState, 'idle'>) => void;
}

export async function prepareScrcpy(options: LivePreviewOptions): Promise<string | undefined> {
    options.signal.throwIfAborted();
    options.onState('checkingScrcpy');
    const commandOptions = { signal: options.signal, cwd: options.storage, timeout: 10_000, maxBuffer: 64 * 1024 };
    const version = async (executable: string): Promise<number | undefined> => {
        try {
            const { stdout } = await execFileAsync(executable, ['--version'], commandOptions);
            options.signal.throwIfAborted();
            const match = /^scrcpy (\d+)\./m.exec(stdout);
            return match ? Number(match[1]) : undefined;
        } catch {
            options.signal.throwIfAborted();
            return undefined;
        }
    };
    if ((await version('scrcpy') ?? 0) >= 3) { return 'scrcpy'; }
    if (!options.confirmScrcpyInstall) { throw new LivePreviewError('SCRCPY_UNAVAILABLE'); }
    let brew: string | undefined;
    for (const executable of ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
        try {
            await execFileAsync(executable, ['--version'], commandOptions);
            brew = executable;
            break;
        } catch { options.signal.throwIfAborted(); }
    }
    if (!brew) { throw new LivePreviewError('HOMEBREW_UNAVAILABLE'); }
    try {
        const { stdout: prefix } = await execFileAsync(brew, ['--prefix', 'scrcpy'], commandOptions);
        if (!path.isAbsolute(prefix.trim())) { throw new LivePreviewError('SCRCPY_INSTALL_FAILED'); }
        const executable = path.join(prefix.trim(), 'bin', 'scrcpy');
        if ((await version(executable) ?? 0) >= 3) { return executable; }
        let action: 'install' | 'upgrade' = 'install';
        try {
            const { stdout } = await execFileAsync(brew, ['list', '--versions', 'scrcpy'], commandOptions);
            if (stdout.trim()) { action = 'upgrade'; }
        } catch { options.signal.throwIfAborted(); }
        options.signal.throwIfAborted();
        options.onState('waitingForScrcpyInstall');
        const accepted = await options.confirmScrcpyInstall(action);
        options.signal.throwIfAborted();
        if (!accepted) { return undefined; }
        options.onState('installingScrcpy');
        await installPrerequisite({
            id: 'scrcpy', title: 'scrcpy for Android live preview',
            detail: 'Install scrcpy and its dependencies using the existing Homebrew installation.',
            documentation: 'https://github.com/Genymobile/scrcpy/blob/master/doc/macos.md',
            install: {
                executable: brew, args: [action, 'scrcpy'], cwd: options.storage,
                env: { HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' },
            },
        }, options.storage, options.signal);
        options.signal.throwIfAborted();
        options.onState('checkingScrcpy');
        if ((await version(executable) ?? 0) < 3) { throw new LivePreviewError('SCRCPY_INSTALL_FAILED'); }
        return executable;
    } catch {
        options.signal.throwIfAborted();
        throw new LivePreviewError('SCRCPY_INSTALL_FAILED');
    }
}

export async function openLivePreview(device: Device, options: LivePreviewOptions): Promise<void> {
    options.signal.throwIfAborted();
    await fs.mkdir(options.storage, { recursive: true, mode: 0o700 });
    if (device.platform === 'iOS' && device.type === 'simulator') {
        options.onState('starting');
        try {
            const { stdout } = await execFileAsync('xcode-select', ['-p'], { signal: options.signal, timeout: 10_000, maxBuffer: 64 * 1024 });
            await execFileAsync('open', ['-a', `${stdout.trim()}/Applications/Simulator.app`, '--args', '-CurrentDeviceUDID', device.id], {
                signal: options.signal, timeout: 15_000, maxBuffer: 64 * 1024,
            });
        } catch {
            options.signal.throwIfAborted();
            throw new LivePreviewError('PREVIEW_FAILED');
        }
        options.signal.throwIfAborted();
        options.onState('simulatorOpened');
        return;
    }

    let command: string;
    let args: string[];
    if (device.platform === 'Android') {
        const scrcpy = await prepareScrcpy(options);
        if (!scrcpy) { return; }
        command = scrcpy;
        args = [`--serial=${device.id}`, '--no-control', '--no-audio', '--no-clipboard-autosync', '--no-power-on',
            '--max-fps=30', '--window-height=720', `--window-title=MAUI Deploy - ${device.name}`];
        if (options.alwaysOnTop) { args.push('--always-on-top'); }
    } else {
        command = await prepareVideoHelper(options.extensionPath, options.storage, options.signal, stage => {
            if (stage === 'checkingHelper' || stage === 'buildingHelper') { options.onState(stage); }
        });
        args = ['preview', device.id, device.name];
        if (options.alwaysOnTop) { args.push('--always-on-top'); }
    }
    options.signal.throwIfAborted();
    options.onState('starting');
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.storage, stdio: ['pipe', 'pipe', 'pipe'] });
        let failure: Error | undefined;
        let started = false;
        let closed = false;
        let stopping = false;
        let state: LivePreviewState = 'starting';
        let previewPaused = false;
        let screenshotBusy = false;
        let recordingBusy = false;
        let recording: VideoRecording | undefined;
        let recordingTimer: ReturnType<typeof setTimeout> | undefined;
        const captureCancellation = new AbortController();
        const ownedRecordings = new Set<VideoRecording>();
        const pendingCaptures = new Set<Promise<void>>();
        let startupTimer: ReturnType<typeof setTimeout>;
        let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            if (closed || stopping) { return; }
            stopping = true;
            captureCancellation.abort();
            clearTimeout(recordingTimer);
            usbSelection.dispose();
            clearTimeout(startupTimer);
            options.onState('stopping');
            forceStopTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
            child.stdin?.end();
            child.kill('SIGTERM');
        };
        const awaitStartup = (waitingForUsb = false) => {
            clearTimeout(startupTimer);
            startupTimer = setTimeout(() => {
                failure = new LivePreviewError(waitingForUsb ? 'USB_DEVICE_UNAVAILABLE' : 'START_TIMEOUT');
                stop();
            }, waitingForUsb || state === 'waitingForPermission' || state === 'choosingUsbScreen' ? 120_000 : 60_000);
        };
        const report = (next: Exclude<LivePreviewState, 'idle'>) => {
            if (stopping || closed || next === state) { return; }
            if (next === 'live') { started = true; clearTimeout(startupTimer); usbSelection.dispose(); }
            if (started && ['starting', 'waitingForUsb', 'waitingForPermission'].includes(next)) { return; }
            state = next;
            if (!started) { awaitStartup(next === 'waitingForUsb'); }
            options.onState(next);
        };
        const usbSelection = createUsbScreenSelection(child, {
            ...options, onStage: stage => { if (stage === 'choosingUsbScreen') { report(stage); } },
        }, error => {
            if (error) { failure = error instanceof RecordingError ? error : new LivePreviewError('PREVIEW_FAILED'); }
            stop();
        });
        const reply = (action: string, fields: Record<string, string> = {}) => {
            if (!stopping && !closed && child.stdin?.writable) { child.stdin.write(`${JSON.stringify({ action, ...fields })}\n`); }
        };
        const trackCapture = (task: () => Promise<void>) => {
            const promise = task();
            pendingCaptures.add(promise);
            void promise.finally(() => pendingCaptures.delete(promise)).catch(() => {});
        };
        const captureError = (message: string) => {
            if (!captureCancellation.signal.aborted) { options.onCaptureError?.(message); }
        };
        const captureScreenshot = (encoded: unknown) => {
            if (!started || stopping || closed || screenshotBusy) { return; }
            screenshotBusy = true;
            trackCapture(async () => {
                let success = false;
                try {
                    if (typeof encoded !== 'string' || encoded.length > 45 * 1024 * 1024 || !options.onScreenshot) {
                        throw new Error('Invalid screenshot');
                    }
                    const image = Buffer.from(encoded, 'base64');
                    if (image.length < 24 || image.length > 32 * 1024 * 1024
                        || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
                        throw new Error('Invalid screenshot');
                    }
                    captureCancellation.signal.throwIfAborted();
                    await options.onScreenshot(image, captureCancellation.signal);
                    success = true;
                } catch {
                    captureError('Could not copy the preview screenshot. The live preview is still open.');
                } finally {
                    screenshotBusy = false;
                    reply('screenshotComplete', { success: String(success) });
                }
            });
        };
        const recordingDeadline = (duration: number) => {
            clearTimeout(recordingTimer);
            recordingTimer = setTimeout(() => {
                failure = new RecordingError('FINISH_TIMEOUT');
                stop();
            }, duration);
        };
        const startRecording = () => {
            if (!started || stopping || closed || recordingBusy || recording) { return; }
            recordingBusy = true;
            trackCapture(async () => {
                try {
                    if (!options.onRecordingReady) { throw new Error('Recording unavailable'); }
                    const directory = await fs.mkdtemp(path.join(options.storage, 'video-'));
                    const candidate = { path: path.join(directory, 'recording.mp4'), dispose: () => fs.rm(directory, { recursive: true, force: true }) };
                    ownedRecordings.add(candidate);
                    captureCancellation.signal.throwIfAborted();
                    recording = candidate;
                    recordingDeadline(60_000);
                    reply('startRecording', { path: candidate.path });
                } catch {
                    recordingBusy = false;
                    captureError('Could not start recording. The live preview is still open.');
                    reply('recordingComplete', { success: 'false' });
                }
            });
        };
        const finishRecording = (success: boolean) => {
            const completed = recording;
            if (!completed) { return; }
            recording = undefined;
            clearTimeout(recordingTimer);
            trackCapture(async () => {
                let delivered = false;
                try {
                    if (!success) { throw new RecordingError('RECORDING_FAILED'); }
                    await validateVideoRecording(completed.path);
                    captureCancellation.signal.throwIfAborted();
                    await options.onRecordingReady!(completed);
                    delivered = true;
                    ownedRecordings.delete(completed);
                } catch {
                    captureError('Could not finish the preview recording. Try recording again.');
                } finally {
                    if (!delivered) { await completed.dispose().catch(() => {}); ownedRecordings.delete(completed); }
                    recordingBusy = false;
                    reply('recordingComplete', { success: String(delivered) });
                    if (!stopping && !closed && state !== 'disconnected') { report(previewPaused ? 'paused' : 'live'); }
                }
            });
        };
        awaitStartup();
        const readLine = (line: string) => {
            if (device.platform === 'Android') {
                if (/\bTexture: \d+x\d+/.test(line)) { report('live'); }
                if (/Device disconnected/i.test(line)) { report('disconnected'); }
                return;
            }
            let event: { event?: string; code?: string; devices?: unknown; image?: unknown };
            try { event = JSON.parse(line); } catch { return; }
            if (!event || typeof event !== 'object') { return; }
            if (event.event === 'screens') { usbSelection.update(event.devices); return; }
            if (event.event === 'error') { failure = new RecordingError(event.code || 'RECORDING_FAILED'); stop(); return; }
            switch (event.event) {
                case 'screenshot': captureScreenshot(event.image); break;
                case 'recordRequested': startRecording(); break;
                case 'recordingStarted':
                    if (recording) { recordingDeadline(videoDurationLimitMs + 60_000); report('recording'); }
                    break;
                case 'recordingFinalizing':
                    if (recording) { recordingDeadline(45_000); report('finalizingRecording'); }
                    break;
                case 'recordingReady': finishRecording(true); break;
                case 'recordingFailed': finishRecording(false); break;
                case 'started': report('live'); break;
                case 'resumed': previewPaused = false; if (!recordingBusy) { report('live'); } break;
                case 'paused': previewPaused = true; if (!recordingBusy) { report('paused'); } break;
                case 'starting': case 'waitingForUsb': case 'waitingForPermission': case 'disconnected': report(event.event); break;
            }
        };
        for (const stream of [child.stdout, child.stderr]) {
            let pending = '';
            stream?.setEncoding('utf8');
            stream?.on('data', (chunk: string) => {
                pending += chunk;
                let newline: number;
                while ((newline = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, newline).trim();
                    pending = pending.slice(newline + 1);
                    if (!stopping && !closed) { readLine(line); }
                }
                if (pending.length > 48 * 1024 * 1024) {
                    failure = new LivePreviewError('PREVIEW_FAILED');
                    stop();
                    pending = '';
                }
            });
        }
        child.stdin?.on('error', () => {});
        child.on('error', () => { failure = new LivePreviewError(device.platform === 'Android' ? 'SCRCPY_UNAVAILABLE' : 'PREVIEW_FAILED'); });
        child.on('close', (code, signal) => {
            closed = true;
            captureCancellation.abort();
            clearTimeout(recordingTimer);
            clearTimeout(startupTimer);
            clearTimeout(forceStopTimer);
            usbSelection.dispose();
            options.signal.removeEventListener('abort', stop);
            void (async () => {
                await Promise.allSettled(pendingCaptures);
                await Promise.all([...ownedRecordings].map(video => video.dispose()));
                if (options.signal.aborted) { resolve(); }
                else if (failure) { reject(failure); }
                else if (code !== 0 || signal) { reject(new LivePreviewError(state === 'disconnected' ? 'DEVICE_DISCONNECTED' : 'PREVIEW_FAILED')); }
                else { resolve(); }
            })().catch(reject);
        });
        options.signal.addEventListener('abort', stop, { once: true });
        if (options.signal.aborted) { stop(); }
    });
}