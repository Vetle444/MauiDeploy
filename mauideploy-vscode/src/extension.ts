import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
    detectPlatforms, detectAllDevices, bootSimulator,
    Platform, Device, RecentDevice, isMauiProject,
    findIosAppBundle, findAndroidApk
} from './devices';
import { findWorkspaceMauiProjects, findWorkspaceCsprojs, findCsprojsInDir } from './projects';
import {
    buildAndDeploy, deployFromBin, buildForDebug, openLogViewer, disposeTerminals,
    askCopilotToFixLastBuildFailure, runTests, startHotReload, stopHotReload,
    isHotReloadRunning, onDidChangeHotReloadStatus
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
let sbHotReload: vscode.StatusBarItem;
let sbTests: vscode.StatusBarItem;
let sbProject: vscode.StatusBarItem;
let sbConfig: vscode.StatusBarItem;
let sbDevice: vscode.StatusBarItem;
let sbLogs: vscode.StatusBarItem;

// ── Lifecycle ──────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    ctx = context;
    loadState();
    createStatusBar(context);
    registerCommands(context);
    registerDebugHotReload(context);
    context.subscriptions.push(onDidChangeHotReloadStatus(updateStatusBar));
    autoDetectProject();
    context.subscriptions.push({ dispose: () => { stopXamlHotReloadWatcher(); disposeTerminals(); } });
}

export function deactivate() {
    stopXamlHotReloadWatcher();
    disposeTerminals();
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

    sbHotReload = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99.75);
    sbHotReload.command = 'mauideploy.hotReload';
    context.subscriptions.push(sbHotReload);

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
        const target = state.deviceName
            ? `Deploy existing build to **${state.deviceName}**`
            : 'Deploy existing build from bin';
        sbDeployFromBin.tooltip = markdownTooltip(`**$(rocket) Deploy from Bin** — ${target}\n\nUses the app already in \`bin/${state.config}\``);
    }
    sbDeployFromBin.show();

    // ── Debug button ──
    if (!isBuilding) {
        sbDebug.text = '$(bug)';
        sbDebug.color = '#cca700';
        sbDebug.command = 'mauideploy.debug';
        sbDebug.tooltip = markdownTooltip(
            `**$(bug) Debug** — Build with breakpoints and XAML Hot Reload\n\nUses Mono SDB debugger`
        );
    }
    sbDebug.show();

    // ── Hot Reload button ──
    if (!isBuilding) {
        if (isHotReloadRunning()) {
            sbHotReload.text = '$(flame) Hot';
            sbHotReload.color = '#ff8c42';
            sbHotReload.command = 'mauideploy.stopHotReload';
            sbHotReload.tooltip = markdownTooltip(
                `**$(flame) Watch Run** — Running for **${state.deviceName || 'selected device'}**\n\nClick to stop`
            );
        } else {
            sbHotReload.text = '$(flame)';
            sbHotReload.color = '#ff8c42';
            sbHotReload.command = 'mauideploy.hotReload';
            sbHotReload.tooltip = markdownTooltip(
                '**$(flame) Watch Run** — Run with `dotnet watch`\n\nExperimental rebuild/rerun watcher. Does not attach the debugger.'
            );
        }
    }
    sbHotReload.show();

    // ── Tests button ──
    if (!isBuilding) {
        sbTests.text = '$(beaker)';
        sbTests.color = '#c586c0';
        sbTests.tooltip = markdownTooltip('**$(beaker) Run Tests** — Pick a `.csproj` to test');
    }
    sbTests.show();

    // ── Project ──
    if (state.projectPath) {
        const name = path.basename(state.projectPath, '.csproj');
        sbProject.text = `$(file-code) ${name}`;
        sbProject.color = undefined;
        sbProject.tooltip = markdownTooltip(
            `**Project:** ${name}\n\n` +
            `$(folder) \`${path.dirname(state.projectPath)}\`\n\nClick to change`
        );
    } else {
        sbProject.text = '$(file-code) Select Project…';
        sbProject.color = '#888888';
        sbProject.tooltip = 'Click to select a MAUI project';
    }
    sbProject.show();

    // ── Config ──
    sbConfig.text = state.config;
    sbConfig.color = state.config === 'Debug' ? '#dcdcaa' : '#4ec9b0';
    sbConfig.tooltip = `Configuration: ${state.config}\n\nClick to toggle`;
    sbConfig.show();

    // ── Device ──
    if (state.deviceName) {
        const icon = state.devicePlatform === 'iOS' ? '$(device-mobile)' : '$(vm)';
        sbDevice.text = `${icon} ${state.deviceName}`;
        sbDevice.color = undefined;
        sbDevice.tooltip = markdownTooltip(
            `**${state.devicePlatform}** — ${state.deviceName}\n\nClick to change`
        );
    } else {
        sbDevice.text = '$(device-mobile) Select Device…';
        sbDevice.color = '#888888';
        sbDevice.tooltip = 'Click to select a target device';
    }
    sbDevice.show();

    // ── Logs ──
    sbLogs.text = '$(output)';
    sbLogs.color = '#888888';
    sbLogs.tooltip = 'Open log viewer';
    sbLogs.show();

    vscode.commands.executeCommand('setContext', 'mauideploy.ready',
        !!state.projectPath && !!state.deviceId);
}

function markdownTooltip(value: string): vscode.MarkdownString {
    return new vscode.MarkdownString(value, true);
}

// ── Commands ───────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('mauideploy.run', cmdRun),
        vscode.commands.registerCommand('mauideploy.deployFromBin', cmdDeployFromBin),
        vscode.commands.registerCommand('mauideploy.debug', cmdDebug),
        vscode.commands.registerCommand('mauideploy.hotReload', cmdHotReload),
        vscode.commands.registerCommand('mauideploy.stopHotReload', cmdStopHotReload),
        vscode.commands.registerCommand('mauideploy.runTests', cmdRunTests),
        vscode.commands.registerCommand('mauideploy.pickProject', cmdPickProject),
        vscode.commands.registerCommand('mauideploy.toggleConfig', cmdToggleConfig),
        vscode.commands.registerCommand('mauideploy.pickDevice', cmdPickDevice),
        vscode.commands.registerCommand('mauideploy.openLogs', cmdOpenLogs),
        vscode.commands.registerCommand('mauideploy.fixBuildErrorWithCopilot', askCopilotToFixLastBuildFailure),
    );
}

// ── Hot Reload ────────────────────────────────────────

async function cmdHotReload() {
    if (isHotReloadRunning()) {
        cmdStopHotReload();
        return;
    }
    if (isBuilding) { return; }

    if (!state.projectPath || !fs.existsSync(state.projectPath)) {
        if (!await cmdPickProject()) { return; }
    }

    if (!state.deviceId || !state.devicePlatform) {
        if (!await cmdPickDevice()) { return; }
    }

    const platforms = detectPlatforms(state.projectPath!);
    const platform = platforms.find(p => p.name === state.devicePlatform);
    if (!platform) {
        vscode.window.showErrorMessage(
            `Project doesn't target ${state.devicePlatform}. Pick a different device.`
        );
        return;
    }

    if (state.config !== 'Debug') {
        const choice = await vscode.window.showWarningMessage(
            'Hot Reload requires the Debug configuration.',
            'Switch to Debug',
            'Cancel'
        );
        if (choice !== 'Switch to Debug') { return; }

        state.config = 'Debug';
        saveState();
        updateStatusBar();
    }

    if (state.devicePlatform === 'iOS' && state.deviceType !== 'physical') {
        const allDevices = await detectAllDevices(platforms);
        const device = allDevices.find(d => d.id === state.deviceId);
        if (device && device.state === 'Shutdown') {
            const booted = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Booting ${state.deviceName}…` },
                () => bootSimulator(device.id)
            );
            if (!booted) {
                vscode.window.showErrorMessage(`Failed to boot ${state.deviceName}.`);
                return;
            }
        }
    }

    isBuilding = true;
    sbHotReload.text = '$(sync~spin)';
    sbHotReload.color = '#dcdcaa';
    sbHotReload.tooltip = 'Starting Hot Reload…';

    try {
        const device: Device = {
            id: state.deviceId!, name: state.deviceName!,
            platform: state.devicePlatform!, state: 'Booted',
            type: state.deviceType || 'simulator',
            display: state.deviceName!
        };

        const started = await startHotReload(state.projectPath!, platform, device);
        if (started) {
            vscode.window.showInformationMessage(
                `Watch Run started for ${state.deviceName}. Save files to rebuild and rerun.`
            );
        }
    } finally {
        isBuilding = false;
        updateStatusBar();
    }
}

function cmdStopHotReload() {
    if (!isHotReloadRunning()) { return; }
    stopHotReload();
    updateStatusBar();
    vscode.window.showInformationMessage('Watch Run stopped.');
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
    startXamlHotReloadTunnel(session);
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
        vscode.window.showErrorMessage(`MAUI XAML Hot Reload failed: ${message}`);
    }
}

function showXamlHotReloadResult(filePath: string, resourcePath: string, details: string) {
    const matchedViews = readMetric(details, 'matchedViews');
    const explicitReloads = readMetric(details, 'explicitReloads');
    const inPlaceReloads = readMetric(details, 'inPlaceReloads');
    const freshReloads = readMetric(details, 'freshReloads');
    const cachedResource = readMetric(details, 'cachedResource');

    if (cachedResource === 1 && matchedViews === 0) {
        debugLog(`Hot Reload: ${path.basename(filePath)} cached for next navigation`);
        vscode.window.setStatusBarMessage(`MAUI XAML Hot Reload cached ${path.basename(filePath)} for next navigation`, 3000);
        return;
    }

    if (matchedViews === 0 || explicitReloads === 0) {
        debugLog(`Hot Reload: no views updated for ${path.basename(filePath)}`);
        vscode.window.showWarningMessage(`MAUI XAML Hot Reload did not update ${path.basename(filePath)}. ${details}`);
        return;
    }

    const mode = inPlaceReloads && inPlaceReloads > 0 ? 'applied in-place' : 'applied';
    debugLog(`Hot Reload: ${mode} ${path.basename(filePath)} (matched: ${matchedViews}, in-place: ${inPlaceReloads}, fresh: ${freshReloads})`);
    vscode.window.setStatusBarMessage(`MAUI XAML Hot Reload ${mode} ${path.basename(filePath)}`, 2000);
}

function startXamlHotReloadTunnel(session: vscode.DebugSession) {
    stopXamlHotReloadTunnel();

    const platform = session.configuration.platform;
    const deviceType = session.configuration.deviceType;
    const deviceId = session.configuration.deviceId;

    if (typeof deviceId !== 'string') {
        return;
    }

    if (platform === 'iOS' && deviceType === 'physical') {
        const process = spawn('iproxy', [`${xamlHotReloadPort}:${xamlHotReloadPort}`, '-u', deviceId], {
            stdio: 'ignore',
        });
        process.on('error', error => {
            vscode.window.showWarningMessage(`MAUI XAML Hot Reload tunnel failed: ${error.message}`);
        });
        xamlHotReloadTunnel = { platform, deviceId, process };
        return;
    }

    if (platform === 'Android') {
        xamlHotReloadTunnel = { platform, deviceId };
        void execFileAsync('adb', ['-s', deviceId, 'forward', `tcp:${xamlHotReloadPort}`, `tcp:${xamlHotReloadPort}`])
            .catch(error => vscode.window.showWarningMessage(`MAUI XAML Hot Reload adb forward failed: ${error.message}`));
    }
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
            timeout: 5000,
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
                sbRun.tooltip = `Booting ${state.deviceName}…`;
                const booted = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Booting ${state.deviceName}…` },
                    () => bootSimulator(device.id)
                );
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

        const success = await buildAndDeploy(state.projectPath!, platform, device, state.config);

        if (success) {
            sbRun.text = '$(check)';
            sbRun.color = '#89d185';
            sbRun.tooltip = `Deployed to ${state.deviceName}`;
            vscode.window.showInformationMessage(
                `Deployed to ${state.deviceName}`,
                'Open Logs'
            ).then(choice => {
                if (choice === 'Open Logs') { cmdOpenLogs(); }
            });
            setTimeout(() => updateStatusBar(), 3000);
        }
    } finally {
        isBuilding = false;
        // Don't call updateStatusBar here — let the success flash timeout do it
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
                sbDeployFromBin.tooltip = `Booting ${state.deviceName}…`;
                const booted = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Booting ${state.deviceName}…` },
                    () => bootSimulator(device.id)
                );
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

    // Boot iOS simulator if needed (skip for physical devices)
    if (state.devicePlatform === 'iOS' && state.deviceType !== 'physical') {
        const allDevices = await detectAllDevices(platforms);
        const device = allDevices.find(d => d.id === state.deviceId);
        if (device && device.state === 'Shutdown') {
            const booted = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Booting ${state.deviceName}…` },
                () => bootSimulator(device.id)
            );
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
        const buildSuccess = await buildForDebug(state.projectPath!, platform, state.config, state.deviceType);
        if (!buildSuccess) {
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
        const success = await runTests(testProject.projectPath, testProject.config);
        if (success) {
            sbTests.text = '$(check)';
            sbTests.color = '#89d185';
            sbTests.tooltip = `Tests passed for ${path.basename(testProject.projectPath)}`;
            vscode.window.showInformationMessage(`Tests passed for ${path.basename(testProject.projectPath)}`);
            setTimeout(() => updateStatusBar(), 3000);
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

    const allDevices = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Detecting devices…' },
        () => detectAllDevices(platforms)
    );

    interface Item extends vscode.QuickPickItem { device?: Device; }
    const items: Item[] = [];

    // Recently used (still available)
    const recentIds = new Set<string>();
    const recentAvailable = state.recentDevices
        .filter(r => allDevices.some(d => d.id === r.id))
        .slice(0, 5);

    if (recentAvailable.length > 0) {
        items.push({ label: 'Recently Used', kind: vscode.QuickPickItemKind.Separator });
        for (const r of recentAvailable) {
            recentIds.add(r.id);
            const device = allDevices.find(d => d.id === r.id)!;
            const { icon, stateLabel } = deviceVisuals(device);
            const isCurrent = device.id === state.deviceId;
            items.push({
                label: `${isCurrent ? '$(check)' : '$(history)'}  ${device.name}`,
                description: device.runtime || device.platform,
                detail: stateLabel,
                device
            });
        }
    }

    // iOS physical devices (excluding recent)
    const iosPhysical = allDevices.filter(d => d.platform === 'iOS' && d.type === 'physical' && !recentIds.has(d.id));
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

    // iOS simulators (excluding recent)
    const ios = allDevices.filter(d => d.platform === 'iOS' && d.type === 'simulator' && !recentIds.has(d.id));
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

    // Android devices (excluding recent)
    const android = allDevices.filter(d => d.platform === 'Android' && !recentIds.has(d.id));
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

    if (allDevices.length === 0) {
        const hint = platforms.some(p => p.name === 'iOS')
            ? 'Start a simulator or connect an Android device.'
            : 'Connect an Android device or start an emulator.';
        vscode.window.showWarningMessage(`No devices found. ${hint}`);
        return false;
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select Target Device',
        placeHolder: 'Type to search…',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked?.device) { return false; }

    setDevice(picked.device);
    return true;
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

function loadState() {
    state = {
        projectPath: ctx.globalState.get('projectPath'),
        config: ctx.globalState.get('config', 'Debug') as 'Debug' | 'Release',
        deviceId: ctx.globalState.get('deviceId'),
        deviceName: ctx.globalState.get('deviceName'),
        devicePlatform: ctx.globalState.get('devicePlatform') as 'iOS' | 'Android' | undefined,
        deviceType: ctx.globalState.get('deviceType') as 'simulator' | 'physical' | undefined,
        recentDevices: ctx.globalState.get('recentDevices', []),
    };
}

function saveState() {
    ctx.globalState.update('projectPath', state.projectPath);
    ctx.globalState.update('config', state.config);
    ctx.globalState.update('deviceId', state.deviceId);
    ctx.globalState.update('deviceName', state.deviceName);
    ctx.globalState.update('devicePlatform', state.devicePlatform);
    ctx.globalState.update('deviceType', state.deviceType);
    ctx.globalState.update('recentDevices', state.recentDevices);
}
