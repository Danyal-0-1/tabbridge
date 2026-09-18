# Changelog

All notable changes to TabBridge will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and released versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

This version remains unreleased until the automated gates, desktop Chrome and Firefox 140+
acceptance tests, reproducibility check, artifact inspection, and signing/publication steps have
actual recorded results.

### Added

- Strict version-1 workspace schema using logical UUIDs for snapshots, generations, windows, groups,
  and tabs.
- Capture rules for current/all normal windows and the active tab, with duplicate, order, pin,
  active-tab, and currently open group metadata preservation.
- Restore planning for whole or selected workspaces, new-window creation, group feature detection,
  cancellation, progress, and partial-failure reporting.
- Local encrypted vault and opt-in browser-sync record layers with chunked encrypted payloads,
  commit manifests, quota preflight, and deletion markers.
- AES-256-GCM encryption, PBKDF2-HMAC-SHA-256 key derivation, gzip-before-encryption, ciphertext
  integrity digests, and encrypted `.tabbridge` import/export format.
- Strict import/schema checks, size/count/string/depth bounds, prototype-pollution-key rejection,
  bounded decompression, canonical cryptographic field lengths, and `http:`/`https:` URL policy.
- Authenticated import preview and confirmation before storage mutation, including safe fresh-copy
  handling for existing or tombstoned snapshot identities.
- Shared promise-based Chrome/Firefox WebExtension adapter and separate Manifest V3 build targets.
- Popup, manager, first-run privacy disclosure, local/sync settings, snapshot management, and
  restore status surfaces.
- Unit, integration, security, manifest, package, browser-smoke, and Firefox lint entry points.
- Deterministic Chrome/Firefox packaging with SHA-256 checksum output.
- Privacy, security, architecture, data-format, threat-model, contribution, community, and release
  documentation.

### Security

- Limited WebExtension API permissions to `tabs`, `tabGroups`, and `storage`, without host
  permissions or content scripts.
- Kept passphrases out of persistent storage and restricted cached key material to memory or
  trusted-context session storage.
- Excluded private/incognito content in manifest policy and capture logic.
- Added no developer backend, analytics, advertising, remote code, or runtime network dependency.
- Added Firefox optional data-transmission consent declarations for explicitly enabled Browser Sync.
- Added durable 2.1-second sync-write pacing across background restarts.

### Changed

- Set the conservative Firefox compatibility floor to 140 so tab-group support and Firefox's
  built-in data-consent flow are both available.
