import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Platform, Device, findIosAppBundle, findAndroidApk, getAndroidPackageId, getBundleId } from './devices';

export const DEFAULT_XAML_HOT_RELOAD_PORT = 55438;

const defaultBuildTerminalName = 'MAUI Deploy — Build';
const buildTerminals = new Map<string, vscode.Terminal>();
let logTerminal: vscode.Terminal | undefined;
let buildErrorsOutput: vscode.OutputChannel | undefined;

interface BuildFailureContext {
    command: string;
    exitCode: number | undefined;
    errors: string[];
    output: string;
    failedAt: Date;
}

let lastBuildFailure: BuildFailureContext | undefined;

function getBuildTerminal(fresh = true, name = defaultBuildTerminalName): vscode.Terminal {
    const existing = buildTerminals.get(name);
    if (fresh && existing && !existing.exitStatus) {
        existing.dispose();
        buildTerminals.delete(name);
    }
    const current = buildTerminals.get(name);
    if (current && !current.exitStatus) { return current; }
    const terminal = vscode.window.createTerminal({
        name,
        iconPath: new vscode.ThemeIcon('rocket')
    });
    buildTerminals.set(name, terminal);
    return terminal;
}

function getLogTerminal(): vscode.Terminal {
    if (logTerminal && !logTerminal.exitStatus) { logTerminal.dispose(); }
    logTerminal = vscode.window.createTerminal({
        name: 'MAUI Deploy — Logs',
        iconPath: new vscode.ThemeIcon('output')
    });
    return logTerminal;
}

function getBuildErrorsOutput(): vscode.OutputChannel {
    buildErrorsOutput ??= vscode.window.createOutputChannel('MAUI Deploy — Build Errors');
    return buildErrorsOutput;
}

export async function buildAndDeploy(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    terminalName?: string
): Promise<BuildResult> {
    if (platform.name === 'iOS') {
        return device.type === 'physical'
            ? buildAndDeployIosDevice(projectPath, platform, device, config, token, onProgress, terminalName)
            : buildAndDeployIos(projectPath, platform, device, config, token, onProgress, terminalName);
    }
    return buildAndDeployAndroid(projectPath, platform, device, config, token, onProgress, terminalName);
}

export async function deployFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    terminalName?: string
): Promise<boolean> {
    if (platform.name === 'iOS') {
        return device.type === 'physical'
            ? launchIosDeviceFromBin(projectPath, platform, device, config, terminalName)
            : launchIosSimulatorFromBin(projectPath, platform, device, config, terminalName);
    }
    return launchAndroidFromBin(projectPath, platform, device, config, terminalName);
}

async function buildAndDeployIos(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    terminalName?: string
): Promise<BuildResult> {
    const terminal = getBuildTerminal(true, terminalName);
    terminal.show();

    const shared = sharedBuildProps(projectPath);
    const noRestore = restoreFlag(projectPath);
    const result = await runBuildCommand(terminal, logArgs => {
        const buildCmd = `dotnet build ${noRestore} "${projectPath}" -f ${platform.framework} -c ${config} ${shared} ${logArgs}`;
        return `echo '▶ Building...' && ${buildCmd}`;
    }, 600_000, token, onProgress);
    if (!result.success) {
        return result;
    }

    const appPath = findIosAppBundle(projectPath, platform.framework, config, 'simulator');
    if (!appPath) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not find .app bundle.');
        return result;
    }

    await launchIosSimulatorApp(terminal, appPath, device);
    return result;
}

async function launchIosSimulatorFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    terminalName?: string
): Promise<boolean> {
    const terminal = getBuildTerminal(true, terminalName);
    terminal.show();

    const appPath = findIosAppBundle(projectPath, platform.framework, config, 'simulator');
    if (!appPath) {
        vscode.window.showErrorMessage(`MAUI Deploy: Could not find a ${config} .app bundle in bin/${config}/${platform.framework}. Build the app first.`);
        return false;
    }

    return launchIosSimulatorApp(terminal, appPath, device);
}

async function launchIosSimulatorApp(
    terminal: vscode.Terminal,
    appPath: string,
    device: Device
): Promise<boolean> {
    const bundleId = await getBundleId(appPath);
    if (!bundleId) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not determine bundle ID.');
        return false;
    }

    sendSilent(terminal,
        `xcrun simctl terminate ${device.id} ${bundleId} 2>/dev/null; ` +
        `xcrun simctl uninstall ${device.id} ${bundleId} 2>/dev/null; ` +
        `echo '▶ Installing...' && xcrun simctl install ${device.id} "${appPath}" && ` +
        `echo '▶ Launching...' && for i in 1 2 3 4 5; do xcrun simctl launch ${device.id} ${bundleId} 2>/dev/null && break; echo "  Retry $i..."; sleep 2; done`
    );

    return true;
}

async function buildAndDeployIosDevice(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    terminalName?: string
): Promise<BuildResult> {
    const terminal = getBuildTerminal(true, terminalName);
    terminal.show();

    // Build for physical device (needs RuntimeIdentifier ios-arm64)
    const shared = sharedBuildProps(projectPath);
    const noRestore = restoreFlag(projectPath);
    const fastProps = iosFastBuildProps(config, 'physical').join(' ');
    const result = await runBuildCommand(terminal, logArgs => {
        const buildCmd = `dotnet build ${noRestore} "${projectPath}" -f ${platform.framework} -c ${config} -r ios-arm64 ${fastProps} ${shared} ${logArgs}`;
        return `echo '▶ Building for device...' && ${buildCmd}`;
    }, 600_000, token, onProgress);
    if (!result.success) {
        return result;
    }

    const appPath = findIosAppBundle(projectPath, platform.framework, config, 'physical');
    if (!appPath) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not find .app bundle.');
        return result;
    }

    await launchIosDeviceApp(terminal, appPath, device);
    return result;
}

async function launchIosDeviceFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    terminalName?: string
): Promise<boolean> {
    const terminal = getBuildTerminal(true, terminalName);
    terminal.show();

    const appPath = findIosAppBundle(projectPath, platform.framework, config, 'physical');
    if (!appPath) {
        vscode.window.showErrorMessage(`MAUI Deploy: Could not find a ${config} .app bundle in bin/${config}/${platform.framework}. Build the app first.`);
        return false;
    }

    return launchIosDeviceApp(terminal, appPath, device);
}

async function launchIosDeviceApp(
    terminal: vscode.Terminal,
    appPath: string,
    device: Device
): Promise<boolean> {
    const bundleId = await getBundleId(appPath);
    if (!bundleId) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not determine bundle ID.');
        return false;
    }

    // Install via devicectl
    sendSilent(terminal,
        `echo '▶ Installing on device...' && xcrun devicectl device install app --device ${device.id} "${appPath}"`
    );

    // Launch via devicectl
    sendSilent(terminal,
        `echo '▶ Launching...' && xcrun devicectl device process launch --device ${device.id} ${bundleId}`
    );

    return true;
}

async function buildAndDeployAndroid(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    terminalName?: string
): Promise<BuildResult> {
    const terminal = getBuildTerminal(true, terminalName);
    terminal.show();

    return runBuildCommand(terminal, logArgs => {
        const shared = sharedBuildProps(projectPath);
        const noRestore = restoreFlag(projectPath);
        const buildCmd = [
            `dotnet build ${noRestore} "${projectPath}"`,
            `-t:Run`,
            `-f ${platform.framework}`,
            `-c ${config}`,
            `/p:AdbTarget="-s ${device.id}"`,
            shared,
            ...androidFastBuildProps(config),
            logArgs
        ].join(' ');
        return `echo '▶ Building & deploying...' && ${buildCmd}`;
    }, 600_000, token, onProgress);
}

async function launchAndroidFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string,
    terminalName?: string
): Promise<boolean> {
    const terminal = getBuildTerminal(true, terminalName);
    terminal.show();

    const apkPath = findAndroidApk(projectPath, platform.framework, config);
    if (!apkPath) {
        vscode.window.showErrorMessage(`MAUI Deploy: Could not find a ${config} APK in bin/${config}/${platform.framework}. Build the app first.`);
        return false;
    }

    const packageId = getAndroidPackageId(projectPath);
    if (!packageId) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not determine Android package ID. Add <ApplicationId> to the project file.');
        return false;
    }

    sendSilent(terminal,
        `echo '▶ Installing APK...' && adb -s ${device.id} install -r "${apkPath}" && ` +
        `echo '▶ Launching...' && adb -s ${device.id} shell monkey -p ${packageId} 1`
    );

    return true;
}

export async function buildOnly(
    projectPath: string,
    platform: Platform,
    config: string
): Promise<BuildResult> {
    const terminal = getBuildTerminal();
    terminal.show();

    return runBuildCommand(terminal, logArgs => {
        const buildCmd = `dotnet build ${restoreFlag(projectPath)} "${projectPath}" -f ${platform.framework} -c ${config} ${logArgs}`;
        return `echo '▶ Pre-building for debug...' && ${buildCmd} && echo '✅ BUILD_DONE'`;
    });
}

export async function runTests(
    targetPath: string,
    config: string,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void
): Promise<BuildResult> {
    const terminal = getBuildTerminal();
    terminal.show();

    const testCmd = `dotnet test "${targetPath}" -c ${config}`;
    return runTerminalCommand(
        terminal,
        `echo '▶ Running tests...' && ${testCmd}`,
        1_200_000,
        undefined,
        showTestFailure,
        token,
        onProgress
    );
}

/** Shared props for all builds: injects hot reload agent + XAML diagnostics.
 *  Keeping these consistent between Run and Debug ensures CoreCompile
 *  can skip when switching modes (same Compile items, same intermediate assembly).
 *  Note: we do NOT force MauiXamlInflator=SourceGen — the project's own setting
 *  is respected. We only enable diagnostics so the source gen (if active) emits
 *  the ResourceProvider2 preamble in InitializeComponent. */
function sharedBuildProps(projectPath: string, hotReloadPort = DEFAULT_XAML_HOT_RELOAD_PORT): string {
    const hotReloadAgent = createHotReloadAgentFiles(hotReloadPort);
    const targetProjectPath = path.resolve(projectPath);
    return [
        shellQuote(`-p:CustomAfterMicrosoftCommonTargets=${hotReloadAgent.targetsPath}`),
        shellQuote(`-p:MauiDeployHotReloadAgentSource=${hotReloadAgent.sourcePath}`),
        shellQuote(`-p:MauiDeployHotReloadTargetProject=${targetProjectPath}`),
        '-p:EnableMauiXamlDiagnostics=true',
        '-p:MauiXamlLineInfo=true'
    ].join(' ');
}

/** Returns '--no-restore' unless the project needs a restore (csproj or related config newer than assets file). */
function restoreFlag(projectPath: string): string {
    try {
        const projectDir = path.dirname(projectPath);
        const assetsFile = path.join(projectDir, 'obj', 'project.assets.json');
        if (!fs.existsSync(assetsFile)) { return ''; }
        const assetsMtime = fs.statSync(assetsFile).mtimeMs;

        // Check csproj and any Directory.Build/Packages/NuGet config files up the tree
        const filesToCheck = [projectPath];
        let dir: string | undefined = projectDir;
        while (dir) {
            for (const name of [
                'Directory.Build.props', 'Directory.Build.targets',
                'Directory.Packages.props', 'NuGet.config', 'nuget.config',
                'global.json',
            ]) {
                const candidate = path.join(dir, name);
                if (fs.existsSync(candidate)) { filesToCheck.push(candidate); }
            }
            // Stop at repo/solution root
            if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.sln')) || fs.existsSync(path.join(dir, '.slnx'))) { break; }
            const parent = path.dirname(dir);
            if (parent === dir) { break; }
            dir = parent;
        }

        for (const file of filesToCheck) {
            if (fs.statSync(file).mtimeMs > assetsMtime) { return ''; }
        }
    } catch { return ''; }
    return '--no-restore';
}

export async function buildForDebug(
    projectPath: string,
    platform: Platform,
    config: string,
    deviceType?: 'simulator' | 'physical',
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    hotReloadPort = DEFAULT_XAML_HOT_RELOAD_PORT
): Promise<BuildResult> {
    const terminal = getBuildTerminal(false);
    terminal.show();

    // Build with debug flags — MtouchDebug=true enables Mono SDB in iOS apps
    const extraProps = platform.name === 'iOS'
        ? `-p:MtouchDebug=true ${iosFastBuildProps(config, deviceType).join(' ')}`
        : `-p:EmbedAssembliesIntoApk=true ${androidFastBuildProps(config).join(' ')}`;

    const shared = sharedBuildProps(projectPath, hotReloadPort);
    const noRestore = restoreFlag(projectPath);
    const rid = platform.name === 'iOS' && deviceType === 'physical' ? ' -r ios-arm64' : '';
    return runBuildCommand(terminal, logArgs => {
        const buildCmd = `dotnet build ${noRestore} "${projectPath}" -f ${platform.framework} -c ${config} ${extraProps}${rid} ${shared} ${logArgs}`;
        return `echo '▶ Building for debug...' && ${buildCmd} && echo '✅ BUILD_DONE'`;
    }, 600_000, token, onProgress);
}

function createHotReloadAgentFiles(hotReloadPort: number): { sourcePath: string; targetsPath: string } {
    const directory = path.join(os.tmpdir(), 'mauideploy-hotreload');
    fs.mkdirSync(directory, { recursive: true });

    const sourcePath = path.join(directory, 'MauiDeploy.HotReloadAgent.g.cs');
    const targetsPath = path.join(directory, 'MauiDeploy.HotReloadAgent.targets');

    writeIfChanged(sourcePath, hotReloadAgentSource(hotReloadPort));
    writeIfChanged(targetsPath, hotReloadAgentTargets());

    return { sourcePath, targetsPath };
}

/** Create the dotnet-watch bridge project that connects to dotnet-watch's named pipe
 *  and forwards metadata deltas to the MAUI app's HTTP agent.
 *  Returns the project directory path. */
export function createHotReloadBridgeProject(mauiProjectPath: string, hotReloadPort = DEFAULT_XAML_HOT_RELOAD_PORT): string {
    const directory = path.join(os.tmpdir(), 'mauideploy-hotreload-bridge');
    fs.mkdirSync(directory, { recursive: true });

    const csprojPath = path.join(directory, 'MauiDeploy.HotReloadBridge.csproj');
    const programPath = path.join(directory, 'Program.cs');
    const signalPath = path.join(directory, 'bridge-ready.signal');

    // Clean up stale signal file
    try { fs.rmSync(signalPath, { force: true }); } catch { }

    writeIfChanged(csprojPath, hotReloadBridgeCsproj(mauiProjectPath));
    writeIfChanged(programPath, hotReloadBridgeSource(hotReloadPort));

    return directory;
}

function hotReloadBridgeCsproj(mauiProjectPath: string): string {
    const absProjectPath = path.resolve(mauiProjectPath);
    return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="${absProjectPath}" ReferenceOutputAssembly="false" SkipGetTargetFrameworkProperties="true" />
  </ItemGroup>
</Project>
`;
}

function hotReloadBridgeSource(hotReloadPort: number): string {
    return `// <auto-generated />
// MauiDeploy Hot Reload Bridge — connects to dotnet-watch named pipe and forwards
// metadata deltas to the MAUI app's HTTP agent.
using System;
using System.Buffers.Binary;
using System.IO;
using System.IO.Pipes;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

var pipeName = Environment.GetEnvironmentVariable("DOTNET_WATCH_HOTRELOAD_NAMEDPIPE_NAME");
if (string.IsNullOrEmpty(pipeName))
{
    Console.Error.WriteLine("[MauiDeploy Bridge] DOTNET_WATCH_HOTRELOAD_NAMEDPIPE_NAME not set. Exiting.");
    // Write signal file to unblock the extension even on failure
    File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "bridge-ready.signal"), "error:no-pipe-name");
    Thread.Sleep(Timeout.Infinite);
    return;
}

Console.WriteLine($"[MauiDeploy Bridge] Connecting to pipe: {pipeName}");

using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
try
{
    pipe.Connect(5000);
    Console.WriteLine("[MauiDeploy Bridge] Connected to dotnet-watch pipe.");
}
catch (TimeoutException)
{
    Console.Error.WriteLine("[MauiDeploy Bridge] Failed to connect to dotnet-watch pipe within 5s.");
    File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "bridge-ready.signal"), "error:pipe-timeout");
    Thread.Sleep(Timeout.Infinite);
    return;
}

// Send ClientInitializationResponse: version(byte 0) + capabilities(string)
// Query capabilities from env or use a reasonable default set
var capabilities = "Baseline AddMethodToExistingType AddStaticFieldToExistingType NewTypeDefinition ChangeCustomAttributes UpdateParameters AddExplicitInterfaceImplementation";
await WriteByteAsync(pipe, 0); // version
await WriteStringAsync(pipe, capabilities);
Console.WriteLine($"[MauiDeploy Bridge] Sent capabilities: {capabilities}");

// Write signal file so the extension knows we're ready
var signalDir = Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;
// Also try writing to the project directory (where the extension looks)
var bridgeDir = Path.GetDirectoryName(typeof(object).Assembly.Location) ?? AppContext.BaseDirectory;
// Use a well-known location
var signalPath = Path.Combine(Path.GetTempPath(), "mauideploy-hotreload-bridge", "bridge-ready.signal");
Directory.CreateDirectory(Path.GetDirectoryName(signalPath)!);
File.WriteAllText(signalPath, $"ready:{pipeName}");
Console.WriteLine($"[MauiDeploy Bridge] Signal written. Waiting for deltas...");

// Read initial updates
await ReceiveUpdatesAsync(pipe, initialPhase: true);

// Main loop: receive deltas and forward to MAUI app
await ReceiveUpdatesAsync(pipe, initialPhase: false);

Console.WriteLine("[MauiDeploy Bridge] Pipe disconnected. Exiting.");

async Task ReceiveUpdatesAsync(NamedPipeClientStream stream, bool initialPhase)
{
    using var httpClient = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:${hotReloadPort}"), Timeout = TimeSpan.FromSeconds(30) };

    while (stream.IsConnected)
    {
        var requestType = await ReadByteAsync(stream);
        switch (requestType)
        {
            case 1: // ManagedCodeUpdate
                await HandleManagedCodeUpdateAsync(stream, httpClient);
                break;
            case 2: // StaticAssetUpdate
                await SkipStaticAssetUpdateAsync(stream);
                // Send success response
                await WriteByteAsync(stream, 2); // ResponseType.UpdateResponse
                await WriteBoolAsync(stream, true);
                await WriteInt32Async(stream, 0); // 0 log entries
                break;
            case 3: // InitialUpdatesCompleted
                if (initialPhase) return;
                break;
            default:
                Console.Error.WriteLine($"[MauiDeploy Bridge] Unknown request type: {requestType}");
                return;
        }
    }
}

async Task HandleManagedCodeUpdateAsync(NamedPipeClientStream stream, HttpClient httpClient)
{
    // Read ManagedCodeUpdateRequest
    var version = await ReadByteAsync(stream);
    if (version != 4)
    {
        Console.Error.WriteLine($"[MauiDeploy Bridge] Unsupported ManagedCodeUpdate version: {version}");
        return;
    }

    var count = await ReadInt32Async(stream);
    Console.WriteLine($"[MauiDeploy Bridge] Received {count} delta(s)");

    var updates = new List<object>();
    for (var i = 0; i < count; i++)
    {
        var moduleId = await ReadGuidAsync(stream);
        var metadataDelta = await ReadByteArrayAsync(stream);
        var ilDelta = await ReadByteArrayAsync(stream);
        var pdbDelta = await ReadByteArrayAsync(stream);
        var updatedTypes = await ReadIntArrayAsync(stream);

        Console.WriteLine($"[MauiDeploy Bridge]   Delta {i}: moduleId={moduleId}, metadata={metadataDelta.Length}B, il={ilDelta.Length}B, pdb={pdbDelta.Length}B, types={updatedTypes.Length}");

        updates.Add(new
        {
            moduleId = moduleId.ToString(),
            metadataDelta = Convert.ToBase64String(metadataDelta),
            ilDelta = Convert.ToBase64String(ilDelta),
            pdbDelta = Convert.ToBase64String(pdbDelta),
            updatedTypes = updatedTypes
        });
    }

    var responseLoggingLevel = await ReadByteAsync(stream);

    // Forward to MAUI app via HTTP POST /delta
    var success = false;
    try
    {
        var payload = JsonSerializer.Serialize(new { updates });
        var content = new StringContent(payload, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync("/delta", content);
        var responseBody = await response.Content.ReadAsStringAsync();
        Console.WriteLine($"[MauiDeploy Bridge] App response: {response.StatusCode} — {responseBody}");
        success = response.IsSuccessStatusCode;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[MauiDeploy Bridge] Failed to forward deltas to app: {ex.Message}");
    }

    // Send UpdateResponse back to dotnet-watch
    await WriteByteAsync(stream, 2); // ResponseType.UpdateResponse
    await WriteBoolAsync(stream, success);
    await WriteInt32Async(stream, 0); // 0 log entries
}

async Task SkipStaticAssetUpdateAsync(NamedPipeClientStream stream)
{
    var version = await ReadByteAsync(stream);
    await ReadStringAsync(stream); // assemblyName
    await ReadBoolAsync(stream); // isApplicationProject
    await ReadStringAsync(stream); // relativePath
    await ReadByteArrayAsync(stream); // contents
    await ReadByteAsync(stream); // responseLoggingLevel
}

// ── Stream primitives (matching dotnet-watch protocol) ──

async Task WriteByteAsync(Stream s, byte value)
{
    var buf = new byte[] { value };
    await s.WriteAsync(buf);
}

async Task WriteBoolAsync(Stream s, bool value)
{
    await WriteByteAsync(s, value ? (byte)1 : (byte)0);
}

async Task WriteInt32Async(Stream s, int value)
{
    var buf = new byte[4];
    BinaryPrimitives.WriteInt32LittleEndian(buf, value);
    await s.WriteAsync(buf);
}

async Task WriteStringAsync(Stream s, string value)
{
    var bytes = Encoding.UTF8.GetBytes(value);
    await Write7BitEncodedIntAsync(s, bytes.Length);
    await s.WriteAsync(bytes);
}

async Task Write7BitEncodedIntAsync(Stream s, int value)
{
    var uValue = (uint)value;
    while (uValue > 127)
    {
        await WriteByteAsync(s, (byte)(uValue | 0x80));
        uValue >>= 7;
    }
    await WriteByteAsync(s, (byte)uValue);
}

async Task<byte> ReadByteAsync(Stream s)
{
    var buf = new byte[1];
    await s.ReadExactlyAsync(buf, 0, 1);
    return buf[0];
}

async Task<bool> ReadBoolAsync(Stream s)
{
    return await ReadByteAsync(s) != 0;
}

async Task<int> ReadInt32Async(Stream s)
{
    var buf = new byte[4];
    await s.ReadExactlyAsync(buf, 0, 4);
    return BinaryPrimitives.ReadInt32LittleEndian(buf);
}

async Task<Guid> ReadGuidAsync(Stream s)
{
    var buf = new byte[16];
    await s.ReadExactlyAsync(buf, 0, 16);
    return new Guid(buf);
}

async Task<byte[]> ReadByteArrayAsync(Stream s)
{
    var length = await ReadInt32Async(s);
    var buf = new byte[length];
    if (length > 0)
        await s.ReadExactlyAsync(buf, 0, length);
    return buf;
}

async Task<int[]> ReadIntArrayAsync(Stream s)
{
    var count = await ReadInt32Async(s);
    var result = new int[count];
    if (count > 0)
    {
        var buf = new byte[count * 4];
        await s.ReadExactlyAsync(buf, 0, buf.Length);
        for (var i = 0; i < count; i++)
            result[i] = BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(i * 4, 4));
    }
    return result;
}

async Task<string> ReadStringAsync(Stream s)
{
    var length = await Read7BitEncodedIntAsync(s);
    if (length == 0) return string.Empty;
    var buf = new byte[length];
    await s.ReadExactlyAsync(buf, 0, length);
    return Encoding.UTF8.GetString(buf);
}

async Task<int> Read7BitEncodedIntAsync(Stream s)
{
    var result = 0;
    var shift = 0;
    byte b;
    do
    {
        b = await ReadByteAsync(s);
        result |= (b & 0x7F) << shift;
        shift += 7;
    } while ((b & 0x80) != 0);
    return result;
}
`;
}

/** Only write file if content differs — preserves mtime for MSBuild incremental builds. */
function writeIfChanged(filePath: string, content: string) {
    try {
        if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
            return;
        }
    } catch { }
    fs.writeFileSync(filePath, content, 'utf8');
}

function hotReloadAgentTargets(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Project>
    <ItemGroup Condition="'$(MauiDeployHotReloadAgentSource)' != '' and '$(MSBuildProjectFullPath)' == '$(MauiDeployHotReloadTargetProject)'">
    <Compile Include="$(MauiDeployHotReloadAgentSource)" Link="MauiDeploy.HotReloadAgent.g.cs" Visible="false" />
  </ItemGroup>
</Project>
`;
}

function hotReloadAgentSource(hotReloadPort: number): string {
    return `// <auto-generated />
#nullable disable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Controls;
using Microsoft.Maui.Controls.Internals;
using Microsoft.Maui.HotReload;

namespace MauiDeploy.HotReload;

internal static class XamlHotReloadAgent
{
    private const int ServerPort = ${hotReloadPort};
    private static readonly string CrLf = new string(new[] { (char)13, (char)10 });
    private static readonly object Gate = new();
    private static readonly ConcurrentDictionary<string, string> Resources = new(StringComparer.OrdinalIgnoreCase);
    private static readonly ConcurrentDictionary<Type, BindableProperty[]> BindablePropertiesByType = new();
    private static readonly ConcurrentDictionary<Type, byte> InitializeComponentDeadList = new();
    private static readonly ConcurrentDictionary<Type, FieldInfo[]> GeneratedFieldsByType = new();
    private static readonly ConcurrentDictionary<Type, string> XamlFilePathByType = new();
    private static readonly ConcurrentDictionary<Type, BindableProperty[]> DataTemplatePropertiesByType = new();
    private static readonly MethodInfo GetIsBoundMethod = typeof(BindableObject).GetMethod("GetIsBound", BindingFlags.NonPublic | BindingFlags.Instance);
    private static readonly PropertyInfo IsReadOnlyPropertyInfo = typeof(BindableProperty).GetProperty("IsReadOnly", BindingFlags.NonPublic | BindingFlags.Instance);
    private static MethodInfo _loadFromXamlStringMethod;
    private static MethodInfo _loadFromXamlExtensionMethod; // Extensions.LoadFromXaml<T> open generic
    private static readonly HashSet<string> StructuralPropertyNames = new(StringComparer.Ordinal)
    {
        "Children",
        "Content",
        "ControlTemplate",
        "Footer",
        "FooterTemplate",
        "Header",
        "HeaderTemplate",
        "ItemsSource",
        "ItemTemplate",
        "ItemTemplateSelector",
        "LogicalChildren",
        "MenuItems",
        "Resources",
        "RowDefinitions",
        "ColumnDefinitions"
    };
    private static int providerInstalled;
    private static int serverStarted;
    private static int applyVersion;
    private static int providerRequests;
    private static int providerHits;
    private static int lastActiveViews;
    private static int lastMatchedViews;
    private static int lastReloadHandlers;
    private static int lastReloadedViews;
    private static int lastInPlaceReloadedViews;
    private static int lastFreshReloadedViews;
    private static string lastAppliedPath = string.Empty;
    private static string lastRequestedPath = string.Empty;
    private static string lastMatchedPath = string.Empty;
    private static string lastTargetType = string.Empty;
    private static string lastCandidateTypes = string.Empty;
    private static string lastReloadError = string.Empty;
    private static string lastServerError = string.Empty;
    private static string lastStrategyLog = string.Empty;
    private const string AgentVersion = "3";

    [ModuleInitializer]
    internal static void Initialize()
    {
        try
        {
            InstallProvider();
            StartServer();
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] XAML Hot Reload agent failed to initialize: {ex}");
        }
    }

    public static string ApplyXaml(string resourcePath, string base64Xaml)
    {
        InstallProvider();

        var normalizedPath = NormalizeResourcePath(resourcePath);
        var xaml = NormalizeXaml(Encoding.UTF8.GetString(Convert.FromBase64String(base64Xaml)));
        var version = Interlocked.Increment(ref applyVersion);

        // Skip reload if XAML is identical to what we already cached
        Resources.TryGetValue(normalizedPath, out var previousXaml);
        if (previousXaml == xaml)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload v{version}: skipped (identical to previous)");
            return $"Skipped XAML Hot Reload v{version} for {normalizedPath} (unchanged). {GetStatus(normalizedPath)}";
        }

        Debug.WriteLine($"[MauiDeploy] Hot Reload v{version}: received {normalizedPath} ({xaml.Length} chars)");

        Resources[normalizedPath] = xaml;
        Resources[normalizedPath.Replace('/', '.')] = xaml;

        var fileName = Path.GetFileName(normalizedPath);
        if (!string.IsNullOrEmpty(fileName))
            Resources[fileName] = xaml;

        lastAppliedPath = normalizedPath;
        lastRequestedPath = string.Empty;
        lastMatchedPath = string.Empty;
        Interlocked.Exchange(ref providerRequests, 0);
        Interlocked.Exchange(ref providerHits, 0);

        MauiHotReloadHelper.IsEnabled = true;
        ReloadOnMainThread(normalizedPath, previousXaml, xaml);

        var status = GetStatus(normalizedPath);
        Debug.WriteLine($"[MauiDeploy] Hot Reload v{version}: done. {status}");
        return $"Queued XAML Hot Reload v{version} for {normalizedPath}. {status}";
    }

    public static string GetStatus(string resourcePath)
    {
        var normalizedPath = NormalizeResourcePath(resourcePath ?? string.Empty);
        var cachedResource = TryGetResource(normalizedPath, out _, out _) ? 1 : 0;
        var xamlLoader = _loadFromXamlStringMethod != null ? "XamlLoader" : _loadFromXamlExtensionMethod != null ? "Extensions" : "none";
        var providerIsSet = ResourceLoader.ResourceProvider2 != null ? 1 : 0;
        return $"agentV={AgentVersion}, serverStarted={Volatile.Read(ref serverStarted)}, serverPort={ServerPort}, serverError='{lastServerError}', activeViews={Volatile.Read(ref lastActiveViews)}, matchedViews={Volatile.Read(ref lastMatchedViews)}, reloadHandlers={Volatile.Read(ref lastReloadHandlers)}, explicitReloads={Volatile.Read(ref lastReloadedViews)}, inPlaceReloads={Volatile.Read(ref lastInPlaceReloadedViews)}, freshReloads={Volatile.Read(ref lastFreshReloadedViews)}, providerInstalled={Volatile.Read(ref providerInstalled)}, providerIsSet={providerIsSet}, providerRequests={Volatile.Read(ref providerRequests)}, providerHits={Volatile.Read(ref providerHits)}, cachedResource={cachedResource}, xamlLoader='{xamlLoader}', reloadError='{lastReloadError}', strategyLog='{lastStrategyLog}', targetType='{lastTargetType}', candidates='{lastCandidateTypes}', lastApplied='{lastAppliedPath}', lastRequested='{lastRequestedPath}', lastMatched='{lastMatchedPath}', requested='{normalizedPath}'";
    }

    private static void StartServer()
    {
        if (Interlocked.Exchange(ref serverStarted, 1) == 1)
            return;

        Task.Run(RunServer);
    }

    private static void RunServer()
    {
        try
        {
            var listener = CreateServerListener();
            Debug.WriteLine($"[MauiDeploy] XAML Hot Reload server listening on port {ServerPort}");

            while (true)
            {
                var client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(HandleClient, client);
            }
        }
        catch (Exception ex)
        {
            lastServerError = ex.GetType().Name + ": " + ex.Message;
            Debug.WriteLine($"[MauiDeploy] XAML Hot Reload server failed: {ex}");
            Interlocked.Exchange(ref serverStarted, 0);
        }
    }

    private static TcpListener CreateServerListener()
    {
        try
        {
            var listener = new TcpListener(IPAddress.IPv6Any, ServerPort);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            listener.Server.DualMode = true;
            listener.Start();
            return listener;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] XAML Hot Reload dual-stack bind failed: {ex.Message}; falling back to IPv4.");
            var listener = new TcpListener(IPAddress.Any, ServerPort);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            listener.Start();
            return listener;
        }
    }

    private static void HandleClient(object state)
    {
        using var client = (TcpClient)state;
        client.ReceiveTimeout = 5000;
        client.SendTimeout = 5000;
        NetworkStream stream = null;

        try
        {
            stream = client.GetStream();
            var request = ReadHttpRequest(stream);
            Debug.WriteLine($"[MauiDeploy] XAML Hot Reload request: {request.Path} ({request.Body.Length} chars)");
            var result = HandleHttpRequest(request.Path, request.Body);
            WriteHttpResponse(stream, 200, "OK", result);
        }
        catch (Exception ex)
        {
            if (stream != null)
                WriteHttpResponse(stream, 500, "Internal Server Error", ex.Message);
        }
    }

    private static string HandleHttpRequest(string requestPath, string body)
    {
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        var resourcePath = ReadJsonString(root, "resourcePath");

        if (requestPath.StartsWith("/apply", StringComparison.OrdinalIgnoreCase))
            return ApplyXaml(resourcePath, ReadJsonString(root, "base64Xaml"));

        if (requestPath.StartsWith("/status", StringComparison.OrdinalIgnoreCase))
            return GetStatus(resourcePath);

        if (requestPath.StartsWith("/delta", StringComparison.OrdinalIgnoreCase))
            return ApplyMetadataDeltas(root);

        if (requestPath.StartsWith("/capabilities", StringComparison.OrdinalIgnoreCase))
            return GetHotReloadCapabilities();

        throw new InvalidOperationException("Unknown XAML Hot Reload request path: " + requestPath);
    }

    private static string GetHotReloadCapabilities()
    {
        try
        {
            var caps = typeof(System.Reflection.Metadata.MetadataUpdater)
                .GetMethod("GetCapabilities", BindingFlags.Public | BindingFlags.Static)?
                .Invoke(null, null) as string;
            return caps ?? string.Empty;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: GetCapabilities failed: {ex.Message}");
            return string.Empty;
        }
    }

    private static string ApplyMetadataDeltas(JsonElement root)
    {
        var applied = 0;
        var errors = new List<string>();

        if (!root.TryGetProperty("updates", out var updatesElement))
            return "No updates in delta payload";

        foreach (var update in updatesElement.EnumerateArray())
        {
            try
            {
                var moduleIdStr = update.GetProperty("moduleId").GetString();
                var metadataDelta = Convert.FromBase64String(update.GetProperty("metadataDelta").GetString());
                var ilDelta = Convert.FromBase64String(update.GetProperty("ilDelta").GetString());
                var pdbDelta = update.TryGetProperty("pdbDelta", out var pdbProp) && pdbProp.ValueKind == JsonValueKind.String
                    ? Convert.FromBase64String(pdbProp.GetString())
                    : Array.Empty<byte>();

                var moduleId = Guid.Parse(moduleIdStr);
                Assembly targetAssembly = null;

                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try
                    {
                        if (asm.IsDynamic) continue;
                        var modules = asm.GetModules();
                        if (modules.Length > 0 && modules[0].ModuleVersionId == moduleId)
                        {
                            targetAssembly = asm;
                            break;
                        }
                    }
                    catch { }
                }

                if (targetAssembly == null)
                {
                    var msg = $"Assembly not found for moduleId {moduleId}";
                    errors.Add(msg);
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: {msg}");
                    continue;
                }

                Debug.WriteLine($"[MauiDeploy] Hot Reload: applying delta to {targetAssembly.GetName().Name} (moduleId={moduleId})");

                System.Reflection.Metadata.MetadataUpdater.ApplyUpdate(
                    targetAssembly,
                    metadataDelta,
                    ilDelta,
                    pdbDelta);

                applied++;
                Debug.WriteLine($"[MauiDeploy] Hot Reload: delta applied to {targetAssembly.GetName().Name}");

                // Invoke MetadataUpdateHandler callbacks (ClearCache + UpdateApplication)
                // The runtime does this automatically after ApplyUpdate in .NET 9+,
                // but we explicitly invoke for earlier runtimes as a safety net.
                if (update.TryGetProperty("updatedTypes", out var typesElement))
                {
                    try
                    {
                        var updatedTypes = new List<Type>();
                        foreach (var typeToken in typesElement.EnumerateArray())
                        {
                            var token = typeToken.GetInt32();
                            try
                            {
                                var type = targetAssembly.GetModules()[0].ResolveType(token);
                                if (type != null)
                                    updatedTypes.Add(type);
                            }
                            catch { }
                        }

                        if (updatedTypes.Count > 0)
                            InvokeMetadataUpdateHandlers(updatedTypes.ToArray());
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: handler invocation warning: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                var unwrapped = UnwrapException(ex);
                var msg = $"Delta apply failed: {unwrapped.GetType().Name}: {unwrapped.Message}";
                errors.Add(msg);
                Debug.WriteLine($"[MauiDeploy] Hot Reload: {msg}");
            }
        }

        var result = $"Applied {applied} delta(s)";
        if (errors.Count > 0)
            result += $", {errors.Count} error(s): " + string.Join("; ", errors);
        return result;
    }

    private static void InvokeMetadataUpdateHandlers(Type[] updatedTypes)
    {
        // Find all types with [MetadataUpdateHandler] attribute and invoke their
        // ClearCache and UpdateApplication methods.
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                foreach (var attr in asm.GetCustomAttributes())
                {
                    var attrType = attr.GetType();
                    if (attrType.FullName != "System.Reflection.Metadata.MetadataUpdateHandlerAttribute")
                        continue;

                    var handlerTypeProp = attrType.GetProperty("HandlerType");
                    if (handlerTypeProp?.GetValue(attr) is not Type handlerType)
                        continue;

                    try
                    {
                        var clearCache = handlerType.GetMethod("ClearCache",
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static,
                            null, new[] { typeof(Type[]) }, null);
                        clearCache?.Invoke(null, new object[] { updatedTypes });
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: ClearCache on {handlerType.Name} failed: {UnwrapException(ex).Message}");
                    }

                    try
                    {
                        var updateApp = handlerType.GetMethod("UpdateApplication",
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static,
                            null, new[] { typeof(Type[]) }, null);
                        updateApp?.Invoke(null, new object[] { updatedTypes });
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: UpdateApplication on {handlerType.Name} failed: {UnwrapException(ex).Message}");
                    }
                }
            }
            catch { }
        }
    }

    private static string ReadJsonString(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out var property)
            ? property.GetString() ?? string.Empty
            : string.Empty;
    }

    private static (string Path, string Body) ReadHttpRequest(NetworkStream stream)
    {
        var bytes = new List<byte>();
        var buffer = new byte[4096];
        var headerEnd = -1;

        while (headerEnd < 0)
        {
            var read = stream.Read(buffer, 0, buffer.Length);
            if (read <= 0)
                throw new IOException("Client disconnected before sending headers.");

            for (var i = 0; i < read; i++)
                bytes.Add(buffer[i]);

            headerEnd = FindHeaderEnd(bytes);
            if (bytes.Count > 65536)
                throw new IOException("XAML Hot Reload request headers are too large.");
        }

        var header = Encoding.ASCII.GetString(bytes.GetRange(0, headerEnd).ToArray());
        var contentLength = ReadContentLength(header);
        var bodyStart = headerEnd + 4;
        var bodyBytes = bytes.Count > bodyStart
            ? bytes.GetRange(bodyStart, bytes.Count - bodyStart)
            : new List<byte>();

        while (bodyBytes.Count < contentLength)
        {
            var read = stream.Read(buffer, 0, Math.Min(buffer.Length, contentLength - bodyBytes.Count));
            if (read <= 0)
                throw new IOException("Client disconnected before sending request body.");

            for (var i = 0; i < read; i++)
                bodyBytes.Add(buffer[i]);
        }

        var requestLineEnd = header.IndexOf(CrLf, StringComparison.Ordinal);
        var requestLine = requestLineEnd >= 0 ? header.Substring(0, requestLineEnd) : header;
        var parts = requestLine.Split(' ');
        var path = parts.Length > 1 ? parts[1] : "/";
        var body = Encoding.UTF8.GetString(bodyBytes.GetRange(0, contentLength).ToArray());
        return (path, body);
    }

    private static int FindHeaderEnd(List<byte> bytes)
    {
        for (var i = 0; i <= bytes.Count - 4; i++)
        {
            if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10)
                return i;
        }

        return -1;
    }

    private static int ReadContentLength(string header)
    {
        foreach (var line in header.Split(new[] { CrLf }, StringSplitOptions.None))
        {
            if (!line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                continue;

            return int.TryParse(line.Substring("Content-Length:".Length).Trim(), out var length)
                ? length
                : 0;
        }

        return 0;
    }

    private static void WriteHttpResponse(NetworkStream stream, int statusCode, string reason, string body)
    {
        var bodyBytes = Encoding.UTF8.GetBytes(body ?? string.Empty);
        var header = $"HTTP/1.1 {statusCode} {reason}{CrLf}Content-Type: text/plain; charset=utf-8{CrLf}Content-Length: {bodyBytes.Length}{CrLf}Connection: close{CrLf}{CrLf}";
        var headerBytes = Encoding.ASCII.GetBytes(header);
        stream.Write(headerBytes, 0, headerBytes.Length);
        stream.Write(bodyBytes, 0, bodyBytes.Length);
    }

    private static void InstallProvider()
    {
        if (providerInstalled == 1)
            return;

        lock (Gate)
        {
            if (providerInstalled == 1)
                return;

            Func<ResourceLoader.ResourceLoadingQuery, ResourceLoader.ResourceLoadingResponse> provider = ProvideResource;
            var property = typeof(ResourceLoader).GetProperty(nameof(ResourceLoader.ResourceProvider2), BindingFlags.Public | BindingFlags.Static);
            var setter = property?.GetSetMethod(nonPublic: true);
            if (setter == null)
                throw new MissingMethodException(typeof(ResourceLoader).FullName, nameof(ResourceLoader.ResourceProvider2));

            setter.Invoke(null, new object[] { provider });
            MauiHotReloadHelper.IsEnabled = true;
            providerInstalled = 1;
        }
    }

    private static void ReloadOnMainThread(string resourcePath, string previousXaml, string newXaml)
    {
        if (MainThread.IsMainThread)
        {
            ReloadMatchingViews(resourcePath, previousXaml, newXaml);
            return;
        }

        Exception captured = null;
        using var completed = new ManualResetEventSlim(false);

        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                ReloadMatchingViews(resourcePath, previousXaml, newXaml);
            }
            catch (Exception ex)
            {
                captured = ex;
            }
            finally
            {
                completed.Set();
            }
        });

        if (!completed.Wait(TimeSpan.FromSeconds(30)))
            throw new TimeoutException("Timed out waiting for XAML Hot Reload on the UI thread.");

        if (captured != null)
            throw new InvalidOperationException("XAML Hot Reload failed on the UI thread.", captured);
    }

    private static ResourceLoader.ResourceLoadingResponse ProvideResource(ResourceLoader.ResourceLoadingQuery query)
    {
        var resourcePath = NormalizeResourcePath(query.ResourcePath ?? string.Empty);
        Interlocked.Increment(ref providerRequests);
        lastRequestedPath = resourcePath;

        if (!TryGetResource(resourcePath, out var xaml, out _))
            return null;

        Interlocked.Increment(ref providerHits);
        lastMatchedPath = resourcePath;

        return new ResourceLoader.ResourceLoadingResponse
        {
            ResourceContent = xaml,
            UseDesignProperties = false
        };
    }

    private static int ReloadMatchingViews(string resourcePath, string previousXaml, string newXaml)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var activeViews = 0;
        var matchedViews = 0;
        var reloadHandlers = 0;
        var reloadedViews = 0;
        var inPlaceReloadedViews = 0;
        var freshReloadedViews = 0;
        lastReloadError = string.Empty;
        lastStrategyLog = string.Empty;

        // Primary lookup: use XamlResourceIdAttribute (assembly-level) to find the
        // Type that owns this XAML file.  This is the same attribute the source gen
        // consults when it checks ResourceProvider2 inside InitializeComponent, so
        // the path format is guaranteed to match.
        var targetType = FindTypeByXamlResourceId(resourcePath) ?? FindTypeByXamlClass(newXaml);
        lastTargetType = targetType?.FullName ?? string.Empty;
        var candidateTypes = new List<string>();

        try
        {
            foreach (var item in GetReloadCandidates(GetActiveViews()))
            {
                if (item == null)
                    continue;

                activeViews++;
                if (item is IHotReloadableView view && view.ReloadHandler != null)
                    reloadHandlers++;

                var viewType = item.GetType();
                if (candidateTypes.Count < 24)
                {
                    var xamlPath = GetXamlFilePath(viewType);
                    candidateTypes.Add(string.IsNullOrEmpty(xamlPath) ? viewType.Name : viewType.Name + "=" + xamlPath);
                }

                if (!IsMatchingReloadTarget(viewType, targetType, resourcePath))
                    continue;

                matchedViews++;

                var reloadSw = System.Diagnostics.Stopwatch.StartNew();

                // Fast path: surgically patch attribute-only XAML changes without re-parsing the whole page.
                // Bails to fallback on any structural / markup-extension / unknown property change.
                var fastResult = (item is BindableObject fastTarget && !string.IsNullOrEmpty(previousXaml))
                    ? RunReloadStrategy(viewType, "FastPath",
                        () => TryReloadPropertyOnly(fastTarget, previousXaml, newXaml))
                    : ReloadStrategyResult.Rejected;
                if (fastResult == ReloadStrategyResult.Succeeded)
                {
                    reloadedViews++;
                    inPlaceReloadedViews++;
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: reloaded {viewType.Name} via fast-path in {reloadSw.ElapsedMilliseconds}ms");
                    continue;
                }

                // Direct XAML string reload: parse cached XAML into the live view.
                // Bypasses compiled InitializeComponent which ignores ResourceProvider2
                // when the XAML source generator is used (.NET 10+).
                var xamlResult = RunReloadStrategy(viewType, "LoadFromXaml",
                    () => TryReloadViaXamlString(item, viewType, resourcePath));
                if (xamlResult == ReloadStrategyResult.Succeeded)
                {
                    reloadedViews++;
                    inPlaceReloadedViews++;
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: reloaded {viewType.Name} via LoadFromXaml in {reloadSw.ElapsedMilliseconds}ms");
                    continue;
                }

                var initResult = InitializeComponentDeadList.ContainsKey(viewType)
                    ? ReloadStrategyResult.Rejected
                    : RunReloadStrategy(viewType, "InitializeComponent",
                        () => TryReloadViaInitializeComponent(item, viewType));
                if (initResult != ReloadStrategyResult.Succeeded)
                {
                    InitializeComponentDeadList.TryAdd(viewType, 0);
                }
                if (initResult == ReloadStrategyResult.Succeeded)
                {
                    reloadedViews++;
                    inPlaceReloadedViews++;
                    InitializeComponentDeadList.TryRemove(viewType, out _);
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: reloaded {viewType.Name} via InitializeComponent in {reloadSw.ElapsedMilliseconds}ms");
                }
                else
                {
                    object replacement = null;
                    object bindingContext = null;
                    try
                    {
                        replacement = CreateReplacement(viewType, item, resourcePath, out bindingContext);
                    }
                    catch (Exception ex)
                    {
                        var unwrapped = UnwrapException(ex);
                        lastReloadError = "CreateReplacement: " + FormatException(unwrapped);
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: CreateReplacement failed for {viewType.Name}: {unwrapped}");
                    }

                    var createMs = reloadSw.ElapsedMilliseconds;
                    var inPlaceResult = replacement == null
                        ? ReloadStrategyResult.Rejected
                        : RunReloadStrategy(viewType, "InPlace",
                            () => TryReloadInPlace(item, replacement, bindingContext));

                    if (inPlaceResult == ReloadStrategyResult.Succeeded)
                    {
                        reloadedViews++;
                        inPlaceReloadedViews++;
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: reloaded {viewType.Name} in-place in {reloadSw.ElapsedMilliseconds}ms (create: {createMs}ms)");
                    }
                    else
                    {
                        var freshResult = replacement == null
                            ? ReloadStrategyResult.Rejected
                            : RunReloadStrategy(viewType, "FromReplacement",
                                () => TryReloadFromReplacement(item, replacement, bindingContext, viewType));

                        if (freshResult == ReloadStrategyResult.Succeeded)
                        {
                            reloadedViews++;
                            freshReloadedViews++;
                            Debug.WriteLine($"[MauiDeploy] Hot Reload: reloaded {viewType.Name} via fresh instance in {reloadSw.ElapsedMilliseconds}ms (create: {createMs}ms)");
                        }
                        else
                        {
                            Debug.WriteLine($"[MauiDeploy] Hot Reload: could not reload {viewType.Name} (init={initResult}, inPlace={inPlaceResult}, fresh={freshResult}); will rebuild on next navigation");
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: active view scan failed: {ex}");
        }

        Debug.WriteLine($"[MauiDeploy] Hot Reload: scanned {activeViews} views, matched {matchedViews}, reloaded {reloadedViews} (in-place: {inPlaceReloadedViews}, fresh: {freshReloadedViews}) in {sw.ElapsedMilliseconds}ms total");

        if (matchedViews == 0)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: no direct matches, scanning DataTemplate consumers for {resourcePath}...");
            try
            {
                foreach (var item in GetReloadCandidates(GetActiveViews()))
                {
                    if (item is not BindableObject bindable)
                        continue;

                    var templateProps = GetDataTemplateProperties(bindable.GetType());
                    if (templateProps.Length == 0)
                        continue;

                    var refreshed = false;
                    foreach (var prop in templateProps)
                    {
                        if (!bindable.IsSet(prop))
                            continue;

                        try
                        {
                            var value = bindable.GetValue(prop);
                            if (value == null)
                                continue;

                            if (!DataTemplateContainsMatchingView(value, resourcePath, targetType))
                            {
                                Debug.WriteLine($"[MauiDeploy] Hot Reload: skipping {bindable.GetType().Name}.{prop.PropertyName} (template does not contain {Path.GetFileName(resourcePath)})");
                                continue;
                            }

                            Debug.WriteLine($"[MauiDeploy] Hot Reload: resetting {bindable.GetType().Name}.{prop.PropertyName} (contains matching view)");
                            bindable.ClearValue(prop);
                            bindable.SetValue(prop, value);
                            refreshed = true;
                        }
                        catch (Exception ex)
                        {
                            Debug.WriteLine($"[MauiDeploy] Hot Reload: template refresh failed for {bindable.GetType().Name}.{prop.PropertyName}: {ex.Message}");
                        }
                    }

                    if (refreshed)
                    {
                        matchedViews++;
                        reloadedViews++;
                        freshReloadedViews++;
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: template scan failed: {ex}");
            }

            if (matchedViews > 0)
                Debug.WriteLine($"[MauiDeploy] Hot Reload: refreshed {matchedViews} template consumer(s)");
            else
                Debug.WriteLine($"[MauiDeploy] Hot Reload: no template consumers found, XAML cached for next navigation");
        }

        Volatile.Write(ref lastActiveViews, activeViews);
        Volatile.Write(ref lastMatchedViews, matchedViews);
        Volatile.Write(ref lastReloadHandlers, reloadHandlers);
        Volatile.Write(ref lastReloadedViews, reloadedViews);
        Volatile.Write(ref lastInPlaceReloadedViews, inPlaceReloadedViews);
        Volatile.Write(ref lastFreshReloadedViews, freshReloadedViews);
        lastCandidateTypes = SanitizeForResponse(string.Join("|", candidateTypes.Distinct()), 500);
        return reloadedViews;
    }

    private static bool IsMatchingXamlView(Type viewType, string resourcePath)
    {
        var xamlPath = GetXamlFilePath(viewType);
        if (!string.IsNullOrEmpty(xamlPath))
        {
            var normalizedXamlPath = NormalizeResourcePath(xamlPath);
            if (string.Equals(normalizedXamlPath, resourcePath, StringComparison.OrdinalIgnoreCase))
                return true;

            if (normalizedXamlPath.EndsWith('/' + resourcePath, StringComparison.OrdinalIgnoreCase) ||
                resourcePath.EndsWith('/' + normalizedXamlPath, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        // Fallback: match by type name when XamlFilePathAttribute is absent (XAML source gen)
        var fileName = Path.GetFileNameWithoutExtension(resourcePath);
        if (string.IsNullOrEmpty(fileName))
            return false;

        return string.Equals(viewType.Name, fileName, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsMatchingReloadTarget(Type viewType, Type targetType, string resourcePath)
    {
        if (targetType != null)
        {
            if (viewType == targetType || targetType.IsAssignableFrom(viewType) || viewType.IsAssignableFrom(targetType))
                return true;
        }

        return IsMatchingXamlView(viewType, resourcePath);
    }

    private static Type FindTypeByXamlClass(string xaml)
    {
        var className = ExtractXamlClassName(xaml);
        if (string.IsNullOrEmpty(className))
            return null;

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                var type = asm.GetType(className, throwOnError: false, ignoreCase: false);
                if (type != null)
                {
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: resolved x:Class {className} → {type.FullName}");
                    return type;
                }
            }
            catch { }
        }

        Debug.WriteLine($"[MauiDeploy] Hot Reload: x:Class type not found: {className}");
        return null;
    }

    private static string ExtractXamlClassName(string xaml)
    {
        if (string.IsNullOrEmpty(xaml))
            return string.Empty;

        const string marker = "x:Class";
        var index = xaml.IndexOf(marker, StringComparison.Ordinal);
        while (index >= 0)
        {
            var equals = xaml.IndexOf('=', index + marker.Length);
            if (equals < 0)
                return string.Empty;

            var pos = equals + 1;
            while (pos < xaml.Length && char.IsWhiteSpace(xaml[pos]))
                pos++;

            if (pos >= xaml.Length)
                return string.Empty;

            var quote = xaml[pos];
            if (quote != '"' && quote != (char)39)
            {
                index = xaml.IndexOf(marker, index + marker.Length, StringComparison.Ordinal);
                continue;
            }

            var end = xaml.IndexOf(quote, pos + 1);
            if (end <= pos + 1)
                return string.Empty;

            return xaml.Substring(pos + 1, end - pos - 1).Trim();
        }

        return string.Empty;
    }

    private static string GetXamlFilePath(Type viewType)
    {
        return XamlFilePathByType.GetOrAdd(viewType, static type =>
        {
            foreach (var attribute in type.GetCustomAttributes(inherit: true))
            {
                var attributeType = attribute.GetType();
                if (attributeType.FullName != "Microsoft.Maui.Controls.Xaml.XamlFilePathAttribute")
                    continue;

                if (attributeType.GetProperty("FilePath")?.GetValue(attribute) is string path)
                    return path;

                if (attributeType.GetProperty("Path")?.GetValue(attribute) is string fallbackPath)
                    return fallbackPath;
            }

            return string.Empty;
        });
    }

    // Resolve the CLR Type that owns a given XAML resource path using the assembly-level
    // XamlResourceIdAttribute.  This is the same attribute the source gen consults inside
    // its generated InitializeComponent, so the path format is always consistent.
    private static readonly ConcurrentDictionary<string, Type> XamlResourceIdTypeCache = new(StringComparer.OrdinalIgnoreCase);

    private static Type FindTypeByXamlResourceId(string resourcePath)
    {
        if (XamlResourceIdTypeCache.TryGetValue(resourcePath, out var cached))
            return cached;

        // XamlResourceIdAttribute uses dot-separated embedded-resource style paths
        // (e.g., "MyApp.Views.MainPage.xaml") whereas the extension sends
        // slash-separated project-relative paths ("Views/MainPage.xaml").
        // Build several candidate forms so we can match either style.
        var slashPath = resourcePath.Replace('.', '/');
        var dotPath = resourcePath.Replace('/', '.');
        var fileName = Path.GetFileName(resourcePath);
        var fileNameNoExt = Path.GetFileNameWithoutExtension(resourcePath);

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                foreach (var attr in asm.GetCustomAttributes())
                {
                    var attrType = attr.GetType();
                    if (attrType.FullName != "Microsoft.Maui.Controls.Xaml.XamlResourceIdAttribute")
                        continue;

                    var pathProp = attrType.GetProperty("Path");
                    var typeProp = attrType.GetProperty("Type");
                    if (pathProp == null || typeProp == null)
                        continue;

                    var path = pathProp.GetValue(attr) as string;
                    if (string.IsNullOrEmpty(path))
                        continue;

                    var normalizedAttrPath = NormalizeResourcePath(path);
                    // Also convert dot-style to slash-style for comparison
                    var attrSlash = normalizedAttrPath.Replace('.', '/');
                    var attrDot = normalizedAttrPath.Replace('/', '.');

                    if (ResourcePathsMatch(normalizedAttrPath, resourcePath) ||
                        ResourcePathsMatch(attrSlash, slashPath) ||
                        ResourcePathsMatch(attrDot, dotPath) ||
                        ResourcePathsMatch(normalizedAttrPath, dotPath) ||
                        ResourcePathsMatch(attrSlash, resourcePath))
                    {
                        if (typeProp.GetValue(attr) is Type match)
                        {
                            XamlResourceIdTypeCache[resourcePath] = match;
                            Debug.WriteLine($"[MauiDeploy] Hot Reload: resolved {resourcePath} → {match.FullName} via XamlResourceIdAttribute (attr='{normalizedAttrPath}')");
                            return match;
                        }
                    }
                }
            }
            catch { }
        }

        Debug.WriteLine($"[MauiDeploy] Hot Reload: no XamlResourceIdAttribute match for {resourcePath} (dotPath='{dotPath}')");
        return null;
    }

    private static bool ResourcePathsMatch(string a, string b)
    {
        var normalizedA = NormalizeComparableResourcePath(a);
        var normalizedB = NormalizeComparableResourcePath(b);

        if (string.Equals(normalizedA, normalizedB, StringComparison.OrdinalIgnoreCase))
            return true;
        if (normalizedA.EndsWith('/' + normalizedB, StringComparison.OrdinalIgnoreCase) ||
            normalizedB.EndsWith('/' + normalizedA, StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    private static string NormalizeComparableResourcePath(string path)
    {
        path = NormalizeResourcePath(path ?? string.Empty).Trim('/');
        if (path.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase))
            path = path.Substring(0, path.Length - ".xaml".Length);

        path = path.Replace('.', '/');
        while (path.Contains("//"))
            path = path.Replace("//", "/");

        return path.Trim('/');
    }

    // Direct XAML string reload: bypass compiled InitializeComponent and load our cached XAML
    // directly into the existing view via XamlLoader.Load(object, string). This is a fallback
    // for cases where the source gen's ResourceProvider2 check cannot find the cached XAML.
    private static bool TryReloadViaXamlString(object target, Type viewType, string resourcePath)
    {
        if (target is not BindableObject)
            return false;

        if (!TryGetResource(resourcePath, out var xaml, out _))
            return false;

        if (_loadFromXamlStringMethod == null && _loadFromXamlExtensionMethod == null)
        {
            // Strategy 1: XamlLoader.Load(object, string) — internal but public methods.
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var candidate = asm.GetType("Microsoft.Maui.Controls.Xaml.XamlLoader", throwOnError: false);
                    if (candidate == null)
                        continue;

                    var method = candidate.GetMethod("Load",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static,
                        null,
                        new[] { typeof(object), typeof(string) },
                        null);
                    if (method != null)
                    {
                        _loadFromXamlStringMethod = method;
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: found XamlLoader.Load in {asm.GetName().Name}");
                        break;
                    }
                }
                catch { }
            }

            // Strategy 2: Extensions.LoadFromXaml<T>(this T, string) — public API, always available.
            if (_loadFromXamlStringMethod == null)
            {
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try
                    {
                        var candidate = asm.GetType("Microsoft.Maui.Controls.Xaml.Extensions", throwOnError: false);
                        if (candidate == null)
                            continue;

                        var methods = candidate.GetMethods(BindingFlags.Public | BindingFlags.Static);
                        foreach (var m in methods)
                        {
                            if (m.Name == "LoadFromXaml" && m.IsGenericMethodDefinition && m.GetParameters().Length == 2)
                            {
                                _loadFromXamlExtensionMethod = m;
                                Debug.WriteLine($"[MauiDeploy] Hot Reload: found Extensions.LoadFromXaml<T> in {asm.GetName().Name}");
                                break;
                            }
                        }
                        if (_loadFromXamlExtensionMethod != null)
                            break;
                    }
                    catch { }
                }
            }

            if (_loadFromXamlStringMethod == null && _loadFromXamlExtensionMethod == null)
                Debug.WriteLine("[MauiDeploy] Hot Reload: no XAML loading method found in any loaded assembly");
        }

        if (_loadFromXamlStringMethod == null && _loadFromXamlExtensionMethod == null)
            return false;

        var bindingContext = (target as BindableObject)?.BindingContext;

        SaveViewState(target, out var savedContent, out var savedToolbarItems);
        ClearViewForReload(target);

        try
        {
            if (_loadFromXamlStringMethod != null)
            {
                _loadFromXamlStringMethod.Invoke(null, new object[] { target, xaml });
            }
            else
            {
                var closed = _loadFromXamlExtensionMethod.MakeGenericMethod(viewType);
                closed.Invoke(null, new object[] { target, xaml });
            }
        }
        catch (Exception ex)
        {
            var unwrapped = UnwrapException(ex);
            lastReloadError = $"LoadFromXaml threw {unwrapped.GetType().Name}: {unwrapped.Message}";
            Debug.WriteLine($"[MauiDeploy] Hot Reload: {lastReloadError}");
            RestoreViewContent(target, savedContent, savedToolbarItems);
            return false;
        }

        // Restore BindingContext if cleared
        if (target is BindableObject boAfter && boAfter.BindingContext == null && bindingContext != null)
            boAfter.BindingContext = bindingContext;

        // Force implicit style resolution + layout invalidation.
        // XamlLoader.Load creates new elements but they don't automatically pick up
        // implicit styles from ancestor ResourceDictionaries (app-level themes, etc.).
        // This causes labels/buttons to appear invisible (no TextColor, no background).
        if (target is VisualElement reloadedVe)
        {
            try
            {
                ReapplyImplicitStyles(reloadedVe);
                reloadedVe.InvalidateMeasureNonVirtual(Microsoft.Maui.Controls.Internals.InvalidationTrigger.Undefined);
                if (target is Page reloadedPage)
                    reloadedPage.ForceLayout();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: post-reload style/layout fixup warning: {UnwrapException(ex).Message}");
            }
        }

        return true;
    }

    /// <summary>
    /// Walk the visual tree and re-apply implicit styles to all elements.
    /// After XamlLoader.Load, newly created elements don't resolve implicit styles
    /// from ancestor ResourceDictionaries, so text can appear invisible (no TextColor set).
    /// </summary>
    private static void ReapplyImplicitStyles(Element root)
    {
        // Use the internal ApplyStyleSheetsInternal or force style resolution
        // by temporarily removing and re-adding the element's Style,
        // or by calling the internal SetInheritedBindingContext path.
        try
        {
            // Strategy: call the internal "ApplyStyles" pipeline by invoking
            // the protected OnParentResourcesChanged method which triggers
            // implicit style lookup for the element and all descendants.
            var method = typeof(Element).GetMethod("OnParentResourcesChanged",
                BindingFlags.NonPublic | BindingFlags.Instance,
                null,
                new Type[] { typeof(IEnumerable<KeyValuePair<string, object>>) },
                null);

            if (method != null)
            {
                // Collect merged resources from the app level down
                var appResources = Application.Current?.Resources;
                if (appResources != null)
                {
                    var mergedResources = new List<KeyValuePair<string, object>>();
                    CollectResources(appResources, mergedResources);
                    method.Invoke(root, new object[] { mergedResources });
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: re-applied {mergedResources.Count} app resources to visual tree");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: OnParentResourcesChanged failed: {UnwrapException(ex).Message}");
        }

        // Fallback: walk tree and force style re-evaluation per element
        try
        {
            ForceStyleResolution(root);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: ForceStyleResolution failed: {UnwrapException(ex).Message}");
        }
    }

    private static void CollectResources(ResourceDictionary dict, List<KeyValuePair<string, object>> result)
    {
        foreach (var kvp in dict)
            result.Add(kvp);

        if (dict.MergedDictionaries != null)
        {
            foreach (var merged in dict.MergedDictionaries)
                CollectResources(merged, result);
        }
    }

    /// <summary>
    /// Walk every element in the tree and nudge MAUI into re-resolving implicit styles.
    /// Sets Style=null then back, which triggers the internal style lookup machinery.
    /// </summary>
    private static void ForceStyleResolution(Element element)
    {
        if (element is VisualElement ve)
        {
            // If no explicit style is set, the element should pick up implicit styles.
            // Toggling the internal style class triggers re-resolution.
            if (ve.Style == null)
            {
                // Force MAUI to re-check implicit styles by briefly invalidating
                try
                {
                    ve.InvalidateMeasureNonVirtual(Microsoft.Maui.Controls.Internals.InvalidationTrigger.Undefined);
                }
                catch { }
            }
        }

        // Recurse into children
        if (element is IVisualTreeElement vte)
        {
            foreach (var child in vte.GetVisualChildren())
            {
                if (child is Element childElement)
                    ForceStyleResolution(childElement);
            }
        }
    }

    // Fast-path: collect attribute deltas in a validation pass, then apply atomically.
    // Returns false if anything looks structural / markup-extension / non-trivial — caller falls back.
    private static bool TryReloadPropertyOnly(BindableObject root, string oldXaml, string newXaml)
    {
        if (string.IsNullOrEmpty(oldXaml) || string.IsNullOrEmpty(newXaml))
            return false;
        if (oldXaml == newXaml)
            return true;

        System.Xml.Linq.XDocument oldDoc, newDoc;
        try
        {
            oldDoc = System.Xml.Linq.XDocument.Parse(oldXaml);
            newDoc = System.Xml.Linq.XDocument.Parse(newXaml);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: fast-path parse failed — {ex.Message}");
            return false;
        }

        var changes = new List<FastPathChange>();
        if (!TryCollectFastPathChanges(oldDoc.Root, newDoc.Root, root, changes))
            return false;

        foreach (var change in changes)
        {
            try { change.Target.SetValue(change.Property, change.Value); }
            catch (Exception ex)
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: fast-path SetValue failed for {change.Property.PropertyName} — {ex.Message}");
                return false;
            }
        }

        Debug.WriteLine($"[MauiDeploy] Hot Reload: fast-path applied {changes.Count} attribute change(s)");
        return true;
    }

    private struct FastPathChange
    {
        public BindableObject Target;
        public BindableProperty Property;
        public object Value;
    }

    private static bool TryCollectFastPathChanges(System.Xml.Linq.XElement oldEl, System.Xml.Linq.XElement newEl, BindableObject live, List<FastPathChange> changes)
    {
        if (oldEl.Name != newEl.Name)
            return false;

        // Bail if any non-whitespace text content (e.g., <Label>Hello</Label>) — we don't patch text.
        if (HasTextContent(oldEl) || HasTextContent(newEl))
            return false;

        var liveType = live.GetType();

        // Attributes
        foreach (var newAttr in newEl.Attributes())
        {
            if (newAttr.IsNamespaceDeclaration)
                continue;
            var localName = newAttr.Name.LocalName;
            if (localName.Contains('.'))
                return false; // attached property (e.g., Grid.Row) — bail
            if (newAttr.Name.NamespaceName.Length > 0 && newAttr.Name.NamespaceName != oldEl.Name.NamespaceName)
                continue; // x:Name, x:Key, etc — ignore

            var oldAttr = oldEl.Attribute(newAttr.Name);
            if (oldAttr != null && oldAttr.Value == newAttr.Value)
                continue;

            var value = newAttr.Value;
            if (value.StartsWith("{") && value.EndsWith("}"))
                return false; // markup extension — bail

            var property = FindBindablePropertyByName(liveType, localName);
            if (property == null)
                return false;

            if (!TryConvertSimpleValue(value, property.ReturnType, out var converted))
                return false;

            changes.Add(new FastPathChange { Target = live, Property = property, Value = converted });
        }

        // Removed attribute would require resetting to default — bail.
        foreach (var oldAttr in oldEl.Attributes())
        {
            if (oldAttr.IsNamespaceDeclaration)
                continue;
            if (newEl.Attribute(oldAttr.Name) == null)
                return false;
        }

        // Property elements (Grid.RowDefinitions etc.) — bail if not byte-equal.
        var oldPropEls = oldEl.Elements().Where(e => e.Name.LocalName.Contains('.')).ToList();
        var newPropEls = newEl.Elements().Where(e => e.Name.LocalName.Contains('.')).ToList();
        if (oldPropEls.Count != newPropEls.Count)
            return false;
        for (var i = 0; i < oldPropEls.Count; i++)
        {
            if (!System.Xml.Linq.XNode.DeepEquals(oldPropEls[i], newPropEls[i]))
                return false;
        }

        // Element children → must align with live structural children
        var oldChildren = oldEl.Elements().Where(e => !e.Name.LocalName.Contains('.')).ToList();
        var newChildren = newEl.Elements().Where(e => !e.Name.LocalName.Contains('.')).ToList();
        if (oldChildren.Count != newChildren.Count)
            return false;

        var liveChildren = new List<BindableObject>();
        foreach (var child in GetStructuralChildren(live))
        {
            if (child is BindableObject bindable)
                liveChildren.Add(bindable);
            else
                return false;
        }
        if (liveChildren.Count != oldChildren.Count)
            return false;

        for (var i = 0; i < oldChildren.Count; i++)
        {
            if (!TryCollectFastPathChanges(oldChildren[i], newChildren[i], liveChildren[i], changes))
                return false;
        }

        return true;
    }

    private static bool HasTextContent(System.Xml.Linq.XElement el)
    {
        foreach (var node in el.Nodes())
        {
            if (node is System.Xml.Linq.XText text && !string.IsNullOrWhiteSpace(text.Value))
                return true;
        }
        return false;
    }

    private static BindableProperty FindBindablePropertyByName(Type type, string propertyName)
    {
        var fieldName = propertyName + "Property";
        for (var t = type; t != null && t != typeof(object); t = t.BaseType)
        {
            var field = t.GetField(fieldName, BindingFlags.Public | BindingFlags.Static);
            if (field != null && field.GetValue(null) is BindableProperty bp)
                return bp;
        }
        return null;
    }

    private static bool TryConvertSimpleValue(string value, Type targetType, out object result)
    {
        result = null;
        try
        {
            if (targetType == typeof(string))
            {
                result = value;
                return true;
            }
            var underlying = Nullable.GetUnderlyingType(targetType) ?? targetType;
            if (underlying.IsEnum)
            {
                result = System.Enum.Parse(underlying, value, ignoreCase: true);
                return true;
            }
            var converter = System.ComponentModel.TypeDescriptor.GetConverter(underlying);
            if (converter != null && converter.CanConvertFrom(typeof(string)))
            {
                result = converter.ConvertFromInvariantString(value);
                return true;
            }
        }
        catch
        {
        }
        return false;
    }

    private enum ReloadStrategyResult { Succeeded, Rejected, Failed }

    private static ReloadStrategyResult RunReloadStrategy(Type viewType, string name, Func<bool> strategy)
    {
        try
        {
            var result = strategy() ? ReloadStrategyResult.Succeeded : ReloadStrategyResult.Rejected;
            lastStrategyLog += $"{name}={result} ";
            return result;
        }
        catch (Exception ex)
        {
            var unwrapped = UnwrapException(ex);
            lastReloadError = name + ": " + FormatException(unwrapped);
            lastStrategyLog += $"{name}=Failed({unwrapped.GetType().Name}) ";
            Debug.WriteLine($"[MauiDeploy] Hot Reload: {name} threw for {viewType.Name}: {unwrapped}");
            return ReloadStrategyResult.Failed;
        }
    }

    private static bool TryReloadInPlace(object target, object replacement, object bindingContext)
    {
        if (GetIsBoundMethod == null)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: in-place skipped — GetIsBound method not found");
            return false;
        }

        if (target is not BindableObject targetRoot || replacement is not BindableObject replacementRoot)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: in-place skipped — target or replacement is not BindableObject");
            return false;
        }

        if (!TryCollectStructuralTree(targetRoot, out var targetTree) || !TryCollectStructuralTree(replacementRoot, out var replacementTree))
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: in-place skipped — structural tree collection failed");
            return false;
        }

        if (!HaveSameStructure(targetTree, replacementTree))
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: in-place skipped — structure differs (target: {targetTree.Count} nodes, replacement: {replacementTree.Count} nodes)");
            if (targetTree.Count == replacementTree.Count)
            {
                for (var d = 0; d < targetTree.Count; d++)
                {
                    if (targetTree[d].GetType() != replacementTree[d].GetType())
                    {
                        Debug.WriteLine($"[MauiDeploy] Hot Reload:   node {d}: {targetTree[d].GetType().Name} vs {replacementTree[d].GetType().Name}");
                        break;
                    }
                }
            }
            return false;
        }

        var changedValues = 0;
        for (var i = 0; i < targetTree.Count; i++)
        {
            var copiedValues = CopyInPlaceBindableValues(replacementTree[i], targetTree[i]);
            if (copiedValues < 0)
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: in-place skipped — CopyInPlaceBindableValues failed at node {i} ({targetTree[i].GetType().Name})");
                return false;
            }

            changedValues += copiedValues;
        }

        if (changedValues == 0)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: in-place skipped — no values changed across {targetTree.Count} nodes");
            return false;
        }

        targetRoot.BindingContext = bindingContext;
        return true;
    }

    private static bool TryReloadViaInitializeComponent(object target, Type viewType)
    {
        var initMethod = viewType.GetMethod("InitializeComponent", BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
        if (initMethod == null)
        {
            // Also check for InitializeComponentRuntime as a diagnostic
            var runtimeMethod = viewType.GetMethod("InitializeComponentRuntime", BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
            lastReloadError = $"InitializeComponent not found on {viewType.Name} (runtime={runtimeMethod != null})";
            Debug.WriteLine($"[MauiDeploy] Hot Reload: {lastReloadError}");
            return false;
        }

        Debug.WriteLine($"[MauiDeploy] Hot Reload: found InitializeComponent on {viewType.Name}, declaring type={initMethod.DeclaringType?.FullName}");

        var bindingContext = (target as BindableObject)?.BindingContext;

        SaveViewState(target, out var savedContent, out var savedToolbarItems);
        ClearViewForReload(target);

        try
        {
            initMethod.Invoke(target, null);
        }
        catch (Exception ex)
        {
            var unwrapped = UnwrapException(ex);
            lastReloadError = $"InitializeComponent threw {unwrapped.GetType().Name}: {unwrapped.Message}";
            Debug.WriteLine($"[MauiDeploy] Hot Reload: {lastReloadError}");
            RestoreViewContent(target, savedContent, savedToolbarItems);
            return false;
        }

        // Restore BindingContext if InitializeComponent cleared it
        if (target is BindableObject boAfter && boAfter.BindingContext == null && bindingContext != null)
            boAfter.BindingContext = bindingContext;

        return true;
    }

    private static bool TryReloadFromReplacement(object target, object replacement, object bindingContext, Type viewType)
    {
        if (target is BindableObject targetRoot && replacement is BindableObject replacementRoot)
        {
            SafeStep("CopyRootBindableValues", () => CopyRootBindableValues(replacementRoot, targetRoot));
            SafeStep("CopyNameScope", () => CopyNameScope(replacementRoot, targetRoot));
        }

        bool moved;
        try
        {
            moved = TryMoveContent(replacement, target);
        }
        catch (Exception ex)
        {
            var unwrapped = UnwrapException(ex);
            Debug.WriteLine($"[MauiDeploy] Hot Reload: TryMoveContent threw: {unwrapped}");
            throw;
        }
        if (!moved)
            return false;

        if (target is BindableObject targetBindableAfterMove)
            SafeStep("BindingContext", () => targetBindableAfterMove.BindingContext = bindingContext);

        SafeStep("CopyGeneratedFields", () => CopyGeneratedFields(replacement, target, viewType));
        return true;
    }

    private static void SafeStep(string name, Action step)
    {
        try
        {
            step();
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: {name} swallowed — {UnwrapException(ex).Message}");
        }
    }

    /// <summary>
    /// Clear all page-level collections so InitializeComponent / XamlLoader can
    /// re-populate from scratch without NameScope conflicts or "already a child" errors.
    /// Source gen code and the runtime XAML parser both ADD to collections (ToolbarItems, etc.)
    /// rather than replacing them, so we must clear first.
    /// </summary>
    private static void ClearViewForReload(object target)
    {
        // 1. Unregister all x:Name entries from the existing NameScope
        //    AND clear the internal registration dictionary via reflection.
        if (target is BindableObject bo)
        {
            try
            {
                var existingScope = NameScope.GetNameScope(bo) as NameScope;
                if (existingScope != null)
                {
                    // NameScope stores names in an internal dictionary.
                    // We need to clear it so the parser doesn't see stale registrations.
                    // Try reflection to clear the internal dictionary.
                    var internalField = typeof(NameScope).GetField("_names",
                        BindingFlags.NonPublic | BindingFlags.Instance)
                        ?? typeof(NameScope).GetField("_names",
                            BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.FlattenHierarchy);

                    if (internalField != null)
                    {
                        var dict = internalField.GetValue(existingScope);
                        if (dict != null)
                        {
                            var clearMethod = dict.GetType().GetMethod("Clear");
                            clearMethod?.Invoke(dict, null);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: NameScope clear warning: {ex.Message}");
            }
        }

        // 2. Clear content and collections BEFORE setting a new NameScope.
        //    Setting a new NameScope on a live view can trigger auto-registration
        //    of existing named children, so we remove them beforehand.
        if (target is ContentPage page)
        {
            page.Content = null;
            try { page.ToolbarItems.Clear(); } catch { }
            try { if (page.MenuBarItems != null) page.MenuBarItems.Clear(); } catch { }
        }
        else if (target is ContentView cv)
        {
            cv.Content = null;
        }
        else if (target is ScrollView sv)
        {
            sv.Content = null;
        }
        else if (target is Border border)
        {
            border.Content = null;
        }

        // 3. Also clear Resources — they can hold x:Name references and DataTemplates
        //    that may conflict on re-parse.
        if (target is VisualElement ve)
        {
            try
            {
                // Don't clear app-level resources, only page/view-level
                if (ve.Resources != null && ve.Resources.Count > 0)
                    ve.Resources.Clear();
            }
            catch { }
        }

        // 4. Clear Behaviors and Triggers — they may hold named references
        if (target is VisualElement veTarget)
        {
            try { if (veTarget.Behaviors.Count > 0) veTarget.Behaviors.Clear(); } catch { }
            try { if (veTarget.Triggers.Count > 0) veTarget.Triggers.Clear(); } catch { }
        }

        // 5. Now set a fresh NameScope so the parser can register x:Name elements cleanly
        if (target is BindableObject boFinal)
            NameScope.SetNameScope(boFinal, new NameScope());

        // 6. Also null out any x:Name-backed fields on the target so they don't
        //    hold stale references. The XAML parser will re-populate them.
        ClearNamedFields(target);
    }

    /// <summary>
    /// Null out all private/internal instance fields that match the naming pattern
    /// for x:Name-backed code-behind fields (typically the name itself, or prefixed with underscore).
    /// This prevents stale references and allows the XAML parser to re-assign them cleanly.
    /// </summary>
    private static void ClearNamedFields(object target)
    {
        try
        {
            var type = target.GetType();
            var fields = type.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            foreach (var field in fields)
            {
                // Skip backing fields for properties, event handlers, and infrastructure
                if (field.Name.StartsWith("<") || field.Name.StartsWith("_delegate"))
                    continue;

                // Only clear fields whose type derives from Element (MAUI UI elements)
                if (!typeof(Element).IsAssignableFrom(field.FieldType))
                    continue;

                try { field.SetValue(target, null); }
                catch { }
            }
        }
        catch { }
    }

    /// <summary>
    /// Restore content if a reload strategy fails (so subsequent strategies can still work).
    /// </summary>
    private static void RestoreViewContent(object target, View savedContent, IList<ToolbarItem> savedToolbarItems)
    {
        if (target is ContentPage rp)
        {
            rp.Content = savedContent;
            if (savedToolbarItems != null)
            {
                try { rp.ToolbarItems.Clear(); } catch { }
                foreach (var item in savedToolbarItems)
                    try { rp.ToolbarItems.Add(item); } catch { }
            }
        }
        else if (target is ContentView rc)
            rc.Content = savedContent;
    }

    /// <summary>Save content/toolbar items for rollback on failure.</summary>
    private static void SaveViewState(object target, out View savedContent, out IList<ToolbarItem> savedToolbarItems)
    {
        savedContent = null;
        savedToolbarItems = null;
        if (target is ContentPage page)
        {
            savedContent = page.Content;
            savedToolbarItems = page.ToolbarItems.ToList();
        }
        else if (target is ContentView cv)
        {
            savedContent = cv.Content;
        }
    }

    private static object CreateReplacement(Type viewType, object target, string resourcePath, out object bindingContext)
    {
        bindingContext = target is BindableObject targetBindable
            ? targetBindable.BindingContext
            : null;

        object replacement;
        try
        {
            replacement = Activator.CreateInstance(viewType);
        }
        catch (MissingMethodException)
        {
            return null;
        }

        // When source gen is active with EnableMauiXamlDiagnostics=true, the
        // constructor → InitializeComponent → source gen check → ResourceProvider2
        // already picks up the cached XAML.  TryReloadViaXamlString is a safety net
        // for the case where the source gen check missed (e.g. path mismatch or
        // diagnostics not enabled).
        TryReloadViaXamlString(replacement, viewType, resourcePath);

        if (replacement is BindableObject replacementBindable)
            replacementBindable.BindingContext = bindingContext;

        return replacement;
    }

    private static bool TryCollectStructuralTree(BindableObject root, out List<BindableObject> tree)
    {
        tree = new List<BindableObject>();
        return TryCollectStructuralTree(root, tree);
    }

    private static bool TryCollectStructuralTree(BindableObject item, List<BindableObject> tree)
    {
        tree.Add(item);

        foreach (var child in GetStructuralChildren(item))
        {
            if (child is not BindableObject bindableChild)
                return false;

            if (!TryCollectStructuralTree(bindableChild, tree))
                return false;
        }

        return true;
    }

    private static IEnumerable<object> GetStructuralChildren(BindableObject item)
    {
        switch (item)
        {
            case ContentPage page when page.Content != null:
                yield return page.Content;
                yield break;
            case ContentView contentView when contentView.Content != null:
                yield return contentView.Content;
                yield break;
            case ScrollView scrollView when scrollView.Content != null:
                yield return scrollView.Content;
                yield break;
            case Border border when border.Content != null:
                yield return border.Content;
                yield break;
            case Layout layout:
                foreach (var child in layout.Children)
                    yield return child;
                yield break;
            default:
                var contentProperty = item.GetType().GetProperty("Content", BindingFlags.Public | BindingFlags.Instance);
                if (contentProperty?.GetIndexParameters().Length == 0 && contentProperty.PropertyType != typeof(string))
                {
                    object content = null;
                    try
                    {
                        content = contentProperty.GetValue(item);
                    }
                    catch
                    {
                    }

                    if (content != null && !ReferenceEquals(content, item))
                        yield return content;
                }

                yield break;
        }
    }

    private static bool HaveSameStructure(List<BindableObject> targetTree, List<BindableObject> replacementTree)
    {
        if (targetTree.Count != replacementTree.Count)
            return false;

        for (var i = 0; i < targetTree.Count; i++)
        {
            if (targetTree[i].GetType() != replacementTree[i].GetType())
                return false;
        }

        return true;
    }

    private static bool TryMoveContent(object source, object target)
    {
        switch (target)
        {
            case ContentPage targetPage when source is ContentPage sourcePage:
                // Move Content
                var pageContent = sourcePage.Content;
                if (!ReferenceEquals(targetPage.Content, pageContent))
                {
                    sourcePage.Content = null;
                    targetPage.Content = null;
                    targetPage.Content = pageContent;
                }
                // Move ToolbarItems
                try
                {
                    var sourceItems = sourcePage.ToolbarItems.ToList();
                    sourcePage.ToolbarItems.Clear();
                    targetPage.ToolbarItems.Clear();
                    foreach (var item in sourceItems)
                        targetPage.ToolbarItems.Add(item);
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[MauiDeploy] Hot Reload: ToolbarItems move failed: {ex.Message}");
                }
                return true;
            case ContentView targetContentView when source is ContentView sourceContentView:
                var contentViewContent = sourceContentView.Content;
                if (ReferenceEquals(targetContentView.Content, contentViewContent))
                    return true;
                sourceContentView.Content = null;
                targetContentView.Content = null;
                targetContentView.Content = contentViewContent;
                return true;
            case ScrollView targetScrollView when source is ScrollView sourceScrollView:
                var scrollContent = sourceScrollView.Content;
                if (ReferenceEquals(targetScrollView.Content, scrollContent))
                    return true;
                sourceScrollView.Content = null;
                targetScrollView.Content = null;
                targetScrollView.Content = scrollContent;
                return true;
            case Border targetBorder when source is Border sourceBorder:
                var borderContent = sourceBorder.Content;
                if (ReferenceEquals(targetBorder.Content, borderContent))
                    return true;
                sourceBorder.Content = null;
                targetBorder.Content = null;
                targetBorder.Content = borderContent;
                return true;
            default:
                return false;
        }
    }

    private static void CopyNameScope(BindableObject source, BindableObject target)
    {
        var nameScope = NameScope.GetNameScope(source);
        if (nameScope != null)
            target.SetValue(NameScope.NameScopeProperty, nameScope);
    }

    private static void CopyRootBindableValues(BindableObject source, BindableObject target)
    {
        foreach (var property in GetBindableProperties(source.GetType()))
        {
            if (!source.IsSet(property) || ShouldSkipRootBindableProperty(property))
                continue;

            if (IsReadOnlyPropertyInfo?.GetValue(property) is true)
                continue;

            try
            {
                var value = source.GetValue(property);
                if (value is Element)
                    continue;
                target.SetValue(property, value);
            }
            catch
            {
                // Some bindable properties are one-shot or root-specific. Keep reload best-effort.
            }
        }
    }

    private static int CopyInPlaceBindableValues(BindableObject source, BindableObject target)
    {
        var changedValues = 0;
        foreach (var property in GetBindableProperties(source.GetType()))
        {
            if (!source.IsSet(property) || ShouldSkipInPlaceBindableProperty(property))
                continue;

            try
            {
                var sourceValue = source.GetValue(property);
                var targetValue = target.GetValue(property);
                var sourceIsBound = IsBound(source, property);
                var targetIsBound = IsBound(target, property);

                if (sourceIsBound || targetIsBound)
                {
                    if (sourceIsBound != targetIsBound || !Equals(sourceValue, targetValue))
                        return -1;

                    continue;
                }

                if (Equals(sourceValue, targetValue))
                    continue;

                target.SetValue(property, sourceValue);
                changedValues++;
            }
            catch
            {
                return -1;
            }
        }

        return changedValues;
    }

    private static bool IsBound(BindableObject item, BindableProperty property)
    {
        try
        {
            return GetIsBoundMethod?.Invoke(item, new object[] { property }) is bool value && value;
        }
        catch
        {
            return false;
        }
    }

    private static bool DataTemplateContainsMatchingView(object templateOrSelector, string resourcePath, Type targetType)
    {
        try
        {
            DataTemplate template = null;

            if (templateOrSelector is DataTemplateSelector)
            {
                // Can't probe without data context — skip rather than blindly reset
                Debug.WriteLine($"[MauiDeploy] Hot Reload: skipping DataTemplateSelector (cannot probe without data)");
                return false;
            }

            template = templateOrSelector as DataTemplate;
            if (template == null)
                return false;

            var content = template.CreateContent();
            if (content == null)
                return false;

            if (content is ViewCell cell)
                content = cell.View;

            if (content == null)
                return false;

            // Check the root element
            var contentType = content.GetType();
            if (IsMatchingReloadTarget(contentType, targetType, resourcePath))
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: template probe — root {contentType.Name} matches {Path.GetFileName(resourcePath)}");
                return true;
            }

            // Walk descendants to see if the changed view is nested inside the template
            if (content is BindableObject bindableContent)
            {
                var seen = new HashSet<object>(ReferenceEqualityComparer.Instance) { bindableContent };
                foreach (var descendant in EnumerateBindableDescendants(bindableContent, seen))
                {
                    var descType = descendant.GetType();
                    if (IsMatchingReloadTarget(descType, targetType, resourcePath))
                    {
                        Debug.WriteLine($"[MauiDeploy] Hot Reload: template probe — descendant {descType.Name} (XamlPath='{GetXamlFilePath(descType)}') matches {Path.GetFileName(resourcePath)}");
                        return true;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] Hot Reload: DataTemplateContainsMatchingView probe failed: {ex.Message}");
            return false;
        }

        return false;
    }

    private static BindableProperty[] GetDataTemplateProperties(Type type)
    {
        return DataTemplatePropertiesByType.GetOrAdd(type, static t =>
        {
            var result = new List<BindableProperty>();
            foreach (var property in GetBindableProperties(t))
            {
                if (typeof(DataTemplate).IsAssignableFrom(property.ReturnType) ||
                    typeof(DataTemplateSelector).IsAssignableFrom(property.ReturnType))
                    result.Add(property);
            }
            return result.ToArray();
        });
    }

    private static BindableProperty[] GetBindableProperties(Type type)
    {
        return BindablePropertiesByType.GetOrAdd(type, CreateBindableProperties);
    }

    private static BindableProperty[] CreateBindableProperties(Type type)
    {
        var visited = new HashSet<BindableProperty>();
        var properties = new List<BindableProperty>();
        for (var current = type; current != null; current = current.BaseType)
        {
            foreach (var field in current.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly))
            {
                if (!typeof(BindableProperty).IsAssignableFrom(field.FieldType))
                    continue;

                if (field.GetValue(null) is BindableProperty property && visited.Add(property))
                    properties.Add(property);
            }
        }

        return properties.ToArray();
    }

    private static bool ShouldSkipRootBindableProperty(BindableProperty property)
    {
        if (property == BindableObject.BindingContextProperty)
            return true;

        switch (property.PropertyName)
        {
            case "Content":
            case "AutomationId":
            case "Navigation":
            case "Title":
                return true;
        }

        // Skip readonly properties (MAUI internal flag)
        try
        {
            if (IsReadOnlyPropertyInfo?.GetValue(property) is true)
                return true;
        }
        catch { }

        return false;
    }

    private static bool ShouldSkipInPlaceBindableProperty(BindableProperty property)
    {
        return property == BindableObject.BindingContextProperty ||
            property.PropertyName == "AutomationId" ||
            StructuralPropertyNames.Contains(property.PropertyName);
    }

    private static void CopyGeneratedFields(object source, object target, Type viewType)
    {
        foreach (var field in GetGeneratedFields(viewType))
        {
            try
            {
                field.SetValue(target, field.GetValue(source));
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[MauiDeploy] Hot Reload: skipped field {field.Name} — {UnwrapException(ex).Message}");
            }
        }
    }

    private static FieldInfo[] GetGeneratedFields(Type type)
    {
        return GeneratedFieldsByType.GetOrAdd(type, CreateGeneratedFields);
    }

    private static FieldInfo[] CreateGeneratedFields(Type type)
    {
        var fields = new List<FieldInfo>();
        for (var current = type; current != null; current = current.BaseType)
        {
            foreach (var field in current.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                if (!field.IsInitOnly && IsGeneratedField(field))
                    fields.Add(field);
            }
        }

        return fields.ToArray();
    }

    private static bool IsGeneratedField(FieldInfo field)
    {
        foreach (var attribute in field.GetCustomAttributes(inherit: false))
        {
            if (attribute.GetType().FullName == "System.CodeDom.Compiler.GeneratedCodeAttribute")
                return true;
        }

        return false;
    }

    private static string NormalizeXaml(string xaml)
    {
        return string.IsNullOrEmpty(xaml) || xaml[0] != (char)0xFEFF
            ? xaml
            : xaml.Substring(1);
    }

    private static Exception UnwrapException(Exception exception)
    {
        while (exception is TargetInvocationException && exception.InnerException != null)
            exception = exception.InnerException;

        return exception;
    }

    private static string FormatException(Exception exception)
    {
        var message = SanitizeForResponse(exception.Message ?? string.Empty, 200);
        var frame = string.Empty;
        var stack = exception.StackTrace;
        if (!string.IsNullOrEmpty(stack))
        {
            var newline = stack.IndexOf((char)10);
            var firstLine = newline >= 0 ? stack.Substring(0, newline) : stack;
            firstLine = SanitizeForResponse(firstLine.Trim(), 240);
            if (firstLine.Length > 0)
                frame = " @ " + firstLine;
        }

        return exception.GetType().Name + ": " + message + frame;
    }

    private static string SanitizeForResponse(string value, int maxLength)
    {
        if (string.IsNullOrEmpty(value))
            return string.Empty;

        value = value
            .Replace((char)13, (char)32)
            .Replace((char)10, (char)32)
            .Replace((char)39, (char)32);

        if (value.Length > maxLength)
            value = value.Substring(0, maxLength);

        return value;
    }

    private static IEnumerable GetActiveViews()
    {
        var field = typeof(MauiHotReloadHelper).GetField("ActiveViews", BindingFlags.NonPublic | BindingFlags.Static);
        if (field?.GetValue(null) is IEnumerable activeViews)
            return activeViews;

        return Array.Empty<object>();
    }

    private static List<BindableObject> GetWindowPages()
    {
        var pages = new List<BindableObject>();
        var app = Application.Current;
        if (app == null)
            return pages;

        foreach (var window in app.Windows)
        {
            if (window?.Page == null)
                continue;

            pages.Add(window.Page);

            // Shell navigation: walk ShellItems → ShellSections → ShellContents → ContentPage
            if (window.Page is Shell shell)
            {
                try
                {
                    foreach (var item in shell.Items)
                    {
                        if (item == null) continue;
                        pages.Add(item);
                        foreach (var section in item.Items)
                        {
                            if (section == null) continue;
                            pages.Add(section);
                            foreach (var content in section.Items)
                            {
                                if (content == null) continue;
                                pages.Add(content);
                                // ShellContent.ContentTemplate may produce a Page
                                try
                                {
                                    var contentPage = content.GetType()
                                        .GetProperty("ContentCache", BindingFlags.NonPublic | BindingFlags.Instance)?
                                        .GetValue(content) as Page;
                                    if (contentPage != null)
                                        pages.Add(contentPage);
                                }
                                catch { }
                            }
                        }
                    }

                    // Also include Shell's currently visible page
                    if (shell.CurrentPage != null)
                        pages.Add(shell.CurrentPage);

                    // Walk Shell navigation stack
                    try
                    {
                        foreach (var page in shell.Navigation.NavigationStack)
                            if (page != null) pages.Add(page);
                    }
                    catch { }
                    try
                    {
                        foreach (var modal in shell.Navigation.ModalStack)
                            if (modal != null) pages.Add(modal);
                    }
                    catch { }
                }
                catch { }
                continue;
            }

            INavigation nav = null;
            try { nav = window.Page.Navigation; } catch { }
            if (nav == null)
                continue;

            try
            {
                foreach (var page in nav.NavigationStack)
                    if (page != null)
                        pages.Add(page);
            }
            catch { }

            try
            {
                foreach (var modal in nav.ModalStack)
                {
                    if (modal == null)
                        continue;

                    pages.Add(modal);

                    if (modal is NavigationPage navPage)
                    {
                        try
                        {
                            foreach (var p in navPage.Navigation.NavigationStack)
                                if (p != null)
                                    pages.Add(p);
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        return pages;
    }

    private static IEnumerable<object> GetReloadCandidates(IEnumerable activeViews)
    {
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        foreach (var root in activeViews)
        {
            if (root == null || !seen.Add(root))
                continue;

            yield return root;

            if (root is not BindableObject bindableRoot)
                continue;

            foreach (var descendant in EnumerateBindableDescendants(bindableRoot, seen))
                yield return descendant;
        }

        // Fallback: walk Application.Current.Windows + modal stacks
        // Pages created before MauiHotReloadHelper.IsEnabled was set won't be in ActiveViews
        foreach (var page in GetWindowPages())
        {
            if (!seen.Add(page))
                continue;

            yield return page;

            foreach (var descendant in EnumerateBindableDescendants(page, seen))
                yield return descendant;
        }

        // Presentation services can hold live controls outside the normal MAUI window tree.
        foreach (var root in GetKnownPresentationRoots())
        {
            if (root == null || !seen.Add(root))
                continue;

            yield return root;

            if (root is not BindableObject bindableRoot)
                continue;

            foreach (var descendant in EnumerateBindableDescendants(bindableRoot, seen))
                yield return descendant;
        }
    }

    private static IEnumerable<object> GetKnownPresentationRoots()
    {
        foreach (var root in GetStaticEnumerableMember(
            "DIPS.Mobile.UI.Components.BottomSheets.BottomSheetService",
            "BottomSheetStack"))
            yield return root;
    }

    private static IEnumerable<object> GetStaticEnumerableMember(string typeFullName, string memberName)
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type serviceType;
            try
            {
                serviceType = assembly.GetType(typeFullName, throwOnError: false, ignoreCase: false);
            }
            catch
            {
                continue;
            }

            if (serviceType == null)
                continue;

            object value = null;
            try
            {
                var property = serviceType.GetProperty(memberName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                value = property?.GetValue(null);
            }
            catch { }

            if (value == null)
            {
                try
                {
                    var field = serviceType.GetField(memberName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                    value = field?.GetValue(null);
                }
                catch { }
            }

            if (value is not IEnumerable enumerable)
                yield break;

            foreach (var item in enumerable)
            {
                if (item != null)
                    yield return item;
            }

            yield break;
        }
    }

    private static IEnumerable<object> EnumerateBindableDescendants(BindableObject root, HashSet<object> seen)
    {
        var stack = new Stack<BindableObject>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            var current = stack.Pop();
            foreach (var child in GetStructuralChildren(current))
            {
                if (child is not BindableObject bindableChild || !seen.Add(bindableChild))
                    continue;

                yield return bindableChild;
                stack.Push(bindableChild);
            }
        }
    }

    private static bool TryGetResource(string resourcePath, out string xaml, out string matchedKey)
    {
        if (Resources.TryGetValue(resourcePath, out xaml))
        {
            matchedKey = resourcePath;
            return true;
        }

        foreach (var entry in Resources)
        {
            if (resourcePath.EndsWith('/' + entry.Key, StringComparison.OrdinalIgnoreCase) ||
                entry.Key.EndsWith('/' + resourcePath, StringComparison.OrdinalIgnoreCase))
            {
                xaml = entry.Value;
                matchedKey = entry.Key;
                return true;
            }
        }

        xaml = string.Empty;
        matchedKey = string.Empty;
        return false;
    }

    private static string NormalizeResourcePath(string path)
    {
        return path.Replace((char)92, '/').TrimStart('/');
    }
}
`;
}

export interface BuildResult {
    success: boolean;
    durationMs: number;
    cancelled?: boolean;
}

async function runBuildCommand(
    terminal: vscode.Terminal,
    commandFactory: (logArgs: string) => string,
    timeout = 600_000,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void
): Promise<BuildResult> {
    const errorLogFile = tempFilePath('.errors.log');
    const progressLogFile = tempFilePath('.progress.log');

    try { fs.rmSync(errorLogFile, { force: true }); } catch { }
    try { fs.rmSync(progressLogFile, { force: true }); } catch { }

    const logArgs = [
        shellQuote(`-flp:logfile=${errorLogFile};errorsonly;verbosity=normal`),
        shellQuote(`-flp2:logfile=${progressLogFile};verbosity=detailed`)
    ].join(' ');

    try {
        const cmd = commandFactory(logArgs);
        const hasNoRestore = /dotnet build --no-restore /.test(cmd);

        // If --no-restore is present, suppress the error popup on first attempt
        // so we can silently retry with restore before bothering the user.
        const result = await runTerminalCommand(
            terminal, cmd, timeout, errorLogFile,
            hasNoRestore ? captureFailureSilently : showBuildErrors,
            token, onProgress, progressLogFile
        );

        // If build failed and we used --no-restore, always retry with restore
        if (!result.success && !result.cancelled && hasNoRestore) {
            try { fs.rmSync(errorLogFile, { force: true }); } catch { }
            try { fs.rmSync(progressLogFile, { force: true }); } catch { }
            const retryCmd = cmd.replace(/dotnet build --no-restore /, 'dotnet build ');
            sendSilent(terminal, `echo '⟳ Retrying with NuGet restore...'`);
            return await runTerminalCommand(terminal, retryCmd, timeout, errorLogFile, showBuildErrors, token, onProgress, progressLogFile);
        }

        return result;
    } finally {
        try { fs.rmSync(errorLogFile, { force: true }); } catch { }
        try { fs.rmSync(progressLogFile, { force: true }); } catch { }
    }
}

/** Capture failure context without showing any UI — used for the first
 *  --no-restore attempt so we can silently retry with restore. */
function captureFailureSilently(output: string, exitCode: number | undefined, command: string) {
    lastBuildFailure = {
        command,
        exitCode,
        errors: extractBuildErrors(output),
        output,
        failedAt: new Date(),
    };
}

/** Check if build failure was caused by missing NuGet restore. */
function needsRestore(errorOutput: string): boolean {
    const markers = [
        'assets file',
        'project.assets.json',
        'run a nuget package restore',
        'NETSDK1004',
        'NU1301',
    ];
    const lower = errorOutput.toLowerCase();
    return markers.some(m => lower.includes(m));
}

async function runTerminalCommand(
    terminal: vscode.Terminal,
    command: string,
    timeout = 600_000,
    errorLogFile?: string,
    onFailure: (output: string, exitCode: number | undefined, command: string) => void = showBuildErrors,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    progressLogFile?: string
): Promise<BuildResult> {
    const exitCodeFile = tempFilePath('.exit');
    const started = Date.now();

    try { fs.rmSync(exitCodeFile, { force: true }); } catch { }
    buildErrorsOutput?.clear();
    lastBuildFailure = undefined;

    // Write the command to a temp script so the terminal only echoes
    // ". /tmp/script.sh" instead of the entire (very long) build command.
    // The script starts by erasing that echoed line with ANSI escape codes.
    // A trap ensures Ctrl+C still writes the exit code file (zsh aborts sourced
    // scripts on SIGINT, so the normal printf after the command wouldn't run).
    const scriptFile = tempFilePath('.sh');
    const exitCapture = `printf '%s' $_ec > ${shellQuote(exitCodeFile)}`;
    const trapLine = `trap 'printf "%s" 130 > ${shellQuote(exitCodeFile)}; trap - INT' INT`;
    // Save $? into _ec BEFORE `trap - INT` — in zsh, trap is a builtin that
    // returns 0, so $? would be clobbered if we read it after the trap reset.
    fs.writeFileSync(scriptFile, `printf '\x1b[A\x1b[2K'\n${trapLine}\n${command}\n_ec=$?; trap - INT\n${exitCapture}\n`, 'utf8');
    terminal.sendText(`. ${shellQuote(scriptFile)}; rm -f ${shellQuote(scriptFile)}`);
    const exitCode = await waitForExitCodeFile(exitCodeFile, timeout, terminal, token, onProgress, progressLogFile);
    const durationMs = Date.now() - started;
    const output = errorLogFile ? readTextFile(errorLogFile) : '';

    try { fs.rmSync(exitCodeFile, { force: true }); } catch { }

    const cancelled = exitCode === undefined || exitCode === 130;
    if (exitCode !== 0 && !cancelled) {
        onFailure(output, exitCode, command);
    }

    return { success: exitCode === 0, durationMs, cancelled };
}

/** MSBuild properties that speed up Android Debug builds by disabling
 *  AOT compilation, IL trimming, and IL linking — these are Release-only
 *  optimizations but some project templates enable them globally. */
function androidFastBuildProps(config: string): string[] {
    if (config.toLowerCase() !== 'debug') { return []; }
    return [
        '-p:RunAOTCompilation=false',
        '-p:PublishTrimmed=false',
        '-p:AndroidLinkMode=None',
        '-p:AndroidEnableProfiledAot=false',
        '-p:AndroidPackageFormat=apk',
        '-p:AndroidUseAssemblyStore=false',
        '-p:AndroidEnableAssemblyCompression=false',
    ];
}

/** MSBuild properties that speed up iOS physical-device Debug builds by using
 *  the Mono interpreter instead of full AOT native compilation. */
function iosFastBuildProps(config: string, deviceType?: 'simulator' | 'physical'): string[] {
    if (config.toLowerCase() !== 'debug' || deviceType !== 'physical') { return []; }
    return [
        '-p:UseInterpreter=true',
        '-p:MtouchLink=None',
    ];
}

let _tempSeq = 0;
function tempFilePath(suffix: string): string {
    return path.join(
        os.tmpdir(),
        `mauideploy-${process.pid}-${Date.now()}-${(++_tempSeq).toString(36)}${suffix}`
    );
}

function showBuildErrors(output: string, exitCode: number | undefined, command: string) {
    const errors = extractBuildErrors(output);
    const channel = getBuildErrorsOutput();

    lastBuildFailure = {
        command,
        exitCode,
        errors,
        output,
        failedAt: new Date(),
    };

    channel.clear();
    channel.appendLine('MAUI Deploy build failed');
    channel.appendLine(`Exit code: ${exitCode ?? 'timed out'}`);
    channel.appendLine('');

    if (errors.length === 0) {
        channel.appendLine('No compiler error lines were found in the captured build output.');
        channel.appendLine('Open the build terminal for the full command output.');
    } else {
        channel.appendLine(`${errors.length} error${errors.length === 1 ? '' : 's'} found:`);
        channel.appendLine('');
        for (const error of errors) {
            channel.appendLine(error);
        }
    }

    channel.show(true);

    const message = errors.length > 0
        ? `MAUI Deploy: Build failed with ${errors.length} error${errors.length === 1 ? '' : 's'}.`
        : 'MAUI Deploy: Build failed. No compiler error lines were found.';
    vscode.window.showErrorMessage(message, 'Ask Copilot to Fix', 'Open Build Errors', 'Open Terminal').then(choice => {
        if (choice === 'Ask Copilot to Fix') {
            void askCopilotToFixLastBuildFailure();
        } else if (choice === 'Open Build Errors') {
            channel.show(true);
        } else if (choice === 'Open Terminal') {
            getBuildTerminal(false).show();
        }
    });
}

function showTestFailure(_output: string, exitCode: number | undefined) {
    const message = exitCode === undefined
        ? 'MAUI Deploy: Tests timed out.'
        : 'MAUI Deploy: Tests failed.';
    vscode.window.showErrorMessage(message, 'Open Terminal').then(choice => {
        if (choice === 'Open Terminal') {
            getBuildTerminal(false).show();
        }
    });
}

export async function askCopilotToFixLastBuildFailure(): Promise<void> {
    if (!lastBuildFailure) {
        vscode.window.showInformationMessage('MAUI Deploy: No failed build has been captured yet.');
        return;
    }

    const prompt = createCopilotRepairPrompt(lastBuildFailure);
    if (await openCopilotChat(prompt)) {
        return;
    }

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(
        'MAUI Deploy: Could not open Copilot Chat. The build-fix prompt was copied to the clipboard.'
    );
}

async function openCopilotChat(prompt: string): Promise<boolean> {
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes('workbench.action.chat.open')) {
        return false;
    }

    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            mode: 'agent',
            query: prompt,
            isPartialQuery: false,
        });
        return true;
    } catch {
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt,
                isPartialQuery: false,
            });
            return true;
        } catch {
            return false;
        }
    }
}

function createCopilotRepairPrompt(failure: BuildFailureContext): string {
    const workspace = vscode.workspace.workspaceFolders
        ?.map(folder => folder.uri.fsPath)
        .join('\n') || 'No workspace folder detected';

    return [
        '@workspace Fix this .NET MAUI build failure in the current workspace.',
        '',
        'Please make the smallest correct code changes needed, then run the relevant build command again to verify the fix.',
        '',
        'Workspace:',
        '```text',
        workspace,
        '```',
        '',
        'Failed at:',
        failure.failedAt.toLocaleString(),
        '',
        'Exit code:',
        `${failure.exitCode ?? 'timed out'}`,
        '',
        'Build command:',
        '```sh',
        failure.command,
        '```',
        '',
        'Captured build errors:',
        '```text',
        formatErrorsForPrompt(failure.errors),
        '```',
        '',
        'Captured MSBuild error log:',
        '```text',
        truncateForPrompt(failure.output, 12000),
        '```',
    ].join('\n');
}

function formatErrorsForPrompt(errors: string[]): string {
    if (errors.length === 0) {
        return 'No compiler error lines were found in the captured MSBuild error log.';
    }

    const maxErrors = 50;
    const visibleErrors = errors.slice(0, maxErrors);
    const omittedCount = errors.length - visibleErrors.length;
    const formatted = visibleErrors.map(error => `- ${error}`).join('\n');

    return omittedCount > 0
        ? `${formatted}\n... ${omittedCount} more error${omittedCount === 1 ? '' : 's'} omitted ...`
        : formatted;
}

function truncateForPrompt(value: string, maxCharacters: number): string {
    const text = stripAnsi(value).trim();
    if (!text) {
        return 'No MSBuild error log content was captured.';
    }
    if (text.length <= maxCharacters) {
        return text;
    }

    return `${text.slice(0, maxCharacters)}\n... truncated ${text.length - maxCharacters} characters ...`;
}

function extractBuildErrors(output: string): string[] {
    const seen = new Set<string>();
    const errors: string[] = [];

    for (const rawLine of output.split(/\r?\n/)) {
        const line = stripAnsi(rawLine).trim();
        if (!line || isBuildSummaryLine(line) || !isErrorLine(line) || seen.has(line)) { continue; }

        seen.add(line);
        errors.push(line);
    }

    return errors;
}

function isErrorLine(line: string): boolean {
    return /(^|[\s:])(?:fatal\s+)?error\s*(?:[A-Z][A-Z0-9]*\d+)?:/i.test(line);
}

function isBuildSummaryLine(line: string): boolean {
    return /\b(?:warning|error)\(s\)\b/i.test(line);
}

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function readTextFile(filePath: string): string {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function estimateMsBuildLogProgress(logSizeBytes: number): number {
    if (logSizeBytes <= 0) { return 0; }

    const scaleBytes = 350_000;
    const saturationBytes = 8_000_000;
    const normalized = Math.log1p(logSizeBytes / scaleBytes) / Math.log1p(saturationBytes / scaleBytes);
    return Math.min(82, 82 * normalized);
}

async function waitForExitCodeFile(
    exitCodeFile: string,
    timeout: number,
    terminal?: vscode.Terminal,
    token?: vscode.CancellationToken,
    onProgress?: (elapsedMs: number, buildPercent: number) => void,
    progressLogFile?: string
): Promise<number | undefined> {
    const started = Date.now();

    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (token?.isCancellationRequested) {
                clearInterval(timer);
                resolve(undefined);
                return;
            }

            // Terminal was closed/killed by the user
            if (terminal?.exitStatus !== undefined) {
                clearInterval(timer);
                resolve(undefined);
                return;
            }

            if (onProgress) {
                let buildPercent = -1;
                if (progressLogFile) {
                    try {
                        const size = fs.statSync(progressLogFile).size;
                        buildPercent = estimateMsBuildLogProgress(size);
                    } catch { buildPercent = 0; }
                }
                onProgress(Date.now() - started, buildPercent);
            }

            if (fs.existsSync(exitCodeFile)) {
                clearInterval(timer);
                const content = fs.readFileSync(exitCodeFile, 'utf8').trim();
                resolve(Number.parseInt(content, 10));
                return;
            }

            if (Date.now() - started >= timeout) {
                clearInterval(timer);
                resolve(undefined);
            }
        }, 250);
    });
}

function shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Send a command to the terminal without echoing the command line itself. */
function sendSilent(terminal: vscode.Terminal, command: string): void {
    const scriptFile = tempFilePath('.sh');
    fs.writeFileSync(scriptFile, `printf '\x1b[A\x1b[2K'\n${command}\n`, 'utf8');
    terminal.sendText(`. ${shellQuote(scriptFile)}; rm -f ${shellQuote(scriptFile)}`);
}

function shellEnvAssignment(name: string, value: string): string {
    return `${name}=${shellQuote(value)}`;
}

export function disposeTerminals() {
    for (const terminal of buildTerminals.values()) {
        terminal.dispose();
    }
    buildTerminals.clear();
    logTerminal?.dispose();
    buildErrorsOutput?.dispose();
}
