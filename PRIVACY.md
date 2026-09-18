# TabBridge privacy notice

Effective: 2026-09-18

TabBridge is designed around data minimization. It has no developer-operated server, project
account, telemetry, analytics, advertising, tracking pixels, or crash-reporting service. The
extension does not make runtime network requests. Optional browser-account sync is provided by the
browser vendor, not by TabBridge.

## Data TabBridge processes

At the user's request, TabBridge can process:

- URLs and titles of eligible tabs;
- window boundaries, tab order, duplicate URLs, pinned and active state;
- currently open tab-group membership, title, color, order, and collapsed state;
- snapshot names and capture warnings;
- a locally generated device UUID and user-editable device label;
- browser family/version and operating-system information available through ordinary extension APIs;
  and
- settings such as sync selection and background-tab discarding.

URLs can contain query parameters, fragments, document identifiers, or access tokens. Treat every
snapshot as sensitive even when its title looks harmless.

TabBridge does not intentionally capture cookies, passwords, form values, page bodies, account
identity, browsing-history databases, page memory, scroll position, media position, full navigation
history, or unsaved page state. It excludes private/incognito and non-normal windows and skips URLs
other than `http:` and `https:`.

## Where data goes

### Local-only mode

Encrypted snapshot records and settings are stored in the browser extension's `storage.local` area.
They remain within the browser profile unless the user exports a file, copies the profile, or
another program with profile access reads it. TabBridge makes no network request in this mode.

### Optional browser-account sync

The user can explicitly select snapshots for `storage.sync`. The browser then transports encrypted
records through its own infrastructure:

- Google infrastructure for compatible Chrome Sync installations; or
- Mozilla infrastructure for compatible Firefox installations with Add-ons Sync enabled.

Chrome Sync and Mozilla Sync are independent and cannot transfer a TabBridge record between Chrome
and Firefox. Sync is eventually consistent; TabBridge cannot see the active browser account, promise
delivery time, or confirm receipt by another device.

Google and Mozilla may process account, service, and operational data under their own terms.
TabBridge does not receive that data.

### Encrypted files

Export creates a `.tabbridge` file on the user's device. The user chooses where it is copied and who
receives it. Import reads a file the user selects; the file is not uploaded by TabBridge and no URL
in it is fetched during preview. TabBridge authenticates, decrypts, validates, and summarizes the
file before asking for confirmation, and it makes no import storage write if that preview fails or
the user cancels.

## Encryption and visible metadata

Snapshot payloads are gzip-compressed and encrypted using AES-256-GCM. Keys are derived from a
passphrase with PBKDF2-HMAC-SHA-256, a random salt, and 600,000 iterations. Every encryption uses a
fresh random 96-bit IV and a 128-bit authentication tag.

URLs, tab titles, snapshot names, group names, and device labels are encrypted. The record envelope
remains unencrypted so the browser can store and reassemble it. Depending on the storage form, the
envelope includes format and schema versions, logical snapshot/generation/vault identifiers,
KDF/cipher parameters, ciphertext length or chunk count, integrity digest, and commit or deletion
timestamps. These can reveal that records exist and their approximate size, but not the decrypted
workspace contents.

The SHA-256 ciphertext digest detects assembly errors; AES-GCM authentication is the security
boundary for modification detection.

## Passphrases and session keys

TabBridge does not transmit, log, or persist a passphrase. It stores a salted verifier so the
passphrase can be checked. Derived key material can be retained only in memory or
trusted-extension-context `storage.session` for the active browser session. The **Lock** action
removes cached session material; browser shutdown also ends the session. JavaScript cannot guarantee
physical memory erasure.

There is no password recovery or secret question. A forgotten passphrase makes the associated
snapshots unreadable. Changing a passphrase must preserve old encrypted records until verified
replacements have been committed.

## Firefox Browser Sync consent

Firefox 140+ requires extensions to declare data-collection categories. TabBridge declares `none` as
required and requests the following optional categories only when the user chooses Browser Sync:

| Firefox category            | Why consent is requested                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `browsingActivity`          | Encrypted snapshot records represent tab URLs and browsing structure.                           |
| `websiteContent`            | Encrypted records can contain page titles and user-named groups.                                |
| `technicalAndInteraction`   | Encrypted records can include source-browser/device metadata and settings used to operate sync. |
| `personallyIdentifyingInfo` | User-controlled snapshot names and device labels can contain names or other identifying text.   |

Firefox may show the optional technical/interaction category during installation; TabBridge requests
the other optional categories from the explicit Enable Sync gesture. The extension writes no
snapshot record to Firefox Sync until sync is enabled and the needed consent is granted. Records
remain encrypted before entering Firefox Sync. Denying consent leaves local storage and encrypted
export/import available. This consent is separate from the extension's `tabs`, `tabGroups`, and
`storage` API permissions.

## Retention and deletion

Local records remain until the user deletes them, clears extension storage, removes the extension
and its data, or the browser/profile removes them. Synced records are also subject to the browser
vendor's synchronization and retention behavior.

Deleting a synced snapshot can leave a minimal encrypted-record deletion marker (snapshot UUID and
deletion time) so an offline device does not resurrect stale data. Browser sync may retain or
propagate older values for some time. An exported file remains wherever the user or receiving
software stored it; deleting a TabBridge record does not delete external copies.

## Logging

Production code must not log passphrases, derived keys, decrypted snapshot payloads, or complete
URLs. Diagnostic error text should redact URL query strings where a URL is necessary. Browser
developer tools, operating-system logs, third-party extensions, or modified builds are outside
TabBridge's control.

## Children, sale, and advertising

TabBridge is a general-purpose developer-distributed utility, not a service directed to children.
The project does not sell personal information, serve advertising, or build user profiles.

## Security limitations

Encryption protects stored and synchronized records from casual disclosure without the passphrase.
It cannot protect data while the vault is unlocked from malware, a compromised browser or
operating-system profile, a malicious extension with sufficient access, a keylogger, or a person
controlling the device. Restoring a URL gives it back to the browser, which may contact that site
and record it in browser history.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full boundaries and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Changes to this notice

A privacy-affecting code change must update this notice and the changelog in the same pull request.
The effective date will change when a revised notice is released. Historical versions remain
available in source control.
