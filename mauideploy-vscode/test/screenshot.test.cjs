const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

const actualExecFile = childProcess.execFile;
let invocation;
let result;
const fakeExecFile = () => {};
fakeExecFile[promisify.custom] = async (command, args, options) => {
    invocation = { command, args, options };
    if (typeof result === 'function') { return result(command, args, options); }
    if (result instanceof Error) { throw result; }
    return { stdout: result };
};
childProcess.execFile = fakeExecFile;
const { captureScreenshot } = require('../out/screenshots');
const devicesModule = require('../out/devices');
childProcess.execFile = actualExecFile;

test('screenshots target the selected device and preserve binary PNG without an image file', async () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(24, 255)]);
    const signal = new AbortController().signal;
    result = png;
    for (const [platform, type, command, args] of [
        ['Android', 'physical', 'adb', ['-s', 'chosen', 'exec-out', 'screencap', '-p']],
        ['iOS', 'simulator', 'xcrun', ['simctl', 'io', 'chosen', 'screenshot', '--type=png', '-']],
        ['iOS', 'physical', '/managed/python', ['-m', 'pymobiledevice3', 'developer', 'dvt', 'screenshot', '/dev/stdout', '--native', '--udid', 'chosen']],
    ]) {
        assert.equal(await captureScreenshot({ id: 'chosen', platform, type }, signal, '/managed/python', '/managed'), png);
        assert.equal(invocation.command, command);
        assert.deepEqual(invocation.args, args);
        assert.equal(invocation.options.encoding, 'buffer');
        assert.equal(invocation.options.signal, signal);
        assert.equal(invocation.options.cwd, '/managed');
    }
});

test('failed or invalid captures never become screenshots', async () => {
    const device = { id: 'chosen', platform: 'iOS', type: 'physical' };
    const signal = new AbortController().signal;
    await assert.rejects(captureScreenshot(device, signal), /not installed/);
    for (const invalid of [Buffer.alloc(0), Buffer.from('device error'), Buffer.alloc(32)]) {
        result = invalid;
        await assert.rejects(captureScreenshot(device, signal, '/managed/python'), /PNG/);
    }
    result = new Error('device disconnected');
    await assert.rejects(captureScreenshot(device, signal, '/managed/python'), /disconnected/);
});

test('screenshot discovery excludes unreachable phones and stopped simulators, but retains Wi-Fi devices', async () => {
    result = async (command, args) => {
        if (args.includes('devicectl')) {
            assert.ok(args.includes('/dev/stdout'));
            return { stdout: JSON.stringify({ result: { devices: [
                { deviceProperties: { name: 'wifi' }, hardwareProperties: { udid: 'wifi-id' }, connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected', transportType: 'localNetwork' } },
                { deviceProperties: { name: 'offline' }, hardwareProperties: { udid: 'offline-id' }, connectionProperties: { pairingState: 'paired', tunnelState: 'unavailable' } },
                { deviceProperties: { name: 'unpaired' }, hardwareProperties: { udid: 'unpaired-id' }, connectionProperties: { pairingState: 'unpaired' } },
            ] } }) };
        }
        if (args.includes('simctl')) {
            return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
                { name: 'running', udid: 'running-id', isAvailable: true, state: 'Booted' },
                { name: 'stopped', udid: 'stopped-id', isAvailable: true, state: 'Shutdown' },
            ] } }) };
        }
        assert.equal(command, 'adb');
        return { stdout: 'List of devices attached\nandroid-id device model:Pixel\nunauthorized-id unauthorized\n' };
    };
    const devices = await devicesModule.detectScreenshotDevices();
    assert.deepEqual(devices.map(device => device.id), ['wifi-id', 'running-id', 'android-id']);
    assert.equal(devices[0].transport, 'Wi-Fi');
});

const vscodeMock = {
    commands: {}, window: {}, workspace: { isTrusted: true, fs: {} },
    ProgressLocation: { Window: 10, Notification: 15 }, ViewColumn: { Active: -1 }, QuickPickItemKind: { Separator: -1 },
    Uri: { file: fsPath => ({ fsPath }) },
    CancellationTokenSource: class {
        constructor() {
            this.listeners = new Set();
            this.token = {
                isCancellationRequested: false,
                onCancellationRequested: callback => {
                    this.listeners.add(callback);
                    return { dispose: () => this.listeners.delete(callback) };
                },
            };
        }
        cancel() {
            if (this.token.isCancellationRequested) { return; }
            this.token.isCancellationRequested = true;
            for (const callback of this.listeners) { callback(); }
        }
        dispose() { this.listeners.clear(); }
    },
};
const actualLoad = Module._load;
Module._load = function (request, ...args) {
    if (request === 'vscode') { return vscodeMock; }
    return actualLoad.call(this, request, ...args);
};
const { formatRecordingTime, registerScreenshotCommand, videoHtml } = require('../out/screenshotCommand');
Module._load = actualLoad;

test('video preview exposes native playback controls and an editor Save action without scripts or unsafe URLs', () => {
    const html = videoHtml('https://preview/recording.mp4?name="<video>&', 'https://preview');
    assert.ok(html.includes('controls autoplay muted playsinline'));
    assert.ok(html.includes("default-src 'none'; media-src https://preview;"));
    assert.ok(html.includes('name=&quot;&lt;video&gt;&amp;'));
    assert.ok(!html.includes('<script'));
    const manifest = require('../package.json');
    for (const command of ['mauideploy.recordVideo', 'mauideploy.stopRecording', 'mauideploy.cancelRecording', 'mauideploy.saveRecording']) {
        assert.ok(manifest.contributes.commands.some(item => item.command === command));
    }
    assert.ok(!manifest.contributes.commands.some(item => /gif/i.test(item.command)));
    assert.ok(manifest.contributes.menus['editor/title'].some(item =>
        item.command === 'mauideploy.saveRecording' && item.when === 'activeWebviewPanelId == mauideploy.recording'));
});

test('recording toolbar shows waiting states, changes Cancel to Stop only after startup, and displays elapsed time', () => {
    const filename = path.resolve(__dirname, '../out/extension.js');
    const localRequire = Module.createRequire(filename);
    const items = new Map();
    let report;
    let screenshotBusy;
    const sandbox = {
        exports: {}, process,
        require(name) {
            if (name === 'vscode') {
                return {
                    StatusBarAlignment: { Left: 1 },
                    ThemeColor: class { constructor(id) { this.id = id; } },
                    MarkdownString: class { constructor(value) { this.value = value; } },
                    commands: { executeCommand() {} },
                    window: {
                        createStatusBarItem(id) {
                            const item = { show() {}, dispose() {} };
                            if (typeof id === 'string') { items.set(id, item); }
                            return item;
                        },
                        registerUriHandler() { return { dispose() {} }; },
                    },
                };
            }
            if (name === './screenshotCommand') {
                return {
                    formatRecordingTime,
                    registerScreenshotCommand(context, selected, setBusy, update) { screenshotBusy = setBusy; report = update; },
                };
            }
            if (name === './branchDeploy') { return { registerBranchSetup() {} }; }
            if (name.startsWith('./')) { return {}; }
            return localRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
        augmentProcessPath = () => {};
        loadState = () => {};
        registerCommands = () => {};
        registerDebugHotReload = () => {};
        registerDebugAdapterFactory = () => {};
        autoDetectProject = () => {};
        startDevicePolling = () => {};
    `, sandbox, { filename });
    sandbox.exports.activate({ subscriptions: [] });
    const video = items.get('mauideploy.recordVideo');
    assert.equal(video.text, '$(record)');
    for (const [state, label] of [
        ['findingDevices', 'Finding devices'], ['buildingHelper', 'Building recorder'],
        ['waitingForUsb', 'Waiting for USB'], ['waitingForPermission', 'Camera permission'],
        ['starting', 'Starting video'], ['finalizing', 'Finalizing video'], ['downloading', 'Downloading video'],
    ]) {
        report(state, `Progress: ${label}`);
        assert.equal(video.text, `$(loading~spin) ${label}`);
        assert.equal(video.command, 'mauideploy.cancelRecording');
        assert.ok(video.tooltip.includes(label));
        assert.equal(video.accessibilityInformation.label, `Progress: ${label}`);
    }
    report('recording', 'Recording Phone: 01:05 / 03:00', 65_000);
    assert.equal(video.text, '$(debug-stop) 01:05');
    assert.equal(video.command, 'mauideploy.stopRecording');
    assert.equal(video.color.id, 'errorForeground');
    assert.match(video.tooltip, /Stop recording and save/);
    for (const state of ['saving', 'cancelling']) {
        report(state, state);
        assert.equal(video.command, undefined);
    }
    report('idle');
    assert.equal(video.text, '$(record)');
    assert.equal(video.command, 'mauideploy.recordVideo');
    assert.equal(video.color, undefined);
    screenshotBusy(true);
    assert.equal(video.command, undefined);
    screenshotBusy(false);
    assert.equal(video.command, 'mauideploy.recordVideo');
});

test('command opens the chosen screenshot independently of the deployment target and retains preview on clipboard failure', { skip: process.platform !== 'darwin' }, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-screenshot-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const screenshots = require('../out/screenshots');
    const originalCapture = screenshots.captureScreenshot;
    const originalCopy = screenshots.copyScreenshot;
    const originalDiscovery = devicesModule.detectScreenshotDevices;
    context.after(() => {
        screenshots.captureScreenshot = originalCapture;
        screenshots.copyScreenshot = originalCopy;
        devicesModule.detectScreenshotDevices = originalDiscovery;
    });
    const deploymentDevice = { id: 'deploy', name: 'Deploy', platform: 'Android', type: 'physical' };
    const screenshotDevice = { id: 'screenshot', name: 'Screenshot', platform: 'Android', type: 'physical' };
    devicesModule.detectScreenshotDevices = async () => [screenshotDevice, deploymentDevice];
    const commands = new Map();
    let captures = 0;
    let cancelChoice = false;
    let html;
    let warned = false;
    const busy = [];
    const log = [];
    vscodeMock.window.createOutputChannel = () => ({ appendLine: message => log.push(message), show() {}, dispose() {} });
    vscodeMock.commands.registerCommand = (name, callback) => { commands.set(name, callback); return { dispose() {} }; };
    vscodeMock.window.withProgress = async (options, callback) => callback({ report() {} }, { onCancellationRequested() { return { dispose() {} }; } });
    vscodeMock.window.showQuickPick = async items => {
        assert.equal(items.find(item => item.device).device.id, 'deploy');
        if (cancelChoice) { return undefined; }
        return items.find(item => item.device?.id === 'screenshot');
    };
    vscodeMock.window.createWebviewPanel = (type, title, column, options) => {
        assert.equal(options.enableScripts, false);
        assert.deepEqual(options.localResourceRoots, []);
        return { webview: { set html(value) { html = value; } }, reveal() {}, dispose() {}, onDidDispose() {} };
    };
    vscodeMock.window.showWarningMessage = async () => { warned = true; };
    vscodeMock.window.showErrorMessage = async message => assert.fail(message);
    screenshots.captureScreenshot = async device => {
        assert.equal(device.id, 'screenshot');
        captures++;
        return Buffer.from('image-data');
    };
    screenshots.copyScreenshot = async () => { throw new Error('clipboard unavailable'); };
    const extensionContext = { subscriptions: [], globalStorageUri: { fsPath: directory } };
    registerScreenshotCommand(extensionContext, () => deploymentDevice.id, value => busy.push(value));
    const command = commands.get('mauideploy.screenshot');
    await command();
    assert.equal(captures, 1);
    assert.equal(warned, true);
    assert.ok(log.includes('Preview opened.'));
    assert.ok(!log.join('\n').includes('image-data'));
    assert.ok(html.includes('data:image/png;base64,'));
    assert.ok(html.includes("default-src 'none'"));
    assert.equal(deploymentDevice.id, 'deploy');
    assert.deepEqual(busy, [true, false]);
    cancelChoice = true;
    await command();
    assert.equal(captures, 1);
    assert.deepEqual(busy, [true, false, true, false]);
    cancelChoice = false;
    screenshots.captureScreenshot = async () => { throw Object.assign(new Error('sensitive stderr'), { killed: true, signal: 'SIGTERM' }); };
    let errorMessage;
    vscodeMock.window.showErrorMessage = async message => { errorMessage = message; };
    await command();
    assert.match(errorMessage, /timed out/);
    assert.ok(log.some(line => line.includes('Failed to capture the screenshot:')));
    assert.ok(!log.join('\n').includes('sensitive stderr'));
    for (const subscription of extensionContext.subscriptions) { subscription.dispose(); }
});

test('video command records a USB iPhone without Python, saves MP4 and retains previews for save retries', { skip: process.platform !== 'darwin' }, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-video-command-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const screenshots = require('../out/screenshots');
    const recordings = require('../out/recordings');
    const originalCapture = recordings.captureVideo;
    const originalScreenshot = screenshots.captureScreenshot;
    const originalCopy = screenshots.copyScreenshot;
    const originalDiscovery = devicesModule.detectScreenshotDevices;
    context.after(() => {
        recordings.captureVideo = originalCapture;
        screenshots.captureScreenshot = originalScreenshot;
        screenshots.copyScreenshot = originalCopy;
        devicesModule.detectScreenshotDevices = originalDiscovery;
        vscodeMock.workspace.isTrusted = true;
    });
    const deploymentDevice = { id: 'deploy', name: 'Deploy', platform: 'Android', type: 'physical' };
    const recordingDevice = { id: 'record', name: 'Record', platform: 'iOS', type: 'physical', transport: 'USB' };
    devicesModule.detectScreenshotDevices = async () => {
        assert.ok(progressMessages.includes('Finding available devices...'));
        return [recordingDevice, deploymentDevice];
    };
    const commands = new Map();
    const states = [];
    const feedback = [];
    const progressMessages = [];
    const log = [];
    const videoPath = path.join(directory, 'recordings', 'video-private', 'recording.mp4');
    const saveDestination = { scheme: 'file', fsPath: path.join(directory, 'saved video.mp4') };
    const revealed = [];
    let copyCompleted = false;
    let revealFailure = false;
    const panels = [];
    let disposed = 0;
    let html;
    let saves = 0;
    let declineSave = false;
    vscodeMock.commands.registerCommand = (name, callback) => { commands.set(name, callback); return { dispose() {} }; };
    vscodeMock.commands.executeCommand = async (name, destination) => {
        assert.equal(name, 'revealFileInOS');
        assert.equal(destination, saveDestination);
        assert.equal(copyCompleted, true);
        revealed.push(destination);
        if (revealFailure) { throw new Error('private Finder details'); }
    };
    vscodeMock.window.createOutputChannel = () => ({ appendLine: message => log.push(message), show() {}, dispose() {} });
    vscodeMock.window.withProgress = async (options, callback) => {
        assert.equal(options.location, vscodeMock.ProgressLocation.Notification);
        assert.match(options.title, /^MAUI Deploy: (Record Video|Save Recording)$/);
        return callback({ report({ message }) { progressMessages.push(message); } }, { onCancellationRequested() { return { dispose() {} }; } });
    };
    vscodeMock.window.showQuickPick = async (items, options) => {
        assert.equal(options.title, 'Record Video');
        assert.equal(items.find(item => item.device).device.id, 'deploy');
        assert.match(items.find(item => item.device?.id === 'record').description, /USB required/);
        return items.find(item => item.device?.id === 'record');
    };
    vscodeMock.window.createWebviewPanel = (type, title, column, options) => {
        assert.equal(type, 'mauideploy.recording');
        assert.equal(options.enableScripts, false);
        assert.deepEqual(options.localResourceRoots, [{ fsPath: path.dirname(videoPath) }]);
        for (const panel of panels) { panel.active = false; }
        let onDispose;
        const panel = {
            active: true,
            webview: {
                cspSource: 'https://test.webview',
                asWebviewUri: uri => { assert.equal(uri.fsPath, videoPath); return { toString: () => 'https://test.webview/recording.mp4' }; },
                set html(value) { html = value; },
            },
            reveal() {}, dispose() { onDispose?.(); }, onDidDispose(callback) { onDispose = callback; },
        };
        panels.push(panel);
        return panel;
    };
    vscodeMock.window.showSaveDialog = async options => {
        assert.deepEqual(options.filters, { 'MP4 Video': ['mp4'] });
        assert.ok(options.defaultUri.fsPath.endsWith('.mp4'));
        copyCompleted = false;
        return declineSave ? undefined : saveDestination;
    };
    vscodeMock.workspace.fs.copy = async (source, destination, options) => {
        assert.equal(source.fsPath, videoPath);
        assert.equal(destination, saveDestination);
        assert.deepEqual(options, { overwrite: true });
        saves++;
        copyCompleted = true;
    };
    vscodeMock.window.setStatusBarMessage = () => {};
    vscodeMock.window.showErrorMessage = async message => assert.fail(message);
    screenshots.captureScreenshot = async () => assert.fail('Screenshots must not run during video recording.');
    screenshots.copyScreenshot = async () => assert.fail('Video must not replace the clipboard with a still image.');
    recordings.captureVideo = async (device, options) => {
        assert.equal(device.id, 'record');
        assert.equal(options.storage, path.join(directory, 'recordings'));
        assert.equal(options.extensionPath, directory);
        assert.equal(options.python, undefined);
        options.onStage('checkingHelper');
        options.onStage('buildingHelper');
        options.onStage('waitingForUsb');
        assert.ok(!states.includes('recording') || declineSave);
        options.onStage('waitingForPermission');
        options.onStage('starting');
        options.onStarted();
        options.onProgress(65_000);
        await commands.get('mauideploy.screenshot')();
        await commands.get(declineSave ? 'mauideploy.stopRecording' : 'mauideploy.recordVideo')();
        assert.equal(options.stop.aborted, true);
        assert.equal(options.signal.aborted, false);
        options.onFinalizing();
        return { path: videoPath, async dispose() { disposed++; } };
    };
    const extensionContext = { subscriptions: [], globalStorageUri: { fsPath: directory }, extensionPath: directory };
    registerScreenshotCommand(extensionContext, () => deploymentDevice.id, () => assert.fail('Screenshot state must be unchanged.'), (state, message, elapsedMs) => {
        if (states.at(-1) !== state) { states.push(state); }
        feedback.push({ state, message, elapsedMs });
    });
    await commands.get('mauideploy.recordVideo')();
    assert.equal(saves, 1);
    assert.equal(revealed.length, 1);
    assert.deepEqual(states, ['findingDevices', 'choosingDevice', 'preparing', 'checkingHelper', 'buildingHelper',
        'waitingForUsb', 'waitingForPermission', 'starting', 'recording', 'finalizing', 'previewing', 'saving', 'idle']);
    assert.ok(progressMessages.some(message => message.includes('Waiting for USB iPhone')));
    assert.ok(progressMessages.some(message => message.includes('Waiting for camera permission')));
    assert.ok(progressMessages.includes('Recording Record: 01:05 / 03:00'));
    assert.ok(progressMessages.includes('Saving MP4...'));
    assert.ok(progressMessages.includes('Opening Finder...'));
    assert.ok(feedback.some(item => item.state === 'recording' && item.elapsedMs === 65_000));
    assert.equal(formatRecordingTime(65_000), '01:05');
    assert.ok(html.includes('src="https://test.webview/recording.mp4"'));
    assert.ok(html.includes('controls autoplay muted playsinline'));
    assert.ok(html.includes('media-src https://test.webview'));
    assert.ok(html.includes("default-src 'none'"));
    assert.equal(deploymentDevice.id, 'deploy');
    assert.ok(!log.join('\n').includes(videoPath));
    declineSave = true;
    await commands.get('mauideploy.recordVideo')();
    assert.equal(saves, 1);
    assert.equal(revealed.length, 1);
    assert.ok(log.includes('Save declined or cancelled; preview retained.'));
    assert.equal(states.at(-1), 'idle');
    assert.equal(disposed, 0);
    declineSave = false;
    await commands.get('mauideploy.saveRecording')();
    assert.equal(saves, 2);
    assert.equal(revealed.length, 2);
    const copyVideo = vscodeMock.workspace.fs.copy;
    let saveError;
    vscodeMock.workspace.fs.copy = async () => { throw new Error('private destination details'); };
    vscodeMock.window.showErrorMessage = async message => { saveError = message; };
    await commands.get('mauideploy.saveRecording')();
    assert.match(saveError, /writable destination/);
    assert.ok(!saveError.includes('private destination details'));
    assert.equal(disposed, 0);
    assert.equal(revealed.length, 2);
    vscodeMock.workspace.fs.copy = copyVideo;
    vscodeMock.window.showErrorMessage = async message => assert.fail(message);
    let finderWarning;
    vscodeMock.window.showWarningMessage = async message => { finderWarning = message; };
    revealFailure = true;
    await commands.get('mauideploy.saveRecording')();
    assert.equal(saves, 3);
    assert.equal(revealed.length, 3);
    assert.match(finderWarning, /video was saved, but Finder/);
    assert.ok(!log.join('\n').includes('private Finder details'));
    assert.equal(disposed, 0);
    revealFailure = false;
    saveDestination.scheme = 'vscode-remote';
    await commands.get('mauideploy.saveRecording')();
    assert.equal(saves, 4);
    assert.equal(revealed.length, 3);
    saveDestination.scheme = 'file';
    const stateCount = states.length;
    let warned = false;
    vscodeMock.window.showWarningMessage = async () => { warned = true; };
    vscodeMock.workspace.isTrusted = false;
    await commands.get('mauideploy.recordVideo')();
    assert.equal(warned, true);
    assert.equal(states.length, stateCount);
    vscodeMock.workspace.isTrusted = true;
    vscodeMock.window.showQuickPick = async () => undefined;
    await commands.get('mauideploy.recordVideo')();
    assert.deepEqual(states.slice(-3), ['findingDevices', 'choosingDevice', 'idle']);
    let cancelCapture;
    vscodeMock.window.withProgress = async (options, callback) => callback({ report() {} }, {
        onCancellationRequested(callback) { cancelCapture = callback; return { dispose() {} }; },
    });
    vscodeMock.window.showQuickPick = async items => items.find(item => item.device?.id === 'record');
    recordings.captureVideo = async (device, options) => {
        options.onStarted();
        cancelCapture();
        assert.equal(options.signal.aborted, true);
        throw new Error('cancelled');
    };
    await commands.get('mauideploy.recordVideo')();
    assert.equal(saves, 4);
    assert.equal(revealed.length, 3);
    assert.deepEqual(states.slice(-4), ['preparing', 'recording', 'cancelling', 'idle']);
    assert.ok(log.includes('Video cancelled.'));
    for (const subscription of extensionContext.subscriptions) { subscription.dispose(); }
    assert.equal(disposed, 2);
});

test('recording cancellation closes the device picker, suppresses late discovery and keeps USB wait feedback accurate', { skip: process.platform !== 'darwin' }, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-video-feedback-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recordingModule = require('../out/recordings');
    const commands = new Map();
    const messages = [];
    const completions = [];
    const feedback = [];
    const device = { id: 'phone', name: 'Phone', platform: 'iOS', type: 'physical', transport: 'Wi-Fi' };
    let scenario;
    let picks = 0;
    let captures = 0;
    let notificationCancellation;
    const extensionContext = { subscriptions: [], globalStorageUri: { fsPath: directory }, extensionPath: directory };
    context.after(() => { for (const subscription of extensionContext.subscriptions) { subscription.dispose(); } });
    context.mock.method(vscodeMock.commands, 'registerCommand', (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
    });
    context.mock.method(vscodeMock.window, 'createOutputChannel', () => ({ appendLine() {}, show() {}, dispose() {} }));
    context.mock.method(vscodeMock.window, 'setStatusBarMessage', message => completions.push(message));
    context.mock.method(vscodeMock.window, 'showErrorMessage', message => assert.fail(message));
    context.mock.method(vscodeMock.window, 'withProgress', async (options, callback) => {
        assert.equal(options.title, 'MAUI Deploy: Record Video');
        assert.equal(options.cancellable, true);
        const token = new vscodeMock.CancellationTokenSource();
        notificationCancellation = token;
        try { return await callback({ report({ message }) { messages.push(message); } }, token.token); }
        finally { token.dispose(); }
    });
    context.mock.method(devicesModule, 'detectScreenshotDevices', async () => {
        assert.equal(messages.at(-1), 'Finding available devices...');
        if (scenario === 'discovery') { await commands.get('mauideploy.cancelRecording')(); }
        return [device];
    });
    context.mock.method(vscodeMock.window, 'showQuickPick', async (items, options, token) => {
        picks++;
        assert.equal(messages.at(-1), 'Waiting for device selection...');
        if (scenario === 'picker') {
            return new Promise(resolve => {
                token.onCancellationRequested(() => resolve(undefined));
                commands.get('mauideploy.cancelRecording')();
            });
        }
        return items.find(item => item.device);
    });
    context.mock.method(recordingModule, 'captureVideo', async (chosen, options) => {
        captures++;
        options.onStage('waitingForUsb');
        assert.equal(feedback.at(-1).state, 'waitingForUsb');
        assert.match(feedback.at(-1).message, /Connect and unlock/);
        if (scenario === 'usb-toolbar') { await commands.get('mauideploy.cancelRecording')(); }
        else { notificationCancellation.cancel(); }
        assert.equal(options.signal.aborted, true);
        options.onStage('starting');
        options.onFinalizing();
        assert.equal(feedback.at(-1).state, 'cancelling');
        options.signal.throwIfAborted();
    });
    registerScreenshotCommand(extensionContext, () => device.id, () => {}, (state, message) => feedback.push({ state, message }));
    for (scenario of ['discovery', 'picker', 'usb-toolbar', 'usb-notification']) {
        await commands.get('mauideploy.recordVideo')();
        assert.equal(completions.at(-1), 'Recording cancelled.');
        assert.equal(feedback.at(-1).state, 'idle');
        assert.ok(!feedback.some(item => item.state === 'recording'));
    }
    assert.equal(picks, 3);
    assert.equal(captures, 2);
});