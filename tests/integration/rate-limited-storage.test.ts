import assert from 'node:assert/strict';
import test from 'node:test';

import { RateLimitedStorageArea } from '../../src/storage/rate-limited-storage.ts';
import type { StorageArea } from '../../src/storage/storage-area.ts';
import { InMemoryStorageArea } from './helpers/in-memory-storage.ts';

const RATE_STATE_KEY = 'tb:sync-write-scheduler';

test('RateLimitedStorageArea serializes writes with a persisted interval', async () => {
  const target = new InMemoryStorageArea({ removable: true });
  const state = new InMemoryStorageArea();
  const interval = 20;
  const limited = new RateLimitedStorageArea(target, state, interval);

  await Promise.all([
    limited.set({ first: 1 }),
    limited.remove('removable'),
    limited.set({ last: 3 }),
  ]);

  const writes = target.operations.filter(
    (operation) => operation.method === 'set' || operation.method === 'remove',
  );
  assert.deepEqual(
    writes.map((operation) => operation.method),
    ['set', 'remove', 'set'],
  );
  assert.ok(writes[1]!.at - writes[0]!.at >= interval - 2);
  assert.ok(writes[2]!.at - writes[1]!.at >= interval - 2);
  assert.deepEqual(target.snapshot(), { first: 1, last: 3 });

  const persisted = state.snapshot()[RATE_STATE_KEY];
  assert.equal(typeof persisted, 'object');
  assert.equal(typeof (persisted as { lastWriteAt?: unknown }).lastWriteAt, 'number');
});

test('a new rate limiter honors the timestamp persisted by an earlier instance', async () => {
  const target = new InMemoryStorageArea();
  const state = new InMemoryStorageArea();
  const interval = 25;
  await new RateLimitedStorageArea(target, state, interval).set({ first: true });

  const startedAt = Date.now();
  await new RateLimitedStorageArea(target, state, interval).set({ second: true });

  assert.ok(Date.now() - startedAt >= interval - 2);
  assert.deepEqual(target.snapshot(), { first: true, second: true });
});

test('a rejected write does not update rate state or poison later queued writes', async () => {
  let rejectFirst = true;
  const target = new InMemoryStorageArea(
    {},
    {
      beforeSet(items) {
        if (!rejectFirst || !Object.hasOwn(items, 'fails')) return;
        rejectFirst = false;
        throw new Error('simulated quota rejection');
      },
    },
  );
  const state = new InMemoryStorageArea();
  const limited = new RateLimitedStorageArea(target, state, 0);

  const failed = limited.set({ fails: true });
  const succeeded = limited.set({ succeeds: true });

  await assert.rejects(failed, /quota rejection/);
  await succeeded;
  assert.deepEqual(target.snapshot(), { succeeds: true });
  const stateWrites = state.operations.filter((operation) => operation.method === 'set');
  assert.equal(stateWrites.length, 1);
});

test('reads and capability methods delegate without entering the write queue', async () => {
  const target = new InMemoryStorageArea({ unicode: '日本語' });
  const state = new InMemoryStorageArea({
    [RATE_STATE_KEY]: { lastWriteAt: Date.now() + 10_000 },
  });
  const limited = new RateLimitedStorageArea(target, state, 20);

  assert.deepEqual(await limited.get('unicode'), { unicode: '日本語' });
  assert.equal(await limited.getBytesInUse('unicode'), await target.getBytesInUse('unicode'));
  await limited.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

  assert.deepEqual(target.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.equal(
    state.operations.some((operation) => operation.method === 'set'),
    false,
  );
});

test('getBytesInUse has a UTF-8 fallback when the target lacks that API', async () => {
  const values = { unicode: 'é🚀' };
  const target: StorageArea = {
    async get() {
      return values;
    },
    async set() {},
    async remove() {},
  };
  const limited = new RateLimitedStorageArea(target, new InMemoryStorageArea(), 0);

  assert.equal(
    await limited.getBytesInUse(null),
    new TextEncoder().encode(JSON.stringify(values)).byteLength,
  );
});
