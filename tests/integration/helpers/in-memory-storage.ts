import type { StorageArea } from '../../../src/storage/storage-area.ts';
import { estimateStorageBytes } from '../../../src/storage/storage-area.ts';

export type StorageKeys = string | string[] | null | undefined;

export interface StorageOperation {
  method: 'get' | 'set' | 'remove' | 'getBytesInUse' | 'setAccessLevel';
  at: number;
  keys?: string | string[] | null;
  items?: Record<string, unknown>;
}

export interface InMemoryStorageHooks {
  beforeGet?(keys: StorageKeys, area: InMemoryStorageArea): void | Promise<void>;
  afterGet?(
    result: Record<string, unknown>,
    keys: StorageKeys,
    area: InMemoryStorageArea,
  ): void | Promise<void>;
  beforeSet?(items: Record<string, unknown>, area: InMemoryStorageArea): void | Promise<void>;
  afterSet?(items: Record<string, unknown>, area: InMemoryStorageArea): void | Promise<void>;
  beforeRemove?(keys: string | string[], area: InMemoryStorageArea): void | Promise<void>;
  afterRemove?(keys: string | string[], area: InMemoryStorageArea): void | Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function loggedKeys(keys: StorageKeys): string | string[] | null {
  if (keys === undefined || keys === null) return null;
  return clone(keys);
}

/** A structured-clone-like StorageArea fake with opt-in fault hooks. */
export class InMemoryStorageArea implements StorageArea {
  private readonly values = new Map<string, unknown>();
  public readonly operations: StorageOperation[] = [];
  public readonly accessLevels: Array<{ accessLevel: 'TRUSTED_CONTEXTS' }> = [];
  public hooks: InMemoryStorageHooks;

  public constructor(initial: Record<string, unknown> = {}, hooks: InMemoryStorageHooks = {}) {
    this.hooks = hooks;
    this.seed(initial);
  }

  public async get(keys: StorageKeys = null): Promise<Record<string, unknown>> {
    this.operations.push({ method: 'get', at: Date.now(), keys: loggedKeys(keys) });
    await this.hooks.beforeGet?.(keys, this);
    const result: Record<string, unknown> = {};
    const requested =
      keys === undefined || keys === null
        ? [...this.values.keys()]
        : typeof keys === 'string'
          ? [keys]
          : keys;
    for (const key of requested) {
      if (this.values.has(key)) result[key] = clone(this.values.get(key));
    }
    await this.hooks.afterGet?.(result, keys, this);
    return result;
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    const copied = clone(items);
    this.operations.push({ method: 'set', at: Date.now(), items: copied });
    await this.hooks.beforeSet?.(copied, this);
    this.seed(copied);
    await this.hooks.afterSet?.(copied, this);
  }

  public async remove(keys: string | string[]): Promise<void> {
    const copied = clone(keys);
    this.operations.push({ method: 'remove', at: Date.now(), keys: copied });
    await this.hooks.beforeRemove?.(copied, this);
    for (const key of typeof copied === 'string' ? [copied] : copied) this.values.delete(key);
    await this.hooks.afterRemove?.(copied, this);
  }

  public async getBytesInUse(keys: StorageKeys = null): Promise<number> {
    this.operations.push({ method: 'getBytesInUse', at: Date.now(), keys: loggedKeys(keys) });
    return estimateStorageBytes(await this.get(keys));
  }

  public async setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> {
    this.operations.push({ method: 'setAccessLevel', at: Date.now() });
    this.accessLevels.push(clone(options));
  }

  /** Bypass hooks and operation logging for arranging or corrupting stored state. */
  public seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) this.values.set(key, clone(value));
  }

  /** Bypass hooks and operation logging for arranging missing-data scenarios. */
  public deleteDirect(keys: string | string[]): void {
    for (const key of typeof keys === 'string' ? [keys] : keys) this.values.delete(key);
  }

  public snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.values].map(([key, value]) => [key, clone(value)]));
  }

  public clearOperations(): void {
    this.operations.length = 0;
  }
}
