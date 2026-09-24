const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const extensionRoot = path.resolve(__dirname, '..');
const applicationId = 'org.synthetic.memory';
const deviceId = 'SYNTHETIC-DEVICE';

function record(hour, alive) {
    return {
        schemaVersion: 1, checkedAtUtc: `2026-09-23T${hour}:00:00Z`,
        rootType: 'Synthetic.MemoryPage', alive, gcRounds: 10,
        survivors: alive ? [{ kind: 'visual', type: 'Synthetic.MemoryHandler' }] : [],
    };
}

function writeRecords(directory, name, records) {
    fs.writeFileSync(path.join(directory, name), records.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'));
}

async function runDeviceTool() {
    const root = process.env.MAUI_MEMORY_FIXTURE;
    const args = process.argv.slice(3);
    const diagnostics = path.join(root, 'diagnostics');
    fs.appendFileSync(path.join(root, 'device-calls.jsonl'), `${JSON.stringify(args)}\n`);
    if (args[0] === 'simctl' && args[1] === 'list') {
        process.stdout.write(JSON.stringify({ devices: {} }));
        return;
    }
    if (args[0] === 'devicectl' && args[1] === 'list') {
        process.stdout.write(JSON.stringify({ result: { devices: [{
            identifier: deviceId,
            hardwareProperties: { udid: deviceId, productType: 'Synthetic iPhone' },
            deviceProperties: { name: 'Synthetic phone', osVersionNumber: '26.0' },
            connectionProperties: { pairingState: 'paired', transportType: 'wired', tunnelState: 'connected' },
        }] } }));
        return;
    }
    assert.equal(args[args.indexOf('--device') + 1], deviceId);
    assert.equal(args[args.indexOf('--domain-identifier') + 1], applicationId);
    assert.equal(args[args.indexOf('--domain-type') + 1], 'appDataContainer');
    if (fs.existsSync(path.join(root, 'fail-device'))) throw new Error('Synthetic private device failure');
    if (args[2] === 'info' && args[3] === 'files') {
        const directory = args[args.indexOf('--subdirectory') + 1];
        assert.ok(['Library', 'Library/memory-diagnostics'].includes(directory));
        assert.ok(args.includes('--no-recurse'));
        const names = directory === 'Library' ? ['memory-diagnostics'] : fs.readdirSync(diagnostics);
        process.stdout.write(JSON.stringify({ result: { files: names.map(name => ({
            name, metadata: { size: directory === 'Library' ? 0 : fs.statSync(path.join(diagnostics, name)).size },
            resources: { isDirectory: directory === 'Library', isSymbolicLink: false },
        })) } }));
        return;
    }
    assert.deepEqual(args.slice(0, 4), ['devicectl', 'device', 'copy', 'from']);
    const source = args[args.indexOf('--source') + 1];
    assert.equal(path.posix.dirname(source), 'Library/memory-diagnostics');
    const destination = args[args.indexOf('--destination') + 1];
    assert.equal(fs.statSync(path.dirname(destination)).mode & 0o777, 0o700);
    if (fs.existsSync(path.join(root, 'block-copy'))) {
        fs.writeFileSync(path.join(root, 'copy-started'), '');
        await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    fs.copyFileSync(path.join(diagnostics, path.posix.basename(source)), destination);
}

async function runVscodeTest() {
    const { _electron, expect } = require('../memory-inspector/node_modules/@playwright/test');
    const executablePath = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    assert.ok(fs.existsSync(executablePath), 'Set VSCODE_EXECUTABLE to the local VS Code executable.');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-'));
    const workspace = path.join(root, 'workspace');
    const tools = path.join(root, 'tools');
    const temporary = path.join(root, 'tmp');
    const diagnostics = path.join(root, 'diagnostics');
    const output = path.join(extensionRoot, 'memory-inspector', 'test-results', 'vscode');
    let app;
    let page;
    try {
        for (const directory of [workspace, tools, temporary, diagnostics, output, path.join(root, 'extensions'), path.join(root, 'profile', 'User')]) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.writeFileSync(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
            'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
            'workbench.enableExperiments': false, 'extensions.ignoreRecommendations': true,
            'extensions.autoUpdate': false, 'security.workspace.trust.enabled': false,
        }));
        fs.writeFileSync(path.join(workspace, 'SyntheticMemory.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0-ios</TargetFramework><UseMaui>true</UseMaui><ApplicationId>org.synthetic.memory</ApplicationId></PropertyGroup></Project>');
        const bundle = path.join(workspace, 'bin', 'Debug', 'net10.0-ios', 'ios-arm64', 'SyntheticMemory.app');
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.synthetic.memory</string></dict></plist>');
        const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
        fs.writeFileSync(path.join(tools, 'xcrun'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} device-tool "$@"\n`, { mode: 0o700 });
        writeRecords(diagnostics, 'checks.previous.jsonl', [record('09', false), record('10', true)]);
        writeRecords(diagnostics, 'checks-session.previous.jsonl', [record('11', true)]);
        writeRecords(diagnostics, 'checks-session.jsonl', [record('11', true), record('12', false), '{"schemaVersion":1,']);
        writeRecords(diagnostics, 'checks.jsonl', [record('13', false)]);
        fs.writeFileSync(path.join(diagnostics, 'unrelated.txt'), 'Never copy this synthetic non-diagnostic file.');
        const env = { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, TMPDIR: temporary, MAUI_MEMORY_FIXTURE: root, VSCODE_CLI: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        let developmentPath = extensionRoot;
        const packageIndex = process.argv.indexOf('--vsix');
        if (packageIndex !== -1) {
            assert.ok(process.argv[packageIndex + 1], 'Pass the VSIX path after --vsix.');
            const archive = path.resolve(process.argv[packageIndex + 1]);
            const cli = path.resolve(executablePath, '../../Resources/app/bin/code');
            execFileSync(cli, [
                '--user-data-dir', path.join(root, 'profile'), '--extensions-dir', path.join(root, 'extensions'),
                '--install-extension', archive, '--force', '--disable-telemetry',
            ], { env, encoding: 'utf8', timeout: 60_000 });
            const installed = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'extensions.json'), 'utf8'))
                .find(extension => extension.identifier.id.toLowerCase() === 'finstadproductions.maui-deploy');
            assert.ok(installed, 'The VSIX must install in the isolated profile.');
            developmentPath = path.join(root, 'extensions', installed.relativeLocation);
            console.log('Testing the VSIX installed only in a temporary profile.');
        }
        app = await _electron.launch({ executablePath, env, timeout: 45_000, args: [
            `--extensionDevelopmentPath=${developmentPath}`, `--user-data-dir=${path.join(root, 'profile')}`,
            `--extensions-dir=${path.join(root, 'extensions')}`, '--disable-extensions', '--disable-workspace-trust',
            '--disable-telemetry', '--force-disable-user-env', '--skip-welcome', '--skip-release-notes', '--new-window', workspace,
        ] });
        page = await app.firstWindow();
        page.setDefaultTimeout(15_000);
        await page.setViewportSize({ width: 1280, height: 900 });
        const toolbar = page.getByRole('button', { name: 'Open MAUI Deploy tools', exact: true });
        await expect(toolbar).toBeVisible({ timeout: 30_000 });
        await toolbar.click();
        let toolboxFrame;
        await expect.poll(async () => {
            for (const frame of page.frames()) {
                if (await frame.locator('.toolbox').count()) { toolboxFrame = frame; return true; }
            }
            return false;
        }, { timeout: 20_000 }).toBe(true);
        await expect(toolboxFrame.getByRole('button', { name: 'Select project', exact: true })).toContainText('SyntheticMemory');
        await expect(page.locator('.statusbar [id^="FinstadProductions.maui-deploy."]')).toHaveCount(4);
        await expect(page.locator('.part.sidebar')).toBeVisible();
        await expect(page.locator('.tabs-container .tab').filter({ hasText: /^MAUI Deploy$/ })).toHaveCount(0);
        const projectPicker = page.getByRole('button', { name: 'Select MAUI Deploy project', exact: true });
        await expect(projectPicker).toContainText('SyntheticMemory');
        await projectPicker.click();
        await expect(toolboxFrame.getByRole('region', { name: 'Select MAUI Project', exact: true })).toBeVisible();
        await expect(page.locator('.quick-input-widget')).toBeHidden();
        await toolboxFrame.getByRole('combobox', { name: 'Search choices', exact: true }).press('Escape');
        await expect(projectPicker).toContainText('SyntheticMemory');
        await expect(toolboxFrame.getByRole('button', { name: 'Select project', exact: true })).toContainText('SyntheticMemory');
        await toolboxFrame.getByRole('button', { name: 'Select project', exact: true }).click();
        await toolboxFrame.getByRole('combobox', { name: 'Search choices', exact: true }).fill('SyntheticMemory');
        await toolboxFrame.getByRole('option', { name: /SyntheticMemory/ }).click();
        await expect(projectPicker).toContainText('SyntheticMemory');
        await toolboxFrame.getByRole('button', { name: 'Release', exact: true }).click();
        await expect(toolboxFrame.getByRole('button', { name: 'Release', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await toolboxFrame.getByRole('button', { name: 'Debug', exact: true }).first().click();
        await expect(toolboxFrame.getByRole('button', { name: 'Debug', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
        await toolboxFrame.locator('.toolbox').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        await page.screenshot({ path: path.join(output, 'tools-desktop-synthetic.png') });
        await toolboxFrame.getByRole('button', { name: 'Record video', exact: true }).click();
        await expect(toolboxFrame.getByRole('option', { name: /Synthetic phone/ })).toBeVisible();
        await expect(page.locator('.quick-input-widget')).toBeHidden();
        await expect(toolboxFrame.getByRole('region', { name: 'MAUI Deploy: Record Video', exact: true })).toBeVisible();
        await expect(page.locator('.notifications-toasts').filter({ hasText: 'MAUI Deploy: Record Video' })).toHaveCount(0);
        await page.screenshot({ path: path.join(output, 'tools-progress-synthetic.png'), animations: 'disabled' });
        await toolboxFrame.getByRole('combobox', { name: 'Search choices', exact: true }).press('Escape');
        await expect(toolboxFrame.getByRole('region', { name: 'MAUI Deploy: Record Video', exact: true })).toHaveCount(0);
        await expect(toolboxFrame.getByRole('button', { name: 'Record video', exact: true })).toBeEnabled();
        await toolboxFrame.getByRole('button', { name: 'Select device', exact: true }).click();
        await expect(toolboxFrame.getByRole('region', { name: 'Select Target Device', exact: true })).toBeVisible();
        const phoneChoice = toolboxFrame.getByRole('option', { name: /Synthetic phone/ });
        await expect(phoneChoice.locator('.platform-ios .toolbox-platform-logo')).toBeVisible();
        await phoneChoice.click();
        await expect(toolboxFrame.getByRole('button', { name: 'Select device', exact: true })).toContainText('Synthetic phone');
        const deviceToolbar = page.locator('.statusbar [id="FinstadProductions.maui-deploy.mauideploy.device"]');
        await expect(deviceToolbar).toContainText('Synthetic phone');
        await deviceToolbar.click();
        await expect(phoneChoice.locator('.platform-ios .toolbox-platform-logo')).toBeVisible();
        await page.screenshot({ path: path.join(output, 'tools-device-picker-synthetic.png'), animations: 'disabled' });
        await toolboxFrame.getByRole('button', { name: 'Cancel selection', exact: true }).click();
        await expect(deviceToolbar).toContainText('Synthetic phone');
        const openDiagnostics = async () => {
            await toolbar.click();
            await toolboxFrame.getByRole('button', { name: 'DUI memory diagnostics', exact: true }).click();
        };
        await openDiagnostics();
        let inspector;
        await expect.poll(async () => {
            for (const frame of page.frames()) {
                if (await frame.locator('.app').count()) { inspector = frame; return true; }
            }
            return false;
        }, { timeout: 20_000 }).toBe(true);
        await expect(inspector.getByTestId('check-count')).toHaveText('6', { timeout: 20_000 });
        await expect(inspector.getByTestId('survived-count')).toHaveText('3');
        await inspector.getByLabel('Files', { exact: true }).click();
        await expect(inspector.locator('.source-item')).toHaveCount(4);
        await expect(inspector.locator('.source-origin').first()).toContainText('org.synthetic.memory / Synthetic phone');
        await expect(inspector.locator('.source-issues summary')).toContainText('1 line skipped');
        await inspector.getByLabel('Files', { exact: true }).press('Escape');
        await inspector.locator('.workspace').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        await page.screenshot({ path: path.join(output, 'desktop-synthetic.png') });
        await inspector.getByRole('tab', { name: 'Checks', exact: true }).click();
        await expect(inspector.locator('.event-table time')).toHaveText(['09:00:00', '10:00:00', '11:00:00', '11:00:00', '12:00:00', '13:00:00']);
        await inspector.getByRole('button', { name: 'Inspect Synthetic.MemoryPage, checks-session.jsonl line 1', exact: true }).click();
        await expect(inspector.locator('.detail-section')).toContainText('checks-session.jsonl');
        await expect(inspector.locator('.detail-section')).toContainText('Synthetic.MemoryHandler');

        fs.unlinkSync(path.join(diagnostics, 'checks-session.previous.jsonl'));
        writeRecords(diagnostics, 'checks-session.jsonl', [record('14', false)]);
        await inspector.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
        await expect(inspector.getByTestId('check-count')).toHaveText('4');
        await expect(inspector.getByTestId('survived-count')).toHaveText('1');
        await inspector.getByLabel('Files', { exact: true }).click();
        await expect(inspector.locator('.source-item')).toHaveCount(3);
        await inspector.getByLabel('Files', { exact: true }).press('Escape');
        fs.writeFileSync(path.join(root, 'fail-device'), '');
        await inspector.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
        await expect(inspector.getByRole('alert')).toBeVisible();
        await expect(inspector.getByRole('alert')).not.toContainText('Synthetic private');
        await expect(inspector.getByTestId('check-count')).toHaveText('4');
        fs.unlinkSync(path.join(root, 'fail-device'));

        fs.writeFileSync(path.join(root, 'block-copy'), '');
        await inspector.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
        await expect.poll(() => fs.existsSync(path.join(root, 'copy-started'))).toBe(true);
        await expect(inspector.getByRole('button', { name: 'Refresh diagnostics', exact: true })).toBeDisabled();
        await inspector.getByRole('button', { name: 'Cancel device import', exact: true }).click();
        await expect(inspector.getByRole('status')).toHaveCount(0);
        await expect(inspector.locator('.app')).toHaveAttribute('aria-busy', 'false');
        await expect(inspector.getByTestId('check-count')).toHaveText('4');
        fs.unlinkSync(path.join(root, 'block-copy'));
        await inspector.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
        await expect(inspector.getByRole('alert')).toHaveCount(0);
        await expect(inspector.getByRole('status')).toHaveCount(0);

        for (const command of ['View: Close Primary Side Bar', 'View: Close Secondary Side Bar']) {
            await page.keyboard.press('Meta+Shift+p');
            await page.locator('.quick-input-box input').fill(`>${command}`);
            await page.keyboard.press('Enter');
            await expect(page.locator('.quick-input-widget')).toBeHidden();
        }
        await page.setViewportSize({ width: 640, height: 844 });
        assert.ok(await inspector.evaluate(() => innerWidth) >= 320, 'The diagnostic panel must have at least 320 pixels.');
        await inspector.locator('.workspace').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        assert.equal(await inspector.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'The diagnostic panel must not overflow.');
        await page.screenshot({ path: path.join(output, 'narrow-synthetic.png') });
        await toolbar.click();
        await expect(toolboxFrame.locator('.toolbox')).toBeVisible();
        await toolboxFrame.getByRole('button', { name: 'Select project', exact: true }).scrollIntoViewIfNeeded();
        await expect(toolboxFrame.getByRole('button', { name: 'Select project', exact: true })).toBeInViewport();
        await expect(toolboxFrame.getByRole('button', { name: 'Select project', exact: true })).toContainText('SyntheticMemory');
        assert.equal(await toolboxFrame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'The tools window must not overflow.');
        await page.screenshot({ path: path.join(output, 'tools-narrow-synthetic.png') });
        assert.equal(fs.readdirSync(temporary).some(name => name.startsWith('mauideploy-memory-')), false);
        const calls = fs.readFileSync(path.join(root, 'device-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const copies = calls.filter(args => args.includes('copy'));
        assert.ok(copies.length >= 7);
        assert.ok(copies.every(args => !args.includes('unrelated.txt') && args[args.indexOf('--source') + 1].startsWith('Library/memory-diagnostics/checks')));
        console.log('PASS: real VS Code sidebar, toolbar project picker, inline progress without popup, and diagnostics import/refresh/failure/cancellation.');
        console.log('PASS: isolated profile, private temporary copies removed, synthetic desktop/narrow screenshots. No installed extension or app was changed.');
    } catch (error) {
        if (page) await page.screenshot({ path: path.join(output, 'failure-synthetic.png') }).catch(() => {});
        throw error;
    } finally {
        if (app) await app.close().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }
}

if (process.argv[2] === 'device-tool') {
    runDeviceTool().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
} else {
    runVscodeTest().catch(error => { console.error(error.message); process.exitCode = 1; });
}