import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectPlatforms, findIosAppBundle, getAndroidPackageId, getBundleId } from './devices';
import type { Device } from './devices';

const maxDiagnosticBytes = 16 * 1024 * 1024;
const maxSnapshotBytes = 64 * 1024 * 1024;
const maxDiagnosticFiles = 128;

export interface MemoryDiagnosticsTarget {
    applicationId: string;
    device: Pick<Device, 'id' | 'name' | 'platform' | 'type'>;
}

export interface MemoryDiagnosticFile {
    name: string;
    content: string;
    lastModified: number;
}

export class MemoryDiagnosticsError extends Error { }

interface IosFile {
    name: string;
    resources: { isDirectory: boolean; isSymbolicLink: boolean };
    metadata: { size: number };
}

export async function resolveMemoryDiagnosticsTarget(
    projectPath: string, config: string, device: MemoryDiagnosticsTarget['device'], signal: AbortSignal,
): Promise<MemoryDiagnosticsTarget> {
    signal.throwIfAborted();
    const platform = detectPlatforms(projectPath).find(item => item.name === device.platform);
    if (!platform) throw new MemoryDiagnosticsError('The selected project does not target the selected device platform.');
    let applicationId: string | undefined;
    if (device.platform === 'iOS') {
        const bundle = findIosAppBundle(projectPath, platform.framework, config, device.type);
        if (!bundle) throw new MemoryDiagnosticsError('No built iOS app was found for the selected project and configuration. Build it once or import exported diagnostic files.');
        applicationId = await getBundleId(bundle);
    } else {
        applicationId = getAndroidPackageId(projectPath);
    }
    signal.throwIfAborted();
    if (!applicationId || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(applicationId)) {
        throw new MemoryDiagnosticsError('Could not determine the selected app ID. Build the selected configuration or import exported diagnostic files.');
    }
    return { applicationId, device };
}

export async function readDeviceMemoryDiagnostics(target: MemoryDiagnosticsTarget, signal: AbortSignal): Promise<MemoryDiagnosticFile[]> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(target.applicationId)
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(target.device.id)) {
        throw new MemoryDiagnosticsError('Select a valid app and device in MAUI Deploy before importing diagnostics.');
    }
    signal.throwIfAborted();
    let temporaryDirectory: string | undefined;
    try {
        let container: string | undefined;
        let names: string[];
        if (target.device.platform === 'iOS') {
            if (process.platform !== 'darwin') {
                throw new MemoryDiagnosticsError('Reading iOS diagnostics requires a local macOS extension host.');
            }
            if (target.device.type === 'simulator') {
                container = (await runDeviceCommand('xcrun', [
                    'simctl', 'get_app_container', target.device.id, target.applicationId, 'data',
                ], signal, false)).trim();
                if (!path.isAbsolute(container)) {
                    throw new MemoryDiagnosticsError('Could not locate the selected app in the simulator.');
                }
                const directory = await sandboxPath(container, path.join('Library', 'memory-diagnostics'));
                try {
                    names = (await fs.promises.readdir(directory)).filter(isDiagnosticFileName);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    names = [];
                }
            } else {
                const library = await listIosFiles(target, 'Library', signal);
                const directory = library.find(file => file.name === 'memory-diagnostics');
                if (!directory) throw noDiagnosticFiles();
                if (!directory.resources.isDirectory || directory.resources.isSymbolicLink) {
                    throw new MemoryDiagnosticsError('The diagnostic directory is not a regular app directory.');
                }
                const files = (await listIosFiles(target, 'Library/memory-diagnostics', signal))
                    .filter(file => isDiagnosticFileName(file.name));
                if (files.some(file => file.resources.isDirectory || file.resources.isSymbolicLink || file.metadata.size > maxDiagnosticBytes)) {
                    throw new MemoryDiagnosticsError('Diagnostic entries must be regular files within the 16 MB file limit.');
                }
                if (files.reduce((size, file) => size + file.metadata.size, 0) > maxSnapshotBytes) {
                    throw new MemoryDiagnosticsError('Device diagnostics exceed the 64 MB snapshot limit. Import selected exported files instead.');
                }
                names = files.map(file => file.name);
                temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mauideploy-memory-'));
                await fs.promises.chmod(temporaryDirectory, 0o700);
            }
        } else {
            const listing = await runDeviceCommand('adb', [
                '-s', target.device.id, 'exec-out', 'run-as', target.applicationId,
                'find', 'files/memory-diagnostics', '-maxdepth', '1', '-type', 'f', '-print0',
            ], signal, true);
            names = (listing ?? '').split('\0').flatMap(filename => {
                if (!filename.startsWith('files/memory-diagnostics/')) return [];
                const name = filename.slice('files/memory-diagnostics/'.length);
                return isDiagnosticFileName(name) ? [name] : [];
            });
        }

        names = [...new Set(names)].sort();
        if (names.length > maxDiagnosticFiles) {
            throw new MemoryDiagnosticsError('Too many diagnostic files for automatic import. Import selected exported files instead.');
        }
        const files: MemoryDiagnosticFile[] = [];
        let totalBytes = 0;
        for (const name of names) {
            signal.throwIfAborted();
            let content: string | undefined;
            let lastModified = Date.now();
            if (target.device.platform === 'Android') {
                content = await runDeviceCommand('adb', [
                    '-s', target.device.id, 'exec-out', 'run-as', target.applicationId,
                    'cat', `'files/memory-diagnostics/${name.replace(/'/g, "'\\''")}'`,
                ], signal, true);
            } else if (container) {
                const file = await readSandboxFile(container, path.join('Library', 'memory-diagnostics', name));
                content = file?.content;
                lastModified = file?.lastModified ?? lastModified;
            } else if (temporaryDirectory) {
                const output = await runDeviceCommand('xcrun', [
                    'devicectl', 'device', 'copy', 'from', '--device', target.device.id,
                    '--domain-type', 'appDataContainer', '--domain-identifier', target.applicationId,
                    '--source', `Library/memory-diagnostics/${name}`,
                    '--destination', path.join(temporaryDirectory, name), '--quiet', '--timeout', '30',
                ], signal, true, temporaryDirectory);
                if (output === undefined) continue;
                const file = await readSandboxFile(temporaryDirectory, name);
                if (!file) throw new MemoryDiagnosticsError('The device did not return the requested diagnostic file.');
                content = file.content;
                lastModified = file.lastModified;
            }
            if (content !== undefined) {
                totalBytes += Buffer.byteLength(content, 'utf8');
                if (totalBytes > maxSnapshotBytes) {
                    throw new MemoryDiagnosticsError('Device diagnostics exceed the 64 MB snapshot limit. Import selected exported files instead.');
                }
                files.push({ name, content, lastModified });
            }
        }
        signal.throwIfAborted();
        if (files.length === 0) {
            throw noDiagnosticFiles();
        }
        return files;
    } finally {
        if (temporaryDirectory) await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
    }
}

function isDiagnosticFileName(name: string): boolean {
    return name === 'checks.jsonl' || name === 'checks.previous.jsonl' || /^checks-[^/\\\u0000-\u001f]+\.jsonl$/.test(name);
}

function noDiagnosticFiles(): MemoryDiagnosticsError {
    return new MemoryDiagnosticsError('No diagnostic files found in the selected app. Complete a DUI GC check in a Debug build, then retry.');
}

async function listIosFiles(target: MemoryDiagnosticsTarget, directory: string, signal: AbortSignal): Promise<IosFile[]> {
    const output = await runDeviceCommand('xcrun', [
        'devicectl', 'device', 'info', 'files', '--device', target.device.id,
        '--domain-type', 'appDataContainer', '--domain-identifier', target.applicationId,
        '--subdirectory', directory, '--no-recurse', '--json-output', '/dev/stdout', '--quiet', '--timeout', '30',
    ], signal, false);
    try {
        const files: IosFile[] = JSON.parse(output)?.result?.files;
        if (!Array.isArray(files) || !files.every(file => file && typeof file.name === 'string'
            && typeof file.resources?.isDirectory === 'boolean' && typeof file.resources?.isSymbolicLink === 'boolean'
            && Number.isSafeInteger(file.metadata?.size) && file.metadata.size >= 0)) {
            throw new Error('Unexpected file listing');
        }
        return files;
    } catch {
        throw new MemoryDiagnosticsError('The device returned an unsupported diagnostic file listing. No files were imported.');
    }
}

async function sandboxPath(container: string, relativeName: string): Promise<string> {
    const root = await fs.promises.realpath(container);
    let filename: string;
    try {
        filename = await fs.promises.realpath(path.join(root, relativeName));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return path.join(root, relativeName);
    }
    const relative = path.relative(root, filename);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new MemoryDiagnosticsError('Could not read the diagnostic file safely. Diagnostic paths must stay inside the selected app container.');
    }
    return filename;
}

async function readSandboxFile(container: string, relativeName: string): Promise<{ content: string; lastModified: number } | undefined> {
    try {
        const directory = await sandboxPath(container, path.dirname(relativeName));
        const filename = path.join(directory, path.basename(relativeName));
        const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > maxDiagnosticBytes) {
                throw new Error('Diagnostic file is not a regular file within the 16 MB import limit.');
            }
            const content = await handle.readFile({ encoding: 'utf8' });
            if (Buffer.byteLength(content, 'utf8') > maxDiagnosticBytes) {
                throw new Error('Diagnostic file exceeds the 16 MB import limit.');
            }
            return { content, lastModified: stat.mtimeMs };
        } finally {
            await handle.close();
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new MemoryDiagnosticsError('Could not read the diagnostic file safely. Check app access and the 16 MB file limit.');
    }
}

function runDeviceCommand(binary: string, args: string[], signal: AbortSignal, allowMissing: false, cwd?: string): Promise<string>;
function runDeviceCommand(binary: string, args: string[], signal: AbortSignal, allowMissing: true, cwd?: string): Promise<string | undefined>;
function runDeviceCommand(binary: string, args: string[], signal: AbortSignal, allowMissing: boolean, cwd?: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        let result: { error: Error | null; stdout: string; stderr: string } | undefined;
        const child = execFile(binary, args, {
            encoding: 'utf8', signal, timeout: 35_000, maxBuffer: maxDiagnosticBytes, cwd,
        }, (error, stdout, stderr) => { result = { error, stdout, stderr }; });
        child.once('close', () => {
            if (signal.aborted) {
                reject(new Error('Diagnostic import cancelled.'));
            } else if (!result || result.error) {
                const missingFile = result && /No such file or directory|NSCocoaErrorDomain Code=260\b|NSPOSIXErrorDomain Code=2\b/i.test(result.stderr);
                if (allowMissing && missingFile) resolve(undefined);
                else reject(new MemoryDiagnosticsError('Could not read diagnostics from the selected app. Check the device connection, installed Debug app and device tools.'));
            } else {
                resolve(result.stdout);
            }
        });
    });
}