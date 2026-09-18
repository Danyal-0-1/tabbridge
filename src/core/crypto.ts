import { compress, decompress } from './compression.ts';
import {
  asArrayBuffer,
  base64ToBytes,
  bytesToBase64,
  decodeUtf8,
  timingSafeEqual,
  utf8,
} from './encoding.ts';
import { TabBridgeError } from './errors.ts';
import { newId } from './ids.ts';
import { migrateSnapshot } from './migrations.ts';
import { parseExportJson, validateExportFile, validateSnapshot } from './schema.ts';
import {
  ENCRYPTION_FORMAT_VERSION,
  FILE_FORMAT_VERSION,
  SCHEMA_VERSION,
  type AuthenticatedMetadata,
  type EncryptedSnapshot,
  type ExportFile,
  type KdfParameters,
  type Snapshot,
  type VaultConfig,
} from './types.ts';

export const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const VERIFIER_TEXT = 'TabBridge vault verifier v1';

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new TabBridgeError('BROWSER_ERROR', 'Web Crypto is unavailable in this browser context.');
  }
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  return requireCrypto().getRandomValues(new Uint8Array(length));
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 12) {
    throw new TabBridgeError('VALIDATION_ERROR', 'Use a passphrase with at least 12 characters.');
  }
  if (passphrase.length > 1_024) {
    throw new TabBridgeError(
      'VALIDATION_ERROR',
      'The passphrase exceeds the 1,024-character limit.',
    );
  }
}

export async function deriveVaultKey(
  passphrase: string,
  parameters: KdfParameters,
): Promise<CryptoKey> {
  validatePassphrase(passphrase);
  const crypto = requireCrypto();
  const material = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(utf8(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: parameters.hash,
      salt: asArrayBuffer(base64ToBytes(parameters.salt)),
      iterations: parameters.iterations,
    },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportRawKey(key: CryptoKey): Promise<string> {
  const raw = await requireCrypto().subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
}

export async function importRawKey(value: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.byteLength !== 32) {
    throw new TabBridgeError('CORRUPT_DATA', 'Session key material has an invalid length.');
  }
  return requireCrypto().subtle.importKey(
    'raw',
    asArrayBuffer(bytes),
    { name: 'AES-GCM', length: KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

function metadata(snapshotId: string, generationId: string): AuthenticatedMetadata {
  return {
    format: 'tabbridge-snapshot',
    encryptionVersion: ENCRYPTION_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    generationId,
  };
}

function aad(snapshotId: string, generationId: string): Uint8Array {
  const value = metadata(snapshotId, generationId);
  return utf8(
    `${value.format}|encryption=${value.encryptionVersion}|schema=${value.schemaVersion}|snapshot=${value.snapshotId}|generation=${value.generationId}|compression=gzip|cipher=AES-256-GCM`,
  );
}

function verifierAad(vaultId: string): Uint8Array {
  return utf8(`tabbridge-vault|format=1|vault=${vaultId}|cipher=AES-256-GCM`);
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const result = await requireCrypto().subtle.digest('SHA-256', asArrayBuffer(value));
  return new Uint8Array(result);
}

async function aesEncrypt(
  plaintext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  const encrypted = await requireCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(additionalData),
      tagLength: 128,
    },
    key,
    asArrayBuffer(plaintext),
  );
  return new Uint8Array(encrypted);
}

async function aesDecrypt(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  try {
    const decrypted = await requireCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asArrayBuffer(iv),
        additionalData: asArrayBuffer(additionalData),
        tagLength: 128,
      },
      key,
      asArrayBuffer(ciphertext),
    );
    return new Uint8Array(decrypted);
  } catch (error) {
    throw new TabBridgeError(
      'CORRUPT_DATA',
      'Decryption failed. The passphrase may be wrong, or the data was modified.',
      { cause: error },
    );
  }
}

export async function createVault(
  passphrase: string,
): Promise<{ config: VaultConfig; key: CryptoKey }> {
  validatePassphrase(passphrase);
  const vaultId = newId();
  const parameters: KdfParameters = {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(randomBytes(SALT_BYTES)),
  };
  const key = await deriveVaultKey(passphrase, parameters);
  const iv = randomBytes(IV_BYTES);
  const encrypted = await aesEncrypt(
    utf8(`${VERIFIER_TEXT}:${vaultId}`),
    key,
    iv,
    verifierAad(vaultId),
  );
  return {
    config: {
      formatVersion: 1,
      vaultId,
      kdf: parameters,
      verifier: { iv: bytesToBase64(iv), ciphertext: bytesToBase64(encrypted) },
      createdAt: new Date().toISOString(),
    },
    key,
  };
}

export async function unlockVault(passphrase: string, config: VaultConfig): Promise<CryptoKey> {
  const key = await deriveVaultKey(passphrase, config.kdf);
  let plaintext: Uint8Array;
  try {
    plaintext = await aesDecrypt(
      base64ToBytes(config.verifier.ciphertext),
      key,
      base64ToBytes(config.verifier.iv),
      verifierAad(config.vaultId),
    );
  } catch (error) {
    throw new TabBridgeError('WRONG_PASSPHRASE', 'The passphrase is incorrect.', { cause: error });
  }
  if (decodeUtf8(plaintext) !== `${VERIFIER_TEXT}:${config.vaultId}`) {
    throw new TabBridgeError('WRONG_PASSPHRASE', 'The passphrase is incorrect.');
  }
  return key;
}

export async function encryptSnapshot(
  value: Snapshot,
  key: CryptoKey,
  vaultId: string,
): Promise<EncryptedSnapshot> {
  const snapshot = validateSnapshot(value);
  const compressed = await compress(utf8(JSON.stringify(snapshot)));
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await aesEncrypt(
    compressed,
    key,
    iv,
    aad(snapshot.snapshotId, snapshot.generationId),
  );
  return {
    format: 'tabbridge-encrypted',
    encryptionVersion: ENCRYPTION_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId,
    generationId: snapshot.generationId,
    vaultId,
    compression: 'gzip',
    cipher: { name: 'AES-GCM', keyLength: 256, iv: bytesToBase64(iv) },
    ciphertext: bytesToBase64(ciphertext),
    digest: bytesToBase64(await sha256(ciphertext)),
  };
}

export async function decryptSnapshot(
  encrypted: EncryptedSnapshot,
  key: CryptoKey,
): Promise<Snapshot> {
  const ciphertext = base64ToBytes(encrypted.ciphertext);
  const actualDigest = await sha256(ciphertext);
  const expectedDigest = base64ToBytes(encrypted.digest);
  if (!timingSafeEqual(actualDigest, expectedDigest)) {
    throw new TabBridgeError('CORRUPT_DATA', 'The encrypted snapshot failed its integrity check.');
  }
  const compressed = await aesDecrypt(
    ciphertext,
    key,
    base64ToBytes(encrypted.cipher.iv),
    aad(encrypted.snapshotId, encrypted.generationId),
  );
  const plaintext = decodeUtf8(await decompress(compressed));
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch (error) {
    throw new TabBridgeError('CORRUPT_DATA', 'The decrypted snapshot is not valid JSON.', {
      cause: error,
    });
  }
  const snapshot = migrateSnapshot(parsed);
  if (
    snapshot.snapshotId !== encrypted.snapshotId ||
    snapshot.generationId !== encrypted.generationId
  ) {
    throw new TabBridgeError('CORRUPT_DATA', 'Encrypted metadata does not match the snapshot.');
  }
  return snapshot;
}

export async function createExportFile(
  snapshot: Snapshot,
  passphrase: string,
): Promise<ExportFile> {
  validatePassphrase(passphrase);
  const parameters: KdfParameters = {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(randomBytes(SALT_BYTES)),
  };
  const key = await deriveVaultKey(passphrase, parameters);
  const compressed = await compress(utf8(JSON.stringify(validateSnapshot(snapshot))));
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await aesEncrypt(
    compressed,
    key,
    iv,
    aad(snapshot.snapshotId, snapshot.generationId),
  );
  return {
    fileFormat: 'tabbridge',
    formatVersion: FILE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId,
    generationId: snapshot.generationId,
    compression: 'gzip',
    kdf: parameters,
    cipher: { name: 'AES-GCM', keyLength: 256, iv: bytesToBase64(iv) },
    ciphertext: bytesToBase64(ciphertext),
    digest: bytesToBase64(await sha256(ciphertext)),
  };
}

export async function readExportFile(
  value: string | ExportFile,
  passphrase: string,
): Promise<Snapshot> {
  const file = typeof value === 'string' ? parseExportJson(value) : validateExportFile(value);
  const ciphertext = base64ToBytes(file.ciphertext);
  if (!timingSafeEqual(await sha256(ciphertext), base64ToBytes(file.digest))) {
    throw new TabBridgeError('CORRUPT_DATA', 'The import file was modified or is corrupt.');
  }
  const key = await deriveVaultKey(passphrase, file.kdf);
  let compressed: Uint8Array;
  try {
    compressed = await aesDecrypt(
      ciphertext,
      key,
      base64ToBytes(file.cipher.iv),
      aad(file.snapshotId, file.generationId),
    );
  } catch (error) {
    throw new TabBridgeError(
      'WRONG_PASSPHRASE',
      'The passphrase is incorrect, or the import file was modified.',
      { cause: error },
    );
  }
  const plaintext = decodeUtf8(await decompress(compressed));
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch (error) {
    throw new TabBridgeError('CORRUPT_DATA', 'The decrypted import is not valid JSON.', {
      cause: error,
    });
  }
  const snapshot = migrateSnapshot(parsed);
  if (snapshot.snapshotId !== file.snapshotId || snapshot.generationId !== file.generationId) {
    throw new TabBridgeError(
      'CORRUPT_DATA',
      'Import metadata does not match its encrypted payload.',
    );
  }
  return snapshot;
}

export function regenerateSnapshot(snapshot: Snapshot): Snapshot {
  return validateSnapshot({
    ...snapshot,
    snapshotId: newId(),
    generationId: newId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
