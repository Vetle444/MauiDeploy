const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');

function prerequisitesHarness() {
    const filename = path.resolve(__dirname, '../out/prerequisites.js');
    const localRequire = createRequire(filename);
    const fixture = { calls: [], responses: new Map(), controller: new AbortController(), installations: [], kills: [], readOnlyDirectories: new Set() };
    const execute = () => {};
    execute[promisify.custom] = async (executable, args, options) => {
        fixture.calls.push({ executable, args, options });
        const result = fixture.responses.get([executable, ...args].join(' '));
        if (result instanceof Error) { throw result; }
        if (typeof result === 'function') { return result(options); }
        return { stdout: result ?? '' };
    };
    const spawn = (executable, args, options) => {
        const child = new EventEmitter();
        child.pid = 1234;
        fixture.child = child;
        fixture.installations.push({ executable, args, options });
        queueMicrotask(() => {
            if (fixture.onInstall) { fixture.onInstall(executable, args, options); }
            child.emit('close', fixture.installExitCode ?? 0);
        });
        return child;
    };
    const sandbox = {
        exports: {}, setTimeout, clearTimeout,
        process: { ...process, platform: 'darwin', kill: (pid, signal) => fixture.kills.push({ pid, signal }) },
        require: name => {
            if (name === 'child_process') { return { execFile: execute, spawn }; }
            if (name === 'fs') {
                return { ...fs, promises: { ...fs.promises, access: async (directory, mode) => {
                    if (fixture.readOnlyDirectories.has(directory)) { throw Object.assign(new Error('Administrator-managed'), { code: 'EACCES' }); }
                    return fs.promises.access(directory, mode);
                } } };
            }
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return Object.assign(fixture, sandbox.exports);
}

test('missing Git offers only a supported local installer and missing Homebrew remains user-managed', async () => {
    const fixture = prerequisitesHarness();
    const signal = fixture.controller.signal;
    fixture.responses.set('git --version', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    let issues = await fixture.inspectGitPrerequisites('/private/storage', signal);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].install.executable, 'brew');
    assert.deepEqual(Array.from(issues[0].install.args), ['install', 'git']);
    assert.equal(issues[0].install.cwd, '/private/storage');
    fixture.responses.set('brew --version', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    issues = await fixture.inspectGitPrerequisites('/private/storage', signal);
    assert.equal(issues[0].install, undefined);
});

test('PR prerequisites distinguish missing gh from host-specific authentication without exposing credentials', async () => {
    const fixture = prerequisitesHarness();
    const signal = fixture.controller.signal;
    fixture.responses.set('gh --version', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    let issues = await fixture.inspectGitHubPrerequisites('dips.ghe.com', '/private/storage', signal);
    assert.equal(issues[0].id, 'github-cli');
    assert.ok(!fixture.calls.some(call => call.args.includes('status')));
    fixture.responses.delete('gh --version');
    fixture.responses.set('gh auth status --hostname dips.ghe.com', new Error('secret credential output'));
    issues = await fixture.inspectGitHubPrerequisites('dips.ghe.com', '/private/storage', signal);
    assert.equal(issues[0].id, 'github-auth');
    assert.equal(issues[0].install, undefined);
    assert.deepEqual(Array.from(issues[0].manualCommand.args), ['auth', 'login', '--hostname', 'dips.ghe.com', '--web']);
    assert.doesNotMatch(JSON.stringify(issues), /secret credential output/);
    const statusCall = fixture.calls.find(call => call.args.includes('status'));
    assert.equal(statusCall.options.env.GH_PROMPT_DISABLED, '1');
    assert.ok(!statusCall.args.includes('--show-token'));
    fixture.responses.delete('gh auth status --hostname dips.ghe.com');
    assert.equal((await fixture.inspectGitHubPrerequisites('dips.ghe.com', '/private/storage', signal)).length, 0);
});

test('cancelled prerequisite checks never become missing-tool or installation findings', async () => {
    const fixture = prerequisitesHarness();
    fixture.responses.set('git --version', () => {
        fixture.controller.abort();
        throw new Error('Process cancelled');
    });
    await assert.rejects(fixture.inspectGitPrerequisites('/private/storage', fixture.controller.signal));
    assert.equal(fixture.calls.length, 1);
});

test('Xcode checks distinguish Command Line Tools from first-use setup and missing iOS tools', async () => {
    const fixture = prerequisitesHarness();
    const signal = fixture.controller.signal;
    fixture.responses.set('/usr/bin/xcode-select -p', '/Library/Developer/CommandLineTools');
    fixture.responses.set('/usr/bin/xcodebuild -version', new Error('Command Line Tools selected'));
    let issues = await fixture.inspectXcodePrerequisites('/private/storage', signal);
    assert.equal(issues[0].id, 'xcode');
    assert.equal(issues[0].install, undefined);
    fixture.responses.set('/usr/bin/xcode-select -p', '/Applications/Xcode.app/Contents/Developer');
    fixture.responses.set('/usr/bin/xcodebuild -version', 'Xcode 26.4\nBuild version example');
    fixture.responses.set('/usr/bin/xcodebuild -checkFirstLaunchStatus', new Error('License required'));
    issues = await fixture.inspectXcodePrerequisites('/private/storage', signal);
    assert.equal(issues[0].id, 'xcode-setup');
    assert.equal(issues[0].manualCommand.executable, '/usr/bin/open');
    assert.deepEqual(Array.from(issues[0].manualCommand.args), ['-a', '/Applications/Xcode.app']);
    fixture.responses.delete('/usr/bin/xcodebuild -checkFirstLaunchStatus');
    fixture.responses.set('/usr/bin/xcrun --find devicectl', new Error('missing'));
    fixture.responses.set('/usr/bin/xcrun --sdk iphoneos --show-sdk-version', new Error('missing'));
    issues = await fixture.inspectXcodePrerequisites('/private/storage', signal);
    assert.deepEqual(Array.from(issues, issue => issue.id), ['xcode-devicectl', 'xcode-ios-sdk']);
    fixture.responses.delete('/usr/bin/xcrun --find devicectl');
    fixture.responses.delete('/usr/bin/xcrun --sdk iphoneos --show-sdk-version');
    assert.equal((await fixture.inspectXcodePrerequisites('/private/storage', signal)).length, 0);
});

function sdkFixture(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-prerequisites-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'worktree');
    const projectDirectory = path.join(root, 'src', 'App');
    fs.mkdirSync(projectDirectory, { recursive: true });
    const project = path.join(projectDirectory, 'App.csproj');
    fs.writeFileSync(project, '<Project />');
    const globalJson = path.join(root, 'global.json');
    fs.writeFileSync(globalJson, JSON.stringify({ sdk: { version: '10.0.100' } }));
    const storage = path.join(directory, 'storage');
    const dotnetRoot = path.join(directory, 'system-dotnet');
    fs.mkdirSync(dotnetRoot);
    const dotnet = path.join(dotnetRoot, 'dotnet');
    fs.writeFileSync(dotnet, 'fixture');
    return { directory, root, projectDirectory, project, globalJson, storage, dotnet: fs.realpathSync(dotnet) };
}

test('SDK checks resolve from the worktree and propose the pinned version instead of changing global.json', async context => {
    const files = sdkFixture(context);
    const fixture = prerequisitesHarness();
    fixture.responses.set('/usr/bin/which dotnet', files.dotnet);
    fixture.responses.set(`${files.dotnet} --version`, new Error('Requested SDK 10.0.100 unavailable; installed 10.0.204'));
    const before = fs.readFileSync(files.globalJson);
    const result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'dotnet-sdk');
    assert.equal(result.issues[0].sdkInstall.version, '10.0.100');
    assert.equal(result.issues[0].sdkInstall.directory, path.join(files.storage, 'dotnet', '10.0.100'));
    assert.equal(result.issues[0].sdkInstall.workingDirectory, files.projectDirectory);
    assert.ok(fixture.calls.every(call => call.options.cwd === files.projectDirectory));
    assert.deepEqual(fs.readFileSync(files.globalJson), before);
});

test('the CLI resolver governs roll-forward and workloads are checked using that exact host and directory', async context => {
    const files = sdkFixture(context);
    fs.writeFileSync(files.globalJson, JSON.stringify({ sdk: { version: '10.0.100', rollForward: 'latestFeature' } }));
    const fixture = prerequisitesHarness();
    fixture.responses.set('/usr/bin/which dotnet', files.dotnet);
    fixture.responses.set(`${files.dotnet} --version`, '10.0.204');
    fixture.responses.set(`${files.dotnet} workload list --machine-readable`, 'SDK notice\n{"installed":["maui-ios"]}');
    let result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.executable, files.dotnet);
    assert.equal(result.version, '10.0.204');
    assert.equal(result.issues.length, 0);
    const check = fixture.calls.find(call => call.args.includes('workload'));
    assert.equal(check.options.env.DOTNET_HOST_PATH, files.dotnet);
    assert.equal(check.options.cwd, files.projectDirectory);
    fixture.responses.set(`${files.dotnet} workload list --machine-readable`, '{"installed":["maui-android"]}');
    result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'maui-ios');
    assert.equal(result.issues[0].install.executable, files.dotnet);
    assert.deepEqual(Array.from(result.issues[0].install.args), ['workload', 'install', 'maui-ios', '--skip-manifest-update']);
    fixture.responses.set(`${files.dotnet} workload list --machine-readable`, 'Unrecognized output');
    result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'dotnet-workloads');
    assert.equal(result.issues[0].install, undefined);
});

test('an older unpinned SDK offers the target channel but a conflicting project pin stays user-managed', async context => {
    const files = sdkFixture(context);
    const fixture = prerequisitesHarness();
    fixture.responses.set('/usr/bin/which dotnet', files.dotnet);
    fixture.responses.set(`${files.dotnet} --version`, '8.0.100');
    fs.unlinkSync(files.globalJson);
    let result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'dotnet-target');
    assert.equal(result.issues[0].sdkInstall.channel, '10.0');
    fs.writeFileSync(files.globalJson, '{"sdk":{"version":"8.0.100"}}');
    result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'dotnet-target');
    assert.equal(result.issues[0].sdkInstall, undefined);
    assert.equal(JSON.parse(fs.readFileSync(files.globalJson, 'utf8')).sdk.version, '8.0.100');
});

test('a private SDK takes priority once installed and unsafe or ambiguous SDK requests never become install commands', async context => {
    const files = sdkFixture(context);
    const fixture = prerequisitesHarness();
    const managed = path.join(files.storage, 'dotnet', '10.0.100', 'dotnet');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, 'fixture');
    const executable = fs.realpathSync(managed);
    fixture.responses.set(`${executable} --version`, '10.0.100');
    fixture.responses.set(`${executable} workload list --machine-readable`, '{"installed":["maui"]}');
    let result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.executable, executable);
    assert.equal(result.issues.length, 0);
    fs.writeFileSync(files.globalJson, '{"sdk":{"version":"--other-command"}}');
    result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'dotnet-sdk');
    assert.equal(result.issues[0].sdkInstall, undefined);
});

test('administrator-managed SDKs offer a private copy instead of a privileged workload installation', async context => {
    const files = sdkFixture(context);
    const fixture = prerequisitesHarness();
    fixture.responses.set('/usr/bin/which dotnet', files.dotnet);
    fixture.responses.set(`${files.dotnet} --version`, '10.0.100');
    fixture.responses.set(`${files.dotnet} workload list --machine-readable`, '{"installed":[]}');
    fixture.readOnlyDirectories.add(path.dirname(files.dotnet));
    const result = await fixture.inspectIosSdkPrerequisites(files.project, 'net10.0-ios', files.storage, fixture.controller.signal);
    assert.equal(result.issues[0].id, 'maui-ios');
    assert.equal(result.issues[0].install, undefined);
    assert.equal(result.issues[0].sdkInstall.version, '10.0.100');
    assert.equal(result.issues[0].sdkInstall.directory, path.join(files.storage, 'dotnet', '10.0.100'));
    assert.equal(result.issues[0].manualCommand.executable, files.dotnet);
    assert.equal(fixture.installations.length, 0);
});

test('SDK installation validates staging before activation and never leaves a failed SDK or lock behind', async context => {
    const files = sdkFixture(context);
    const fixture = prerequisitesHarness();
    const installation = { directory: path.join(files.storage, 'dotnet', '10.0.100'), workingDirectory: files.projectDirectory, version: '10.0.100' };
    const issue = { id: 'dotnet-sdk', sdkInstall: installation };
    fixture.onInstall = (executable, args) => {
        if (executable !== '/bin/bash') { return; }
        const staging = args[args.indexOf('--install-dir') + 1];
        const dotnet = path.join(staging, 'dotnet');
        fs.writeFileSync(dotnet, 'SDK fixture');
        fixture.responses.set(`${dotnet} --version`, fixture.validSdk ? '10.0.100' : new Error('Cannot resolve SDK'));
    };
    await assert.rejects(fixture.installPrerequisite(issue, files.storage, fixture.controller.signal), /does not satisfy/);
    assert.equal(fs.existsSync(installation.directory), false);
    assert.equal(fs.existsSync(path.join(files.storage, 'install.lock')), false);
    assert.deepEqual(fs.readdirSync(path.join(files.storage, 'dotnet')), []);
    fixture.validSdk = true;
    await fixture.installPrerequisite(issue, files.storage, fixture.controller.signal);
    assert.ok(fs.existsSync(path.join(installation.directory, 'dotnet')));
    const installer = fixture.installations.find(call => call.executable === '/bin/bash');
    assert.ok(installer.args.includes('--no-path'));
    assert.equal(installer.args[installer.args.indexOf('--version') + 1], '10.0.100');
    assert.ok(fixture.installations.every(call => call.options.cwd === files.storage));
    assert.equal(fs.existsSync(path.join(files.storage, 'install.lock')), false);
});

test('dependency installation refuses concurrent work and cancels only its owned process group', async context => {
    const files = sdkFixture(context);
    const fixture = prerequisitesHarness();
    fs.mkdirSync(files.storage);
    const lock = path.join(files.storage, 'install.lock');
    fs.writeFileSync(lock, 'another process');
    const issue = { id: 'github-cli', install: { executable: 'brew', args: ['install', 'gh'], cwd: files.storage } };
    await assert.rejects(fixture.installPrerequisite(issue, files.storage, fixture.controller.signal), /Another MauiDeploy/);
    assert.equal(fixture.installations.length, 0);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'another process');
    fs.unlinkSync(lock);
    fixture.onInstall = () => fixture.controller.abort();
    await assert.rejects(fixture.installPrerequisite(issue, files.storage, fixture.controller.signal));
    assert.deepEqual(fixture.kills, [{ pid: -1234, signal: 'SIGKILL' }]);
    assert.equal(fs.existsSync(lock), false);
});

function setupHarness(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-prerequisite-ui-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.resolve(__dirname, '../out/prerequisiteSetup.js');
    const localRequire = createRequire(filename);
    const controller = new AbortController();
    const fixture = { issues: [], authIssues: [], actions: [], installed: [], checks: [], hostChecks: [], documentation: [], terminals: [], consent: 'Install', controller };
    const closeHandlers = new Set();
    const token = { get isCancellationRequested() { return controller.signal.aborted; } };
    const issue = { id: 'tool', title: 'Tool', detail: 'Required tool', documentation: 'https://example.invalid/setup', install: { executable: 'brew', args: ['install', 'gh'], cwd: directory } };
    const sandbox = {
        exports: {}, process: { ...process, platform: 'darwin' },
        require: name => {
            if (name === 'vscode') {
                return {
                    CancellationError: class extends Error {}, Uri: { parse: value => value },
                    ThemeIcon: class {}, TerminalExitReason: { Process: 1, User: 2 },
                    env: { openExternal: async url => fixture.documentation.push(url) },
                    window: {
                        showQuickPick: async (items, options, selectedToken) => {
                            assert.equal(selectedToken, token);
                            const action = fixture.actions.shift();
                            if (action === 'abort') { controller.abort(); return undefined; }
                            if (action === 'recheck') { fixture.issues = []; }
                            return items.find(item => item.action === action);
                        },
                        showWarningMessage: async () => fixture.consent,
                        showErrorMessage: async () => {},
                        onDidCloseTerminal: handler => {
                            closeHandlers.add(handler);
                            return { dispose: () => closeHandlers.delete(handler) };
                        },
                        createTerminal: options => {
                            fixture.terminals.push(options);
                            const terminal = {
                                dispose() {},
                                show() {
                                    queueMicrotask(() => {
                                        assert.ok(fixture.authIssues.length > 0);
                                        for (const handler of closeHandlers) { handler({ exitStatus: { code: 0, reason: 1 } }); }
                                        if (fixture.cancelSignIn) {
                                            terminal.exitStatus = { reason: 2 };
                                        } else {
                                            fixture.authIssues = [];
                                            terminal.exitStatus = { code: 0, reason: 1 };
                                        }
                                        for (const handler of closeHandlers) { handler(terminal); }
                                    });
                                }
                            };
                            return terminal;
                        }
                    }
                };
            }
            if (name === './prerequisites') {
                return {
                    inspectGitPrerequisites: async () => { fixture.checks.push('git'); return [...fixture.issues]; },
                    inspectGitHubPrerequisites: async host => { fixture.hostChecks.push(host); return fixture.authIssues; },
                    inspectXcodePrerequisites: async () => fixture.issues,
                    inspectIosSdkPrerequisites: async (project, framework) => {
                        fixture.checks.push({ project, framework });
                        return { executable: '/private/dotnet/dotnet', issues: fixture.issues };
                    },
                    installPrerequisite: async (value, storage, signal) => {
                        fixture.installed.push(value);
                        assert.equal(signal, controller.signal);
                        if (fixture.installFails) { throw new Error('Install failed'); }
                        fixture.issues = [];
                    }
                };
            }
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const preflight = new sandbox.exports.BranchPrerequisites({ globalStorageUri: { fsPath: directory } }, token, controller.signal, () => {});
    return { ...fixture, fixture, preflight, issue };
}

test('prerequisite UI installs only after consent, rechecks and retains the correct GHE host', async context => {
    const { fixture, preflight, issue } = setupHarness(context);
    fixture.issues = [issue];
    fixture.actions = ['install'];
    await preflight.ensureSourceTools('dips.ghe.com');
    assert.equal(fixture.installed.length, 1);
    assert.equal(fixture.checks.length, 2);
    assert.ok(fixture.hostChecks.every(host => host === 'dips.ghe.com'));
    const count = fixture.hostChecks.length;
    await preflight.ensureGitHub('dips.ghe.com');
    assert.equal(fixture.hostChecks.length, count);
});

test('declining, cancelling or failed installation cannot pass the dependency gate', async context => {
    for (const scenario of ['declined', 'cancelled', 'failed']) {
        const { fixture, preflight, issue } = setupHarness(context);
        fixture.issues = [issue];
        fixture.actions = [scenario === 'cancelled' ? 'abort' : 'install'];
        if (scenario === 'declined') { fixture.consent = undefined; }
        if (scenario === 'failed') { fixture.installFails = true; }
        await assert.rejects(preflight.ensureSourceTools());
        assert.equal(fixture.installed.length, scenario === 'failed' ? 1 : 0);
    }
});

test('host-specific sign-in resumes checks after its own terminal exits, while cancelled sign-in stops the request', async context => {
    for (const cancelSignIn of [false, true]) {
        const { fixture, preflight } = setupHarness(context);
        fixture.cancelSignIn = cancelSignIn;
        fixture.authIssues = [{
            id: 'github-auth', title: 'GHE sign-in', detail: 'Sign in', documentation: 'https://cli.github.com/manual/gh_auth_login',
            manualCommand: { executable: '/opt/homebrew/bin/gh', args: ['auth', 'login', '--hostname', 'dips.ghe.com', '--web'], cwd: '/private/storage' }
        }];
        fixture.actions = ['manual'];
        if (cancelSignIn) { await assert.rejects(preflight.ensureSourceTools('dips.ghe.com')); }
        else { await preflight.ensureSourceTools('dips.ghe.com'); }
        assert.equal(fixture.terminals.length, 1);
        assert.equal(fixture.terminals[0].shellPath, '/opt/homebrew/bin/gh');
        assert.deepEqual(Array.from(fixture.terminals[0].shellArgs), ['auth', 'login', '--hostname', 'dips.ghe.com', '--web']);
        assert.equal(fixture.terminals[0].env.GH_PROMPT_DISABLED, null);
        assert.equal(fixture.installed.length, 0);
        assert.equal(fixture.hostChecks.length, cancelSignIn ? 1 : 2);
    }
});

test('manual instructions recheck without installation and missing Xcode can be bypassed only for Android', async context => {
    const { fixture, preflight, issue } = setupHarness(context);
    fixture.issues = [{ ...issue, install: undefined }];
    fixture.actions = ['documentation', 'recheck'];
    await preflight.ensureSourceTools();
    assert.deepEqual(fixture.documentation, [issue.documentation]);
    assert.equal(fixture.installed.length, 0);
    const ios = { name: 'iOS', framework: 'net10.0-ios' };
    const android = { name: 'Android', framework: 'net10.0-android' };
    fixture.issues = [issue];
    fixture.actions = ['alternative'];
    assert.deepEqual(Array.from(await preflight.prepareDevicePlatforms([ios, android])), [android]);
    fixture.actions = ['alternative'];
    await assert.rejects(preflight.prepareDevicePlatforms([ios]));
    assert.equal(await preflight.ensureBuildTools('/worktree/App.csproj', android), undefined);
    fixture.issues = [];
    assert.equal(await preflight.ensureBuildTools('/worktree/App.csproj', ios), '/private/dotnet/dotnet');
});

test('iOS restore, registrar clean and build use the resolved SDK without changing ordinary Run defaults', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-sdk-build-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.resolve(__dirname, '../out/deployer.js');
    const localRequire = createRequire(filename);
    const commands = [];
    const terminals = [];
    const sandbox = {
        exports: {}, process,
        captureCommand: command => { commands.push(command); return { success: true, durationMs: 0 }; },
        require: name => {
            if (name === 'os') { return { ...os, tmpdir: () => directory }; }
            if (name === 'vscode') {
                return {
                    ThemeIcon: class {}, Uri: { file: value => value },
                    workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) },
                    window: {
                        createTerminal: options => { terminals.push(options); return { show() {}, dispose() {} }; },
                        createOutputChannel: () => ({ appendLine() {} }), showErrorMessage() {}
                    }
                };
            }
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
        sharedBuildProps = () => '';
        runTerminalCommand = async (terminal, command) => captureCommand(command);
        runBuildCommand = async (terminal, factory) => captureCommand(factory(''));
    `, sandbox, { filename });
    const platform = { name: 'iOS', framework: 'net10.0-ios' };
    const project = path.join(directory, 'App', 'App.csproj');
    const dotnet = path.join(directory, 'Managed SDK', 'dotnet');
    await sandbox.exports.buildAndDeploy(project, platform, { id: 'phone', type: 'physical' }, 'Debug', undefined, undefined, 'Branch', dotnet);
    assert.equal(commands.length, 3);
    for (const verb of ['restore', 'clean', 'build']) {
        assert.ok(commands.some(command => command.includes(`'${dotnet}' ${verb} `)));
    }
    assert.equal(terminals[0].env.DOTNET_ROOT, path.dirname(dotnet));
    assert.equal(terminals[0].cwd, path.dirname(project));
    commands.length = 0;
    await sandbox.exports.buildAndDeploy(project, platform, { id: 'simulator', type: 'simulator' }, 'Debug', undefined, undefined, 'Simulator', dotnet);
    assert.ok(commands[0].includes(`'${dotnet}' build `));
    commands.length = 0;
    await sandbox.exports.buildAndDeploy(project, platform, { id: 'simulator', type: 'simulator' }, 'Debug');
    assert.ok(commands[0].includes('dotnet build '));
    assert.equal(terminals[2].env, undefined);
});