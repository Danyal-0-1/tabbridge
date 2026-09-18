import assert from 'node:assert/strict';
import test from 'node:test';

import { joinChunks, MAX_CHUNK_CHARACTERS, splitIntoChunks } from '../../src/core/chunking.ts';
import { TabBridgeError } from '../../src/core/errors.ts';
import { estimateStorageBytes } from '../../src/storage/storage-area.ts';

test('chunking honors empty, exact, and just-over boundary lengths', () => {
  const cases = [
    { length: 0, expectedLengths: [0] },
    { length: MAX_CHUNK_CHARACTERS - 1, expectedLengths: [6_999] },
    { length: MAX_CHUNK_CHARACTERS, expectedLengths: [7_000] },
    { length: MAX_CHUNK_CHARACTERS + 1, expectedLengths: [7_000, 1] },
    { length: MAX_CHUNK_CHARACTERS * 2, expectedLengths: [7_000, 7_000] },
    { length: MAX_CHUNK_CHARACTERS * 2 + 1, expectedLengths: [7_000, 7_000, 1] },
  ];

  for (const { length, expectedLengths } of cases) {
    const value = 'a'.repeat(length);
    const chunks = splitIntoChunks(value);
    assert.deepEqual(
      chunks.map((chunk) => chunk.length),
      expectedLengths,
      `unexpected chunks for ${length} characters`,
    );
    assert.equal(joinChunks(chunks, length), value);
  }
});

test('chunking reassembles multibyte text without confusing UTF-8 bytes and JS characters', () => {
  const value = `${'é'.repeat(MAX_CHUNK_CHARACTERS)}🚀`;
  const chunks = splitIntoChunks(value);

  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [7_000, 2],
  );
  assert.equal(joinChunks(chunks, value.length), value);
  assert.ok(new TextEncoder().encode(chunks[0]).byteLength > chunks[0]!.length);
});

test('chunking rejects invalid maxima and malformed assemblies', () => {
  for (const maximum of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => splitIntoChunks('payload', maximum),
      (error) => error instanceof TabBridgeError && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.throws(
    () => joinChunks(['abc', 'def'], 5),
    (error) => error instanceof TabBridgeError && error.code === 'CORRUPT_DATA',
  );
  assert.throws(
    () => joinChunks(['abc', 42 as unknown as string], 5),
    (error) => error instanceof TabBridgeError && error.code === 'CORRUPT_DATA',
  );
});

test('storage estimates key and JSON value bytes in UTF-8', () => {
  const ascii = estimateStorageBytes({ key: 'aaaa' });
  const multibyte = estimateStorageBytes({ key: 'éééé' });
  const emojiKey = estimateStorageBytes({ '🚀': true });

  assert.equal(ascii, 3 + 6);
  assert.equal(multibyte, 3 + 10);
  assert.equal(emojiKey, 4 + 4);
  assert.ok(multibyte > ascii);
});
