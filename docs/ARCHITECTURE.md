# TabBridge architecture

This document describes the version-1 design and the invariants a release is expected to satisfy. It
is not, by itself, evidence that a particular build passed its tests; release evidence is recorded
through [RELEASING.md](RELEASING.md).

## System boundaries

TabBridge is a Manifest V3 WebExtension with no application backend.

```text
popup / manager pages
        │ typed runtime messages
        ▼
background service
        ├── shared core: capture, schema, crypto, URL policy, restore
        ├── browser adapter: Chrome callback APIs / Firefox Promise APIs
        ├── local repository ──► storage.local
        ├── session vault ─────► storage.session when available
        └── sync repository ───► storage.sync ──► browser-vendor sync

manager export/import ◄──── user-controlled encrypted .tabbridge file
```

Google or Mozilla may carry encrypted `storage.sync` values after the user opts in. They are outside
the extension process and are not a TabBridge server. The extension does not call store, telemetry,
favicon, website, CDN, or analytics endpoints at runtime.

## Source organization

| Area                        | Responsibility                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/background/`           | Long-lived operations expressed as restart-safe message handlers; synchronous event-listener registration.                                                                       |
| `src/popup/`                | Compact save/status/recent-snapshot UI. It sends requests; it does not own durable state.                                                                                        |
| `src/manager/`              | Search, preview, selective restore, import/export, sync, passphrase, quota, and settings UI.                                                                                     |
| `src/core/`                 | Browser-independent types, exact schema validation, capture transformation, restore planning/execution, URL policy, compression, cryptography, encoding, errors, and migrations. |
| `src/platform/`             | Promise-shaped adapter over Chrome callback APIs and Firefox Promise APIs; browser feature detection.                                                                            |
| `src/storage/`              | Settings, vault/session key handling, encrypted snapshot repository, record chunking/commit, and sync boundary.                                                                  |
| `manifests/`                | Separate Chrome and Firefox MV3 inputs.                                                                                                                                          |
| `scripts/`                  | Builds, manifest validation, tests, deterministic packaging, and smoke automation.                                                                                               |
| `public/` and `src/styles/` | Local-only HTML/CSS/icons; no remotely loaded runtime assets.                                                                                                                    |

Core modules accept small interfaces, so tests can simulate browser failures without installing an
extension. UI text is untrusted at render time even when it originated locally; pages use DOM text
properties rather than HTML injection.

## Extension contexts

### Background

Chrome uses `background.service_worker`. Firefox uses `background.scripts` because Firefox does not
currently implement Manifest V3 extension service workers as a drop-in replacement. Shared
background code therefore has no DOM or `window` dependency.

Runtime message, `storage.onChanged`, and installation listeners are registered synchronously when
the module is evaluated. Important data lives in extension storage, not only in module globals. A
global may optimize or serialize work during one lifetime, but correctness must survive the
background being terminated and restarted.

The background owns privileged browser operations:

- querying normal windows/tabs/groups;
- encrypting and committing a capture;
- decrypting and planning a preview or restore;
- creating windows, tabs, and groups after explicit confirmation;
- import/export transformation;
- local/sync record movement; and
- vault unlock/lock and passphrase rotation.

### Popup and manager

The popup is intentionally narrow: capture actions, current local/sync and lock state, recent
snapshots, last action, manager navigation, and Lock. Advanced configuration remains in the manager.

The manager owns user interaction for listing/searching/sorting, preview, selection, confirmations,
progress, import/export, device label, sync opt-in, quota, privacy disclosure, and passphrase
operations. It does not bypass the background repository. Reloading a page loses only transient view
state.

Imported names, labels, titles, and URLs are rendered as text. Preview never embeds a captured page,
follows its links, or fetches a favicon.

## Browser adapter

`BrowserAdapter` normalizes the two native API styles into Promises and checks both rejected
Promises and callback-style `runtime.lastError`. It exposes only the operations the application
needs.

Feature detection remains mandatory even above the declared minimum:

- group capture/recreation requires `tabs.group` and `tabGroups.update`;
- background tab discarding requires `tabs.discard`;
- trusted-context storage hardening uses `storage.*.setAccessLevel` where implemented;
- session key caching uses `storage.session` where implemented; and
- Firefox sync opt-in requests transmission consent through
  `permissions.request({data_collection: ...})`.

The only top-level WebExtension API permissions are `tabs`, `tabGroups`, and `storage`. Firefox's
optional transmission categories are separate consent metadata.

## Capture and save flow

```text
explicit user action
  → query current tab/current window/all normal windows
  → exclude private and non-normal windows
  → keep only http/https tabs; count skipped tabs
  → replace native IDs with fresh logical UUIDs
  → exact schema validation
  → UTF-8 JSON
  → gzip
  → AES-256-GCM with a fresh IV and authenticated metadata
  → standard Base64
  → 7,000-character chunks
  → write and read back new chunks
  → write the small manifest last
  → read back and verify the committed record
```

Duplicates are never deduplicated. Capture uses tab index for order and a logical active-tab
reference. Because the browser group API exposes no group index, group order is derived from the
lowest saved member-tab index. Group IDs are translated to logical UUIDs and only referenced groups
are retained. Browser-native tab, window, and group IDs are never durable fields.

A snapshot always enters `storage.local`. Syncing it is a separate explicit operation. If sync quota
preflight fails, the local snapshot remains available and the UI offers encrypted export rather than
truncating it.

## Record commit model

Each storage location has namespaced manifest, chunk, and tombstone records. Chunk keys contain both
snapshot and generation UUIDs. A generation is meant to become visible only through its manifest:

1. Prepare all new generation chunks.
2. Write them as a batch where possible.
3. Read back the exact keys and compare their string values.
4. Publish the manifest after chunk verification.
5. Read the manifest and assembled record back.
6. Remove superseded/orphaned chunks only after the new commit is known good.

The previous manifest must remain recoverable if any step fails. Passphrase rotation prepares and
verifies replacements before publishing new manifests and the new vault config. Crash/failure
injection around every phase is a release-blocking storage test because browser storage APIs do not
provide a transaction primitive.

A tombstone is written before a synced deletion removes the visible manifest/chunks. Its purpose is
to prevent a stale offline copy from silently reappearing. `storage.onChanged` is treated as a hint:
sync values can arrive in any order, so an incomplete record is retried later rather than restored
or exposed.

The sync layer serializes mutations and spaces them by at least 2.1 seconds. It records the last
successful write time in local storage, so a background restart cannot reset the pacing window.
Chrome's documented minute/hour rate limits and restart behavior remain integration-test targets;
the scheduler reduces bursts but does not turn a rejected browser write into success.

## Sync flow

Browser Sync is off by default. Enabling it requires a configured vault and an explicit user action.
Firefox 140+ can expose optional `technicalAndInteraction` consent at installation and requests the
remaining optional `browsingActivity`, `websiteContent`, and `personallyIdentifyingInfo` categories
from the Enable Sync gesture. No snapshot enters sync before all needed consent is granted. The last
category is conservative because user-controlled snapshot names and device labels can contain
identifying text.

The local vault configuration is copied to a fixed sync key so another installation can verify the
same passphrase. If an installation already has a different local vault, it does not overwrite
either vault; the user must choose an explicit import/join path.

Only snapshots marked by the user are copied from the verified local record store into the sync
namespace. The extension can confirm only that `storage.sync` accepted and returned the written
values. It cannot see a server acknowledgement, the active account, or another device, so the
success wording is “Saved to browser sync.”

`storage.onChanged` causes a namespace rescan/mirror attempt. Received ciphertext is mirrored to
local storage only when the record is structurally complete and belongs to the expected vault. No
received snapshot opens tabs automatically.

## Restore flow

```text
explicit restore choice
  → decrypt and validate snapshot
  → apply whole/window/group/tab selection
  → validate and normalize each URL again
  → show large-restore confirmation in the UI
  → create a new normal window
  → create tabs inactive in saved order
  → preserve pinning
  → map logical tab/group IDs to new runtime IDs
  → recreate supported groups and metadata
  → activate the saved active tab last
  → optionally discard eligible background tabs
  → return successes, skips, differences, and failures
```

Cancellation is cooperative. It prevents remaining creation work but never closes tabs/windows
already restored. Individual failures are collected and restoration continues where safe. If group
APIs are absent, order is preserved without groups. A pinned member that cannot remain grouped stays
pinned and is reported as a difference.

## Import and export

Export uses a fresh salt, key derivation, and IV for a standalone UTF-8 JSON `.tabbridge` envelope
(`application/vnd.tabbridge+json`). It does not reuse or expose the stored vault key.

Import is a two-phase operation. Its preview applies the file-size bound,
JSON/plain-object/key/depth/count/string validation, exact format and KDF/cipher checks, canonical
Base64 and cryptographic lengths, digest verification, key derivation, AES-GCM authentication,
bounded UTF-8/gzip decoding, snapshot migration/schema validation, authenticated-ID comparison, and
URL policy. The UI shows the authenticated counts, excluded-URL count, and copy status. Only an
explicit confirmation repeats validation and commits the encrypted local record. An identity that
already exists or has a tombstone is assigned new logical snapshot/generation UUIDs rather than
overwriting or reviving prior data.

## Vault and locking

The local vault config contains a random vault UUID, PBKDF2 parameters, and an AES-GCM encrypted
verifier. It does not contain a passphrase. A successfully derived key is held in memory and, when
available, exported only to trusted-context `storage.session` so a restarted background can continue
during that browser session.

Lock removes session key entries and in-memory references. JavaScript cannot guarantee secure
physical erasure. Long-running operations must check current authorization immediately before
commit; Web Crypto work itself is not cancellable.

Passphrase change is a record migration, not an in-place key edit: decrypt/validate old records,
build new-vault generations, verify prepared chunks, publish synced/local manifest sets with the new
config, then clean old material. A durable non-secret rotation journal identifies interrupted work.
The old readable data must not be deleted until the replacement is verified.

## Build and release boundary

Shared TypeScript is bundled separately into `dist/chrome` and `dist/firefox`. The manifests differ
only where browser behavior requires it:

- Chrome: service worker background and stable Web Store identity for production.
- Firefox: background script/event page, fixed Gecko ID `{bf90e8ec-cdc7-4385-9bd9-19cac28c37c0}`,
  `strict_min_version: "140.0"`, and required/optional data-consent declarations.

The Chrome manifest declares `minimum_chrome_version: "90"`; callback adaptation and feature
detection avoid requiring newer Promise/session-storage variants for correctness.

Manifest validation rejects extra permissions, host permissions, content scripts, remote CSP
sources, private browsing, missing assets, or the wrong background model. Packaging includes only
the built allowlist, orders paths bytewise, and normalizes ZIP timestamp/mode/extra metadata. See
[RELEASING.md](RELEASING.md).

## Known platform limitations

- Standard mobile Chrome cannot install this extension, and Firefox Android does not sync extension
  `storage.sync`.
- Browser sync is capacity-limited, eventually consistent, and has no delivery receipt.
- Chrome and Mozilla sync systems do not interoperate.
- Page state, authentication/session state, and Chrome's closed Saved Tab Groups collection are
  unavailable through the chosen APIs.
- Browser/OS compromise while unlocked defeats extension-level confidentiality.
- Compression Streams are required by format v1; unsupported contexts fail rather than writing a
  falsely labelled payload.
