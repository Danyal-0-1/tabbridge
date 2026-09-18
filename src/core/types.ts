export const SCHEMA_VERSION = 1 as const;
export const ENCRYPTION_FORMAT_VERSION = 1 as const;
export const FILE_FORMAT_VERSION = 1 as const;

export type BrowserFamily = 'chrome' | 'firefox' | 'chromium' | 'unknown';
export type StorageLocation = 'local' | 'synced';
export type GroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export interface SourceDevice {
  id: string;
  label: string;
  browser: BrowserFamily;
  browserVersion?: string;
  operatingSystem?: string;
}

export interface CaptureWarning {
  code: 'unsupported-url' | 'private-window' | 'missing-url' | 'group-unavailable';
  message: string;
  count: number;
}

export interface SavedGroup {
  id: string;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  order: number;
}

export interface SavedTab {
  id: string;
  url: string;
  title: string;
  index: number;
  pinned: boolean;
  active: boolean;
  groupId?: string;
}

export interface SavedWindow {
  id: string;
  order: number;
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  activeTabId?: string;
  groups: SavedGroup[];
  tabs: SavedTab[];
}

export interface Snapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  generationId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceDevice: SourceDevice;
  windows: SavedWindow[];
  captureWarnings: CaptureWarning[];
}

export interface SnapshotSummary {
  snapshotId: string;
  generationId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sourceDevice: SourceDevice;
  windowCount: number;
  tabCount: number;
  groupCount: number;
  location: StorageLocation;
  locked: boolean;
}

export interface KdfParameters {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: string;
}

export interface CipherParameters {
  name: 'AES-GCM';
  keyLength: 256;
  iv: string;
}

export interface AuthenticatedMetadata {
  format: 'tabbridge-snapshot';
  encryptionVersion: typeof ENCRYPTION_FORMAT_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  generationId: string;
}

export interface EncryptedSnapshot {
  format: 'tabbridge-encrypted';
  encryptionVersion: typeof ENCRYPTION_FORMAT_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  generationId: string;
  vaultId: string;
  compression: 'gzip';
  cipher: CipherParameters;
  ciphertext: string;
  digest: string;
}

export interface ExportFile {
  fileFormat: 'tabbridge';
  formatVersion: typeof FILE_FORMAT_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  generationId: string;
  compression: 'gzip';
  kdf: KdfParameters;
  cipher: CipherParameters;
  ciphertext: string;
  digest: string;
}

export interface VaultConfig {
  formatVersion: 1;
  vaultId: string;
  kdf: KdfParameters;
  verifier: {
    iv: string;
    ciphertext: string;
  };
  createdAt: string;
}

export interface TabBridgeSettings {
  deviceId: string;
  deviceLabel: string;
  browserFamily: BrowserFamily;
  browserVersion?: string;
  operatingSystem?: string;
  syncEnabled: boolean;
  discardBackgroundTabs: boolean;
  firstRunComplete: boolean;
}

export interface RestoreSelection {
  windowIds?: string[];
  groupIds?: string[];
  tabIds?: string[];
}

export interface RestoreProgress {
  operationId: string;
  phase: 'validating' | 'windows' | 'tabs' | 'groups' | 'finalizing';
  completed: number;
  total: number;
  message: string;
}

export interface RestoreFailure {
  operation: string;
  itemId?: string;
  reason: string;
}

export interface RestoreReport {
  operationId: string;
  stopped: boolean;
  windowsRestored: number;
  tabsRestored: number;
  groupsRestored: number;
  skippedUrls: Array<{ url: string; reason: string }>;
  differences: string[];
  failures: RestoreFailure[];
}

export interface PlannedGroup extends SavedGroup {
  tabIds: string[];
}

export interface PlannedWindow {
  sourceWindowId: string;
  state?: SavedWindow['state'];
  activeTabId?: string;
  tabs: SavedTab[];
  groups: PlannedGroup[];
}

export interface RestorePlan {
  snapshotId: string;
  windows: PlannedWindow[];
  tabCount: number;
  groupCount: number;
  skippedUrls: Array<{ url: string; reason: string }>;
}

export interface RecordManifest {
  kind: 'tabbridge-record-manifest';
  formatVersion: 1;
  snapshotId: string;
  generationId: string;
  vaultId: string;
  schemaVersion: typeof SCHEMA_VERSION;
  encryptionVersion: typeof ENCRYPTION_FORMAT_VERSION;
  compression: 'gzip';
  cipher: CipherParameters;
  chunkCount: number;
  ciphertextLength: number;
  digest: string;
  committedAt: string;
}

export interface Tombstone {
  kind: 'tabbridge-tombstone';
  snapshotId: string;
  deletedAt: string;
}

export interface SyncQuota {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  itemCount: number;
  maxItems: number;
}
