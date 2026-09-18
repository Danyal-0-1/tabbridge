import { TabBridgeError } from './errors.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newId(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new TabBridgeError('BROWSER_ERROR', 'Secure random UUID generation is unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
