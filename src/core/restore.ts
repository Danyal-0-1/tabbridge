import { errorMessage } from './errors.ts';
import { newId } from './ids.ts';
import { validateSnapshot } from './schema.ts';
import { assessUrl } from './url-policy.ts';
import type {
  GroupColor,
  PlannedWindow,
  RestorePlan,
  RestoreProgress,
  RestoreReport,
  RestoreSelection,
  SavedTab,
  Snapshot,
} from './types.ts';

export interface RestoredTab {
  id?: number;
  windowId?: number;
}

export interface RestoredWindow {
  id?: number;
  tabs?: RestoredTab[];
}

export interface RestoreAdapter {
  groupsSupported(): boolean;
  createWindow(options: Record<string, unknown>): Promise<RestoredWindow>;
  createTab(options: Record<string, unknown>): Promise<RestoredTab>;
  updateTab(tabId: number, options: Record<string, unknown>): Promise<RestoredTab>;
  groupTabs(tabIds: number[], windowId: number): Promise<number>;
  updateGroup(
    groupId: number,
    options: { title: string; color: GroupColor; collapsed: boolean },
  ): Promise<void>;
  discardTab(tabId: number): Promise<void>;
}

function selectionSets(selection?: RestoreSelection): {
  constrained: boolean;
  windows: Set<string>;
  groups: Set<string>;
  tabs: Set<string>;
} {
  const windows = new Set(selection?.windowIds ?? []);
  const groups = new Set(selection?.groupIds ?? []);
  const tabs = new Set(selection?.tabIds ?? []);
  return {
    constrained: windows.size + groups.size + tabs.size > 0,
    windows,
    groups,
    tabs,
  };
}

export function createRestorePlan(value: Snapshot, selection?: RestoreSelection): RestorePlan {
  const snapshot = validateSnapshot(value);
  const selected = selectionSets(selection);
  const windows: PlannedWindow[] = [];
  const skippedUrls: RestorePlan['skippedUrls'] = [];

  for (const window of [...snapshot.windows].sort((left, right) => left.order - right.order)) {
    const includeWindow = !selected.constrained || selected.windows.has(window.id);
    const tabs: SavedTab[] = [];
    for (const tab of [...window.tabs].sort((left, right) => left.index - right.index)) {
      const include =
        includeWindow ||
        selected.tabs.has(tab.id) ||
        (tab.groupId !== undefined && selected.groups.has(tab.groupId));
      if (!include) continue;
      const decision = assessUrl(tab.url);
      if (!decision.allowed || !decision.normalized) {
        skippedUrls.push({ url: tab.url, reason: decision.reason ?? 'Unsupported URL.' });
        continue;
      }
      tabs.push({ ...tab, url: decision.normalized });
    }
    if (tabs.length === 0) continue;
    const includedIds = new Set(tabs.map((tab) => tab.id));
    const groups = window.groups
      .map((group) => ({
        ...group,
        tabIds: tabs.filter((tab) => tab.groupId === group.id && !tab.pinned).map((tab) => tab.id),
      }))
      .filter((group) => group.tabIds.length > 0);
    const activeTabId =
      window.activeTabId && includedIds.has(window.activeTabId)
        ? window.activeTabId
        : (tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id);
    windows.push({
      sourceWindowId: window.id,
      ...(window.state === undefined ? {} : { state: window.state }),
      ...(activeTabId === undefined ? {} : { activeTabId }),
      tabs,
      groups,
    });
  }

  return {
    snapshotId: snapshot.snapshotId,
    windows,
    tabCount: windows.reduce((total, window) => total + window.tabs.length, 0),
    groupCount: windows.reduce((total, window) => total + window.groups.length, 0),
    skippedUrls,
  };
}

export interface ExecuteRestoreOptions {
  discardBackgroundTabs: boolean;
  isCancelled?: () => Promise<boolean>;
  onProgress?: (progress: RestoreProgress) => void | Promise<void>;
  operationId?: string;
}

export async function executeRestore(
  adapter: RestoreAdapter,
  plan: RestorePlan,
  options: ExecuteRestoreOptions,
): Promise<RestoreReport> {
  const operationId = options.operationId ?? newId();
  const report: RestoreReport = {
    operationId,
    stopped: false,
    windowsRestored: 0,
    tabsRestored: 0,
    groupsRestored: 0,
    skippedUrls: [...plan.skippedUrls],
    differences: [],
    failures: [],
  };
  const totalSteps = Math.max(1, plan.tabCount + plan.groupCount + plan.windows.length);
  let completed = 0;
  const progress = async (phase: RestoreProgress['phase'], message: string): Promise<void> => {
    await options.onProgress?.({ operationId, phase, completed, total: totalSteps, message });
  };
  const cancelled = async (): Promise<boolean> => {
    if (!(await options.isCancelled?.())) return false;
    report.stopped = true;
    return true;
  };

  await progress('validating', 'Snapshot validated.');
  const groupsAvailable = adapter.groupsSupported();
  if (!groupsAvailable && plan.groupCount > 0) {
    report.differences.push(
      'This browser does not support tab groups; tabs were restored in their saved contiguous order.',
    );
  }

  for (const plannedWindow of plan.windows) {
    if (await cancelled()) break;
    const first = plannedWindow.tabs[0];
    if (!first) continue;
    let runtimeWindow: RestoredWindow;
    try {
      runtimeWindow = await adapter.createWindow({
        url: first.url,
        focused: false,
        state: plannedWindow.state === 'fullscreen' ? 'normal' : (plannedWindow.state ?? 'normal'),
      });
      if (runtimeWindow.id === undefined) throw new Error('The browser returned no window ID.');
      report.windowsRestored += 1;
      completed += 1;
      await progress('windows', `Created window ${report.windowsRestored}.`);
    } catch (error) {
      report.failures.push({
        operation: 'create-window',
        itemId: plannedWindow.sourceWindowId,
        reason: errorMessage(error),
      });
      continue;
    }

    const runtimeWindowId = runtimeWindow.id;
    const runtimeTabs = new Map<string, number>();
    const firstRuntimeId = runtimeWindow.tabs?.[0]?.id;
    if (firstRuntimeId === undefined) {
      report.failures.push({
        operation: 'create-tab',
        itemId: first.id,
        reason: 'The browser created a window without returning its first tab.',
      });
    } else {
      runtimeTabs.set(first.id, firstRuntimeId);
      report.tabsRestored += 1;
      try {
        await adapter.updateTab(firstRuntimeId, { pinned: first.pinned });
      } catch (error) {
        report.failures.push({
          operation: 'pin-tab',
          itemId: first.id,
          reason: errorMessage(error),
        });
      }
      completed += 1;
      await progress('tabs', `Opened ${report.tabsRestored} of ${plan.tabCount} tabs.`);
    }

    for (const tab of plannedWindow.tabs.slice(1)) {
      if (await cancelled()) break;
      try {
        const runtimeTab = await adapter.createTab({
          windowId: runtimeWindowId,
          url: tab.url,
          active: false,
          pinned: tab.pinned,
        });
        if (runtimeTab.id === undefined) throw new Error('The browser returned no tab ID.');
        runtimeTabs.set(tab.id, runtimeTab.id);
        report.tabsRestored += 1;
      } catch (error) {
        report.failures.push({
          operation: 'create-tab',
          itemId: tab.id,
          reason: errorMessage(error),
        });
      }
      completed += 1;
      await progress('tabs', `Opened ${report.tabsRestored} of ${plan.tabCount} tabs.`);
    }
    if (report.stopped) break;

    if (groupsAvailable) {
      for (const group of plannedWindow.groups) {
        if (await cancelled()) break;
        const runtimeIds = group.tabIds.flatMap((tabId) => {
          const runtimeId = runtimeTabs.get(tabId);
          return runtimeId === undefined ? [] : [runtimeId];
        });
        const pinnedMembers = plannedWindow.tabs.filter(
          (tab) => tab.groupId === group.id && tab.pinned && runtimeTabs.has(tab.id),
        );
        if (pinnedMembers.length > 0) {
          report.differences.push(
            `${pinnedMembers.length} pinned tab(s) from group “${group.title || 'Untitled'}” were left ungrouped.`,
          );
        }
        if (runtimeIds.length === 0) continue;
        try {
          const runtimeGroupId = await adapter.groupTabs(runtimeIds, runtimeWindowId);
          await adapter.updateGroup(runtimeGroupId, {
            title: group.title,
            color: group.color,
            collapsed: group.collapsed,
          });
          report.groupsRestored += 1;
        } catch (error) {
          report.failures.push({
            operation: 'create-group',
            itemId: group.id,
            reason: errorMessage(error),
          });
        }
        completed += 1;
        await progress('groups', `Restored ${report.groupsRestored} of ${plan.groupCount} groups.`);
      }
    }
    if (report.stopped) break;

    const activeRuntimeId = plannedWindow.activeTabId
      ? runtimeTabs.get(plannedWindow.activeTabId)
      : undefined;
    if (activeRuntimeId !== undefined) {
      try {
        await adapter.updateTab(activeRuntimeId, { active: true });
      } catch (error) {
        report.failures.push({
          operation: 'activate-tab',
          ...(plannedWindow.activeTabId === undefined ? {} : { itemId: plannedWindow.activeTabId }),
          reason: errorMessage(error),
        });
      }
    }

    if (options.discardBackgroundTabs) {
      for (const tab of plannedWindow.tabs) {
        const runtimeId = runtimeTabs.get(tab.id);
        if (runtimeId === undefined || runtimeId === activeRuntimeId || tab.pinned) continue;
        try {
          await adapter.discardTab(runtimeId);
        } catch (error) {
          report.failures.push({
            operation: 'discard-tab',
            itemId: tab.id,
            reason: errorMessage(error),
          });
        }
      }
    }
  }

  await progress('finalizing', report.stopped ? 'Restore stopped.' : 'Restore finished.');
  return report;
}
