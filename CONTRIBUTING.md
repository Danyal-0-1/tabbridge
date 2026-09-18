# Contributing to TabBridge

Thank you for helping improve TabBridge. This project handles potentially sensitive URLs and titles,
so privacy, safety, and honest release claims are part of every change—not a final review step.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities
through the private process in [SECURITY.md](SECURITY.md), not through a public issue or pull
request.

## Before opening an issue

- Search existing issues and the changelog.
- Use a bug report for reproducible incorrect behavior and a feature request for product proposals.
- Remove real URLs, titles, device labels, account details, exported files, passphrases, and keys.
- Reproduce with synthetic data such as `https://example.test/path?token=not-a-secret`.
- Do not post a security issue publicly.

## Development setup

Use the repository's pinned Node `24.21.0` from `.nvmrc` and an npm version allowed by
`package.json`. `npm ci` and the committed lockfile are authoritative for dependencies.

```sh
cd tabbridge
npm ci
npm run check
```

Start from a checkout or fork you are authorized to use. The project does not fabricate a public
owner or clone URL before one exists.

Common commands:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:security
npm run build:chrome
npm run build:firefox
npm run validate:manifests
npm run validate:firefox
npm run package
npm run verify:packages
npm run test:e2e
```

`npm run check` is the aggregate static/unit/integration/security/build/package gate defined by
`package.json`. The browser smoke test may remain a separate command because it launches a real
browser. A documented command is not evidence that it passed: record the exact commands,
environment, exit status, and any skipped step in the pull request.

Generated `dist/`, `artifacts/`, browser profiles, and dependency directories are not source and
should not be committed unless a maintainer explicitly requests a release fixture.

## Design constraints

Changes must preserve these boundaries:

- Desktop Chrome 90+ and Firefox 140+ are the supported targets for version 1.
- Transfer is copy-and-restore. Never close or replace existing tabs, remotely close source tabs, or
  restore without an explicit user action.
- Local-only mode makes no network request. Browser Sync is opt-in and uses only the browser's
  `storage.sync` service.
- Chrome and Firefox sync ecosystems do not interoperate; cross-browser transfer uses an encrypted
  `.tabbridge` file.
- Request only `tabs`, `tabGroups`, and `storage`. A new permission or Firefox data category needs
  explicit maintainer approval, a threat-model update, and user-facing justification.
- No host permissions, content scripts, remote code, remote fonts/assets, CDNs, analytics,
  advertisements, tracking, or developer backend.
- Do not add `eval`, `Function`, HTML string injection, or dynamic remote imports.
- Imported strings are hostile. Render them as text, validate exact schemas and bounds, and never
  fetch a URL or favicon for preview.
- Preserve duplicate URLs. Exclude private/incognito content and restore only validated `http:` and
  `https:` URLs.
- Never persist browser runtime tab/window/group IDs as durable identifiers.
- Never persist or log passphrases or decrypted keys outside memory/trusted `storage.session`.
- Background correctness cannot depend on a long-lived global, timer, or page. Chrome service
  workers and Firefox event pages can stop between events.

Before adding a dependency, explain why platform APIs or a small local implementation are
insufficient. Pin its exact version, review its license and install scripts, update
`THIRD_PARTY_NOTICES.md`, and confirm that unnecessary code is absent from both release ZIPs.

## Code and UI

- Keep TypeScript strict and keep business rules independent of browser APIs.
- Put browser differences behind the adapter layer.
- Register background listeners synchronously during module evaluation.
- Use semantic HTML and vanilla CSS unless a different framework has a documented, reviewed
  justification.
- Support keyboard operation, visible focus, WCAG AA contrast, light/dark color schemes, reduced
  motion, and `aria-live` status updates.
- Do not rely on color alone.
- Keep the toolbar popup focused on quick actions and put advanced settings in the manager.
- Avoid source maps and development-only files in release artifacts.

Run formatting through the project command rather than introducing unrelated style churn.

## Tests expected with changes

Add the smallest meaningful regression coverage and include boundary/failure cases. Depending on the
change, that includes:

- capture across multiple windows, duplicates, pin/active/group state, private exclusion, unsafe
  URLs, and Unicode;
- restore selection, logical-to-runtime mapping, order, grouping fallback, cancellation, and partial
  failure;
- encryption round trips, wrong passphrases, tampering, unique IVs, exact salt/IV/digest lengths,
  PBKDF2 limits, and plaintext-leak scans;
- schema bounds, prototype-pollution keys, malicious markup-like strings, invalid UTF-8/base64,
  oversized imports, two-phase preview/cancel/confirm behavior, and bounded decompression;
- chunk boundaries, byte/item quotas, interrupted writes, missing/corrupt records, tombstones,
  collision copies, conflicts, durable throttling across background restarts, and prior-generation
  preservation;
- Chrome manifest/build behavior and a Chromium save → list → restore smoke test; and
- Firefox 140+ manifest/data-consent behavior, group handling, temporary installation, and
  `web-ext lint` with warnings treated as errors.

For user-visible or browser-specific changes, perform the relevant manual checks in
[docs/RELEASING.md](docs/RELEASING.md). Never check a test box merely because somebody else is
expected to run it later.

## Documentation changes

Update documentation in the same pull request when behavior changes:

- `README.md` for user-visible behavior, compatibility, permissions, or limitations;
- `PRIVACY.md` for any processed field, destination, retention, consent, or network behavior;
- `SECURITY.md` and `docs/THREAT_MODEL.md` for changed protections or trust boundaries;
- `docs/DATA_FORMAT.md` for schema, cryptography, keys, limits, or migrations;
- `docs/ARCHITECTURE.md` for component/lifecycle changes;
- `docs/RELEASING.md` for build, validation, or publication changes; and
- `CHANGELOG.md` for a user- or maintainer-visible change.

Only real screenshots from the tested build may be added. Include the browser/version and commit
used to capture them. Do not add mockups as though they are product evidence.

## Pull requests

Keep a pull request focused and explain:

1. the problem and user impact;
2. the chosen approach and important alternatives;
3. privacy, permission, data-format, compatibility, and failure-mode effects;
4. exact automated commands and results;
5. manual Chrome/Firefox checks and results, or why they are not applicable; and
6. follow-up work that is genuinely out of scope.

Use clear commit messages, for example `fix: preserve prior generation after a failed sync commit`.
Do not commit secrets, production browsing data, generated signing material, private `.pem` files,
store credentials, tokens, or passphrases.

Maintainers may ask for changes or decline work that expands version 1 into accounts, a backend,
collaboration, mobile support, automatic periodic capture, or unrelated tab-management features.

## License

By submitting a contribution, you agree that it may be distributed under the repository's
[MIT License](LICENSE). Only submit material you have the right to license, and identify third-party
material and its license explicitly.
