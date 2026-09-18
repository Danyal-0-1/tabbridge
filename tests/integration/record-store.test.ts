import assert from 'node:assert/strict';
import test from 'node:test';

import { TabBridgeError, type ErrorCode } from '../../src/core/errors.ts';
import {
  RecordStore,
  recordKeys,
  SYNC_MAX_ITEMS,
  SYNC_QUOTA_BYTES,
} from '../../src/storage/record-store.ts';
import { InMemoryStorageArea } from './helpers/in-memory-storage.ts';
import {
  encryptedSnapshot,
  GENERATION_ONE,
  GENERATION_TWO,
  SNAPSHOT_ID,
  tombstone,
} from './helpers/storage-fixtures.ts';

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof TabBridgeError && error.code === code;
}

function keysFrom(items: Record<string, unknown> | undefined): string[] {
  return Object.keys(items ?? {});
}

test('RecordStore writes exact-boundary chunks before publishing one manifest', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:local');
  const encrypted = encryptedSnapshot('A'.repeat(7_004));

  const manifest = await records.commit(encrypted);

  assert.equal(manifest.chunkCount, 2);
  assert.equal(manifest.ciphertextLength, 7_004);
  const sets = area.operations.filter((operation) => operation.method === 'set');
  assert.equal(sets.length, 2);
  assert.deepEqual(keysFrom(sets[0]?.items), [
    recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 0),
    recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 1),
  ]);
  assert.deepEqual(keysFrom(sets[1]?.items), [recordKeys.manifest('tb:local', SNAPSHOT_ID)]);
  assert.equal(
    area.snapshot()[recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 0)],
    'A'.repeat(7_000),
  );
  assert.equal(
    area.snapshot()[recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 1)],
    'AAAA',
  );
  assert.deepEqual(await records.read(SNAPSHOT_ID), encrypted);
});

test('RecordStore quota checks count UTF-8 bytes and happen before any mutation', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:sync');
  const multibyte = encryptedSnapshot('é'.repeat(7_000));

  await assert.rejects(
    records.commit(multibyte, { enforceSyncQuota: true }),
    hasCode('QUOTA_FULL'),
  );

  assert.deepEqual(area.snapshot(), {});
  assert.equal(
    area.operations.some(
      (operation) => operation.method === 'set' || operation.method === 'remove',
    ),
    false,
  );
});

test('RecordStore preflights total-byte and item-count sync quotas', async (context) => {
  await context.test('total bytes', async () => {
    const area = new InMemoryStorageArea({ occupied: 'x'.repeat(SYNC_QUOTA_BYTES) });
    const records = new RecordStore(area, 'tb:sync');

    await assert.rejects(
      records.commit(encryptedSnapshot('AAAA'), { enforceSyncQuota: true }),
      hasCode('QUOTA_FULL'),
    );
    assert.equal(
      area.operations.some((operation) => operation.method === 'set'),
      false,
    );
  });

  await context.test('item count', async () => {
    const existing = Object.fromEntries(
      Array.from({ length: SYNC_MAX_ITEMS - 1 }, (_, index) => [`existing:${index}`, index]),
    );
    const area = new InMemoryStorageArea(existing);
    const records = new RecordStore(area, 'tb:sync');

    await assert.rejects(
      records.commit(encryptedSnapshot('AAAA'), { enforceSyncQuota: true }),
      hasCode('QUOTA_FULL'),
    );
    assert.equal(
      area.operations.some((operation) => operation.method === 'set'),
      false,
    );
  });

  await context.test('chunk count', async () => {
    const area = new InMemoryStorageArea();
    const records = new RecordStore(area, 'tb:sync');
    const tooManyChunks = encryptedSnapshot('A'.repeat(7_000 * SYNC_MAX_ITEMS + 1));

    await assert.rejects(
      records.commit(tooManyChunks, { enforceSyncQuota: true }),
      hasCode('QUOTA_FULL'),
    );
    assert.equal(area.operations.length, 0);
  });
});

test('an interrupted chunk write removes only the incomplete generation', async () => {
  let interrupted = false;
  const area = new InMemoryStorageArea(
    {},
    {
      beforeSet(items, storage) {
        const chunks = Object.entries(items).filter(([key]) => key.startsWith('tb:local:chunk:'));
        if (interrupted || chunks.length === 0) return;
        interrupted = true;
        const first = chunks[0];
        assert.ok(first);
        storage.seed({ [first[0]]: first[1] });
        throw new Error('simulated storage interruption');
      },
    },
  );
  const records = new RecordStore(area, 'tb:local');

  await assert.rejects(records.commit(encryptedSnapshot('A'.repeat(7_004))), /interruption/);

  assert.deepEqual(area.snapshot(), {});
  assert.deepEqual(
    area.operations.map((operation) => operation.method),
    ['get', 'set', 'remove'],
  );
});

test('a failed replacement chunk verification preserves the committed generation', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:local');
  const original = encryptedSnapshot('A'.repeat(7_004));
  await records.commit(original);
  area.clearOperations();

  let corrupted = false;
  area.hooks.afterSet = (items, storage) => {
    const key = Object.keys(items).find((item) =>
      item.includes(`:chunk:${SNAPSHOT_ID}:${GENERATION_TWO}:`),
    );
    if (!key || corrupted) return;
    corrupted = true;
    storage.seed({ [key]: 'storage returned a different value' });
  };

  await assert.rejects(
    records.commit(
      encryptedSnapshot('B'.repeat(7_004), {
        generationId: GENERATION_TWO,
      }),
    ),
    hasCode('CORRUPT_DATA'),
  );

  area.hooks = {};
  assert.deepEqual(await records.read(SNAPSHOT_ID), original);
  const values = area.snapshot();
  assert.equal(
    Object.keys(values).some((key) => key.includes(`:chunk:${SNAPSHOT_ID}:${GENERATION_TWO}:`)),
    false,
  );
  assert.equal(
    (values[recordKeys.manifest('tb:local', SNAPSHOT_ID)] as { generationId: string }).generationId,
    GENERATION_ONE,
  );
});

test('a manifest read-back failure rolls a replacement back to its prior manifest', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:local');
  const original = encryptedSnapshot('AAAA');
  await records.commit(original);

  let corrupted = false;
  area.hooks.afterSet = (items, storage) => {
    const key = recordKeys.manifest('tb:local', SNAPSHOT_ID);
    const value = items[key];
    if (
      corrupted ||
      typeof value !== 'object' ||
      value === null ||
      (value as { generationId?: unknown }).generationId !== GENERATION_TWO
    ) {
      return;
    }
    corrupted = true;
    storage.seed({
      [key]: { ...value, digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    });
  };

  await assert.rejects(
    records.commit(encryptedSnapshot('BBBB', { generationId: GENERATION_TWO })),
    hasCode('CORRUPT_DATA'),
  );

  area.hooks = {};
  assert.deepEqual(await records.read(SNAPSHOT_ID), original);
  assert.equal(
    Object.keys(area.snapshot()).some((key) =>
      key.includes(`:chunk:${SNAPSHOT_ID}:${GENERATION_TWO}:`),
    ),
    false,
  );
});

test('RecordStore rejects missing chunks, invalid chunk values, and wrong lengths', async (context) => {
  const build = async (): Promise<{
    area: InMemoryStorageArea;
    records: RecordStore;
    chunk: string;
  }> => {
    const area = new InMemoryStorageArea();
    const records = new RecordStore(area, 'tb:local');
    await records.commit(encryptedSnapshot('A'.repeat(7_004)));
    return {
      area,
      records,
      chunk: recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 1),
    };
  };

  await context.test('missing chunk', async () => {
    const { area, records, chunk } = await build();
    area.deleteDirect(chunk);
    await assert.rejects(records.read(SNAPSHOT_ID), hasCode('CORRUPT_DATA'));
  });

  await context.test('non-string chunk', async () => {
    const { area, records, chunk } = await build();
    area.seed({ [chunk]: 1 });
    await assert.rejects(records.read(SNAPSHOT_ID), hasCode('CORRUPT_DATA'));
  });

  await context.test('wrong assembled length', async () => {
    const { area, records, chunk } = await build();
    area.seed({ [chunk]: 'AA' });
    await assert.rejects(records.read(SNAPSHOT_ID), hasCode('CORRUPT_DATA'));
  });

  await context.test('same-length tampering', async () => {
    const { area, records, chunk } = await build();
    area.seed({ [chunk]: 'AAAB' });
    await assert.rejects(records.read(SNAPSHOT_ID), hasCode('CORRUPT_DATA'));
  });
});

test('RecordStore distinguishes missing and corrupt manifests', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:local');

  await assert.rejects(records.read(SNAPSHOT_ID), hasCode('NOT_FOUND'));

  area.seed({ [recordKeys.manifest('tb:local', SNAPSHOT_ID)]: { kind: 'wrong' } });
  await assert.rejects(records.read(SNAPSHOT_ID), hasCode('VALIDATION_ERROR'));
});

test('orphan cleanup removes stale generations only in its own namespace', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:local');
  await records.commit(encryptedSnapshot('A'.repeat(7_004)));
  await records.commit(encryptedSnapshot('BBBB', { generationId: GENERATION_TWO }));
  const staleChunkZero = recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 0);
  const staleChunkOne = recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_ONE, 1);
  assert.equal(area.snapshot()[staleChunkZero], undefined);
  assert.equal(area.snapshot()[staleChunkOne], undefined);

  const explicitOrphan = recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_TWO, 99);
  const otherNamespace = recordKeys.chunk('tb:sync', SNAPSHOT_ID, GENERATION_ONE, 99);
  area.seed({
    [staleChunkZero]: 'A'.repeat(7_000),
    [staleChunkOne]: 'AAAA',
    [explicitOrphan]: 'orphan',
    [otherNamespace]: 'other-area',
    unrelated: true,
  });

  assert.equal(await records.cleanupOrphans(), 3);

  const values = area.snapshot();
  assert.equal(values[staleChunkZero], undefined);
  assert.equal(values[staleChunkOne], undefined);
  assert.equal(values[explicitOrphan], undefined);
  assert.equal(values[recordKeys.chunk('tb:local', SNAPSHOT_ID, GENERATION_TWO, 0)], 'BBBB');
  assert.equal(values[otherNamespace], 'other-area');
  assert.equal(values.unrelated, true);
});

test('a valid tombstone wins over surviving data and blocks identity reuse', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:sync');
  const encrypted = encryptedSnapshot('AAAA');
  await records.commit(encrypted);
  area.seed({ [recordKeys.tombstone('tb:sync', SNAPSHOT_ID)]: tombstone() });

  await assert.rejects(records.read(SNAPSHOT_ID), hasCode('NOT_FOUND'));
  assert.equal(await records.has(SNAPSHOT_ID), false);
  assert.deepEqual(await records.listManifests(), []);
  assert.deepEqual(await records.read(SNAPSHOT_ID, { ignoreTombstone: true }), encrypted);
  await assert.rejects(
    records.commit(encryptedSnapshot('BBBB', { generationId: GENERATION_TWO })),
    hasCode('VALIDATION_ERROR'),
  );
});

test('an interrupted tombstoned deletion still prevents stale manifest resurrection', async () => {
  const area = new InMemoryStorageArea();
  const records = new RecordStore(area, 'tb:sync');
  await records.commit(encryptedSnapshot('AAAA'));
  area.hooks.beforeRemove = () => {
    throw new Error('simulated remove failure');
  };

  await assert.rejects(records.remove(SNAPSHOT_ID, true), /remove failure/);

  area.hooks = {};
  assert.equal(await records.isTombstoned(SNAPSHOT_ID), true);
  await assert.rejects(records.read(SNAPSHOT_ID), hasCode('NOT_FOUND'));
  assert.deepEqual(
    await records.read(SNAPSHOT_ID, { ignoreTombstone: true }),
    encryptedSnapshot('AAAA'),
  );
});
