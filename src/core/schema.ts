import { TabBridgeError } from './errors.ts';
import { isUuid } from './ids.ts';
import { base64ToBytes, bytesToBase64 } from './encoding.ts';
import {
  ENCRYPTION_FORMAT_VERSION,
  FILE_FORMAT_VERSION,
  SCHEMA_VERSION,
  type BrowserFamily,
  type CaptureWarning,
  type CipherParameters,
  type ExportFile,
  type GroupColor,
  type KdfParameters,
  type RecordManifest,
  type SavedGroup,
  type SavedTab,
  type SavedWindow,
  type Snapshot,
  type Tombstone,
  type VaultConfig,
} from './types.ts';

export const LIMITS = {
  importBytes: 25 * 1024 * 1024,
  decompressedBytes: 32 * 1024 * 1024,
  nestingDepth: 20,
  windows: 50,
  tabsPerWindow: 1_000,
  tabsTotal: 5_000,
  groupsPerWindow: 250,
  groupsTotal: 500,
  nameLength: 200,
  titleLength: 2_000,
  urlLength: 16_384,
  deviceLabelLength: 120,
  warningLength: 500,
  ciphertextLength: 35 * 1024 * 1024,
  chunks: 512,
} as const;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GROUP_COLORS = new Set<GroupColor>([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);
const BROWSERS = new Set<BrowserFamily>(['chrome', 'firefox', 'chromium', 'unknown']);

function fail(message: string): never {
  throw new TabBridgeError('VALIDATION_ERROR', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertSafeJsonValue(value: unknown, depth = 0): void {
  if (depth > LIMITS.nestingDepth) fail('The data exceeds the maximum nesting depth.');
  if (typeof value === 'string' && value.length > LIMITS.ciphertextLength) {
    fail('A string in the data exceeds the maximum length.');
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.tabsTotal * 2) fail('An array in the data is too large.');
    for (const item of value) assertSafeJsonValue(item, depth + 1);
    return;
  }
  if (!isPlainObject(value)) fail('Only plain JSON objects are accepted.');
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) fail(`Unsafe property name rejected: ${key}.`);
    assertSafeJsonValue(child, depth + 1);
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${path} must be an object.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not recognized.`);
  }
}

function stringValue(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > max
  ) {
    fail(
      `${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${max} characters.`,
    );
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean.`);
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${path} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function uuid(value: unknown, path: string): string {
  const result = stringValue(value, path, 64);
  if (!isUuid(result)) fail(`${path} must be a UUID.`);
  return result;
}

function isoDate(value: unknown, path: string): string {
  const result = stringValue(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || Number.isNaN(Date.parse(result))) {
    fail(`${path} must be an ISO 8601 date.`);
  }
  return result;
}

function optionalString(value: unknown, path: string, max: number): string | undefined {
  return value === undefined ? undefined : stringValue(value, path, max, true);
}

function base64Value(
  value: unknown,
  path: string,
  options: { exactBytes?: number; minimumBytes?: number; maximumCharacters?: number } = {},
): string {
  const encoded = stringValue(value, path, options.maximumCharacters ?? LIMITS.ciphertextLength);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(encoded);
  } catch (error) {
    throw new TabBridgeError('VALIDATION_ERROR', `${path} must be canonical base64.`, {
      cause: error,
    });
  }
  if (bytesToBase64(bytes) !== encoded) fail(`${path} must use canonical base64 encoding.`);
  if (options.exactBytes !== undefined && bytes.byteLength !== options.exactBytes) {
    fail(`${path} must decode to exactly ${options.exactBytes} bytes.`);
  }
  if (options.minimumBytes !== undefined && bytes.byteLength < options.minimumBytes) {
    fail(`${path} is shorter than the authenticated-encryption tag.`);
  }
  return encoded;
}

function parseKdf(value: unknown, path: string): KdfParameters {
  const data = object(value, path);
  exactKeys(data, ['name', 'hash', 'iterations', 'salt'], [], path);
  if (data.name !== 'PBKDF2' || data.hash !== 'SHA-256') fail(`${path} uses an unsupported KDF.`);
  const iterations = integer(data.iterations, `${path}.iterations`, 600_000, 2_000_000);
  const salt = base64Value(data.salt, `${path}.salt`, { exactBytes: 16, maximumCharacters: 64 });
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt };
}

function parseCipher(value: unknown, path: string): CipherParameters {
  const data = object(value, path);
  exactKeys(data, ['name', 'keyLength', 'iv'], [], path);
  if (data.name !== 'AES-GCM' || data.keyLength !== 256)
    fail(`${path} uses an unsupported cipher.`);
  return {
    name: 'AES-GCM',
    keyLength: 256,
    iv: base64Value(data.iv, `${path}.iv`, { exactBytes: 12, maximumCharacters: 32 }),
  };
}

function parseGroup(value: unknown, path: string): SavedGroup {
  const data = object(value, path);
  exactKeys(data, ['id', 'title', 'color', 'collapsed', 'order'], [], path);
  if (typeof data.color !== 'string' || !GROUP_COLORS.has(data.color as GroupColor)) {
    fail(`${path}.color is not supported.`);
  }
  return {
    id: uuid(data.id, `${path}.id`),
    title: stringValue(data.title, `${path}.title`, LIMITS.titleLength, true),
    color: data.color as GroupColor,
    collapsed: booleanValue(data.collapsed, `${path}.collapsed`),
    order: integer(data.order, `${path}.order`, 0, LIMITS.groupsPerWindow - 1),
  };
}

function parseTab(value: unknown, path: string): SavedTab {
  const data = object(value, path);
  exactKeys(data, ['id', 'url', 'title', 'index', 'pinned', 'active'], ['groupId'], path);
  const groupId = data.groupId === undefined ? undefined : uuid(data.groupId, `${path}.groupId`);
  return {
    id: uuid(data.id, `${path}.id`),
    url: stringValue(data.url, `${path}.url`, LIMITS.urlLength),
    title: stringValue(data.title, `${path}.title`, LIMITS.titleLength, true),
    index: integer(data.index, `${path}.index`, 0, LIMITS.tabsPerWindow - 1),
    pinned: booleanValue(data.pinned, `${path}.pinned`),
    active: booleanValue(data.active, `${path}.active`),
    ...(groupId === undefined ? {} : { groupId }),
  };
}

function parseWindow(value: unknown, path: string): SavedWindow {
  const data = object(value, path);
  exactKeys(data, ['id', 'order', 'groups', 'tabs'], ['state', 'activeTabId'], path);
  if (!Array.isArray(data.groups) || data.groups.length > LIMITS.groupsPerWindow) {
    fail(`${path}.groups exceeds the group limit.`);
  }
  if (!Array.isArray(data.tabs) || data.tabs.length > LIMITS.tabsPerWindow) {
    fail(`${path}.tabs exceeds the tab limit.`);
  }
  const groups = data.groups.map((item, index) => parseGroup(item, `${path}.groups[${index}]`));
  const tabs = data.tabs.map((item, index) => parseTab(item, `${path}.tabs[${index}]`));
  const groupIds = new Set(groups.map((group) => group.id));
  if (groupIds.size !== groups.length) fail(`${path}.groups contains duplicate IDs.`);
  if (new Set(groups.map((group) => group.order)).size !== groups.length) {
    fail(`${path}.groups contains duplicate order values.`);
  }
  const tabIds = new Set(tabs.map((tab) => tab.id));
  if (tabIds.size !== tabs.length) fail(`${path}.tabs contains duplicate IDs.`);
  if (new Set(tabs.map((tab) => tab.index)).size !== tabs.length) {
    fail(`${path}.tabs contains duplicate index values.`);
  }
  for (const tab of tabs) {
    if (tab.groupId && !groupIds.has(tab.groupId))
      fail(`${path} contains an unknown tab group reference.`);
  }
  const activeTabId =
    data.activeTabId === undefined ? undefined : uuid(data.activeTabId, `${path}.activeTabId`);
  if (activeTabId && !tabIds.has(activeTabId))
    fail(`${path}.activeTabId does not reference a tab.`);
  const activeTabs = tabs.filter((tab) => tab.active);
  if (tabs.length > 0 && activeTabs.length !== 1) fail(`${path} must have exactly one active tab.`);
  if (activeTabId !== activeTabs[0]?.id) {
    fail(`${path}.activeTabId must match the tab marked active.`);
  }

  const allowedStates = new Set(['normal', 'minimized', 'maximized', 'fullscreen']);
  const stateValue = data.state;
  if (
    stateValue !== undefined &&
    (typeof stateValue !== 'string' || !allowedStates.has(stateValue))
  ) {
    fail(`${path}.state is not supported.`);
  }
  const state = stateValue as NonNullable<SavedWindow['state']> | undefined;

  return {
    id: uuid(data.id, `${path}.id`),
    order: integer(data.order, `${path}.order`, 0, LIMITS.windows - 1),
    ...(state === undefined ? {} : { state }),
    ...(activeTabId === undefined ? {} : { activeTabId }),
    groups,
    tabs,
  };
}

function parseWarning(value: unknown, path: string): CaptureWarning {
  const data = object(value, path);
  exactKeys(data, ['code', 'message', 'count'], [], path);
  const codes = new Set<CaptureWarning['code']>([
    'unsupported-url',
    'private-window',
    'missing-url',
    'group-unavailable',
  ]);
  if (typeof data.code !== 'string' || !codes.has(data.code as CaptureWarning['code'])) {
    fail(`${path}.code is not supported.`);
  }
  return {
    code: data.code as CaptureWarning['code'],
    message: stringValue(data.message, `${path}.message`, LIMITS.warningLength),
    count: integer(data.count, `${path}.count`, 1, LIMITS.tabsTotal),
  };
}

export function validateSnapshot(value: unknown): Snapshot {
  assertSafeJsonValue(value);
  const data = object(value, 'snapshot');
  exactKeys(
    data,
    [
      'schemaVersion',
      'snapshotId',
      'generationId',
      'name',
      'createdAt',
      'updatedAt',
      'sourceDevice',
      'windows',
      'captureWarnings',
    ],
    [],
    'snapshot',
  );
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new TabBridgeError(
      'UNSUPPORTED_VERSION',
      `Snapshot schema version ${String(data.schemaVersion)} is not supported.`,
    );
  }
  if (!Array.isArray(data.windows) || data.windows.length > LIMITS.windows) {
    fail('snapshot.windows exceeds the window limit.');
  }
  if (!Array.isArray(data.captureWarnings) || data.captureWarnings.length > 100) {
    fail('snapshot.captureWarnings exceeds the warning limit.');
  }
  const source = object(data.sourceDevice, 'snapshot.sourceDevice');
  exactKeys(
    source,
    ['id', 'label', 'browser'],
    ['browserVersion', 'operatingSystem'],
    'snapshot.sourceDevice',
  );
  if (typeof source.browser !== 'string' || !BROWSERS.has(source.browser as BrowserFamily)) {
    fail('snapshot.sourceDevice.browser is not supported.');
  }
  const windows = data.windows.map((item, index) =>
    parseWindow(item, `snapshot.windows[${index}]`),
  );
  const totalTabs = windows.reduce((sum, window) => sum + window.tabs.length, 0);
  const totalGroups = windows.reduce((sum, window) => sum + window.groups.length, 0);
  if (totalTabs > LIMITS.tabsTotal) fail('The snapshot exceeds the total tab limit.');
  if (totalGroups > LIMITS.groupsTotal) fail('The snapshot exceeds the total group limit.');
  const windowIds = new Set(windows.map((window) => window.id));
  if (windowIds.size !== windows.length) fail('snapshot.windows contains duplicate IDs.');
  if (new Set(windows.map((window) => window.order)).size !== windows.length) {
    fail('snapshot.windows contains duplicate order values.');
  }
  const allTabIds = windows.flatMap((window) => window.tabs.map((tab) => tab.id));
  if (new Set(allTabIds).size !== allTabIds.length) {
    fail('snapshot.windows contains duplicate tab IDs.');
  }
  const allGroupIds = windows.flatMap((window) => window.groups.map((group) => group.id));
  if (new Set(allGroupIds).size !== allGroupIds.length) {
    fail('snapshot.windows contains duplicate group IDs.');
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: uuid(data.snapshotId, 'snapshot.snapshotId'),
    generationId: uuid(data.generationId, 'snapshot.generationId'),
    name: stringValue(data.name, 'snapshot.name', LIMITS.nameLength),
    createdAt: isoDate(data.createdAt, 'snapshot.createdAt'),
    updatedAt: isoDate(data.updatedAt, 'snapshot.updatedAt'),
    sourceDevice: {
      id: uuid(source.id, 'snapshot.sourceDevice.id'),
      label: stringValue(source.label, 'snapshot.sourceDevice.label', LIMITS.deviceLabelLength),
      browser: source.browser as BrowserFamily,
      ...(source.browserVersion === undefined
        ? {}
        : {
            browserVersion: optionalString(
              source.browserVersion,
              'snapshot.sourceDevice.browserVersion',
              80,
            ) as string,
          }),
      ...(source.operatingSystem === undefined
        ? {}
        : {
            operatingSystem: optionalString(
              source.operatingSystem,
              'snapshot.sourceDevice.operatingSystem',
              80,
            ) as string,
          }),
    },
    windows,
    captureWarnings: data.captureWarnings.map((item, index) =>
      parseWarning(item, `snapshot.captureWarnings[${index}]`),
    ),
  };
}

export function parseSnapshotJson(text: string): Snapshot {
  if (new TextEncoder().encode(text).byteLength > LIMITS.importBytes) {
    throw new TabBridgeError('INVALID_IMPORT', 'The imported snapshot exceeds the 25 MiB limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TabBridgeError('INVALID_IMPORT', 'The imported data is not valid JSON.', {
      cause: error,
    });
  }
  return validateSnapshot(value);
}

export function validateExportFile(value: unknown): ExportFile {
  assertSafeJsonValue(value);
  const data = object(value, 'file');
  exactKeys(
    data,
    [
      'fileFormat',
      'formatVersion',
      'schemaVersion',
      'snapshotId',
      'generationId',
      'compression',
      'kdf',
      'cipher',
      'ciphertext',
      'digest',
    ],
    [],
    'file',
  );
  if (data.fileFormat !== 'tabbridge' || data.formatVersion !== FILE_FORMAT_VERSION) {
    throw new TabBridgeError('UNSUPPORTED_VERSION', 'This TabBridge file format is not supported.');
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new TabBridgeError(
      'UNSUPPORTED_VERSION',
      'This snapshot schema version is not supported.',
    );
  }
  if (data.compression !== 'gzip') fail('file.compression is not supported.');
  return {
    fileFormat: 'tabbridge',
    formatVersion: FILE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    snapshotId: uuid(data.snapshotId, 'file.snapshotId'),
    generationId: uuid(data.generationId, 'file.generationId'),
    compression: 'gzip',
    kdf: parseKdf(data.kdf, 'file.kdf'),
    cipher: parseCipher(data.cipher, 'file.cipher'),
    ciphertext: base64Value(data.ciphertext, 'file.ciphertext', {
      minimumBytes: 16,
      maximumCharacters: LIMITS.ciphertextLength,
    }),
    digest: base64Value(data.digest, 'file.digest', { exactBytes: 32, maximumCharacters: 64 }),
  };
}

export function parseExportJson(text: string): ExportFile {
  if (new TextEncoder().encode(text).byteLength > LIMITS.importBytes) {
    throw new TabBridgeError('INVALID_IMPORT', 'The import file exceeds the 25 MiB limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TabBridgeError('INVALID_IMPORT', 'The import file is not valid JSON.', {
      cause: error,
    });
  }
  return validateExportFile(parsed);
}

export function validateVaultConfig(value: unknown): VaultConfig {
  assertSafeJsonValue(value);
  const data = object(value, 'vault');
  exactKeys(data, ['formatVersion', 'vaultId', 'kdf', 'verifier', 'createdAt'], [], 'vault');
  if (data.formatVersion !== 1) {
    throw new TabBridgeError('UNSUPPORTED_VERSION', 'This vault format is not supported.');
  }
  const verifier = object(data.verifier, 'vault.verifier');
  exactKeys(verifier, ['iv', 'ciphertext'], [], 'vault.verifier');
  return {
    formatVersion: 1,
    vaultId: uuid(data.vaultId, 'vault.vaultId'),
    kdf: parseKdf(data.kdf, 'vault.kdf'),
    verifier: {
      iv: base64Value(verifier.iv, 'vault.verifier.iv', {
        exactBytes: 12,
        maximumCharacters: 32,
      }),
      ciphertext: base64Value(verifier.ciphertext, 'vault.verifier.ciphertext', {
        minimumBytes: 16,
        maximumCharacters: 512,
      }),
    },
    createdAt: isoDate(data.createdAt, 'vault.createdAt'),
  };
}

export function validateRecordManifest(value: unknown): RecordManifest {
  assertSafeJsonValue(value);
  const data = object(value, 'manifest');
  exactKeys(
    data,
    [
      'kind',
      'formatVersion',
      'snapshotId',
      'generationId',
      'vaultId',
      'schemaVersion',
      'encryptionVersion',
      'compression',
      'cipher',
      'chunkCount',
      'ciphertextLength',
      'digest',
      'committedAt',
    ],
    [],
    'manifest',
  );
  if (
    data.kind !== 'tabbridge-record-manifest' ||
    data.formatVersion !== 1 ||
    data.schemaVersion !== SCHEMA_VERSION ||
    data.encryptionVersion !== ENCRYPTION_FORMAT_VERSION ||
    data.compression !== 'gzip'
  ) {
    throw new TabBridgeError('UNSUPPORTED_VERSION', 'The stored record format is not supported.');
  }
  return {
    kind: 'tabbridge-record-manifest',
    formatVersion: 1,
    snapshotId: uuid(data.snapshotId, 'manifest.snapshotId'),
    generationId: uuid(data.generationId, 'manifest.generationId'),
    vaultId: uuid(data.vaultId, 'manifest.vaultId'),
    schemaVersion: SCHEMA_VERSION,
    encryptionVersion: ENCRYPTION_FORMAT_VERSION,
    compression: 'gzip',
    cipher: parseCipher(data.cipher, 'manifest.cipher'),
    chunkCount: integer(data.chunkCount, 'manifest.chunkCount', 1, LIMITS.chunks),
    ciphertextLength: integer(
      data.ciphertextLength,
      'manifest.ciphertextLength',
      1,
      LIMITS.ciphertextLength,
    ),
    digest: base64Value(data.digest, 'manifest.digest', {
      exactBytes: 32,
      maximumCharacters: 64,
    }),
    committedAt: isoDate(data.committedAt, 'manifest.committedAt'),
  };
}

export function validateTombstone(value: unknown): Tombstone {
  assertSafeJsonValue(value);
  const data = object(value, 'tombstone');
  exactKeys(data, ['kind', 'snapshotId', 'deletedAt'], [], 'tombstone');
  if (data.kind !== 'tabbridge-tombstone') fail('tombstone.kind is invalid.');
  return {
    kind: 'tabbridge-tombstone',
    snapshotId: uuid(data.snapshotId, 'tombstone.snapshotId'),
    deletedAt: isoDate(data.deletedAt, 'tombstone.deletedAt'),
  };
}
