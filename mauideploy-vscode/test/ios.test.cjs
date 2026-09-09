const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

function harness(results, collectBinlog = false) {
    const filename = path.resolve(__dirname, '../out/deployer.js');
    const localRequire = createRequire(filename);
    const commands = [];
    const messages = [];
    const state = new Map();
    const settings = { 'ios.collectBinlogs': collectBinlog };
    let clock = 0;
    const context = vm.createContext({
        exports: {}, process, console,
        Date: class extends Date { static now() { return clock; } },
        setTimeout: callback => { clock += 2000; callback(); },
        require: name => {
            if (name === 'vscode') {
                return {
                    window: {
                        createOutputChannel: () => ({ appendLine: line => messages.push(line) }),
                        showErrorMessage: message => messages.push(message)
                    },
                    workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
                    Uri: { file: value => value }
                };
            }
            if (name === './devices') {
                return { getBundleId: async () => 'test.bundle', findIosAppBundle: () => '/tmp/Test.app' };
            }
            if (name === 'fs') {
                return {
                    existsSync: filename => state.has(filename),
                    readFileSync: filename => state.get(filename),
                    writeFileSync: (filename, value) => state.set(filename, value),
                    mkdirSync: () => {}
                };
            }
            return localRequire(name);
        },
        fakeRun: async (_terminal, command, _timeout, _log, _failure, token) => {
            commands.push(command);
            assert.equal(token?.marker, 'token');
            const result = results.shift();
            assert.ok(result, 'Unexpected command');
            clock += result.durationMs;
            return result;
        }
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8') + `
        runTerminalCommand = fakeRun;
        getBuildTerminal = () => ({ show() {} });
        sharedBuildProps = () => '';
        restoreFlag = () => '';
        runBuildCommand = async (terminal, factory, timeout, token) =>
            fakeRun(terminal, factory(''), timeout, undefined, undefined, token);
        exports.testApi = { launchIosDeviceApp, launchIosSimulatorApp, runIosBuildCommand, runIosPhysicalBuild, iosFastBuildProps, buildForDebug, buildAndDeployIos, buildAndDeployIosDevice };
    `, context, { filename });
    return { ...context.exports.testApi, commands, messages, settings, state };
}

const token = { marker: 'token' };
const device = { id: 'test-device', name: 'Test phone' };

test('iOS install failure or cancellation prevents launch', async () => {
    for (const cancelled of [false, true]) {
        const fixture = harness([{ success: false, durationMs: 120, cancelled }]);
        const result = await fixture.launchIosDeviceApp({}, '/tmp/Test App.app', device, token);
        assert.equal(result.success, false);
        assert.equal(result.cancelled, cancelled);
        assert.equal(fixture.commands.length, 1);
    }
});

test('iOS waits for install and launch and includes both durations', async () => {
    const fixture = harness([
        { success: true, durationMs: 100 },
        { success: true, durationMs: 50 }
    ]);
    const result = await fixture.launchIosDeviceApp({}, '/tmp/Test App.app', device, token);
    assert.equal(result.success, true);
    assert.equal(result.durationMs, 150);
    assert.match(fixture.commands[0], /device install app/);
    assert.match(fixture.commands[1], /device process launch/);
    assert.ok(fixture.messages.some(message => message.includes('Install: 100 ms')));
    assert.ok(fixture.messages.some(message => message.includes('Launch: 50 ms')));
});

test('iOS launch failure is not reported as deployment success', async () => {
    const fixture = harness([
        { success: true, durationMs: 100 },
        { success: false, durationMs: 50 }
    ]);
    const result = await fixture.launchIosDeviceApp({}, '/tmp/Test.app', device, token);
    assert.equal(result.success, false);
    assert.equal(result.durationMs, 150);
});

test('simulator retries transient launch failure and includes retry delay', async () => {
    const fixture = harness([
        { success: true, durationMs: 100 },
        { success: false, durationMs: 50 },
        { success: true, durationMs: 50 }
    ]);
    const result = await fixture.launchIosSimulatorApp({}, '/tmp/Test.app', device, token);
    assert.equal(result.success, true);
    assert.equal(result.durationMs, 2200);
    assert.equal(fixture.commands.length, 3);
});

test('iOS binlogs are opt-in and retain project-import privacy option', async () => {
    for (const enabled of [false, true]) {
        const fixture = harness([{ success: true, durationMs: 100 }], enabled);
        await fixture.runIosBuildCommand({}, '/tmp/Test.csproj', flags => `dotnet build ${flags}`, 1000, token);
        assert.equal(fixture.commands[0].includes('.ios.binlog;ProjectImports=None'), enabled);
        assert.equal(fixture.messages.some(message => message.includes('Local binlog')), enabled);
    }
});

function buildPhysical(fixture, config = 'Debug') {
    return fixture.runIosPhysicalBuild({}, '/tmp/Test.csproj', 'net10.0-ios', config,
        (logs, properties) => `dotnet build ${properties} ${logs}`, 1000, token);
}

test('dynamic registrar defaults on, cleans once, and cleans when disabled', async () => {
    const fixture = harness(Array.from({ length: 5 }, () => ({ success: true, durationMs: 100 })));
    assert.equal((await buildPhysical(fixture)).durationMs, 200);
    assert.match(fixture.commands[0], /dotnet clean.*-f 'net10.0-ios'.*-c 'Debug'.*-r ios-arm64/);
    assert.match(fixture.commands[1], /-p:Registrar=dynamic/);
    await buildPhysical(fixture);
    assert.match(fixture.commands[2], /dotnet build.*-p:Registrar=dynamic/);
    fixture.settings['ios.useDynamicRegistrar'] = false;
    await buildPhysical(fixture);
    assert.match(fixture.commands[3], /dotnet clean/);
    assert.doesNotMatch(fixture.commands[4], /Registrar=/);
});

test('failed or cancelled registrar clean blocks build and is retried', async () => {
    for (const cancelled of [false, true]) {
        const fixture = harness([
            { success: false, cancelled, durationMs: 100 },
            { success: true, durationMs: 100 },
            { success: true, durationMs: 100 }
        ]);
        const result = await buildPhysical(fixture);
        assert.equal(result.success, false);
        assert.equal(result.cancelled, cancelled);
        assert.equal(fixture.commands.length, 1);
        assert.equal((await buildPhysical(fixture)).success, true);
        assert.match(fixture.commands[1], /dotnet clean/);
    }
});

test('failed registrar switch build leaves pending state and forces a clean retry', async () => {
    const fixture = harness([
        { success: true, durationMs: 100 },
        { success: false, durationMs: 100 },
        { success: true, durationMs: 100 },
        { success: true, durationMs: 100 }
    ]);
    assert.equal((await buildPhysical(fixture)).success, false);
    assert.equal((await buildPhysical(fixture)).success, true);
    assert.match(fixture.commands[2], /dotnet clean/);
});

test('Release and simulator retain their registrar and interpreter settings', async () => {
    const fixture = harness([{ success: true, durationMs: 100 }]);
    await buildPhysical(fixture, 'Release');
    assert.equal(fixture.commands.length, 1);
    assert.doesNotMatch(fixture.commands[0], /Registrar=|dotnet clean|UseInterpreter|MtouchLink/);
    assert.equal(fixture.state.size, 0);
    const properties = fixture.iosFastBuildProps('/tmp/Test.csproj', 'Debug', 'simulator');
    assert.doesNotMatch(properties.join(' '), /Registrar=|UseInterpreter|MtouchLink/);
});

test('Debug uses the same registrar preparation and retains Mono debug support', async () => {
    const fixture = harness(Array.from({ length: 2 }, () => ({ success: true, durationMs: 100 })));
    const platform = { name: 'iOS', framework: 'net10.0-ios' };
    const result = await fixture.buildForDebug('/tmp/Test.csproj', platform, 'Debug', 'physical', token);
    assert.equal(result.success, true);
    assert.match(fixture.commands[0], /dotnet clean/);
    assert.match(fixture.commands[1], /-p:MtouchDebug=true/);
    assert.match(fixture.commands[1], /-p:Registrar=dynamic/);

    const simulator = harness([{ success: true, durationMs: 100 }]);
    await simulator.buildForDebug('/tmp/Test.csproj', platform, 'Debug', 'simulator', token);
    assert.equal(simulator.commands.length, 1);
    assert.doesNotMatch(simulator.commands[0], /Registrar=|dotnet clean/);
});

test('registrar setting is enabled by default and documents the crash fallback', () => {
    const manifest = require('../package.json');
    const setting = manifest.contributes.configuration.properties['mauideploy.ios.useDynamicRegistrar'];
    assert.equal(setting.default, true);
    assert.equal(setting.scope, 'resource');
    assert.match(setting.description, /off if the app crashes/);
});

test('iOS Run and Debug skip compatibility analyzers only in Debug and allow opt-out', async () => {
    const manifest = require('../package.json');
    const setting = manifest.contributes.configuration.properties['mauideploy.ios.skipCompatibilityAnalyzers'];
    assert.equal(setting.default, true);
    assert.equal(setting.scope, 'resource');
    const platform = { name: 'iOS', framework: 'net10.0-ios' };
    for (const deviceType of ['physical', 'simulator']) {
        for (const config of ['Debug', 'Release']) {
            for (const enabled of [undefined, false]) {
                for (const action of ['Run', 'Debug']) {
                    const fixture = harness(Array.from({ length: 4 }, () => ({ success: true, durationMs: 100 })));
                    fixture.settings['ios.skipCompatibilityAnalyzers'] = enabled;
                    if (action === 'Debug') {
                        await fixture.buildForDebug('/tmp/Test.csproj', platform, config, deviceType, token);
                    } else {
                        const build = deviceType === 'physical' ? fixture.buildAndDeployIosDevice : fixture.buildAndDeployIos;
                        await build('/tmp/Test.csproj', platform, { ...device, type: deviceType }, config, token);
                    }
                    const command = fixture.commands.find(command => command.includes('dotnet build'));
                    assert.ok(command);
                    const shouldSkip = config === 'Debug' && enabled !== false;
                    const context = `${action} ${config} ${deviceType} skip=${enabled}`;
                    assert.equal(command.includes('-p:EnableTrimAnalyzer=false'), shouldSkip, context);
                    assert.equal(command.includes('-p:EnableSingleFileAnalyzer=false'), shouldSkip, context);
                    assert.doesNotMatch(command, /RunAnalyzers=false|RunAnalyzersDuringBuild=false/);
                }
            }
        }
    }
});