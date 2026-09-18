import { TabBridgeError } from './errors.ts';
import { SCHEMA_VERSION, type Snapshot } from './types.ts';
import { validateSnapshot } from './schema.ts';

export function migrateSnapshot(value: unknown): Snapshot {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'schemaVersion')) {
    throw new TabBridgeError('VALIDATION_ERROR', 'The snapshot schema version is missing.');
  }
  const version = (value as { schemaVersion: unknown }).schemaVersion;
  if (version === SCHEMA_VERSION) return validateSnapshot(value);
  throw new TabBridgeError(
    'UNSUPPORTED_VERSION',
    `Snapshot schema version ${String(version)} is not supported. Upgrade TabBridge before importing it.`,
  );
}
