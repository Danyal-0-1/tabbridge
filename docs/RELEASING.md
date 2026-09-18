# Releasing TabBridge

This is the human release procedure. It deliberately separates build success, browser acceptance,
GitHub publication, and browser-store publication. No step is considered complete without its actual
output or reviewer record.

## Release prerequisites

- The repository owner and public remote are known and authorized. Do not invent an owner or push
  destination.
- GitHub Private Vulnerability Reporting is enabled and the Code of Conduct has a sustainable
  confidential route.
- The release version and tag use SemVer. The initial pair is package version `0.1.0` and tag
  `v0.1.0`.
- `package.json`, both manifests, artifact names, and `CHANGELOG.md` agree on the version.
- The changelog heading is changed from `Unreleased` to the actual UTC release date only when
  publication occurs.
- The tree contains no placeholder links, fake screenshot, fake result, secret, signing key, store
  credential, personal data, or unresolved implementation marker.
- Production installation text names only store listings that actually exist.
- The browser versions in the manifests match the tested range; Firefox is at least `140.0` for
  built-in data consent plus tab groups.

Use Node `24.21.0` as pinned by `.nvmrc` and a compatible npm. The release environment must fail,
not silently substitute another version, if that pin is unavailable. Install exclusively from the
committed lockfile:

```sh
node --version
npm --version
npm ci
```

Review `npm audit` output and all direct/transitive licenses. An audit finding is input to a risk
decision, not proof that a build is safe or unsafe. Update `THIRD_PARTY_NOTICES.md` from the final
lockfile and inspect whether any dependency entered the extension bundle.

## Automated gate

From a clean clone at the candidate commit:

```sh
npm ci
npm run check
npm run test:e2e
```

`npm run check` must actually run formatting, lint, TypeScript checking, unit/integration/security
tests, both production builds, manifest validation, Firefox lint, and deterministic packaging. If
`test:e2e` is intentionally separate, run it after the build and record the browser version.

Firefox lint fails on every error, notice, or warning except
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`. That one warning is narrowly allowlisted in the
validation script because Mozilla's linter currently infers an Android minimum from the desktop-only
manifest even when `gecko_android` is deliberately absent. The separate manifest validator fails if
Android compatibility is added. This is tracked in
[mozilla/web-ext#3561](https://github.com/mozilla/web-ext/issues/3561). Remove the allowlist when
the upstream linter issue is fixed. If reliable Firefox extension automation is unavailable, perform
and record the manual Firefox matrix below; label it manual, not automated.

Record:

- candidate commit and tag;
- clean-clone location/runner image;
- Node, npm, Chrome/Chromium, Firefox, and `web-ext` versions;
- every command and exit code;
- tests skipped and reason;
- artifact hashes; and
- reviewers for permission, privacy, threat-model, and manual-browser checks.

## Manifest audit

Inspect both generated `manifest.json` files, not only source templates.

Both builds must have:

- Manifest V3;
- exactly `storage`, `tabs`, and `tabGroups` in top-level `permissions`;
- no host or optional host permissions;
- no content scripts;
- no `cookies`, `history`, `identity`, `bookmarks`, `webRequest`, `scripting`, clipboard, downloads,
  or native messaging;
- `incognito: "not_allowed"`;
- a strict extension-pages CSP with no remote script/style source and no unsafe executable source;
- only existing local icon/popup/manager/background assets; and
- no update URL or externally connectable surface not explicitly approved.

Chrome must use only `background.service_worker`. A committed manifest `key`, if used for stable
unpacked identity, is the public key only; no `.pem` belongs in the repository. The Chrome Web Store
assigns the production identity.

Firefox must use only `background.scripts`/event-page semantics and a stable fixed
`browser_specific_settings.gecko.id`. Changing the Gecko ID breaks the sync identity. Its settings
must include:

```json
{
  "id": "{bf90e8ec-cdc7-4385-9bd9-19cac28c37c0}",
  "strict_min_version": "140.0",
  "data_collection_permissions": {
    "required": ["none"],
    "optional": [
      "browsingActivity",
      "websiteContent",
      "technicalAndInteraction",
      "personallyIdentifyingInfo"
    ]
  }
}
```

Confirm that Firefox exposes `technicalAndInteraction` as its special optional category during the
installation/permissions experience and requests the remaining optional categories from the user's
Enable Sync gesture; no snapshot may enter sync before all needed consent is granted. Denial must
leave local-only behavior usable. `personallyIdentifyingInfo` is included because Mozilla's taxonomy
says identifying information can be actively user-supplied and includes names; snapshot names and
device labels are free text. Re-check the category mapping against Mozilla's current
[built-in data-consent documentation](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
and [Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) before
an AMO submission; category definitions and policy can change.

## Manual browser acceptance

Use throwaway Chrome and Firefox profiles with synthetic URLs only. Test the exact files in `dist/`
and then repeat critical installation/startup checks with the packaged files where the browser
permits it.

### Chrome desktop

1. Load `dist/chrome` unpacked in the declared minimum/current stable Chrome.
2. Verify the permission prompt contains no permission outside the documented set.
3. Complete first run; verify the exact local/sync, no-server, separate-ecosystem, desktop-only, and
   lost-passphrase disclosures.
4. Save current window, all windows, and current tab with normal, duplicate, pinned, active,
   grouped/ungrouped, Unicode, and blocked-scheme fixtures.
5. Confirm private windows are absent even when extension incognito access is manually allowed.
6. Rename, search/sort, preview, delete with confirmation, and exercise
   empty/locked/loading/offline/quota/corrupt/error states.
7. Restore all and selected windows/groups/tabs into new windows. Confirm existing tabs remain,
   duplicate/order/pin/active/group state, large-restore confirmation, cancellation, partial
   failures, and optional discard behavior.
8. Export, wrong-passphrase/tamper-test, inspect the authenticated import preview, cancel once, then
   confirm import; verify no storage mutation on failed or cancelled import.
9. Enable Browser Sync, select a snapshot, and verify the wording is “Saved to browser sync,” not
   remote delivery.
10. With the same stable extension identity and a separate synced Chrome profile/device, wait for
    browser sync, unlock, and verify no automatic restore.
11. Lock, restart/reload the service worker, and verify session/key and durable-state behavior.

### Firefox 140+

1. Run the Firefox lint gate, then temporarily load `dist/firefox/manifest.json` from
   `about:debugging`.
2. Repeat the core capture/restore/import/export/private-window/lock checks above.
3. Verify current tab groups capture and restore on the tested Firefox version and graceful fallback
   behavior if APIs are feature-disabled.
4. Verify the install/permissions UI exposes optional technical/interaction consent. Enable Browser
   Sync from its user gesture and verify Firefox requests the other optional transmission
   categories; Deny must leave local mode working and produce no sync write.
5. Confirm the Firefox background event page resumes correctly after suspension/reload; no
   service-worker-only global is assumed.
6. With the same Gecko ID, Mozilla account, and Add-ons Sync enabled on another desktop Firefox
   profile/device, verify eventual encrypted record receipt/unlock and no automatic restore.
7. Record that temporary installation is not evidence that an unsigned ZIP can be installed by
   ordinary users. Test the Mozilla-signed package before production publication.

### Cross-browser and failure matrix

- Export synthetic grouped workspaces in Chrome and import in Firefox, then reverse the direction.
- Inspect the raw local/sync/export serialization for unique plaintext URL, title, snapshot, group,
  and device markers; none may appear.
- Trigger per-item, total-byte, item-count, write-rate, missing-chunk, corrupt-manifest, and
  interruption failures. The previous committed snapshot must remain usable.
- Deliver sync chunks/manifest in both orders and retry after background restart.
- Test concurrent rename/delete/tombstone behavior and interrupted passphrase rotation.
- Verify no runtime request reaches a TabBridge, analytics, advertising, crash, CDN, font, favicon,
  or captured-site endpoint before explicit restore.

## Artifact inspection

Expected initial outputs:

```text
dist/chrome/
dist/firefox/
artifacts/tabbridge-chrome-v0.1.0.zip
artifacts/tabbridge-firefox-v0.1.0.zip
artifacts/tabbridge-chrome-v0.1.0.zip.sha256
artifacts/tabbridge-firefox-v0.1.0.zip.sha256
artifacts/SHA256SUMS
```

For each ZIP:

- `manifest.json` is at archive root, not under a containing directory;
- each file byte-for-byte matches its `dist/<browser>` counterpart;
- all paths are relative, canonical, sorted by UTF-8 byte order, unique, and free of `..`, absolute
  paths, backslashes, or symlinks;
- entries have a fixed DOS-compatible timestamp, fixed regular-file mode, no variable extra fields,
  and no archive comment;
- the ZIP method is the repository's fixed method (STORE/no compression for cross-zlib
  reproducibility);
- no `.map`, tests, source TypeScript, dotfiles, lockfile, credentials, `.pem`, log, browser
  profile, or undeclared asset is present; and
- checksums use lowercase SHA-256 and verify with `(cd artifacts && sha256sum -c SHA256SUMS)`.

Use `unzip -l`, `zipinfo -v`, and an extraction into a fresh temporary directory for inspection.
Never extract an untrusted archive over the working tree.

## Reproducibility check

Package twice from the same clean candidate, keeping the first outputs outside the repository, then
compare bytes:

```sh
release_compare_dir="$(mktemp -d)"
npm run build
npm run package
cp artifacts/*.zip artifacts/*.sha256 artifacts/SHA256SUMS "$release_compare_dir"/
npm run build
npm run package
cmp "$release_compare_dir/tabbridge-chrome-v0.1.0.zip" artifacts/tabbridge-chrome-v0.1.0.zip
cmp "$release_compare_dir/tabbridge-firefox-v0.1.0.zip" artifacts/tabbridge-firefox-v0.1.0.zip
(cd artifacts && sha256sum -c SHA256SUMS)
```

Record both hashes. A mismatch blocks release until the variable input (path order, timestamp, mode,
ZIP extras, generated content, or toolchain) is identified. `SOURCE_DATE_EPOCH` is not a substitute
for inspecting actual archive metadata.

## GitHub Actions security

Continuous integration must run on pull requests and pushes to `main` with top-level
`permissions: contents: read`. It uses `npm ci`, runs the complete gate, builds both browser
outputs, and uploads only reviewed artifacts/checksums. Do not use `pull_request_target` to execute
pull-request code and do not expose secrets to forked/untrusted code. Checkout uses
`persist-credentials: false`.

The release workflow triggers only for a version tag. Its build/test job remains read-only and
produces an artifact bundle. A separate publication job downloads and verifies that bundle without
checking out or executing repository code, grants only `contents: write`, and exposes `GITHUB_TOKEN`
only to the final `gh release create` step. Store upload is never automatic.

Action references verified against upstream tags on 2026-09-18:

```yaml
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0 # v7.0.1
actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
```

Treat these as immutable reviewed revisions, not floating version selectors. Before updating a SHA,
verify the signed/upstream tag and review the diff. GitHub recommends full-length commit pinning for
action security; also review current
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

GitHub-hosted runners include `gh`; no separate action is needed to create the release. If a script
action becomes necessary, the currently verified `actions/github-script` pin is
`3a2844b7e9c422d3c10d287c895573f7108da1b3` (`v9.0.0`). Prefer the smaller workflow surface.

## Tag and GitHub release

After all evidence and reviews are complete:

1. Finalize the `[0.1.0]` changelog date and release notes. Keep the bracketed version heading:
   `npm run release:prepare` uses it to extract the notes.
2. Commit the release-only metadata change and rerun the gates on that commit.
3. Create a signed or annotated `v0.1.0` tag at that exact commit.
4. Push the commit and tag without force.
5. Let the tag workflow rebuild and verify artifacts; do not upload a developer workstation ZIP as a
   substitute.
6. Publish a GitHub release containing both ZIPs, both per-file checksum files, `SHA256SUMS`, the
   changelog excerpt, install instructions, test/browser evidence, and candid known limitations.
7. Download the published assets into a fresh directory and verify their hashes against the release
   page values.

The release job may use:

```sh
gh release create v0.1.0 \
  artifacts/tabbridge-chrome-v0.1.0.zip \
  artifacts/tabbridge-firefox-v0.1.0.zip \
  artifacts/tabbridge-chrome-v0.1.0.zip.sha256 \
  artifacts/tabbridge-firefox-v0.1.0.zip.sha256 \
  artifacts/SHA256SUMS \
  --verify-tag \
  --notes-file artifacts/RELEASE_NOTES.md
```

`npm run release:prepare -- v0.1.0` validates the tag/version/artifact relationship and creates the
reviewable `artifacts/RELEASE_NOTES.md`; the tag workflow performs the equivalent step and publishes
its downloaded copy from `release-assets/RELEASE_NOTES.md`. This generated file is not a permanent
unresolved template. The workflow must fail if the tag, version, assets, checksums, or notes are
missing.

## Browser-store publication

GitHub publication does not make an installable Firefox/Chrome store release.

- **Chrome:** upload the reviewed Chrome ZIP to the correct Chrome Web Store item, review the
  permission/privacy disclosures, and publish through a human-authorized account. Test the
  store-delivered build and record its assigned stable ID.
- **Firefox:** submit the reviewed Firefox ZIP to AMO for signing with the fixed Gecko ID and
  current data-collection disclosures. Address review findings in source, rebuild, and re-run the
  release process. Test the signed file; ordinary Firefox users should not be told to install an
  unsigned ZIP.

Never place store credentials in the repository and never add automatic store publishing without a
separately reviewed threat-model/workflow change and explicit human approval.

## After release

- Confirm README production links only after listings exist; add real screenshots only from the
  released build and record their browser/commit.
- Verify installation, first run, sync opt-in, and update behavior from each store.
- Preserve the source tag, release evidence, checksums, and store version mapping.
- Monitor private security reports and browser/API policy changes, especially Firefox data consent.
- For a bad release, stop store rollout or issue a higher-version fix. Do not silently replace
  published assets or move an existing tag.
