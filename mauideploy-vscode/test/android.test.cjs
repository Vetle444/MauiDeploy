const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { androidBuildProperties, androidDeploymentTargets, androidPhaseTimings } = require('../out/androidBuild');

const actualExecFile = childProcess.execFile;
let adbResult;
let adbArguments;
const fakeExecFile = () => {};
fakeExecFile[promisify.custom] = async (command, args, options) => {
    assert.equal(command, 'adb');
    assert.equal(options.timeout, 5000);
    adbArguments = args;
    if (adbResult instanceof Error) { throw adbResult; }
    return { stdout: adbResult };
};
childProcess.execFile = fakeExecFile;
const { getAndroidRuntimeIdentifier, findAndroidApk } = require('../out/devices');
childProcess.execFile = actualExecFile;

test('device ABI selects the correct RID, with safe fallback on unknown/offline devices', async () => {
    for (const [abi, expected] of [
        ['arm64-v8a\n', 'android-arm64'], ['armeabi-v7a', 'android-arm'],
        ['x86_64', 'android-x64'], ['x86', 'android-x86'], ['unknown', undefined]
    ]) {
        adbResult = abi;
        assert.equal(await getAndroidRuntimeIdentifier('selected-device'), expected);
        assert.deepEqual(adbArguments, ['-s', 'selected-device', 'shell', 'getprop', 'ro.product.cpu.abi']);
    }
    adbResult = new Error('offline');
    assert.equal(await getAndroidRuntimeIdentifier('selected-device'), undefined);
});

test('APK selection prefers signed output for selected RID and never another RID', context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-apk-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'App.csproj');
    const output = path.join(directory, 'bin', 'Debug', 'net10.0-android');
    fs.mkdirSync(path.join(output, 'android-x64'), { recursive: true });
    fs.writeFileSync(path.join(output, 'android-x64', 'App-Signed.apk'), 'x64');
    assert.equal(findAndroidApk(project, 'net10.0-android', 'Debug', 'android-arm64'), undefined);
    fs.writeFileSync(path.join(output, 'App-Signed.apk'), 'legacy');
    assert.equal(findAndroidApk(project, 'net10.0-android', 'Debug', 'android-arm64'), path.join(output, 'App-Signed.apk'));
    fs.mkdirSync(path.join(output, 'android-arm64'));
    fs.writeFileSync(path.join(output, 'android-arm64', 'App.apk'), 'unsigned');
    fs.writeFileSync(path.join(output, 'android-arm64', 'App-Signed.apk'), 'signed');
    assert.equal(findAndroidApk(project, 'net10.0-android', 'Debug', 'android-arm64'), path.join(output, 'android-arm64', 'App-Signed.apk'));
});

test('Debug uses selected architecture and Fast Deployment, with explicit full APK fallback', () => {
    const options = { framework: 'net10.0-android', configuration: 'Debug', runtimeIdentifier: 'android-arm64', fastDeployment: true, forceReinstall: false };
    assert.deepEqual(androidBuildProperties(options), ['-p:AndroidPreserveUserData=true', '-r android-arm64', '-p:EmbedAssembliesIntoApk=false']);
    const full = androidBuildProperties({ ...options, fastDeployment: false, forceReinstall: true });
    assert.ok(full.includes('-p:EmbedAssembliesIntoApk=true'));
    assert.ok(full.includes('-p:MauiDeployForceReinstall=true'));
    assert.ok(full.includes('-p:_ReInstall=true'));
    assert.ok(!androidBuildProperties({ ...options, runtimeIdentifier: undefined }).some(property => property.startsWith('-r')));
});

test('Release leaves architecture and assembly embedding to the project', () => {
    assert.deepEqual(androidBuildProperties({ configuration: 'Release', runtimeIdentifier: 'android-x64', fastDeployment: true, forceReinstall: false }), ['-p:AndroidPreserveUserData=true']);
});

test('compatibility analysis is skipped by default in settings and only affects Debug', () => {
    const manifest = require('../package.json');
    const defaultValue = manifest.contributes.configuration.properties['mauideploy.android.skipCompatibilityAnalyzers'].default;
    assert.equal(defaultValue, true);
    const options = { framework: 'net10.0-android', configuration: 'Debug', fastDeployment: true, forceReinstall: false };
    const baseline = androidBuildProperties(options);
    assert.deepEqual(androidBuildProperties({ ...options, skipCompatibilityAnalyzers: false }), baseline);
    assert.deepEqual(androidBuildProperties({ ...options, skipCompatibilityAnalyzers: defaultValue }), [
        ...baseline, '-p:EnableTrimAnalyzer=false', '-p:EnableSingleFileAnalyzer=false'
    ]);
    assert.deepEqual(androidBuildProperties({ ...options, configuration: 'Release', skipCompatibilityAnalyzers: true }), ['-p:AndroidPreserveUserData=true']);
});

test('timings preserve tick precision and reject absent, malformed or reversed phases', () => {
    const started = 1788912000000;
    const ticks = milliseconds => (BigInt(milliseconds) + 62135596800000n) * 10000n;
    const content = `deployStart=${ticks(started + 200)}\ndeployEnd=${ticks(started + 350)}\n`;
    assert.deepEqual(androidPhaseTimings(started, started + 400, content), { buildMs: 200, deployMs: 150 });
    for (const invalid of ['', 'deployStart=bad', `deployStart=${ticks(started + 400)}\ndeployEnd=${ticks(started + 300)}`]) {
        assert.equal(androidPhaseTimings(started, started + 500, invalid), undefined);
    }
});

test('MSBuild hooks time upload, force a stale upload flag to be removed, and block bin compilation', context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-msbuild-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'android.targets'), androidDeploymentTargets());
    const fixture = path.join(directory, 'fixture.proj');
    const flag = path.join(directory, 'upload.flag');
    const timing = path.join(directory, 'timing.txt');
    fs.writeFileSync(fixture, `<Project>
      <Import Project="android.targets" />
      <PropertyGroup><_UploadFlag>${flag}</_UploadFlag></PropertyGroup>
      <Target Name="_GetUploadInputs" />
      <Target Name="_Upload" DependsOnTargets="_GetUploadInputs">
        <Error Condition="Exists('$(_UploadFlag)')" Text="Stale upload flag survived force reinstall" />
      </Target>
      <Target Name="CoreCompile" />
    </Project>`);
    fs.writeFileSync(flag, 'cached');
    const started = Date.now();
    const output = childProcess.spawnSync('dotnet', ['msbuild', fixture, '-nologo', '-t:_Upload', '-p:MauiDeployForceReinstall=true', `-p:MauiDeployTimingFile=${timing}`], { encoding: 'utf8' });
    assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.ok(androidPhaseTimings(started, Date.now(), fs.readFileSync(timing, 'utf8')));
    assert.equal(fs.existsSync(flag), false);
    const blocked = childProcess.spawnSync('dotnet', ['msbuild', fixture, '-nologo', '-t:CoreCompile', '-p:MauiDeployFromBin=true'], { encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout, /Existing Android build output is incomplete/);
});

test('installed Android SDK evaluates single-RID Fast Deployment and imports the deployment hooks', context => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mauideploy-sdk-test-'));
        context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        fs.writeFileSync(path.join(directory, 'android.targets'), androidDeploymentTargets());
        const fixture = path.join(directory, 'App.csproj');
        fs.writeFileSync(fixture, `<Project Sdk="Microsoft.NET.Sdk">
            <PropertyGroup>
                <TargetFramework>net10.0-android</TargetFramework>
                <OutputType>Exe</OutputType>
                <CustomAfterMicrosoftCommonTargets>${path.join(directory, 'android.targets')}</CustomAfterMicrosoftCommonTargets>
            </PropertyGroup>
        </Project>`);
        const output = childProcess.spawnSync('dotnet', ['msbuild', fixture, '-nologo',
                '-p:Configuration=Debug', '-p:RuntimeIdentifier=android-arm64', '-p:EmbedAssembliesIntoApk=false',
                '-getProperty:RuntimeIdentifier,RuntimeIdentifiers,EmbedAssembliesIntoApk,InstallDependsOnTargets'], { encoding: 'utf8' });
        assert.equal(output.status, 0, output.stdout + output.stderr);
        const properties = JSON.parse(output.stdout).Properties;
        assert.equal(properties.RuntimeIdentifier, 'android-arm64');
        assert.equal(properties.RuntimeIdentifiers, '');
        assert.equal(properties.EmbedAssembliesIntoApk.toLowerCase(), 'false');
        assert.match(properties.InstallDependsOnTargets, /SignAndroidPackage/);
        assert.match(properties.InstallDependsOnTargets, /_Upload/);
});