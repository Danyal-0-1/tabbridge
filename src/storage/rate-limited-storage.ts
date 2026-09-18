import type { StorageArea } from './storage-area.ts';

const RATE_STATE_KEY = 'tb:sync-write-scheduler';
export const SYNC_WRITE_INTERVAL_MS = 2_100;

interface RateState {
  lastWriteAt: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RateLimitedStorageArea implements StorageArea {
  private chain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly target: StorageArea,
    private readonly state: StorageArea,
    private readonly intervalMilliseconds = SYNC_WRITE_INTERVAL_MS,
  ) {}

  public get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    return this.target.get(keys);
  }

  public set(items: Record<string, unknown>): Promise<void> {
    return this.schedule(() => this.target.set(items));
  }

  public remove(keys: string | string[]): Promise<void> {
    return this.schedule(() => this.target.remove(keys));
  }

  public getBytesInUse(keys?: string | string[] | null): Promise<number> {
    if (this.target.getBytesInUse) return this.target.getBytesInUse(keys);
    return this.target
      .get(keys)
      .then((value) => new TextEncoder().encode(JSON.stringify(value)).length);
  }

  public setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> {
    return this.target.setAccessLevel?.(options) ?? Promise.resolve();
  }

  private schedule(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.chain.then(async () => {
      const stored = await this.state.get(RATE_STATE_KEY);
      const value = stored[RATE_STATE_KEY];
      const lastWriteAt =
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Partial<RateState>).lastWriteAt === 'number'
          ? ((value as RateState).lastWriteAt as number)
          : 0;
      const wait = Math.max(0, lastWriteAt + this.intervalMilliseconds - Date.now());
      if (wait > 0) await delay(wait);
      await operation();
      await this.state.set({ [RATE_STATE_KEY]: { lastWriteAt: Date.now() } satisfies RateState });
    });
    this.chain = scheduled.catch(() => undefined);
    return scheduled;
  }
}
