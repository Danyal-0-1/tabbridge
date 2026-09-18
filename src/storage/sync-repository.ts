import { TabBridgeError } from '../core/errors.ts';
import { validateVaultConfig } from '../core/schema.ts';
import type { SyncQuota, VaultConfig } from '../core/types.ts';
import { RecordStore, SYNC_MAX_ITEMS, SYNC_QUOTA_BYTES } from './record-store.ts';
import type { StorageArea } from './storage-area.ts';
import { VAULT_CONFIG_KEY } from './vault.ts';

export const SYNC_VAULT_KEY = 'tb:sync:vault';

export class SyncRepository {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly area: StorageArea,
    public readonly records: RecordStore,
  ) {}

  public async remoteVault(): Promise<VaultConfig | undefined> {
    const values = await this.area.get(SYNC_VAULT_KEY);
    const value = values[SYNC_VAULT_KEY];
    return value === undefined ? undefined : validateVaultConfig(value);
  }

  public async publishVault(config: VaultConfig): Promise<void> {
    const remote = await this.remoteVault();
    if (remote && remote.vaultId !== config.vaultId) {
      throw new TabBridgeError(
        'SYNC_UNAVAILABLE',
        'Browser sync already contains a different TabBridge vault. Export or clear it before joining.',
      );
    }
    await this.enqueue(async () => this.area.set({ [SYNC_VAULT_KEY]: config }));
  }

  public async upload(local: RecordStore, snapshotId: string): Promise<void> {
    await this.enqueue(async () => {
      const encrypted = await local.read(snapshotId);
      await this.records.commit(encrypted, { enforceSyncQuota: true });
    });
  }

  public async mirrorTo(
    local: RecordStore,
    snapshotId: string,
    expectedVaultId: string,
  ): Promise<void> {
    const encrypted = await this.records.read(snapshotId);
    if (encrypted.vaultId !== expectedVaultId) {
      throw new TabBridgeError(
        'SYNC_UNAVAILABLE',
        'A synchronized snapshot belongs to a different encryption vault.',
      );
    }
    await local.commit(encrypted);
  }

  public async remove(snapshotId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.records.remove(snapshotId, true);
    });
  }

  public async syncedIds(): Promise<Set<string>> {
    return new Set((await this.records.listManifests()).map((manifest) => manifest.snapshotId));
  }

  public async quota(): Promise<SyncQuota> {
    const all = await this.area.get(null);
    const usedBytes = this.area.getBytesInUse
      ? await this.area.getBytesInUse(null)
      : new TextEncoder().encode(JSON.stringify(all)).byteLength;
    return {
      usedBytes,
      quotaBytes: SYNC_QUOTA_BYTES,
      remainingBytes: Math.max(0, SYNC_QUOTA_BYTES - usedBytes),
      itemCount: Object.keys(all).length,
      maxItems: SYNC_MAX_ITEMS,
    };
  }

  public async importRemoteVaultToLocal(localArea: StorageArea): Promise<VaultConfig | undefined> {
    const remote = await this.remoteVault();
    if (!remote) return undefined;
    const localValue = await localArea.get(VAULT_CONFIG_KEY);
    if (localValue[VAULT_CONFIG_KEY] === undefined) {
      await localArea.set({ [VAULT_CONFIG_KEY]: remote });
    }
    return remote;
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.writeChain.then(operation, operation);
    this.writeChain = current.catch(() => undefined);
    return current;
  }
}
