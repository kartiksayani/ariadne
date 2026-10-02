# ADR-0007: Gate scaffold release isolation

Status: accepted
Supersedes: none
Superseded by: none

## Context

Source configuration alone does not prove the packaged build excludes test
services. Cargo feature activation, Tauri configuration merging and Vite's actual
module graph can differ from a manifest or a source-text search. Generated
`capabilities.json` contains filesystem definitions, not inline capabilities.

## Decision

Default `npm run test:e2e` runs native positive proof and production isolation.
Use separate E2E frontend/target output and clean production frontend/release
output, exact locked dependencies and sanitized environment. Match CLI production
features with Cargo metadata and fresh compiler events. Read the desktop build
script's actual OUT_DIR ACL artifacts and fingerprint-recorded TAURI_CONFIG.
Allow only the known base JSON configuration and identical CLI bundle overrides;
reject alternate/platform sources, unexpected overrides, features or permissions.
Verify fresh frontend module inventory against emitted chunk hashes. Remove the
unused template opener plugin and permission; retain the core capability and
scaffold ping command. The scaffold never launches link navigation.

Production CSP permits bundled script/style/font/image resources and required
Tauri IPC only, with no unsafe eval or external origins. Keep Tauri's automatic
bundled-code hashes/nonces enabled; enforce this exact configuration in the
release gate. The test overlay inherits it unless an actual plugin incompatibility
requires an explicitly documented test-only exception. Bundle minimum macOS is
13.0, matching the compiler deployment target. See the official
[CSP guidance](https://v2.tauri.app/security/csp/) and
[macOS configuration](https://v2.tauri.app/reference/config/#macconfig).

Launch the exact packaged executable with hostile E2E root/nonce/driver switches.
Observe its live OS PID and executable for ten seconds, with no driver listener
or E2E writes. Retain logs, hashes, features, permissions and bounded cleanup proof.

## Consequences

Every gate pays for a clean release build. Base output is `target/desktop-dist`;
E2E output is `target/native-e2e/desktop-dist`. Module inventories stay outside
both packaged outputs. This proves bounded test-service exclusion, not native UX
acceptance, a global security assessment or external-process coverage. No production
test endpoint or extra capability is added; Appium/Mac2 remains for actual OS features.

The retained npm graph has 18 affected test-tool packages (17 high, one moderate),
rooted in four advisory-bearing packages; this is not an audit-clean claim. The
actual hashed production module graph excludes them, independently of npm's dev
flags. The macOS-only embedded path bypasses Puppeteer browser setup/download and
its FTP/PAC path; embedded mode alone is insufficient on Windows, where Edge
setup precedes the embedded bypass. Explicit nonparallel Mocha avoids its parallel
option serializer. Deepmerge does execute on checked-in config, CLI options and
protocol definitions; inspected inputs lack the advisory's cyclic object graphs.
Reassess browser downloads, Windows, parallel Mocha or untrusted configuration.

- `deepmerge-ts` 7.1.6 via WDIO configuration/protocol utilities:
  [cyclic-graph exhaustion; fixed in 8.0.0](https://github.com/advisories/GHSA-ggr8-5vv4-36mx).
- `extract-zip` 2.0.1 via Puppeteer browser downloads:
  [symlink traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and
  [symlink overwrite](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), no patched version.
- `basic-ftp` 5.3.1 via get-uri/PAC/ProxyAgent:
  [directory-list parsing exhaustion; fixed in 6.2.1](https://github.com/advisories/GHSA-c475-qrg2-pj4r).
- `serialize-javascript` 6.0.2 via Mocha:
  [object code injection; fixed in 7.0.3](https://github.com/advisories/GHSA-5c6j-r48x-rmvq) and
  [array-like exhaustion; fixed in 7.0.5](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v).

## Spec references

- [Native E2E contract](../planning/low-level/NATIVE_E2E.md#first-scaffold-smoke-then-real-store-acceptance)
