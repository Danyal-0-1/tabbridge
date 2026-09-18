import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compress, decompress } from '../../src/core/compression.ts';
import { decodeUtf8, utf8 } from '../../src/core/encoding.ts';
import { TabBridgeError } from '../../src/core/errors.ts';
import { LIMITS } from '../../src/core/schema.ts';

describe('bounded gzip decompression', () => {
  it('round-trips multibyte UTF-8 data', async () => {
    const plaintext = '雪 🔐 مرحبا é'.repeat(2_000);
    const compressed = await compress(utf8(plaintext));

    assert.equal(decodeUtf8(await decompress(compressed)), plaintext);
    assert.ok(compressed.byteLength < utf8(plaintext).byteLength);
  });

  it(
    'stops a highly compressible payload once decompressed output crosses the safety bound',
    { timeout: 60_000 },
    async () => {
      const bomb = new Uint8Array(LIMITS.decompressedBytes + 1);
      const compressed = await compress(bomb);

      assert.ok(compressed.byteLength < 100_000);
      await assert.rejects(
        () => decompress(compressed),
        (error: unknown) => error instanceof TabBridgeError && error.code === 'CORRUPT_DATA',
      );
    },
  );

  it('fails closed for malformed gzip bytes', async () => {
    await assert.rejects(
      () => decompress(Uint8Array.of(0x1f, 0x8b, 0x08, 0xff, 0x00)),
      (error: unknown) => error instanceof TabBridgeError && error.code === 'CORRUPT_DATA',
    );
  });
});
