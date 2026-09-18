import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  captureWorkspace,
  type CaptureAdapter,
  type CaptureWindow,
} from '../../src/core/capture.ts';
import { sourceDeviceFixture } from './fixtures.ts';

describe('captureWorkspace', () => {
  it('preserves reproducible structure while excluding private and unsupported content', async () => {
    const windows: CaptureWindow[] = [
      {
        id: 9001,
        type: 'normal',
        incognito: true,
        tabs: [
          {
            id: 8001,
            index: 0,
            url: 'https://private.example/never-save',
            title: 'Private',
            pinned: false,
            active: true,
            incognito: true,
          },
        ],
      },
      {
        id: 42,
        type: 'normal',
        incognito: false,
        state: 'maximized',
        tabs: [
          {
            id: 703,
            index: 7,
            url: 'https://ungrouped.example/路径',
            title: 'ノート 📘',
            pinned: false,
            active: false,
            incognito: false,
          },
          {
            id: 702,
            index: 3,
            url: 'https://duplicate.example/item?q=1#same',
            title: 'Duplicate active',
            pinned: false,
            active: true,
            incognito: false,
          },
          {
            id: 701,
            index: 1,
            url: 'https://duplicate.example/item?q=1#same',
            title: 'Duplicate pinned',
            pinned: true,
            active: false,
            incognito: false,
            groupId: 77,
          },
        ],
      },
      {
        id: 9002,
        type: 'popup',
        incognito: false,
        tabs: [],
      },
      {
        id: 43,
        type: 'normal',
        incognito: false,
        state: 'minimized',
        tabs: [
          {
            id: 704,
            index: 0,
            title: 'Missing URL',
            pinned: false,
            active: false,
            incognito: false,
          },
          {
            id: 705,
            index: 1,
            url: 'javascript:alert(1)',
            title: 'Blocked',
            pinned: false,
            active: false,
            incognito: false,
          },
          {
            id: 706,
            index: 2,
            url: 'https://private-tab.example/',
            title: 'Private tab',
            pinned: false,
            active: false,
            incognito: true,
          },
          {
            id: 707,
            index: 3,
            url: 'HTTPS://SECOND.EXAMPLE/work',
            title: 'Second window',
            pinned: false,
            active: true,
            incognito: false,
          },
        ],
      },
    ];
    const groupRequests: number[] = [];
    const adapter: CaptureAdapter = {
      async getAllWindows() {
        return windows;
      },
      async getCurrentWindow() {
        throw new Error('current-window API should not be used for all-windows capture');
      },
      async getActiveTab() {
        throw new Error('active-tab API should not be used for all-windows capture');
      },
      async getGroups(windowId) {
        groupRequests.push(windowId);
        return windowId === 42
          ? [{ id: 77, title: '研究 🌙', color: 'purple', collapsed: true }]
          : [];
      },
      groupsSupported() {
        return true;
      },
    };

    const snapshot = await captureWorkspace(
      adapter,
      'all-windows',
      sourceDeviceFixture(),
      new Date('2026-09-18T22:42:00.000Z'),
    );

    assert.deepEqual(groupRequests, [42, 43]);
    assert.equal(snapshot.windows.length, 2);
    assert.deepEqual(
      snapshot.windows.map((window) => window.order),
      [0, 1],
    );

    const first = snapshot.windows[0];
    assert.ok(first);
    assert.equal(first.state, 'maximized');
    assert.equal(first.tabs.length, 3);
    assert.deepEqual(
      first.tabs.map((tab) => tab.url),
      [
        'https://duplicate.example/item?q=1#same',
        'https://duplicate.example/item?q=1#same',
        'https://ungrouped.example/%E8%B7%AF%E5%BE%84',
      ],
    );
    assert.deepEqual(
      first.tabs.map((tab) => tab.index),
      [0, 1, 2],
    );
    assert.equal(first.tabs[0]?.pinned, true);
    assert.equal(first.activeTabId, first.tabs[1]?.id);
    assert.equal(first.tabs[0]?.groupId, first.groups[0]?.id);
    assert.equal(first.groups[0]?.title, '研究 🌙');
    assert.equal(first.groups[0]?.collapsed, true);
    assert.equal(first.groups[0]?.order, 0);
    assert.equal(first.tabs[2]?.title, 'ノート 📘');

    const second = snapshot.windows[1];
    assert.ok(second);
    assert.equal(second.tabs.length, 1);
    assert.equal(second.tabs[0]?.url, 'https://second.example/work');
    assert.equal(second.activeTabId, second.tabs[0]?.id);

    const warnings = Object.fromEntries(
      snapshot.captureWarnings.map((warning) => [warning.code, warning.count]),
    );
    assert.deepEqual(warnings, {
      'private-window': 3,
      'missing-url': 1,
      'unsupported-url': 1,
    });

    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('private.example'), false);
    assert.equal(serialized.includes('private-tab.example'), false);
    assert.equal(serialized.includes('javascript:alert'), false);
    for (const runtimeId of [
      '9001',
      '9002',
      '8001',
      '701',
      '702',
      '703',
      '704',
      '705',
      '706',
      '707',
      '77',
    ]) {
      assert.equal(serialized.includes(`\"id\":${runtimeId}`), false);
    }
  });

  it('uses the requested scope and reports unavailable group metadata', async () => {
    const calls: string[] = [];
    const adapter: CaptureAdapter = {
      async getAllWindows() {
        calls.push('all');
        return [];
      },
      async getCurrentWindow() {
        calls.push('current');
        return {
          id: 12,
          type: 'normal',
          incognito: false,
          tabs: [
            {
              index: 0,
              url: 'https://example.test/',
              title: 'Grouped in source browser',
              pinned: false,
              active: true,
              incognito: false,
              groupId: 5,
            },
          ],
        };
      },
      async getActiveTab() {
        calls.push('active');
        return undefined;
      },
      async getGroups() {
        calls.push('groups');
        return [];
      },
      groupsSupported() {
        return false;
      },
    };

    const snapshot = await captureWorkspace(
      adapter,
      'current-window',
      sourceDeviceFixture(),
      new Date('2026-09-18T22:42:00.000Z'),
    );

    assert.deepEqual(calls, ['current']);
    assert.equal(snapshot.windows.length, 1);
    assert.deepEqual(snapshot.windows[0]?.groups, []);
    assert.equal(snapshot.windows[0]?.tabs[0]?.groupId, undefined);
    assert.deepEqual(snapshot.captureWarnings, [
      {
        code: 'group-unavailable',
        message: 'Group metadata was unavailable in this browser.',
        count: 1,
      },
    ]);
  });
});
