import { ChildProcess, execFile, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Device } from './devices';

const execFileAsync = promisify(execFile);
export const videoDurationLimitMs = 180_000;
const videoSizeLimit = 512 * 1024 * 1024;

export const videoCaptureMessages = {
    checkingHelper: 'Checking the macOS recording helper...',
    buildingHelper: 'Building the macOS recording helper for this Mac...',
    waitingForUsb: 'Waiting for USB iPhone (up to 2 minutes). Connect and unlock the selected iPhone, then trust this Mac.',
    waitingForPermission: 'Waiting for camera permission. Allow access in the macOS permission prompt.',
    starting: 'Starting native video capture...',
    downloading: 'Downloading the Android recording...',
    validating: 'Checking the MP4 recording...',
} as const;

export type VideoCaptureStage = keyof typeof videoCaptureMessages;

const recordingErrors: Record<string, string> = {
    USB_DEVICE_UNAVAILABLE: 'Connect the selected iPhone by USB, unlock it, and trust this Mac. Wi-Fi alone cannot provide USB video capture.',
    PERMISSION_DENIED: 'Allow camera access for VS Code or MAUI Deploy Screen Recorder in System Settings > Privacy & Security > Camera, then retry.',
    DEVICE_DISCONNECTED: 'The iPhone was disconnected. Reconnect it by USB and try again.',
    HELPER_BUILD_FAILED: 'Could not prepare the Mac recording helper. Select a full Xcode installation with its command line tools and try again.',
    RECORDER_UNAVAILABLE: 'Install the Xcode command line tools or Android SDK platform tools for this device.',
    START_TIMEOUT: 'The device did not start recording. Check its connection, unlock it, and accept any permission prompt.',
    STOP_FAILED: 'Could not stop the recorder cleanly. Reconnect the device and try again.',
    FINISH_TIMEOUT: 'The recorder timed out while finalizing the video.',
    RECORDING_FAILED: 'The device could not record video. Check its connection and unlock it before retrying.',
    INVALID_VIDEO: 'The recorder did not produce a valid MP4 file.',
};

export class RecordingError extends Error {
    constructor(readonly code: string) {
        super(recordingErrors[code] || recordingErrors.RECORDING_FAILED);
        this.name = 'RecordingError';
    }
}

export interface VideoRecording {
    path: string;
    dispose: () => Promise<void>;
}

export interface VideoCaptureOptions {
    signal: AbortSignal;
    stop: AbortSignal;
    storage: string;
    extensionPath: string;
    onStage?: (stage: VideoCaptureStage) => void;
    onStarted?: () => void;
    onProgress?: (elapsedMs: number) => void;
    onFinalizing?: () => void;
    onWarning?: (message: string) => void;
}

export async function prepareVideoHelper(extensionPath: string, storage: string, signal: AbortSignal,
    onStage?: (stage: VideoCaptureStage) => void): Promise<string> {
    signal.throwIfAborted();
    onStage?.('checkingHelper');
    const source = path.join(extensionPath, 'native', 'ScreenRecorder.swift');
    const info = path.join(extensionPath, 'native', 'ScreenRecorder-Info.plist');
    const hash = createHash('sha256').update(await fs.readFile(source)).update(await fs.readFile(info))
        .update(process.arch).update(os.release()).digest('hex').slice(0, 20);
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });
    const directory = path.join(storage, `recorder-${hash}`);
    const executable = path.join(directory, 'ScreenRecorder');
    try { await fs.access(executable, constants.X_OK); return executable; } catch { }
    const staging = await fs.mkdtemp(path.join(storage, '.recorder-'));
    try {
        onStage?.('buildingHelper');
        await execFileAsync('xcrun', [
            'swiftc', '-swift-version', '5', '-O', source, '-o', path.join(staging, 'ScreenRecorder'),
            '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', info,
        ], { cwd: storage, signal, timeout: 120_000, maxBuffer: 512 * 1024 });
        signal.throwIfAborted();
        try { await fs.rename(staging, directory); } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) { throw error; }
            await fs.access(executable, constants.X_OK);
        }
        return executable;
    } catch (error) {
        signal.throwIfAborted();
        throw new RecordingError('HELPER_BUILD_FAILED');
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}

export async function captureVideo(device: Device, options: VideoCaptureOptions): Promise<VideoRecording | undefined> {
    options.signal.throwIfAborted();
    if (options.stop.aborted) { return undefined; }
    await fs.mkdir(options.storage, { recursive: true, mode: 0o700 });
    const helper = device.platform === 'iOS' && device.type === 'physical'
        ? await prepareVideoHelper(options.extensionPath, options.storage, options.signal, options.onStage) : undefined;
    options.signal.throwIfAborted();
    if (options.stop.aborted) { return undefined; }
    const directory = await fs.mkdtemp(path.join(options.storage, 'video-'));
    const video = path.join(directory, 'recording.mp4');
    const dispose = () => fs.rm(directory, { recursive: true, force: true });
    let retained = false;
    try {
        let started: boolean;
        if (device.platform === 'Android') {
            started = await recordAndroid(device, video, options);
        } else if (device.type === 'simulator') {
            started = await runRecorder('xcrun', ['simctl', 'io', device.id, 'recordVideo', '--codec=h264', video], options, video, line => {
                return line.includes('Recording started') ? 'started' : undefined;
            });
        } else {
            started = await runRecorder(helper!, ['record', device.id, video], options, video.replace(/\.mp4$/, '.mov'), line => {
                let event: { event?: string; code?: string };
                try { event = JSON.parse(line); } catch { return undefined; }
                if (event.event === 'error') { throw new RecordingError(event.code || 'RECORDING_FAILED'); }
                switch (event.event) {
                    case 'started': case 'finalizing': case 'waitingForUsb': case 'waitingForPermission': case 'starting':
                        return event.event;
                    default: return undefined;
                }
            });
        }
        options.signal.throwIfAborted();
        if (!started) { return undefined; }
        options.onStage?.('validating');
        const file = await fs.open(video, 'r').catch(() => { throw new RecordingError('INVALID_VIDEO'); });
        try {
            const info = await file.stat();
            const header = Buffer.alloc(12);
            const { bytesRead } = await file.read(header, 0, header.length, 0);
            if (info.size < 32 || info.size > videoSizeLimit || bytesRead !== header.length || header.toString('ascii', 4, 8) !== 'ftyp') {
                throw new RecordingError('INVALID_VIDEO');
            }
        } finally { await file.close(); }
        await fs.chmod(video, 0o600);
        retained = true;
        return { path: video, dispose };
    } finally {
        if (!retained) { await dispose(); }
    }
}

async function recordAndroid(device: Device, video: string, options: VideoCaptureOptions): Promise<boolean> {
    const remote = `/data/local/tmp/mauideploy-video-${randomUUID()}`;
    const movie = `${remote}/recording.mp4`;
    let recorderPid: string | undefined;
    const signalOwnedRecorder = `if test -r /proc/$recorder_pid/cmdline && tr '\\0' ' ' < /proc/$recorder_pid/cmdline | grep -F -q '${movie}'; then kill -INT "$recorder_pid" 2>/dev/null; fi`;
    const stopRemote = async () => {
        if (!recorderPid) { return; }
        await execFileAsync('adb', ['-s', device.id, 'shell', '-T', `recorder_pid=${recorderPid}; ${signalOwnedRecorder}`], { timeout: 10_000, maxBuffer: 64 * 1024 });
    };
    const script = `umask 077; mkdir ${remote} || exit 1; screenrecord --bit-rate 8000000 --time-limit 180 ${movie} & recorder_pid=$!; echo "$recorder_pid" > ${remote}/pid; trap 'kill -INT "$recorder_pid" 2>/dev/null' HUP INT TERM; echo MAUI_RECORDING:$recorder_pid; wait "$recorder_pid"`;
    try {
        const started = await runRecorder('adb', ['-s', device.id, 'shell', '-T', script], options, video, line => {
            const match = /^MAUI_RECORDING:([1-9][0-9]*)$/.exec(line.trim());
            if (!match) { return undefined; }
            recorderPid = match[1];
            return 'started';
        }, stopRemote);
        options.signal.throwIfAborted();
        if (!started) { return false; }
        options.onStage?.('downloading');
        await execFileAsync('adb', ['-s', device.id, 'pull', movie, video], {
            signal: options.signal, timeout: 120_000, maxBuffer: 512 * 1024,
        });
        return true;
    } finally {
        const cleanup = `if test -f ${remote}/pid; then read recorder_pid < ${remote}/pid; case "$recorder_pid" in ''|*[!0-9]*) exit 1;; esac; ${signalOwnedRecorder}; fi; rm -rf ${remote}`;
        try {
            await execFileAsync('adb', ['-s', device.id, 'shell', '-T', cleanup], { timeout: 10_000, maxBuffer: 64 * 1024 });
        } catch {
            options.onWarning?.(`Could not remove the temporary Android recording. Reconnect the device and remove ${remote} with adb.`);
        }
    }
}

async function runRecorder(command: string, args: string[], options: VideoCaptureOptions, growingFile: string,
    readLine: (line: string) => 'started' | 'finalizing' | 'waitingForUsb' | 'waitingForPermission' | 'starting' | undefined,
    stopRemote?: () => Promise<void>): Promise<boolean> {
    options.signal.throwIfAborted();
    if (options.stop.aborted) { return false; }
    options.onStage?.('starting');
    return new Promise<boolean>((resolve, reject) => {
        const child: ChildProcess = spawn(command, args, { cwd: options.storage, stdio: ['ignore', 'pipe', 'pipe'] });
        let started = false;
        let stopping = false;
        let finalizing = false;
        let closed = false;
        let failure: Error | undefined;
        let startupTimer: ReturnType<typeof setTimeout>;
        let durationTimer: ReturnType<typeof setTimeout> | undefined;
        let finishTimer: ReturnType<typeof setTimeout> | undefined;
        let progressTimer: ReturnType<typeof setInterval> | undefined;
        const armFinishTimeout = () => {
            if (finishTimer || closed) { return; }
            finishTimer = setTimeout(() => {
                failure ??= new RecordingError('FINISH_TIMEOUT');
                child.kill('SIGKILL');
            }, 45_000);
        };
        const finalize = () => {
            if (finalizing) { return; }
            finalizing = true;
            clearTimeout(durationTimer);
            clearInterval(progressTimer);
            options.onFinalizing?.();
            armFinishTimeout();
        };
        const sendStop = () => {
            if (stopRemote) {
                if (started) {
                    void stopRemote().catch(() => {
                        if (closed) { return; }
                        failure ??= new RecordingError('STOP_FAILED');
                        child.kill('SIGTERM');
                    });
                }
            } else {
                child.kill('SIGINT');
            }
        };
        const stop = () => {
            if (stopping || closed) { return; }
            stopping = true;
            clearTimeout(startupTimer);
            finalize();
            sendStop();
        };
        const awaitStartup = (stage: 'starting' | 'waitingForUsb' | 'waitingForPermission') => {
            clearTimeout(startupTimer);
            startupTimer = setTimeout(() => {
                failure ??= new RecordingError(stage === 'waitingForUsb' ? 'USB_DEVICE_UNAVAILABLE' : 'START_TIMEOUT');
                stop();
            }, stage === 'starting' ? 60_000 : 120_000);
        };
        awaitStartup('starting');
        const ready = () => {
            if (started) { return; }
            started = true;
            clearTimeout(startupTimer);
            if (stopping) { sendStop(); return; }
            const began = performance.now();
            durationTimer = setTimeout(stop, videoDurationLimitMs);
            progressTimer = setInterval(() => {
                options.onProgress?.(performance.now() - began);
                void fs.stat(growingFile).then(info => {
                    if (info.size >= videoSizeLimit) { stop(); }
                }).catch(() => {});
            }, 1000);
            options.onStarted?.();
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
                    try {
                        const event = readLine(line);
                        if (event === 'started') { ready(); }
                        if (event === 'finalizing') { finalize(); }
                        if (!started && !stopping && !closed
                            && (event === 'waitingForUsb' || event === 'waitingForPermission' || event === 'starting')) {
                            awaitStartup(event);
                            options.onStage?.(event);
                        }
                    } catch (error) {
                        failure = error instanceof RecordingError ? error : new RecordingError('RECORDING_FAILED');
                        stop();
                    }
                }
                if (pending.length > 4096) { pending = ''; }
            });
        }
        options.signal.addEventListener('abort', stop, { once: true });
        options.stop.addEventListener('abort', stop, { once: true });
        child.on('error', () => { failure = new RecordingError('RECORDER_UNAVAILABLE'); });
        child.on('close', (code, signal) => {
            closed = true;
            clearTimeout(startupTimer);
            clearTimeout(durationTimer);
            clearTimeout(finishTimer);
            clearInterval(progressTimer);
            options.signal.removeEventListener('abort', stop);
            options.stop.removeEventListener('abort', stop);
            if (options.signal.aborted) { reject(options.signal.reason); }
            else if (failure) { reject(failure); }
            else if (code !== 0 && !(stopping && (code === 130 || signal === 'SIGINT'))) { reject(new RecordingError('RECORDING_FAILED')); }
            else if (!started && !stopping) { reject(new RecordingError('RECORDING_FAILED')); }
            else {
                finalize();
                resolve(started);
            }
        });
        if (options.signal.aborted || options.stop.aborted) { stop(); }
    });
}