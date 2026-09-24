const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { test } = require('node:test');
const os = require('node:os');
const { EventEmitter } = require('node:events');

class SafeDiagnosticsError extends Error { }

function loadInspector(hasAssets = true, options = {}) {
    const filename = path.resolve(__dirname, '../out/memoryInspector.js');
    const localRequire = Module.createRequire(filename);
    const commands = new Map();
    const panels = [];
    const errors = [];
    const reads = [];
    const uri = fsPath => ({ fsPath, toString: () => `https://local-assets${fsPath}` });
    const vscode = {
        workspace: { isTrusted: options.trusted !== false },
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        ViewColumn: { Active: -1 },
        commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
        window: {
            showErrorMessage(message) { errors.push(message); },
            createWebviewPanel(viewType, title, column, options) {
                let onDispose;
                const panel = {
                    viewType, title, column, options, reveals: 0, disposed: false,
                    messages: [],
                    webview: {
                        cspSource: 'https://local-assets', asWebviewUri: value => value,
                        postMessage(message) { panel.messages.push(message); return Promise.resolve(true); },
                        onDidReceiveMessage(callback) { panel.receive = callback; return { dispose() {} }; },
                    },
                    onDidDispose(callback) { onDispose = callback; return { dispose() {} }; },
                    reveal() { this.reveals++; },
                    dispose() { this.disposed = true; onDispose?.(); },
                };
                panels.push(panel);
                return panel;
            },
        },
    };
    const sandbox = {
        exports: {}, AbortController,
        require(name) {
            if (name === 'vscode') return vscode;
            if (name === 'fs') return { existsSync: () => hasAssets };
            if (name === './memoryDiagnostics') return {
                MemoryDiagnosticsError: SafeDiagnosticsError,
                async readDeviceMemoryDiagnostics(target, signal) {
                    reads.push({ target, signal });
                    if (options.read) return options.read(target, signal);
                    return [{ name: 'checks.jsonl', content: 'Synthetic file', lastModified: 10 }];
                },
            };
            return localRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const context = { extensionUri: uri('/extension'), subscriptions: [] };
    sandbox.exports.registerMemoryInspector(context, options.getTarget ?? (async () => syntheticTarget));
    return { context, panels, errors, reads, open: commands.get('mauideploy.memoryDiagnostics') };
}

test('memory inspector reuses the in-memory panel, recreates after close and disposes with the extension', () => {
    const inspector = loadInspector();
    inspector.open();
    inspector.open();
    assert.equal(inspector.panels.length, 1);
    assert.equal(inspector.panels[0].reveals, 1);
    assert.equal(inspector.panels[0].options.retainContextWhenHidden, true);
    inspector.panels[0].dispose();
    inspector.open();
    assert.equal(inspector.panels.length, 2);
    for (const subscription of inspector.context.subscriptions) subscription.dispose();
    assert.equal(inspector.panels[1].disposed, true);
});

test('memory inspector only exposes bundled assets and forbids network connections and inline script', () => {
    const inspector = loadInspector();
    inspector.open();
    const panel = inspector.panels[0];
    assert.equal(panel.options.localResourceRoots.length, 1);
    assert.equal(panel.options.localResourceRoots[0].fsPath, '/extension/out/memory-inspector');
    const html = panel.webview.html;
    assert.match(html, /default-src 'none'/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /script-src 'nonce-[a-f0-9]{48}'/);
    assert.match(html, /inspector\.js/);
    assert.match(html, /inspector\.css/);
    assert.doesNotMatch(html, /unsafe-inline|acquireVsCodeApi|localStorage|sessionStorage|https?:\/\/(?!local-assets)/);
    const manifest = require('../package.json');
    assert.ok(manifest.contributes.commands.some(command => command.command === 'mauideploy.memoryDiagnostics'));
});

test('missing UI assets never open a broken diagnostic panel', () => {
    const inspector = loadInspector(false);
    inspector.open();
    assert.equal(inspector.panels.length, 0);
    assert.equal(inspector.errors.length, 1);
});

test('device import waits for the ready handshake and refreshes the currently selected target on every toolbar click', async () => {
    let target = syntheticTarget;
    const inspector = loadInspector(true, { getTarget: async () => target });
    inspector.open();
    assert.equal(inspector.reads.length, 0);
    const panel = inspector.panels[0];
    await panel.receive({ type: 'deviceImportReady' });
    assert.equal(inspector.reads.length, 1);
    assert.equal(panel.messages.at(-1).type, 'deviceImportLoaded');
    assert.equal(panel.messages.at(-1).files[0].name, 'checks.jsonl');
    assert.equal(panel.messages.at(-1).origin.label, 'org.synthetic.memory / Synthetic phone');
    await panel.receive({ type: 'deviceImportReady' });
    assert.equal(inspector.reads.length, 1);
    target = { ...syntheticTarget, applicationId: 'org.synthetic.other' };
    await inspector.open();
    assert.equal(inspector.reads.length, 2);
    assert.equal(inspector.reads[1].target.applicationId, target.applicationId);
    assert.equal(panel.messages.at(-1).requestId, 2);
    await panel.receive({ type: 'deviceImportRefresh', applicationId: 'org.attacker.app', deviceId: 'OTHER' });
    assert.equal(inspector.reads[2].target, target);
});

test('untrusted workspaces and cancelled selection never access a device; unexpected errors never expose diagnostics', async () => {
    const untrusted = loadInspector(true, { trusted: false, getTarget: () => assert.fail('must not select target') });
    untrusted.open();
    await untrusted.panels[0].receive({ type: 'deviceImportReady' });
    assert.equal(untrusted.reads.length, 0);
    assert.match(untrusted.panels[0].messages.at(-1).message, /Trust this workspace/);
    const cancelled = loadInspector(true, { getTarget: async () => undefined });
    cancelled.open();
    await cancelled.panels[0].receive({ type: 'deviceImportReady' });
    assert.equal(cancelled.reads.length, 0);
    assert.equal(cancelled.panels[0].messages.at(-1).type, 'deviceImportError');
    const failing = loadInspector(true, { read: async () => { throw new Error('Synthetic sensitive command output'); } });
    failing.open();
    await failing.panels[0].receive({ type: 'deviceImportReady' });
    assert.doesNotMatch(JSON.stringify(failing.panels[0].messages), /sensitive/);
});

test('new requests and closed panels cancel owned reads and never deliver stale device snapshots', async () => {
    const completions = [];
    const inspector = loadInspector(true, { read: (target, signal) => new Promise(resolve => completions.push({ resolve, signal })) });
    inspector.open();
    const panel = inspector.panels[0];
    const first = panel.receive({ type: 'deviceImportReady' });
    await new Promise(resolve => setImmediate(resolve));
    const second = inspector.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completions[0].signal.aborted, true);
    completions[1].resolve([{ name: 'checks.jsonl', content: 'Synthetic latest', lastModified: 20 }]);
    await second;
    completions[0].resolve([{ name: 'checks.jsonl', content: 'Synthetic stale', lastModified: 10 }]);
    await first;
    assert.equal(panel.messages.filter(message => message.type === 'deviceImportLoaded').length, 1);
    assert.equal(panel.messages.at(-1).files[0].content, 'Synthetic latest');
    const third = inspector.open();
    await new Promise(resolve => setImmediate(resolve));
    const count = panel.messages.length;
    panel.dispose();
    assert.equal(completions[2].signal.aborted, true);
    completions[2].resolve([]);
    await third;
    assert.equal(panel.messages.length, count);
});

function loadDeviceReader(directory, execute, names = ['checks.previous.jsonl', 'checks.jsonl']) {
    const filename = path.resolve(__dirname, '../out/memoryDiagnostics.js');
    const localRequire = Module.createRequire(filename);
    const calls = [];
    const sandbox = {
        exports: {}, process, Buffer,
        require(name) {
            if (name === 'os') return { tmpdir: () => directory };
            if (name === 'child_process') return {
                execFile(binary, args, options, callback) {
                    calls.push({ binary, args: Array.from(args), options });
                    const child = new EventEmitter();
                    Promise.resolve().then(() => {
                        if (args.includes('info')) {
                            const isLibrary = args[args.indexOf('--subdirectory') + 1] === 'Library';
                            const entries = isLibrary ? ['memory-diagnostics'] : names;
                            return JSON.stringify({ result: { files: entries.map(name => ({
                                name, metadata: { size: 100 }, resources: { isDirectory: isLibrary, isSymbolicLink: false },
                            })) } });
                        }
                        if (args.includes('find')) return names.map(name => `files/memory-diagnostics/${name}\0`).join('');
                        return execute(binary, args, options);
                    }).then(
                        stdout => callback(null, stdout ?? '', ''),
                        error => callback(error, '', error.stderr ?? ''),
                    ).finally(() => child.emit('close'));
                    return child;
                },
            };
            return localRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return { read: sandbox.exports.readDeviceMemoryDiagnostics, calls };
}

const syntheticTarget = {
    applicationId: 'org.synthetic.memory',
    device: { id: 'SYNTHETIC-DEVICE', name: 'Synthetic phone', platform: 'iOS', type: 'physical' },
};

test('physical iOS discovers only diagnostic files for the selected app and removes private temporary copies', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reader-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const content = '{"schemaVersion":1,"rootType":"Synthetic.Page"}\n';
    const reader = loadDeviceReader(directory, async (binary, args, options) => {
        assert.equal(binary, 'xcrun');
        assert.equal(args[args.indexOf('--device') + 1], syntheticTarget.device.id);
        assert.equal(args[args.indexOf('--domain-identifier') + 1], syntheticTarget.applicationId);
        assert.equal(fs.statSync(options.cwd).mode & 0o777, 0o700);
        fs.writeFileSync(args[args.indexOf('--destination') + 1], content);
    });
    const files = await reader.read(syntheticTarget, new AbortController().signal);
    assert.deepEqual(Array.from(files, file => file.name), ['checks.jsonl', 'checks.previous.jsonl']);
    assert.ok(files.every(file => file.content === content));
    assert.deepEqual(reader.calls.filter(call => call.args.includes('copy')).map(call => call.args[call.args.indexOf('--source') + 1]), [
        'Library/memory-diagnostics/checks.jsonl', 'Library/memory-diagnostics/checks.previous.jsonl',
    ]);
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('missing rotated file is optional, while device failures discard partial imports and clean temporary files', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reader-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reader = loadDeviceReader(directory, async (binary, args) => {
        if (args.includes('Library/memory-diagnostics/checks.previous.jsonl')) {
            throw Object.assign(new Error('Synthetic private diagnostic output'), { stderr: 'NSCocoaErrorDomain Code=260 No such file or directory' });
        }
        fs.writeFileSync(args[args.indexOf('--destination') + 1], '');
    });
    const files = await reader.read(syntheticTarget, new AbortController().signal);
    assert.deepEqual(Array.from(files, file => file.name), ['checks.jsonl']);
    const failing = loadDeviceReader(directory, async (binary, args) => {
        fs.writeFileSync(args[args.indexOf('--destination') + 1], 'Synthetic private file');
        throw Object.assign(new Error('Synthetic private error'), { stderr: 'Synthetic private stderr' });
    });
    await assert.rejects(failing.read(syntheticTarget, new AbortController().signal), error => {
        assert.doesNotMatch(error.message, /Synthetic private/);
        return /Could not read diagnostics/.test(error.message);
    });
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('simulator reads the selected container and refuses diagnostic symlinks outside it', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reader-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const container = path.join(directory, 'container');
    const diagnostics = path.join(container, 'Library', 'memory-diagnostics');
    fs.mkdirSync(diagnostics, { recursive: true });
    fs.writeFileSync(path.join(diagnostics, 'checks.jsonl'), 'synthetic record');
    const reader = loadDeviceReader(directory, () => `${container}\n`);
    const target = { ...syntheticTarget, device: { ...syntheticTarget.device, type: 'simulator' } };
    const files = await reader.read(target, new AbortController().signal);
    assert.equal(files.length, 1);
    assert.equal(files[0].content, 'synthetic record');
    assert.deepEqual(reader.calls[0].args, ['simctl', 'get_app_container', target.device.id, target.applicationId, 'data']);
    const outside = path.join(directory, 'outside');
    fs.writeFileSync(outside, 'Do not import');
    fs.symlinkSync(outside, path.join(diagnostics, 'checks.previous.jsonl'));
    await assert.rejects(reader.read(target, new AbortController().signal), /Could not read the diagnostic file safely/);
});

test('Android uses only the selected device and run-as app files without copying other sandbox data', async () => {
    const reader = loadDeviceReader(os.tmpdir(), () => 'synthetic record');
    const target = { ...syntheticTarget, device: { ...syntheticTarget.device, platform: 'Android' } };
    const files = await reader.read(target, new AbortController().signal);
    assert.equal(files.length, 2);
    assert.ok(reader.calls.every(call => call.binary === 'adb'));
    assert.deepEqual(reader.calls[1].args, [
        '-s', target.device.id, 'exec-out', 'run-as', target.applicationId,
        'cat', "'files/memory-diagnostics/checks.jsonl'",
    ]);
    await assert.rejects(reader.read({ ...target, applicationId: 'unsafe; command' }, new AbortController().signal), /valid app and device/);
    assert.equal(reader.calls.length, 3);
});

test('cancelled imports wait for the device process to close and remove any temporary copy', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reader-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const controller = new AbortController();
    const reader = loadDeviceReader(directory, async (binary, args) => {
        controller.abort();
        fs.writeFileSync(args[args.indexOf('--destination') + 1], 'Synthetic private file');
    });
    await assert.rejects(reader.read(syntheticTarget, controller.signal), /cancelled/);
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(reader.calls.filter(call => call.args.includes('copy')).length, 1);
});

test('automatic discovery retains named sessions and rotated files, rejects unrelated paths and quotes Android filenames', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reader-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const names = ['checks-session-a.jsonl', 'checks-session-a.previous.jsonl', 'checks-session-b.jsonl', 'checks.jsonl', 'checks.previous.jsonl', 'private.txt', '../checks-private.jsonl'];
    const reader = loadDeviceReader(directory, async (binary, args) => {
        fs.writeFileSync(args[args.indexOf('--destination') + 1], 'Synthetic data');
    }, names);
    const files = await reader.read(syntheticTarget, new AbortController().signal);
    assert.equal(files.length, 5);
    assert.equal(reader.calls.filter(call => call.args.includes('copy')).length, 5);
    assert.deepEqual(fs.readdirSync(directory), []);
    const android = loadDeviceReader(directory, () => 'Synthetic data', ["checks-test'quote.jsonl", 'checks-another.jsonl']);
    const target = { ...syntheticTarget, device: { ...syntheticTarget.device, platform: 'Android' } };
    assert.equal((await android.read(target, new AbortController().signal)).length, 2);
    assert.ok(android.calls.some(call => call.args.at(-1) === "'files/memory-diagnostics/checks-test'\\''quote.jsonl'"));
});