import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRestorePlan, executeRestore, type RestoreAdapter } from '../../src/core/restore.ts';
import type { GroupColor, RestorePlan } from '../../src/core/types.ts';
import { IDS, snapshotFixture } from './fixtures.ts';

interface AdapterCalls {
  windows: Record<string, unknown>[];
  tabs: Record<string, unknown>[];
  updates: Array<{ tabId: number; options: Record<string, unknown> }>;
  groups: Array<{ tabIds: number[]; windowId: number }>;
  groupUpdates: Array<{
    groupId: number;
    options: { title: string; color: GroupColor; collapsed: boolean };
  }>;
  discarded: number[];
}

function recordingAdapter(groupsSupported: boolean): {
  adapter: RestoreAdapter;
  calls: AdapterCalls;
} {
  const calls: AdapterCalls = {
    windows: [],
    tabs: [],
    updates: [],
    groups: [],
    groupUpdates: [],
    discarded: [],
  };
  let windowIndex = 0;
  let createdTabId = 1_001;
  const adapter: RestoreAdapter = {
    groupsSupported() {
      return groupsSupported;
    },
    async createWindow(options) {
      calls.windows.push(options);
      const id = 101 + windowIndex * 100;
      const firstTabId = 1_000 + windowIndex * 1_000;
      windowIndex += 1;
      createdTabId = firstTabId + 1;
      return { id, tabs: [{ id: firstTabId, windowId: id }] };
    },
    async createTab(options) {
      calls.tabs.push(options);
      const id = createdTabId;
      createdTabId += 1;
      return { id, windowId: options.windowId as number };
    },
    async updateTab(tabId, options) {
      calls.updates.push({ tabId, options });
      return { id: tabId };
    },
    async groupTabs(tabIds, windowId) {
      calls.groups.push({ tabIds, windowId });
      return 901;
    },
    async updateGroup(groupId, options) {
      calls.groupUpdates.push({ groupId, options });
    },
    async discardTab(tabId) {
      calls.discarded.push(tabId);
    },
  };
  return { adapter, calls };
}

describe('createRestorePlan', () => {
  it('sorts saved structure, preserves duplicates, and excludes unsafe URLs', () => {
    const snapshot = snapshotFixture();
    const firstWindow = snapshot.windows.find((window) => window.id === IDS.windowA);
    assert.ok(firstWindow);
    firstWindow.tabs.push({
      id: IDS.tabUnsafe,
      url: 'javascript:alert(document.domain)',
      title: 'Never restore',
      index: 3,
      pinned: false,
      active: false,
    });

    const plan = createRestorePlan(snapshot);

    assert.deepEqual(
      plan.windows.map((window) => window.sourceWindowId),
      [IDS.windowA, IDS.windowB],
    );
    assert.deepEqual(
      plan.windows[0]?.tabs.map((tab) => tab.id),
      [IDS.tabA, IDS.tabB, IDS.tabC],
    );
    assert.equal(
      plan.windows[0]?.tabs.filter(
        (tab) => tab.url === 'https://duplicate.example/path?token=same#fragment',
      ).length,
      2,
    );
    assert.equal(plan.windows[0]?.tabs[0]?.pinned, true);
    assert.equal(plan.windows[0]?.activeTabId, IDS.tabB);
    assert.equal(plan.windows[0]?.groups[0]?.title, '研究 🌙');
    assert.equal(plan.windows[0]?.groups[0]?.color, 'purple');
    assert.equal(plan.windows[0]?.groups[0]?.collapsed, true);
    assert.deepEqual(plan.windows[0]?.groups[0]?.tabIds, [IDS.tabC]);
    assert.deepEqual(plan.skippedUrls, [
      {
        url: 'javascript:alert(document.domain)',
        reason: 'The javascript: scheme is not allowed.',
      },
    ]);
    assert.equal(plan.tabCount, 4);
    assert.equal(plan.groupCount, 1);
  });

  it('supports group and individual-tab selections without mutating the snapshot', () => {
    const snapshot = snapshotFixture();
    const before = structuredClone(snapshot);

    const groupPlan = createRestorePlan(snapshot, { groupIds: [IDS.groupA] });
    assert.equal(groupPlan.windows.length, 1);
    assert.deepEqual(
      groupPlan.windows[0]?.tabs.map((tab) => tab.id),
      [IDS.tabA, IDS.tabC],
    );
    assert.equal(groupPlan.windows[0]?.activeTabId, IDS.tabA);
    assert.deepEqual(groupPlan.windows[0]?.groups[0]?.tabIds, [IDS.tabC]);

    const tabPlan = createRestorePlan(snapshot, { tabIds: [IDS.tabD] });
    assert.equal(tabPlan.windows.length, 1);
    assert.equal(tabPlan.windows[0]?.sourceWindowId, IDS.windowB);
    assert.deepEqual(tabPlan.windows[0]?.groups, []);
    assert.deepEqual(snapshot, before);
  });
});

describe('executeRestore', () => {
  it('maps logical IDs to fresh runtime IDs and restores browser state in order', async () => {
    const plan = createRestorePlan(snapshotFixture());
    const { adapter, calls } = recordingAdapter(true);
    const progress: string[] = [];

    const report = await executeRestore(adapter, plan, {
      discardBackgroundTabs: true,
      operationId: 'restore-operation',
      onProgress(update) {
        progress.push(update.phase);
      },
    });

    assert.deepEqual(calls.windows, [
      {
        url: 'https://duplicate.example/path?token=same#fragment',
        focused: false,
        state: 'maximized',
      },
      {
        url: 'https://second.example/%CE%B4?value=2#result',
        focused: false,
        state: 'normal',
      },
    ]);
    assert.deepEqual(calls.tabs, [
      {
        windowId: 101,
        url: 'https://duplicate.example/path?token=same#fragment',
        active: false,
        pinned: false,
      },
      {
        windowId: 101,
        url: 'https://grouped.example/notes',
        active: false,
        pinned: false,
      },
    ]);
    assert.deepEqual(calls.groups, [{ tabIds: [1_002], windowId: 101 }]);
    assert.deepEqual(calls.groupUpdates, [
      {
        groupId: 901,
        options: { title: '研究 🌙', color: 'purple', collapsed: true },
      },
    ]);
    assert.deepEqual(calls.updates, [
      { tabId: 1_000, options: { pinned: true } },
      { tabId: 1_001, options: { active: true } },
      { tabId: 2_000, options: { pinned: false } },
      { tabId: 2_000, options: { active: true } },
    ]);
    assert.deepEqual(calls.discarded, [1_002]);
    assert.deepEqual(report, {
      operationId: 'restore-operation',
      stopped: false,
      windowsRestored: 2,
      tabsRestored: 4,
      groupsRestored: 1,
      skippedUrls: [],
      differences: ['1 pinned tab(s) from group “研究 🌙” were left ungrouped.'],
      failures: [],
    });
    assert.equal(progress[0], 'validating');
    assert.equal(progress.at(-1), 'finalizing');
  });

  it('continues after an individual tab failure and reports the failed logical ID', async () => {
    const plan: RestorePlan = {
      snapshotId: IDS.snapshot,
      windows: [
        {
          sourceWindowId: IDS.windowA,
          activeTabId: IDS.tabB,
          tabs: [
            {
              id: IDS.tabA,
              url: 'https://one.example/',
              title: 'One',
              index: 0,
              pinned: false,
              active: false,
            },
            {
              id: IDS.tabB,
              url: 'https://failure.example/',
              title: 'Failure',
              index: 1,
              pinned: false,
              active: true,
            },
            {
              id: IDS.tabC,
              url: 'https://three.example/',
              title: 'Three',
              index: 2,
              pinned: false,
              active: false,
            },
          ],
          groups: [],
        },
      ],
      tabCount: 3,
      groupCount: 0,
      skippedUrls: [],
    };
    const attemptedUrls: string[] = [];
    const adapter: RestoreAdapter = {
      groupsSupported: () => true,
      async createWindow() {
        return { id: 50, tabs: [{ id: 500 }] };
      },
      async createTab(options) {
        const url = options.url as string;
        attemptedUrls.push(url);
        if (url === 'https://failure.example/') throw new Error('simulated tab failure');
        return { id: 502 };
      },
      async updateTab(tabId) {
        return { id: tabId };
      },
      async groupTabs() {
        throw new Error('no group was planned');
      },
      async updateGroup() {
        throw new Error('no group was planned');
      },
      async discardTab() {},
    };

    const report = await executeRestore(adapter, plan, { discardBackgroundTabs: false });

    assert.deepEqual(attemptedUrls, ['https://failure.example/', 'https://three.example/']);
    assert.equal(report.tabsRestored, 2);
    assert.deepEqual(report.failures, [
      {
        operation: 'create-tab',
        itemId: IDS.tabB,
        reason: 'simulated tab failure',
      },
    ]);
  });

  it('falls back without invoking group APIs when the browser lacks group support', async () => {
    const plan = createRestorePlan(snapshotFixture());
    const { adapter, calls } = recordingAdapter(false);

    const report = await executeRestore(adapter, plan, { discardBackgroundTabs: false });

    assert.deepEqual(calls.groups, []);
    assert.deepEqual(calls.groupUpdates, []);
    assert.equal(report.groupsRestored, 0);
    assert.deepEqual(report.differences, [
      'This browser does not support tab groups; tabs were restored in their saved contiguous order.',
    ]);
    assert.equal(report.tabsRestored, 4);
  });

  it('stops before opening remaining tabs without rolling back completed work', async () => {
    const plan = createRestorePlan(snapshotFixture(), { windowIds: [IDS.windowA] });
    const { adapter, calls } = recordingAdapter(true);
    let cancellationChecks = 0;

    const report = await executeRestore(adapter, plan, {
      discardBackgroundTabs: false,
      async isCancelled() {
        cancellationChecks += 1;
        return cancellationChecks === 3;
      },
    });

    assert.equal(report.stopped, true);
    assert.equal(report.windowsRestored, 1);
    assert.equal(report.tabsRestored, 2);
    assert.equal(calls.windows.length, 1);
    assert.equal(calls.tabs.length, 1);
    assert.deepEqual(calls.groups, []);
  });
});
