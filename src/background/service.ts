import { captureWorkspace, type CaptureScope } from '../core/capture.ts';
import {
  createExportFile,
  createVault,
  decryptSnapshot,
  encryptSnapshot,
  readExportFile,
} from '../core/crypto.ts';
import { publicError, TabBridgeError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import {
  requestType,
  type ImportResponse,
  type ImportPreviewResponse,
  type Request,
  type Response,
  type ResponseData,
} from '../core/messages.ts';
import { createRestorePlan, executeRestore } from '../core/restore.ts';
import { LIMITS, validateSnapshot } from '../core/schema.ts';
import type { CaptureWarning, RestoreSelection, Snapshot, SnapshotSummary } from '../core/types.ts';
import { assessUrl } from '../core/url-policy.ts';
import { BrowserAdapter } from '../platform/browser-adapter.ts';
import { RecordStore, type PreparedRecord } from '../storage/record-store.ts';
import { RateLimitedStorageArea } from '../storage/rate-limited-storage.ts';
import { SettingsRepository } from '../storage/settings.ts';
import { SnapshotRepository } from '../storage/snapshot-repository.ts';
import { SyncRepository, SYNC_VAULT_KEY } from '../storage/sync-repository.ts';
import { VAULT_CONFIG_KEY, VaultManager } from '../storage/vault.ts';

const LAST_ACTION_KEY = 'tb:last-action';
const ROTATION_JOURNAL_KEY = 'tb:transaction:passphrase-rotation';

interface LastAction {
  message: string;
  at: string;
}

function requiredString(value: unknown, field: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TabBridgeError('VALIDATION_ERROR', `${field} is invalid.`);
  }
  return value;
}

function asRequest(value: unknown): Request {
  if (!requestType(value)) throw new TabBridgeError('VALIDATION_ERROR', 'Unknown request.');
  return value as Request;
}

function summary(snapshot: Snapshot, synced: boolean): SnapshotSummary {
  return {
    snapshotId: snapshot.snapshotId,
    generationId: snapshot.generationId,
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    sourceDevice: snapshot.sourceDevice,
    windowCount: snapshot.windows.length,
    tabCount: snapshot.windows.reduce((total, window) => total + window.tabs.length, 0),
    groupCount: snapshot.windows.reduce((total, window) => total + window.groups.length, 0),
    location: synced ? 'synced' : 'local',
    locked: false,
  };
}

function sanitizeImportedSnapshot(snapshot: Snapshot): { snapshot: Snapshot; skipped: number } {
  let skipped = 0;
  const windows = snapshot.windows.flatMap((window) => {
    const tabs = window.tabs.flatMap((tab) => {
      const decision = assessUrl(tab.url);
      if (!decision.allowed || !decision.normalized) {
        skipped += 1;
        return [];
      }
      return [{ ...tab, url: decision.normalized }];
    });
    if (tabs.length === 0) return [];
    const ids = new Set(tabs.map((tab) => tab.id));
    const usedGroups = new Set(tabs.flatMap((tab) => (tab.groupId ? [tab.groupId] : [])));
    const activeTabId =
      window.activeTabId && ids.has(window.activeTabId) ? window.activeTabId : tabs[0]?.id;
    return [
      {
        ...window,
        ...(activeTabId ? { activeTabId } : {}),
        groups: window.groups.filter((group) => usedGroups.has(group.id)),
        tabs: tabs.map((tab, index) => ({ ...tab, index, active: tab.id === activeTabId })),
      },
    ];
  });
  const captureWarnings: CaptureWarning[] = [...snapshot.captureWarnings];
  if (skipped > 0) {
    captureWarnings.push({
      code: 'unsupported-url',
      count: skipped,
      message: 'Unsafe or unsupported URLs were removed during import.',
    });
  }
  return { snapshot: validateSnapshot({ ...snapshot, windows, captureWarnings }), skipped };
}

export class TabBridgeService {
  private readonly localRecords: RecordStore;
  private readonly syncRecords: RecordStore;
  private readonly settings: SettingsRepository;
  private readonly vault: VaultManager;
  private readonly snapshots: SnapshotRepository;
  private readonly sync: SyncRepository;

  public constructor(private readonly browser: BrowserAdapter) {
    const throttledSync = new RateLimitedStorageArea(browser.sync, browser.local);
    this.localRecords = new RecordStore(browser.local, 'tb:local');
    this.syncRecords = new RecordStore(throttledSync, 'tb:sync');
    this.settings = new SettingsRepository(browser);
    this.vault = new VaultManager(browser.local, browser.session);
    this.snapshots = new SnapshotRepository(this.localRecords, this.vault);
    this.sync = new SyncRepository(throttledSync, this.syncRecords);
  }

  public async initialize(): Promise<void> {
    await this.browser.hardenStorage().catch(() => undefined);
    await this.settings.get();
    await this.localRecords.cleanupOrphans().catch(() => undefined);
  }

  public async handle(value: unknown): Promise<Response> {
    try {
      const request = asRequest(value);
      const data = await this.dispatch(request);
      return { ok: true, data: data as ResponseData };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  }

  public async handleSyncChange(changes: unknown): Promise<void> {
    const settings = await this.settings.get();
    if (!settings.syncEnabled || typeof changes !== 'object' || changes === null) return;
    const config = await this.vault.config();
    if (!config) return;
    for (const key of Object.keys(changes)) {
      const prefix = 'tb:sync:manifest:';
      const tombstonePrefix = 'tb:sync:tombstone:';
      if (key.startsWith(tombstonePrefix)) {
        const snapshotId = key.slice(tombstonePrefix.length);
        await this.localRecords.remove(snapshotId, true).catch(() => undefined);
      } else if (key.startsWith(prefix)) {
        const snapshotId = key.slice(prefix.length);
        try {
          await this.sync.mirrorTo(this.localRecords, snapshotId, config.vaultId);
        } catch {
          // Sync delivery can be chunk-by-chunk. A later change or manager refresh retries it.
        }
      }
    }
  }

  private async dispatch(request: Request): Promise<unknown> {
    switch (request.type) {
      case 'GET_STATUS':
        return this.getStatus();
      case 'SETUP_VAULT':
        return this.setupVault(request.passphrase, request.deviceLabel);
      case 'UNLOCK':
        await this.vault.unlock(requiredString(request.passphrase, 'Passphrase', 1_024));
        return { locked: false };
      case 'JOIN_SYNC':
        return this.joinSync(request.passphrase, request.consentGranted);
      case 'LOCK':
        await this.vault.lock();
        return { locked: true };
      case 'CAPTURE':
        return this.capture(request.scope);
      case 'LIST_SNAPSHOTS':
        return this.list();
      case 'GET_SNAPSHOT':
        return this.snapshots.get(requiredString(request.snapshotId, 'Snapshot ID', 64));
      case 'RENAME_SNAPSHOT':
        return this.rename(request.snapshotId, request.name);
      case 'DELETE_SNAPSHOT':
        return this.delete(request.snapshotId);
      case 'RESTORE_SNAPSHOT':
        return this.restore(
          request.snapshotId,
          request.selection,
          requiredString(request.operationId, 'Operation ID', 64),
        );
      case 'STOP_RESTORE':
        await this.cancellationArea().set({ [this.cancelKey(request.operationId)]: true });
        return { stopped: true };
      case 'EXPORT_SNAPSHOT':
        return this.exportSnapshot(request.snapshotId, request.passphrase);
      case 'PREVIEW_IMPORT':
        return this.previewImport(request.contents, request.passphrase);
      case 'IMPORT_SNAPSHOT':
        return this.importSnapshot(request.contents, request.passphrase);
      case 'SET_SYNC_ENABLED':
        return this.setSyncEnabled(request.enabled, request.consentGranted);
      case 'SET_SNAPSHOT_SYNC':
        return this.setSnapshotSync(request.snapshotId, request.synced);
      case 'UPDATE_SETTINGS':
        return this.settings.update(request.patch);
      case 'CHANGE_PASSPHRASE':
        await this.changePassphrase(request.oldPassphrase, request.newPassphrase);
        return { changed: true };
    }
  }

  private async getStatus(): Promise<unknown> {
    const settings = await this.settings.get();
    const status = await this.vault.status();
    const storedAction = await this.browser.local.get(LAST_ACTION_KEY);
    const action = storedAction[LAST_ACTION_KEY] as LastAction | undefined;
    const quota = settings.syncEnabled ? await this.sync.quota().catch(() => undefined) : undefined;
    return {
      settings,
      configured: status.configured,
      locked: status.locked,
      syncedVaultAvailable: settings.syncEnabled,
      ...(action?.message ? { lastAction: action.message } : {}),
      ...(quota ? { quota } : {}),
    };
  }

  private async setupVault(passphrase: string, deviceLabel: string): Promise<unknown> {
    const label = requiredString(deviceLabel.trim(), 'Device label', LIMITS.deviceLabelLength);
    await this.vault.setup(requiredString(passphrase, 'Passphrase', 1_024));
    const settings = await this.settings.update({ deviceLabel: label, firstRunComplete: true });
    return settings;
  }

  private async joinSync(passphrase: string, consentGranted: boolean): Promise<unknown> {
    if (!consentGranted) {
      throw new TabBridgeError('SYNC_UNAVAILABLE', 'Browser Sync consent was not granted.');
    }
    const existing = await this.vault.config();
    if (existing) {
      throw new TabBridgeError(
        'SYNC_UNAVAILABLE',
        'This installation already has a local vault. Import snapshots instead of replacing it.',
      );
    }
    const remote = await this.sync.remoteVault();
    if (!remote)
      throw new TabBridgeError('NOT_FOUND', 'No TabBridge vault was found in browser sync.');
    const key = await (async () => {
      await this.vault.unlock(requiredString(passphrase, 'Passphrase', 1_024), remote);
      return this.vault.key(remote.vaultId);
    })();
    await this.vault.installConfig(remote, key);
    await this.settings.update({ syncEnabled: true, firstRunComplete: true });
    for (const manifest of await this.syncRecords.listManifests()) {
      await this.sync
        .mirrorTo(this.localRecords, manifest.snapshotId, remote.vaultId)
        .catch(() => undefined);
    }
    return { joined: true };
  }

  private async capture(scope: CaptureScope): Promise<unknown> {
    await this.vault.key();
    const settings = await this.settings.get();
    const snapshot = await captureWorkspace(this.browser, scope, {
      id: settings.deviceId,
      label: settings.deviceLabel,
      browser: settings.browserFamily,
      ...(settings.browserVersion ? { browserVersion: settings.browserVersion } : {}),
      ...(settings.operatingSystem ? { operatingSystem: settings.operatingSystem } : {}),
    });
    if (snapshot.windows.length === 0) {
      throw new TabBridgeError('VALIDATION_ERROR', 'No supported tabs were available to save.');
    }
    await this.snapshots.save(snapshot);
    const skipped = snapshot.captureWarnings.reduce((total, warning) => total + warning.count, 0);
    await this.setLastAction(`Saved a snapshot${skipped ? `; skipped ${skipped} tab(s)` : ''}.`);
    return { saved: true, skipped };
  }

  private async list(): Promise<unknown> {
    const settings = await this.settings.get();
    let syncedIds = new Set<string>();
    if (settings.syncEnabled) {
      syncedIds = await this.sync.syncedIds().catch(() => new Set<string>());
      const config = await this.vault.config();
      if (config) {
        for (const id of syncedIds) {
          if (!(await this.localRecords.has(id))) {
            await this.sync.mirrorTo(this.localRecords, id, config.vaultId).catch(() => undefined);
          }
        }
      }
    }
    return this.snapshots.list(syncedIds);
  }

  private async rename(snapshotIdValue: string, nameValue: string): Promise<unknown> {
    const snapshotId = requiredString(snapshotIdValue, 'Snapshot ID', 64);
    const name = requiredString(nameValue.trim(), 'Snapshot name', LIMITS.nameLength);
    const old = await this.snapshots.get(snapshotId);
    const updated = validateSnapshot({
      ...old,
      generationId: newId(),
      name,
      updatedAt: new Date().toISOString(),
    });
    await this.snapshots.save(updated);
    const settings = await this.settings.get();
    const synced = settings.syncEnabled
      ? (await this.sync.syncedIds().catch(() => new Set<string>())).has(snapshotId)
      : false;
    if (synced) await this.sync.upload(this.localRecords, snapshotId);
    await this.setLastAction('Renamed a snapshot.');
    return summary(updated, synced);
  }

  private async delete(snapshotIdValue: string): Promise<unknown> {
    const snapshotId = requiredString(snapshotIdValue, 'Snapshot ID', 64);
    const settings = await this.settings.get();
    if (settings.syncEnabled && (await this.sync.syncedIds()).has(snapshotId)) {
      await this.sync.remove(snapshotId);
    }
    await this.localRecords.remove(snapshotId, true);
    await this.setLastAction('Deleted a snapshot.');
    return { deleted: true };
  }

  private async restore(
    snapshotIdValue: string,
    selection: RestoreSelection | undefined,
    operationId: string,
  ): Promise<unknown> {
    const snapshot = await this.snapshots.get(requiredString(snapshotIdValue, 'Snapshot ID', 64));
    const plan = createRestorePlan(snapshot, selection);
    const settings = await this.settings.get();
    const lockEpoch = await this.vault.lockEpoch();
    const area = this.cancellationArea();
    const key = this.cancelKey(operationId);
    await area.set({ [key]: false });
    try {
      const report = await executeRestore(this.browser, plan, {
        operationId,
        discardBackgroundTabs: settings.discardBackgroundTabs,
        isCancelled: async () =>
          (await area.get(key))[key] === true || (await this.vault.lockEpoch()) !== lockEpoch,
        onProgress: async (progress) => {
          await this.browser
            .sendMessage({ type: 'RESTORE_PROGRESS', progress })
            .catch(() => undefined);
        },
      });
      await this.setLastAction(
        report.stopped
          ? `Restore stopped after opening ${report.tabsRestored} tab(s).`
          : `Restored ${report.tabsRestored} tab(s) in ${report.windowsRestored} window(s).`,
      );
      return report;
    } finally {
      await area.remove(key).catch(() => undefined);
    }
  }

  private async exportSnapshot(snapshotIdValue: string, passphrase: string): Promise<unknown> {
    const snapshot = await this.snapshots.get(requiredString(snapshotIdValue, 'Snapshot ID', 64));
    const epoch = await this.vault.lockEpoch();
    const file = await createExportFile(snapshot, requiredString(passphrase, 'Passphrase', 1_024));
    await this.vault.assertEpoch(epoch);
    await this.setLastAction('Prepared an encrypted export.');
    return {
      filename: `tabbridge-${snapshot.snapshotId.slice(0, 8)}.tabbridge`,
      contents: `${JSON.stringify(file, null, 2)}\n`,
      mediaType: 'application/vnd.tabbridge+json',
    };
  }

  private async importSnapshot(contents: string, passphrase: string): Promise<ImportResponse> {
    const prepared = await this.prepareImport(contents, passphrase);
    let snapshot = prepared.snapshot;
    const importedAsCopy = prepared.importedAsCopy;
    if (importedAsCopy) {
      const now = new Date().toISOString();
      snapshot = validateSnapshot({
        ...snapshot,
        snapshotId: newId(),
        generationId: newId(),
        name: `${snapshot.name} (imported copy)`.slice(0, LIMITS.nameLength),
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.snapshots.save(snapshot);
    await this.setLastAction('Imported an encrypted snapshot.');
    return {
      snapshot: summary(snapshot, false),
      skipped: prepared.skipped,
      importedAsCopy,
    };
  }

  private async previewImport(
    contents: string,
    passphrase: string,
  ): Promise<ImportPreviewResponse> {
    const prepared = await this.prepareImport(contents, passphrase);
    return {
      name: prepared.snapshot.name,
      windowCount: prepared.snapshot.windows.length,
      tabCount: prepared.snapshot.windows.reduce((sum, window) => sum + window.tabs.length, 0),
      groupCount: prepared.snapshot.windows.reduce((sum, window) => sum + window.groups.length, 0),
      skipped: prepared.skipped,
      importedAsCopy: prepared.importedAsCopy,
    };
  }

  private async prepareImport(
    contents: string,
    passphrase: string,
  ): Promise<{ snapshot: Snapshot; skipped: number; importedAsCopy: boolean }> {
    requiredString(contents, 'Import contents', LIMITS.importBytes);
    const snapshot = await readExportFile(
      contents,
      requiredString(passphrase, 'Passphrase', 1_024),
    );
    const sanitized = sanitizeImportedSnapshot(snapshot);
    const importedAsCopy =
      (await this.localRecords.has(sanitized.snapshot.snapshotId)) ||
      (await this.localRecords.isTombstoned(sanitized.snapshot.snapshotId));
    return {
      snapshot: sanitized.snapshot,
      skipped: sanitized.skipped,
      importedAsCopy,
    };
  }

  private async setSyncEnabled(enabled: boolean, consentGranted: boolean): Promise<unknown> {
    if (!enabled) {
      await this.settings.update({ syncEnabled: false });
      return { synced: false };
    }
    if (!consentGranted) {
      throw new TabBridgeError('SYNC_UNAVAILABLE', 'Browser Sync consent was not granted.');
    }
    const config = await this.vault.config();
    if (!config)
      throw new TabBridgeError('NOT_CONFIGURED', 'Set a passphrase before enabling sync.');
    await this.sync.publishVault(config);
    await this.settings.update({ syncEnabled: true });
    await this.setLastAction('Browser Sync mode enabled. Delivery may not be immediate.');
    return { synced: true };
  }

  private async setSnapshotSync(snapshotIdValue: string, synced: boolean): Promise<unknown> {
    const snapshotId = requiredString(snapshotIdValue, 'Snapshot ID', 64);
    const settings = await this.settings.get();
    if (!settings.syncEnabled) {
      throw new TabBridgeError('SYNC_UNAVAILABLE', 'Enable Browser Sync mode first.');
    }
    if (synced) {
      if (await this.syncRecords.isTombstoned(snapshotId)) {
        const source = await this.snapshots.get(snapshotId);
        const now = new Date().toISOString();
        const copy = validateSnapshot({
          ...source,
          snapshotId: newId(),
          generationId: newId(),
          createdAt: now,
          updatedAt: now,
        });
        await this.snapshots.save(copy);
        await this.sync.upload(this.localRecords, copy.snapshotId);
        await this.localRecords.remove(snapshotId, true);
      } else {
        await this.sync.upload(this.localRecords, snapshotId);
      }
      await this.setLastAction('Saved to browser sync. Delivery to other devices may take time.');
    } else {
      await this.sync.remove(snapshotId);
      await this.setLastAction('Removed the synced copy. The local snapshot remains.');
    }
    return { synced };
  }

  private async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    const oldConfig = await this.vault.config();
    if (!oldConfig) throw new TabBridgeError('NOT_CONFIGURED', 'Encryption is not configured.');
    await this.vault.unlock(requiredString(oldPassphrase, 'Old passphrase', 1_024), oldConfig);
    const oldKey = await this.vault.key(oldConfig.vaultId);
    const lockEpoch = await this.vault.lockEpoch();
    const manifests = await this.localRecords.listManifests();
    const plaintext: Snapshot[] = [];
    for (const manifest of manifests) {
      plaintext.push(
        await decryptSnapshot(await this.localRecords.read(manifest.snapshotId), oldKey),
      );
    }
    const { config: newConfig, key: newKey } = await createVault(
      requiredString(newPassphrase, 'New passphrase', 1_024),
    );
    await this.browser.local.set({
      [ROTATION_JOURNAL_KEY]: {
        fromVaultId: oldConfig.vaultId,
        toVaultId: newConfig.vaultId,
        startedAt: new Date().toISOString(),
        snapshotIds: plaintext.map((snapshot) => snapshot.snapshotId),
      },
    });

    const localPrepared: PreparedRecord[] = [];
    const syncPrepared: PreparedRecord[] = [];
    const settings = await this.settings.get();
    const oldSyncManifests = settings.syncEnabled
      ? await this.syncRecords.listManifests().catch(() => [])
      : [];
    const syncedIds = new Set(oldSyncManifests.map((manifest) => manifest.snapshotId));
    let discardLocalOnFailure = true;
    let discardSyncOnFailure = true;
    try {
      for (const snapshot of plaintext) {
        const rotated = validateSnapshot({
          ...snapshot,
          generationId: newId(),
          updatedAt: new Date().toISOString(),
        });
        const encrypted = await encryptSnapshot(rotated, newKey, newConfig.vaultId);
        await this.vault.assertEpoch(lockEpoch, oldConfig.vaultId);
        const prepared = await this.localRecords.prepare(encrypted);
        localPrepared.push(prepared);
        if (syncedIds.has(snapshot.snapshotId)) {
          syncPrepared.push(await this.syncRecords.prepare(encrypted, { enforceSyncQuota: true }));
        }
      }

      if (syncPrepared.length > 0) {
        await this.vault.assertEpoch(lockEpoch, oldConfig.vaultId);
        try {
          await this.syncRecords.publish(
            syncPrepared.map((item) => item.manifest),
            { [SYNC_VAULT_KEY]: newConfig },
          );
          discardSyncOnFailure = false;
        } catch (error) {
          try {
            await this.syncRecords.publish(oldSyncManifests, { [SYNC_VAULT_KEY]: oldConfig });
            discardSyncOnFailure = true;
          } catch {
            discardSyncOnFailure = false;
          }
          throw error;
        }
      }
      try {
        await this.vault.assertEpoch(lockEpoch, oldConfig.vaultId);
        await this.localRecords.publish(
          localPrepared.map((item) => item.manifest),
          { [VAULT_CONFIG_KEY]: newConfig },
        );
        discardLocalOnFailure = false;
      } catch (error) {
        try {
          await this.localRecords.publish(manifests, { [VAULT_CONFIG_KEY]: oldConfig });
          discardLocalOnFailure = true;
        } catch {
          discardLocalOnFailure = false;
        }
        if (syncPrepared.length > 0 && !discardSyncOnFailure) {
          try {
            await this.syncRecords.publish(oldSyncManifests, { [SYNC_VAULT_KEY]: oldConfig });
            discardSyncOnFailure = true;
          } catch {
            discardSyncOnFailure = false;
          }
        }
        throw error;
      }
      await this.vault.lock();
      await this.vault.installConfig(newConfig, newKey);
      await this.browser.local.remove(ROTATION_JOURNAL_KEY);
      await this.localRecords.discardPrevious(localPrepared).catch(() => undefined);
      if (syncPrepared.length > 0) {
        await this.syncRecords.discardPrevious(syncPrepared).catch(() => undefined);
      }
      await this.setLastAction('Encryption passphrase changed and all snapshots were verified.');
    } catch (error) {
      if (discardLocalOnFailure) {
        await this.localRecords.discardPrepared(localPrepared).catch(() => undefined);
      }
      if (discardSyncOnFailure) {
        await this.syncRecords.discardPrepared(syncPrepared).catch(() => undefined);
      }
      throw error;
    }
  }

  private cancellationArea() {
    return this.browser.session ?? this.browser.local;
  }

  private cancelKey(operationId: string): string {
    return `tb:restore:cancel:${operationId}`;
  }

  private async setLastAction(message: string): Promise<void> {
    await this.browser.local.set({
      [LAST_ACTION_KEY]: { message, at: new Date().toISOString() } satisfies LastAction,
    });
  }
}

const browser = new BrowserAdapter();
const service = new TabBridgeService(browser);

browser.raw.runtime.onMessage.addListener((...arguments_: unknown[]) => {
  const [message, , sendResponse] = arguments_;
  if (typeof sendResponse !== 'function') return false;
  void service
    .handle(message)
    .then((response) => (sendResponse as (value: Response) => void)(response));
  return true;
});

browser.raw.storage.onChanged.addListener((...arguments_: unknown[]) => {
  const [changes, areaName] = arguments_;
  if (areaName === 'sync') void service.handleSyncChange(changes);
});

browser.raw.runtime.onInstalled.addListener((...arguments_: unknown[]) => {
  const [details] = arguments_;
  void service.initialize();
  if (
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'install'
  ) {
    void browser.openManager();
  }
});

browser.raw.runtime.onStartup?.addListener(() => {
  void service.initialize();
});

void service.initialize();
