import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const extensionPath = path.resolve('dist/chrome');
const profile = await mkdtemp(path.join(os.tmpdir(), 'tabbridge-chromium-'));
const captureScreenshots = process.argv.includes('--screenshots');
const screenshotDirectory = path.resolve('docs/screenshots');
if (captureScreenshots) await mkdir(screenshotDirectory, { recursive: true });

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route('http://tabbridge.test/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>TabBridge smoke fixture</title><h1>Local fixture</h1>',
    });
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  if (captureScreenshots) {
    await page.screenshot({
      path: path.join(screenshotDirectory, 'manager-first-run.png'),
      fullPage: true,
    });
  }
  await page.locator('#setup-device-label').fill('Smoke test device');
  await page.locator('#setup-passphrase').fill('correct horse battery staple');
  await page.locator('#setup-passphrase-confirm').fill('correct horse battery staple');
  await page.locator('#setup-form button[type=submit]').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });

  const fixture = 'http://tabbridge.test/duplicate?secret=test-only';
  const first = await context.newPage();
  await first.goto(fixture);
  const second = await context.newPage();
  await second.goto(fixture);
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#actions').waitFor({ state: 'visible' });
  if (await page.locator('#unlock-form').isVisible()) {
    throw new Error('Popup displayed the unlock form while the vault was unlocked.');
  }
  if (captureScreenshots) {
    await page.locator('.popup-shell').screenshot({
      path: path.join(screenshotDirectory, 'popup.png'),
    });
  }
  await page.locator('#save-window').click();
  await page.locator('#live-status').filter({ hasText: 'Saved' }).waitFor();

  const windowsBefore = context.pages().length;
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.locator('.snapshot-card').first().waitFor();
  await page.getByRole('button', { name: 'Preview' }).first().click();
  if (captureScreenshots) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(screenshotDirectory, 'manager-snapshot-preview.png'),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Restore all' }).click();
  await page.getByText('Restore complete', { exact: true }).waitFor({ timeout: 20_000 });
  const deadline = Date.now() + 10_000;
  while (context.pages().length <= windowsBefore && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (context.pages().length <= windowsBefore) throw new Error('Restore did not open new tabs.');
  process.stdout.write('Chromium extension smoke test passed: setup → save → list → restore.\n');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
