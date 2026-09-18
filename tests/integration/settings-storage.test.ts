import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrowserAdapter } from '../../src/platform/browser-adapter.ts';
import { SETTINGS_KEY, SettingsRepository } from '../../src/storage/settings.ts';
import { InMemoryStorageArea } from './helpers/in-memory-storage.ts';

function browserWith(local: InMemoryStorageArea): BrowserAdapter {
  return {
    local,
    getManifest: () => ({ browser_specific_settings: { gecko: { id: 'test@example.test' } } }),
    platformInfo: async () => ({ os: 'linux' }),
    browserInfo: async () => ({ name: 'Firefox', version: '143.0' }),
  } as unknown as BrowserAdapter;
}

test('SettingsRepository creates and persists device metadata once', async () => {
  const local = new InMemoryStorageArea();
  const settings = new SettingsRepository(browserWith(local));

  const created = await settings.get();
  const fetchedAgain = await settings.get();

  assert.deepEqual(fetchedAgain, created);
  assert.match(created.deviceId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.deviceLabel, 'This device');
  assert.equal(created.browserFamily, 'firefox');
  assert.equal(created.browserVersion, '143.0');
  assert.equal(created.operatingSystem, 'linux');
  assert.equal(created.syncEnabled, false);
  assert.equal(local.operations.filter((operation) => operation.method === 'set').length, 1);
});

test('settings updates preserve stable identity and reject invalid labels atomically', async () => {
  const local = new InMemoryStorageArea();
  const repository = new SettingsRepository(browserWith(local));
  const original = await repository.get();

  const updated = await repository.update({
    deviceId: '11111111-1111-4111-8111-111111111111',
    browserFamily: 'chrome',
    deviceLabel: '仕事用 laptop',
    syncEnabled: true,
    discardBackgroundTabs: true,
  });

  assert.equal(updated.deviceId, original.deviceId);
  assert.equal(updated.browserFamily, original.browserFamily);
  assert.equal(updated.deviceLabel, '仕事用 laptop');
  assert.equal(updated.syncEnabled, true);
  assert.equal(updated.discardBackgroundTabs, true);

  const beforeInvalidUpdate = local.snapshot()[SETTINGS_KEY];
  await assert.rejects(repository.update({ deviceLabel: ' '.repeat(10) }), /between 1 and 120/);
  await assert.rejects(repository.update({ deviceLabel: 'x'.repeat(121) }), /between 1 and 120/);
  assert.deepEqual(local.snapshot()[SETTINGS_KEY], beforeInvalidUpdate);
});
