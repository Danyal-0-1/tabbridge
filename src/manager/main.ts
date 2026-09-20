import type {
  ExportResponse,
  ImportPreviewResponse,
  ImportResponse,
  ListResponse,
  Request,
  Response,
  StatusResponse,
} from '../core/messages.ts';
import { newId } from '../core/ids.ts';
import type { RestoreReport, RestoreSelection, Snapshot, SnapshotSummary } from '../core/types.ts';
import { BrowserAdapter } from '../platform/browser-adapter.ts';
import { bindPassphraseVisibility } from '../ui/passphrase-visibility.ts';

const browser = new BrowserAdapter();
let status: StatusResponse | undefined;
let snapshots: SnapshotSummary[] = [];
let selectedId: string | undefined;
let renameId: string | undefined;
let exportId: string | undefined;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`#${CSS.escape(id)}`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function send<T>(request: Request): Promise<T> {
  const response = await browser.sendMessage<Response>(request);
  if (!response.ok) throw new Error(response.error.message);
  return response.data as T;
}

const liveStatus = byId<HTMLParagraphElement>('live-status');
const headerStatus = byId<HTMLSpanElement>('header-status');
const onboarding = byId<HTMLElement>('onboarding');
const unlockPanel = byId<HTMLElement>('unlock-panel');
const workspace = byId<HTMLElement>('workspace');
const lockButton = byId<HTMLButtonElement>('lock-button');
const snapshotList = byId<HTMLDivElement>('snapshot-list');
const preview = byId<HTMLElement>('preview');
const snapshotCount = byId<HTMLParagraphElement>('snapshot-count');
const searchInput = byId<HTMLInputElement>('search');
const sortSelect = byId<HTMLSelectElement>('sort');
const quotaWarning = byId<HTMLDivElement>('quota-warning');

function announce(message: string): void {
  liveStatus.textContent = message;
}

function errorState(container: HTMLElement, message: string): void {
  const error = element('div', 'error-state');
  error.setAttribute('role', 'alert');
  error.textContent = message;
  container.replaceChildren(error);
  announce(message);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function plural(value: number, word: string): string {
  return `${value} ${word}${value === 1 ? '' : 's'}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Invalid URL';
  }
}

function setBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll('button, input, select')) {
    if (
      control instanceof HTMLButtonElement ||
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement
    ) {
      control.disabled = busy;
    }
  }
}

async function loadStatus(): Promise<void> {
  status = await send<StatusResponse>({ type: 'GET_STATUS' });
  onboarding.hidden = status.configured;
  unlockPanel.hidden = !status.configured || !status.locked;
  workspace.hidden = !status.configured || status.locked;
  lockButton.hidden = !status.configured || status.locked;
  headerStatus.textContent = !status.configured
    ? 'Setup required'
    : status.locked
      ? 'Locked'
      : status.settings.syncEnabled
        ? 'Browser Sync · Unlocked'
        : 'Local only · Unlocked';

  if (!status.locked && status.configured) {
    byId<HTMLInputElement>('device-label').value = status.settings.deviceLabel;
    byId<HTMLInputElement>('discard-tabs').checked = status.settings.discardBackgroundTabs;
    byId<HTMLInputElement>('sync-enabled').checked = status.settings.syncEnabled;
    const quota = byId<HTMLDivElement>('quota-display');
    quota.textContent = status.quota
      ? `${status.quota.usedBytes.toLocaleString()} of ${status.quota.quotaBytes.toLocaleString()} sync bytes used · ${status.quota.itemCount} of ${status.quota.maxItems} items`
      : status.settings.syncEnabled
        ? 'Sync quota is temporarily unavailable.'
        : 'Sync is disabled. Local snapshots are unaffected.';
    if (!navigator.onLine && status.settings.syncEnabled) {
      quotaWarning.textContent =
        'You appear to be offline. Browser sync may queue changes and delivery will be delayed.';
      quotaWarning.hidden = false;
    } else if (status.quota && status.quota.remainingBytes < 10_240) {
      quotaWarning.textContent =
        'Browser sync storage is nearly full. Keep large snapshots local or export them.';
      quotaWarning.hidden = false;
    } else {
      quotaWarning.hidden = true;
    }
  }
}

function filteredSnapshots(): SnapshotSummary[] {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const filtered = snapshots.filter((snapshot) =>
    snapshot.name.toLocaleLowerCase().includes(query),
  );
  return [...filtered].sort((left, right) => {
    if (sortSelect.value === 'oldest') return left.createdAt.localeCompare(right.createdAt);
    if (sortSelect.value === 'device') {
      return (
        left.sourceDevice.label.localeCompare(right.sourceDevice.label) ||
        right.createdAt.localeCompare(left.createdAt)
      );
    }
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function actionButton(label: string, className = 'button button-quiet'): HTMLButtonElement {
  const button = element('button', className, label);
  button.type = 'button';
  return button;
}

function renderList(): void {
  const filtered = filteredSnapshots();
  snapshotCount.textContent = `${plural(filtered.length, 'snapshot')} shown`;
  snapshotList.replaceChildren();
  if (filtered.length === 0) {
    const empty = element('div', 'empty-state');
    empty.append(
      element(
        'h3',
        undefined,
        snapshots.length === 0 ? 'No snapshots yet' : 'No matching snapshots',
      ),
      element(
        'p',
        undefined,
        snapshots.length === 0
          ? 'Use the toolbar popup to save the current window, all windows, or one tab.'
          : 'Try a different search term.',
      ),
    );
    snapshotList.append(empty);
    return;
  }

  for (const snapshot of filtered) {
    const card = element(
      'article',
      `snapshot-card${selectedId === snapshot.snapshotId ? ' is-selected' : ''}`,
    );
    const top = element('div', 'card-top');
    const title = element('h3', undefined, snapshot.name);
    const location = element(
      'span',
      'location',
      snapshot.location === 'synced' ? 'Synced' : 'Local',
    );
    top.append(title, location);
    const metadata = element('div', 'metadata');
    for (const text of [
      formatDate(snapshot.createdAt),
      snapshot.sourceDevice.label,
      snapshot.sourceDevice.browser,
      plural(snapshot.windowCount, 'window'),
      plural(snapshot.tabCount, 'tab'),
      plural(snapshot.groupCount, 'group'),
      'Encrypted',
    ]) {
      metadata.append(element('span', undefined, text));
    }
    const actions = element('div', 'card-actions');
    const previewButton = actionButton('Preview', 'button button-secondary');
    previewButton.addEventListener('click', () => void selectSnapshot(snapshot.snapshotId));
    const renameButton = actionButton('Rename');
    renameButton.addEventListener('click', () => openRename(snapshot));
    const exportButton = actionButton('Export');
    exportButton.addEventListener('click', () => openExport(snapshot.snapshotId));
    const syncButton = actionButton(snapshot.location === 'synced' ? 'Keep local only' : 'Sync');
    syncButton.hidden = !status?.settings.syncEnabled;
    syncButton.addEventListener(
      'click',
      () => void toggleSnapshotSync(snapshot, snapshot.location !== 'synced'),
    );
    const deleteButton = actionButton('Delete', 'button button-danger');
    deleteButton.addEventListener('click', () => void deleteSnapshot(snapshot));
    actions.append(previewButton, renameButton, exportButton, syncButton, deleteButton);
    card.append(top, metadata, actions);
    snapshotList.append(card);
  }
}

async function loadSnapshots(): Promise<void> {
  snapshotList.replaceChildren(element('div', 'loading-state', 'Loading encrypted snapshots…'));
  try {
    const result = await send<ListResponse>({ type: 'LIST_SNAPSHOTS' });
    snapshots = result.snapshots;
    renderList();
    if (result.corrupt.length > 0) {
      quotaWarning.textContent = `${plural(result.corrupt.length, 'record')} could not be read. Existing valid snapshots were preserved.`;
      quotaWarning.hidden = false;
    }
    if (selectedId && !snapshots.some((snapshot) => snapshot.snapshotId === selectedId)) {
      selectedId = undefined;
      resetPreview();
    }
  } catch (error) {
    errorState(snapshotList, error instanceof Error ? error.message : 'Could not load snapshots.');
  }
}

function resetPreview(): void {
  preview.replaceChildren(
    element('h3', undefined, 'Select a snapshot'),
    element('p', 'muted', 'Preview windows, groups, and tabs here. No sites are contacted.'),
  );
}

async function selectSnapshot(snapshotId: string): Promise<void> {
  selectedId = snapshotId;
  renderList();
  preview.replaceChildren(element('div', 'loading-state', 'Decrypting preview…'));
  try {
    const snapshot = await send<Snapshot>({ type: 'GET_SNAPSHOT', snapshotId });
    renderPreview(snapshot);
  } catch (error) {
    errorState(
      preview,
      error instanceof Error ? error.message : 'Could not preview this snapshot.',
    );
  }
}

function renderPreview(snapshot: Snapshot): void {
  preview.replaceChildren();
  const header = element('div', 'preview-header');
  const heading = element('div');
  heading.append(
    element('h3', undefined, snapshot.name),
    element(
      'p',
      'muted',
      `${formatDate(snapshot.createdAt)} · ${snapshot.sourceDevice.label} · ${snapshot.sourceDevice.browser}`,
    ),
  );
  const restoreAll = actionButton('Restore all', 'button button-primary');
  restoreAll.addEventListener('click', () => void restore(snapshot));
  header.append(heading, restoreAll);
  preview.append(header);

  if (snapshot.captureWarnings.length > 0) {
    const warning = element('div', 'notice notice-warning');
    warning.textContent = snapshot.captureWarnings
      .map((item) => `${item.count}× ${item.message}`)
      .join(' ');
    preview.append(warning);
  }

  const tree = element('div', 'preview-tree');
  for (const [windowIndex, windowValue] of snapshot.windows.entries()) {
    const windowNode = element('section', 'tree-window');
    const windowHeading = element('div', 'card-top');
    windowHeading.append(
      element(
        'strong',
        undefined,
        `Window ${windowIndex + 1} · ${plural(windowValue.tabs.length, 'tab')}`,
      ),
    );
    const restoreWindow = actionButton('Restore window');
    restoreWindow.addEventListener(
      'click',
      () => void restore(snapshot, { windowIds: [windowValue.id] }),
    );
    windowHeading.append(restoreWindow);
    windowNode.append(windowHeading);

    const groupedTabs = new Set<string>();
    for (const group of [...windowValue.groups].sort((left, right) => left.order - right.order)) {
      const groupTabs = windowValue.tabs.filter((tab) => tab.groupId === group.id);
      for (const tab of groupTabs) groupedTabs.add(tab.id);
      const groupRow = element('div', 'tree-group');
      const checkbox = element('input') as HTMLInputElement;
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.groupId = group.id;
      checkbox.setAttribute('aria-label', `Select group ${group.title || 'Untitled'}`);
      checkbox.addEventListener('change', () => {
        for (const tab of groupTabs) {
          const tabCheckbox = preview.querySelector<HTMLInputElement>(
            `input[data-tab-id="${CSS.escape(tab.id)}"]`,
          );
          if (tabCheckbox) tabCheckbox.checked = checkbox.checked;
        }
      });
      const label = element(
        'strong',
        undefined,
        `${group.title || 'Untitled group'} · ${group.color}${group.collapsed ? ' · collapsed' : ''}`,
      );
      const groupRestore = actionButton('Restore group');
      groupRestore.addEventListener(
        'click',
        () => void restore(snapshot, { groupIds: [group.id] }),
      );
      groupRow.append(checkbox, label, groupRestore);
      windowNode.append(groupRow);
      for (const tab of groupTabs) windowNode.append(tabRow(tab));
    }
    for (const tab of windowValue.tabs.filter((item) => !groupedTabs.has(item.id))) {
      windowNode.append(tabRow(tab));
    }
    tree.append(windowNode);
  }
  preview.append(tree);
  const actions = element('div', 'preview-actions');
  const restoreSelected = actionButton('Restore selected tabs', 'button button-secondary');
  restoreSelected.addEventListener('click', () => {
    const tabIds = [...preview.querySelectorAll<HTMLInputElement>('input[data-tab-id]:checked')]
      .map((input) => input.dataset.tabId)
      .filter((value): value is string => Boolean(value));
    if (tabIds.length === 0) {
      announce('Select at least one tab to restore.');
      return;
    }
    void restore(snapshot, { tabIds });
  });
  actions.append(restoreSelected);
  preview.append(actions);
}

function tabRow(tab: Snapshot['windows'][number]['tabs'][number]): HTMLLabelElement {
  const row = element('label', 'tree-tab');
  const checkbox = element('input') as HTMLInputElement;
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.dataset.tabId = tab.id;
  const content = element('span');
  content.append(
    document.createTextNode(`${tab.pinned ? 'Pinned · ' : ''}${tab.title || safeHost(tab.url)}`),
    element('span', 'url-host', safeHost(tab.url)),
  );
  row.append(checkbox, content);
  return row;
}

function selectedCounts(
  snapshot: Snapshot,
  selection?: RestoreSelection,
): { windows: number; tabs: number; groups: number } {
  const windowIds = new Set(selection?.windowIds ?? []);
  const groupIds = new Set(selection?.groupIds ?? []);
  const tabIds = new Set(selection?.tabIds ?? []);
  const unconstrained = windowIds.size + groupIds.size + tabIds.size === 0;
  let windows = 0;
  let tabs = 0;
  let groups = 0;
  for (const windowValue of snapshot.windows) {
    const selectedTabs = windowValue.tabs.filter(
      (tab) =>
        unconstrained ||
        windowIds.has(windowValue.id) ||
        tabIds.has(tab.id) ||
        (tab.groupId !== undefined && groupIds.has(tab.groupId)),
    );
    if (selectedTabs.length === 0) continue;
    windows += 1;
    tabs += selectedTabs.length;
    groups += new Set(selectedTabs.flatMap((tab) => (tab.groupId ? [tab.groupId] : []))).size;
  }
  return { windows, tabs, groups };
}

async function restore(snapshot: Snapshot, selection?: RestoreSelection): Promise<void> {
  const counts = selectedCounts(snapshot, selection);
  if (
    counts.tabs >= 25 &&
    !window.confirm(
      `Open ${plural(counts.tabs, 'tab')} in ${plural(counts.windows, 'new window')} with ${plural(counts.groups, 'group')}? Existing tabs will not be changed.`,
    )
  ) {
    return;
  }
  const operationId = newId();
  const progress = element('div', 'notice', 'Starting restore…');
  const stop = actionButton('Stop opening remaining tabs', 'button button-danger');
  stop.addEventListener(
    'click',
    () =>
      void send({ type: 'STOP_RESTORE', operationId }).then(() => announce('Stopping restore…')),
  );
  preview.prepend(progress, stop);
  try {
    const report = await send<RestoreReport>({
      type: 'RESTORE_SNAPSHOT',
      snapshotId: snapshot.snapshotId,
      ...(selection ? { selection } : {}),
      operationId,
    });
    stop.remove();
    renderRestoreReport(report, progress);
  } catch (error) {
    stop.remove();
    progress.className = 'error-state';
    progress.textContent = error instanceof Error ? error.message : 'Restore failed.';
  }
}

function renderRestoreReport(report: RestoreReport, container: HTMLElement): void {
  container.replaceChildren();
  container.className = report.failures.length > 0 ? 'notice notice-warning' : 'notice';
  container.append(
    element('strong', undefined, report.stopped ? 'Restore stopped' : 'Restore complete'),
    element(
      'p',
      undefined,
      `${plural(report.windowsRestored, 'window')}, ${plural(report.tabsRestored, 'tab')}, and ${plural(report.groupsRestored, 'group')} restored. ${plural(report.skippedUrls.length, 'URL')} skipped.`,
    ),
  );
  const details = [
    ...report.differences,
    ...report.failures.map((failure) => `${failure.operation}: ${failure.reason}`),
  ];
  if (details.length > 0) {
    const list = element('ul');
    for (const item of details) list.append(element('li', undefined, item));
    container.append(list);
  }
  announce(report.stopped ? 'Restore stopped.' : 'Restore complete.');
}

function openRename(snapshot: SnapshotSummary): void {
  renameId = snapshot.snapshotId;
  byId<HTMLInputElement>('rename-value').value = snapshot.name;
  byId<HTMLDialogElement>('rename-dialog').showModal();
}

function openExport(snapshotId: string): void {
  exportId = snapshotId;
  byId<HTMLFormElement>('export-form').reset();
  byId<HTMLDialogElement>('export-dialog').showModal();
}

async function toggleSnapshotSync(snapshot: SnapshotSummary, synced: boolean): Promise<void> {
  if (
    !synced &&
    !window.confirm(
      'Remove this encrypted copy from browser sync? Its local copy remains. A deletion marker prevents stale devices from reviving it.',
    )
  ) {
    return;
  }
  try {
    announce(synced ? 'Saving to browser sync…' : 'Removing synced copy…');
    await send({ type: 'SET_SNAPSHOT_SYNC', snapshotId: snapshot.snapshotId, synced });
    announce(
      synced
        ? 'Saved to browser sync. This does not confirm delivery to another device.'
        : 'Synced copy removed; local copy retained.',
    );
    await Promise.all([loadStatus(), loadSnapshots()]);
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Could not change sync status.');
  }
}

async function deleteSnapshot(snapshot: SnapshotSummary): Promise<void> {
  if (!window.confirm(`Delete “${snapshot.name}”? This cannot be undone.`)) return;
  try {
    await send({ type: 'DELETE_SNAPSHOT', snapshotId: snapshot.snapshotId });
    announce('Snapshot deleted.');
    await loadSnapshots();
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Could not delete the snapshot.');
  }
}

byId<HTMLFormElement>('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const passphrase = byId<HTMLInputElement>('setup-passphrase');
  const confirmation = byId<HTMLInputElement>('setup-passphrase-confirm');
  if (passphrase.value !== confirmation.value) {
    announce('Passphrases do not match.');
    confirmation.focus();
    return;
  }
  void (async () => {
    setBusy(form, true);
    try {
      await send({
        type: 'SETUP_VAULT',
        passphrase: passphrase.value,
        deviceLabel: byId<HTMLInputElement>('setup-device-label').value,
      });
      form.reset();
      announce('Encrypted vault created. Keep your passphrase somewhere safe.');
      await initialize();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not create the vault.');
    } finally {
      setBusy(form, false);
    }
  })();
});

byId<HTMLFormElement>('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void (async () => {
    setBusy(form, true);
    try {
      const consentGranted = await browser.requestFirefoxSyncDataConsent();
      await send({
        type: 'JOIN_SYNC',
        passphrase: byId<HTMLInputElement>('join-passphrase').value,
        consentGranted,
      });
      form.reset();
      announce('Joined the synced vault. Received snapshots are never restored automatically.');
      await initialize();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not join the synced vault.');
    } finally {
      setBusy(form, false);
    }
  })();
});

byId<HTMLFormElement>('unlock-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void (async () => {
    setBusy(form, true);
    try {
      const input = byId<HTMLInputElement>('unlock-passphrase');
      await send({ type: 'UNLOCK', passphrase: input.value });
      form.reset();
      announce('Unlocked.');
      await initialize();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not unlock TabBridge.');
    } finally {
      setBusy(form, false);
    }
  })();
});

lockButton.addEventListener('click', () => {
  void (async () => {
    await send({ type: 'LOCK' });
    byId<HTMLFormElement>('unlock-form').reset();
    byId<HTMLFormElement>('passphrase-form').reset();
    snapshots = [];
    selectedId = undefined;
    announce('TabBridge locked and session key material cleared.');
    await loadStatus();
  })();
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab-button')) {
  tab.addEventListener('click', () => {
    const section = tab.dataset.section;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.tab-button')) {
      button.classList.toggle('is-active', button === tab);
    }
    for (const view of document.querySelectorAll<HTMLElement>('.section-view')) {
      view.hidden = view.id !== `${section}-section`;
    }
  });
}

searchInput.addEventListener('input', renderList);
sortSelect.addEventListener('change', renderList);
byId<HTMLButtonElement>('import-button').addEventListener('click', () => {
  byId<HTMLFormElement>('import-form').reset();
  byId<HTMLDialogElement>('import-dialog').showModal();
});

byId<HTMLFormElement>('rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitter = (event as SubmitEvent).submitter;
  const dialog = byId<HTMLDialogElement>('rename-dialog');
  if (!(submitter instanceof HTMLButtonElement) || submitter.value === 'cancel') {
    dialog.close();
    return;
  }
  if (!renameId) return;
  void (async () => {
    try {
      await send({
        type: 'RENAME_SNAPSHOT',
        snapshotId: renameId as string,
        name: byId<HTMLInputElement>('rename-value').value,
      });
      dialog.close();
      announce('Snapshot renamed.');
      await loadSnapshots();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not rename the snapshot.');
    }
  })();
});

byId<HTMLFormElement>('export-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitter = (event as SubmitEvent).submitter;
  const dialog = byId<HTMLDialogElement>('export-dialog');
  if (!(submitter instanceof HTMLButtonElement) || submitter.value === 'cancel') {
    dialog.close();
    return;
  }
  if (!exportId) return;
  void (async () => {
    try {
      const result = await send<ExportResponse>({
        type: 'EXPORT_SNAPSHOT',
        snapshotId: exportId as string,
        passphrase: byId<HTMLInputElement>('export-passphrase').value,
      });
      const url = URL.createObjectURL(new Blob([result.contents], { type: result.mediaType }));
      const anchor = element('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      dialog.close();
      announce('Encrypted export created.');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not export the snapshot.');
    }
  })();
});

byId<HTMLFormElement>('import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitter = (event as SubmitEvent).submitter;
  const dialog = byId<HTMLDialogElement>('import-dialog');
  if (!(submitter instanceof HTMLButtonElement) || submitter.value === 'cancel') {
    dialog.close();
    return;
  }
  const file = byId<HTMLInputElement>('import-file').files?.[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    announce('The import file exceeds the 25 MiB limit.');
    return;
  }
  void (async () => {
    try {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const previewResult = await send<ImportPreviewResponse>({
        type: 'PREVIEW_IMPORT',
        contents,
        passphrase: byId<HTMLInputElement>('import-passphrase').value,
      });
      const confirmed = window.confirm(
        `Import “${previewResult.name}” with ${plural(previewResult.tabCount, 'tab')} in ${plural(previewResult.windowCount, 'window')} and ${plural(previewResult.groupCount, 'group')}? ${previewResult.skipped ? `${plural(previewResult.skipped, 'unsafe URL')} will be removed. ` : ''}${previewResult.importedAsCopy ? 'It will be saved as a new copy because this identity already exists or was deleted.' : ''}`,
      );
      if (!confirmed) return;
      const result = await send<ImportResponse>({
        type: 'IMPORT_SNAPSHOT',
        contents,
        passphrase: byId<HTMLInputElement>('import-passphrase').value,
      });
      dialog.close();
      (event.currentTarget as HTMLFormElement).reset();
      announce(
        `Imported “${result.snapshot.name}”${result.skipped ? `; removed ${plural(result.skipped, 'unsafe URL')}` : ''}${result.importedAsCopy ? ' as a new copy' : ''}.`,
      );
      await loadSnapshots();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not import the file.');
    }
  })();
});

byId<HTMLFormElement>('device-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    try {
      await send({
        type: 'UPDATE_SETTINGS',
        patch: { deviceLabel: byId<HTMLInputElement>('device-label').value },
      });
      announce('Device label saved. Existing snapshots remain immutable.');
      await loadStatus();
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not update the device label.');
    }
  })();
});

byId<HTMLInputElement>('discard-tabs').addEventListener('change', (event) => {
  const checked = (event.currentTarget as HTMLInputElement).checked;
  void send({ type: 'UPDATE_SETTINGS', patch: { discardBackgroundTabs: checked } })
    .then(() => announce('Restore setting saved.'))
    .catch((error: unknown) =>
      announce(error instanceof Error ? error.message : 'Could not save.'),
    );
});

byId<HTMLInputElement>('sync-enabled').addEventListener('change', (event) => {
  const input = event.currentTarget as HTMLInputElement;
  void (async () => {
    input.disabled = true;
    try {
      const consentGranted = input.checked ? await browser.requestFirefoxSyncDataConsent() : true;
      await send({ type: 'SET_SYNC_ENABLED', enabled: input.checked, consentGranted });
      announce(
        input.checked
          ? 'Browser Sync enabled. This does not confirm delivery to another device.'
          : 'Browser Sync disabled. Existing synced records are not automatically deleted.',
      );
      await Promise.all([loadStatus(), loadSnapshots()]);
    } catch (error) {
      input.checked = !input.checked;
      announce(error instanceof Error ? error.message : 'Could not change sync mode.');
    } finally {
      input.disabled = false;
    }
  })();
});

byId<HTMLFormElement>('passphrase-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const current = byId<HTMLInputElement>('old-passphrase');
  const next = byId<HTMLInputElement>('new-passphrase');
  const confirmation = byId<HTMLInputElement>('new-passphrase-confirm');
  if (next.value !== confirmation.value) {
    announce('New passphrases do not match.');
    confirmation.focus();
    return;
  }
  if (!window.confirm('Re-encrypt every snapshot with the new passphrase? Keep this page open.'))
    return;
  void (async () => {
    setBusy(form, true);
    try {
      announce('Changing passphrase and verifying every snapshot…');
      await send({
        type: 'CHANGE_PASSPHRASE',
        oldPassphrase: current.value,
        newPassphrase: next.value,
      });
      form.reset();
      announce('Passphrase changed. Old encrypted generations were removed after verification.');
      await initialize();
    } catch (error) {
      announce(
        error instanceof Error ? error.message : 'Passphrase change failed; original data remains.',
      );
    } finally {
      setBusy(form, false);
    }
  })();
});

browser.raw.runtime.onMessage.addListener((...arguments_: unknown[]) => {
  const [message] = arguments_;
  if (typeof message !== 'object' || message === null) return;
  const candidate = message as { type?: unknown; progress?: { message?: unknown } };
  if (candidate.type === 'RESTORE_PROGRESS' && typeof candidate.progress?.message === 'string') {
    announce(candidate.progress.message);
  }
});

async function initialize(): Promise<void> {
  try {
    await loadStatus();
    if (status?.configured && !status.locked) await loadSnapshots();
  } catch (error) {
    headerStatus.textContent = 'Error';
    errorState(
      workspace.hidden ? onboarding : workspace,
      error instanceof Error ? error.message : 'TabBridge could not start.',
    );
  }
}

resetPreview();
bindPassphraseVisibility(document);
void initialize();
