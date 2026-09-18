import { newId } from './ids.ts';
import { validateSnapshot } from './schema.ts';
import { assessUrl } from './url-policy.ts';
import {
  SCHEMA_VERSION,
  type CaptureWarning,
  type GroupColor,
  type SavedGroup,
  type SavedTab,
  type SavedWindow,
  type Snapshot,
  type SourceDevice,
} from './types.ts';

export interface CaptureTab {
  id?: number;
  windowId?: number;
  index: number;
  url?: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  incognito: boolean;
  groupId?: number;
}

export interface CaptureWindow {
  id?: number;
  type?: string;
  incognito: boolean;
  state?: string;
  tabs?: CaptureTab[];
}

export interface CaptureGroup {
  id: number;
  title?: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface CaptureAdapter {
  getAllWindows(): Promise<CaptureWindow[]>;
  getCurrentWindow(): Promise<CaptureWindow>;
  getActiveTab(): Promise<CaptureTab | undefined>;
  getGroups(windowId: number): Promise<CaptureGroup[]>;
  groupsSupported(): boolean;
}

export type CaptureScope = 'current-window' | 'all-windows' | 'current-tab';

function defaultName(now: Date): string {
  return `Workspace — ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now)}`;
}

function incrementWarning(
  warnings: Map<CaptureWarning['code'], CaptureWarning>,
  code: CaptureWarning['code'],
  message: string,
): void {
  const existing = warnings.get(code);
  warnings.set(code, { code, message, count: (existing?.count ?? 0) + 1 });
}

async function captureWindow(
  adapter: CaptureAdapter,
  source: CaptureWindow,
  order: number,
  warnings: Map<CaptureWarning['code'], CaptureWarning>,
): Promise<SavedWindow | undefined> {
  if (source.incognito || (source.type !== undefined && source.type !== 'normal')) {
    incrementWarning(warnings, 'private-window', 'A private or non-normal window was excluded.');
    return undefined;
  }
  let runtimeGroups: CaptureGroup[] = [];
  if (source.id !== undefined && adapter.groupsSupported()) {
    try {
      runtimeGroups = await adapter.getGroups(source.id);
    } catch {
      incrementWarning(
        warnings,
        'group-unavailable',
        'Group metadata was unavailable in this browser.',
      );
    }
  }
  if (!adapter.groupsSupported() && (source.tabs ?? []).some((tab) => (tab.groupId ?? -1) >= 0)) {
    incrementWarning(
      warnings,
      'group-unavailable',
      'Group metadata was unavailable in this browser.',
    );
  }
  const groupMap = new Map<number, string>();
  const groups: SavedGroup[] = runtimeGroups.map((group) => {
    const id = newId();
    groupMap.set(group.id, id);
    return {
      id,
      title: (group.title ?? '').slice(0, 2_000),
      color: group.color,
      collapsed: group.collapsed,
      order: 0,
    };
  });

  const tabs: SavedTab[] = [];
  let activeTabId: string | undefined;
  const sortedTabs = [...(source.tabs ?? [])].sort((left, right) => left.index - right.index);
  for (const tab of sortedTabs) {
    if (tab.incognito) {
      incrementWarning(warnings, 'private-window', 'A private tab was excluded.');
      continue;
    }
    const decision = assessUrl(tab.url);
    if (!decision.allowed || !decision.normalized) {
      incrementWarning(
        warnings,
        tab.url ? 'unsupported-url' : 'missing-url',
        decision.reason ?? 'An unsupported URL was skipped.',
      );
      continue;
    }
    const id = newId();
    const logicalGroupId = tab.groupId === undefined ? undefined : groupMap.get(tab.groupId);
    const saved: SavedTab = {
      id,
      url: decision.normalized,
      title: (tab.title ?? '').slice(0, 2_000),
      index: tabs.length,
      pinned: tab.pinned,
      active: tab.active,
      ...(logicalGroupId === undefined ? {} : { groupId: logicalGroupId }),
    };
    tabs.push(saved);
    if (tab.active) activeTabId = id;
  }

  if (tabs.length === 0) return undefined;
  if (!activeTabId) {
    const firstTab = tabs[0];
    if (firstTab) {
      firstTab.active = true;
      activeTabId = firstTab.id;
    }
  }
  const usedGroupIds = new Set(tabs.flatMap((tab) => (tab.groupId ? [tab.groupId] : [])));
  const orderedGroups = groups
    .filter((group) => usedGroupIds.has(group.id))
    .map((group) => ({
      group,
      firstTabIndex: Math.min(
        ...tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.index),
      ),
    }))
    .sort((left, right) => left.firstTabIndex - right.firstTabIndex)
    .map(({ group }, index) => ({ ...group, order: index }));
  const state = ['normal', 'minimized', 'maximized', 'fullscreen'].includes(source.state ?? '')
    ? (source.state as SavedWindow['state'])
    : undefined;
  return {
    id: newId(),
    order,
    ...(state === undefined ? {} : { state }),
    ...(activeTabId === undefined ? {} : { activeTabId }),
    groups: orderedGroups,
    tabs,
  };
}

export async function captureWorkspace(
  adapter: CaptureAdapter,
  scope: CaptureScope,
  sourceDevice: SourceDevice,
  now = new Date(),
): Promise<Snapshot> {
  let sources: CaptureWindow[];
  if (scope === 'all-windows') {
    sources = await adapter.getAllWindows();
  } else if (scope === 'current-window') {
    sources = [await adapter.getCurrentWindow()];
  } else {
    const tab = await adapter.getActiveTab();
    sources = tab
      ? [
          {
            ...(tab.windowId === undefined ? {} : { id: tab.windowId }),
            incognito: tab.incognito,
            type: 'normal',
            tabs: [tab],
          },
        ]
      : [];
  }

  const warnings = new Map<CaptureWarning['code'], CaptureWarning>();
  const windows: SavedWindow[] = [];
  for (const source of sources) {
    const saved = await captureWindow(adapter, source, windows.length, warnings);
    if (saved) windows.push(saved);
  }
  const timestamp = now.toISOString();
  return validateSnapshot({
    schemaVersion: SCHEMA_VERSION,
    snapshotId: newId(),
    generationId: newId(),
    name: defaultName(now),
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceDevice,
    windows,
    captureWarnings: [...warnings.values()],
  });
}
