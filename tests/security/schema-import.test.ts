import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TabBridgeError, type ErrorCode } from '../../src/core/errors.ts';
import {
  assertSafeJsonValue,
  LIMITS,
  parseExportJson,
  parseSnapshotJson,
  validateExportFile,
  validateSnapshot,
} from '../../src/core/schema.ts';
import type { ExportFile } from '../../src/core/types.ts';
import { IDS, snapshotFixture } from '../unit/fixtures.ts';

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof TabBridgeError && error.code === code;
}

function exportFixture(): ExportFile {
  return {
    fileFormat: 'tabbridge',
    formatVersion: 1,
    schemaVersion: 1,
    snapshotId: IDS.snapshot,
    generationId: IDS.generation,
    compression: 'gzip',
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 600_000,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
    cipher: {
      name: 'AES-GCM',
      keyLength: 256,
      iv: 'AAAAAAAAAAAAAAAA',
    },
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };
}

describe('snapshot and import validation', () => {
  it('accepts valid hostile-looking strings as inert data without rewriting them', () => {
    const snapshot = snapshotFixture();
    const strings = {
      name: '<script>globalThis.compromised = true</script>',
      device: '<img src=x onerror="globalThis.compromised=true">',
      group: '"><svg onload=globalThis.compromised=true>',
      title: '&lt;not executable&gt; 雪 🔐',
    };
    snapshot.name = strings.name;
    snapshot.sourceDevice.label = strings.device;
    const group = snapshot.windows[1]?.groups[0];
    const tab = snapshot.windows[1]?.tabs[0];
    assert.ok(group);
    assert.ok(tab);
    group.title = strings.group;
    tab.title = strings.title;

    const parsed = parseSnapshotJson(JSON.stringify(snapshot));

    assert.equal(parsed.name, strings.name);
    assert.equal(parsed.sourceDevice.label, strings.device);
    assert.equal(parsed.windows[1]?.groups[0]?.title, strings.group);
    assert.equal(parsed.windows[1]?.tabs[0]?.title, strings.title);
    assert.equal(Object.hasOwn(globalThis, 'compromised'), false);
  });

  it('rejects every prototype-pollution key at any nesting level', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const value = JSON.parse(`{"outer":{"${key}":{"polluted":true}}}`) as unknown;
      assert.throws(() => assertSafeJsonValue(value), hasCode('VALIDATION_ERROR'));
    }
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  });

  it('rejects excessive nesting before schema traversal', () => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth <= LIMITS.nestingDepth; depth += 1) value = [value];

    assert.throws(() => assertSafeJsonValue(value), hasCode('VALIDATION_ERROR'));
  });

  it('enforces the UTF-8 byte limit before parsing imported JSON', () => {
    const oversized = `"${'€'.repeat(Math.floor(LIMITS.importBytes / 3) + 1)}"`;

    assert.ok(oversized.length < LIMITS.importBytes);
    assert.throws(() => parseSnapshotJson(oversized), hasCode('INVALID_IMPORT'));
  });

  it('rejects invalid JSON, unknown versions, and unknown properties', () => {
    assert.throws(() => parseSnapshotJson('{not-json'), hasCode('INVALID_IMPORT'));

    const future = { ...snapshotFixture(), schemaVersion: 2 };
    assert.throws(() => validateSnapshot(future), hasCode('UNSUPPORTED_VERSION'));

    const rootExtra = { ...snapshotFixture(), unexpected: 'value' };
    assert.throws(() => validateSnapshot(rootExtra), hasCode('VALIDATION_ERROR'));

    const nestedExtra = snapshotFixture() as unknown as Record<string, unknown>;
    const source = nestedExtra.sourceDevice as Record<string, unknown>;
    source.unexpected = 'value';
    assert.throws(() => validateSnapshot(nestedExtra), hasCode('VALIDATION_ERROR'));
  });

  it('enforces collection, identity, reference, active-tab, and string constraints', () => {
    const tooManyWindows = snapshotFixture();
    const sourceWindow = tooManyWindows.windows[0];
    assert.ok(sourceWindow);
    tooManyWindows.windows = Array.from({ length: LIMITS.windows + 1 }, () =>
      structuredClone(sourceWindow),
    );
    assert.throws(() => validateSnapshot(tooManyWindows), hasCode('VALIDATION_ERROR'));

    const duplicateTabs = snapshotFixture();
    const duplicateWindow = duplicateTabs.windows[1];
    assert.ok(duplicateWindow);
    const duplicateSource = duplicateWindow.tabs[0];
    assert.ok(duplicateSource);
    duplicateWindow.tabs[1] = structuredClone(duplicateSource);
    assert.throws(() => validateSnapshot(duplicateTabs), hasCode('VALIDATION_ERROR'));

    const danglingGroup = snapshotFixture();
    const danglingTab = danglingGroup.windows[1]?.tabs[0];
    assert.ok(danglingTab);
    danglingTab.groupId = '00000000-0000-4000-8000-000000000099';
    assert.throws(() => validateSnapshot(danglingGroup), hasCode('VALIDATION_ERROR'));

    const multipleActive = snapshotFixture();
    const inactiveTab = multipleActive.windows[1]?.tabs[0];
    assert.ok(inactiveTab);
    inactiveTab.active = true;
    assert.throws(() => validateSnapshot(multipleActive), hasCode('VALIDATION_ERROR'));

    const longName = snapshotFixture();
    longName.name = 'x'.repeat(LIMITS.nameLength + 1);
    assert.throws(() => validateSnapshot(longName), hasCode('VALIDATION_ERROR'));
  });

  it('validates cryptographic parameters and canonical base64 before expensive work', () => {
    assert.deepEqual(validateExportFile(exportFixture()), exportFixture());
    assert.deepEqual(parseExportJson(JSON.stringify(exportFixture())), exportFixture());

    const weakKdf = exportFixture();
    weakKdf.kdf.iterations = 599_999;
    assert.throws(() => validateExportFile(weakKdf), hasCode('VALIDATION_ERROR'));

    const excessiveKdf = exportFixture();
    excessiveKdf.kdf.iterations = 10_000_001;
    assert.throws(() => validateExportFile(excessiveKdf), hasCode('VALIDATION_ERROR'));

    const shortSalt = exportFixture();
    shortSalt.kdf.salt = 'AAAAAAAAAAAAAAAAAAAA';
    assert.throws(() => validateExportFile(shortSalt), hasCode('VALIDATION_ERROR'));

    const nonCanonicalSalt = exportFixture();
    nonCanonicalSalt.kdf.salt = 'AAAAAAAAAAAAAAAAAAAAAB==';
    assert.throws(() => validateExportFile(nonCanonicalSalt), hasCode('VALIDATION_ERROR'));

    const shortCiphertext = exportFixture();
    shortCiphertext.ciphertext = 'AAAAAAAAAAAAAAAAAAAA';
    assert.throws(() => validateExportFile(shortCiphertext), hasCode('VALIDATION_ERROR'));
  });
});
