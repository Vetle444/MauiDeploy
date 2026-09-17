const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');

function terminalHarness(context, shell = '/bin/sh') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-terminal-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.resolve(__dirname, '../out/deployer.js');
    const localRequire = createRequire(filename);
    const messages = [];
    const commands = [];
    const terminalOutput = [];
    const terminal = {
        sendText: command => {
            const result = spawnSync(shell, ['-f', '-c', command], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            terminalOutput.push(result.stdout + result.stderr);
        }
    };
    const sandbox = {
        exports: {}, process,
        captureCommand: command => commands.push(command),
        require: name => {
            if (name === 'vscode') {
                return {
                    window: {
                        createOutputChannel: () => ({ clear() {}, show() {}, appendLine: line => messages.push(line) }),
                        showErrorMessage: async message => { messages.push(message); }
                    },
                    workspace: {}
                };
            }
            if (name === 'os') { return { ...os, tmpdir: () => directory }; }
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
        waitForExitCodeFile = async filename => Number.parseInt(readTextFile(filename), 10);
        const executeCommand = runTerminalCommand;
        runTerminalCommand = async (...args) => {
            captureCommand(args[1]);
            return executeCommand(...args);
        };
        exports.testApi = { runTerminalCommand, restoreAndCleanProject, createCopilotRepairPrompt, getFailure: () => lastBuildFailure };
    `, sandbox, { filename });
    return { ...sandbox.exports.testApi, directory, terminal, messages, commands, terminalOutput };
}

test('command failure preserves stdout, stderr and exit code without an MSBuild error log', async context => {
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(filename => fs.existsSync(filename))) {
        for (const logContent of [undefined, null, '', ' \n']) {
            const fixture = terminalHarness(context, shell);
            const errorLogFile = logContent === undefined ? undefined : path.join(fixture.directory, 'errors.log');
            if (typeof logContent === 'string') { fs.writeFileSync(errorLogFile, logContent); }
            const command = "printf 'restore stdout\\n'; printf 'error NETSDK1047: Missing selected target\\n' >&2; false";
            const result = await fixture.runTerminalCommand(fixture.terminal, command, 1000, errorLogFile);
            assert.equal(result.success, false);
            assert.equal(result.cancelled, false);
            const failure = fixture.getFailure();
            assert.equal(failure.exitCode, 1);
            assert.equal(failure.command, command);
            assert.match(failure.output, /restore stdout/);
            assert.match(failure.output, /error NETSDK1047: Missing selected target/);
            assert.equal(failure.errors.length, 1);
            assert.match(fixture.createCopilotRepairPrompt(failure), /restore stdout/);
            assert.ok(fixture.messages.some(message => message.includes('NETSDK1047')));
            assert.match(fixture.terminalOutput.join(''), /restore stdout/);
            assert.match(fixture.terminalOutput.join(''), /NETSDK1047/);
            assert.deepEqual(fs.readdirSync(fixture.directory).filter(filename => filename.startsWith('mauideploy-')), []);
        }
    }
});

test('non-compiler command failures show captured output in Build Errors and the repair prompt', async context => {
    const fixture = terminalHarness(context);
    await fixture.runTerminalCommand(fixture.terminal, "printf 'Unable to open NuGet settings\\n' >&2; false", 1000);
    assert.ok(fixture.messages.some(message => message.includes('Unable to open NuGet settings')));
    assert.match(fixture.createCopilotRepairPrompt(fixture.getFailure()), /Unable to open NuGet settings/);
});

test('a populated MSBuild error log remains the preferred failure output', async context => {
    const fixture = terminalHarness(context);
    const errorLogFile = path.join(fixture.directory, 'errors.log');
    const error = 'error NU1301: Cannot load package source\n';
    fs.writeFileSync(errorLogFile, error);
    await fixture.runTerminalCommand(fixture.terminal, "printf 'console output\\n'; false", 1000, errorLogFile);
    assert.equal(fixture.getFailure().output, error);
});

test('command capture preserves success, nonzero exit codes and cancellation', async context => {
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(filename => fs.existsSync(filename))) {
        for (const exitCode of [0, 7, 130]) {
            const fixture = terminalHarness(context, shell);
            const result = await fixture.runTerminalCommand(fixture.terminal,
                `command_result() { return ${exitCode}; }; command_result`, 1000);
            assert.equal(result.success, exitCode === 0);
            assert.equal(result.cancelled, exitCode === 130);
            if (exitCode === 7) {
                assert.equal(fixture.getFailure().exitCode, exitCode);
            } else {
                assert.equal(fixture.getFailure(), undefined);
            }
        }
    }
});

test('restore before clean refreshes project-reference assets across iOS RID and Test configuration changes', async context => {
    const fixture = terminalHarness(context);
    const project = path.join(fixture.directory, 'App With Spaces', 'App.csproj');
    const reference = path.join(fixture.directory, 'Shared', 'Shared.csproj');
    const projectFiles = [project, reference];
    for (const projectFile of projectFiles) {
        fs.mkdirSync(path.dirname(projectFile));
        const referenceItem = projectFile === project
            ? '<ItemGroup><ProjectReference Include="../Shared/Shared.csproj" /></ItemGroup>'
            : '';
        fs.writeFileSync(projectFile, `<Project Sdk="Microsoft.NET.Sdk">
            <PropertyGroup>
                <TargetFrameworks>net10.0-ios</TargetFrameworks>
                <TargetFrameworks Condition="'$(Configuration)' == 'Test'">net10.0</TargetFrameworks>
            </PropertyGroup>
            ${referenceItem}
        </Project>`);
    }
    const targetsFor = projectFile => Object.keys(JSON.parse(fs.readFileSync(
        path.join(path.dirname(projectFile), 'obj', 'project.assets.json'), 'utf8')).targets);
    for (const [previousConfig, previousRuntime, runtimeIdentifier] of [
        ['Debug', 'iossimulator-arm64', 'ios-arm64'],
        ['Debug', 'ios-arm64', 'iossimulator-arm64'],
        ['Test', undefined, 'ios-arm64'],
        ['Test', undefined, 'iossimulator-arm64']
    ]) {
        const restoreArgs = ['restore', project, `-p:Configuration=${previousConfig}`];
        if (previousRuntime) { restoreArgs.push('-r', previousRuntime, '-p:TargetFramework=net10.0-ios'); }
        const previousRestore = spawnSync('dotnet', restoreArgs, { encoding: 'utf8' });
        assert.equal(previousRestore.status, 0, previousRestore.stdout + previousRestore.stderr);
        for (const projectFile of projectFiles) {
            const targets = targetsFor(projectFile);
            assert.ok(!targets.some(target => target.endsWith(`/${runtimeIdentifier}`)), JSON.stringify(targets));
            if (previousConfig === 'Test') { assert.deepEqual(targets, ['net10.0']); }
        }

        const commandCount = fixture.commands.length;
        const result = await fixture.restoreAndCleanProject(fixture.terminal, project, 'net10.0-ios', 'Debug',
            runtimeIdentifier, ['-p:EnableTrimAnalyzer=false', '-p:EnableSingleFileAnalyzer=false'], 120000);
        assert.equal(result.success, true, fixture.messages.join('\n'));
        assert.equal(fixture.commands.length, commandCount + 2);
        assert.match(fixture.commands[commandCount], /^dotnet restore/);
        assert.match(fixture.commands[commandCount + 1], /^dotnet clean/);
        for (const projectFile of projectFiles) {
            const targets = targetsFor(projectFile);
            assert.ok(targets.some(target => target.startsWith('net10.0-ios') && target.endsWith(`/${runtimeIdentifier}`)), JSON.stringify(targets));
        }
    }
});

test('iOS Run, Debug and build-only restore even when recent assets contain only the other RID or Test target', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-ios-restore-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'App.csproj');
    fs.writeFileSync(project, '<Project />');
    fs.mkdirSync(path.join(directory, 'obj'));
    const assetsFile = path.join(directory, 'obj', 'project.assets.json');
    const compiledFile = path.resolve(__dirname, '../out/deployer.js');
    const compiledRequire = createRequire(compiledFile);
    const commands = [];
    const sandbox = {
        process,
        exports: {},
        require: name => name === 'vscode' ? {
            window: {
                createTerminal: () => ({ show() {}, dispose() {} }),
                createOutputChannel: () => ({ appendLine() {} })
            },
            workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) },
            Uri: { file: value => value },
            ThemeIcon: class {}
        } : compiledRequire(name),
        captureCommand: command => {
            commands.push(command);
            return { success: false, durationMs: 0 };
        }
    };
    vm.runInNewContext(fs.readFileSync(compiledFile, 'utf8') + `
        sharedBuildProps = () => '';
        runTerminalCommand = async () => ({ success: true, durationMs: 0 });
        runBuildCommand = async (terminal, factory) => captureCommand(factory(''));
    `, sandbox, { filename: compiledFile });
    const platform = { name: 'iOS', framework: 'net10.0-ios', display: 'iOS' };
    for (const [type, restoredTarget] of [
        ['physical', 'net10.0-ios26.4/iossimulator-arm64'],
        ['simulator', 'net10.0-ios26.4/ios-arm64'],
        ['physical', 'net10.0'],
        ['simulator', 'net10.0']
    ]) {
        fs.writeFileSync(assetsFile, JSON.stringify({ targets: { [restoredTarget]: {} } }));
        const future = new Date(Date.now() + 60000);
        fs.utimesSync(assetsFile, future, future);
        await sandbox.exports.buildAndDeploy(project, platform, { id: 'device', platform: 'iOS', type }, 'Debug');
        await sandbox.exports.buildForDebug(project, platform, 'Debug', type);
        await sandbox.exports.buildOnly(project, platform, 'Debug');
    }
    assert.equal(commands.length, 12);
    for (const command of commands) {
        assert.match(command, /dotnet build/);
        assert.match(command, /-f net10\.0-ios/);
        assert.match(command, /-c Debug/);
        assert.doesNotMatch(command, /--no-restore/);
    }
    assert.match(commands[0], /-r ios-arm64/);
    assert.match(commands[1], /-r ios-arm64/);
});