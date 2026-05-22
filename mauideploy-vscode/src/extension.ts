import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
    detectPlatforms, detectAllDevices, bootSimulator,
    Platform, Device, RecentDevice, isMauiProject,
    findIosAppBundle, findAndroidApk, getAndroidPackageId
} from './devices';
import { findWorkspaceMauiProjects, findWorkspaceCsprojs, findCsprojsInDir } from './projects';
import {
    buildAndDeploy, deployFromBin, buildForDebug, openLogViewer, disposeTerminals,
    askCopilotToFixLastBuildFailure, runTests,
    BuildResult
} from './deployer';

const execFileAsync = promisify(execFile);
const xamlHotReloadPort = 55337;
const xamlHotReloadRequestAttempts = 4;
const xamlHotReloadRequestRetryDelayMs = 700;

// ── State ──────────────────────────────────────────────

interface State {
    projectPath?: string;
    config: 'Debug' | 'Release';
    deviceId?: string;
    deviceName?: string;
    devicePlatform?: 'iOS' | 'Android';
    deviceType?: 'simulator' | 'physical';
    recentDevices: RecentDevice[];
}

let state: State = { config: 'Debug', recentDevices: [] };
let ctx: vscode.ExtensionContext;
let isBuilding = false;

// ── Device Cache ───────────────────────────────────────
let cachedDevices: Device[] = [];
let devicePollTimer: ReturnType<typeof setInterval> | undefined;
const DEVICE_POLL_INTERVAL_MS = 60_000;
let xamlHotReloadWatcher: vscode.FileSystemWatcher | undefined;
let xamlHotReloadSession: vscode.DebugSession | undefined;
let xamlHotReloadTunnel: { platform: 'iOS' | 'Android'; deviceId: string; process?: ChildProcess } | undefined;
const xamlHotReloadTimers = new Map<string, NodeJS.Timeout>();
const xamlHotReloadInFlight = new Set<string>();
const xamlHotReloadPending = new Map<string, { session: vscode.DebugSession; projectPath: string }>();
const lastAppliedXamlByFile = new Map<string, string>();

// ── Status Bar ─────────────────────────────────────────

let sbRun: vscode.StatusBarItem;
let sbDeployFromBin: vscode.StatusBarItem;
let sbDebug: vscode.StatusBarItem;
let sbTests: vscode.StatusBarItem;
let sbProject: vscode.StatusBarItem;
let sbConfig: vscode.StatusBarItem;
let sbDevice: vscode.StatusBarItem;
let sbLogs: vscode.StatusBarItem;

// ── Lifecycle ──────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    augmentProcessPath();
    ctx = context;
    loadState();
    createStatusBar(context);
    registerCommands(context);
    registerDebugHotReload(context);
    autoDetectProject();
    startDevicePolling();
    context.subscriptions.push({ dispose: () => { stopDevicePolling(); stopXamlHotReloadWatcher(); disposeTerminals(); } });
}

export function deactivate() {
    stopDevicePolling();
    stopXamlHotReloadWatcher();
    disposeTerminals();
}

// ── Device Polling ─────────────────────────────────────

function startDevicePolling() {
    refreshDeviceCache();
    devicePollTimer = setInterval(refreshDeviceCache, DEVICE_POLL_INTERVAL_MS);
}

function stopDevicePolling() {
    if (devicePollTimer) {
        clearInterval(devicePollTimer);
        devicePollTimer = undefined;
    }
}

async function refreshDeviceCache() {
    if (!state.projectPath) { return; }
    const platforms = detectPlatforms(state.projectPath);
    if (platforms.length === 0) { return; }
    try {
        cachedDevices = await detectAllDevices(platforms);
    } catch { /* detection can fail if tools aren't installed */ }
}

// ── Status Bar Creation ────────────────────────────────

function createStatusBar(context: vscode.ExtensionContext) {
    // ▶  🚀  🐛  |  MyApp  |  Debug  |  iPhone 16 Pro  |  📋
    sbRun = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    sbRun.command = 'mauideploy.run';
    context.subscriptions.push(sbRun);

    sbDeployFromBin = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100.5);
    sbDeployFromBin.command = 'mauideploy.deployFromBin';
    context.subscriptions.push(sbDeployFromBin);

    sbDebug = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbDebug.command = 'mauideploy.debug';
    context.subscriptions.push(sbDebug);

    sbTests = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99.5);
    sbTests.command = 'mauideploy.runTests';
    context.subscriptions.push(sbTests);

    sbProject = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    sbProject.command = 'mauideploy.pickProject';
    context.subscriptions.push(sbProject);

    sbConfig = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    sbConfig.command = 'mauideploy.toggleConfig';
    context.subscriptions.push(sbConfig);

    sbDevice = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    sbDevice.command = 'mauideploy.pickDevice';
    context.subscriptions.push(sbDevice);

    sbLogs = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    sbLogs.command = 'mauideploy.openLogs';
    context.subscriptions.push(sbLogs);

    updateStatusBar();
}

function updateStatusBar() {
    // ── Run button ──
    if (!isBuilding) {
        sbRun.text = '$(play)';
        sbRun.color = '#89d185';
        sbRun.backgroundColor = undefined;
        const key = process.platform === 'darwin' ? 'Cmd+Shift+R' : 'Ctrl+Shift+R';
        const target = state.deviceName
            ? `Build & deploy to **${state.deviceName}**`
            : 'Build & deploy';
        sbRun.tooltip = markdownTooltip(`**$(play) Run** — ${target}\n\n\`${key}\``);
    }
    sbRun.show();

    // ── Deploy from bin button ──
    if (!isBuilding) {
        sbDeployFromBin.text = '$(rocket)';
        sbDeployFromBin.color = '#4ec9b0';
        sbDeployFromBin.backgroundColor = undefined;
        const target = state.deviceName
            ? `Deploy existing build to **${state.deviceName}**`
            : 'Deploy existing build from bin';
        sbDeployFromBin.tooltip = markdownTooltip(
            `**$(rocket) Deploy from Bin** — ${target}\n\nSkips build — uses the app already in \`bin/${state.config}\``
        );
    }
    sbDeployFromBin.show();

    // ── Debug button ──
    if (!isBuilding) {
        sbDebug.text = '$(bug)';
        sbDebug.color = '#cca700';
        sbDebug.backgroundColor = undefined;
        sbDebug.command = 'mauideploy.debug';
        sbDebug.tooltip = markdownTooltip(
            `**$(bug) Debug** — Build with breakpoints & XAML Hot Reload\n\nAttaches Mono SDB debugger · saves XAML changes are live-reloaded`
        );
    }
    sbDebug.show();

    // ── Tests button ──
    if (!isBuilding) {
        sbTests.text = '$(beaker)';
        sbTests.color = '#c586c0';
        sbTests.backgroundColor = undefined;
        sbTests.tooltip = markdownTooltip(
            '**$(beaker) Run Tests** — Pick a `.csproj` and run `dotnet test`'
        );
    }
    sbTests.show();

    // ── Project ──
    if (state.projectPath) {
        const name = path.basename(state.projectPath, '.csproj');
        sbProject.text = `$(file-code) ${name}`;
        sbProject.color = undefined;
        const dir = path.dirname(state.projectPath).replace(process.env.HOME || '', '~');
        sbProject.tooltip = markdownTooltip(
            `**Project:** ${name}\n\n$(folder) \`${dir}\`\n\nClick to change`
        );
    } else {
        sbProject.text = '$(file-code) Select Project…';
        sbProject.color = '#888888';
        sbProject.tooltip = markdownTooltip('Click to select a .NET MAUI project');
    }
    sbProject.show();

    // ── Config ──
    const configIcon = state.config === 'Debug' ? '$(tools)' : '$(package)';
    sbConfig.text = `${configIcon} ${state.config}`;
    sbConfig.color = state.config === 'Debug' ? '#dcdcaa' : '#4ec9b0';
    sbConfig.tooltip = markdownTooltip(
        `**Configuration:** ${state.config}\n\nClick to toggle between Debug and Release`
    );
    sbConfig.show();

    // ── Device ──
    if (state.deviceName) {
        const icon = state.deviceType === 'physical' ? '$(plug)' :
            state.devicePlatform === 'iOS' ? '$(device-mobile)' : '$(vm)';
        sbDevice.text = `${icon} ${state.deviceName}`;
        sbDevice.color = undefined;
        const details = [
            `**${state.devicePlatform}** ${state.deviceType === 'physical' ? 'Device' : 'Simulator'}`,
            state.deviceName,
        ].join(' — ');
        sbDevice.tooltip = markdownTooltip(`${details}\n\nClick to change`);
    } else {
        sbDevice.text = '$(device-mobile) Select Device…';
        sbDevice.color = '#888888';
        sbDevice.tooltip = markdownTooltip('Click to select a target device');
    }
    sbDevice.show();

    // ── Logs ──
    sbLogs.text = '$(output)';
    sbLogs.color = '#888888';
    sbLogs.tooltip = markdownTooltip('**$(output) Logs** — Open device log viewer');
    sbLogs.show();

    vscode.commands.executeCommand('setContext', 'mauideploy.ready',
        !!state.projectPath && !!state.deviceId);
}

function markdownTooltip(value: string): vscode.MarkdownString {
    return new vscode.MarkdownString(value, true);
}

function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) { return `${seconds}s`; }
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

/** Creates a progress callback that updates a status bar item with build progress.
 *  Uses the MAX of a time-based asymptotic curve and real MSBuild log
 *  file size, so the progress always fills smoothly and accelerates when
 *  real build data is available. */
function createStatusBarReporter(item: vscode.StatusBarItem, label: string) {
    let lastPercent = 0;
    return (elapsedMs: number, buildPercent: number) => {
        const timeBased = Math.min(90, 90 * (1 - Math.exp(-elapsedMs / 1000 / 40)));
        const targetPercent = buildPercent > timeBased ? buildPercent : timeBased;
        const pct = Math.round(targetPercent);
        if (targetPercent - lastPercent >= 0.5 || targetPercent === lastPercent) {
            item.text = `$(sync~spin) ${pct}%`;
            item.tooltip = `${label} — ${formatElapsed(elapsedMs)}`;
            lastPercent = targetPercent;
        }
    };
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) { return `${seconds}s`; }
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function flashError(item: vscode.StatusBarItem) {
    item.text = '$(error)';
    item.color = '#f44747';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    item.tooltip = 'Build failed — check the Build Errors panel';
    setTimeout(() => updateStatusBar(), 4000);
}

// ── Tooling preflight ─────────────────────────────────

function augmentProcessPath() {
    // macOS apps launched from Finder/Dock don't inherit shell PATH, so /opt/homebrew/bin
    // (Apple Silicon brew) and /usr/local/bin (Intel brew) may be missing. Without those,
    // tools like iproxy/adb/brew can't be found even when they're installed.
    if (process.platform !== 'darwin') { return; }
    const extras = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
    const current = (process.env.PATH || '').split(path.delimiter);
    const additions = extras.filter(p => !current.includes(p) && fs.existsSync(p));
    if (additions.length > 0) {
        process.env.PATH = [...additions, ...current].join(path.delimiter);
    }
}


interface ToolRequirement {
    command: string;
    brewPackage: string;
    reason: string;
}

async function isOnPath(command: string): Promise<boolean> {
    try {
        await execFileAsync('which', [command]);
        return true;
    } catch {
        return false;
    }
}

async function ensureToolsAvailable(tools: ToolRequirement[]): Promise<boolean> {
    const missing: ToolRequirement[] = [];
    for (const tool of tools) {
        if (!await isOnPath(tool.command)) {
            missing.push(tool);
        }
    }
    if (missing.length === 0) { return true; }

    if (!await isOnPath('brew')) {
        const cmds = missing.map(m => `brew install ${m.brewPackage}`).join(' && ');
        vscode.window.showErrorMessage(
            `MAUI Deploy needs ${missing.map(m => m.command).join(', ')} but they're not on PATH. ` +
            `Install Homebrew from https://brew.sh, then run: ${cmds}`
        );
        return false;
    }

    const packages = Array.from(new Set(missing.map(m => m.brewPackage)));
    return await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${packages.join(', ')} via Homebrew…`,
            cancellable: false,
        },
        async () => {
            try {
                await execFileAsync('brew', ['install', ...packages], { maxBuffer: 64 * 1024 * 1024 });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    `brew install ${packages.join(' ')} failed: ${message.split('\n')[0]}. ` +
                    `Run it manually in a terminal to see full output.`
                );
                return false;
            }

            for (const tool of missing) {
                if (!await isOnPath(tool.command)) {
                    vscode.window.showErrorMessage(
                        `brew install completed but ${tool.command} is still not on PATH. ` +
                        `You may need to open a new shell or check the brew install output.`
                    );
                    return false;
                }
            }
            return true;
        }
    );
}

function toolsForCurrentTarget(): ToolRequirement[] {
    const tools: ToolRequirement[] = [];
    if (state.devicePlatform === 'iOS' && state.deviceType === 'physical') {
        tools.push({
            command: 'iproxy',
            brewPackage: 'libimobiledevice',
            reason: 'physical iOS USB tunnel for SDB + XAML Hot Reload',
        });
    }
    if (state.devicePlatform === 'Android') {
        tools.push({
            command: 'adb',
            brewPackage: 'android-platform-tools',
            reason: 'Android deployment and logcat',
        });
    }
    return tools;
}

// ── Commands ───────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('mauideploy.run', cmdRun),
        vscode.commands.registerCommand('mauideploy.deployFromBin', cmdDeployFromBin),
        vscode.commands.registerCommand('mauideploy.debug', cmdDebug),
        vscode.commands.registerCommand('mauideploy.runTests', cmdRunTests),
        vscode.commands.registerCommand('mauideploy.pickProject', cmdPickProject),
        vscode.commands.registerCommand('mauideploy.toggleConfig', cmdToggleConfig),
        vscode.commands.registerCommand('mauideploy.pickDevice', cmdPickDevice),
        vscode.commands.registerCommand('mauideploy.openLogs', cmdOpenLogs),
        vscode.commands.registerCommand('mauideploy.fixBuildErrorWithCopilot', askCopilotToFixLastBuildFailure),
    );
}

// ── Debug XAML Hot Reload ─────────────────────────────

function registerDebugHotReload(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(session => {
            if (session.type === 'mauideploy') {
                startXamlHotReloadWatcher(session);
            }
        }),
        vscode.debug.onDidTerminateDebugSession(session => {
            if (session === xamlHotReloadSession) {
                stopXamlHotReloadWatcher();
            }
        })
    );
}

function debugLog(message: string) {
    vscode.debug.activeDebugConsole?.appendLine(`[MauiDeploy] ${message}`);
}

function startXamlHotReloadWatcher(session: vscode.DebugSession) {
    const projectPath = session.configuration.projectPath;
    if (typeof projectPath !== 'string' || !fs.existsSync(projectPath)) {
        return;
    }

    stopXamlHotReloadWatcher();

    const projectDirectory = path.dirname(projectPath);
    xamlHotReloadSession = session;
    void startXamlHotReloadTunnel(session);
    xamlHotReloadWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectDirectory, '**/*.xaml')
    );

    const queue = (uri: vscode.Uri) => queueXamlHotReload(session, projectPath, uri.fsPath);
    xamlHotReloadWatcher.onDidChange(queue);
    xamlHotReloadWatcher.onDidCreate(queue);

    vscode.window.setStatusBarMessage('MAUI XAML Hot Reload is watching this debug session.', 3000);
}

function stopXamlHotReloadWatcher() {
    xamlHotReloadWatcher?.dispose();
    xamlHotReloadWatcher = undefined;
    xamlHotReloadSession = undefined;
    stopXamlHotReloadTunnel();

    for (const timer of xamlHotReloadTimers.values()) {
        clearTimeout(timer);
    }
    xamlHotReloadTimers.clear();
    xamlHotReloadPending.clear();
    xamlHotReloadInFlight.clear();
    lastAppliedXamlByFile.clear();
}

function queueXamlHotReload(session: vscode.DebugSession, projectPath: string, filePath: string) {
    const existingTimer = xamlHotReloadTimers.get(filePath);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        xamlHotReloadTimers.delete(filePath);
        void applyXamlHotReload(session, projectPath, filePath);
    }, 100);
    xamlHotReloadTimers.set(filePath, timer);
}

async function applyXamlHotReload(session: vscode.DebugSession, projectPath: string, filePath: string) {
    if (xamlHotReloadInFlight.has(filePath)) {
        xamlHotReloadPending.set(filePath, { session, projectPath });
        return;
    }

    xamlHotReloadInFlight.add(filePath);
    try {
        await sendXamlHotReload(session, projectPath, filePath);
    } finally {
        xamlHotReloadInFlight.delete(filePath);

        const pending = xamlHotReloadPending.get(filePath);
        if (pending) {
            xamlHotReloadPending.delete(filePath);
            if (pending.session === xamlHotReloadSession) {
                queueXamlHotReload(pending.session, pending.projectPath, filePath);
            }
        }
    }
}

async function sendXamlHotReload(session: vscode.DebugSession, projectPath: string, filePath: string) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const projectDirectory = path.dirname(projectPath);
    const resourcePath = path.relative(projectDirectory, filePath).split(path.sep).join('/');
    const xaml = stripUtf8Bom(await fs.promises.readFile(filePath, 'utf8'));
    if (lastAppliedXamlByFile.get(filePath) === xaml) {
        return;
    }

    const base64Xaml = Buffer.from(xaml, 'utf8').toString('base64');
    const fileName = path.basename(filePath);
    debugLog(`Hot Reload: sending ${fileName} (${resourcePath}, ${xaml.length} chars)`);

    try {
        const response = await postXamlHotReloadWithRetry('/apply', {
            resourcePath,
            base64Xaml
        });

        if (response?.status === 'error') {
            debugLog(`Hot Reload: error — ${response.details || 'unknown'}`);
            vscode.window.showErrorMessage(`MAUI XAML Hot Reload failed: ${response.details || 'unknown error'}`);
            return;
        }

        lastAppliedXamlByFile.set(filePath, xaml);
        debugLog(`Hot Reload: response — ${response.details ?? ''}`);
        showXamlHotReloadResult(filePath, resourcePath, response.details ?? '');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog(`Hot Reload: failed — ${message}`);
        const isTimeout = isTransientXamlHotReloadConnectionError(error);
        const actions = isTimeout ? ['Show Tunnel Log'] : [];
        vscode.window.showErrorMessage(`MAUI XAML Hot Reload failed: ${message}`, ...actions)
            .then(choice => {
                if (choice === 'Show Tunnel Log') {
                    getTunnelLogChannel().show();
                }
            });
    }
}

function showXamlHotReloadResult(filePath: string, resourcePath: string, details: string) {
    const matchedViews = readMetric(details, 'matchedViews');
    const explicitReloads = readMetric(details, 'explicitReloads');
    const inPlaceReloads = readMetric(details, 'inPlaceReloads');
    const freshReloads = readMetric(details, 'freshReloads');
    const cachedResource = readMetric(details, 'cachedResource');
    const reloadError = readQuotedField(details, 'reloadError');

    const fileName = path.basename(filePath);

    if (cachedResource === 1 && matchedViews === 0) {
        debugLog(`Hot Reload: ${fileName} cached for next navigation`);
        vscode.window.setStatusBarMessage(`MAUI XAML Hot Reload cached ${fileName} for next navigation`, 3000);
        return;
    }

    if (matchedViews === 0 || explicitReloads === 0) {
        debugLog(`Hot Reload: no views updated for ${fileName} ${reloadError ? `(${reloadError})` : ''}`);
        const message = reloadError
            ? `Could not hot reload ${fileName}: structural change can't be applied live. Navigate away and back to that page to see the update.`
            : `Could not hot reload ${fileName}: no matching live view. Navigate to that page to see the update.`;
        vscode.window.showWarningMessage(message, 'Show Details')
            .then(choice => {
                if (choice === 'Show Details') {
                    const channel = getHotReloadLogChannel();
                    channel.appendLine(`--- ${new Date().toISOString()} — ${fileName} ---`);
                    if (reloadError) { channel.appendLine(`reloadError: ${reloadError}`); }
                    channel.appendLine(details);
                    channel.show();
                }
            });
        return;
    }

    const mode = inPlaceReloads && inPlaceReloads > 0 ? 'applied in-place' : 'applied';
    debugLog(`Hot Reload: ${mode} ${path.basename(filePath)} (matched: ${matchedViews}, in-place: ${inPlaceReloads}, fresh: ${freshReloads})`);
    vscode.window.setStatusBarMessage(`MAUI XAML Hot Reload ${mode} ${path.basename(filePath)}`, 2000);
}

async function startXamlHotReloadTunnel(session: vscode.DebugSession) {
    stopXamlHotReloadTunnel();

    const platform = session.configuration.platform;
    const deviceType = session.configuration.deviceType;
    const deviceId = session.configuration.deviceId;

    if (typeof deviceId !== 'string') {
        return;
    }

    if (platform === 'iOS' && deviceType === 'physical') {
        if (!await ensureToolsAvailable([{
            command: 'iproxy',
            brewPackage: 'libimobiledevice',
            reason: 'physical iOS USB tunnel for SDB + XAML Hot Reload',
        }])) {
            return;
        }
        const log = getTunnelLogChannel();
        log.appendLine(`[tunnel] starting: iproxy ${xamlHotReloadPort}:${xamlHotReloadPort} -u ${deviceId}`);
        const process = spawn('iproxy', [`${xamlHotReloadPort}:${xamlHotReloadPort}`, '-u', deviceId]);
        process.stdout?.on('data', (chunk: Buffer) => log.append(`[iproxy] ${chunk.toString()}`));
        process.stderr?.on('data', (chunk: Buffer) => log.append(`[iproxy stderr] ${chunk.toString()}`));
        process.on('error', error => {
            log.appendLine(`[tunnel] iproxy spawn error: ${error.message}`);
            vscode.window.showWarningMessage(`MAUI XAML Hot Reload tunnel failed: ${error.message}`);
        });
        process.on('exit', (code, signal) => {
            log.appendLine(`[tunnel] iproxy exited (code=${code}, signal=${signal})`);
        });
        xamlHotReloadTunnel = { platform, deviceId, process };
        return;
    }

    if (platform === 'Android') {
        if (!await ensureToolsAvailable([{
            command: 'adb',
            brewPackage: 'android-platform-tools',
            reason: 'Android deployment and logcat',
        }])) {
            return;
        }
        xamlHotReloadTunnel = { platform, deviceId };
        void execFileAsync('adb', ['-s', deviceId, 'forward', `tcp:${xamlHotReloadPort}`, `tcp:${xamlHotReloadPort}`])
            .catch(error => vscode.window.showWarningMessage(`MAUI XAML Hot Reload adb forward failed: ${error.message}`));
    }
}

let tunnelLogChannel: vscode.OutputChannel | undefined;
function getTunnelLogChannel(): vscode.OutputChannel {
    if (!tunnelLogChannel) {
        tunnelLogChannel = vscode.window.createOutputChannel('MAUI Deploy: Hot Reload Tunnel');
    }
    return tunnelLogChannel;
}

function stopXamlHotReloadTunnel() {
    const tunnel = xamlHotReloadTunnel;
    xamlHotReloadTunnel = undefined;

    tunnel?.process?.kill();

    if (tunnel?.platform === 'Android') {
        void execFileAsync('adb', ['-s', tunnel.deviceId, 'forward', '--remove', `tcp:${xamlHotReloadPort}`]).catch(() => { });
    }
}

async function postXamlHotReload(endpoint: '/apply' | '/status', body: Record<string, string>): Promise<{ status: string; details: string }> {
    const details = await postText(endpoint, JSON.stringify(body));
    return { status: 'ok', details };
}

async function postXamlHotReloadWithRetry(endpoint: '/apply' | '/status', body: Record<string, string>): Promise<{ status: string; details: string }> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= xamlHotReloadRequestAttempts; attempt++) {
        try {
            return await postXamlHotReload(endpoint, body);
        } catch (error) {
            lastError = error;
            if (!isTransientXamlHotReloadConnectionError(error) || attempt === xamlHotReloadRequestAttempts) {
                throw error;
            }

            await delay(xamlHotReloadRequestRetryDelayMs);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isTransientXamlHotReloadConnectionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Timed out connecting to the MAUI XAML Hot Reload agent.')
        || message.includes('ECONNREFUSED')
        || message.includes('ECONNRESET')
        || message.includes('ETIMEDOUT')
        || message.includes('socket hang up');
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function postText(endpoint: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port: xamlHotReloadPort,
            path: endpoint,
            method: 'POST',
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body, 'utf8'),
            },
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if ((response.statusCode ?? 500) >= 400) {
                    reject(new Error(text || `HTTP ${response.statusCode}`));
                    return;
                }

                resolve(text);
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error('Timed out connecting to the MAUI XAML Hot Reload agent.'));
        });
        request.on('error', reject);
        request.end(body);
    });
}

function readMetric(details: string, name: string): number | undefined {
    const match = new RegExp(`${name}=([0-9]+)`).exec(details);
    return match ? Number(match[1]) : undefined;
}

function readQuotedField(details: string, name: string): string | undefined {
    const match = new RegExp(`${name}='([^']*)'`).exec(details);
    return match && match[1].length > 0 ? match[1] : undefined;
}

let hotReloadLogChannel: vscode.OutputChannel | undefined;
function getHotReloadLogChannel(): vscode.OutputChannel {
    if (!hotReloadLogChannel) {
        hotReloadLogChannel = vscode.window.createOutputChannel('MAUI Deploy: Hot Reload');
    }
    return hotReloadLogChannel;
}

function stripUtf8Bom(value: string): string {
    return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

// ── Run ────────────────────────────────────────────────

async function cmdRun() {
    if (isBuilding) { return; }

    // Ensure project is selected
    if (!state.projectPath || !fs.existsSync(state.projectPath)) {
        if (!await cmdPickProject()) { return; }
    }

    // Ensure device is selected
    if (!state.deviceId || !state.devicePlatform) {
        if (!await cmdPickDevice()) { return; }
    }

    // Resolve platform framework
    const platforms = detectPlatforms(state.projectPath!);
    const platform = platforms.find(p => p.name === state.devicePlatform);
    if (!platform) {
        vscode.window.showErrorMessage(
            `Project doesn't target ${state.devicePlatform}. Pick a different device.`
        );
        return;
    }

    if (!await ensureToolsAvailable(toolsForCurrentTarget())) { return; }

    isBuilding = true;
    sbRun.text = '$(sync~spin)';
    sbRun.color = '#dcdcaa';
    sbRun.tooltip = 'Building…';

    try {
        // Boot iOS simulator if needed (skip for physical devices)
        if (state.devicePlatform === 'iOS' && state.deviceType !== 'physical') {
            const allDevices = await detectAllDevices(platforms);
            const device = allDevices.find(d => d.id === state.deviceId);
            if (device && device.state === 'Shutdown') {
                sbRun.text = '$(sync~spin)';
                sbRun.tooltip = `Booting ${state.deviceName}…`;
                const booted = await bootSimulator(device.id);
                if (!booted) {
                    vscode.window.showErrorMessage(`Failed to boot ${state.deviceName}.`);
                    return;
                }
            }
        }

        // Build & deploy
        sbRun.tooltip = 'Building & deploying…';
        const device: Device = {
            id: state.deviceId!, name: state.deviceName!,
            platform: state.devicePlatform!, state: 'Booted',
            type: state.deviceType || 'simulator',
            display: state.deviceName!
        };

        const projectName = path.basename(state.projectPath!, '.csproj');
        const result = await buildAndDeploy(
            state.projectPath!, platform, device, state.config,
            undefined,
            createStatusBarReporter(sbRun, `Building ${projectName}`)
        );

        if (result.success) {
            const duration = formatDuration(result.durationMs);
            sbRun.text = '$(check)';
            sbRun.color = '#89d185';
            sbRun.tooltip = `Deployed to ${state.deviceName} in ${duration}`;
            vscode.window.showInformationMessage(
                `Deployed to ${state.deviceName} in ${duration}`,
                'Open Logs'
            ).then(choice => {
                if (choice === 'Open Logs') { cmdOpenLogs(); }
            });
            setTimeout(() => updateStatusBar(), 3000);
        } else {
            flashError(sbRun);
        }
    } finally {
        isBuilding = false;
        if (sbRun.text === '$(sync~spin)') { updateStatusBar(); }
    }
}

// ── Deploy from Bin ───────────────────────────────────

async function cmdDeployFromBin() {
    if (isBuilding) { return; }

    // Ensure project is selected
    if (!state.projectPath || !fs.existsSync(state.projectPath)) {
        if (!await cmdPickProject()) { return; }
    }

    // Ensure device is selected
    if (!state.deviceId || !state.devicePlatform) {
        if (!await cmdPickDevice()) { return; }
    }

    // Resolve platform framework
    const platforms = detectPlatforms(state.projectPath!);
    const platform = platforms.find(p => p.name === state.devicePlatform);
    if (!platform) {
        vscode.window.showErrorMessage(
            `Project doesn't target ${state.devicePlatform}. Pick a different device.`
        );
        return;
    }

    if (!await ensureToolsAvailable(toolsForCurrentTarget())) { return; }

    isBuilding = true;
    sbDeployFromBin.text = '$(sync~spin)';
    sbDeployFromBin.color = '#dcdcaa';
    sbDeployFromBin.tooltip = 'Deploying from bin…';

    try {
        // Boot iOS simulator if needed (skip for physical devices)
        if (state.devicePlatform === 'iOS' && state.deviceType !== 'physical') {
            const allDevices = await detectAllDevices(platforms);
            const device = allDevices.find(d => d.id === state.deviceId);
            if (device && device.state === 'Shutdown') {
                sbDeployFromBin.text = '$(sync~spin)';
                sbDeployFromBin.tooltip = `Booting ${state.deviceName}…`;
                const booted = await bootSimulator(device.id);
                if (!booted) {
                    vscode.window.showErrorMessage(`Failed to boot ${state.deviceName}.`);
                    return;
                }
            }
        }

        const device: Device = {
            id: state.deviceId!, name: state.deviceName!,
            platform: state.devicePlatform!, state: 'Booted',
            type: state.deviceType || 'simulator',
            display: state.deviceName!
        };

        const success = await deployFromBin(state.projectPath!, platform, device, state.config);

        if (success) {
            sbDeployFromBin.text = '$(check)';
            sbDeployFromBin.color = '#89d185';
            sbDeployFromBin.tooltip = `Deployed from bin to ${state.deviceName}`;
            vscode.window.showInformationMessage(
                `Deployed from bin to ${state.deviceName}`,
                'Open Logs'
            ).then(choice => {
                if (choice === 'Open Logs') { cmdOpenLogs(); }
            });
            setTimeout(() => updateStatusBar(), 3000);
        }
    } finally {
        isBuilding = false;
        // Don't call updateStatusBar here — let the success flash timeout do it
        if (sbDeployFromBin.text === '$(sync~spin)') { updateStatusBar(); }
    }
}

// ── Debug ──────────────────────────────────────────────

async function cmdDebug() {
    if (isBuilding) { return; }

    // Ensure project is selected
    if (!state.projectPath || !fs.existsSync(state.projectPath)) {
        if (!await cmdPickProject()) { return; }
    }

    // Ensure device is selected
    if (!state.deviceId || !state.devicePlatform) {
        if (!await cmdPickDevice()) { return; }
    }

    if (state.config !== 'Debug') {
        const choice = await vscode.window.showWarningMessage(
            'Debug with XAML Hot Reload requires the Debug configuration.',
            'Switch to Debug',
            'Cancel'
        );
        if (choice !== 'Switch to Debug') { return; }

        state.config = 'Debug';
        saveState();
        updateStatusBar();
    }

    // Resolve platform
    const platforms = detectPlatforms(state.projectPath!);
    const platform = platforms.find(p => p.name === state.devicePlatform);
    if (!platform) {
        vscode.window.showErrorMessage(
            `Project doesn't target ${state.devicePlatform}. Pick a different device.`
        );
        return;
    }

    if (!await ensureToolsAvailable(toolsForCurrentTarget())) { return; }

    // Boot iOS simulator if needed (skip for physical devices)
    if (state.devicePlatform === 'iOS' && state.deviceType !== 'physical') {
        const allDevices = await detectAllDevices(platforms);
        const device = allDevices.find(d => d.id === state.deviceId);
        if (device && device.state === 'Shutdown') {
            sbDebug.text = '$(sync~spin)';
            sbDebug.tooltip = `Booting ${state.deviceName}…`;
            const booted = await bootSimulator(device.id);
            if (!booted) {
                vscode.window.showErrorMessage(`Failed to boot ${state.deviceName}.`);
                return;
            }
        }
    }

    isBuilding = true;
    sbDebug.text = '$(sync~spin)';
    sbDebug.color = '#dcdcaa';
    sbDebug.tooltip = 'Building for debug…';

    try {
        // Build with debug flags (MtouchDebug=true for iOS)
        const projectName = path.basename(state.projectPath!, '.csproj');
        const buildResult = await buildForDebug(
            state.projectPath!, platform, state.config, state.deviceType,
            undefined,
            createStatusBarReporter(sbDebug, `Building ${projectName} for debug`)
        );
        if (!buildResult.success) {
            flashError(sbDebug);
            return;
        }

        // Find the built app path
        const programPath = state.devicePlatform === 'iOS'
            ? findIosAppBundle(state.projectPath!, platform.framework, state.config)
            : findAndroidApk(state.projectPath!, platform.framework, state.config);

        if (!programPath) {
            vscode.window.showErrorMessage('Could not find built app. Build may have failed.');
            return;
        }

        // Start debug session via our custom debug adapter
        sbDebug.tooltip = 'Starting debug session…';
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const debugConfig: vscode.DebugConfiguration = {
            name: `MAUI Debug: ${state.deviceName}`,
            type: 'mauideploy',
            request: 'launch',
            projectPath: state.projectPath!,
            configuration: state.config,
            platform: state.devicePlatform,
            framework: platform.framework,
            deviceId: state.deviceId!,
            deviceName: state.deviceName!,
            deviceType: state.deviceType || 'simulator',
            programPath: programPath,
            applicationId: state.devicePlatform === 'Android'
                ? getAndroidPackageId(state.projectPath!) : undefined,
        };

        const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
        if (started) {
            sbDebug.text = '$(check)';
            sbDebug.color = '#89d185';
            setTimeout(() => updateStatusBar(), 3000);
        } else {
            vscode.window.showErrorMessage('Failed to start debug session.');
        }
    } finally {
        isBuilding = false;
        if (sbDebug.text === '$(sync~spin)') { updateStatusBar(); }
    }
}

// ── Tests ─────────────────────────────────────────────

async function cmdRunTests() {
    if (isBuilding) { return; }

    const testProject = await pickTestProject();
    if (!testProject) { return; }

    isBuilding = true;
    sbTests.text = '$(sync~spin)';
    sbTests.color = '#dcdcaa';
    sbTests.tooltip = `Running tests for ${path.basename(testProject.projectPath)}…`;

    try {
        const testName = path.basename(testProject.projectPath, '.csproj');
        const result = await runTests(
            testProject.projectPath, testProject.config, undefined,
            createStatusBarReporter(sbTests, `Running tests — ${testName}`)
        );
        if (result.success) {
            const duration = formatDuration(result.durationMs);
            sbTests.text = '$(check)';
            sbTests.color = '#89d185';
            sbTests.tooltip = `Tests passed for ${testName} in ${duration}`;
            vscode.window.showInformationMessage(`Tests passed for ${testName} in ${duration}`);
            setTimeout(() => updateStatusBar(), 3000);
        } else {
            flashError(sbTests);
        }
    } finally {
        isBuilding = false;
        if (sbTests.text === '$(sync~spin)') { updateStatusBar(); }
    }
}

interface TestProjectPick {
    projectPath: string;
    config: string;
}

async function pickTestProject(): Promise<TestProjectPick | undefined> {
    interface Item extends vscode.QuickPickItem { projectPath?: string; config?: string; }

    const projects = await findWorkspaceCsprojs();
    if (projects.length === 0) {
        vscode.window.showWarningMessage('No .csproj files found in the workspace.');
        return undefined;
    }

    const testProjects = projects.filter(isLikelyTestProject);
    const otherProjects = projects.filter(projectPathValue => !testProjects.includes(projectPathValue));
    const items: Item[] = [];

    const addProjects = (label: string, projectPaths: string[]) => {
        if (projectPaths.length === 0) { return; }
        items.push({ label, kind: vscode.QuickPickItemKind.Separator });
        for (const projectPathValue of projectPaths) {
            const config = getTestRunConfiguration(projectPathValue);
            items.push({
                label: `$(file-code)  ${path.basename(projectPathValue, '.csproj')}`,
                description: path.dirname(projectPathValue).replace(process.env.HOME || '', '~'),
                detail: `dotnet test -c ${config}`,
                projectPath: projectPathValue,
                config,
            });
        }
    };

    addProjects('Test Projects', testProjects);
    addProjects('Other Projects', otherProjects);

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select Test Project',
        placeHolder: 'Choose a .csproj to run with dotnet test',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked?.projectPath || !picked.config) {
        return undefined;
    }

    return { projectPath: picked.projectPath, config: picked.config };
}

function isLikelyTestProject(projectPath: string): boolean {
    const projectName = path.basename(projectPath, '.csproj');
    if (/tests?$/i.test(projectName) || /\.tests?\./i.test(projectName)) {
        return true;
    }

    const content = readTextFile(projectPath);
    return /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(content)
        || /<PackageReference\s+Include=["'](?:Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest\.TestFramework)["']/i.test(content);
}

function getTestRunConfiguration(projectPath: string): string {
    return hasTestConfiguration(projectPath) ? 'Test' : state.config;
}

function hasTestConfiguration(projectPath: string): boolean {
    return getProjectConfigurationFiles(projectPath).some(filePath => declaresTestConfiguration(readTextFile(filePath)));
}

function getProjectConfigurationFiles(projectPath: string): string[] {
    const files = [projectPath];
    let dir = path.dirname(projectPath);

    while (true) {
        for (const fileName of ['Directory.Build.props', 'Directory.Build.targets']) {
            const filePath = path.join(dir, fileName);
            if (fs.existsSync(filePath)) {
                files.push(filePath);
            }
        }

        const parent = path.dirname(dir);
        if (parent === dir || isWorkspaceRoot(dir)) { break; }
        dir = parent;
    }

    return files;
}

function declaresTestConfiguration(content: string): boolean {
    const withoutComments = content.replace(/<!--[^]*?-->/g, '');
    const configurations = withoutComments.match(/<Configurations>\s*([^<]+?)\s*<\/Configurations>/i)?.[1];
    if (configurations?.split(';').some(config => config.trim().toLowerCase() === 'test')) {
        return true;
    }

    const conditionAttributes = withoutComments.matchAll(/Condition\s*=\s*(?:"([^"]*)"|'([^']*)')/gi);
    for (const conditionAttribute of conditionAttributes) {
        const condition = conditionAttribute[1] || conditionAttribute[2] || '';
        if (condition.includes('$(Configuration)') && /\bTest\b/i.test(condition)) {
            return true;
        }
    }

    return false;
}

function readTextFile(filePath: string): string {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function isWorkspaceRoot(dir: string): boolean {
    return vscode.workspace.workspaceFolders
        ?.some(folder => isSamePath(folder.uri.fsPath, dir)) ?? false;
}

// ── Project Picker ─────────────────────────────────────

async function cmdPickProject(): Promise<boolean> {
    interface Item extends vscode.QuickPickItem { projectPath?: string; action?: string; }
    const items: Item[] = [];

    // Workspace projects
    const wsProjects = await findWorkspaceMauiProjects();
    if (wsProjects.length > 0) {
        items.push({ label: 'Workspace', kind: vscode.QuickPickItemKind.Separator });
        for (const p of wsProjects) {
            const isCurrent = p === state.projectPath;
            items.push({
                label: `${isCurrent ? '$(check) ' : '$(file-code) '} ${path.basename(p, '.csproj')}`,
                description: path.dirname(p).replace(process.env.HOME || '', '~'),
                projectPath: p
            });
        }
    }

    // Recently used (not in workspace)
    const saved: string[] = ctx.globalState.get('savedProjects', []);
    const recentOnly = saved
        .filter(p => !wsProjects.includes(p) && fs.existsSync(p))
        .slice(0, 8);
    if (recentOnly.length > 0) {
        items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
        for (const p of recentOnly) {
            const isCurrent = p === state.projectPath;
            items.push({
                label: `${isCurrent ? '$(check) ' : '$(history) '} ${path.basename(p, '.csproj')}`,
                description: path.dirname(p).replace(process.env.HOME || '', '~'),
                projectPath: p
            });
        }
    }

    // Actions
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(folder-opened)  Browse…', action: 'browse' });
    items.push({ label: '$(search)  Scan for solutions…', action: 'scan' });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select MAUI Project',
        placeHolder: 'Type to search…',
        matchOnDescription: true
    });
    if (!picked) { return false; }

    if (picked.projectPath) {
        setProject(picked.projectPath);
        return true;
    }
    if (picked.action === 'browse') { return browseForProject(); }
    if (picked.action === 'scan') { return scanForSolutions(); }
    return false;
}

async function browseForProject(): Promise<boolean> {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false,
        filters: { 'C# Project': ['csproj'] },
        title: 'Select MAUI .csproj'
    });
    if (!uris?.length) { return false; }
    if (!isMauiProject(uris[0].fsPath)) {
        vscode.window.showWarningMessage('Not a MAUI project.');
        return false;
    }
    setProject(uris[0].fsPath);
    return true;
}

async function scanForSolutions(): Promise<boolean> {
    const home = process.env.HOME || '';
    const skip = new Set([
        'node_modules', '.git', 'bin', 'obj', '.nuget', '.dotnet',
        'Library', '.Trash', 'Pictures', 'Music', 'Movies',
        '.cache', '.local', '.npm', '.yarn', '.cargo', '.rustup'
    ]);

    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning…', cancellable: true },
        async (_progress, token) => {
            const solutions: string[] = [];
            const scan = (dir: string, depth: number) => {
                if (token.isCancellationRequested || depth > 5) { return; }
                try {
                    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (token.isCancellationRequested) { return; }
                        if (e.isFile() && (e.name.endsWith('.sln') || e.name.endsWith('.slnx'))) {
                            solutions.push(path.join(dir, e.name));
                        }
                        if (e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name)) {
                            scan(path.join(dir, e.name), depth + 1);
                        }
                    }
                } catch { /* permission denied */ }
            };
            scan(home, 0);

            if (solutions.length === 0) {
                vscode.window.showInformationMessage('No solutions found.');
                return false;
            }

            const slnPick = await vscode.window.showQuickPick(
                solutions.map(s => ({
                    label: `$(file-symlink-file)  ${path.basename(s)}`,
                    description: s.replace(home, '~'),
                    path: s
                })),
                { title: 'Select Solution', placeHolder: `Found ${solutions.length} solution(s)` }
            );
            if (!slnPick) { return false; }

            const csprojs = findCsprojsInDir(path.dirname(slnPick.path)).filter(isMauiProject);
            if (csprojs.length === 0) {
                vscode.window.showWarningMessage('No MAUI projects in that solution.');
                return false;
            }
            if (csprojs.length === 1) {
                setProject(csprojs[0]);
                return true;
            }

            const projPick = await vscode.window.showQuickPick(
                csprojs.map(c => ({
                    label: `$(file-code)  ${path.basename(c, '.csproj')}`,
                    description: path.dirname(c).replace(home, '~'),
                    path: c
                })),
                { title: 'Select Project' }
            );
            if (projPick) { setProject(projPick.path); return true; }
            return false;
        }
    );
}

function setProject(projectPath: string) {
    state.projectPath = projectPath;

    // Save to recent list (most recent first, max 10)
    const saved: string[] = ctx.globalState.get('savedProjects', []);
    const updated = [projectPath, ...saved.filter(p => p !== projectPath)].slice(0, 10);
    ctx.globalState.update('savedProjects', updated);

    // Clear incompatible device
    if (state.devicePlatform) {
        const platforms = detectPlatforms(projectPath);
        if (!platforms.some(p => p.name === state.devicePlatform)) {
            state.deviceId = undefined;
            state.deviceName = undefined;
            state.devicePlatform = undefined;
        }
    }

    saveState();
    updateStatusBar();
}

// ── Config Toggle ──────────────────────────────────────

function cmdToggleConfig() {
    state.config = state.config === 'Debug' ? 'Release' : 'Debug';
    saveState();
    updateStatusBar();
}

// ── Device Picker ──────────────────────────────────────

async function cmdPickDevice(): Promise<boolean> {
    if (!state.projectPath) {
        vscode.window.showWarningMessage('Select a project first.');
        return false;
    }

    const platforms = detectPlatforms(state.projectPath);
    if (platforms.length === 0) {
        vscode.window.showErrorMessage('No iOS/Android targets in project.');
        return false;
    }

    interface Item extends vscode.QuickPickItem { device?: Device; }

    const buildDeviceItems = (devices: Device[]): Item[] => {
        const items: Item[] = [];
        const recentIds = new Set<string>();
        const recentAvailable = state.recentDevices
            .filter(r => devices.some(d => d.id === r.id))
            .slice(0, 5);

        if (recentAvailable.length > 0) {
            items.push({ label: 'Recently Used', kind: vscode.QuickPickItemKind.Separator });
            for (const r of recentAvailable) {
                recentIds.add(r.id);
                const device = devices.find(d => d.id === r.id)!;
                const { stateLabel } = deviceVisuals(device);
                const isCurrent = device.id === state.deviceId;
                items.push({
                    label: `${isCurrent ? '$(check)' : '$(history)'}  ${device.name}`,
                    description: device.runtime || device.platform,
                    detail: stateLabel,
                    device
                });
            }
        }

        const iosPhysical = devices.filter(d => d.platform === 'iOS' && d.type === 'physical' && !recentIds.has(d.id));
        if (iosPhysical.length > 0) {
            items.push({ label: 'iOS Devices', kind: vscode.QuickPickItemKind.Separator });
            for (const d of iosPhysical) {
                items.push({
                    label: `$(plug)  ${d.name}`,
                    description: d.runtime,
                    detail: '● Connected',
                    device: d
                });
            }
        }

        const ios = devices.filter(d => d.platform === 'iOS' && d.type === 'simulator' && !recentIds.has(d.id));
        if (ios.length > 0) {
            items.push({ label: 'iOS Simulators', kind: vscode.QuickPickItemKind.Separator });
            for (const d of ios) {
                const { icon, stateLabel } = deviceVisuals(d);
                items.push({
                    label: `${icon}  ${d.name}`,
                    description: d.runtime,
                    detail: stateLabel,
                    device: d
                });
            }
        }

        const android = devices.filter(d => d.platform === 'Android' && !recentIds.has(d.id));
        if (android.length > 0) {
            items.push({ label: 'Android Devices', kind: vscode.QuickPickItemKind.Separator });
            for (const d of android) {
                items.push({
                    label: `$(plug)  ${d.name}`,
                    description: d.id,
                    detail: 'Connected',
                    device: d
                });
            }
        }

        return items;
    };

    // Show picker immediately with cached devices, then refresh in background
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Select Target Device';
    qp.placeholder = 'Type to search…';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    // Populate with cached devices instantly
    if (cachedDevices.length > 0) {
        qp.items = buildDeviceItems(cachedDevices);
    }

    // Start async refresh
    qp.busy = true;
    detectAllDevices(platforms).then(freshDevices => {
        cachedDevices = freshDevices;
        qp.items = buildDeviceItems(freshDevices);
        qp.busy = false;

        if (freshDevices.length === 0 && cachedDevices.length === 0) {
            const hint = platforms.some(p => p.name === 'iOS')
                ? 'Start a simulator or connect an Android device.'
                : 'Connect an Android device or start an emulator.';
            qp.placeholder = `No devices found. ${hint}`;
        }
    }).catch(() => {
        qp.busy = false;
    });

    return new Promise<boolean>(resolve => {
        qp.onDidAccept(() => {
            const selected = qp.selectedItems[0];
            qp.dispose();
            if (selected?.device) {
                setDevice(selected.device);
                resolve(true);
            } else {
                resolve(false);
            }
        });
        qp.onDidHide(() => {
            qp.dispose();
            resolve(false);
        });
        qp.show();
    });
}

function deviceVisuals(d: Device): { icon: string; stateLabel: string } {
    if (d.state === 'Booted') {
        return { icon: '$(circle-filled)', stateLabel: '● Running' };
    }
    if (d.state === 'connected') {
        return { icon: '$(plug)', stateLabel: '● Connected' };
    }
    return { icon: '$(circle-large-outline)', stateLabel: '○ Not running — will boot on run or deploy' };
}

function setDevice(device: Device) {
    state.deviceId = device.id;
    state.deviceName = device.name;
    state.devicePlatform = device.platform;
    state.deviceType = device.type;

    // Update recent devices (most recent first, max 10, deduplicate)
    state.recentDevices = [
        { id: device.id, name: device.name, platform: device.platform, runtime: device.runtime },
        ...state.recentDevices.filter(r => r.id !== device.id)
    ].slice(0, 10);

    saveState();
    updateStatusBar();
}

// ── Logs ───────────────────────────────────────────────

function cmdOpenLogs() {
    if (!state.projectPath || !state.deviceId || !state.devicePlatform) {
        vscode.window.showWarningMessage('Run or deploy first to set up logging.');
        return;
    }
    const platforms = detectPlatforms(state.projectPath);
    const platform = platforms.find(p => p.name === state.devicePlatform);
    if (!platform) { return; }

    const device: Device = {
        id: state.deviceId, name: state.deviceName || '',
        platform: state.devicePlatform, state: 'Booted',
        type: state.deviceType || 'simulator',
        display: state.deviceName || ''
    };
    openLogViewer(platform, device, state.projectPath);
}

// ── Auto-detection ─────────────────────────────────────

async function autoDetectProject() {
    const wsProjects = await findWorkspaceMauiProjects();

    if (wsProjects.length === 0) {
        return;
    }

    if (state.projectPath && wsProjects.some(p => isSamePath(p, state.projectPath!))) {
        return;
    }

    const projectToSelect = getAutoWorkspaceProject(wsProjects);
    if (projectToSelect) {
        setProject(projectToSelect);
        return;
    }

    if (state.projectPath && fs.existsSync(state.projectPath)) {
        state.projectPath = undefined;
        saveState();
        updateStatusBar();
    }
}

function getAutoWorkspaceProject(projects: string[]): string | undefined {
    if (projects.length === 1) {
        return projects[0];
    }

    const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const rootProjects = projects.filter(project =>
        workspaceRoots.some(root => isSamePath(path.dirname(project), root))
    );

    return rootProjects.length === 1 ? rootProjects[0] : undefined;
}

function isSamePath(left: string, right: string): boolean {
    return path.normalize(left) === path.normalize(right);
}

// ── Persistence ────────────────────────────────────────

/** Read from workspaceState first; fall back to globalState (last-used across workspaces). */
function loadState() {
    const ws = ctx.workspaceState;
    const gs = ctx.globalState;
    state = {
        projectPath: ws.get('projectPath') ?? gs.get('projectPath'),
        config: ws.get('config') ?? gs.get('config', 'Debug') as 'Debug' | 'Release',
        deviceId: ws.get('deviceId') ?? gs.get('deviceId'),
        deviceName: ws.get('deviceName') ?? gs.get('deviceName'),
        devicePlatform: ws.get('devicePlatform') ?? gs.get('devicePlatform') as 'iOS' | 'Android' | undefined,
        deviceType: ws.get('deviceType') ?? gs.get('deviceType') as 'simulator' | 'physical' | undefined,
        recentDevices: ws.get('recentDevices') ?? gs.get('recentDevices', []),
    };
}

/** Save to workspaceState (per-workspace) AND globalState (last-used fallback). */
function saveState() {
    const ws = ctx.workspaceState;
    const gs = ctx.globalState;
    const keys: (keyof State)[] = ['projectPath', 'config', 'deviceId', 'deviceName', 'devicePlatform', 'deviceType', 'recentDevices'];
    for (const key of keys) {
        ws.update(key, state[key]);
        gs.update(key, state[key]);
    }
}
