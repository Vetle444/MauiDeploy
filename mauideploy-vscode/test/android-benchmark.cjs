const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { androidDeploymentTargets, androidPhaseTimings } = require('../out/androidBuild');

const [projectArgument, deviceId, mode, directoryArgument] = process.argv.slice(2);
if (!projectArgument || !deviceId || !['legacy', 'arm64', 'fast', 'finish'].includes(mode) || !directoryArgument) {
    throw new Error('Usage: node test/android-benchmark.cjs <project> <device> legacy|arm64|fast|finish <results-directory>');
}
const project = path.resolve(projectArgument);
const directory = path.resolve(directoryArgument);
const cwd = path.dirname(project);
const framework = 'net10.0-android';
const packageId = 'com.dipsas.arenamobil.dips';
const hotReloadDirectory = path.join(os.tmpdir(), 'mauideploy-hotreload');
const probePath = path.join(directory, 'BenchmarkProbe.cs');
const targetsPath = path.join(directory, 'benchmark.targets');
const importsPath = path.join(directory, 'imports.targets');
const timingPath = path.join(directory, 'timing.txt');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

function xml(value) {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function writeIfChanged(file, content) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) { fs.writeFileSync(file, content); }
}

writeIfChanged(targetsPath, androidDeploymentTargets().replace('</Project>', `
  <ItemGroup Condition="'$(MSBuildProjectFullPath)' == '${xml(project)}' and '$(MauiDeployBenchmarkProbe)' == 'true'">
    <Compile Include="${xml(probePath)}" />
  </ItemGroup>
</Project>`));
writeIfChanged(importsPath, `<Project>
    <Import Project="${xml(path.join(hotReloadDirectory, 'MauiDeploy.HotReloadAgent.targets'))}" />
    <Import Project="${xml(targetsPath)}" Condition="'$(MSBuildProjectFullPath)' == '${xml(project)}'" />
</Project>`);

function execute(command, args, label) {
    const logfile = path.join(directory, `${mode}-${label}.log`);
    const descriptor = fs.openSync(logfile, 'w', 0o600);
    const started = Date.now();
    let result;
    try {
        result = spawnSync(command, args, { cwd, stdio: ['ignore', descriptor, descriptor], timeout: 1200000 });
    } finally {
        fs.closeSync(descriptor);
    }
    const elapsed = Date.now() - started;
    if (result.error || result.status !== 0) {
        console.error(JSON.stringify({ mode, label, exitCode: result.status, error: result.error?.message, logfile }));
        process.exit(1);
    }
    return elapsed;
}

function apkFile() {
    const output = path.join(cwd, 'bin', 'Debug', framework);
    const candidates = mode === 'legacy' ? [output] : [path.join(output, 'android-arm64'), output];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) { continue; }
        const signed = fs.readdirSync(candidate).filter(name => name.endsWith('-Signed.apk'));
        if (signed.length === 1) { return path.join(candidate, signed[0]); }
    }
    throw new Error('No unambiguous signed APK found');
}

function sample(kind, index) {
    const label = `${kind}-${index}`;
    if (kind === 'changed' || kind === 'warmup') {
        fs.writeFileSync(probePath, `namespace MauiDeployBenchmark; internal static class Probe { internal static int Value => ${Date.now() % 1000000000}; }\n`);
    }
    execute('adb', ['-s', deviceId, 'shell', 'am', 'force-stop', packageId], `${label}-stop`);
    fs.rmSync(timingPath, { force: true });
    const args = ['build', project, '-f', framework, '-c', 'Debug',
        '-p:RunAOTCompilation=false', '-p:PublishTrimmed=false', '-p:AndroidLinkMode=None',
        '-p:AndroidEnableProfiledAot=false', '-p:AndroidPackageFormat=apk',
        '-p:AndroidUseAssemblyStore=false', '-p:AndroidEnableAssemblyCompression=false',
        '-p:EnableMauiXamlDiagnostics=true', '-p:MauiXamlLineInfo=true',
        `-p:CustomAfterMicrosoftCommonTargets=${importsPath}`,
        `-p:MauiDeployHotReloadAgentSource=${path.join(hotReloadDirectory, 'MauiDeploy.HotReloadAgent.g.cs')}`,
        `-p:MauiDeployHotReloadTargetProject=${project}`,
        `-p:MauiDeployTimingFile=${timingPath}`,
        `-p:MauiDeployBenchmarkProbe=${mode !== 'finish'}`,
        `-p:EmbedAssembliesIntoApk=${mode !== 'fast' && mode !== 'finish'}`,
        `-flp:logfile=${path.join(directory, `${mode}-${label}.msbuild.log`)};verbosity=detailed`, '-v:quiet'];
    if (mode === 'legacy') {
        if (kind !== 'warmup') { args.push('--no-restore'); }
    } else {
        args.push('-r', 'android-arm64', '-t:Install', `-p:AdbTarget=-s ${deviceId}`, '-p:AndroidPreserveUserData=true');
    }
    const started = Date.now();
    const buildInstallMs = execute('dotnet', args, label);
    const finished = Date.now();
    const apk = apkFile();
    let buildMs;
    let deployMs;
    if (mode === 'legacy') {
        buildMs = buildInstallMs;
        deployMs = execute('adb', ['-s', deviceId, 'install', '-r', apk], `${label}-install`);
    } else if (fs.existsSync(timingPath)) {
        const timings = androidPhaseTimings(started, finished, fs.readFileSync(timingPath, 'utf8'));
        buildMs = timings?.buildMs;
        deployMs = timings?.deployMs;
    }
    const measurement = { mode, kind, index, buildMs, deployMs,
        totalMs: mode === 'legacy' ? buildMs + deployMs : buildInstallMs,
        apkBytes: fs.statSync(apk).size };
    fs.appendFileSync(path.join(directory, 'results.ndjson'), JSON.stringify(measurement) + '\n');
    console.log(JSON.stringify(measurement));
}

if (mode === 'finish') {
    sample('cleanup', 1);
} else {
    sample('warmup', 0);
    for (let index = 1; index <= 3; index++) { sample('unchanged', index); }
    for (let index = 1; index <= 3; index++) { sample('changed', index); }
}