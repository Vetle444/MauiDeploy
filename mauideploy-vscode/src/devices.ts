import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface Platform {
    name: 'iOS' | 'Android';
    framework: string;
    display: string;
}

export interface Device {
    name: string;
    id: string;
    display: string;
    state: 'Booted' | 'Shutdown' | 'connected';
    platform: 'iOS' | 'Android';
    type: 'simulator' | 'physical';
    runtime?: string;
}

export interface RecentDevice {
    id: string;
    name: string;
    platform: 'iOS' | 'Android';
    runtime?: string;
}

// ── Platform detection ─────────────────────────────────

export function detectPlatforms(csprojPath: string): Platform[] {
    const content = fs.readFileSync(csprojPath, 'utf-8');
    const platforms: Platform[] = [];

    const tfmMatch = content.match(/<TargetFrameworks?>(.*?)<\/TargetFrameworks?>/s);
    if (!tfmMatch) { return platforms; }
    const tfms = tfmMatch[1];

    const iosMatch = tfms.match(/(net[\d.]+-ios[\d.]*)/);
    if (iosMatch) {
        platforms.push({ name: 'iOS', framework: iosMatch[1], display: `iOS (${iosMatch[1]})` });
    }

    const androidMatch = tfms.match(/(net[\d.]+-android[\d.]*)/);
    if (androidMatch) {
        platforms.push({ name: 'Android', framework: androidMatch[1], display: `Android (${androidMatch[1]})` });
    }

    return platforms;
}

// ── Device detection ───────────────────────────────────

export async function detectAllDevices(platforms: Platform[]): Promise<Device[]> {
    const devices: Device[] = [];
    if (platforms.some(p => p.name === 'iOS')) {
        devices.push(...await detectIosPhysicalDevices());
        devices.push(...await detectIosSimulators());
    }
    if (platforms.some(p => p.name === 'Android')) {
        devices.push(...await detectAndroidDevices());
    }
    return devices;
}

async function detectIosPhysicalDevices(): Promise<Device[]> {
    const devices: Device[] = [];
    try {
        const { stdout } = await execFileAsync('xcrun', [
            'devicectl', 'list', 'devices', '--json-output', '-'
        ]);
        const data = JSON.parse(stdout);
        const deviceList = data?.result?.devices;
        if (!Array.isArray(deviceList)) { return devices; }

        for (const d of deviceList) {
            const props = d.deviceProperties;
            const hw = d.hardwareProperties;
            const conn = d.connectionProperties;
            if (!props || !hw) { continue; }

            // Only include devices that are paired and available
            if (conn?.pairingState !== 'paired') { continue; }

            const name = props.name || hw.marketingName || hw.productType || 'iOS Device';
            const udid = hw.udid || d.identifier;
            if (!udid) { continue; }

            const osVersion = props.osVersionNumber ? `iOS ${props.osVersionNumber}` : 'iOS';
            devices.push({
                name,
                id: udid,
                state: 'connected',
                platform: 'iOS',
                type: 'physical',
                runtime: osVersion,
                display: `${name} — ${osVersion}`
            });
        }
    } catch { /* devicectl not available or no devices */ }
    return devices;
}

async function detectIosSimulators(): Promise<Device[]> {
    const devices: Device[] = [];
    try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '--json']);
        const data = JSON.parse(stdout);

        for (const [runtime, devList] of Object.entries(data.devices)) {
            if (!runtime.includes('iOS')) { continue; }
            const runtimeLabel = runtime
                .replace('com.apple.CoreSimulator.SimRuntime.', '')
                .replace(/-/g, ' ');

            for (const d of devList as any[]) {
                if (!d.isAvailable) { continue; }
                devices.push({
                    name: d.name,
                    id: d.udid,
                    state: d.state === 'Booted' ? 'Booted' : 'Shutdown',
                    platform: 'iOS',
                    type: 'simulator',
                    runtime: runtimeLabel,
                    display: `${d.name} — ${runtimeLabel}`
                });
            }
        }

        devices.sort((a, b) => {
            if (a.state === 'Booted' && b.state !== 'Booted') { return -1; }
            if (a.state !== 'Booted' && b.state === 'Booted') { return 1; }
            if (a.runtime && b.runtime) {
                const cmp = b.runtime.localeCompare(a.runtime);
                if (cmp !== 0) { return cmp; }
            }
            return a.name.localeCompare(b.name);
        });
    } catch { /* xcrun not available */ }
    return devices;
}

async function detectAndroidDevices(): Promise<Device[]> {
    const devices: Device[] = [];
    try {
        const { stdout } = await execFileAsync('adb', ['devices', '-l']);
        for (const line of stdout.split('\n').slice(1)) {
            if (!line.trim()) { continue; }
            const parts = line.split(/\s+/);
            if (parts.length < 2 || parts[1] !== 'device') { continue; }
            const serial = parts[0];
            const modelMatch = line.match(/model:(\S+)/);
            const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : serial;
            devices.push({
                name: model,
                id: serial,
                state: 'connected',
                platform: 'Android',
                type: 'physical',
                display: `${model} (${serial})`
            });
        }
    } catch { /* adb not available */ }
    return devices;
}

// ── Simulator management ───────────────────────────────

export async function bootSimulator(deviceId: string): Promise<boolean> {
    try {
        await execFileAsync('xcrun', ['simctl', 'boot', deviceId]);
        await execFileAsync('open', ['-a', 'Simulator']);
        return true;
    } catch { return false; }
}

// ── Project detection ──────────────────────────────────

export function isMauiProject(csprojPath: string): boolean {
    try {
        const content = fs.readFileSync(csprojPath, 'utf-8');
        return /UseMaui/i.test(content)
            || (/net[\d.]+-ios/i.test(content) || /net[\d.]+-android/i.test(content));
    } catch { return false; }
}

// ── iOS bundle helpers ─────────────────────────────────

export function findIosAppBundle(csprojPath: string, framework: string, config: string): string | undefined {
    const projectDir = path.dirname(csprojPath);
    const binDir = path.join(projectDir, 'bin', config, framework);
    if (!fs.existsSync(binDir)) { return undefined; }

    const findApps = (dir: string): string[] => {
        const results: string[] = [];
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.endsWith('.app')) { results.push(full); }
                    else { results.push(...findApps(full)); }
                }
            }
        } catch { /* permission denied */ }
        return results;
    };
    return findApps(binDir)[0];
}

export function findAndroidApk(csprojPath: string, framework: string, config: string): string | undefined {
    const projectDir = path.dirname(csprojPath);
    const binDir = path.join(projectDir, 'bin', config, framework);
    if (!fs.existsSync(binDir)) { return undefined; }

    try {
        // Look for signed APK first, then unsigned
        for (const entry of fs.readdirSync(binDir)) {
            if (entry.endsWith('-Signed.apk')) { return path.join(binDir, entry); }
        }
        for (const entry of fs.readdirSync(binDir)) {
            if (entry.endsWith('.apk')) { return path.join(binDir, entry); }
        }
    } catch { /* permission denied */ }
    return undefined;
}

export async function getBundleId(appPath: string): Promise<string | undefined> {
    const plistPath = path.join(appPath, 'Info.plist');
    if (!fs.existsSync(plistPath)) { return undefined; }
    try {
        const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
            '-c', 'Print :CFBundleIdentifier', plistPath
        ]);
        return stdout.trim() || undefined;
    } catch { return undefined; }
}
