import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createExportFile,
  createVault,
  decryptSnapshot,
  encryptSnapshot,
  importRawKey,
  PBKDF2_ITERATIONS,
  readExportFile,
  unlockVault,
} from '../../src/core/crypto.ts';
import { asArrayBuffer, base64ToBytes, bytesToBase64 } from '../../src/core/encoding.ts';
import { TabBridgeError, type ErrorCode } from '../../src/core/errors.ts';
import type { EncryptedSnapshot, Snapshot } from '../../src/core/types.ts';
import { snapshotFixture } from '../unit/fixtures.ts';

const PASSPHRASE = 'correct horse battery staple 🔐';
const OTHER_PASSPHRASE = 'entirely different passphrase 🛡️';

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof TabBridgeError && error.code === code;
}

function sensitiveSnapshot(): Snapshot {
  const snapshot = snapshotFixture();
  snapshot.name = 'PRIVATE_NAME_雪_🔬';
  snapshot.sourceDevice.label = 'PRIVATE_DEVICE_Ångström';
  const group = snapshot.windows[1]?.groups[0];
  const tab = snapshot.windows[1]?.tabs[0];
  assert.ok(group);
  assert.ok(tab);
  group.title = 'PRIVATE_GROUP_مجموعة';
  tab.title = 'PRIVATE_TITLE_é_🌍';
  tab.url = 'https://plaintext-leak.invalid/PRIVATE_URL?token=highly-sensitive#secret';
  return snapshot;
}

function indexedUuid(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function largeSnapshot(): Snapshot {
  const tabs = Array.from({ length: 1_000 }, (_, index) => ({
    id: indexedUuid(index + 1),
    url: `https://large.example/item/${index}?value=${index}#position-${index}`,
    title: Array.from({ length: 1_200 }, (_unused, character) =>
      String.fromCharCode(0x4e00 + ((index * 17 + character * 31) % 300)),
    ).join(''),
    index,
    pinned: index < 20,
    active: index === 999,
  }));
  return {
    schemaVersion: 1,
    snapshotId: '10000000-0000-4000-8000-000000001001',
    generationId: '10000000-0000-4000-8000-000000001002',
    name: 'Large encrypted workspace 📚',
    createdAt: '2026-09-18T20:42:00.000Z',
    updatedAt: '2026-09-18T20:42:00.000Z',
    sourceDevice: {
      id: '10000000-0000-4000-8000-000000001003',
      label: 'Load-test device',
      browser: 'chromium',
    },
    windows: [
      {
        id: '10000000-0000-4000-8000-000000001004',
        order: 0,
        activeTabId: indexedUuid(1_000),
        groups: [],
        tabs,
      },
    ],
    captureWarnings: [],
  };
}

async function digest(encoded: string): Promise<string> {
  const value = base64ToBytes(encoded);
  const result = await globalThis.crypto.subtle.digest('SHA-256', asArrayBuffer(value));
  return bytesToBase64(new Uint8Array(result));
}

function flipByte(encoded: string, index = 0): string {
  const value = base64ToBytes(encoded);
  value[index] = (value[index] ?? 0) ^ 1;
  return bytesToBase64(value);
}

const snapshot = sensitiveSnapshot();
const vaultPromise = createVault(PASSPHRASE);
const encryptedPromise = vaultPromise.then(async ({ config, key }) => ({
  config,
  key,
  encrypted: await encryptSnapshot(snapshot, key, config.vaultId),
}));

describe('authenticated snapshot encryption', () => {
  it(
    'round-trips Unicode and a maximum-tab payload without plaintext leakage',
    { timeout: 60_000 },
    async () => {
      const { config, key, encrypted } = await encryptedPromise;
      const second = await encryptSnapshot(snapshot, key, config.vaultId);

      assert.equal(config.kdf.name, 'PBKDF2');
      assert.equal(config.kdf.hash, 'SHA-256');
      assert.equal(config.kdf.iterations, PBKDF2_ITERATIONS);
      assert.equal(base64ToBytes(config.kdf.salt).byteLength, 16);
      assert.equal(base64ToBytes(config.verifier.iv).byteLength, 12);
      assert.equal((key.algorithm as AesKeyAlgorithm).name, 'AES-GCM');
      assert.equal((key.algorithm as AesKeyAlgorithm).length, 256);
      assert.equal(base64ToBytes(encrypted.cipher.iv).byteLength, 12);
      assert.notEqual(encrypted.cipher.iv, second.cipher.iv);

      const serialized = JSON.stringify(encrypted);
      for (const marker of [
        'PRIVATE_NAME',
        'PRIVATE_DEVICE',
        'PRIVATE_GROUP',
        'PRIVATE_TITLE',
        'PRIVATE_URL',
        'plaintext-leak.invalid',
      ]) {
        assert.equal(serialized.includes(marker), false, marker);
      }
      assert.equal(JSON.stringify(config).includes(PASSPHRASE), false);
      assert.deepEqual(await decryptSnapshot(encrypted, key), snapshot);

      const large = largeSnapshot();
      const encryptedLarge = await encryptSnapshot(large, key, config.vaultId);
      const decryptedLarge = await decryptSnapshot(encryptedLarge, key);
      assert.equal(decryptedLarge.windows[0]?.tabs.length, 1_000);
      assert.deepEqual(decryptedLarge, large);
    },
  );

  it('rejects a wrong key and a wrong vault passphrase', { timeout: 30_000 }, async () => {
    const { config, encrypted } = await encryptedPromise;
    const wrongKey = await importRawKey(bytesToBase64(new Uint8Array(32).fill(0xa5)));

    await assert.rejects(() => decryptSnapshot(encrypted, wrongKey), hasCode('CORRUPT_DATA'));
    await assert.rejects(() => unlockVault(OTHER_PASSPHRASE, config), hasCode('WRONG_PASSPHRASE'));
  });

  it('detects changes to ciphertext, digest, IV, and AAD-bound IDs', async () => {
    const { key, encrypted } = await encryptedPromise;
    const cases: EncryptedSnapshot[] = [];

    const ciphertext = structuredClone(encrypted);
    ciphertext.ciphertext = flipByte(
      ciphertext.ciphertext,
      base64ToBytes(ciphertext.ciphertext).length - 1,
    );
    ciphertext.digest = await digest(ciphertext.ciphertext);
    cases.push(ciphertext);

    const digestChange = structuredClone(encrypted);
    digestChange.digest = flipByte(digestChange.digest);
    cases.push(digestChange);

    const iv = structuredClone(encrypted);
    iv.cipher.iv = flipByte(iv.cipher.iv);
    cases.push(iv);

    const snapshotId = structuredClone(encrypted);
    snapshotId.snapshotId = '00000000-0000-4000-8000-000000000099';
    cases.push(snapshotId);

    const generationId = structuredClone(encrypted);
    generationId.generationId = '00000000-0000-4000-8000-000000000098';
    cases.push(generationId);

    for (const candidate of cases) {
      await assert.rejects(() => decryptSnapshot(candidate, key), hasCode('CORRUPT_DATA'));
    }
  });

  it('enforces passphrase length limits before derivation', async () => {
    await assert.rejects(() => createVault('too short'), hasCode('VALIDATION_ERROR'));
    await assert.rejects(() => createVault('x'.repeat(1_025)), hasCode('VALIDATION_ERROR'));
  });
});

describe('encrypted export files', () => {
  it(
    'round-trips independently, hides captured content, and rejects a wrong passphrase',
    { timeout: 60_000 },
    async () => {
      const file = await createExportFile(snapshot, PASSPHRASE);
      const serialized = JSON.stringify(file);

      assert.equal(file.kdf.iterations, PBKDF2_ITERATIONS);
      assert.equal(base64ToBytes(file.kdf.salt).byteLength, 16);
      assert.equal(base64ToBytes(file.cipher.iv).byteLength, 12);
      for (const marker of [
        'PRIVATE_NAME',
        'PRIVATE_DEVICE',
        'PRIVATE_GROUP',
        'PRIVATE_TITLE',
        'PRIVATE_URL',
        'plaintext-leak.invalid',
      ]) {
        assert.equal(serialized.includes(marker), false, marker);
      }

      assert.deepEqual(await readExportFile(serialized, PASSPHRASE), snapshot);
      await assert.rejects(
        () => readExportFile(file, OTHER_PASSPHRASE),
        hasCode('WRONG_PASSPHRASE'),
      );
    },
  );
});
