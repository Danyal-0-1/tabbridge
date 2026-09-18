import { TabBridgeError } from '../core/errors.ts';
import type { BrowserFamily, GroupColor } from '../core/types.ts';
import type { StorageArea } from '../storage/storage-area.ts';

export interface BrowserTab {
  id?: number;
  windowId?: number;
  index: number;
  url?: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  incognito: boolean;
  groupId?: number;
}

export interface BrowserWindow {
  id?: number;
  type?: string;
  incognito: boolean;
  state?: string;
  tabs?: BrowserTab[];
}

export interface BrowserGroup {
  id: number;
  windowId?: number;
  title?: string;
  color: GroupColor;
  collapsed: boolean;
}

interface RuntimeLastError {
  message?: string;
}

interface EventLike {
  addListener(callback: (...arguments_: unknown[]) => unknown): void;
}

interface RawStorageArea {
  get(keys?: unknown, callback?: (items: Record<string, unknown>) => void): unknown;
  set(items: Record<string, unknown>, callback?: () => void): unknown;
  remove(keys: string | string[], callback?: () => void): unknown;
  getBytesInUse?(keys?: unknown, callback?: (bytes: number) => void): unknown;
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' }, callback?: () => void): unknown;
}

interface RawExtensionApi {
  runtime: {
    lastError?: RuntimeLastError;
    onInstalled: EventLike;
    onStartup?: EventLike;
    onMessage: EventLike;
    getManifest(): Record<string, unknown>;
    getURL(path: string): string;
    sendMessage(message: unknown, callback?: (response: unknown) => void): unknown;
    openOptionsPage?(callback?: () => void): unknown;
    getPlatformInfo?(callback?: (info: { os?: string }) => void): unknown;
    getBrowserInfo?(callback?: (info: { name?: string; version?: string }) => void): unknown;
  };
  storage: {
    local: RawStorageArea;
    sync: RawStorageArea;
    session?: RawStorageArea;
    onChanged: EventLike;
  };
  windows: {
    getAll(
      options: Record<string, unknown>,
      callback?: (windows: BrowserWindow[]) => void,
    ): unknown;
    getCurrent(
      options: Record<string, unknown>,
      callback?: (window: BrowserWindow) => void,
    ): unknown;
    create(options: Record<string, unknown>, callback?: (window: BrowserWindow) => void): unknown;
  };
  tabs: {
    query(options: Record<string, unknown>, callback?: (tabs: BrowserTab[]) => void): unknown;
    create(options: Record<string, unknown>, callback?: (tab: BrowserTab) => void): unknown;
    update(
      tabId: number,
      options: Record<string, unknown>,
      callback?: (tab: BrowserTab) => void,
    ): unknown;
    group?(
      options: { tabIds: number[]; createProperties?: { windowId: number } },
      callback?: (groupId: number) => void,
    ): unknown;
    discard?(tabId: number, callback?: (tab: BrowserTab) => void): unknown;
  };
  tabGroups?: {
    query(options: Record<string, unknown>, callback?: (groups: BrowserGroup[]) => void): unknown;
    update(
      groupId: number,
      options: Record<string, unknown>,
      callback?: (group: BrowserGroup) => void,
    ): unknown;
  };
  permissions?: {
    request(permissions: Record<string, unknown>, callback?: (granted: boolean) => void): unknown;
  };
}

type Method = (...arguments_: unknown[]) => unknown;

function detectApi(): { raw: RawExtensionApi; promiseNative: boolean } {
  const globals = globalThis as unknown as {
    browser?: RawExtensionApi;
    chrome?: RawExtensionApi;
  };
  if (globals.browser?.runtime) return { raw: globals.browser, promiseNative: true };
  if (globals.chrome?.runtime) return { raw: globals.chrome, promiseNative: false };
  throw new TabBridgeError('BROWSER_ERROR', 'The WebExtension API is unavailable.');
}

function runtimeError(raw: RawExtensionApi): Error | undefined {
  const message = raw.runtime.lastError?.message;
  return message ? new TabBridgeError('BROWSER_ERROR', message) : undefined;
}

async function invoke<T>(
  raw: RawExtensionApi,
  promiseNative: boolean,
  owner: object,
  method: Method,
  arguments_: unknown[],
): Promise<T> {
  if (promiseNative) {
    return (await method.apply(owner, arguments_)) as T;
  }
  return new Promise<T>((resolve, reject) => {
    const callback = (value: T): void => {
      const error = runtimeError(raw);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      method.apply(owner, [...arguments_, callback]);
    } catch (error) {
      reject(error);
    }
  });
}

class WrappedStorageArea implements StorageArea {
  public constructor(
    private readonly rawApi: RawExtensionApi,
    private readonly promiseNative: boolean,
    private readonly rawArea: RawStorageArea,
  ) {}

  public get(keys: string | string[] | null = null): Promise<Record<string, unknown>> {
    return invoke(this.rawApi, this.promiseNative, this.rawArea, this.rawArea.get as Method, [
      keys,
    ]);
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    await invoke(this.rawApi, this.promiseNative, this.rawArea, this.rawArea.set as Method, [
      items,
    ]);
  }

  public async remove(keys: string | string[]): Promise<void> {
    await invoke(this.rawApi, this.promiseNative, this.rawArea, this.rawArea.remove as Method, [
      keys,
    ]);
  }

  public async getBytesInUse(keys: string | string[] | null = null): Promise<number> {
    if (!this.rawArea.getBytesInUse) {
      const values = await this.get(keys);
      return new TextEncoder().encode(JSON.stringify(values)).byteLength;
    }
    return invoke(
      this.rawApi,
      this.promiseNative,
      this.rawArea,
      this.rawArea.getBytesInUse as Method,
      [keys],
    );
  }

  public async setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> {
    if (!this.rawArea.setAccessLevel) return;
    await invoke(
      this.rawApi,
      this.promiseNative,
      this.rawArea,
      this.rawArea.setAccessLevel as Method,
      [options],
    );
  }
}

export class BrowserAdapter {
  public readonly raw: RawExtensionApi;
  public readonly local: StorageArea;
  public readonly sync: StorageArea;
  public readonly session?: StorageArea;
  private readonly promiseNative: boolean;

  public constructor() {
    const detected = detectApi();
    this.raw = detected.raw;
    this.promiseNative = detected.promiseNative;
    this.local = new WrappedStorageArea(this.raw, this.promiseNative, this.raw.storage.local);
    this.sync = new WrappedStorageArea(this.raw, this.promiseNative, this.raw.storage.sync);
    if (this.raw.storage.session) {
      this.session = new WrappedStorageArea(this.raw, this.promiseNative, this.raw.storage.session);
    }
  }

  public async hardenStorage(): Promise<void> {
    await Promise.all([
      this.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }),
      this.sync.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }),
      this.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
  }

  public getManifest(): Record<string, unknown> {
    return this.raw.runtime.getManifest();
  }

  public getUrl(path: string): string {
    return this.raw.runtime.getURL(path);
  }

  public async sendMessage<T>(message: unknown): Promise<T> {
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.runtime,
      this.raw.runtime.sendMessage as Method,
      [message],
    );
  }

  public async openManager(): Promise<void> {
    if (this.raw.runtime.openOptionsPage) {
      await invoke(
        this.raw,
        this.promiseNative,
        this.raw.runtime,
        this.raw.runtime.openOptionsPage as Method,
        [],
      );
    }
  }

  public async getAllWindows(): Promise<BrowserWindow[]> {
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.windows,
      this.raw.windows.getAll as Method,
      [{ populate: true, windowTypes: ['normal'] }],
    );
  }

  public async getCurrentWindow(): Promise<BrowserWindow> {
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.windows,
      this.raw.windows.getCurrent as Method,
      [{ populate: true }],
    );
  }

  public async getActiveTab(): Promise<BrowserTab | undefined> {
    const tabs = await invoke<BrowserTab[]>(
      this.raw,
      this.promiseNative,
      this.raw.tabs,
      this.raw.tabs.query as Method,
      [{ active: true, currentWindow: true }],
    );
    return tabs[0];
  }

  public async getGroups(windowId: number): Promise<BrowserGroup[]> {
    if (!this.raw.tabGroups?.query) return [];
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.tabGroups,
      this.raw.tabGroups.query as Method,
      [{ windowId }],
    );
  }

  public groupsSupported(): boolean {
    return Boolean(this.raw.tabs.group && this.raw.tabGroups?.update);
  }

  public async createWindow(options: Record<string, unknown>): Promise<BrowserWindow> {
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.windows,
      this.raw.windows.create as Method,
      [options],
    );
  }

  public async createTab(options: Record<string, unknown>): Promise<BrowserTab> {
    return invoke(this.raw, this.promiseNative, this.raw.tabs, this.raw.tabs.create as Method, [
      options,
    ]);
  }

  public async updateTab(tabId: number, options: Record<string, unknown>): Promise<BrowserTab> {
    return invoke(this.raw, this.promiseNative, this.raw.tabs, this.raw.tabs.update as Method, [
      tabId,
      options,
    ]);
  }

  public async groupTabs(tabIds: number[], windowId: number): Promise<number> {
    if (!this.raw.tabs.group)
      throw new TabBridgeError('BROWSER_ERROR', 'Tab groups are unavailable.');
    return invoke(this.raw, this.promiseNative, this.raw.tabs, this.raw.tabs.group as Method, [
      { tabIds, createProperties: { windowId } },
    ]);
  }

  public async updateGroup(
    groupId: number,
    options: { title: string; color: GroupColor; collapsed: boolean },
  ): Promise<void> {
    if (!this.raw.tabGroups?.update) {
      throw new TabBridgeError('BROWSER_ERROR', 'Tab groups are unavailable.');
    }
    await invoke(
      this.raw,
      this.promiseNative,
      this.raw.tabGroups,
      this.raw.tabGroups.update as Method,
      [groupId, options],
    );
  }

  public async discardTab(tabId: number): Promise<void> {
    if (!this.raw.tabs.discard) return;
    await invoke(this.raw, this.promiseNative, this.raw.tabs, this.raw.tabs.discard as Method, [
      tabId,
    ]);
  }

  public async platformInfo(): Promise<{ os?: string }> {
    if (!this.raw.runtime.getPlatformInfo) return {};
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.runtime,
      this.raw.runtime.getPlatformInfo as Method,
      [],
    );
  }

  public async browserInfo(): Promise<{ name?: string; version?: string }> {
    if (!this.raw.runtime.getBrowserInfo) return {};
    return invoke(
      this.raw,
      this.promiseNative,
      this.raw.runtime,
      this.raw.runtime.getBrowserInfo as Method,
      [],
    );
  }

  public async requestFirefoxSyncDataConsent(): Promise<boolean> {
    if (!Object.hasOwn(this.getManifest(), 'browser_specific_settings')) return true;
    if (!this.raw.permissions?.request) return true;
    try {
      return await invoke(
        this.raw,
        this.promiseNative,
        this.raw.permissions,
        this.raw.permissions.request as Method,
        [
          {
            data_collection: [
              'browsingActivity',
              'websiteContent',
              'technicalAndInteraction',
              'personallyIdentifyingInfo',
            ],
          },
        ],
      );
    } catch {
      return false;
    }
  }
}

export function inferBrowserFamily(manifest: Record<string, unknown>): BrowserFamily {
  const settings = manifest.browser_specific_settings;
  if (typeof settings === 'object' && settings !== null) return 'firefox';
  const navigatorValue = globalThis.navigator?.userAgent ?? '';
  if (/Edg\//.test(navigatorValue)) return 'chromium';
  if (/Chrome\//.test(navigatorValue)) return 'chrome';
  return 'unknown';
}
