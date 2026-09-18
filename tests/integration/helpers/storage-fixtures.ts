import { createHash } from 'node:crypto';

import type { EncryptedSnapshot, Tombstone, VaultConfig } from '../../../src/core/types.ts';

export const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_SNAPSHOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const GENERATION_ONE = '22222222-2222-4222-8222-222222222222';
export const GENERATION_TWO = '33333333-3333-4333-8333-333333333333';
export const VAULT_ID = '44444444-4444-4444-8444-444444444444';

function digestFor(ciphertext: string): string {
  return createHash('sha256').update(Buffer.from(ciphertext, 'base64')).digest('base64');
}

export function encryptedSnapshot(
  ciphertext: string,
  overrides: Partial<EncryptedSnapshot> = {},
): EncryptedSnapshot {
  return {
    format: 'tabbridge-encrypted',
    encryptionVersion: 1,
    schemaVersion: 1,
    snapshotId: SNAPSHOT_ID,
    generationId: GENERATION_ONE,
    vaultId: VAULT_ID,
    compression: 'gzip',
    cipher: { name: 'AES-GCM', keyLength: 256, iv: 'AAAAAAAAAAAAAAAA' },
    ciphertext,
    digest: digestFor(ciphertext),
    ...overrides,
  };
}

export function tombstone(snapshotId = SNAPSHOT_ID): Tombstone {
  return {
    kind: 'tabbridge-tombstone',
    snapshotId,
    deletedAt: '2026-01-02T03:04:05.000Z',
  };
}

export function vaultConfig(vaultId = VAULT_ID): VaultConfig {
  return {
    formatVersion: 1,
    vaultId,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 600_000,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
    verifier: {
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
    createdAt: '2026-01-02T03:04:05.000Z',
  };
}
