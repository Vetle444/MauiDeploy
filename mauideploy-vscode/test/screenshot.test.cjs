const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

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
    commands: {}, window: {}, workspace: { isTrusted: true },
    ProgressLocation: { Window: 10, Notification: 15 }, ViewColumn: { Active: -1 }, QuickPickItemKind: { Separator: -1 },
};
const actualLoad = Module._load;
Module._load = function (request, ...args) {
    if (request === 'vscode') { return vscodeMock; }
    return actualLoad.call(this, request, ...args);
};
const { registerScreenshotCommand } = require('../out/screenshotCommand');
Module._load = actualLoad;

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
    let command;
    let captures = 0;
    let cancelChoice = false;
    let html;
    let warned = false;
    const busy = [];
    const log = [];
    vscodeMock.window.createOutputChannel = () => ({ appendLine: message => log.push(message), show() {}, dispose() {} });
    vscodeMock.commands.registerCommand = (name, callback) => { command = callback; return { dispose() {} }; };
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