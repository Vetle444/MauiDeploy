import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    detectPlatforms, detectAllDevices, bootSimulator,
    Platform, Device, RecentDevice, isMauiProject,
    findIosAppBundle, findAndroidApk
} from './devices';
import { findWorkspaceMauiProjects, findCsprojsInDir } from './projects';
import { buildAndDeploy, buildOnly, buildForDebug, openLogViewer, disposeTerminals } from './deployer';

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

// ── Status Bar ─────────────────────────────────────────

let sbRun: vscode.StatusBarItem;
let sbDebug: vscode.StatusBarItem;
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
    autoDetectProject();
    context.subscriptions.push({ dispose: disposeTerminals });
}

export function deactivate() { disposeTerminals(); }

// ── Status Bar Creation ────────────────────────────────

function createStatusBar(context: vscode.ExtensionContext) {
    // ▶  🐛  |  MyApp  |  Debug  |  iPhone 16 Pro  |  📋
    sbRun = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    sbRun.command = 'mauideploy.run';
    context.subscriptions.push(sbRun);

    sbDebug = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbDebug.command = 'mauideploy.debug';
    context.subscriptions.push(sbDebug);

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
        sbRun.tooltip = new vscode.MarkdownString(`**$(play) Run** — ${target}\n\n\`${key}\``);
    }
    sbRun.show();

    // ── Debug button ──
    if (!isBuilding) {
        sbDebug.text = '$(bug)';
        sbDebug.color = '#cca700';
        sbDebug.tooltip = new vscode.MarkdownString(
            `**$(bug) Debug** — Build with breakpoints\n\nUses Mono SDB debugger`
        );
    }
    sbDebug.show();

    // ── Project ──
    if (state.projectPath) {
        const name = path.basename(state.projectPath, '.csproj');
        sbProject.text = `$(file-code) ${name}`;
        sbProject.color = undefined;
        sbProject.tooltip = new vscode.MarkdownString(
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
        sbDevice.tooltip = new vscode.MarkdownString(
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

// ── Commands ───────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('mauideploy.run', cmdRun),
        vscode.commands.registerCommand('mauideploy.debug', cmdDebug),
        vscode.commands.registerCommand('mauideploy.pickProject', cmdPickProject),
        vscode.commands.registerCommand('mauideploy.toggleConfig', cmdToggleConfig),
        vscode.commands.registerCommand('mauideploy.pickDevice', cmdPickDevice),
        vscode.commands.registerCommand('mauideploy.openLogs', cmdOpenLogs),
    );
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
            // Success flash ✓
            sbRun.text = '$(check)';
            sbRun.color = '#89d185';
            sbRun.tooltip = `Deployed to ${state.deviceName}`;
            vscode.window.showInformationMessage(
                `$(check) Deployed to ${state.deviceName}`,
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
            vscode.window.showErrorMessage('Build failed. Check terminal for details.');
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
        title: '$(file-code)  Select MAUI Project',
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
                { title: '$(search)  Select Solution', placeHolder: `Found ${solutions.length} solution(s)` }
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
                { title: '$(file-code)  Select Project' }
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
        { location: vscode.ProgressLocation.Window, title: '$(sync~spin) Detecting devices…' },
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
        title: '$(device-mobile)  Select Target Device',
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
    return { icon: '$(circle-large-outline)', stateLabel: '○ Not running — will boot on deploy' };
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
        vscode.window.showWarningMessage('Deploy first to set up logging.');
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
