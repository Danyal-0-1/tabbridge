import type { CaptureScope } from './capture.ts';
import type {
  RestoreReport,
  RestoreSelection,
  Snapshot,
  SnapshotSummary,
  SyncQuota,
  TabBridgeSettings,
} from './types.ts';

export type Request =
  | { type: 'GET_STATUS' }
  | { type: 'SETUP_VAULT'; passphrase: string; deviceLabel: string }
  | { type: 'UNLOCK'; passphrase: string }
  | { type: 'JOIN_SYNC'; passphrase: string; consentGranted: boolean }
  | { type: 'LOCK' }
  | { type: 'CAPTURE'; scope: CaptureScope }
  | { type: 'LIST_SNAPSHOTS' }
  | { type: 'GET_SNAPSHOT'; snapshotId: string }
  | { type: 'RENAME_SNAPSHOT'; snapshotId: string; name: string }
  | { type: 'DELETE_SNAPSHOT'; snapshotId: string }
  | {
      type: 'RESTORE_SNAPSHOT';
      snapshotId: string;
      selection?: RestoreSelection;
      operationId: string;
    }
  | { type: 'STOP_RESTORE'; operationId: string }
  | { type: 'EXPORT_SNAPSHOT'; snapshotId: string; passphrase: string }
  | { type: 'PREVIEW_IMPORT'; contents: string; passphrase: string }
  | { type: 'IMPORT_SNAPSHOT'; contents: string; passphrase: string }
  | { type: 'SET_SYNC_ENABLED'; enabled: boolean; consentGranted: boolean }
  | { type: 'SET_SNAPSHOT_SYNC'; snapshotId: string; synced: boolean }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<TabBridgeSettings> }
  | { type: 'CHANGE_PASSPHRASE'; oldPassphrase: string; newPassphrase: string };

export interface StatusResponse {
  settings: TabBridgeSettings;
  configured: boolean;
  locked: boolean;
  syncedVaultAvailable: boolean;
  lastAction?: string;
  quota?: SyncQuota;
}

export interface ListResponse {
  snapshots: SnapshotSummary[];
  corrupt: Array<{ snapshotId: string; message: string }>;
}

export interface ExportResponse {
  filename: string;
  contents: string;
  mediaType: 'application/vnd.tabbridge+json';
}

export interface ImportResponse {
  snapshot: SnapshotSummary;
  skipped: number;
  importedAsCopy: boolean;
}

export interface ImportPreviewResponse {
  name: string;
  windowCount: number;
  tabCount: number;
  groupCount: number;
  skipped: number;
  importedAsCopy: boolean;
}

export type ResponseData =
  | StatusResponse
  | ListResponse
  | Snapshot
  | SnapshotSummary
  | RestoreReport
  | ExportResponse
  | ImportResponse
  | ImportPreviewResponse
  | TabBridgeSettings
  | { saved: true; skipped: number }
  | { deleted: true }
  | { stopped: true }
  | { synced: boolean }
  | { locked: true }
  | { changed: true }
  | { joined: true };

export type Response =
  { ok: true; data: ResponseData } | { ok: false; error: { code: string; message: string } };

export function requestType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}
