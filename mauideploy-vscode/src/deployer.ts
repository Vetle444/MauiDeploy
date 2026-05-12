import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Platform, Device, findIosAppBundle, getBundleId } from './devices';

let buildTerminal: vscode.Terminal | undefined;
let logTerminal: vscode.Terminal | undefined;

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

async function buildAndDeployIos(
    projectPath: string,
    platform: Platform,
    device: Device,
    config: string
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config}`;
    const buildSucceeded = await runTerminalCommand(terminal, `echo '▶ Building...' && ${buildCmd}`);
    if (!buildSucceeded) {
        vscode.window.showErrorMessage('MAUI Deploy: Build failed. Check terminal for details.');
        return false;
    }

    const appPath = findIosAppBundle(projectPath, platform.framework, config);
    if (!appPath) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not find .app bundle.');
        return false;
    }

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
    const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config} -r ios-arm64`;
    const buildSucceeded = await runTerminalCommand(terminal, `echo '▶ Building for device...' && ${buildCmd}`);
    if (!buildSucceeded) {
        vscode.window.showErrorMessage('MAUI Deploy: Build failed. Check terminal for details.');
        return false;
    }

    const appPath = findIosAppBundle(projectPath, platform.framework, config);
    if (!appPath) {
        vscode.window.showErrorMessage('MAUI Deploy: Could not find .app bundle.');
        return false;
    }

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

    const buildCmd = [
        `dotnet build "${projectPath}"`,
        `-t:Run`,
        `-f ${platform.framework}`,
        `-c ${config}`,
        `/p:AdbTarget="-s ${device.id}"`
    ].join(' ');
    const succeeded = await runTerminalCommand(terminal, `echo '▶ Building & deploying...' && ${buildCmd}`);
    if (!succeeded) {
        vscode.window.showErrorMessage('MAUI Deploy: Build/deploy failed. Check terminal for details.');
    }
    return succeeded;
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

    const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config}`;
    return runTerminalCommand(terminal, `echo '▶ Pre-building for debug...' && ${buildCmd} && echo '✅ BUILD_DONE'`);
}

export async function buildForDebug(
    projectPath: string,
    platform: Platform,
    config: string,
    deviceType?: 'simulator' | 'physical'
): Promise<boolean> {
    const terminal = getBuildTerminal();
    terminal.show();

    // Build with debug flags — MtouchDebug=true enables Mono SDB in iOS apps
    const extraProps = platform.name === 'iOS'
        ? '-p:MtouchDebug=true'
        : '-p:EmbedAssembliesIntoApk=true';

    const rid = platform.name === 'iOS' && deviceType === 'physical' ? ' -r ios-arm64' : '';
    const buildCmd = `dotnet build "${projectPath}" -f ${platform.framework} -c ${config} ${extraProps}${rid}`;
    return runTerminalCommand(terminal, `echo '▶ Building for debug...' && ${buildCmd} && echo '✅ BUILD_DONE'`);
}

async function runTerminalCommand(
    terminal: vscode.Terminal,
    command: string,
    timeout = 600_000
): Promise<boolean> {
    const exitCodeFile = path.join(
        os.tmpdir(),
        `mauideploy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.exit`
    );

    try { fs.rmSync(exitCodeFile, { force: true }); } catch { }

    terminal.sendText(`${command}; printf '%s' $? > ${shellQuote(exitCodeFile)}`);
    const exitCode = await waitForExitCodeFile(exitCodeFile, timeout);

    try { fs.rmSync(exitCodeFile, { force: true }); } catch { }

    return exitCode === 0;
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

export function disposeTerminals() {
    buildTerminal?.dispose();
    logTerminal?.dispose();
}
