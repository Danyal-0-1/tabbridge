import type { ListResponse, Request, Response, StatusResponse } from '../core/messages.ts';
import type { SnapshotSummary } from '../core/types.ts';
import { BrowserAdapter } from '../platform/browser-adapter.ts';
import { bindPassphraseVisibility } from '../ui/passphrase-visibility.ts';

const browser = new BrowserAdapter();

function byId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`#${CSS.escape(id)}`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing element: ${id}`);
  return element as T;
}

const modeStatus = byId<HTMLParagraphElement>('mode-status');
const setupState = byId<HTMLElement>('setup-state');
const unlockForm = byId<HTMLFormElement>('unlock-form');
const unlockPassphrase = byId<HTMLInputElement>('unlock-passphrase');
const actions = byId<HTMLElement>('actions');
const recentSection = byId<HTMLElement>('recent-section');
const recentList = byId<HTMLOListElement>('recent-list');
const lastAction = byId<HTMLParagraphElement>('last-action');
const liveStatus = byId<HTMLParagraphElement>('live-status');
const lockButton = byId<HTMLButtonElement>('lock-button');
const actionButtons = ['save-window', 'save-all', 'save-tab'].map((id) =>
  byId<HTMLButtonElement>(id),
);

async function send<T>(request: Request): Promise<T> {
  const response = await browser.sendMessage<Response>(request);
  if (!response.ok) throw new Error(response.error.message);
  return response.data as T;
}

function announce(message: string): void {
  liveStatus.textContent = message;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function renderRecent(snapshots: SnapshotSummary[]): void {
  recentList.replaceChildren();
  for (const snapshot of snapshots.slice(0, 3)) {
    const item = document.createElement('li');
    const details = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'recent-name';
    name.textContent = snapshot.name;
    const metadata = document.createElement('div');
    metadata.className = 'recent-meta';
    metadata.textContent = `${formatDate(snapshot.createdAt)} · ${snapshot.tabCount} tab${snapshot.tabCount === 1 ? '' : 's'}`;
    details.append(name, metadata);
    const location = document.createElement('span');
    location.className = 'recent-meta';
    location.textContent = snapshot.location === 'synced' ? 'Synced' : 'Local';
    item.append(details, location);
    recentList.append(item);
  }
  recentSection.hidden = snapshots.length === 0;
}

async function refresh(): Promise<void> {
  try {
    const status = await send<StatusResponse>({ type: 'GET_STATUS' });
    modeStatus.textContent = `${status.settings.syncEnabled ? 'Browser Sync' : 'Local only'} · ${status.locked ? 'Locked' : 'Unlocked'}`;
    setupState.hidden = status.configured;
    unlockForm.hidden = !status.configured || !status.locked;
    actions.hidden = !status.configured || status.locked;
    lockButton.hidden = !status.configured || status.locked;
    if (status.lastAction) {
      lastAction.textContent = status.lastAction;
      lastAction.hidden = false;
    } else {
      lastAction.hidden = true;
    }
    if (status.configured && !status.locked) {
      const list = await send<ListResponse>({ type: 'LIST_SNAPSHOTS' });
      renderRecent(list.snapshots);
    } else {
      recentSection.hidden = true;
    }
  } catch (error) {
    modeStatus.textContent = 'Unavailable';
    announce(error instanceof Error ? error.message : 'TabBridge could not load.');
  }
}

async function save(scope: 'current-window' | 'all-windows' | 'current-tab'): Promise<void> {
  for (const button of actionButtons) button.disabled = true;
  announce('Saving workspace…');
  try {
    const result = await send<{ saved: true; skipped: number }>({ type: 'CAPTURE', scope });
    announce(
      result.skipped > 0
        ? `Saved. ${result.skipped} unsupported tab${result.skipped === 1 ? ' was' : 's were'} skipped.`
        : 'Workspace saved.',
    );
    await refresh();
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Could not save the workspace.');
  } finally {
    for (const button of actionButtons) button.disabled = false;
  }
}

byId<HTMLButtonElement>('save-window').addEventListener('click', () => void save('current-window'));
byId<HTMLButtonElement>('save-all').addEventListener('click', () => void save('all-windows'));
byId<HTMLButtonElement>('save-tab').addEventListener('click', () => void save('current-tab'));

unlockForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    try {
      announce('Unlocking…');
      await send({ type: 'UNLOCK', passphrase: unlockPassphrase.value });
      unlockForm.reset();
      announce('Unlocked.');
      await refresh();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not unlock TabBridge.');
    }
  })();
});

lockButton.addEventListener('click', () => {
  void (async () => {
    await send({ type: 'LOCK' });
    unlockForm.reset();
    announce('Locked.');
    await refresh();
  })();
});

for (const id of ['manager-button', 'setup-button']) {
  byId<HTMLButtonElement>(id).addEventListener('click', () => void browser.openManager());
}

bindPassphraseVisibility(document);
void refresh();
