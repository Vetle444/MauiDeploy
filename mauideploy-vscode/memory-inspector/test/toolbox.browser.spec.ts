import { expect, test } from '@playwright/test';
import { siApple, siAndroid } from 'simple-icons';
import { createToolboxSnapshot } from '../../src/toolboxModel';
import type { ToolboxContext, ToolboxPick } from '../../src/toolboxModel';

const ready: ToolboxContext = {
  project: { name: 'Synthetic.Mobile', directory: '~/projects/Synthetic.Mobile/src' },
  configuration: 'Debug', device: { name: 'Synthetic iPhone', platform: 'iOS' },
  trusted: true, captureSupported: true, debugging: false, screenshotBusy: false,
  recording: { state: 'idle', elapsed: '00:00' }, preview: { state: 'idle' },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as Window & { acquireVsCodeApi?: () => object; requested: unknown[] };
    host.requested = [];
    host.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => host.requested.push(message) });
  });
  await page.goto('http://127.0.0.1:4176/toolbox.html');
  await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), createToolboxSnapshot(ready));
});

test('toolbox dispatches known actions and reflects host-owned project, configuration and operation state', async ({ page }) => {
  expect(await page.evaluate(() => (window as Window & { requested: unknown[] }).requested)).toContainEqual({ type: 'toolboxReady' });
  await page.getByRole('button', { name: 'Select project', exact: true }).click();
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { requested: unknown[] }).requested.slice(-2))).toEqual([
    { type: 'toolboxAction', id: 'project' }, { type: 'toolboxAction', id: 'configuration' },
  ]);
  await expect(page.getByRole('button', { name: 'Debug', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
  const busy = createToolboxSnapshot({ ...ready, configuration: 'Release', operation: {
    command: 'mauideploy.runTests', message: 'Running synthetic tests', progress: 42, cancelling: false,
  } });
  await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), busy);
  await expect(page.getByRole('button', { name: 'Release', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Select project', exact: true })).toBeDisabled();
  await expect(page.getByRole('progressbar', { name: 'Build progress' })).toHaveAttribute('value', '42');
  await page.getByRole('button', { name: 'Stop operation', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { requested: unknown[] }).requested.at(-1))).toEqual({ type: 'toolboxAction', id: 'stop' });
  const managed = { ...busy, progress: [{ id: 'task-1', title: 'Synthetic tests', message: 'Preparing', cancellable: true, cancelling: false, operationCommand: 'mauideploy.runTests' }] };
  await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), managed);
  await expect(page.getByRole('region', { name: 'Current operation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Synthetic tests', exact: true })).toContainText('Preparing');
  await expect(page.getByRole('progressbar', { name: 'Synthetic tests progress', exact: true })).toHaveAttribute('value', '42');
  await page.getByRole('button', { name: 'Cancel Synthetic tests', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { requested: unknown[] }).requested.at(-1))).toEqual({ type: 'toolboxCancelProgress', id: 'task-1' });
  managed.progress[0].cancelling = true;
  await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), managed);
  await expect(page.getByRole('button', { name: 'Cancel Synthetic tests', exact: true })).toBeDisabled();
  const recording = createToolboxSnapshot({ ...ready, recording: { state: 'recording', elapsed: '01:05' } });
  await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), recording);
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toContainText('01:05');
  await expect(page.getByRole('button', { name: 'Take screenshot', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { requested: unknown[] }).requested.at(-1))).toEqual({ type: 'toolboxAction', id: 'recording' });
});

test('sidebar choices support search, keyboard selection, multi-select and cancellation without leaving the panel', async ({ page }, testInfo) => {
  const picker: ToolboxPick = {
    id: 'picker-1', title: 'Select device', placeholder: 'Search devices', value: '', busy: false, enabled: true,
    multiple: false, matchDescription: true, matchDetail: true, selectedIds: [],
    items: [
      { id: 'section-1', label: 'iOS', separator: true },
      { id: 'phone-1', label: 'Synthetic phone', description: 'iOS 26', detail: 'Connected via USB', separator: false, device: { platform: 'iOS', type: 'physical', transport: 'USB' } },
      { id: 'sim-1', label: 'Synthetic simulator', description: 'iOS 26', detail: 'Booted', separator: false, device: { platform: 'iOS', type: 'simulator' } },
      { id: 'section-2', label: 'Android', separator: true },
      { id: 'android-1', label: 'Synthetic Android phone', description: 'Android 16', detail: 'Connected via Wi-Fi', separator: false, device: { platform: 'Android', type: 'physical', transport: 'Wi-Fi' } },
      { id: 'emulator-1', label: 'Synthetic emulator', description: 'Android 16', detail: 'Shutdown', separator: false, device: { platform: 'Android', type: 'simulator' } },
    ],
  };
  const publish = (choice?: ToolboxPick) => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), createToolboxSnapshot({ ...ready, picker: choice }));
  const lastMessage = () => page.evaluate(() => (window as Window & { requested: unknown[] }).requested.at(-1));
  await page.getByRole('button', { name: 'Select device', exact: true }).click();
  expect(await lastMessage()).toEqual({ type: 'toolboxAction', id: 'device' });
  await publish(picker);
  const search = page.getByRole('combobox', { name: 'Search choices', exact: true });
  await expect(search).toBeFocused();
  await expect(page.getByRole('region', { name: 'Deployment context' })).toHaveCount(0);
  const phone = page.getByRole('option', { name: /Synthetic phone/ });
  const simulator = page.getByRole('option', { name: /Synthetic simulator/ });
  const android = page.getByRole('option', { name: /Synthetic Android phone/ });
  await expect(phone.locator('.toolbox-platform-logo')).toBeVisible();
  await expect(phone.locator('.toolbox-platform-logo path')).toHaveAttribute('d', siApple.path);
  await expect(phone.locator('.lucide-usb')).toBeVisible();
  await expect(simulator.locator('.lucide-monitor')).toBeVisible();
  await expect(simulator.locator('.lucide-usb, .lucide-wifi')).toHaveCount(0);
  await expect(android.locator('.toolbox-platform-logo path')).toHaveAttribute('d', siAndroid.path);
  await expect(android.locator('.lucide-wifi')).toBeVisible();
  await expect(page.getByRole('option', { name: /Synthetic emulator/ }).locator('.lucide-monitor')).toBeVisible();
  await page.setViewportSize({ width: 340, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('device-picker-light-synthetic.png'), fullPage: true });
  await page.evaluate(() => document.body.classList.add('vscode-dark'));
  await page.locator('.toolbox').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  const contrast = await phone.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const luminance = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const background = luminance(getComputedStyle(element).backgroundColor);
    return ['strong', '.toolbox-choice-copy small', '.toolbox-choice-device'].map(selector => {
      const foreground = luminance(getComputedStyle(element.querySelector(selector)!).color);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  });
  expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: testInfo.outputPath('device-picker-dark-synthetic.png'), fullPage: true });
  await page.evaluate(() => document.body.classList.remove('vscode-dark'));
  await search.fill('booted');
  expect(await lastMessage()).toEqual({ type: 'toolboxPickInput', id: picker.id, value: 'booted' });
  await expect(page.getByRole('option')).toHaveCount(1);
  await publish({ ...picker, value: 'booted' });
  await search.press('Enter');
  expect(await lastMessage()).toEqual({ type: 'toolboxPickAccept', id: picker.id, itemIds: ['sim-1'] });
  await publish();
  await expect(page.getByRole('button', { name: 'Select device', exact: true })).toBeFocused();

  picker.id = 'picker-2';
  picker.multiple = true;
  picker.selectedIds = ['phone-1'];
  await publish(picker);
  await search.fill('simulator');
  await publish({ ...picker, value: 'simulator' });
  await page.getByRole('option', { name: /Synthetic simulator/ }).click();
  expect(await lastMessage()).toEqual({ type: 'toolboxPickSelection', id: picker.id, itemIds: ['phone-1', 'sim-1'] });
  picker.selectedIds = ['phone-1', 'sim-1'];
  await publish({ ...picker, value: 'simulator' });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(await lastMessage()).toEqual({ type: 'toolboxPickAccept', id: picker.id, itemIds: ['phone-1', 'sim-1'] });
  await search.fill('');
  await publish(picker);
  await search.press('ArrowDown');
  expect(await lastMessage()).toEqual({ type: 'toolboxPickFocus', id: picker.id, itemId: 'sim-1' });
  for (const width of [390, 260, 220]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  await page.screenshot({ path: testInfo.outputPath('picker-narrow-synthetic.png'), fullPage: true });
  await search.press('Escape');
  expect(await lastMessage()).toEqual({ type: 'toolboxPickCancel', id: picker.id });
  await publish();
  await expect(page.getByRole('button', { name: 'Select device', exact: true })).toContainText('Synthetic iPhone');
});

test('toolbox is readable on desktop and mobile, uses only local assets and renders state as text', async ({ page }, testInfo) => {
  const externalRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
  const settle = () => page.locator('.toolbox').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await settle();
  await page.screenshot({ path: testInfo.outputPath('tools-desktop-synthetic.png') });
  for (const width of [1280, 768, 390, 320, 260, 220]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`).toBeTruthy();
    await expect(page.getByRole('button', { name: 'DUI memory diagnostics', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('tools-mobile-synthetic.png'), fullPage: true });
  const hostile = createToolboxSnapshot({ ...ready, project: { name: '<img src=x onerror="alert(1)">', directory: 'Synthetic/'.repeat(40) } });
  await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolboxState', state } })), hostile);
  await expect(page.getByRole('button', { name: 'Select project', exact: true })).toContainText('<img');
  await expect(page.locator('img[onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => document.body.classList.add('vscode-dark'));
  await page.screenshot({ path: testInfo.outputPath('tools-dark-synthetic.png'), fullPage: true });
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});