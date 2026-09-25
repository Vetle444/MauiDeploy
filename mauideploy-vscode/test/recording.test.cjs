const assert = require('node:assert/strict');
const { test } = require('node:test');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const actualExecFile = childProcess.execFile;
let execute;
const fakeExecFile = () => {};
fakeExecFile[promisify.custom] = (...args) => execute(...args);
childProcess.execFile = fakeExecFile;
const { captureVideo, createUsbScreenSelection, prepareVideoHelper, validateVideoRecording, videoDurationLimitMs } = require('../out/recordings');
const { openLivePreview, prepareScrcpy } = require('../out/livePreview');
childProcess.execFile = actualExecFile;

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);

function fixture(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-video-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return {
        directory, controller: new AbortController(), stop: new AbortController(),
        options: { storage: directory, extensionPath: path.resolve(__dirname, '..') },
    };
}

function recorder(context, onStart, onStop, screenSources) {
    context.mock.method(childProcess, 'spawn', (command, args, options) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.signals = [];
        child.kill = signal => {
            child.signals.push(signal);
            onStop(child, signal);
            return true;
        };
        if (screenSources !== undefined) {
            child.stdin.once('data', data => {
                const { screenId } = JSON.parse(data.toString());
                assert.ok(screenSources.some(source => source.id === screenId));
                onStart(child, command, [args[0], screenId, ...args.slice(2)], options);
            });
            queueMicrotask(() => child.stdout.write(JSON.stringify({ event: 'screens', devices: screenSources }) + '\n'));
        } else { queueMicrotask(() => onStart(child, command, args, options)); }
        return child;
    });
}

test('simulator video waits for readiness and SIGINT finalization, retains only the MP4 until disposed', async context => {
    const { directory, controller, stop, options } = fixture(context);
    let output;
    let finalized = false;
    recorder(context, (child, command, args, spawnOptions) => {
        assert.equal(command, 'xcrun');
        assert.deepEqual(args.slice(0, -1), ['simctl', 'io', 'chosen', 'recordVideo', '--codec=h264']);
        assert.equal(spawnOptions.cwd, directory);
        output = args.at(-1);
        assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
        child.stderr.write('Recording sta');
        child.stderr.write('rted\n');
    }, (child, signal) => {
        assert.equal(signal, 'SIGINT');
        assert.equal(finalized, true);
        fs.writeFileSync(output, mp4);
        child.emit('close', 0, null);
    });
    const video = await captureVideo({ id: 'chosen', platform: 'iOS', type: 'simulator' }, {
        ...options, signal: controller.signal, stop: stop.signal,
        onStarted() { stop.abort(); }, onFinalizing() { finalized = true; },
    });
    assert.equal(video.path, output);
    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(fs.readFileSync(video.path), mp4);
    assert.equal(fs.statSync(video.path).mode & 0o777, 0o600);
    await video.dispose();
    await video.dispose();
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('USB source selection sends the confirmed native UUID to the same capture process', async context => {
    const { directory, controller, options } = fixture(context);
    const nativeId = '12345678-1234-1234-1234-123456789abc';
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    const request = new Promise(resolve => child.stdin.once('data', data => resolve(JSON.parse(data.toString()))));
    const states = [];
    const selection = createUsbScreenSelection(child, {
        ...options, signal: controller.signal, onStage: stage => states.push(stage),
        selectUsbScreen: async sources => {
            assert.deepEqual(sources, [{ id: nativeId, name: 'iPhone' }]);
            return nativeId;
        },
    }, () => assert.fail('Selection must not restart or stop the capture process.'));
    selection.update([]);
    selection.update([{ id: nativeId, name: 'iPhone' }]);
    assert.deepEqual(await request, { screenId: nativeId });
    assert.equal(states.at(-1), 'choosingUsbScreen');
    selection.dispose();
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('USB source selection never silently selects a different phone and discards cancelled choices', async context => {
    const { controller, options } = fixture(context);
    for (const scenario of ['decline', 'noPicker', 'cancel', 'removed']) {
        const abort = new AbortController();
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdin.on('data', () => assert.fail('Unconfirmed or cancelled sources must not reach capture.'));
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        let answered;
        const answer = new Promise(resolve => { answered = resolve; });
        const selection = createUsbScreenSelection(child, {
            ...options, signal: abort.signal,
            selectUsbScreen: scenario === 'noPicker' ? undefined : async (sources, signal) => {
                if (scenario === 'decline') { return undefined; }
                if (scenario === 'removed') { selection.update([]); }
                abort.abort();
                assert.equal(signal.aborted, true);
                answered();
                return sources[0].id;
            },
        }, finish);
        selection.update([{ id: 'native-id', name: 'iPhone' }]);
        if (scenario === 'noPicker') { assert.equal((await done).code, 'USB_SCREEN_SELECTION_REQUIRED'); }
        else if (scenario === 'decline') { assert.equal(await done, undefined); }
        else { await answer; }
        selection.dispose();
    }
    controller.abort();
    const selection = createUsbScreenSelection({ stdin: new PassThrough() }, { ...options, signal: controller.signal }, () => assert.fail('Cancelled selection must be ignored.'));
    selection.update([{ id: 'native-id', name: 'iPhone' }]);
    selection.dispose();
});

test('cancellation and failed or empty video remove temporary output without returning a recording', async context => {
    const { directory, controller, stop, options } = fixture(context);
    const device = { id: 'chosen', platform: 'iOS', type: 'simulator' };
    stop.abort();
    assert.equal(await captureVideo(device, { ...options, signal: controller.signal, stop: stop.signal }), undefined);
    for (const scenario of ['cancel', 'failure', 'invalid', 'missing']) {
        const cancellation = new AbortController();
        let output;
        recorder(context, (child, command, args) => {
            output = args.at(-1);
            if (scenario !== 'missing') { fs.writeFileSync(output, 'not a video'); }
            child.stderr.write('Recording started\n');
            if (scenario === 'cancel') { cancellation.abort(); }
            else { child.emit('close', scenario === 'failure' ? 1 : 0, null); }
        }, child => child.emit('close', null, 'SIGINT'));
        await assert.rejects(captureVideo(device, { ...options, signal: cancellation.signal, stop: new AbortController().signal }),
            scenario === 'cancel' ? { name: 'AbortError' } : { code: scenario === 'failure' ? 'RECORDING_FAILED' : 'INVALID_VIDEO' });
        assert.deepEqual(fs.readdirSync(directory), []);
        context.mock.restoreAll();
    }
});

test('Android video interrupts only its recorder PID, pulls after exit, and removes its unique device directory', async context => {
    const { controller, stop, options } = fixture(context);
    let child;
    let remote;
    let exited = false;
    const commands = [];
    recorder(context, (process, command, args) => {
        child = process;
        assert.equal(command, 'adb');
        assert.deepEqual(args.slice(0, 4), ['-s', 'chosen', 'shell', '-T']);
        remote = /\/data\/local\/tmp\/mauideploy-video-[0-9a-f-]+/.exec(args.at(-1))[0];
        assert.match(args.at(-1), /screenrecord --bit-rate 8000000 --time-limit 180/);
        child.stdout.write('MAUI_RECORDING:4321\n');
    }, () => assert.fail('Android Stop must signal the device recorder, not kill adb.'));
    execute = async (command, args) => {
        assert.equal(command, 'adb');
        assert.deepEqual(args.slice(0, 2), ['-s', 'chosen']);
        commands.push(args);
        if (args.at(-1).startsWith('recorder_pid=4321;')) {
            assert.ok(args.at(-1).includes(`/proc/$recorder_pid/cmdline`));
            assert.ok(args.at(-1).includes(`${remote}/recording.mp4`));
            assert.ok(args.at(-1).includes('kill -INT "$recorder_pid"'));
            exited = true;
            queueMicrotask(() => child.emit('close', 130, null));
        } else if (args[2] === 'pull') {
            assert.equal(exited, true);
            assert.equal(args[3], `${remote}/recording.mp4`);
            fs.writeFileSync(args[4], mp4);
        } else {
            assert.ok(args.at(-1).endsWith(`rm -rf ${remote}`));
            assert.ok(args.at(-1).includes(`/proc/$recorder_pid/cmdline`));
        }
        return { stdout: '' };
    };
    const video = await captureVideo({ id: 'chosen', platform: 'Android', type: 'physical' }, {
        ...options, signal: controller.signal, stop: stop.signal, onStarted() { stop.abort(); },
    });
    assert.equal(commands.length, 3);
    assert.deepEqual(fs.readFileSync(video.path), mp4);
    await video.dispose();
});

test('automatic stop uses the three-minute limit and still finalizes the MP4', async context => {
    const { controller, stop, options } = fixture(context);
    const originalTimeout = global.setTimeout;
    let expire;
    context.mock.method(global, 'setTimeout', (callback, duration, ...args) => {
        if (duration === videoDurationLimitMs) { expire = callback; }
        return originalTimeout(callback, duration, ...args);
    });
    let output;
    recorder(context, (child, command, args) => {
        output = args.at(-1);
        child.stderr.write('Recording started\n');
        assert.equal(videoDurationLimitMs, 180_000);
        expire();
    }, (child, signal) => {
        assert.equal(signal, 'SIGINT');
        fs.writeFileSync(output, mp4);
        child.emit('close', 0, null);
    });
    const video = await captureVideo({ id: 'chosen', platform: 'iOS', type: 'simulator' }, {
        ...options, signal: controller.signal, stop: stop.signal,
    });
    await video.dispose();
});

test('USB recording targets the exact iPhone and maps permission and connection errors without exposing stderr', async context => {
    const { directory, controller, options } = fixture(context);
    execute = async (command, args) => {
        assert.equal(command, 'xcrun');
        const output = args[args.indexOf('-o') + 1];
        fs.writeFileSync(output, 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    for (const scenario of ['success', 'PERMISSION_DENIED', 'USB_DEVICE_UNAVAILABLE', 'DEVICE_DISCONNECTED']) {
        const stop = new AbortController();
        let output;
        let finalizations = 0;
        recorder(context, (child, command, args) => {
            assert.equal(path.basename(command), 'ScreenRecorder');
            assert.deepEqual(args.slice(0, 2), ['record', 'native-screen-uuid']);
            output = args.at(-1);
            child.stderr.write('private device diagnostics\n');
            if (scenario === 'success') {
                child.stdout.write('{"event":"started"}\n');
            } else {
                child.stdout.write(`${JSON.stringify({ event: 'error', code: scenario })}\n`);
            }
        }, (child, signal) => {
            assert.equal(signal, 'SIGINT');
            if (scenario === 'success') {
                child.stdout.write('{"event":"finalizing"}\n');
                fs.writeFileSync(output, mp4);
            }
            child.emit('close', scenario === 'success' ? 0 : 1, null);
        }, [{ id: 'native-screen-uuid', name: 'iPhone' }]);
        const promise = captureVideo({ id: '00008030-1234567890ABCDEF', platform: 'iOS', type: 'physical' }, {
            ...options, signal: controller.signal, stop: stop.signal,
            selectUsbScreen: async sources => sources[0].id,
            onStarted() { stop.abort(); }, onFinalizing() { finalizations++; },
        });
        if (scenario === 'success') {
            const video = await promise;
            assert.equal(finalizations, 1);
            await video.dispose();
        } else {
            await assert.rejects(promise, error => error.code === scenario && !error.message.includes('private device diagnostics'));
        }
        assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('video-')));
        context.mock.restoreAll();
    }
});

test('USB and permission waits report distinct stages before recording and give each wait its own deadline', async context => {
    const { directory, controller, options } = fixture(context);
    const stages = [];
    const originalTimeout = global.setTimeout;
    const deadlines = [];
    context.mock.method(global, 'setTimeout', (callback, duration, ...args) => {
        deadlines.push(duration);
        return originalTimeout(callback, duration, ...args);
    });
    execute = async (command, args) => {
        assert.equal(stages.at(-1), 'buildingHelper');
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    let output;
    let started = false;
    const stop = new AbortController();
    recorder(context, (child, command, args) => {
        output = args.at(-1);
        for (const stage of ['waitingForUsb', 'waitingForPermission', 'starting']) {
            child.stdout.write(`${JSON.stringify({ event: stage })}\n`);
            assert.equal(stages.at(-1), stage);
            assert.equal(started, false);
        }
        child.stdout.write('{"event":"started"}\n');
        child.stdout.write('{"event":"waitingForUsb"}\n');
        assert.notEqual(stages.at(-1), 'waitingForUsb');
    }, child => {
        fs.writeFileSync(output, mp4);
        child.emit('close', 0, null);
    });
    const video = await captureVideo({ id: 'chosen', platform: 'iOS', type: 'physical' }, {
        ...options, signal: controller.signal, stop: stop.signal,
        onStage: stage => stages.push(stage), onStarted() { started = true; stop.abort(); },
    });
    assert.deepEqual(stages, ['checkingHelper', 'buildingHelper', 'starting', 'waitingForUsb', 'waitingForPermission', 'starting', 'validating']);
    assert.equal(deadlines.filter(duration => duration === 120_000).length, 2);
    await video.dispose();
    stages.length = 0;
    await prepareVideoHelper(options.extensionPath, directory, controller.signal, stage => stages.push(stage));
    assert.deepEqual(stages, ['checkingHelper']);
});

test('USB wait remains cancellable and expires with actionable USB feedback without starting a recording', async context => {
    const { directory, options } = fixture(context);
    execute = async (command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    for (const scenario of ['cancel', 'timeout']) {
        const controller = new AbortController();
        const originalTimeout = global.setTimeout;
        let expire;
        context.mock.method(global, 'setTimeout', (callback, duration, ...args) => {
            if (duration === 120_000) { expire = callback; }
            return originalTimeout(callback, duration, ...args);
        });
        recorder(context, child => {
            child.stdout.write('{"event":"waitingForUsb"}\n');
            if (scenario === 'cancel') { controller.abort(); } else { expire(); }
        }, (child, signal) => {
            assert.equal(signal, 'SIGINT');
            child.emit('close', 0, null);
        });
        await assert.rejects(captureVideo({ id: 'chosen', platform: 'iOS', type: 'physical' }, {
            ...options, signal: controller.signal, stop: new AbortController().signal,
            onStarted() { assert.fail('Waiting for USB is not recording.'); },
        }), scenario === 'cancel' ? { name: 'AbortError' } : { code: 'USB_DEVICE_UNAVAILABLE' });
        assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('video-')));
        context.mock.restoreAll();
    }
});

test('startup and finalization timeouts terminate only the owned process and clean temporary video', async context => {
    const { directory, controller, options } = fixture(context);
    for (const scenario of ['startup', 'finalization']) {
        const timers = new Map();
        const originalTimeout = global.setTimeout;
        const stop = new AbortController();
        context.mock.method(global, 'setTimeout', (callback, duration, ...args) => {
            timers.set(duration, callback);
            return originalTimeout(callback, duration, ...args);
        });
        const signals = [];
        recorder(context, child => {
            if (scenario === 'startup') { timers.get(60_000)(); }
            else { child.stderr.write('Recording started\n'); }
            timers.get(45_000)();
        }, (child, signal) => {
            signals.push(signal);
            if (signal === 'SIGKILL') { child.emit('close', null, signal); }
        });
        await assert.rejects(captureVideo({ id: 'chosen', platform: 'iOS', type: 'simulator' }, {
            ...options, signal: controller.signal, stop: stop.signal, onStarted() { stop.abort(); },
        }), { code: scenario === 'startup' ? 'START_TIMEOUT' : 'FINISH_TIMEOUT' });
        assert.deepEqual(signals, ['SIGINT', 'SIGKILL']);
        assert.deepEqual(fs.readdirSync(directory), []);
        context.mock.restoreAll();
    }
});

test('Android cancellation skips download and failed downloads still remove device and local temporary files', async context => {
    const { directory, options } = fixture(context);
    for (const scenario of ['cancel', 'download']) {
        const controller = new AbortController();
        const stop = new AbortController();
        let child;
        let pulled = false;
        let cleaned = false;
        recorder(context, process => {
            child = process;
            child.stdout.write('MAUI_RECORDING:4321\n');
        }, () => assert.fail('Cancellation must gracefully signal the device recorder.'));
        execute = async (command, args) => {
            if (args.at(-1).startsWith('recorder_pid=4321;')) {
                queueMicrotask(() => child.emit('close', 0, null));
            } else if (args[2] === 'pull') {
                pulled = true;
                throw new Error('download failed');
            } else {
                assert.match(args.at(-1), /rm -rf \/data\/local\/tmp\/mauideploy-video-/);
                cleaned = true;
            }
            return { stdout: '' };
        };
        await assert.rejects(captureVideo({ id: 'chosen', platform: 'Android', type: 'physical' }, {
            ...options, signal: controller.signal, stop: stop.signal,
            onStarted() { if (scenario === 'cancel') { controller.abort(); } else { stop.abort(); } },
        }), scenario === 'cancel' ? { name: 'AbortError' } : /download failed/);
        assert.equal(pulled, scenario === 'download');
        assert.equal(cleaned, true);
        assert.deepEqual(fs.readdirSync(directory), []);
        context.mock.restoreAll();
    }
});

test('native movie finalization exports a synthetic MP4 without synchronously stopping the capture session', { skip: process.platform !== 'darwin' }, async context => {
    const { directory, options } = fixture(context);
    const source = fs.readFileSync(path.join(options.extensionPath, 'native', 'ScreenRecorder.swift'), 'utf8');
    const start = source.indexOf('final class ScreenRecorder:');
    const end = source.indexOf('let arguments = CommandLine.arguments');
    assert.ok(start > 0 && end > start);
    const recorderSource = source.slice(start, end).replace('private let session = AVCaptureSession()', 'private let session = StopSensitiveSession()');
    assert.notEqual(recorderSource, source.slice(start, end));
    const harness = source.slice(0, start) + `
final class StopSensitiveSession: AVCaptureSession {
    override func stopRunning() { fail("SESSION_STOP_BEFORE_EXPORT") }
}
` + recorderSource + `
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let movie = destination.deletingPathExtension().appendingPathExtension("mov")
let recorder = ScreenRecorder(destination: destination)
let writer = try AVAssetWriter(outputURL: movie, fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input)
writer.add(input)
guard writer.startWriting() else { fail("SYNTHETIC_WRITER_FAILED") }
writer.startSession(atSourceTime: .zero)
var frameIndex: Int64 = 0
input.requestMediaDataWhenReady(on: DispatchQueue(label: "synthetic-frames")) {
    while input.isReadyForMoreMediaData && frameIndex < 3 {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32ARGB, nil, &buffer) == kCVReturnSuccess,
              let pixels = buffer else { fail("SYNTHETIC_BUFFER_FAILED") }
        CVPixelBufferLockBaseAddress(pixels, [])
        memset(CVPixelBufferGetBaseAddress(pixels), 120, CVPixelBufferGetDataSize(pixels))
        CVPixelBufferUnlockBaseAddress(pixels, [])
        guard adaptor.append(pixels, withPresentationTime: CMTime(value: frameIndex, timescale: 30)) else { fail("SYNTHETIC_APPEND_FAILED") }
        frameIndex += 1
    }
    if frameIndex == 3 {
        frameIndex += 1
        input.markAsFinished()
        writer.finishWriting {
            guard writer.status == .completed else { fail("SYNTHETIC_MOVIE_FAILED") }
            recorder.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: movie, from: [], error: nil)
        }
    }
}
RunLoop.main.run()
`;
    const filename = path.join(directory, 'Finalization.swift');
    const executable = path.join(directory, 'Finalization');
    const output = path.join(directory, 'synthetic.mp4');
    fs.writeFileSync(filename, harness);
    const actualExecute = promisify(actualExecFile);
    await actualExecute('xcrun', ['swiftc', '-swift-version', '5', '-O', filename, '-o', executable], { timeout: 120_000 });
    const { stdout } = await actualExecute(executable, [output], { timeout: 15_000 });
    const events = stdout.trim().split('\n').map(line => JSON.parse(line).event);
    assert.deepEqual(events, ['finalizing', 'finished']);
    assert.equal(fs.existsSync(path.join(directory, 'synthetic.mov')), false);
    await validateVideoRecording(output);
});

test('native helper builds with usage metadata, caches, lists screen sources and handles early Stop', { skip: process.platform !== 'darwin' }, async context => {
    const { directory, controller, options } = fixture(context);
    const actualExecute = promisify(actualExecFile);
    let builds = 0;
    execute = (...args) => { builds++; return actualExecute(...args); };
    const helper = await prepareVideoHelper(options.extensionPath, directory, controller.signal);
    assert.equal(await prepareVideoHelper(options.extensionPath, directory, controller.signal), helper);
    assert.equal(builds, 1);
    const { stdout } = await actualExecute(helper, ['list'], { timeout: 15_000 });
    const devices = JSON.parse(stdout).devices;
    assert.ok(Array.isArray(devices));
    const source = fs.readFileSync(path.join(options.extensionPath, 'native', 'ScreenRecorder.swift'), 'utf8');
    assert.ok(source.includes('mediaType: .muxed'));
    assert.ok(source.includes('selectedScreenID.map(normalizedID) ?? targetID'));
    assert.ok(source.includes('normalizedID($0.uniqueID) == selectedID'));
    assert.ok(source.includes('output.connection(with: .audio)?.isEnabled = false'));
    const plist = fs.readFileSync(path.join(options.extensionPath, 'native', 'ScreenRecorder-Info.plist'), 'utf8');
    assert.ok(plist.includes('NSCameraUsageDescription'));
    for (const mode of ['record', 'preview']) {
        await new Promise((resolve, reject) => {
            const child = childProcess.spawn(helper, [mode, 'mauideploy-test-not-a-device', mode === 'record' ? path.join(directory, 'cancelled.mp4') : 'Preview Lifecycle Check'], {
                signal: AbortSignal.timeout(15_000), stdio: ['pipe', 'pipe', 'pipe'],
            });
            let pending = '';
            let ready = false;
            child.stdout.on('data', chunk => {
                pending += chunk.toString();
                if (!ready && (pending.includes('"waitingForUsb"') || pending.includes('"screens"'))) {
                    ready = true;
                    if (mode === 'record') { child.kill('SIGINT'); } else { child.stdin.end(); }
                }
            });
            child.on('error', reject);
            child.on('close', (code, signal) => {
                try {
                    assert.equal(ready, true);
                    assert.equal(code, 0);
                    assert.equal(signal, null);
                    assert.equal(fs.existsSync(path.join(directory, 'cancelled.mp4')), false);
                    resolve();
                } catch (error) { reject(error); }
            });
        });
    }
});

test('live USB preview waits for actual frames, reports pause/disconnect, and never writes a recording', async context => {
    const { directory, controller, options } = fixture(context);
    const states = [];
    execute = async (command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    let process;
    recorder(context, (child, command, args, spawnOptions) => {
        process = child;
        child.stdin = new PassThrough();
        assert.equal(path.basename(command), 'ScreenRecorder');
        assert.deepEqual(args, ['preview', 'native-screen-uuid', 'Phone']);
        assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
        for (const event of ['waitingForUsb', 'waitingForPermission', 'started', 'paused', 'resumed', 'disconnected']) {
            child.stdout.write(`${JSON.stringify({ event })}\n`);
        }
        child.stderr.write('private device diagnostics\n');
        controller.abort();
    }, (child, signal) => {
        assert.equal(signal, 'SIGTERM');
        child.emit('close', 0, null);
    }, [{ id: 'native-screen-uuid', name: 'iPhone' }]);
    await openLivePreview({ id: 'chosen', name: 'Phone', platform: 'iOS', type: 'physical' }, {
        ...options, signal: controller.signal, onState: state => states.push(state),
        selectUsbScreen: async sources => sources[0].id,
    });
    assert.deepEqual(states, ['checkingHelper', 'buildingHelper', 'starting', 'choosingUsbScreen', 'waitingForUsb', 'waitingForPermission',
        'live', 'paused', 'live', 'disconnected', 'stopping']);
    assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('video-')));
    assert.deepEqual(process.signals, ['SIGTERM']);
});

test('Android preview uses the selected scrcpy device with audio, control, clipboard and recording disabled', async context => {
    const { controller, options } = fixture(context);
    const states = [];
    execute = async (command, args) => {
        assert.equal(command, 'scrcpy');
        assert.deepEqual(args, ['--version']);
        return { stdout: 'scrcpy 3.3.2 <https://github.com/Genymobile/scrcpy>\n' };
    };
    recorder(context, (child, command, args) => {
        assert.equal(command, 'scrcpy');
        assert.ok(args.includes('--serial=192.0.2.1:5555'));
        for (const flag of ['--no-control', '--no-audio', '--no-clipboard-autosync', '--no-power-on', '--max-fps=30']) {
            assert.ok(args.includes(flag));
        }
        assert.ok(!args.some(value => value.startsWith('--record')));
        assert.ok(args.includes('--always-on-top'));
        assert.equal(states.at(-1), 'starting');
        child.stderr.write('INFO: Text');
        child.stderr.write('ure: 1080x2400\n');
        assert.equal(states.at(-1), 'live');
        child.emit('close', 0, null);
    }, () => assert.fail('Normal preview closure must not kill other processes.'));
    await openLivePreview({ id: '192.0.2.1:5555', name: 'Android', platform: 'Android', type: 'physical' }, {
        ...options, signal: controller.signal, alwaysOnTop: true, onState: state => states.push(state),
    });
    assert.deepEqual(states, ['checkingScrcpy', 'starting', 'live']);
});

test('preview screenshot and record actions keep the stream open and hand off only validated output', async context => {
    const { directory, controller, options } = fixture(context);
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8192)]);
    const states = [];
    let screenshots = 0;
    let savedVideo;
    let process;
    execute = async (command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    recorder(context, child => {
        process = child;
        child.stdin.on('data', data => {
            const request = JSON.parse(data.toString());
            if (request.action === 'screenshotComplete') {
                assert.equal(request.success, 'true');
                child.stdout.write('{"event":"recordRequested"}\n');
                child.stdout.write('{"event":"recordRequested"}\n');
            } else if (request.action === 'startRecording') {
                assert.equal(fs.statSync(path.dirname(request.path)).mode & 0o777, 0o700);
                fs.writeFileSync(request.path, mp4);
                child.stdout.write('{"event":"recordingStarted"}\n{"event":"recordingFinalizing"}\n{"event":"recordingReady"}\n');
            } else {
                assert.equal(request.action, 'recordingComplete');
                assert.equal(request.success, 'true');
                assert.equal(screenshots, 1);
                child.emit('close', 0, null);
            }
        });
        child.stdout.write('{"event":"started"}\n');
        const event = JSON.stringify({ event: 'screenshot', image: png.toString('base64') }) + '\n';
        child.stdout.write(event.slice(0, 7000));
        child.stdout.write(event.slice(7000));
    }, () => assert.fail('Capturing must not stop the live preview.'));
    await openLivePreview({ id: 'chosen', name: 'Phone', platform: 'iOS', type: 'physical' }, {
        ...options, signal: controller.signal, onState: state => states.push(state),
        async onScreenshot(image) { assert.deepEqual(image, png); screenshots++; },
        async onRecordingReady(video) {
            assert.deepEqual(fs.readFileSync(video.path), mp4);
            assert.equal(fs.statSync(video.path).mode & 0o777, 0o600);
            savedVideo = video;
        },
        onCaptureError: message => assert.fail(message),
    });
    assert.ok(states.includes('recording'));
    assert.ok(states.includes('finalizingRecording'));
    assert.deepEqual(process.signals, []);
    assert.ok(fs.existsSync(savedVideo.path));
    await savedVideo.dispose();
    assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('video-')));
});

test('invalid preview captures fail without leaking images, leaving temporary clips, or stopping the preview', async context => {
    const { directory, controller, options } = fixture(context);
    const errors = [];
    execute = async (command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    recorder(context, child => {
        child.stdin.on('data', data => {
            const request = JSON.parse(data.toString());
            if (request.action === 'screenshotComplete') {
                assert.equal(request.success, 'false');
                child.stdout.write('{"event":"recordRequested"}\n');
            } else if (request.action === 'startRecording') {
                fs.writeFileSync(request.path, 'invalid');
                child.stdout.write('{"event":"recordingReady"}\n');
            } else {
                assert.equal(request.success, 'false');
                child.emit('close', 0, null);
            }
        });
        child.stdout.write('{"event":"started"}\n{"event":"screenshot","image":"private-invalid-data"}\n');
    }, () => assert.fail('An action failure must retain preview.'));
    await openLivePreview({ id: 'chosen', name: 'Phone', platform: 'iOS', type: 'physical' }, {
        ...options, signal: controller.signal, onState() {}, onCaptureError: message => errors.push(message),
        onScreenshot: async () => assert.fail('Invalid PNG must not be shown or copied.'),
        onRecordingReady: async () => assert.fail('Invalid video must not be shown or saved.'),
    });
    assert.equal(errors.length, 2);
    assert.ok(!errors.join().includes('private-invalid-data'));
    assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('video-')));
});

test('simulator preview opens the selected Xcode Simulator without booting, shutting down or recording', async context => {
    const { controller, options } = fixture(context);
    const commands = [];
    const states = [];
    execute = async (command, args) => {
        commands.push([command, args]);
        return { stdout: command === 'xcode-select' ? '/Applications/Custom Xcode.app/Contents/Developer\n' : '' };
    };
    await openLivePreview({ id: 'selected-simulator', name: 'Simulator', platform: 'iOS', type: 'simulator' }, {
        ...options, signal: controller.signal, onState: state => states.push(state),
    });
    assert.deepEqual(commands, [
        ['xcode-select', ['-p']],
        ['open', ['-a', '/Applications/Custom Xcode.app/Contents/Developer/Applications/Simulator.app', '--args', '-CurrentDeviceUDID', 'selected-simulator']],
    ]);
    assert.deepEqual(states, ['starting', 'simulatorOpened']);
});

test('live preview rejects unavailable scrcpy and pre-cancelled requests before starting a stream', async context => {
    const { controller, options } = fixture(context);
    context.mock.method(childProcess, 'spawn', () => assert.fail('A preview must not start without prerequisites.'));
    const device = { id: 'chosen', name: 'Android', platform: 'Android', type: 'physical' };
    for (const scenario of ['missing', 'old']) {
        execute = async () => {
            if (scenario === 'missing') { throw new Error('missing'); }
            return { stdout: 'scrcpy 2.7\n' };
        };
        await assert.rejects(openLivePreview(device, { ...options, signal: controller.signal, onState() {} }), { code: 'SCRCPY_UNAVAILABLE' });
    }
    controller.abort();
    execute = async () => assert.fail('Cancelled preview must not invoke tools.');
    await assert.rejects(openLivePreview(device, { ...options, signal: controller.signal, onState() {} }), { name: 'AbortError' });
});

test('scrcpy setup installs or upgrades only after consent and uses the verified Homebrew executable', async context => {
    const prerequisites = require('../out/prerequisites');
    const { controller, options } = fixture(context);
    for (const existing of [false, true]) {
        const states = [];
        let installed = false;
        let accepted = false;
        execute = async (command, args) => {
            if (command === 'scrcpy') { return { stdout: 'scrcpy 2.7\n' }; }
            if (command === '/opt/homebrew/opt/scrcpy/bin/scrcpy') {
                return { stdout: installed ? 'scrcpy 3.3.2\n' : 'scrcpy 2.7\n' };
            }
            assert.equal(command, 'brew');
            if (args[0] === '--version') { return { stdout: 'Homebrew 5.0\n' }; }
            if (args[0] === '--prefix') { return { stdout: '/opt/homebrew/opt/scrcpy\n' }; }
            assert.deepEqual(args, ['list', '--versions', 'scrcpy']);
            return { stdout: existing ? 'scrcpy 2.7\n' : '' };
        };
        context.mock.method(prerequisites, 'installPrerequisite', async (issue, storage, signal) => {
            assert.equal(accepted, true);
            assert.equal(storage, options.storage);
            assert.equal(signal, controller.signal);
            assert.equal(issue.install.executable, 'brew');
            assert.deepEqual(issue.install.args, [existing ? 'upgrade' : 'install', 'scrcpy']);
            assert.equal(issue.install.env.NONINTERACTIVE, '1');
            assert.equal(issue.install.env.HOMEBREW_NO_AUTO_UPDATE, '1');
            installed = true;
        });
        const executable = await prepareScrcpy({
            ...options, signal: controller.signal, onState: state => states.push(state),
            confirmScrcpyInstall: async action => {
                assert.equal(installed, false);
                assert.equal(action, existing ? 'upgrade' : 'install');
                accepted = true;
                return true;
            },
        });
        assert.equal(executable, '/opt/homebrew/opt/scrcpy/bin/scrcpy');
        assert.deepEqual(states, ['checkingScrcpy', 'waitingForScrcpyInstall', 'installingScrcpy', 'checkingScrcpy']);
        context.mock.restoreAll();
    }
});

test('scrcpy setup handles declined, cancelled, failed and unverifiable installations without launching preview', async context => {
    const prerequisites = require('../out/prerequisites');
    const { options } = fixture(context);
    const device = { id: 'phone', name: 'Android', platform: 'Android', type: 'physical' };
    for (const scenario of ['decline', 'cancelConsent', 'cancelInstall', 'failure', 'invalidVersion', 'noBrew']) {
        const controller = new AbortController();
        let confirmations = 0;
        let installations = 0;
        context.mock.method(childProcess, 'spawn', () => assert.fail('Unverified setup must not launch a preview.'));
        execute = async (command, args) => {
            if (command === 'scrcpy' || command.endsWith('/bin/scrcpy')) { throw new Error('not installed'); }
            if (scenario === 'noBrew') { throw new Error('Homebrew unavailable'); }
            if (args[0] === '--prefix') { return { stdout: '/opt/homebrew/opt/scrcpy\n' }; }
            return { stdout: args[0] === '--version' ? 'Homebrew 5.0\n' : '' };
        };
        context.mock.method(prerequisites, 'installPrerequisite', async () => {
            installations++;
            if (scenario === 'cancelInstall') { controller.abort(); controller.signal.throwIfAborted(); }
            if (scenario === 'failure') { throw new Error('private installer details'); }
        });
        const preview = openLivePreview(device, {
            ...options, signal: controller.signal, onState() {},
            confirmScrcpyInstall: async () => {
                confirmations++;
                if (scenario === 'cancelConsent') { controller.abort(); }
                return scenario !== 'decline';
            },
        });
        if (scenario === 'decline') { await preview; }
        else {
            await assert.rejects(preview, scenario.startsWith('cancel') ? { name: 'AbortError' }
                : { code: scenario === 'noBrew' ? 'HOMEBREW_UNAVAILABLE' : 'SCRCPY_INSTALL_FAILED' });
        }
        assert.equal(confirmations, scenario === 'noBrew' ? 0 : 1);
        assert.equal(installations, ['cancelInstall', 'failure', 'invalidVersion'].includes(scenario) ? 1 : 0);
        context.mock.restoreAll();
    }
});

test('scrcpy setup reuses a suitable Homebrew copy outside PATH without asking to install', async context => {
    const { controller, options } = fixture(context);
    const states = [];
    execute = async (command, args) => {
        if (command === 'scrcpy' || command === 'brew') { throw new Error('not on PATH'); }
        if (command === '/opt/homebrew/opt/scrcpy/bin/scrcpy') { return { stdout: 'scrcpy 3.3.2\n' }; }
        assert.equal(command, '/opt/homebrew/bin/brew');
        assert.ok(args[0] === '--version' || args[0] === '--prefix');
        return { stdout: args[0] === '--prefix' ? '/opt/homebrew/opt/scrcpy\n' : 'Homebrew 5.0\n' };
    };
    const executable = await prepareScrcpy({
        ...options, signal: controller.signal, onState: state => states.push(state),
        confirmScrcpyInstall: async () => assert.fail('Existing supported scrcpy must not request installation.'),
    });
    assert.equal(executable, '/opt/homebrew/opt/scrcpy/bin/scrcpy');
    assert.deepEqual(states, ['checkingScrcpy']);
});

test('live preview cancellation and USB timeout stop only the owned helper even before its first frame', async context => {
    const { options } = fixture(context);
    execute = async (command, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'test helper', { mode: 0o700 });
        return { stdout: '' };
    };
    for (const scenario of ['cancel', 'timeout', 'permission']) {
        const controller = new AbortController();
        const timeouts = new Map();
        const states = [];
        const originalTimeout = global.setTimeout;
        context.mock.method(global, 'setTimeout', (callback, duration, ...args) => {
            timeouts.set(duration, callback);
            return originalTimeout(callback, duration, ...args);
        });
        const signals = [];
        recorder(context, child => {
            child.stdout.write('null\nnot-json\n{"event":"waitingForUsb"}\n');
            assert.equal(states.at(-1), 'waitingForUsb');
            if (scenario === 'cancel') { controller.abort(); }
            else if (scenario === 'timeout') { timeouts.get(120_000)(); }
            else { child.stdout.write('{"event":"error","code":"PERMISSION_DENIED"}\n'); }
            if (scenario === 'permission') { return; }
            child.stdout.write('{"event":"started"}\n');
            assert.equal(states.at(-1), 'stopping');
            timeouts.get(5000)();
        }, (child, signal) => {
            signals.push(signal);
            if (signal === 'SIGKILL' || scenario === 'permission') { child.emit('close', null, signal); }
        });
        const preview = openLivePreview({ id: 'chosen', name: 'Phone', platform: 'iOS', type: 'physical' }, {
            ...options, signal: controller.signal, onState: state => states.push(state),
        });
        if (scenario === 'cancel') { await preview; }
        else { await assert.rejects(preview, { code: scenario === 'timeout' ? 'USB_DEVICE_UNAVAILABLE' : 'PERMISSION_DENIED' }); }
        assert.ok(!states.includes('live'));
        assert.deepEqual(signals, scenario === 'permission' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
        context.mock.restoreAll();
    }
});

test('native preview renders frames, freezes and resumes, fits narrow and landscape windows, and clears disconnected images', { skip: process.platform !== 'darwin' }, async context => {
    const { directory, options } = fixture(context);
    const actualExecute = promisify(actualExecFile);
    const native = fs.readFileSync(path.join(options.extensionPath, 'native', 'ScreenRecorder.swift'), 'utf8');
    const definitions = native.slice(0, native.indexOf('let arguments = CommandLine.arguments'));
    const harness = path.join(directory, 'PreviewCheck.swift');
    const screenshot = path.join(directory, 'preview.png');
    fs.writeFileSync(harness, definitions + `
import ScreenCaptureKit
func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { FileHandle.standardError.write(Data(message.utf8)); exit(1) }
}
NSApplication.shared.setActivationPolicy(.accessory)
let preview = DevicePreview(name: "Synthetic Preview", alwaysOnTop: true)
require(preview.window.level == .floating, "Keep-on-top not applied")
require(preview.window.collectionBehavior.contains(.fullScreenNone), "Fullscreen must be disabled")
require(preview.window.standardWindowButton(.zoomButton)?.isHidden == true, "Fullscreen button is still visible")
require(preview.controls.rootView.model === preview.captureControls, "Native controls are not connected to capture state")
require(!preview.captureControls.screenshotEnabled && !preview.captureControls.recordEnabled, "Capture controls enabled before a frame")
let context = CIContext()
func frame(_ image: CIImage, width: Int, height: Int) -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
    require(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes, &buffer) == kCVReturnSuccess, "Synthetic frame unavailable")
    context.render(image, to: buffer!)
    return buffer!
}
func displays(_ frame: CVPixelBuffer) -> Bool {
    preview.displayedFrame === frame && (preview.screenLayer.contents as AnyObject?) === CVPixelBufferGetIOSurface(frame)?.takeUnretainedValue()
}
let portrait = frame(CIImage(color: CIColor(red: 0.1, green: 0.7, blue: 0.6)), width: 320, height: 568)
let landscape = frame(CIImage(color: CIColor(red: 0.9, green: 0.3, blue: 0.2)), width: 568, height: 320)
preview.presentFrame(portrait)
preview.window.contentView!.layoutSubtreeIfNeeded()
require(abs(preview.screenView.frame.width / preview.screenView.frame.height - 320.0 / 568.0) < 0.003, "Initial phone fit leaves side bars")
require(displays(portrait), "Portrait frame is not shown from its IOSurface")
preview.captureControls.pause()
require(preview.captureControls.paused, "Pause control is not connected")
preview.presentFrame(landscape)
require(displays(portrait), "Pause did not hold the displayed frame")
preview.captureControls.screenshot()
preview.captureControls.screenshot()
require(!preview.captureControls.screenshotEnabled, "Screenshot button stayed enabled while copying")
preview.completeCapture(success: true)
require(preview.captureControls.screenshotEnabled, "Screenshot control did not recover")
preview.captureControls.record()
require(!preview.captureControls.recordEnabled, "Record control must wait for recording startup")
preview.completeRecording(success: false)
require(preview.captureControls.recordEnabled, "Record control did not recover from failure")
preview.captureControls.pause()
require(!preview.captureControls.paused, "Resume control is not connected")
preview.presentFrame(landscape)
require(displays(landscape), "Resume or rotation failed")
preview.window.contentView!.layoutSubtreeIfNeeded()
require(abs(preview.screenView.frame.width / preview.screenView.frame.height - 568.0 / 320.0) < 0.003, "Landscape fit: \\(preview.screenView.frame), content: \\(preview.window.contentView!.bounds)")
for size in [NSSize(width: 280, height: 400), NSSize(width: 1100, height: 650)] {
    preview.window.setContentSize(size)
    let content = preview.window.contentView!
    content.layoutSubtreeIfNeeded()
    require(content.bounds.contains(preview.screenView.frame), "Preview outside window: \\(preview.screenView.frame), content: \\(content.bounds)")
    require(preview.screenView.frame.height > 100, "Preview has no usable height")
    let controls = preview.controls
    let controlsInContent = controls.convert(controls.bounds, to: content)
    require(content.bounds.contains(controlsInContent), "Controls outside window")
    require(!preview.screenView.frame.intersects(controlsInContent), "Controls overlap preview")
}
preview.presentFrame(portrait)
let content = preview.window.contentView!
content.layoutSubtreeIfNeeded()
let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
content.cacheDisplay(in: content.bounds, to: bitmap)
let center = bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)!.usingColorSpace(.deviceRGB)!
require(center.greenComponent > 0.4 && center.blueComponent > 0.3, "Native preview pixels are blank")
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
let sample = NSImage(size: NSSize(width: 390, height: 844), flipped: true) { bounds in
    NSColor(calibratedWhite: 0.96, alpha: 1).setFill()
    bounds.fill()
    func text(_ value: String, _ rect: NSRect, _ font: NSFont, _ color: NSColor) {
        (value as NSString).draw(in: rect, withAttributes: [.font: font, .foregroundColor: color])
    }
    text("9:41", NSRect(x: 25, y: 18, width: 60, height: 25), .systemFont(ofSize: 15, weight: .semibold), .black)
    for (symbol, position) in [("wifi", 315), ("battery.100", 342)] {
        NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.draw(in: NSRect(x: position, y: 21, width: 20, height: 15))
    }
    text("Today", NSRect(x: 24, y: 74, width: 280, height: 48), .systemFont(ofSize: 34, weight: .bold), .black)
    text("Monday, September 21", NSRect(x: 25, y: 124, width: 340, height: 26), .systemFont(ofSize: 15), .darkGray)
    NSColor(calibratedRed: 0.04, green: 0.46, blue: 0.42, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 24, y: 177, width: 342, height: 144), xRadius: 20, yRadius: 20).fill()
    text("Weekly activity", NSRect(x: 44, y: 198, width: 280, height: 28), .systemFont(ofSize: 17, weight: .medium), .white)
    text("4 of 5 days", NSRect(x: 44, y: 237, width: 280, height: 44), .systemFont(ofSize: 32, weight: .bold), .white)
    text("Coming up", NSRect(x: 24, y: 359, width: 280, height: 32), .systemFont(ofSize: 22, weight: .bold), .black)
    for (index, entry) in ["Design review", "Walk outside", "Read a chapter"].enumerated() {
        let offset = CGFloat(index) * 84
        NSColor.white.setFill()
        NSBezierPath(roundedRect: NSRect(x: 24, y: 409 + offset, width: 342, height: 72), xRadius: 16, yRadius: 16).fill()
        NSColor(calibratedRed: 0.08, green: 0.5, blue: 0.46, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 42, y: 431 + offset, width: 28, height: 28)).fill()
        text(entry, NSRect(x: 84, y: 434 + offset, width: 250, height: 24), .systemFont(ofSize: 17, weight: .medium), .black)
    }
    NSColor.white.setFill()
    NSRect(x: 0, y: 759, width: 390, height: 85).fill()
    for (symbol, position) in [("house.fill", 70), ("calendar", 186), ("person.crop.circle", 302)] {
        NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.draw(in: NSRect(x: position, y: 781, width: 22, height: 22))
    }
    NSColor.black.setFill()
    NSBezierPath(roundedRect: NSRect(x: 130, y: 828, width: 130, height: 5), xRadius: 2.5, yRadius: 2.5).fill()
    return true
}
let sampleImage = sample.cgImage(forProposedRect: nil, context: nil, hints: nil)!
let sampleFrame = frame(CIImage(cgImage: sampleImage), width: sampleImage.width, height: sampleImage.height)
preview.presentFrame(sampleFrame)
for (appearance, suffix) in [(NSAppearance.Name.aqua, "light"), (NSAppearance.Name.darkAqua, "dark")] {
    preview.window.appearance = NSAppearance(named: appearance)
    content.layoutSubtreeIfNeeded()
    preview.window.displayIfNeeded()
    let snapshot = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
    content.cacheDisplay(in: content.bounds, to: snapshot)
    try snapshot.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1] + "." + suffix + ".png"))
}
func completeValidation() {
    preview.disconnect()
    preview.presentFrame(portrait)
    require(preview.displayedFrame == nil && preview.screenLayer.contents == nil, "Disconnected preview leaked a queued frame")
    print("Native preview rendering, pause, rotation, sizing and disconnect checks passed.")
    exit(0)
}
if #available(macOS 14.0, *), ProcessInfo.processInfo.environment["MAUIDEPLOY_PREVIEW_COMPOSITE"] == "1" {
    let background = NSWindow(contentRect: preview.window.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    background.isReleasedWhenClosed = false
    background.level = .floating
    let backdrop = NSImageView(frame: NSRect(origin: .zero, size: preview.window.frame.size))
    backdrop.imageScaling = .scaleAxesIndependently
    backdrop.image = NSImage(size: NSSize(width: 600, height: 900), flipped: true) { bounds in
        NSColor(calibratedRed: 0.66, green: 0.83, blue: 0.82, alpha: 1).setFill()
        bounds.fill()
        NSColor(calibratedRed: 0.94, green: 0.72, blue: 0.62, alpha: 1).setFill()
        NSRect(x: 320, y: 0, width: 280, height: 900).fill()
        return true
    }
    background.contentView = backdrop
    background.order(.below, relativeTo: preview.window.windowNumber)
    preview.window.orderFrontRegardless()
    Task { @MainActor in
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let ownWindow = content.windows.first(where: { $0.windowID == CGWindowID(preview.window.windowNumber) }) else {
                require(false, "Synthetic preview window not available for capture: visible=\\(preview.window.isVisible), id=\\(preview.window.windowNumber)")
                return
            }
            let filter = SCContentFilter(desktopIndependentWindow: ownWindow)
            let configuration = SCStreamConfiguration()
            configuration.width = Int(preview.window.frame.width * preview.window.backingScaleFactor)
            configuration.height = Int(preview.window.frame.height * preview.window.backingScaleFactor)
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            for (appearance, suffix) in [(NSAppearance.Name.darkAqua, "dark"), (NSAppearance.Name.aqua, "light")] {
                preview.window.appearance = NSAppearance(named: appearance)
                preview.window.displayIfNeeded()
                var snapshot: NSBitmapImageRep?
                var lastFrame: NSBitmapImageRep?
                let deadline = Date().addingTimeInterval(3)
                repeat {
                    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                    let bitmap = NSBitmapImageRep(cgImage: image)
                    lastFrame = bitmap
                    let region = preview.controls.convert(NSRect(x: 23, y: 18, width: 28, height: 28), to: preview.window.contentView!)
                    let scale = CGFloat(bitmap.pixelsWide) / preview.window.frame.width
                    let startY = Int((preview.window.contentView!.bounds.height - region.maxY) * scale)
                    var visibleSymbol = false
                    for row in startY..<Int(CGFloat(startY) + region.height * scale) {
                        for column in Int(region.minX * scale)..<Int(region.maxX * scale) {
                            guard let color = bitmap.colorAt(x: column, y: row)?.usingColorSpace(.deviceRGB) else { continue }
                            let luminance = (color.redComponent + color.greenComponent + color.blueComponent) / 3
                            if suffix == "dark" ? luminance > 0.8 : luminance < 0.25 { visibleSymbol = true }
                        }
                    }
                    if visibleSymbol { snapshot = bitmap; break }
                } while Date() < deadline
                if snapshot == nil, let target = ProcessInfo.processInfo.environment["MAUIDEPLOY_PREVIEW_SNAPSHOT"], let lastFrame {
                    try lastFrame.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: target + ".failed-" + suffix + ".png"))
                }
                require(snapshot != nil, "Glass control contrast did not settle in \\(suffix) appearance")
                try snapshot!.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1] + ".composite-" + suffix + ".png"))
            }
            background.close()
            completeValidation()
        } catch {
            background.close()
            require(false, "Synthetic window compositing failed: \\(error.localizedDescription)")
        }
    }
    NSApplication.shared.run()
} else { completeValidation() }
`);
    const { stdout } = await actualExecute('xcrun', ['swift', '-swift-version', '5', harness, screenshot], { timeout: 60_000, maxBuffer: 512 * 1024 })
        .catch(error => { throw new Error(String(error.stderr || error.message)); });
    assert.match(stdout, /Native preview rendering, pause, rotation, sizing and disconnect checks passed/);
    const captures = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(event => event.event === 'screenshot');
    assert.equal(captures.length, 1);
    assert.equal(stdout.split('\n').filter(line => line.includes('"recordRequested"')).length, 1);
    const capturedPng = Buffer.from(captures[0].image, 'base64');
    assert.equal(capturedPng.subarray(1, 4).toString(), 'PNG');
    assert.equal(capturedPng.readUInt32BE(16), 320);
    assert.equal(capturedPng.readUInt32BE(20), 568);
    assert.ok(fs.statSync(screenshot).size > 1000);
    if (process.env.MAUIDEPLOY_PREVIEW_SNAPSHOT) {
        fs.copyFileSync(screenshot, process.env.MAUIDEPLOY_PREVIEW_SNAPSHOT);
        for (const appearance of ['light', 'dark']) {
            fs.copyFileSync(`${screenshot}.${appearance}.png`, `${process.env.MAUIDEPLOY_PREVIEW_SNAPSHOT}.${appearance}.png`);
            if (process.env.MAUIDEPLOY_PREVIEW_COMPOSITE === '1') {
                fs.copyFileSync(`${screenshot}.composite-${appearance}.png`, `${process.env.MAUIDEPLOY_PREVIEW_SNAPSHOT}.composite-${appearance}.png`);
            }
        }
    }
});