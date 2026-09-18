export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

export function estimateStorageBytes(items: Record<string, unknown>): number {
  const encoder = new TextEncoder();
  return Object.entries(items).reduce(
    (total, [key, value]) =>
      total + encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength,
    0,
  );
}
