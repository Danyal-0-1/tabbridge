import type { Snapshot, SourceDevice } from '../../src/core/types.ts';

export const IDS = {
  snapshot: '00000000-0000-4000-8000-000000000001',
  generation: '00000000-0000-4000-8000-000000000002',
  device: '00000000-0000-4000-8000-000000000003',
  windowA: '00000000-0000-4000-8000-000000000010',
  windowB: '00000000-0000-4000-8000-000000000011',
  groupA: '00000000-0000-4000-8000-000000000020',
  tabA: '00000000-0000-4000-8000-000000000030',
  tabB: '00000000-0000-4000-8000-000000000031',
  tabC: '00000000-0000-4000-8000-000000000032',
  tabD: '00000000-0000-4000-8000-000000000033',
  tabUnsafe: '00000000-0000-4000-8000-000000000034',
} as const;

export function sourceDeviceFixture(): SourceDevice {
  return {
    id: IDS.device,
    label: 'Work laptop 💻',
    browser: 'firefox',
    browserVersion: '140.0',
    operatingSystem: 'Test OS',
  };
}

export function snapshotFixture(): Snapshot {
  return {
    schemaVersion: 1,
    snapshotId: IDS.snapshot,
    generationId: IDS.generation,
    name: 'Research — 京都 🔬',
    createdAt: '2026-09-18T20:42:00.000Z',
    updatedAt: '2026-09-18T20:42:00.000Z',
    sourceDevice: sourceDeviceFixture(),
    windows: [
      {
        id: IDS.windowB,
        order: 1,
        state: 'normal',
        activeTabId: IDS.tabD,
        groups: [],
        tabs: [
          {
            id: IDS.tabD,
            url: 'https://second.example/δ?value=2#result',
            title: 'Second window — δ',
            index: 0,
            pinned: false,
            active: true,
          },
        ],
      },
      {
        id: IDS.windowA,
        order: 0,
        state: 'maximized',
        activeTabId: IDS.tabB,
        groups: [
          {
            id: IDS.groupA,
            title: '研究 🌙',
            color: 'purple',
            collapsed: true,
            order: 0,
          },
        ],
        tabs: [
          {
            id: IDS.tabC,
            url: 'https://grouped.example/notes',
            title: 'Grouped notes',
            index: 2,
            pinned: false,
            active: false,
            groupId: IDS.groupA,
          },
          {
            id: IDS.tabB,
            url: 'https://duplicate.example/path?token=same#fragment',
            title: 'Duplicate, active',
            index: 1,
            pinned: false,
            active: true,
          },
          {
            id: IDS.tabA,
            url: 'https://duplicate.example/path?token=same#fragment',
            title: 'Duplicate, pinned and grouped',
            index: 0,
            pinned: true,
            active: false,
            groupId: IDS.groupA,
          },
        ],
      },
    ],
    captureWarnings: [],
  };
}
