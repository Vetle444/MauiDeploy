import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const helperVersion = '11.12.5';
const uvVersion = '0.12.13';

export function screenshotPythonPath(storage: string): string {
    return path.join(storage, `pymobiledevice3-${helperVersion}`, 'bin', 'python');
}

export async function screenshotToolsReady(storage: string, signal: AbortSignal): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync(screenshotPythonPath(storage), [
            '-c', 'from importlib.metadata import version; print(version("pymobiledevice3"))',
        ], { signal, timeout: 10_000, maxBuffer: 64 * 1024 });
        return stdout.trim() === helperVersion;
    } catch (error) {
        if (signal.aborted) { throw error; }
        return false;
    }
}

export async function installScreenshotTools(storage: string, signal: AbortSignal, report: (message: string) => void): Promise<string> {
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });
    const options = {
        signal, cwd: storage, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024,
        env: {
            ...process.env, PYTHONNOUSERSITE: '1',
            UV_PYTHON_INSTALL_DIR: path.join(storage, 'python'),
            UV_CACHE_DIR: path.join(storage, 'cache'),
            PIP_CACHE_DIR: path.join(storage, 'pip-cache'),
        },
    };
    const bootstrap = path.join(storage, 'bootstrap');
    report('Preparing isolated installer...');
    await execFileAsync('python3', ['-m', 'venv', bootstrap], options);
    await execFileAsync(path.join(bootstrap, 'bin', 'python'), [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `uv==${uvVersion}`,
    ], options);
    const uv = path.join(bootstrap, 'bin', 'uv');
    const environment = path.dirname(path.dirname(screenshotPythonPath(storage)));
    report('Installing managed Python...');
    await execFileAsync(uv, ['venv', '--python', '3.14', '--managed-python', '--clear', environment], options);
    report('Installing iPhone screenshot helper...');
    await execFileAsync(uv, [
        'pip', 'install', '--python', screenshotPythonPath(storage), `pymobiledevice3==${helperVersion}`,
    ], options);
    if (!await screenshotToolsReady(storage, signal)) {
        throw new Error('The iPhone screenshot helper could not be verified. Retry installation.');
    }
    return screenshotPythonPath(storage);
}