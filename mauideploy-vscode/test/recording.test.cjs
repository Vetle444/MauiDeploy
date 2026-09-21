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
const { captureVideo, prepareVideoHelper, videoDurationLimitMs } = require('../out/recordings');
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

function recorder(context, onStart, onStop) {
    context.mock.method(childProcess, 'spawn', (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.signals = [];
        child.kill = signal => { child.signals.push(signal); onStop(child, signal); return true; };
        queueMicrotask(() => onStart(child, command, args, options));
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
            assert.deepEqual(args.slice(0, 2), ['record', '00008030-1234567890ABCDEF']);
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
        });
        const promise = captureVideo({ id: '00008030-1234567890ABCDEF', platform: 'iOS', type: 'physical' }, {
            ...options, signal: controller.signal, stop: stop.signal,
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
    assert.ok(source.includes('normalizedID($0.uniqueID) == targetID'));
    assert.ok(source.includes('output.connection(with: .audio)?.isEnabled = false'));
    const plist = fs.readFileSync(path.join(options.extensionPath, 'native', 'ScreenRecorder-Info.plist'), 'utf8');
    assert.ok(plist.includes('NSCameraUsageDescription'));
    await new Promise((resolve, reject) => {
        const child = childProcess.spawn(helper, ['record', 'mauideploy-test-not-a-device', path.join(directory, 'cancelled.mp4')], {
            signal: AbortSignal.timeout(15_000), stdio: ['ignore', 'pipe', 'pipe'],
        });
        let pending = '';
        let ready = false;
        child.stdout.on('data', chunk => {
            pending += chunk.toString();
            if (!ready && pending.includes('"waitingForUsb"')) { ready = true; child.kill('SIGINT'); }
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
});