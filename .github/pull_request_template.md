## Summary

<!-- What problem does this solve? Describe user impact and keep the scope focused. -->

## Related issue

<!-- Link an issue when one exists, or explain why this is a self-contained maintenance change. -->

## Behavior and design

<!-- Explain the approach, important alternatives, failure/recovery behavior, and browser differences. -->

## Privacy and security review

- Data fields or plaintext envelope metadata added/changed:
- Storage, retention, sync, export, or network behavior changed:
- WebExtension permission or Firefox data-consent category changed:
- Cryptography, schema, migration, URL policy, or trust boundary changed:
- Dependency, remote asset/code, build, workflow, signing, or release surface changed:
- Threat-model impact and mitigations:

Write `None` only after checking each line. Any new permission, host access, content script, runtime
request, remote asset/code, telemetry, persistent plaintext field, or dependency needs explicit
justification and documentation.

## Automated verification actually run

<!-- List exact commands and actual results. Do not mark an unrun command as passing. Explain failures/skips. -->

| Command                      | Result and environment |
| ---------------------------- | ---------------------- |
| `npm run format:check`       | Not run                |
| `npm run lint`               | Not run                |
| `npm run typecheck`          | Not run                |
| `npm run test:unit`          | Not run                |
| `npm run test:integration`   | Not run                |
| `npm run test:security`      | Not run                |
| `npm run build`              | Not run                |
| `npm run validate:manifests` | Not run                |
| `npm run validate:firefox`   | Not run                |
| `npm run package`            | Not run                |
| `npm run verify:packages`    | Not run                |
| `npm run test:e2e`           | Not run                |

## Manual verification actually performed

<!-- Give exact browser/OS/build and results, or explain why N/A. Screenshots must be real captures from this commit and must contain no private data. -->

- Chrome:
- Firefox 140+:
- Keyboard/screen reader/high contrast or dark mode:
- Local, sync, export/import, lock, quota, error, and partial-failure states relevant to this
  change:
- Artifact/archive inspection relevant to this change:

## Checklist

- [ ] The change preserves copy-and-restore: it never closes/replaces existing tabs or auto-restores
      received data.
- [ ] Private/incognito content remains excluded and only validated `http:`/`https:` URLs can
      restore.
- [ ] Imported or browser-supplied text is rendered as text and causes no preview network request.
- [ ] No passphrase, key, credential, private `.pem`, real browsing data, export, profile, source
      map, or generated secret is committed.
- [ ] Chrome/Firefox lifecycle differences and feature fallbacks are covered where relevant.
- [ ] Tests include success, boundary, interruption, and failure paths appropriate to the change.
- [ ] README/privacy/security/architecture/data format/threat model/release docs are updated, or the
      PR explains why none changed.
- [ ] `CHANGELOG.md` records the user- or maintainer-visible change, or the PR explains why no entry
      is needed.
- [ ] New or changed third-party material and licenses are recorded in `THIRD_PARTY_NOTICES.md`.
- [ ] Every check marked or described as passing was actually run against this commit.

## Release note

<!-- One concise user-facing sentence, or “No user-facing release note.” Do not claim installation, compatibility, sync delivery, or test success without evidence. -->
