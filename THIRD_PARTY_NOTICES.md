# Third-party notices

TabBridge source code is licensed under the [MIT License](LICENSE). This file identifies directly
used third-party development material; it does not replace the copyright notices or license texts
distributed by those projects.

## Runtime extension bundle

TabBridge is designed without a third-party production dependency or remotely hosted runtime asset.
It uses browser-provided WebExtension, Web Crypto, Compression Streams, HTML, CSS, and JavaScript
APIs plus system fonts.

That statement must be checked against the final lockfile and both unpacked release directories
before every release. It is not a claim that an uninspected artifact contains no accidentally
bundled development code.

## Development and build tools

The direct tools declared in `package.json` include:

| Project                                                           | Reviewed version | Purpose                                           | License    |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------- | ---------- |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.13.5          | TypeScript definitions for Node.js build scripts  | MIT        |
| [addons-linter](https://github.com/mozilla/addons-linter)         | 10.13.0          | In-process strict Firefox package validation      | MPL-2.0    |
| [esbuild](https://github.com/evanw/esbuild)                       | 0.28.2           | TypeScript/JavaScript bundling                    | MIT        |
| [Playwright](https://github.com/microsoft/playwright)             | 1.63.0           | Chromium browser smoke-test automation            | Apache-2.0 |
| [Prettier](https://github.com/prettier/prettier)                  | 3.9.8            | Source formatting                                 | MIT        |
| [TypeScript](https://github.com/microsoft/TypeScript)             | 5.9.3            | Type checking and compilation                     | Apache-2.0 |
| [web-ext](https://github.com/mozilla/web-ext)                     | 10.6.0           | Firefox extension linting and development tooling | MPL-2.0    |

Playwright can download a Chromium browser and platform codecs/libraries for development and CI.
Review the notices shipped with the exact downloaded browser build as part of release due diligence;
those test-only binaries must not enter either extension ZIP. Transitive build dependencies and
their versions are recorded in `package-lock.json`; review their bundled license files rather than
treating this summary as a complete dependency inventory.

Development tools are not intended to be included in the Chrome or Firefox extension ZIP. The
release checklist verifies archive contents.

## Documentation material

`CODE_OF_CONDUCT.md` is adapted from the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct.html),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Its enforcement guidelines
acknowledge Mozilla's community participation work.

The README license badge is served by [Shields.io](https://shields.io/) when the repository page is
viewed; it is not bundled into the extension.

## Trademarks

Chrome, Chromium, Firefox, Google, Mozilla, and other names are trademarks of their respective
owners. Their use describes compatibility and does not imply endorsement.

## Maintaining this file

For every dependency, vendored source, icon, font, copied test fixture, or generated asset added to
the project:

1. verify origin and license compatibility;
2. preserve required attribution and license text;
3. pin the reviewed version or content hash;
4. update this file in the same change; and
5. inspect both release ZIPs to confirm whether the material is actually distributed.
