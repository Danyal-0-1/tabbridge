import { joinChunks, MAX_CHUNK_CHARACTERS, splitIntoChunks } from '../core/chunking.ts';
import { asArrayBuffer, base64ToBytes, timingSafeEqual } from '../core/encoding.ts';
import { TabBridgeError } from '../core/errors.ts';
import { validateRecordManifest, validateTombstone } from '../core/schema.ts';
import { type EncryptedSnapshot, type RecordManifest, type Tombstone } from '../core/types.ts';
import { estimateStorageBytes, type StorageArea } from './storage-area.ts';

export const SYNC_QUOTA_BYTES = 102_400;
export const SYNC_QUOTA_BYTES_PER_ITEM = 8_192;
export const SYNC_MAX_ITEMS = 512;

export type RecordNamespace = 'tb:local' | 'tb:sync';

export interface CommitOptions {
  enforceSyncQuota?: boolean;
}

export interface PreparedRecord {
  manifest: RecordManifest;
  chunkKeys: string[];
  previousManifest?: RecordManifest;
}

function manifestKey(namespace: RecordNamespace, snapshotId: string): string {
  return `${namespace}:manifest:${snapshotId}`;
}

function tombstoneKey(namespace: RecordNamespace, snapshotId: string): string {
  return `${namespace}:tombstone:${snapshotId}`;
}

function chunkKey(
  namespace: RecordNamespace,
  snapshotId: string,
  generationId: string,
  index: number,
): string {
  return `${namespace}:chunk:${snapshotId}:${generationId}:${index.toString().padStart(3, '0')}`;
}

function chunkKeys(namespace: RecordNamespace, manifest: RecordManifest): string[] {
  return Array.from({ length: manifest.chunkCount }, (_, index) =>
    chunkKey(namespace, manifest.snapshotId, manifest.generationId, index),
  );
}

function parseManifestSafely(value: unknown): RecordManifest | undefined {
  try {
    return validateRecordManifest(value);
  } catch {
    return undefined;
  }
}

export class RecordStore {
  public constructor(
    private readonly area: StorageArea,
    private readonly namespace: RecordNamespace,
  ) {}

  public async commit(
    encrypted: EncryptedSnapshot,
    options: CommitOptions = {},
  ): Promise<RecordManifest> {
    const prepared = await this.prepare(encrypted, options);
    try {
      await this.publish([prepared.manifest]);
      const verified = await this.read(encrypted.snapshotId, { ignoreTombstone: true });
      if (
        verified.ciphertext !== encrypted.ciphertext ||
        verified.digest !== encrypted.digest ||
        verified.generationId !== encrypted.generationId
      ) {
        throw new TabBridgeError('CORRUPT_DATA', 'The committed snapshot failed verification.');
      }
      if (prepared.previousManifest) {
        await this.area
          .remove(chunkKeys(this.namespace, prepared.previousManifest))
          .catch(() => undefined);
      }
      return prepared.manifest;
    } catch (error) {
      if (prepared.previousManifest) {
        await this.publish([prepared.previousManifest]).catch(() => undefined);
      } else {
        await this.area
          .remove(manifestKey(this.namespace, prepared.manifest.snapshotId))
          .catch(() => undefined);
      }
      await this.area.remove(prepared.chunkKeys).catch(() => undefined);
      throw error;
    }
  }

  public async prepare(
    encrypted: EncryptedSnapshot,
    options: CommitOptions = {},
  ): Promise<PreparedRecord> {
    const chunks = splitIntoChunks(encrypted.ciphertext, MAX_CHUNK_CHARACTERS);
    if (chunks.length > SYNC_MAX_ITEMS) {
      throw new TabBridgeError('QUOTA_FULL', 'The encrypted snapshot requires too many chunks.');
    }

    const existingKeys = [
      manifestKey(this.namespace, encrypted.snapshotId),
      tombstoneKey(this.namespace, encrypted.snapshotId),
    ];
    const oldValue = await this.area.get(existingKeys);
    if (oldValue[tombstoneKey(this.namespace, encrypted.snapshotId)] !== undefined) {
      validateTombstone(oldValue[tombstoneKey(this.namespace, encrypted.snapshotId)]);
      throw new TabBridgeError(
        'VALIDATION_ERROR',
        'This snapshot identity was deleted and cannot be reused. Save it as a new copy instead.',
      );
    }
    const oldManifest = parseManifestSafely(
      oldValue[manifestKey(this.namespace, encrypted.snapshotId)],
    );
    const chunkItems: Record<string, unknown> = {};
    for (const [index, chunk] of chunks.entries()) {
      chunkItems[chunkKey(this.namespace, encrypted.snapshotId, encrypted.generationId, index)] =
        chunk;
    }

    const manifest: RecordManifest = {
      kind: 'tabbridge-record-manifest',
      formatVersion: 1,
      snapshotId: encrypted.snapshotId,
      generationId: encrypted.generationId,
      vaultId: encrypted.vaultId,
      schemaVersion: encrypted.schemaVersion,
      encryptionVersion: encrypted.encryptionVersion,
      compression: encrypted.compression,
      cipher: encrypted.cipher,
      chunkCount: chunks.length,
      ciphertextLength: encrypted.ciphertext.length,
      digest: encrypted.digest,
      committedAt: new Date().toISOString(),
    };

    const manifestItem = { [manifestKey(this.namespace, encrypted.snapshotId)]: manifest };
    if (options.enforceSyncQuota) {
      await this.assertFitsSyncQuota(chunkItems, manifestItem);
    }

    const newChunkKeys = Object.keys(chunkItems);
    try {
      await this.area.set(chunkItems);
      const readBack = await this.area.get(newChunkKeys);
      for (const key of newChunkKeys) {
        if (readBack[key] !== chunkItems[key]) {
          throw new TabBridgeError('CORRUPT_DATA', 'A snapshot chunk failed write verification.');
        }
      }
    } catch (error) {
      await this.area.remove(newChunkKeys).catch(() => undefined);
      throw error;
    }
    return {
      manifest,
      chunkKeys: newChunkKeys,
      ...(oldManifest ? { previousManifest: oldManifest } : {}),
    };
  }

  public async publish(
    manifests: RecordManifest[],
    additionalItems: Record<string, unknown> = {},
  ): Promise<void> {
    const items = { ...additionalItems };
    for (const manifest of manifests) {
      items[manifestKey(this.namespace, manifest.snapshotId)] = manifest;
    }
    await this.area.set(items);
    const keys = manifests.map((manifest) => manifestKey(this.namespace, manifest.snapshotId));
    const verified = await this.area.get(keys);
    for (const manifest of manifests) {
      const value = verified[manifestKey(this.namespace, manifest.snapshotId)];
      const parsed = validateRecordManifest(value);
      if (parsed.generationId !== manifest.generationId || parsed.digest !== manifest.digest) {
        throw new TabBridgeError('CORRUPT_DATA', 'A committed manifest failed verification.');
      }
    }
  }

  public async discardPrepared(records: PreparedRecord[]): Promise<void> {
    const keys = records.flatMap((record) => record.chunkKeys);
    if (keys.length > 0) await this.area.remove(keys);
  }

  public async discardPrevious(records: PreparedRecord[]): Promise<void> {
    const keys = records.flatMap((record) =>
      record.previousManifest ? chunkKeys(this.namespace, record.previousManifest) : [],
    );
    if (keys.length > 0) await this.area.remove(keys);
  }

  public async read(
    snapshotId: string,
    options: { ignoreTombstone?: boolean } = {},
  ): Promise<EncryptedSnapshot> {
    const keys = [
      manifestKey(this.namespace, snapshotId),
      tombstoneKey(this.namespace, snapshotId),
    ];
    const stored = await this.area.get(keys);
    if (
      !options.ignoreTombstone &&
      stored[tombstoneKey(this.namespace, snapshotId)] !== undefined
    ) {
      validateTombstone(stored[tombstoneKey(this.namespace, snapshotId)]);
      throw new TabBridgeError('NOT_FOUND', 'This snapshot was deleted.');
    }
    const manifestValue = stored[manifestKey(this.namespace, snapshotId)];
    if (manifestValue === undefined) throw new TabBridgeError('NOT_FOUND', 'Snapshot not found.');
    const manifest = validateRecordManifest(manifestValue);
    if (manifest.snapshotId !== snapshotId) {
      throw new TabBridgeError('CORRUPT_DATA', 'The stored manifest has the wrong snapshot ID.');
    }
    const keysForChunks = chunkKeys(this.namespace, manifest);
    const rawChunks = await this.area.get(keysForChunks);
    const chunks = keysForChunks.map((key) => {
      const value = rawChunks[key];
      if (typeof value !== 'string') {
        throw new TabBridgeError('CORRUPT_DATA', 'A stored snapshot chunk is missing.');
      }
      return value;
    });
    const ciphertext = joinChunks(chunks, manifest.ciphertextLength);
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', asArrayBuffer(base64ToBytes(ciphertext))),
    );
    if (!timingSafeEqual(digest, base64ToBytes(manifest.digest))) {
      throw new TabBridgeError(
        'CORRUPT_DATA',
        'Stored snapshot chunks failed their integrity check.',
      );
    }
    return {
      format: 'tabbridge-encrypted',
      encryptionVersion: manifest.encryptionVersion,
      schemaVersion: manifest.schemaVersion,
      snapshotId: manifest.snapshotId,
      generationId: manifest.generationId,
      vaultId: manifest.vaultId,
      compression: manifest.compression,
      cipher: manifest.cipher,
      ciphertext,
      digest: manifest.digest,
    };
  }

  public async listManifests(): Promise<RecordManifest[]> {
    const all = await this.area.get(null);
    const tombstoned = new Set<string>();
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(`${this.namespace}:tombstone:`)) continue;
      try {
        tombstoned.add(validateTombstone(value).snapshotId);
      } catch {
        // Fail closed: a corrupt deletion marker still quarantines the ID encoded in its key.
        tombstoned.add(key.slice(`${this.namespace}:tombstone:`.length));
      }
    }
    const manifests: RecordManifest[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(`${this.namespace}:manifest:`)) continue;
      try {
        const manifest = validateRecordManifest(value);
        if (!tombstoned.has(manifest.snapshotId)) manifests.push(manifest);
      } catch {
        // Reported separately so one corrupt record does not hide the valid archive.
      }
    }
    return manifests;
  }

  public async corruptRecords(): Promise<Array<{ snapshotId: string; message: string }>> {
    const all = await this.area.get(null);
    const corrupt: Array<{ snapshotId: string; message: string }> = [];
    for (const [key, value] of Object.entries(all)) {
      const manifestPrefix = `${this.namespace}:manifest:`;
      const tombstonePrefix = `${this.namespace}:tombstone:`;
      try {
        if (key.startsWith(manifestPrefix)) validateRecordManifest(value);
        else if (key.startsWith(tombstonePrefix)) validateTombstone(value);
        else continue;
      } catch (error) {
        const id = key.startsWith(manifestPrefix)
          ? key.slice(manifestPrefix.length)
          : key.slice(tombstonePrefix.length);
        corrupt.push({
          snapshotId: id.slice(0, 64) || '[unknown]',
          message: error instanceof Error ? error.message : 'Stored metadata is invalid.',
        });
      }
    }
    return corrupt;
  }

  public async has(snapshotId: string): Promise<boolean> {
    try {
      await this.read(snapshotId);
      return true;
    } catch (error) {
      if (error instanceof TabBridgeError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  public async isTombstoned(snapshotId: string): Promise<boolean> {
    const key = tombstoneKey(this.namespace, snapshotId);
    const stored = await this.area.get(key);
    if (stored[key] === undefined) return false;
    validateTombstone(stored[key]);
    return true;
  }

  public async remove(snapshotId: string, createTombstone = false): Promise<void> {
    const stored = await this.area.get(manifestKey(this.namespace, snapshotId));
    const manifest = parseManifestSafely(stored[manifestKey(this.namespace, snapshotId)]);
    if (createTombstone) {
      const tombstone: Tombstone = {
        kind: 'tabbridge-tombstone',
        snapshotId,
        deletedAt: new Date().toISOString(),
      };
      await this.area.set({ [tombstoneKey(this.namespace, snapshotId)]: tombstone });
    }
    await this.area.remove(manifestKey(this.namespace, snapshotId));
    if (manifest) await this.area.remove(chunkKeys(this.namespace, manifest));
  }

  public async cleanupOrphans(): Promise<number> {
    const all = await this.area.get(null);
    const referenced = new Set<string>();
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(`${this.namespace}:manifest:`)) continue;
      const manifest = parseManifestSafely(value);
      if (manifest) {
        for (const keyForChunk of chunkKeys(this.namespace, manifest)) referenced.add(keyForChunk);
      }
    }
    const orphans = Object.keys(all).filter(
      (key) => key.startsWith(`${this.namespace}:chunk:`) && !referenced.has(key),
    );
    if (orphans.length > 0) await this.area.remove(orphans);
    return orphans.length;
  }

  public async copyFrom(source: RecordStore, snapshotId: string, sync = false): Promise<void> {
    const encrypted = await source.read(snapshotId);
    await this.commit(encrypted, { enforceSyncQuota: sync });
  }

  private async assertFitsSyncQuota(
    chunks: Record<string, unknown>,
    manifest: Record<string, unknown>,
  ): Promise<void> {
    const allNew = { ...chunks, ...manifest };
    for (const [key, value] of Object.entries(allNew)) {
      if (estimateStorageBytes({ [key]: value }) > SYNC_QUOTA_BYTES_PER_ITEM) {
        throw new TabBridgeError('QUOTA_FULL', 'A synchronized storage item exceeds 8,192 bytes.');
      }
    }
    const existing = await this.area.get(null);
    const projected = { ...existing, ...allNew };
    if (Object.keys(projected).length > SYNC_MAX_ITEMS) {
      throw new TabBridgeError('QUOTA_FULL', 'Browser sync would exceed its 512-item limit.');
    }
    if (estimateStorageBytes(projected) > SYNC_QUOTA_BYTES) {
      throw new TabBridgeError(
        'QUOTA_FULL',
        'This snapshot is too large for browser sync. It remains local and can be exported instead.',
      );
    }
  }
}

export const recordKeys = {
  manifest: manifestKey,
  tombstone: tombstoneKey,
  chunk: chunkKey,
};
