# Security policy

TabBridge handles URLs and titles that may be sensitive. Please report suspected vulnerabilities
privately and avoid including real browsing data in any report.

## Supported versions

There is not yet a signed public `0.1.0` release. Until one exists, security fixes are applied to
the current `main` development line only; development builds are not represented as
production-supported. When releases begin, this table will identify maintained release lines using
actual published versions rather than forecasts.

## Report a vulnerability

Use the repository's **Security** tab and choose **Report a vulnerability**. Enabling GitHub Private
Vulnerability Reporting is a prerequisite for public repository launch. If that control is
unavailable, do not open a public issue or attach an export file; contact a maintainer through a
private channel already available to you and ask for a confidential reporting path.

Never send:

- a real `.tabbridge` export;
- a passphrase or derived key;
- a complete sensitive URL, title, or device label;
- browser account credentials; or
- a live exploit against another person's installation.

A useful report includes:

- the affected TabBridge version or commit;
- browser name, exact version, operating system, and installation method;
- whether the issue affects local storage, browser sync, import/export, capture, restore, build, or
  release tooling;
- minimal reproduction steps using synthetic data;
- expected and observed behavior;
- impact and realistic attack preconditions;
- a minimal proof of concept, if safe; and
- whether the report or exploit details have been shared elsewhere.

Use a newly created throwaway vault and synthetic URLs such as `https://example.test/` when
reproducing a problem.

## Coordinated handling

Maintainers will acknowledge and triage reports through the private channel when available. Response
and repair timing depends on severity, reproducibility, maintainer availability, browser-store
review, and whether browser-vendor coordination is needed; this project does not promise a fixed
service-level deadline.

Please allow time for investigation and a release before public disclosure. The project will credit
reporters who want credit, unless doing so would expose private information. If a browser or
sync-service vulnerability is involved, coordinated disclosure with Google or Mozilla may be
necessary.

## In scope

Examples include:

- plaintext workspace fields leaking into encrypted local/sync records or export files;
- passphrase or key material being persisted outside trusted session storage;
- AES-GCM IV reuse under the same key;
- authentication, schema, or import-validation bypasses;
- unsafe URL restoration or imported content executing as markup/script;
- private/incognito tab capture;
- a permission, host access, or runtime network request not documented in the privacy model;
- sync conflict, tombstone, quota, or interrupted-write behavior that destroys a previously
  committed snapshot;
- archive contents that include secrets, source maps, development credentials, or unexpected
  executable code;
- compromised dependency or release workflow paths; and
- privilege escalation from an extension page into browser or web content.

## Usually out of scope

The following are normally limitations rather than vulnerabilities unless TabBridge makes a contrary
claim or amplifies them:

- a forgotten passphrase (there is intentionally no recovery);
- data read from an already unlocked vault by a fully compromised browser profile, operating system,
  or equivalent local attacker;
- a user intentionally sharing an encrypted export and its passphrase with the same recipient;
- browser vendor retention, delivery delay, or account compromise outside extension control;
- a restored website observing the browser request to that website;
- denial of service that requires the victim to import an obviously enormous file already rejected
  by documented limits; and
- behavior in modified builds, unsupported mobile browsers, or browser versions below the declared
  minimum.

## Security design

The security boundary and residual risks are documented in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). The serialized formats and authenticated fields are
documented in [docs/DATA_FORMAT.md](docs/DATA_FORMAT.md). Important properties include:

- no TabBridge backend, telemetry, advertisements, or runtime remote code;
- AES-256-GCM authenticated encryption with random IVs;
- PBKDF2-HMAC-SHA-256 with a 600,000-iteration v1 work factor;
- canonical cryptographic fields with exact 16-byte salts, 12-byte IVs, 32-byte digests, and an
  accepted PBKDF2 range capped at 2,000,000 iterations before expensive work;
- authenticated two-phase import with a 25 MiB file limit and streaming 32 MiB decompression bound
  before a confirmed storage commit;
- strict, versioned schemas and fail-closed future versions;
- only `http:` and `https:` restoration;
- encrypted chunks written and verified before a manifest commit;
- private/incognito exclusion in both manifests and code; and
- exact extension permissions limited to `tabs`, `tabGroups`, and `storage`.

These properties must be verified for a release; their presence in documentation is not evidence
that a particular artifact passed testing.

## Dependency and release incidents

Do not place signing keys, store credentials, GitHub tokens, `.pem` files, or user passphrases in an
issue, commit, workflow artifact, or test fixture. If a credential is exposed, revoke or rotate it
before attempting repository cleanup. Do not rewrite public history merely to create the appearance
that a leaked secret is safe.

Release artifacts are reproducibly packaged, checksummed, and published only after automated and
manual gates described in [docs/RELEASING.md](docs/RELEASING.md). Store publication remains a
separate human-approved step.
