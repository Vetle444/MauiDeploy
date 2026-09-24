const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { test } = require('node:test');
const { createToolboxSnapshot } = require('../out/toolboxModel');
const { EventEmitter } = require('node:events');

const idle = () => ({
    configuration: 'Debug', trusted: true, captureSupported: true, debugging: false,
    screenshotBusy: false, recording: { state: 'idle', elapsed: '00:00' }, preview: { state: 'idle' },
});
const action = (state, id) => createToolboxSnapshot(state).actions.find(item => item.id === id);

function loadProgress(vscode) {
    const filename = path.resolve(__dirname, '../out/toolProgress.js');
    const localRequire = Module.createRequire(filename);
    const sandbox = { exports: {}, require: name => name === 'vscode' ? vscode : localRequire(name) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.exports;
}

function loadPicker() {
    const filename = path.resolve(__dirname, '../out/toolPicker.js');
    class TestEmitter {
        emitter = new EventEmitter();
        event = callback => { this.emitter.on('event', callback); return { dispose: () => this.emitter.off('event', callback) }; };
        fire(value) { this.emitter.emit('event', value); }
        dispose() { this.emitter.removeAllListeners(); }
    }
    const sandbox = { exports: {}, require: () => ({
        EventEmitter: TestEmitter, QuickPickItemKind: { Separator: -1 },
        window: { createQuickPick() { assert.fail('Sidebar picker must not use a native popup'); } },
    }) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.exports;
}

test('sidebar selection returns original objects, preserves multi-select and rejects stale or fabricated options', async () => {
    const selectors = loadPicker();
    let reveals = 0;
    selectors.registerToolPickers({ reveal: async () => { reveals++; }, update() {} });
    const first = { label: '$(check) Phone', device: { id: 'one', platform: 'iOS', type: 'physical', transport: 'USB' }, picked: true };
    const second = { label: 'Simulator', device: { id: 'two', platform: 'Android', type: 'simulator' } };
    const selection = selectors.showToolQuickPick([first, second], { title: 'Devices', canPickMany: true });
    const prompt = selectors.getToolPicker();
    assert.equal(prompt.items[0].label, 'Phone');
    assert.deepEqual(JSON.parse(JSON.stringify(prompt.items.map(item => item.device))), [
        { platform: 'iOS', type: 'physical', transport: 'USB' },
        { platform: 'Android', type: 'simulator' },
    ]);
    assert.deepEqual(Array.from(prompt.selectedIds), [prompt.items[0].id]);
    selectors.handleToolPickerMessage({ type: 'toolboxPickAccept', id: 'stale', itemIds: [prompt.items[1].id] });
    selectors.handleToolPickerMessage({ type: 'toolboxPickAccept', id: prompt.id, itemIds: ['invented'] });
    assert.ok(selectors.getToolPicker());
    selectors.handleToolPickerMessage({ type: 'toolboxPickAccept', id: prompt.id, itemIds: prompt.items.map(item => item.id) });
    const chosen = await selection;
    assert.equal(chosen[0], first);
    assert.equal(chosen[1], second);
    assert.equal(selectors.getToolPicker(), undefined);
    assert.equal(reveals, 1);

    const picker = selectors.createToolQuickPick();
    picker.items = [first];
    let accepted = 0;
    picker.onDidAccept(() => accepted++);
    picker.show();
    const previousId = selectors.getToolPicker().items[0].id;
    picker.items = [second];
    selectors.handleToolPickerMessage({ type: 'toolboxPickAccept', id: picker.id, itemIds: [previousId] });
    assert.equal(accepted, 0);
    selectors.handleToolPickerMessage({ type: 'toolboxPickAccept', id: picker.id, itemIds: [selectors.getToolPicker().items[0].id] });
    assert.equal(accepted, 1);
    assert.equal(picker.selectedItems[0], second);
    picker.dispose();
});

test('sidebar search drives existing live pickers; cancellation and disposal release waiting choices', async () => {
    const selectors = loadPicker();
    const registration = selectors.registerToolPickers({ reveal: async () => {}, update() {} });
    const picker = selectors.createToolQuickPick();
    picker.onDidChangeValue(value => { picker.items = [{ label: value, source: 'synthetic' }]; });
    picker.show();
    selectors.handleToolPickerMessage({ type: 'toolboxPickInput', id: picker.id, value: 'https://example.test/pull/42' });
    assert.equal(selectors.getToolPicker().items[0].label, 'https://example.test/pull/42');
    picker.hide();
    const controller = new TestCancellation();
    const waiting = selectors.showToolQuickPick([{ label: 'Project' }], { title: 'Project' }, controller.token);
    controller.cancel();
    assert.equal(await waiting, undefined);
    assert.equal(selectors.getToolPicker(), undefined);
    const pending = selectors.showToolQuickPick([{ label: 'Another project' }]);
    registration.dispose();
    assert.equal(await pending, undefined);
    assert.equal(selectors.getToolPicker(), undefined);
});

class TestCancellation {
    constructor() {
        this.callbacks = new Set();
        this.token = {
            isCancellationRequested: false,
            onCancellationRequested: callback => {
                this.callbacks.add(callback);
                return { dispose: () => this.callbacks.delete(callback) };
            },
        };
    }
    cancel() {
        if (this.token.isCancellationRequested) return;
        this.token.isCancellationRequested = true;
        for (const callback of this.callbacks) callback();
    }
    dispose() { this.callbacks.clear(); }
}

test('visible sidebar owns progress and cancellation without native notifications, and releases completed or failed tasks', async () => {
    const progress = loadProgress({
        CancellationTokenSource: TestCancellation,
        window: { withProgress() { assert.fail('No native progress while the sidebar is visible.'); } },
    });
    let visible = true;
    let updates = 0;
    const registration = progress.registerToolProgress({ isVisible: () => visible, update: () => updates++ });
    const run = progress.withToolProgress({ title: 'Synthetic capture', cancellable: true, location: 15 }, async (reporter, token) => {
        reporter.report({ message: 'Reading', increment: 25 });
        await new Promise(resolve => token.onCancellationRequested(resolve));
        return 'cancelled';
    });
    const state = progress.getToolProgress()[0];
    assert.equal(state.percent, 25);
    assert.equal(state.message, 'Reading');
    visible = false;
    progress.cancelToolProgress('unknown-id');
    assert.equal(progress.getToolProgress()[0].cancelling, false);
    progress.cancelToolProgress(state.id);
    assert.equal(progress.getToolProgress()[0].cancelling, true);
    assert.equal(await run, 'cancelled');
    assert.equal(progress.getToolProgress().length, 0);
    visible = true;
    await assert.rejects(progress.withToolProgress({ title: 'Fails', location: 15 }, async () => { throw new Error('Synthetic failure'); }), /Synthetic failure/);
    assert.equal(progress.getToolProgress().length, 0);
    assert.ok(updates >= 5);
    registration.dispose();
});

test('progress retains native cancellation when sidebar is hidden and does not cancel non-cancellable sidebar tasks', async () => {
    let nativeCalls = 0;
    const nativeCancellation = new TestCancellation();
    const progress = loadProgress({
        CancellationTokenSource: TestCancellation,
        window: { withProgress: async (options, task) => {
            nativeCalls++;
            assert.equal(options.operationCommand, undefined);
            return task({ report() {} }, nativeCancellation.token);
        } },
    });
    let visible = false;
    const registration = progress.registerToolProgress({ isVisible: () => visible, update() {} });
    assert.equal(await progress.withToolProgress({ title: 'Native', location: 15 }, async (_reporter, token) => token === nativeCancellation.token), true);
    assert.equal(nativeCalls, 1);
    visible = true;
    await progress.withToolProgress({ title: 'Saving', location: 15, cancellable: false }, async (_reporter, token) => {
        progress.cancelToolProgress(progress.getToolProgress()[0].id);
        assert.equal(token.isCancellationRequested, false);
    });
    assert.equal(nativeCalls, 1);
    registration.dispose();
});

test('toolbox preserves capture cancellation and stop states without enabling conflicting starts', () => {
    for (const state of ['findingDevices', 'waitingForUsb', 'buildingHelper', 'starting', 'finalizing']) {
        const context = { ...idle(), recording: { state, message: 'Synthetic stage', elapsed: '00:00' } };
        assert.equal(action(context, 'recording').command, 'mauideploy.cancelRecording');
        assert.equal(action(context, 'recording').enabled, true);
        assert.equal(action(context, 'screenshot').enabled, false);
        assert.equal(action(context, 'preview').enabled, false);
    }
    const recording = { ...idle(), recording: { state: 'recording', elapsed: '01:05' } };
    assert.equal(action(recording, 'recording').command, 'mauideploy.stopRecording');
    assert.equal(action(recording, 'recording').note, '01:05');
    for (const state of ['saving', 'cancelling']) {
        assert.equal(action({ ...recording, recording: { state, elapsed: '01:05' } }, 'recording').enabled, false);
    }
    assert.equal(action({ ...idle(), preview: { state: 'live' } }, 'preview').command, 'mauideploy.stopLivePreview');
    assert.equal(action({ ...idle(), preview: { state: 'stopping' } }, 'preview').enabled, false);
    assert.equal(action({ ...idle(), captureSupported: false }, 'screenshot').enabled, false);
});

test('toolbox blocks conflicting builds and trust-sensitive actions while retaining active stop', () => {
    const busy = { ...idle(), operation: { command: 'mauideploy.runTests', message: 'Testing', cancelling: false } };
    for (const id of ['debug', 'branch', 'bin', 'multiple', 'tests', 'project', 'configuration', 'clean']) {
        assert.equal(action(busy, id).enabled, false, id);
    }
    assert.equal(action(busy, 'stop').enabled, true);
    assert.equal(action({ ...busy, operation: { ...busy.operation, cancelling: true } }, 'stop').enabled, false);
    assert.equal(action({ ...idle(), trusted: false }, 'branch').enabled, false);
    assert.equal(action({ ...idle(), trusted: false }, 'memory').enabled, false);
    assert.equal(action({ ...busy, trusted: false }, 'stop').enabled, true);
    assert.equal(action({ ...idle(), debugging: true }, 'debug').command, 'mauideploy.stopDebug');
});

test('sidebar dispatches allowed actions, preserves pending work when hidden and never opens an editor panel', async () => {
    const filename = path.resolve(__dirname, '../out/toolbox.js');
    const localRequire = Module.createRequire(filename);
    const commands = new Map();
    const executed = [];
    let provider;
    let providerOptions;
    let focusRequests = 0;
    let onDispose;
    let onVisibility;
    const view = {
        visible: true, messages: [],
        webview: {
            cspSource: 'https://test-assets', asWebviewUri: value => value,
            postMessage(message) { view.messages.push(message); return Promise.resolve(true); },
            onDidReceiveMessage(callback) { view.receive = callback; return { dispose() {} }; },
        },
        onDidDispose(callback) { onDispose = callback; return { dispose() {} }; },
        onDidChangeVisibility(callback) { onVisibility = callback; return { dispose() {} }; },
    };
    let current = idle();
    let complete;
    const uri = fsPath => ({ fsPath, toString: () => `https://test-assets${fsPath}` });
    const vscode = {
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        commands: {
            registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; },
            executeCommand(command, ...args) {
                if (command === 'mauideploy.tools.focus') { focusRequests++; return; }
                executed.push({ command, args });
                if (command === 'mauideploy.debug') return new Promise(resolve => { complete = resolve; });
            },
        },
        window: {
            createWebviewPanel() { assert.fail('Tools must open in the sidebar.'); },
            registerWebviewViewProvider(id, registered, options) {
                assert.equal(id, 'mauideploy.tools');
                provider = registered;
                providerOptions = options;
                return { dispose() {} };
            },
        },
    };
    const sandbox = { exports: {}, require(name) {
        if (name === 'vscode') return vscode;
        if (name === 'fs') return { existsSync: () => true };
        if (name === './toolProgress') return loadProgress({ ...vscode, CancellationTokenSource: TestCancellation });
        if (name === './toolPicker') return loadPicker();
        return localRequire(name);
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    sandbox.exports.registerToolbox({ extensionUri: uri('/extension'), subscriptions: [] }, () => current);
    commands.get('mauideploy.openTools')();
    assert.equal(focusRequests, 1);
    provider.resolveWebviewView(view);
    assert.equal(providerOptions.webviewOptions.retainContextWhenHidden, true);
    await view.receive({ type: 'toolboxReady' });
    assert.ok(view.messages[0].state.actions.length > 0);
    assert.match(view.webview.html, /connect-src 'none'/);
    assert.deepEqual(Array.from(view.webview.options.localResourceRoots, item => item.fsPath), ['/extension/out/toolbox']);
    const manifest = require('../package.json');
    assert.ok(manifest.contributes.views.mauideploy.some(item => item.type === 'webview' && item.id === 'mauideploy.tools'));
    await view.receive({ type: 'toolboxAction', id: 'arbitrary', command: 'workbench.action.closeWindow' });
    current = { ...idle(), trusted: false };
    await view.receive({ type: 'toolboxAction', id: 'branch' });
    assert.equal(executed.length, 0);
    current = idle();
    const running = view.receive({ type: 'toolboxAction', id: 'debug', args: ['untrusted payload'] });
    view.visible = false;
    onVisibility();
    await view.receive({ type: 'toolboxAction', id: 'debug' });
    await view.receive({ type: 'toolboxAction', id: 'branch' });
    assert.deepEqual(executed, [{ command: 'mauideploy.debug', args: [] }]);
    current = { ...idle(), operation: { command: 'mauideploy.debug', message: 'Building', cancelling: false } };
    view.visible = true;
    onVisibility();
    assert.equal(view.messages.at(-1).state.operation.message, 'Building');
    await view.receive({ type: 'toolboxAction', id: 'stop' });
    assert.equal(executed.at(-1).command, 'mauideploy.stop');
    commands.get('mauideploy.openTools')();
    assert.equal(focusRequests, 2);
    onDispose();
    const count = view.messages.length;
    complete();
    await running;
    assert.equal(view.messages.length, count);
});