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
  const managerPassphraseControls = await page.evaluate(() =>
    [...document.querySelectorAll('input[type="password"]')].map((input) => {
      const toggle = document.querySelector(
        `[data-passphrase-toggle][aria-controls="${input.id}"]`,
      );
      return {
        id: input.id,
        toggleType: toggle instanceof HTMLButtonElement ? toggle.type : '',
        pressed: toggle?.getAttribute('aria-pressed'),
      };
    }),
  );
  if (
    managerPassphraseControls.length !== 9 ||
    managerPassphraseControls.some(
      ({ toggleType, pressed }) => toggleType !== 'button' || pressed !== 'false',
    )
  ) {
    throw new Error('Manager passphrase fields do not all have valid visibility controls.');
  }

  const vaultPassphrase = 'correct horse battery staple';
  await page.locator('#setup-device-label').fill('Smoke test device');
  const setupPassphrase = page.locator('#setup-passphrase');
  const setupConfirmation = page.locator('#setup-passphrase-confirm');
  const setupVisibility = page.locator('[aria-controls="setup-passphrase"]');
  await setupPassphrase.fill(vaultPassphrase);
  await setupConfirmation.fill(vaultPassphrase);
  await setupVisibility.click();
  if (
    (await setupPassphrase.getAttribute('type')) !== 'text' ||
    (await setupPassphrase.inputValue()) !== vaultPassphrase ||
    (await setupVisibility.getAttribute('aria-pressed')) !== 'true' ||
    (await setupVisibility.getAttribute('aria-label')) !== 'Hide new passphrase' ||
    (await setupConfirmation.getAttribute('type')) !== 'password' ||
    !(await page.locator('#onboarding').isVisible())
  ) {
    throw new Error('Showing a passphrase changed its value, another field, or the form state.');
  }
  await setupVisibility.press('Space');
  if (
    (await setupPassphrase.getAttribute('type')) !== 'password' ||
    (await setupVisibility.getAttribute('aria-pressed')) !== 'false' ||
    (await setupVisibility.getAttribute('aria-label')) !== 'Show new passphrase'
  ) {
    throw new Error('Keyboard activation did not hide the passphrase again.');
  }
  await page.locator('#setup-form button[type=submit]').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  if ((await setupPassphrase.getAttribute('type')) !== 'password') {
    throw new Error('The setup form did not re-mask its passphrase after reset.');
  }

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

  await page.getByRole('button', { name: 'Export' }).first().click();
  const exportDialog = page.locator('#export-dialog');
  const exportPassphrase = page.locator('#export-passphrase');
  await exportDialog.waitFor({ state: 'visible' });
  await exportPassphrase.fill('temporary export secret');
  await page.locator('[aria-controls="export-passphrase"]').click();
  await page.keyboard.press('Escape');
  await exportDialog.waitFor({ state: 'hidden' });
  if (
    (await exportPassphrase.getAttribute('type')) !== 'password' ||
    (await exportPassphrase.inputValue()) !== ''
  ) {
    throw new Error('Closing the export dialog did not clear and re-mask its passphrase.');
  }

  await page.locator('#import-button').click();
  const importDialog = page.locator('#import-dialog');
  const importPassphrase = page.locator('#import-passphrase');
  await importDialog.waitFor({ state: 'visible' });
  await importPassphrase.fill('temporary import secret');
  await page.locator('[aria-controls="import-passphrase"]').click();
  await page.keyboard.press('Escape');
  await importDialog.waitFor({ state: 'hidden' });
  if (
    (await importPassphrase.getAttribute('type')) !== 'password' ||
    (await importPassphrase.inputValue()) !== ''
  ) {
    throw new Error('Closing the import dialog did not clear and re-mask its passphrase.');
  }

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

  await page.locator('#lock-button').click();
  await page.locator('#unlock-panel').waitFor({ state: 'visible' });
  const managerUnlock = page.locator('#unlock-passphrase');
  await managerUnlock.fill(vaultPassphrase);
  await page.locator('[aria-controls="unlock-passphrase"]').click();
  if ((await managerUnlock.getAttribute('type')) !== 'text') {
    throw new Error('Manager unlock passphrase was not revealed.');
  }
  await page.locator('#unlock-form button[type=submit]').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  if (
    (await managerUnlock.getAttribute('type')) !== 'password' ||
    (await managerUnlock.inputValue()) !== ''
  ) {
    throw new Error('Manager unlock did not clear and re-mask the passphrase.');
  }

  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#actions').waitFor({ state: 'visible' });
  await page.locator('#lock-button').click();
  await page.locator('#unlock-form').waitFor({ state: 'visible' });
  const popupUnlock = page.locator('#unlock-passphrase');
  const popupVisibility = page.locator('[aria-controls="unlock-passphrase"]');
  await popupUnlock.fill(vaultPassphrase);
  await popupVisibility.click();
  if (
    (await popupUnlock.getAttribute('type')) !== 'text' ||
    (await popupVisibility.getAttribute('aria-label')) !== 'Hide passphrase'
  ) {
    throw new Error('Popup passphrase visibility control did not reveal the passphrase.');
  }
  await page.locator('#unlock-form button[type=submit]').click();
  await page.locator('#actions').waitFor({ state: 'visible' });
  if ((await popupUnlock.getAttribute('type')) !== 'password' || (await popupUnlock.inputValue())) {
    throw new Error('Popup unlock did not clear and re-mask the passphrase.');
  }
  process.stdout.write(
    'Chromium extension smoke test passed: passphrase visibility → setup → save → list → restore.\n',
  );
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
