import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface PrerequisiteCommand {
    executable: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
}

export interface PrerequisiteIssue {
    id: string;
    title: string;
    detail: string;
    documentation: string;
    install?: PrerequisiteCommand;
    sdkInstall?: SdkInstallation;
    manualCommand?: PrerequisiteCommand;
}

export interface SdkInstallation {
    directory: string;
    workingDirectory: string;
    version?: string;
    channel?: string;
}

export interface IosSdkInspection {
    issues: PrerequisiteIssue[];
    executable?: string;
    version?: string;
}

interface CommandProbe {
    success: boolean;
    stdout: string;
}

async function probe(command: PrerequisiteCommand, signal: AbortSignal): Promise<CommandProbe> {
    signal.throwIfAborted();
    try {
        const result = await execFileAsync(command.executable, command.args, {
            cwd: command.cwd,
            env: {
                ...process.env, ...command.env,
                GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0',
                DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
                DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true'
            },
            encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal
        });
        signal.throwIfAborted();
        return { success: true, stdout: result.stdout.trim() };
    } catch {
        signal.throwIfAborted();
        return { success: false, stdout: '' };
    }
}

export async function inspectGitPrerequisites(directory: string, signal: AbortSignal): Promise<PrerequisiteIssue[]> {
    const result = await probe({ executable: 'git', args: ['--version'], cwd: directory }, signal);
    if (result.success) { return []; }
    return [{
        id: 'git', title: 'Git is unavailable',
        detail: 'Git is required to find repositories and create the separate deployment worktree.',
        documentation: 'https://git-scm.com/downloads',
        install: await homebrewInstall('git', directory, signal)
    }];
}

export async function inspectGitHubPrerequisites(host: string, directory: string, signal: AbortSignal): Promise<PrerequisiteIssue[]> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) { throw new Error('Invalid GitHub host.'); }
    const command = { executable: 'gh', args: ['--version'], cwd: directory };
    const result = await probe(command, signal);
    if (!result.success) {
        return [{
            id: 'github-cli', title: 'GitHub CLI is unavailable',
            detail: `GitHub CLI is required to inspect PRs on ${host}. Git uses its existing credentials separately.`,
            documentation: 'https://cli.github.com/',
            install: await homebrewInstall('gh', directory, signal)
        }];
    }
    const authentication = await probe({ ...command, args: ['auth', 'status', '--hostname', host] }, signal);
    if (authentication.success) { return []; }
    const location = await probe({ executable: '/usr/bin/which', args: ['gh'], cwd: directory }, signal);
    const executable = path.isAbsolute(location.stdout) ? location.stdout : command.executable;
    return [{
        id: 'github-auth', title: `GitHub access needs attention: ${host}`,
        detail: 'GitHub CLI could not verify sign-in. Check your network or VPN, or sign in through the setup terminal. Credentials stay in your local credential store.',
        documentation: 'https://cli.github.com/manual/gh_auth_login',
        manualCommand: { ...command, executable, args: ['auth', 'login', '--hostname', host, '--web'] }
    }];
}

async function homebrewInstall(packageName: string, directory: string, signal: AbortSignal): Promise<PrerequisiteCommand | undefined> {
    if (process.platform !== 'darwin') { return undefined; }
    const command = { executable: 'brew', args: ['--version'], cwd: directory };
    const available = await probe(command, signal);
    if (!available.success) { return undefined; }
    return { ...command, args: ['install', packageName], env: { HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' } };
}

export async function inspectXcodePrerequisites(directory: string, signal: AbortSignal): Promise<PrerequisiteIssue[]> {
    if (process.platform !== 'darwin') {
        return [{
            id: 'ios-host', title: 'iOS deployment requires macOS',
            detail: 'Use a local macOS VS Code window with Xcode for iOS deployment.',
            documentation: 'https://learn.microsoft.com/dotnet/maui/get-started/installation'
        }];
    }
    const developerDirectory = await probe({ executable: '/usr/bin/xcode-select', args: ['-p'], cwd: directory }, signal);
    const xcode = await probe({ executable: '/usr/bin/xcodebuild', args: ['-version'], cwd: directory }, signal);
    if (!developerDirectory.success || !xcode.success || !/^Xcode \d+/m.test(xcode.stdout)) {
        return [{
            id: 'xcode', title: 'Full Xcode is not selected or available',
            detail: 'Command Line Tools alone cannot build iOS apps. Install compatible Xcode, open it once, and select it in Xcode > Settings > Locations > Command Line Tools.',
            documentation: 'https://developer.apple.com/xcode/'
        }];
    }
    const initialized = await probe({ executable: '/usr/bin/xcodebuild', args: ['-checkFirstLaunchStatus'], cwd: directory }, signal);
    if (!initialized.success) {
        return [{
            id: 'xcode-setup', title: 'Xcode first-use setup is incomplete',
            detail: 'Open Xcode and complete its license and component setup, then recheck. MauiDeploy never accepts licenses for you.',
            documentation: 'https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes',
            manualCommand: { executable: '/usr/bin/open', args: ['-a', path.resolve(developerDirectory.stdout, '..', '..')], cwd: directory }
        }];
    }
    const issues: PrerequisiteIssue[] = [];
    for (const tool of ['simctl', 'devicectl']) {
        const available = await probe({ executable: '/usr/bin/xcrun', args: ['--find', tool], cwd: directory }, signal);
        if (!available.success) {
            issues.push({
                id: `xcode-${tool}`, title: `Xcode tool unavailable: ${tool}`,
                detail: 'Select an Xcode installation with iOS device and simulator support, then recheck.',
                documentation: 'https://developer.apple.com/xcode/'
            });
        }
    }
    const sdk = await probe({ executable: '/usr/bin/xcrun', args: ['--sdk', 'iphoneos', '--show-sdk-version'], cwd: directory }, signal);
    if (!sdk.success) {
        issues.push({
            id: 'xcode-ios-sdk', title: 'Xcode iOS SDK is unavailable',
            detail: 'Install the iOS platform components in the selected Xcode installation.',
            documentation: 'https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes'
        });
    }
    return issues;
}

interface SdkRequest {
    globalJson?: string;
    version?: string;
    automaticInstall: boolean;
}

const sdkVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function readSdkRequest(directory: string): Promise<SdkRequest> {
    for (let current = directory; ; current = path.dirname(current)) {
        const filename = path.join(current, 'global.json');
        if (fs.existsSync(filename)) {
            try {
                const data = JSON.parse((await fs.promises.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
                const version = data.sdk?.version;
                if (version === undefined) { return { globalJson: filename, automaticInstall: !data.sdk?.paths }; }
                if (typeof version === 'string' && sdkVersionPattern.test(version)) {
                    return { globalJson: filename, version, automaticInstall: !data.sdk?.paths };
                }
            } catch { }
            return { globalJson: filename, automaticInstall: false };
        }
        if (path.dirname(current) === current) { return { automaticInstall: true }; }
    }
}

export function dotnetEnvironment(executable: string): NodeJS.ProcessEnv {
    const root = path.dirname(executable);
    return {
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
        DOTNET_ROOT: root,
        DOTNET_HOST_PATH: executable,
        DOTNET_MULTILEVEL_LOOKUP: '0'
    };
}

export async function inspectIosSdkPrerequisites(
    projectPath: string,
    framework: string,
    storageDirectory: string,
    signal: AbortSignal
): Promise<IosSdkInspection> {
    const directory = path.dirname(projectPath);
    const request = await readSdkRequest(directory);
    const frameworkVersion = /^net(\d+)\.(\d+)-ios/.exec(framework);
    if (!frameworkVersion) { throw new Error('A concrete iOS target framework is required for SDK checks.'); }
    const channel = `${frameworkVersion[1]}.${frameworkVersion[2]}`;
    const managedDirectory = path.join(storageDirectory, 'dotnet', request.version ?? `channel-${channel}`);
    const systemPath = await probe({ executable: '/usr/bin/which', args: ['dotnet'], cwd: directory }, signal);
    const candidates = [
        path.join(managedDirectory, 'dotnet'), systemPath.stdout,
        path.join(process.env.DOTNET_ROOT ?? '/usr/local/share/dotnet', 'dotnet'),
        '/usr/local/share/dotnet/dotnet', '/opt/homebrew/bin/dotnet', path.join(os.homedir(), '.dotnet', 'dotnet')
    ];
    let executable: string | undefined;
    let version: string | undefined;
    const checked = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate || !fs.existsSync(candidate)) { continue; }
        const resolved = await fs.promises.realpath(candidate);
        if (checked.has(resolved)) { continue; }
        checked.add(resolved);
        const result = await probe({ executable: resolved, args: ['--version'], cwd: directory, env: dotnetEnvironment(resolved) }, signal);
        if (result.success && sdkVersionPattern.test(result.stdout)) {
            executable = resolved;
            version = result.stdout;
            break;
        }
    }
    if (!executable || !version) {
        let sdkInstall: SdkInstallation | undefined;
        if (request.automaticInstall && !fs.existsSync(managedDirectory)) {
            sdkInstall = { directory: managedDirectory, workingDirectory: directory };
            if (request.version) { sdkInstall.version = request.version; }
            else { sdkInstall.channel = channel; }
        }
        const source = request.globalJson ?? projectPath;
        return { issues: [{
            id: 'dotnet-sdk', title: `Compatible .NET SDK required${request.version ? `: ${request.version}` : ` (${channel})`}`,
            detail: `No SDK could be resolved from ${directory}. Requirements: ${source}. Installation uses private MauiDeploy storage; global.json and system SDKs are not changed. If automatic installation is unavailable, install the requested SDK manually.`,
            documentation: 'https://learn.microsoft.com/dotnet/core/install/macos', sdkInstall
        }] };
    }
    if (Number(version.split('.')[0]) < Number(frameworkVersion[1])) {
        let sdkInstall: SdkInstallation | undefined;
        if (!request.version && request.automaticInstall && !fs.existsSync(managedDirectory)) {
            sdkInstall = { directory: managedDirectory, workingDirectory: directory, channel };
        }
        return { issues: [{
            id: 'dotnet-target', title: `.NET SDK ${version} cannot target ${framework}`,
            detail: `Requirements: ${request.globalJson ?? projectPath}. A newer SDK can be installed privately when the project does not pin an older version. MauiDeploy never changes the project's SDK policy.`,
            documentation: 'https://learn.microsoft.com/dotnet/core/tools/global-json', sdkInstall
        }] };
    }
    const command = { executable, args: ['workload', 'list', '--machine-readable'], cwd: directory, env: dotnetEnvironment(executable) };
    const workloads = await probe(command, signal);
    const installed = workloads.success ? installedWorkloads(workloads.stdout) : undefined;
    if (!installed) {
        return { executable, version, issues: [{
            id: 'dotnet-workloads', title: 'Could not inspect .NET workloads',
            detail: `The selected SDK is ${version}. Run its workload list command and resolve any SDK or workload-set errors, then recheck.`,
            documentation: 'https://learn.microsoft.com/dotnet/core/tools/dotnet-workload-list',
            manualCommand: { ...command, args: ['workload', 'list'] }
        }] };
    }
    if (installed.some(workload => ['maui-ios', 'maui', 'maui-mobile'].includes(workload))) {
        return { executable, version, issues: [] };
    }
    const install = { ...command, args: ['workload', 'install', 'maui-ios', '--skip-manifest-update'] };
    const writable = await writableDirectory(path.dirname(executable));
    let sdkInstall: SdkInstallation | undefined;
    if (!writable && request.automaticInstall && !fs.existsSync(managedDirectory)) {
        sdkInstall = { directory: managedDirectory, workingDirectory: directory, version };
    }
    return { executable, version, issues: [{
        id: 'maui-ios', title: `MAUI iOS workload required for SDK ${version}`,
        detail: writable
            ? 'Install maui-ios using the resolved SDK. Existing workload manifests are retained; no workload update or upgrade is run.'
            : 'The selected SDK is administrator-managed. Install a private copy of this SDK first, or have your administrator install maui-ios. No privileged command is run automatically.',
        documentation: 'https://learn.microsoft.com/dotnet/maui/get-started/installation',
        install: writable ? install : undefined, sdkInstall, manualCommand: install
    }] };
}

function installedWorkloads(output: string): string[] | undefined {
    for (const line of output.split(/\r?\n/)) {
        try {
            const data = JSON.parse(line);
            if (Array.isArray(data.installed) && data.installed.every((item: unknown) => typeof item === 'string')) {
                return data.installed;
            }
        } catch { }
    }
    return undefined;
}

async function writableDirectory(directory: string): Promise<boolean> {
    try {
        await fs.promises.access(directory, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

export async function installPrerequisite(issue: PrerequisiteIssue, storageDirectory: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await fs.promises.mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(storageDirectory, 'install.lock');
    let lock: fs.promises.FileHandle;
    try {
        lock = await fs.promises.open(lockPath, 'wx');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        throw new Error(`Another MauiDeploy dependency installation is active. Recheck after it finishes. If it crashed, close it before removing ${lockPath}.`);
    }
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, dependency: issue.id }));
        if (issue.sdkInstall) {
            await installSdk(issue.sdkInstall, storageDirectory, signal);
        } else if (issue.install) {
            await runInstallationCommand(issue.install, signal);
        } else {
            throw new Error('This prerequisite requires manual setup.');
        }
    } finally {
        await lock.close();
        await fs.promises.unlink(lockPath);
    }
}

async function installSdk(installation: SdkInstallation, storageDirectory: string, signal: AbortSignal): Promise<void> {
    const relative = path.relative(storageDirectory, installation.directory);
    const validVersion = installation.version !== undefined && sdkVersionPattern.test(installation.version);
    const validChannel = installation.channel !== undefined && /^\d+\.\d+$/.test(installation.channel);
    if (path.isAbsolute(relative) || relative.startsWith('..') || !relative || validVersion === validChannel) {
        throw new Error('Invalid managed SDK installation request.');
    }
    if (fs.existsSync(installation.directory)) {
        throw new Error('The managed SDK directory already exists. Recheck the installed SDK before retrying.');
    }
    const parent = path.dirname(installation.directory);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await fs.promises.mkdtemp(path.join(parent, '.install-'));
    const script = path.join(staging, 'dotnet-install.sh');
    try {
        await runInstallationCommand({
            executable: '/usr/bin/curl',
            args: ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60',
                '--output', script, 'https://dot.net/v1/dotnet-install.sh'],
            cwd: storageDirectory
        }, signal);
        const versionArgs = validVersion ? ['--version', installation.version!] : ['--channel', installation.channel!];
        await runInstallationCommand({
            executable: '/bin/bash', args: [script, ...versionArgs, '--install-dir', staging, '--no-path'],
            cwd: storageDirectory
        }, signal);
        const dotnet = path.join(staging, 'dotnet');
        const result = await probe({
            executable: dotnet, args: ['--version'], cwd: installation.workingDirectory, env: dotnetEnvironment(dotnet)
        }, signal);
        if (!result.success || !sdkVersionPattern.test(result.stdout)) {
            throw new Error('The downloaded SDK does not satisfy this worktree. Its global.json was not changed.');
        }
        await fs.promises.rm(script, { force: true });
        signal.throwIfAborted();
        await fs.promises.rename(staging, installation.directory);
    } finally {
        await fs.promises.rm(staging, { recursive: true, force: true });
    }
}

async function runInstallationCommand(command: PrerequisiteCommand, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command.executable, command.args, {
            cwd: command.cwd,
            env: {
                ...process.env, ...command.env,
                GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
                DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true'
            },
            detached: process.platform !== 'win32', stdio: 'ignore'
        });
        let timedOut = false;
        const terminate = () => {
            if (!child.pid) { return; }
            try {
                if (process.platform === 'win32') { child.kill('SIGKILL'); }
                else { process.kill(-child.pid, 'SIGKILL'); }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { reject(error); }
            }
        };
        const timeout = setTimeout(() => { timedOut = true; terminate(); }, 20 * 60_000);
        const cleanup = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', terminate);
        };
        child.once('error', error => { cleanup(); reject(error); });
        child.once('close', code => {
            cleanup();
            if (signal.aborted) { reject(signal.reason); }
            else if (timedOut) { reject(new Error('Dependency installation timed out. Recheck before retrying.')); }
            else if (code !== 0) { reject(new Error(`Dependency installation failed (exit ${code ?? 'unknown'}). Use the setup instructions or run the indicated command manually.`)); }
            else { resolve(); }
        });
        signal.addEventListener('abort', terminate, { once: true });
        if (signal.aborted) { terminate(); }
    });
}