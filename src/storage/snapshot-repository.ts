import { decryptSnapshot, encryptSnapshot } from '../core/crypto.ts';
import { TabBridgeError } from '../core/errors.ts';
import { validateSnapshot } from '../core/schema.ts';
import type { Snapshot, SnapshotSummary, VaultConfig } from '../core/types.ts';
import { RecordStore } from './record-store.ts';
import type { VaultManager } from './vault.ts';

export interface SnapshotListResult {
  snapshots: SnapshotSummary[];
  corrupt: Array<{ snapshotId: string; message: string }>;
}

export class SnapshotRepository {
  public constructor(
    public readonly records: RecordStore,
    private readonly vault: VaultManager,
  ) {}

  public async save(snapshot: Snapshot, configOverride?: VaultConfig): Promise<void> {
    const validated = validateSnapshot(snapshot);
    const config = configOverride ?? (await this.vault.config());
    if (!config) throw new TabBridgeError('NOT_CONFIGURED', 'Set a passphrase before saving.');
    const epoch = await this.vault.lockEpoch();
    const key = await this.vault.key(config.vaultId);
    const encrypted = await encryptSnapshot(validated, key, config.vaultId);
    await this.vault.assertEpoch(epoch, config.vaultId);
    await this.records.commit(encrypted);
  }

  public async get(snapshotId: string): Promise<Snapshot> {
    const encrypted = await this.records.read(snapshotId);
    const key = await this.vault.key(encrypted.vaultId);
    return decryptSnapshot(encrypted, key);
  }

  public async list(syncedIds = new Set<string>()): Promise<SnapshotListResult> {
    const manifests = await this.records.listManifests();
    const snapshots: SnapshotSummary[] = [];
    const corrupt: SnapshotListResult['corrupt'] = await this.records.corruptRecords();
    for (const manifest of manifests) {
      try {
        const snapshot = await this.get(manifest.snapshotId);
        snapshots.push({
          snapshotId: snapshot.snapshotId,
          generationId: snapshot.generationId,
          name: snapshot.name,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
          sourceDevice: snapshot.sourceDevice,
          windowCount: snapshot.windows.length,
          tabCount: snapshot.windows.reduce((total, window) => total + window.tabs.length, 0),
          groupCount: snapshot.windows.reduce((total, window) => total + window.groups.length, 0),
          location: syncedIds.has(snapshot.snapshotId) ? 'synced' : 'local',
          locked: false,
        });
      } catch (error) {
        if (error instanceof TabBridgeError && error.code === 'LOCKED') throw error;
        corrupt.push({
          snapshotId: manifest.snapshotId,
          message: error instanceof Error ? error.message : 'Stored data is corrupt.',
        });
      }
    }
    snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { snapshots, corrupt };
  }

  public async remove(snapshotId: string): Promise<void> {
    await this.records.remove(snapshotId);
  }
}
