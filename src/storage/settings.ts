import { newId } from '../core/ids.ts';
import type { TabBridgeSettings } from '../core/types.ts';
import { inferBrowserFamily, type BrowserAdapter } from '../platform/browser-adapter.ts';

export const SETTINGS_KEY = 'tb:settings';

function validSettings(value: unknown): value is TabBridgeSettings {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<TabBridgeSettings>;
  return (
    typeof item.deviceId === 'string' &&
    typeof item.deviceLabel === 'string' &&
    typeof item.browserFamily === 'string' &&
    typeof item.syncEnabled === 'boolean' &&
    typeof item.discardBackgroundTabs === 'boolean' &&
    typeof item.firstRunComplete === 'boolean'
  );
}

export class SettingsRepository {
  public constructor(private readonly browser: BrowserAdapter) {}

  public async get(): Promise<TabBridgeSettings> {
    const stored = await this.browser.local.get(SETTINGS_KEY);
    const value = stored[SETTINGS_KEY];
    if (validSettings(value)) return value;
    return this.create();
  }

  public async update(patch: Partial<TabBridgeSettings>): Promise<TabBridgeSettings> {
    const current = await this.get();
    const next: TabBridgeSettings = {
      ...current,
      ...patch,
      deviceId: current.deviceId,
      browserFamily: current.browserFamily,
    };
    if (next.deviceLabel.trim().length === 0 || next.deviceLabel.length > 120) {
      throw new Error('Device label must be between 1 and 120 characters.');
    }
    await this.browser.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  private async create(): Promise<TabBridgeSettings> {
    const manifest = this.browser.getManifest();
    const family = inferBrowserFamily(manifest);
    const platform: { os?: string } = await this.browser.platformInfo().catch(() => ({}));
    const browserInfo: { name?: string; version?: string } = await this.browser
      .browserInfo()
      .catch(() => ({}));
    const browserVersion = browserInfo.version;
    const settings: TabBridgeSettings = {
      deviceId: newId(),
      deviceLabel: 'This device',
      browserFamily: family,
      ...(browserVersion ? { browserVersion } : {}),
      ...(platform.os ? { operatingSystem: platform.os } : {}),
      syncEnabled: false,
      discardBackgroundTabs: false,
      firstRunComplete: false,
    };
    await this.browser.local.set({ [SETTINGS_KEY]: settings });
    return settings;
  }
}
