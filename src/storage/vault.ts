import { createVault, exportRawKey, importRawKey, unlockVault } from '../core/crypto.ts';
import { TabBridgeError } from '../core/errors.ts';
import { validateVaultConfig } from '../core/schema.ts';
import type { VaultConfig } from '../core/types.ts';
import type { StorageArea } from './storage-area.ts';

export const VAULT_CONFIG_KEY = 'tb:vault:config';
const SESSION_KEYS_KEY = 'tb:session:vault-keys';
const LOCK_EPOCH_KEY = 'tb:vault:lock-epoch';

function keyMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') result[key] = child;
  }
  return result;
}

export class VaultManager {
  private readonly memoryKeys = new Map<string, CryptoKey>();

  public constructor(
    private readonly local: StorageArea,
    private readonly session?: StorageArea,
  ) {}

  public async config(): Promise<VaultConfig | undefined> {
    const values = await this.local.get(VAULT_CONFIG_KEY);
    const value = values[VAULT_CONFIG_KEY];
    return value === undefined ? undefined : validateVaultConfig(value);
  }

  public async setup(passphrase: string): Promise<VaultConfig> {
    if (await this.config()) {
      throw new TabBridgeError('VALIDATION_ERROR', 'Encryption is already configured.');
    }
    const { config, key } = await createVault(passphrase);
    await this.local.set({ [VAULT_CONFIG_KEY]: config });
    await this.remember(config.vaultId, key);
    return config;
  }

  public async unlock(passphrase: string, configOverride?: VaultConfig): Promise<VaultConfig> {
    const config = configOverride ?? (await this.config());
    if (!config) {
      throw new TabBridgeError('NOT_CONFIGURED', 'Set an encryption passphrase before saving.');
    }
    const key = await unlockVault(passphrase, config);
    await this.remember(config.vaultId, key);
    return config;
  }

  public async key(vaultId?: string): Promise<CryptoKey> {
    const config = await this.config();
    const id = vaultId ?? config?.vaultId;
    if (!id) throw new TabBridgeError('NOT_CONFIGURED', 'Encryption is not configured.');
    const inMemory = this.memoryKeys.get(id);
    if (inMemory) return inMemory;
    if (this.session) {
      const stored = await this.session.get(SESSION_KEYS_KEY);
      const encoded = keyMap(stored[SESSION_KEYS_KEY])[id];
      if (encoded) {
        const imported = await importRawKey(encoded);
        this.memoryKeys.set(id, imported);
        return imported;
      }
    }
    throw new TabBridgeError('LOCKED', 'TabBridge is locked. Enter your passphrase to continue.');
  }

  public async status(): Promise<{ configured: boolean; locked: boolean; vaultId?: string }> {
    const config = await this.config();
    if (!config) return { configured: false, locked: true };
    try {
      await this.key(config.vaultId);
      return { configured: true, locked: false, vaultId: config.vaultId };
    } catch {
      return { configured: true, locked: true, vaultId: config.vaultId };
    }
  }

  public async lock(): Promise<void> {
    this.memoryKeys.clear();
    const nextEpoch = (await this.lockEpoch()) + 1;
    await this.local.set({ [LOCK_EPOCH_KEY]: nextEpoch });
    if (this.session) await this.session.remove(SESSION_KEYS_KEY);
  }

  public async lockEpoch(): Promise<number> {
    const stored = await this.local.get(LOCK_EPOCH_KEY);
    const value = stored[LOCK_EPOCH_KEY];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  public async assertEpoch(expected: number, vaultId?: string): Promise<void> {
    if ((await this.lockEpoch()) !== expected) {
      throw new TabBridgeError(
        'CANCELLED',
        'The operation was cancelled because TabBridge was locked.',
      );
    }
    await this.key(vaultId);
  }

  public async installConfig(config: VaultConfig, key: CryptoKey): Promise<void> {
    await this.local.set({ [VAULT_CONFIG_KEY]: config });
    await this.remember(config.vaultId, key);
  }

  private async remember(vaultId: string, key: CryptoKey): Promise<void> {
    this.memoryKeys.set(vaultId, key);
    if (!this.session) return;
    const stored = await this.session.get(SESSION_KEYS_KEY);
    const keys = keyMap(stored[SESSION_KEYS_KEY]);
    keys[vaultId] = await exportRawKey(key);
    await this.session.set({ [SESSION_KEYS_KEY]: keys });
  }
}
