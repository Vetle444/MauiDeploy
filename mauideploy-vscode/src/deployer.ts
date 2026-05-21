import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Platform, Device, findIosAppBundle, findAndroidApk, getAndroidPackageId, getBundleId } from './devices';

let buildTerminal: vscode.Terminal | undefined;
let logTerminal: vscode.Terminal | undefined;
let hotReloadTerminal: vscode.Terminal | undefined;
let hotReloadCloseListener: vscode.Disposable | undefined;
let hotReloadRunning = false;
let buildErrorsOutput: vscode.OutputChannel | undefined;
const hotReloadStatusEmitter = new vscode.EventEmitter<void>();

export const onDidChangeHotReloadStatus = hotReloadStatusEmitter.event;

interface BuildFailureContext {
    command: string;
    exitCode: number | undefined;
    errors: string[];
    output: string;
    failedAt: Date;
}

let lastBuildFailure: BuildFailureContext | undefined;

function getBuildTerminal(): vscode.Terminal {
    if (buildTerminal && !buildTerminal.exitStatus) { return buildTerminal; }
    buildTerminal = vscode.window.createTerminal({
        name: 'MAUI Deploy — Build',
        iconPath: new vscode.ThemeIcon('rocket')
    });
    return buildTerminal;
}

function getLogTerminal(): vscode.Terminal {
    if (logTerminal && !logTerminal.exitStatus) { logTerminal.dispose(); }
    logTerminal = vscode.window.createTerminal({
        name: 'MAUI Deploy — Logs',
        iconPath: new vscode.ThemeIcon('output')
    });
    return logTerminal;
}

function getHotReloadTerminal(): vscode.Terminal {
    if (hotReloadTerminal && !hotReloadTerminal.exitStatus) { return hotReloadTerminal; }
    hotReloadTerminal = vscode.window.createTerminal({
        name: 'MAUI Deploy — Hot Reload',
        iconPath: new vscode.ThemeIcon('flame')
    });

    hotReloadCloseListener?.dispose();
    hotReloadCloseListener = vscode.window.onDidCloseTerminal(closedTerminal => {
        if (closedTerminal !== hotReloadTerminal) { return; }

        hotReloadTerminal = undefined;
        hotReloadCloseListener?.dispose();
        hotReloadCloseListener = undefined;
        setHotReloadRunning(false);
    });

    return hotReloadTerminal;
}

function getBuildErrorsOutput(): vscode.OutputChannel {
    buildErrorsOutput ??= vscode.window.createOutputChannel('MAUI Deploy — Build Errors');
    return buildErrorsOutput;
}

export async function buildAndDeploy(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    if (platform.name === 'iOS') {
        return device.type === 'physical'
            ? buildAndDeployIosDevice(projectPath, platform, device, config)
            : buildAndDeployIos(projectPath, platform, device, config);
    }
    return buildAndDeployAndroid(projectPath, platform, device, config);
}

export async function deployFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    if (platform.name === 'iOS') {
        return device.type === 'physical'
            ? launchIosDeviceFromBin(projectPath, platform, device, config)
            : launchIosSimulatorFromBin(projectPath, platform, device, config);
    }
    return launchAndroidFromBin(projectPath, platform, device, config);
}

export function isHotReloadRunning(): boolean {
    return hotReloadRunning;
}

export async function startHotReload(
    projectPath: string,
    platform: Platform,
    device: Device
): Promise<boolean> {
    if (isHotReloadRunning()) {
        hotReloadTerminal?.show();
        return true;
    }

    const terminal = getHotReloadTerminal();
    terminal.show();
    setHotReloadRunning(true);
    terminal.sendText(createHotReloadCommand(projectPath, platform, device));
    return true;
}

export function stopHotReload(): void {
    const terminal = hotReloadTerminal;

    hotReloadCloseListener?.dispose();
    hotReloadCloseListener = undefined;
    hotReloadTerminal = undefined;
    setHotReloadRunning(false);
    terminal?.dispose();
}

function setHotReloadRunning(running: boolean): void {
    if (hotReloadRunning === running) { return; }
    hotReloadRunning = running;
    hotReloadStatusEmitter.fire();
}

function createHotReloadCommand(projectPath: string, platform: Platform, device: Device): string {
    const watchEnv = hotReloadWatchEnvironment(platform, device);
    const args = [
        ...watchEnv.map(([name, value]) => shellEnvAssignment(name, value)),
        'dotnet watch',
        `--project ${shellQuote(projectPath)}`,
        'build',
        '--',
        '-t:Run',
        `-p:TargetFramework=${shellQuote(platform.framework)}`,
        '-p:Configuration=Debug',
        ...hotReloadPlatformArgs(platform, device)
    ];

    return [
        `cd ${shellQuote(path.dirname(projectPath))}`,
        `echo '▶ Starting Hot Reload...'`,
        `echo 'Save supported C# or XAML changes to apply them. Stop this terminal to end Hot Reload.'`,
        args.join(' ')
    ].join(' && ');
}

function hotReloadWatchEnvironment(platform: Platform, device: Device): [string, string][] {
    const properties: [string, string][] = [
        ['TargetFramework', platform.framework],
        ['Configuration', 'Debug']
    ];

    if (platform.name === 'Android') {
        properties.push(['AdbTarget', `-s ${device.id}`]);
        return properties;
    }

    properties.push(
        ['MtouchDebug', 'true'],
        ['_DeviceName', device.type === 'physical' ? device.id : `:v2:udid=${device.id}`]
    );

    if (device.type === 'physical') {
        properties.push(['RuntimeIdentifier', 'ios-arm64']);
    }

    return properties;
}

function hotReloadPlatformArgs(platform: Platform, device: Device): string[] {
    if (platform.name === 'Android') {
        return [`/p:AdbTarget=${shellQuote(`-s ${device.id}`)}`];
    }

    if (device.type === 'physical') {
        return [
            '-p:MtouchDebug=true',
            '-p:RuntimeIdentifier=ios-arm64',
            `-p:_DeviceName=${shellQuote(device.id)}`
        ];
    }

    return [
        '-p:MtouchDebug=true',
        `-p:_DeviceName=${shellQuote(`:v2:udid=${device.id}`)}`
    ];
}

async function buildAndDeployIos(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const buildSucceeded = await runBuildCommand(terminal, errorLogFile => {
        const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config} ${msBuildErrorLoggerArg(errorLogFile)}`;
        return `echo '▶ Building...' && ${buildCmd}`;
    });
    if (!buildSucceeded) {
        return false;
    }

    const appPath = findIosAppBundle(projectPath, platform.framework, config);
    if (!appPath) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not find .app bundle.');
        return false;
    }

    return launchIosSimulatorApp(terminal, appPath, device);
}

async function launchIosSimulatorFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const appPath = findIosAppBundle(projectPath, platform.framework, config);
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
    terminal.sendText(`echo '▶ Installing...' && xcrun simctl install ${device.id} "${appPath}"`);

    const bundleId = await getBundleId(appPath);
    if (!bundleId) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not determine bundle ID.');
        return false;
    }

    terminal.sendText(
        `xcrun simctl terminate ${device.id} ${bundleId} 2>/dev/null; ` +
        `echo '▶ Launching...' && xcrun simctl launch ${device.id} ${bundleId}`
    );

    return true;
}

async function buildAndDeployIosDevice(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    // Build for physical device (needs RuntimeIdentifier ios-arm64)
    const buildSucceeded = await runBuildCommand(terminal, errorLogFile => {
        const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config} -r ios-arm64 ${msBuildErrorLoggerArg(errorLogFile)}`;
        return `echo '▶ Building for device...' && ${buildCmd}`;
    });
    if (!buildSucceeded) {
        return false;
    }

    const appPath = findIosAppBundle(projectPath, platform.framework, config);
    if (!appPath) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not find .app bundle.');
        return false;
    }

    return launchIosDeviceApp(terminal, appPath, device);
}

async function launchIosDeviceFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const appPath = findIosAppBundle(projectPath, platform.framework, config);
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
    terminal.sendText(
        `echo '▶ Installing on device...' && xcrun devicectl device install app --device ${device.id} "${appPath}"`
    );

    // Launch via devicectl
    terminal.sendText(
        `echo '▶ Launching...' && xcrun devicectl device process launch --device ${device.id} ${bundleId}`
    );

    return true;
}

async function buildAndDeployAndroid(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const succeeded = await runBuildCommand(terminal, errorLogFile => {
        const buildCmd = [
            `dotnet build "${projectPath}"`,
            `-t:Run`,
            `-f ${platform.framework}`,
            `-c ${config}`,
            `/p:AdbTarget="-s ${device.id}"`,
            msBuildErrorLoggerArg(errorLogFile)
        ].join(' ');
        return `echo '▶ Building & deploying...' && ${buildCmd}`;
    });
    return succeeded;
}

async function launchAndroidFromBin(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
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

    terminal.sendText(
        `echo '▶ Installing APK...' && adb -s ${device.id} install -r "${apkPath}" && ` +
        `echo '▶ Launching...' && adb -s ${device.id} shell monkey -p ${packageId} 1`
    );

    return true;
}

export function openLogViewer(platform: Platform, device: Device, projectPath: string) {
    const terminal = getLogTerminal();
    terminal.show();

    const appName = projectPath.replace(/.*\//, '').replace('.csproj', '');

    if (platform.name === 'iOS') {
        if (device.type === 'physical') {
            // Physical iOS device — use log show via devicectl or os_log
            terminal.sendText(
                `xcrun devicectl device process launch --device ${device.id} ` +
                `--console ${appName} 2>/dev/null || ` +
                `echo 'Tip: use Console.app to view logs from physical devices'`
            );
        } else {
            terminal.sendText(
                `xcrun simctl spawn ${device.id} log stream ` +
                `--level debug --style compact ` +
                `--predicate 'processImagePath contains "${appName}" AND NOT subsystem BEGINSWITH "com.apple."'`
            );
        }
    } else {
        terminal.sendText(`adb -s ${device.id} logcat -s dotnet mono-rt Mono`);
    }
}

export async function buildOnly(
    projectPath: string,
    platform: Platform,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    return runBuildCommand(terminal, errorLogFile => {
        const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config} ${msBuildErrorLoggerArg(errorLogFile)}`;
        return `echo '▶ Pre-building for debug...' && ${buildCmd} && echo '✅ BUILD_DONE'`;
    });
}

export async function runTests(
    targetPath: string,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const testCmd = `dotnet test "${targetPath}" -c ${config}`;
    return runTerminalCommand(
        terminal,
        `echo '▶ Running tests...' && ${testCmd}`,
        1_200_000,
        undefined,
        showTestFailure
    );
}

export async function buildForDebug(
    projectPath: string,
    platform: Platform,
    config: string,
    deviceType?: 'simulator' | 'physical'
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const hotReloadAgent = createHotReloadAgentFiles();

    // Build with debug flags — MtouchDebug=true enables Mono SDB in iOS apps
    const extraProps = platform.name === 'iOS'
        ? '-p:MtouchDebug=true'
        : '-p:EmbedAssembliesIntoApk=true';

    const rid = platform.name === 'iOS' && deviceType === 'physical' ? ' -r ios-arm64' : '';
    return runBuildCommand(terminal, errorLogFile => {
        const hotReloadProps = [
            shellQuote(`-p:CustomAfterMicrosoftCommonTargets=${hotReloadAgent.targetsPath}`),
            shellQuote(`-p:MauiDeployHotReloadAgentSource=${hotReloadAgent.sourcePath}`),
            '-p:MauiXamlInflator=SourceGen',
            '-p:EnableMauiXamlDiagnostics=true',
            '-p:MauiXamlLineInfo=true'
        ].join(' ');
        const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config} ${extraProps}${rid} ${hotReloadProps} ${msBuildErrorLoggerArg(errorLogFile)}`;
        return `echo '▶ Building for debug...' && ${buildCmd} && echo '✅ BUILD_DONE'`;
    });
}

function createHotReloadAgentFiles(): { sourcePath: string; targetsPath: string } {
    const directory = path.join(os.tmpdir(), 'mauideploy-hotreload');
    fs.mkdirSync(directory, { recursive: true });

    const sourcePath = path.join(directory, 'MauiDeploy.HotReloadAgent.g.cs');
    const targetsPath = path.join(directory, 'MauiDeploy.HotReloadAgent.targets');

    fs.writeFileSync(sourcePath, hotReloadAgentSource(), 'utf8');
    fs.writeFileSync(targetsPath, hotReloadAgentTargets(), 'utf8');

    return { sourcePath, targetsPath };
}

function hotReloadAgentTargets(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <ItemGroup Condition="'$(MauiDeployHotReloadAgentSource)' != ''">
    <Compile Include="$(MauiDeployHotReloadAgentSource)" Link="MauiDeploy.HotReloadAgent.g.cs" Visible="false" />
  </ItemGroup>
</Project>
`;
}

function hotReloadAgentSource(): string {
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
    private const int ServerPort = 55337;
    private static readonly string CrLf = new string(new[] { (char)13, (char)10 });
    private static readonly object Gate = new();
    private static readonly ConcurrentDictionary<string, string> Resources = new(StringComparer.OrdinalIgnoreCase);
    private static readonly ConcurrentDictionary<Type, BindableProperty[]> BindablePropertiesByType = new();
    private static readonly ConcurrentDictionary<Type, FieldInfo[]> GeneratedFieldsByType = new();
    private static int providerInstalled;
    private static int serverStarted;
    private static int applyVersion;
    private static int providerRequests;
    private static int providerHits;
    private static int lastActiveViews;
    private static int lastMatchedViews;
    private static int lastReloadHandlers;
    private static int lastReloadedViews;
    private static string lastAppliedPath = string.Empty;
    private static string lastRequestedPath = string.Empty;
    private static string lastMatchedPath = string.Empty;
    private static string lastReloadError = string.Empty;
    private static string lastServerError = string.Empty;

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
        ReloadOnMainThread(normalizedPath);

        return $"Queued XAML Hot Reload v{version} for {normalizedPath}. {GetStatus(normalizedPath)}";
    }

    public static string GetStatus(string resourcePath)
    {
        var normalizedPath = NormalizeResourcePath(resourcePath ?? string.Empty);
        var cachedResource = TryGetResource(normalizedPath, out _, out _) ? 1 : 0;
        return $"serverStarted={Volatile.Read(ref serverStarted)}, serverPort={ServerPort}, serverError='{lastServerError}', activeViews={Volatile.Read(ref lastActiveViews)}, matchedViews={Volatile.Read(ref lastMatchedViews)}, reloadHandlers={Volatile.Read(ref lastReloadHandlers)}, explicitReloads={Volatile.Read(ref lastReloadedViews)}, providerRequests={Volatile.Read(ref providerRequests)}, providerHits={Volatile.Read(ref providerHits)}, cachedResource={cachedResource}, reloadError='{lastReloadError}', lastApplied='{lastAppliedPath}', lastRequested='{lastRequestedPath}', lastMatched='{lastMatchedPath}', requested='{normalizedPath}'";
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
            var listener = new TcpListener(IPAddress.Any, ServerPort);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            listener.Start();

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

        throw new InvalidOperationException("Unknown XAML Hot Reload request path: " + requestPath);
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

    private static void ReloadOnMainThread(string resourcePath)
    {
        if (MainThread.IsMainThread)
        {
            ReloadMatchingViews(resourcePath);
            return;
        }

        Exception captured = null;
        using var completed = new ManualResetEventSlim(false);

        MainThread.BeginInvokeOnMainThread(() =>
        {
            try
            {
                ReloadMatchingViews(resourcePath);
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

        if (!completed.Wait(TimeSpan.FromSeconds(5)))
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

    private static int ReloadMatchingViews(string resourcePath)
    {
        var activeViews = 0;
        var matchedViews = 0;
        var reloadHandlers = 0;
        var reloadedViews = 0;
        lastReloadError = string.Empty;

        try
        {
            foreach (var item in GetActiveViews())
            {
                if (item == null)
                    continue;

                activeViews++;
                if (item is IHotReloadableView view && view.ReloadHandler != null)
                    reloadHandlers++;

                var viewType = item.GetType();
                if (!IsMatchingXamlView(viewType, resourcePath))
                    continue;

                matchedViews++;

                try
                {
                    if (TryReloadFromFreshInstance(item, viewType))
                        reloadedViews++;
                }
                catch (Exception ex)
                {
                    lastReloadError = FormatException(UnwrapException(ex));
                    Debug.WriteLine($"[MauiDeploy] XAML Hot Reload view reload failed: {ex}");
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[MauiDeploy] XAML Hot Reload active view scan failed: {ex}");
        }

        Volatile.Write(ref lastActiveViews, activeViews);
        Volatile.Write(ref lastMatchedViews, matchedViews);
        Volatile.Write(ref lastReloadHandlers, reloadHandlers);
        Volatile.Write(ref lastReloadedViews, reloadedViews);
        return reloadedViews;
    }

    private static bool IsMatchingXamlView(Type viewType, string resourcePath)
    {
        var xamlPath = GetXamlFilePath(viewType);
        if (string.IsNullOrEmpty(xamlPath))
            return false;

        var normalizedXamlPath = NormalizeResourcePath(xamlPath);
        if (string.Equals(normalizedXamlPath, resourcePath, StringComparison.OrdinalIgnoreCase))
            return true;

        return normalizedXamlPath.EndsWith('/' + resourcePath, StringComparison.OrdinalIgnoreCase) ||
            resourcePath.EndsWith('/' + normalizedXamlPath, StringComparison.OrdinalIgnoreCase);
    }

    private static string GetXamlFilePath(Type viewType)
    {
        foreach (var attribute in viewType.GetCustomAttributes(inherit: true))
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
    }

    private static bool TryReloadFromFreshInstance(object target, Type viewType)
    {
        object replacement;
        try
        {
            replacement = Activator.CreateInstance(viewType);
        }
        catch (MissingMethodException)
        {
            return false;
        }

        if (replacement == null)
            return false;

        var bindingContext = target is BindableObject targetBindable
            ? targetBindable.BindingContext
            : null;

        if (replacement is BindableObject replacementBindable)
            replacementBindable.BindingContext = bindingContext;

        if (target is BindableObject targetRoot && replacement is BindableObject replacementRoot)
        {
            CopyRootBindableValues(replacementRoot, targetRoot);
            CopyNameScope(replacementRoot, targetRoot);
        }

        if (!TryMoveContent(replacement, target))
            return false;

        if (target is BindableObject targetBindableAfterMove)
            targetBindableAfterMove.BindingContext = bindingContext;

        CopyGeneratedFields(replacement, target, viewType);
        return true;
    }

    private static bool TryMoveContent(object source, object target)
    {
        switch (target)
        {
            case ContentPage targetPage when source is ContentPage sourcePage:
                var pageContent = sourcePage.Content;
                sourcePage.Content = null;
                targetPage.Content = null;
                targetPage.Content = pageContent;
                return true;
            case ContentView targetContentView when source is ContentView sourceContentView:
                var contentViewContent = sourceContentView.Content;
                sourceContentView.Content = null;
                targetContentView.Content = null;
                targetContentView.Content = contentViewContent;
                return true;
            case ScrollView targetScrollView when source is ScrollView sourceScrollView:
                var scrollContent = sourceScrollView.Content;
                sourceScrollView.Content = null;
                targetScrollView.Content = null;
                targetScrollView.Content = scrollContent;
                return true;
            case Border targetBorder when source is Border sourceBorder:
                var borderContent = sourceBorder.Content;
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

            try
            {
                target.SetValue(property, source.GetValue(property));
            }
            catch
            {
                // Some bindable properties are one-shot or root-specific. Keep reload best-effort.
            }
        }
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
        return property == BindableObject.BindingContextProperty ||
            property.PropertyName == "Content" ||
            property.PropertyName == "AutomationId";
    }

    private static void CopyGeneratedFields(object source, object target, Type viewType)
    {
        foreach (var field in GetGeneratedFields(viewType))
        {
            field.SetValue(target, field.GetValue(source));
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
        var message = (exception.Message ?? string.Empty)
            .Replace((char)13, (char)32)
            .Replace((char)10, (char)32)
            .Replace((char)39, (char)32);

        if (message.Length > 500)
            message = message.Substring(0, 500);

        return exception.GetType().Name + ": " + message;
    }

    private static IEnumerable GetActiveViews()
    {
        var field = typeof(MauiHotReloadHelper).GetField("ActiveViews", BindingFlags.NonPublic | BindingFlags.Static);
        if (field?.GetValue(null) is IEnumerable activeViews)
            return activeViews;

        return Array.Empty<object>();
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
                resourcePath.EndsWith(entry.Key, StringComparison.OrdinalIgnoreCase))
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

async function runBuildCommand(
    terminal: vscode.Terminal,
    commandFactory: (errorLogFile: string) => string,
    timeout = 600_000
): Promise<boolean> {
    const errorLogFile = tempFilePath('.errors.log');

    try { fs.rmSync(errorLogFile, { force: true }); } catch { }

    try {
        return await runTerminalCommand(terminal, commandFactory(errorLogFile), timeout, errorLogFile);
    } finally {
        try { fs.rmSync(errorLogFile, { force: true }); } catch { }
    }
}

async function runTerminalCommand(
    terminal: vscode.Terminal,
    command: string,
    timeout = 600_000,
    errorLogFile?: string,
    onFailure: (output: string, exitCode: number | undefined, command: string) => void = showBuildErrors
): Promise<boolean> {
    const exitCodeFile = tempFilePath('.exit');

    try { fs.rmSync(exitCodeFile, { force: true }); } catch { }
    buildErrorsOutput?.clear();
    lastBuildFailure = undefined;

    terminal.sendText(`${command}; printf '%s' $? > ${shellQuote(exitCodeFile)}`);
    const exitCode = await waitForExitCodeFile(exitCodeFile, timeout);
    const output = errorLogFile ? readTextFile(errorLogFile) : '';

    try { fs.rmSync(exitCodeFile, { force: true }); } catch { }

    if (exitCode !== 0) {
        onFailure(output, exitCode, command);
    }

    return exitCode === 0;
}

function msBuildErrorLoggerArg(errorLogFile: string): string {
    return shellQuote(`-flp:logfile=${errorLogFile};errorsonly;verbosity=normal`);
}

function tempFilePath(suffix: string): string {
    return path.join(
        os.tmpdir(),
        `mauideploy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`
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
            buildTerminal?.show();
        }
    });
}

function showTestFailure(_output: string, exitCode: number | undefined) {
    const message = exitCode === undefined
        ? 'MAUI Deploy: Tests timed out.'
        : 'MAUI Deploy: Tests failed.';
    vscode.window.showErrorMessage(message, 'Open Terminal').then(choice => {
        if (choice === 'Open Terminal') {
            buildTerminal?.show();
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

async function waitForExitCodeFile(exitCodeFile: string, timeout: number): Promise<number | undefined> {
    const started = Date.now();

    return new Promise(resolve => {
        const timer = setInterval(() => {
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

function shellEnvAssignment(name: string, value: string): string {
    return `${name}=${shellQuote(value)}`;
}

export function disposeTerminals() {
    buildTerminal?.dispose();
    logTerminal?.dispose();
    stopHotReload();
    buildErrorsOutput?.dispose();
    hotReloadStatusEmitter.dispose();
}
