import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    checkedAtUtc: '2026-09-23T12:00:00.1234567+00:00',
    rootType: 'Synthetic.EditorPage',
    alive: true,
    gcRounds: 10,
    survivors: [
      { kind: 'visual', type: 'Synthetic.EditorHandler' },
      { kind: 'bindingContext', type: 'Synthetic.EditorViewModel' },
    ],
    ...overrides,
  };
}

function file(name: string, records: unknown[]) {
  return {
    name,
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(records.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n')),
  };
}

async function settleMotion(page: Page) {
  await page.locator('.workspace').evaluate(element =>
    Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
}

async function importBoth(page: Page) {
  await page.getByLabel('Diagnostic files').setInputFiles([
    file('checks.jsonl', [
      record({ checkedAtUtc: '2026-09-23T13:00:00Z', alive: false, survivors: [] }),
      record(),
    ]),
    file('checks.previous.jsonl', [
      record({ checkedAtUtc: '2026-09-23T11:00:00Z', rootType: 'Synthetic.Dialog' }),
      record(),
      '{"schemaVersion":1,',
      record({ schemaVersion: 7 }),
    ]),
  ]);
  await expect(page.getByTestId('check-count')).toHaveText('4');
}

test('imports both sources, preserves repeats and refreshes JSONL without opening the file menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No diagnostic files' })).toBeVisible();
  await importBoth(page);
  await expect(page.getByTestId('survived-count')).toHaveText('3');
  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Sources', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await expect(page.locator('.event-table tbody tr')).toHaveCount(4);
  await expect(page.locator('.event-table tbody tr').first()).toContainText('11:00:00');
  await page.getByLabel('Files', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sources', exact: true })).toContainText('2 lines skipped');
  await page.locator('.source-issues summary').click();
  await expect(page.locator('.source-issues')).toContainText('Unsupported schema 7');
  await expect(page.getByRole('region', { name: 'Filters', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Check details', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Data interpretation', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Sources', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspect Synthetic.EditorPage, checks.jsonl line 2', exact: true }).click();
  const details = page.getByRole('region', { name: 'Check details', exact: true });
  await expect(details).toContainText('checks.jsonl');
  await expect(details).toContainText('Line 2');
  await expect(details.locator('.survivor-list li')).toHaveCount(2);
  await expect(details).toContainText('Synthetic.EditorHandler');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple()).toBeTruthy();
  await chooser.setFiles(file('checks.jsonl', [record({ checkedAtUtc: '2026-09-23T14:00:00Z', alive: false, survivors: [] })]));
  await expect(page.getByTestId('check-count')).toHaveText('3');
  await expect(page.getByTestId('survived-count')).toHaveText('2');
  await page.getByLabel('Files', { exact: true }).click();
  await expect(page.locator('.source-item').first()).toContainText('2 checks');
  await expect(page.locator('.source-item').last()).toContainText('1 check');
  await page.getByRole('button', { name: 'Clear session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No diagnostic files' })).toBeVisible();
});

test('file picker and drop accept many named and legacy files, retaining chronology and per-file reload', async ({ page }) => {
  await page.goto('/');
  const activeName = 'checks-2026-09-23-Synthetic.EditorPage.jsonl';
  const previousName = 'checks-2026-09-23-Synthetic.EditorPage.previous.jsonl';
  const repeated = record({ checkedAtUtc: '2026-09-23T12:00:00Z' });
  const picking = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import files', exact: true }).click();
  const picker = await picking;
  expect(picker.isMultiple()).toBeTruthy();
  await picker.setFiles([
    file(activeName, [repeated, repeated]),
    file('checks.jsonl', [record({ checkedAtUtc: '2026-09-23T13:00:00Z' })]),
    file('checks-Synthetic.Dialog.jsonl', [record({ checkedAtUtc: '2026-09-23T11:00:00Z' }), 'broken']),
    file(previousName, [record({ checkedAtUtc: '2026-09-23T10:00:00Z' })]),
    file('checks.previous.jsonl', [record({ checkedAtUtc: '2026-09-23T09:00:00Z' })]),
  ]);
  await expect(page.getByTestId('check-count')).toHaveText('6');
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await expect(page.locator('.event-table time')).toHaveText(['09:00:00', '10:00:00', '11:00:00', '12:00:00', '12:00:00', '13:00:00']);
  await expect(page.locator('.event-table .source-long')).toHaveText([
    'checks.previous.jsonl', previousName, 'checks-Synthetic.Dialog.jsonl', activeName, activeName, 'checks.jsonl',
  ]);
  await page.getByLabel('Files', { exact: true }).click();
  await expect(page.locator('.source-item')).toHaveCount(5);
  await expect(page.locator('.source-issues summary')).toContainText('1 line skipped');
  const reloading = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: `Reload ${activeName}`, exact: true }).click();
  await (await reloading).setFiles(file(activeName, [record({ checkedAtUtc: '2026-09-23T14:00:00Z' })]));
  await expect(page.getByTestId('check-count')).toHaveText('5');
  await expect(page.locator('.source-item')).toHaveCount(5);
  await page.keyboard.press('Escape');
  const dataTransfer = await page.evaluateHandle(files => {
    const transfer = new DataTransfer();
    for (const item of files) transfer.items.add(new File([item.content], item.name, { type: 'application/x-ndjson' }));
    return transfer;
  }, [
    { name: 'checks-Synthetic.Dialog.jsonl', content: JSON.stringify(record({ checkedAtUtc: '2026-09-23T15:00:00Z' })) },
    { name: 'checks-Synthetic.Other.previous.jsonl', content: JSON.stringify(record({ checkedAtUtc: '2026-09-23T10:30:00Z' })) },
  ]);
  await page.locator('.app').dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByTestId('check-count')).toHaveText('6');
  await page.getByRole('tab', { name: 'Checks', exact: true }).click();
  await expect(page.locator('.event-table time')).toHaveText(['09:00:00', '10:00:00', '10:30:00', '13:00:00', '14:00:00', '15:00:00']);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.locator('.event-table .source-short').nth(4)).toHaveText(activeName);
  await page.getByRole('button', { name: `Inspect Synthetic.EditorPage, ${activeName} line 1`, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Check details', exact: true })).toContainText(activeName);
  await expect(page.getByRole('region', { name: 'Check details', exact: true })).toContainText('Line 1');
});

test('summary ranks root types and opens their checks without merging repeated events', async ({ page }) => {
  await page.goto('/');
  await importBoth(page);
  await expect(page.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.event-table')).toHaveCount(0);
  await expect(page.locator('.root-summary tbody tr')).toHaveCount(2);
  await expect(page.locator('.root-summary tbody tr').first()).toContainText('EditorPage');
  await expect(page.locator('.root-summary tbody tr').first()).toContainText('2 / 3 checks');
  await page.getByRole('button', { name: 'Show checks for Synthetic.EditorPage', exact: true }).click();
  await expect(page.locator('.event-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.event-table tbody tr').first()).toContainText('checks.previous.jsonl');
  await page.getByRole('button', { name: 'Inspect Synthetic.EditorPage, checks.jsonl line 2', exact: true }).click();
  await expect(page.locator('.detail-section')).toContainText('checks.jsonl');
  await page.getByRole('button', { name: 'Back to summary', exact: true }).click();
  await expect(page.locator('.detail-section')).toHaveCount(0);
  await expect(page.locator('.root-summary tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('check-count')).toHaveText('4');
  await page.getByRole('tab', { name: 'Summary', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Checks', exact: true })).toBeFocused();
  await expect(page.locator('.event-table tbody tr')).toHaveCount(4);
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('check sequence shows newest first, preserves repeats and provenance and opens the selected event on its chronological list page', async ({ page }) => {
  await page.goto('/');
  await importBoth(page);
  const sequence = page.getByRole('region', { name: 'Check sequence', exact: true });
  await expect(sequence.getByRole('listitem')).toHaveCount(4);
  await expect(sequence.locator('time')).toHaveText([
    '09-23 13:00:00 UTC', '09-23 12:00:00 UTC', '09-23 12:00:00 UTC', '09-23 11:00:00 UTC',
  ]);
  await expect(sequence.locator('.alive-status')).toHaveText(['\u2705', '\u{1F9DF}', '\u{1F9DF}', '\u{1F9DF}']);
  await expect(sequence.getByRole('img', { name: 'No monitored targets survived this check.', exact: true })).toHaveCount(1);
  await expect(sequence.getByRole('img', { name: 'Zombie check: something survived GC, not proof of a leak.', exact: true })).toHaveCount(3);
  await sequence.getByRole('button', { name: 'Inspect Synthetic.EditorPage, checks.previous.jsonl line 2, alive true', exact: true }).click();
  await expect(page.locator('.detail-section')).toContainText('checks.previous.jsonl');
  await expect(page.locator('.detail-section')).toContainText('Line 2');
  await expect(page.locator('.detail-section .alive-status')).toHaveText('\u{1F9DF}');
  await expect(page.locator('.selected-row')).toContainText('checks.previous.jsonl');
  await page.getByRole('tab', { name: 'Summary', exact: true }).click();
  await sequence.getByRole('button', { name: 'Show all checks', exact: true }).click();
  await expect(page.locator('.event-table tbody tr')).toHaveCount(4);
  await expect(page.locator('.event-table time')).toHaveText(['11:00:00', '12:00:00', '12:00:00', '13:00:00']);
  await expect(page.locator('.event-table .alive-status')).toHaveText(['\u{1F9DF}', '\u{1F9DF}', '\u{1F9DF}', '\u2705']);
  await page.getByLabel('Files', { exact: true }).click();
  await page.getByRole('button', { name: 'Clear session', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic sample', exact: true }).click();
  await expect(sequence.getByRole('listitem')).toHaveCount(6);
  await expect(sequence.locator('.sequence-source').first()).toHaveText('checks.jsonl:48');
  await expect(sequence.locator('.sequence-source').last()).toHaveText('checks.jsonl:43');
  await page.setViewportSize({ width: 390, height: 844 });
  await sequence.getByRole('listitem').first().getByRole('button').click();
  await expect(page.locator('.selected-row')).toContainText('checks.jsonl');
  await expect(page.locator('.selected-row')).toContainText(':48');
  await expect(page.locator('.detail-section')).toContainText('Line 48');
  await expect(page.locator('.detail-root')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Check pages', exact: true })).toContainText('81-96 of 96');
});

test('handles drag and drop, empty files, invalid records, unknown schemas and failed replacements', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Diagnostic files').setInputFiles(file('checks.jsonl', []));
  await expect(page.getByRole('heading', { name: 'Empty files' })).toBeVisible();
  await page.getByLabel('Diagnostic files').setInputFiles(file('checks.jsonl', ['broken', record({ alive: 'true' }), record({ schemaVersion: 2 })]));
  await expect(page.getByRole('heading', { name: 'No supported checks' })).toBeVisible();
  await page.getByLabel('Files', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sources', exact: true })).toContainText('3 lines skipped');
  await page.keyboard.press('Escape');
  const dataTransfer = await page.evaluateHandle(content => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'checks.jsonl', { type: 'application/x-ndjson' }));
    return transfer;
  }, JSON.stringify(record({ alive: false, survivors: [] })));
  await page.locator('.app').dispatchEvent('dragenter', { dataTransfer });
  await expect(page.locator('.drop-overlay')).toBeVisible();
  await page.locator('.app').dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByTestId('check-count')).toHaveText('1');
  await expect(page.getByTestId('survived-count')).toHaveText('0');
  await expect(page.locator('.drop-overlay')).toHaveCount(0);
  await page.getByLabel('Diagnostic files').setInputFiles(file('unexpected.jsonl', [record()]));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('check-count')).toHaveText('1');
  await page.getByLabel('Files', { exact: true }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Reload checks.jsonl', exact: true }).click();
  await (await chooserPromise).setFiles(file('checks.previous.jsonl', [record()]));
  await expect(page.getByTestId('check-count')).toHaveText('1');
  await expect(page.getByRole('alert')).toContainText('has not been replaced');
});

test('VS Code requests a device snapshot when the real inspector mounts', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as Window & { acquireVsCodeApi?: () => object; requested: string[] };
    host.requested = [];
    host.acquireVsCodeApi = () => ({ postMessage: (message: { type: string }) => host.requested.push(message.type) });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as Window & { requested: string[] }).requested)).toContain('deviceImportReady');
});

test('one-click device refresh ignores stale results, preserves data on failure and resets selection when the app changes', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as Window & { acquireVsCodeApi?: () => object; requested: string[] };
    host.requested = [];
    host.acquireVsCodeApi = () => ({ postMessage: (message: { type: string }) => host.requested.push(message.type) });
  });
  const send = (data: unknown) => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
  const origin = { id: 'synthetic/first', label: 'Synthetic app / Synthetic phone' };
  await page.goto('/');
  await send({ type: 'deviceImportLoading', requestId: 1, origin });
  await expect(page.getByRole('status')).toBeVisible();
  await send({ type: 'deviceImportLoaded', requestId: 1, origin, files: [
    { name: 'checks-first.previous.jsonl', content: JSON.stringify(record()), lastModified: 1 },
    { name: 'checks-first.jsonl', content: JSON.stringify(record({ alive: false, survivors: [] })), lastModified: 2 },
  ] });
  await expect(page.getByTestId('check-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Show checks for Synthetic.EditorPage', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Synthetic.EditorPage, checks-first.previous.jsonl line 1', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { requested: string[] }).requested.at(-1))).toBe('deviceImportRefresh');
  await send({ type: 'deviceImportLoading', requestId: 2, origin });
  await expect(page.getByRole('button', { name: 'Refresh diagnostics', exact: true })).toBeDisabled();
  await send({ type: 'deviceImportLoaded', requestId: 1, origin, files: [
    { name: 'checks.jsonl', content: '', lastModified: 1 },
  ] });
  await expect(page.getByTestId('check-count')).toHaveText('2');
  await send({ type: 'deviceImportLoaded', requestId: 2, origin, files: [
    { name: '../checks-private.jsonl', content: '', lastModified: 1 },
  ] });
  await expect(page.locator('.app')).toHaveAttribute('aria-busy', 'true');
  await send({ type: 'deviceImportError', requestId: 2, message: 'Synthetic read failed.' });
  await expect(page.locator('.app')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('check-count')).toHaveText('2');
  await expect(page.locator('.detail-section')).toContainText('checks-first.previous.jsonl');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
  const changedOrigin = { id: 'synthetic/second', label: 'Another app / Another phone' };
  await send({ type: 'deviceImportLoading', requestId: 3, origin: changedOrigin });
  await send({ type: 'deviceImportLoaded', requestId: 3, origin: changedOrigin, files: [
    { name: 'checks-second.jsonl', content: JSON.stringify(record({ alive: false, survivors: [] })), lastModified: 3 },
  ] });
  await expect(page.locator('.detail-section')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh diagnostics', exact: true })).toBeEnabled();
  await expect(page.getByTestId('check-count')).toHaveText('1');
  await expect(page.getByTestId('survived-count')).toHaveText('0');
  await page.getByLabel('Files', { exact: true }).click();
  await expect(page.locator('.source-item')).toHaveCount(1);
  await expect(page.locator('.source-origin')).toHaveText(changedOrigin.label);
  await expect(page.locator('.source-name')).toHaveText('checks-second.jsonl');
  await page.keyboard.press('Escape');
  await page.getByLabel('Diagnostic files').setInputFiles(file('checks-export.jsonl', [record()]));
  const deviceRequests = await page.evaluate(() => (window as Window & { requested: string[] }).requested.length);
  const reloading = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
  await (await reloading).setFiles(file('checks-export.jsonl', [record(), record()]));
  await expect(page.getByTestId('check-count')).toHaveText('3');
  expect(await page.evaluate(() => (window as Window & { requested: string[] }).requested.length)).toBe(deviceRequests);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('imported content stays in memory, never triggers network or console output and is escaped', async ({ page }) => {
  const consoleMessages: string[] = [];
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('console', message => consoleMessages.push(message.text()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  const response = await page.goto('/');
  expect(response?.ok()).toBeTruthy();
  await page.evaluate(() => document.fonts.ready);
  const networkAfterImport: string[] = [];
  page.on('request', request => networkAfterImport.push(request.url()));
  const sentinel = 'Synthetic.Private<svg onload="alert(1)">';
  await page.getByLabel('Diagnostic files').setInputFiles(file('checks.jsonl', [record({ rootType: sentinel, survivors: [] })]));
  await expect(page.getByTestId('check-count')).toHaveText('1');
  await expect(page.getByTestId('survived-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: `Show checks for ${sentinel}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Show checks for ${sentinel}`, exact: true }).click();
  await page.getByRole('button', { name: /^Inspect Synthetic.Private/ }).click();
  await expect(page.locator('.full-type')).toHaveText(sentinel);
  await expect(page.locator('svg[onload]')).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  expect(consoleMessages.filter(message => message.includes('Synthetic.Private'))).toEqual([]);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(networkAfterImport).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('check-count')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No diagnostic files' })).toBeVisible();
});

test('motion stays bounded without moving totals or controls, and reduced motion keeps all content usable', async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Synthetic sample', exact: true }).click();
    const motion = await page.locator('.workspace').evaluate(element => {
      const animations = element.getAnimations({ subtree: true });
      const bounds = () => Array.from(element.querySelectorAll('[data-testid], .sequence-step'), target => {
        const rect = target.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
      const before = bounds();
      const bar = element.querySelector('.timeline-bar')!;
      const start = getComputedStyle(bar).transform;
      const bounded = animations.every(animation => Number(animation.effect?.getComputedTiming().endTime) <= 900);
      for (const animation of animations) animation.finish();
      return { count: animations.length, bounded, before, after: bounds(), start, end: getComputedStyle(bar).transform };
    });
    expect(motion.count).toBeGreaterThan(1);
    expect(motion.bounded).toBeTruthy();
    expect(motion.before).toEqual(motion.after);
    expect(motion.start).not.toBe(motion.end);
    await expect(page.getByTestId('check-count')).toHaveText('96');
    await expect(page.getByTestId('survived-count')).toHaveText('42');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.getByRole('button', { name: 'Synthetic sample', exact: true }).click();
    expect(await page.locator('.workspace').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    const barBounds = await page.locator('.chart-survived').first().boundingBox();
    expect(barBounds?.height).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Refresh diagnostics', exact: true })).toBeEnabled();
    await page.getByRole('region', { name: 'Check sequence', exact: true }).getByRole('listitem').last().getByRole('button').click();
    await expect(page.locator('.detail-root')).toBeInViewport();
    expect(await page.locator('.workspace').evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test('desktop and mobile remain usable with direct refresh, synthetic screenshots and long type names', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Synthetic sample', exact: true }).click();
  await expect(page.getByTestId('check-count')).toHaveText('96');
  await expect(page.locator('.root-summary tbody tr')).toHaveCount(4);
  await settleMotion(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-synthetic.png') });
  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`).toBeTruthy();
    await expect(page.getByTestId('check-count')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh diagnostics', exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Files', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Sources', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Sources', exact: true })).toHaveCount(0);
  await settleMotion(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-synthetic.png') });
  await page.getByRole('button', { name: 'Show checks for Demo.Sheets.FilterSheet', exact: true }).click();
  await page.getByRole('button', { name: /^Inspect Demo.Sheets.FilterSheet/ }).first().click();
  await expect(page.locator('.detail-root')).toContainText('FilterSheet');
  await expect(page.locator('.event-section')).toBeHidden();
  await expect(page.locator('.detail-root')).toBeInViewport();
  await settleMotion(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-detail-synthetic.png') });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.locator('.detail-section')).toHaveCount(0);
  await expect(page.locator('.event-table')).toBeInViewport();
  await page.getByLabel('Diagnostic files').setInputFiles(file('checks.jsonl', [record({ rootType: `Synthetic.${'LongGenericType'.repeat(20)}`, survivors: [{ kind: 'visual', type: `Synthetic.${'LongHandler'.repeat(25)}` }] })]));
  await expect(page.getByTestId('check-count')).toHaveText('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: /^Show checks for Synthetic.LongGenericType/ }).click();
  await page.getByRole('button', { name: /^Inspect Synthetic.LongGenericType/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.evaluate(() => document.body.classList.add('vscode-dark'));
  await settleMotion(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-dark-synthetic.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.summary-mascot').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});