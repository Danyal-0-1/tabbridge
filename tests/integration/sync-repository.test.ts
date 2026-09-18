import assert from 'node:assert/strict';
import test from 'node:test';

import { TabBridgeError, type ErrorCode } from '../../src/core/errors.ts';
import { RecordStore, recordKeys, SYNC_QUOTA_BYTES } from '../../src/storage/record-store.ts';
import { SyncRepository, SYNC_VAULT_KEY } from '../../src/storage/sync-repository.ts';
import { estimateStorageBytes } from '../../src/storage/storage-area.ts';
import { VAULT_CONFIG_KEY } from '../../src/storage/vault.ts';
import { InMemoryStorageArea } from './helpers/in-memory-storage.ts';
import {
  encryptedSnapshot,
  GENERATION_ONE,
  OTHER_SNAPSHOT_ID,
  SNAPSHOT_ID,
  VAULT_ID,
  vaultConfig,
} from './helpers/storage-fixtures.ts';

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof TabBridgeError && error.code === code;
}

function repository(area: InMemoryStorageArea): SyncRepository {
  return new SyncRepository(area, new RecordStore(area, 'tb:sync'));
}

test('SyncRepository uploads, reports quota, and mirrors an encrypted record locally', async () => {
  const encrypted = encryptedSnapshot('A'.repeat(7_004));
  const localArea = new InMemoryStorageArea();
  const localRecords = new RecordStore(localArea, 'tb:local');
  await localRecords.commit(encrypted);
  const syncArea = new InMemoryStorageArea();
  const sync = repository(syncArea);

  await sync.upload(localRecords, SNAPSHOT_ID);

  assert.deepEqual(await sync.records.read(SNAPSHOT_ID), encrypted);
  assert.deepEqual(await sync.syncedIds(), new Set([SNAPSHOT_ID]));
  const quota = await sync.quota();
  assert.equal(quota.usedBytes, estimateStorageBytes(syncArea.snapshot()));
  assert.equal(quota.quotaBytes, SYNC_QUOTA_BYTES);
  assert.equal(quota.remainingBytes, SYNC_QUOTA_BYTES - quota.usedBytes);
  assert.equal(quota.itemCount, 3);

  const receivingArea = new InMemoryStorageArea();
  const receivingRecords = new RecordStore(receivingArea, 'tb:local');
  await sync.mirrorTo(receivingRecords, SNAPSHOT_ID, VAULT_ID);
  assert.deepEqual(await receivingRecords.read(SNAPSHOT_ID), encrypted);

  const wrongVaultTarget = new InMemoryStorageArea();
  await assert.rejects(
    sync.mirrorTo(
      new RecordStore(wrongVaultTarget, 'tb:local'),
      SNAPSHOT_ID,
      '99999999-9999-4999-8999-999999999999',
    ),
    hasCode('SYNC_UNAVAILABLE'),
  );
  assert.deepEqual(wrongVaultTarget.snapshot(), {});
});

test('a sync quota rejection leaves the oversized snapshot intact locally', async () => {
  const encrypted = encryptedSnapshot('A'.repeat(105_000));
  const localArea = new InMemoryStorageArea();
  const localRecords = new RecordStore(localArea, 'tb:local');
  await localRecords.commit(encrypted);
  const syncArea = new InMemoryStorageArea();
  const sync = repository(syncArea);

  await assert.rejects(sync.upload(localRecords, SNAPSHOT_ID), hasCode('QUOTA_FULL'));

  assert.deepEqual(await localRecords.read(SNAPSHOT_ID), encrypted);
  assert.deepEqual(syncArea.snapshot(), {});
  assert.equal(
    syncArea.operations.some((operation) => operation.method === 'set'),
    false,
  );
});

test('a tombstone defeats stale sync data that reappears after deletion', async () => {
  const encrypted = encryptedSnapshot('AAAA');
  const localArea = new InMemoryStorageArea();
  const localRecords = new RecordStore(localArea, 'tb:local');
  await localRecords.commit(encrypted);
  const syncArea = new InMemoryStorageArea();
  const sync = repository(syncArea);
  await sync.upload(localRecords, SNAPSHOT_ID);
  const staleGeneration = syncArea.snapshot();

  await sync.remove(SNAPSHOT_ID);
  syncArea.seed(staleGeneration);

  assert.equal(await sync.records.isTombstoned(SNAPSHOT_ID), true);
  await assert.rejects(sync.records.read(SNAPSHOT_ID), hasCode('NOT_FOUND'));
  assert.deepEqual(await sync.syncedIds(), new Set());
  assert.ok(syncArea.snapshot()[recordKeys.manifest('tb:sync', SNAPSHOT_ID)]);
  assert.ok(syncArea.snapshot()[recordKeys.tombstone('tb:sync', SNAPSHOT_ID)]);
});

test('SyncRepository serial queue recovers after an upload failure', async () => {
  const localArea = new InMemoryStorageArea();
  const localRecords = new RecordStore(localArea, 'tb:local');
  await localRecords.commit(encryptedSnapshot('AAAA'));
  await localRecords.commit(
    encryptedSnapshot('BBBB', {
      snapshotId: OTHER_SNAPSHOT_ID,
      generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  );

  let rejectFirst = true;
  const syncArea = new InMemoryStorageArea(
    {},
    {
      beforeSet(items) {
        if (
          rejectFirst &&
          Object.keys(items).some((key) =>
            key.startsWith(`tb:sync:chunk:${SNAPSHOT_ID}:${GENERATION_ONE}:`),
          )
        ) {
          rejectFirst = false;
          throw new Error('first upload failed');
        }
      },
    },
  );
  const sync = repository(syncArea);

  const first = sync.upload(localRecords, SNAPSHOT_ID);
  const second = sync.upload(localRecords, OTHER_SNAPSHOT_ID);
  await assert.rejects(first, /first upload failed/);
  await second;

  assert.deepEqual(await sync.syncedIds(), new Set([OTHER_SNAPSHOT_ID]));
  assert.deepEqual(
    await sync.records.read(OTHER_SNAPSHOT_ID),
    encryptedSnapshot('BBBB', {
      snapshotId: OTHER_SNAPSHOT_ID,
      generationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  );
});

test('vault publishing rejects a conflicting browser-sync vault', async () => {
  const area = new InMemoryStorageArea();
  const sync = repository(area);
  const original = vaultConfig();
  await sync.publishVault(original);
  await sync.publishVault(original);

  const conflict = vaultConfig('55555555-5555-4555-8555-555555555555');
  await assert.rejects(sync.publishVault(conflict), hasCode('SYNC_UNAVAILABLE'));

  assert.deepEqual(await sync.remoteVault(), original);
  assert.deepEqual(area.snapshot()[SYNC_VAULT_KEY], original);
});

test('remote vault import initializes an empty local store without replacing local config', async () => {
  const remote = vaultConfig();
  const syncArea = new InMemoryStorageArea({ [SYNC_VAULT_KEY]: remote });
  const sync = repository(syncArea);
  const localArea = new InMemoryStorageArea();

  assert.deepEqual(await sync.importRemoteVaultToLocal(localArea), remote);
  assert.deepEqual(localArea.snapshot()[VAULT_CONFIG_KEY], remote);

  const local = vaultConfig('66666666-6666-4666-8666-666666666666');
  localArea.seed({ [VAULT_CONFIG_KEY]: local });
  localArea.clearOperations();
  assert.deepEqual(await sync.importRemoteVaultToLocal(localArea), remote);
  assert.deepEqual(localArea.snapshot()[VAULT_CONFIG_KEY], local);
  assert.equal(
    localArea.operations.some((operation) => operation.method === 'set'),
    false,
  );
});
