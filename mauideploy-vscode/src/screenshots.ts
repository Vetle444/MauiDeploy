import { execFile } from 'child_process';
import { promisify } from 'util';
import { Device } from './devices';

const execFileAsync = promisify(execFile);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function captureScreenshot(device: Device, signal: AbortSignal, python?: string, workingDirectory?: string): Promise<Buffer> {
    let command: string;
    let args: string[];
    if (device.platform === 'Android') {
        command = 'adb';
        args = ['-s', device.id, 'exec-out', 'screencap', '-p'];
    } else if (device.type === 'simulator') {
        command = 'xcrun';
        args = ['simctl', 'io', device.id, 'screenshot', '--type=png', '-'];
    } else {
        if (!python) { throw new Error('The iPhone screenshot helper is not installed.'); }
        command = python;
        args = ['-m', 'pymobiledevice3', 'developer', 'dvt', 'screenshot', '/dev/stdout'];
        if (device.transport !== 'USB') { args.push('--native'); }
        args.push('--udid', device.id);
    }

    const { stdout } = await execFileAsync(command, args, {
        encoding: 'buffer', timeout: 45_000, maxBuffer: 32 * 1024 * 1024,
        signal, cwd: workingDirectory,
    });
    if (stdout.length < 24 || !stdout.subarray(0, 8).equals(pngSignature)) {
        throw new Error('The device did not return a PNG screenshot.');
    }
    return stdout;
}

export async function copyScreenshot(image: Buffer, signal: AbortSignal): Promise<void> {
    if (process.platform !== 'darwin') {
        throw new Error('Image clipboard support currently requires macOS.');
    }
    const script = `ObjC.import('AppKit'); ObjC.import('Foundation');
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const image = $.NSImage.alloc.initWithData(data);
if (!image.size.width || !image.size.height) { throw new Error('Invalid image'); }
const clipboard = $.NSPasteboard.generalPasteboard;
clipboard.clearContents;
if (!clipboard.writeObjects($.NSArray.arrayWithObject(image))) { throw new Error('Clipboard write failed'); }`;
    await new Promise<void>((resolve, reject) => {
        const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
            timeout: 15_000, maxBuffer: 64 * 1024, signal,
        }, error => {
            if (error) { reject(error); } else { resolve(); }
        });
        child.stdin?.on('error', reject);
        child.stdin?.end(image);
    });
}