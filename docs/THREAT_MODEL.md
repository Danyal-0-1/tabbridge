# TabBridge threat model

This model covers TabBridge version 1 on desktop Chrome and Firefox. It states intended security
invariants, attack assumptions, and residual risks. It does not claim “100% secure,” and it does not
treat a documented control as verified until the corresponding tests have run against the release
artifact.

## Security and privacy goals

1. Keep snapshot contents confidential at rest in extension storage, in browser-account sync, and in
   exported files without the passphrase.
2. Detect a wrong passphrase and any modification of authenticated encrypted content before use.
3. Never execute imported data or restore a URL outside the `http:`/`https:` policy.
4. Exclude private/incognito browsing and avoid unrelated browser data.
5. Preserve the last committed readable snapshot across quota, interruption, and partial-write
   failures.
6. Never open tabs without an explicit user restore action and never close or replace existing tabs
   as part of transfer.
7. Minimize privileges and external trust: no host access, content scripts, backend, telemetry,
   remote code, or runtime network dependency.
8. Make release artifacts traceable, deterministic as practical, free of secrets/development files,
   and produced by least-privilege automation.

## Assets

- Full URLs, including query strings/fragments that may contain secrets.
- Tab and group titles, snapshot names, device labels, and workspace structure.
- Vault/export passphrases and derived AES keys.
- Integrity and availability of local and synchronized snapshots.
- User intent: which snapshots are synchronized and which tabs are restored.
- Browser extension identity, signing keys, store credentials, GitHub tokens, and release artifacts.
- User trust in the displayed lock, sync, error, and restore status.

## Actors and trust boundaries

### Trusted for version 1

- The reviewed TabBridge source and the exact packaged artifact derived from it.
- Web Crypto, Compression Streams, WebExtension APIs, and the browser's extension isolation when the
  browser/OS profile is not compromised.
- User-entered passphrases and explicit save/sync/import/restore choices.

### Partially trusted

- `storage.local`, `storage.session`, and `storage.sync`: values can be missing, stale, reordered,
  quota-rejected, or modified, so every value is validated and encrypted content is authenticated.
- Google or Mozilla browser sync: trusted to transport bytes on a best-effort basis, not trusted
  with plaintext and not treated as a delivery-confirmation service.
- Imported `.tabbridge` files: entirely attacker-controlled until every check completes.
- Captured website-controlled titles and URLs: hostile strings, even when captured locally.
- npm, GitHub Actions, browser stores, and signing systems: necessary supply-chain services with
  minimized credentials and independently inspectable output.

### Out of the extension's defensive reach

- An attacker who controls the operating system, browser process/profile, or device while the vault
  is unlocked.
- A keylogger or screen reader with equivalent system privileges.
- A malicious browser/extension platform or another extension able to defeat browser isolation.
- A recipient who has both an export and its correct passphrase.
- The network and privacy behavior of a website after the user restores its URL.

## Data-flow trust boundaries

```text
web-controlled tab metadata
  → privileged browser API
  → capture validation / URL policy
  → plaintext snapshot in extension memory
  → compression + authenticated encryption
  → untrusted local/sync byte storage

untrusted .tabbridge file
  → bounded parser and exact schema
  → digest + AES-GCM authentication
  → bounded decompression + snapshot validation
  → preview/confirmation
  → encrypted local commit

authenticated snapshot
  → restore planner / URL policy again
  → explicit confirmation
  → browser creates new tabs/windows
  → restored websites receive requests from the browser
```

## Threats, controls, and residual risk

### Malicious imports and UI injection

Threats include oversized files, excessive nesting, huge arrays/strings, invalid UTF-8 or Base64,
prototype-pollution keys, gzip bombs, script-like labels, and URLs intended to trigger privileged
schemes or network fetches during preview.

Required controls:

- reject the file by byte size before expensive parsing or KDF work;
- accept only plain JSON objects with exact keys and bounded depth/count/string values;
- reject `__proto__`, `prototype`, and `constructor` at every level;
- bound decoded ciphertext and decompressed output before allocating unbounded memory;
- require canonical Base64, exact 16-byte salts, 12-byte IVs, 32-byte digests, and a PBKDF2 range of
  600,000–2,000,000 before invoking cryptography;
- authenticate before parsing plaintext;
- render all strings with `textContent`/safe DOM properties, never `innerHTML`;
- never `eval`, construct code, dynamically import a URL, fetch a favicon, or follow a captured URL
  in preview;
- reapply the `http:`/`https:` policy before commit and again before restore; and
- mutate storage only after the complete file has passed validation.

Residual risk: parsing and PBKDF2 intentionally consume CPU/memory. Limits reduce denial of service
but cannot make hostile local input free. The streaming decompressor cancels before exceeding its 32
MiB output bound; release tests still need a compression-bomb fixture that proves the bound.

### Wrong passphrase or modified ciphertext

Threats include changes to ciphertext, GCM tag, IV, AAD-bound IDs/versions, digest, chunk
order/length, KDF parameters, or gzip bytes.

Controls:

- AES-256-GCM with a fresh 96-bit IV and 128-bit tag;
- PBKDF2-HMAC-SHA-256 with a random 128-bit salt and 600,000 producer iterations;
- AAD binds format/encryption/schema versions and snapshot/generation IDs;
- SHA-256 detects chunk assembly corruption before decryption;
- constant-work comparison for equal-length digest bytes;
- post-decrypt UUID consistency and exact schema validation; and
- generic user errors that do not expose decrypted content.

Residual risk: PBKDF2 cannot make a weak passphrase strong. An attacker with a vault verifier or
export can attempt guesses offline. The 12-character UI minimum is only a floor; users need a long,
unique passphrase. Future hardware may require a format migration to a stronger KDF.

### Lost passphrase

There is deliberately no account, recovery key escrow, secret question, or developer recovery path.
A forgotten passphrase means data loss. The UI must communicate this before vault creation and
passphrase change. Documentation and export UX encourage the user to keep an independent secure
record.

### Key exposure and lock races

Derived key material exists in extension memory and can be stored only in trusted-context
`storage.session`. Local/sync storage, logs, exports, UI messages, and error objects must never
contain it. Storage access levels are hardened where the browser implements that API.

Lock clears session entries and drops in-memory references. Operations check authorization again
before publishing a manifest because Web Crypto work cannot be cancelled after it starts. JavaScript
garbage collection and memory copying mean Lock cannot promise physical zeroization.

Residual risk: any code already executing in a compromised trusted extension context while unlocked
can use the key. Firefox may not implement every Chrome storage-access-level control; absence of
content scripts reduces exposure but does not replace browser isolation.

### URLs containing secrets

TabBridge stores the complete eligible URL so it can reproduce the workspace. A query parameter or
fragment can contain a token. Encryption protects that value in TabBridge storage and exports, and
production logs must redact query strings. It does not remove the URL from browser history, sync
features outside TabBridge, operating-system swap/backups, or the destination website request.

Users should avoid snapshotting one-time sign-in links or export the workspace only with a strong
passphrase. Restoring a URL can trigger server-side actions according to that site's design;
confirmation and selection let the user omit it.

### Private/incognito leakage

Manifests disallow private browsing where supported, capture requests query normal windows, and
capture logic independently rejects private/non-normal windows and tabs. Tests simulate manual
private-access grants so defense does not rely only on manifest policy.

Residual risk: a normal tab may itself contain sensitive material; “normal” does not mean public.

### Sync conflicts, deletion, and stale delivery

Browser sync is eventually consistent. Values can arrive chunk-first or manifest-first, and Firefox
may resolve writes per key. A stale device can re-upload older state.

Controls:

- immutable generation-specific chunk keys;
- small manifest published only after verified chunks;
- complete-record assembly before mirroring;
- vault UUID checks;
- logical UUIDs instead of runtime IDs;
- user-selected sync only and no automatic restore;
- tombstones written before synced removal; and
- deterministic conflict behavior rather than arrival-order assumptions.

Residual risk: WebExtension sync has no remote acknowledgement or per-device cursor. A tombstone may
consume quota indefinitely, and a user clearing sync data can intentionally remove that protection.
Concurrent rename/passphrase operations need explicit regression coverage; silent last-writer data
loss is unacceptable.

### Quota, throttling, and partial writes

Storage writes can reject, partially become visible across devices, or lose their callback
acknowledgement. Sync has small byte/item capacity and Chrome rate limits.

Controls:

- exact UTF-8 estimate per key/value plus conservative 7,000-character chunks;
- 102,400-byte, 8,192-byte/item, and 512-item preflight;
- batch chunk writes, readback verification, and manifest-last publication;
- previous generation retained until replacement verification;
- cleanup restricted to known abandoned or safely superseded generations;
- serialized sync mutations spaced by at least 2.1 seconds with the last successful write time
  persisted locally across background restarts; and
- clear quota error that keeps the local snapshot and offers export.

Residual risk: quota can change after preflight and rate limits can vary. The implementation must
treat browser errors as normal recoverable outcomes. Persistent pacing reduces known bursts but does
not guarantee a vendor will accept a write; release tests must cover background restarts and
failures after every commit phase.

### Compromised browser profile or device

Encryption helps when an attacker obtains stored bytes without the passphrase. It does not protect
an unlocked vault from code or a person controlling the browser profile/OS, nor prevent such an
attacker from changing the extension itself or recording the passphrase. Full-disk encryption, a
protected OS account, browser updates, and locking TabBridge reduce exposure but are outside
application enforcement.

### Browser vendor and account compromise

Google/Mozilla receive encrypted extension values when Browser Sync is enabled and may observe
account, timing, record IDs, and sizes. A compromised browser account may expose ciphertext,
deletion markers, and the vault verifier for offline guessing, or inject stale/modified data.
AES-GCM and schema validation protect confidentiality/authenticity without a guessed key; they do
not hide all metadata or guarantee availability.

TabBridge never claims to know the signed-in account or that a remote device received a record.

### Dependency and build compromise

Threats include a malicious/transitively compromised npm package, lifecycle script, source-control
action, runner, artifact substitution, leaked release token, or signing-key theft.

Controls:

- exact dependency versions and committed lockfile;
- minimal/no runtime dependencies and no remote runtime code;
- `npm ci`, license/advisory review, and archive allowlisting;
- GitHub Actions pinned to immutable commit SHAs;
- read-only workflow permissions by default, no secrets for pull-request code, no
  `pull_request_target` execution of untrusted code;
- separate release job with `contents: write` only at publication;
- normalized deterministic ZIPs built twice and byte-compared;
- SHA-256 checksums, manifest validation, artifact inspection, and tag/version checks; and
- human approval for Chrome Web Store and AMO upload/signing.

Residual risk: a pinned action or compiler can already be compromised, and ordinary SHA-256
checksums do not authenticate an artifact by themselves. Protect repository administration, require
review, monitor provenance, and rotate exposed credentials.

### Release secrets

Private `.pem` files, AMO/CWS credentials, GitHub tokens, passphrases, and real browser data must
never enter commits, test fixtures, caches, logs, or workflow artifacts. Public Chrome manifest keys
and Firefox Gecko IDs are identifiers, not signing secrets. If a secret is exposed, revoke/rotate it
immediately; deleting a commit does not make the credential safe again.

## Security test requirements

A release must have actual results for at least:

- known-answer/round-trip crypto, Unicode, unique IVs, wrong keys, and bit flips in every
  authenticated component;
- plaintext scans of local, sync, and export serialization using a unique
  URL/title/name/group/device marker;
- lock/session behavior and a lock immediately before commit;
- import file, depth, count, string, KDF, decoded-size, and decompression-bomb bounds;
- every prototype-pollution key and script-like strings rendered as text;
- every blocked URL scheme and no preview fetch;
- chunk boundary, per-item/total/item-count quota, reordered/missing/extra chunks, and storage
  callback errors;
- interruption before/after each prepare/publish/readback phase while preserving the prior
  generation;
- manifest/chunk delivery in either order, deterministic conflicts, and tombstone/stale-device
  cases;
- passphrase rotation failure at every phase; and
- final Chrome/Firefox archive scans for secrets, unexpected files, remote URLs, source maps, and
  permission drift.

Skipped or unavailable tests are release risks and must be written as such in release notes, never
represented as passes.
