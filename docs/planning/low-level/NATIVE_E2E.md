# Native macOS E2E implementation contract

Status: **specified; documentation and registry baseline verified 2026-10-02**.
No Ariadne Tauri app or native E2E POC has been built or executed. This closes
the setup gap for [V29](VERIFICATION.md), not its execution evidence. The first
application commit must run this gate and meet the agreed 80% actual coverage.

Use WebdriverIO with the embedded WebDriver server inside the real Tauri app.
Tauri's [official testing guide](https://v2.tauri.app/develop/tests/webdriver/)
documents this macOS route. `tauri-driver` alone supports Windows/Linux;
the native macOS gate requires both WDIO plugins. Browser mode, intercepted
command results, and a detached Rust test server cannot satisfy this gate.

## Baseline and files

Pin these exact dependencies and commit both lockfiles when implementation
starts. Versions were checked in the primary registries; compatibility still
requires the first native run.

| Dependency | Exact version | Primary source |
| --- | --- | --- |
| npm `@wdio/tauri-service`, `@wdio/tauri-plugin` | `1.4.0` each | [service](https://registry.npmjs.org/@wdio/tauri-service/1.4.0), [plugin](https://registry.npmjs.org/@wdio/tauri-plugin/1.4.0) |
| Rust `tauri-plugin-wdio`, `tauri-plugin-wdio-webdriver` | `=1.4.0` each | [WDIO crate](https://crates.io/crates/tauri-plugin-wdio/1.4.0), [embedded crate](https://crates.io/crates/tauri-plugin-wdio-webdriver/1.4.0) |
| Rust `tauri`, build dependency `tauri-build` | `=2.12.1`, `=2.7.1` | [Tauri](https://crates.io/crates/tauri/2.12.1), [build](https://crates.io/crates/tauri-build/2.7.1) |
| npm `@tauri-apps/cli`, `@tauri-apps/api` | `2.12.1`, `2.11.1` | [CLI](https://registry.npmjs.org/@tauri-apps/cli/2.12.1), [API](https://registry.npmjs.org/@tauri-apps/api/2.11.1) |
| npm `@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework`, `@wdio/spec-reporter` | `9.30.1` each | [CLI](https://registry.npmjs.org/@wdio/cli/9.30.1), [runner](https://registry.npmjs.org/@wdio/local-runner/9.30.1), [Mocha](https://registry.npmjs.org/@wdio/mocha-framework/9.30.1), [reporter](https://registry.npmjs.org/@wdio/spec-reporter/9.30.1) |

The embedded crate's published requirement is **Tauri >=2.10 within major 2**;
do not use the generic Tauri 2.0 minimum in examples as the dependency floor.
The service pins its internal `webdriverio` to 9.30.1 and native types to 2.5.0;
retain the resolved dependency graph in `package-lock.json`.

| Planned path | Responsibility |
| --- | --- |
| `apps/desktop/src-tauri/Cargo.toml` | Optional plugins and explicit `e2e` feature; binary name `ariadne-desktop` |
| `apps/desktop/src-tauri/src/lib.rs` | Feature-gated plugin registration and native command handlers |
| `apps/desktop/src-tauri/tauri.e2e.conf.json` | Test capability overlay and bundled frontend build |
| `apps/desktop/src/main.tsx` | Await conditional WDIO import before mounting React |
| `apps/desktop/wdio.native.conf.mjs` | One native worker, managed embedded provider |
| `apps/desktop/tests/e2e/native-smoke.spec.mjs` | Native UI/invoke/process/receipt assertions |
| `scripts/run-native-e2e.mjs` | Build, temporary root, nonce, deadlines, evidence and cleanup |
| `scripts/check-release-boundary.mjs` | Verify packaged build excludes all E2E surfaces |

## Test-only build recipe

In the desktop Cargo manifest, preserve the ordinary feature set and append:

```toml
[features]
e2e = ["dep:tauri-plugin-wdio", "dep:tauri-plugin-wdio-webdriver"]

[dependencies]
tauri-plugin-wdio = { version = "=1.4.0", optional = true }
tauri-plugin-wdio-webdriver = { version = "=1.4.0", optional = true }
```

Keep `e2e` absent from default features. Register both plugins under that feature
in the existing builder chain:

```rust
let builder = tauri::Builder::default();
#[cfg(feature = "e2e")]
let builder = builder
    .plugin(tauri_plugin_wdio::init())
    .plugin(tauri_plugin_wdio_webdriver::init());
```

Use a feature gate rather than `debug_assertions`: development alone must not
open the driver. The [plugin setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup/)
documents optional Cargo dependencies, registration, frontend initialization,
permissions and the embedded server lifecycle.

Import the dev dependency before the renderer mounts, only for the E2E build:

```ts
if (import.meta.env.VITE_ARIADNE_E2E === '1') {
  await import('@wdio/tauri-plugin');
}
```

Use an async bootstrap function if the configured frontend target disallows
top-level await. Ordinary development and packaging build with the variable
unset; the production bundle must exclude the import and plugin code.

The test overlay is:

```json
{
  "build": {
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "security": {
      "capabilities": [
        "default",
        {
          "identifier": "native-e2e",
          "windows": ["main"],
          "permissions": ["wdio:default", "wdio-webdriver:default"]
        }
      ]
    }
  }
}
```

Keep the inline capability in this overlay, outside production capability
files. Set the base config's capability list explicitly to `["default"]` and
`withGlobalTauri` to false. Tauri supports inline capability entries in its
[configuration schema](https://v2.tauri.app/reference/config/#capabilityentry).
Preserve production CSP and the existing default capability; grant no remote
origins. `wdio-webdriver:default` currently adds no IPC commands but loads its
ACL manifest. Full WDIO permissions are confined to this test binary/window.

The runner executes the pinned local Tauri CLI with working directory
`apps/desktop`, using an argument array:

```text
tauri build --debug --features e2e --no-bundle --config src-tauri/tauri.e2e.conf.json
```

Set `VITE_ARIADNE_E2E=1` and `CARGO_TARGET_DIR=<repo>/target/native-e2e` only in
the build subprocess environment. The resulting `appBinaryPath` is the absolute
`<repo>/target/native-e2e/debug/ariadne-desktop`. The
[CLI reference](https://v2.tauri.app/reference/cli/#build) specifies these build
flags. Build and start a real native executable with embedded frontend assets;
this smoke requires no Vite server.

## WDIO service configuration and lifecycle

The runner provides absolute `ARIADNE_E2E_BINARY`, `ARIADNE_E2E_ROOT`, a fresh
cryptographic `ARIADNE_E2E_NONCE`, and `ARIADNE_E2E_PORT`. Required values must
be validated before configuration starts; an empty value is an error.

```js
const binary = process.env.ARIADNE_E2E_BINARY;
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/native-smoke.spec.mjs'],
  maxInstances: 1,
  framework: 'mocha',
  reporters: ['spec'],
  services: [['@wdio/tauri-service', {
    mode: 'native',
    driverProvider: 'embedded',
    appBinaryPath: binary,
    embeddedPort: Number(process.env.ARIADNE_E2E_PORT),
    startTimeout: 60000,
    statusPollTimeout: 5000,
    commandTimeout: 30000
  }]],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  connectionRetryTimeout: 60000,
  connectionRetryCount: 0,
  waitforTimeout: 10000,
  specFileRetries: 0,
  mochaOpts: { timeout: 60000 }
};
```

Options and capabilities follow the [service configuration](https://webdriver.io/docs/desktop-testing/tauri/configuration/).
The explicit native mode is also present in the published
[`@wdio/native-types@2.5.0`](https://registry.npmjs.org/@wdio/native-types/2.5.0)
used by service 1.4.0. The service launches the app, supplies
`TAURI_WEBDRIVER_PORT`, polls `/status`, and terminates the app on completion.

The wrapper defaults to loopback port 4445, checks availability once, and fails
with the occupied port and an override example. A race at launch also fails;
never attach to an existing listener or retry forever. Assert the driver binds
only loopback. Allow 60 seconds for native startup and 10 seconds for each UI
condition; the complete smoke has a 180-second runtime deadline after build.
Readiness requires the server, main window, WDIO bridge and startup witness.
Missing tools, a missing usable macOS GUI session, or unmet readiness fail the
gate with the specific prerequisite and logs; they never become a passing skip.

On success, test failure, timeout or SIGINT, let WDIO stop its app, then verify
the observed native PID has exited and the port is free within 10 seconds.
Terminate only this run's remaining descendant processes and await exit; never
use a global process-name kill. Retain failed-run evidence under
`coverage/native-e2e/<run-id>/`, then remove the private temporary root once
processes are gone. Forward the nonzero failure/cleanup result to the commit
checker. Build has its own bounded cold-start budget, initially 15 minutes.

## First scaffold smoke, then real store acceptance

Budget the initial implementation as one focused day: approximately half for
the scaffold/typed ping and half for native macOS build, coverage, driver and
cleanup evidence. This is an estimate, not an executed benchmark. Complete the
smoke before the first scaffold commit; keep commits <=800 handwritten lines
and PRs <=1600. Allocate the harness with that slice rather than deferring E2E
until the domain store is complete.

The minimal native command is typed `native_ping(request: PingRequest) ->
Result<PingReceipt, CommandError>`. Request fields are `nonce` and bounded
`payload`; receipt fields are `nonce`, `payload`, `pid` and `receipt_id`.
The E2E build obtains its root and expected nonce from the process environment,
rejects a missing/invalid root or mismatched nonce, and uses only a canonical
private temporary root created by the runner. The renderer cannot choose a
filesystem path. A startup witness under that root records the run nonce and
`std::process::id()` from the Tauri process.

The native test must:

1. Read the startup witness from disk and verify the nonce, OS PID's exact
   executable path and ancestry under the launched WDIO process. Record these
   values; a PID field returned by JavaScript alone is insufficient evidence.
2. Type nonce/payload into the real scaffold form and click its native-window
   button with WebDriver element actions. The React click handler calls the
   typed production `invoke('native_ping', { request })` boundary.
3. Wait for the displayed receipt, then independently read
   `<test-root>/smoke/receipt.json`, written by that Rust handler before it
   acknowledges success. Require matching nonce/payload/receipt ID and the
   observed Tauri PID. Assert the file was absent before the click.
4. Snapshot the successful receipt, exercise a rejected request, and confirm
   its bytes remain unchanged with no additional receipt; then close the app
   and verify bounded process/port cleanup.

The initial file receipt proves native UI/invoke/Rust/file wiring only. Once
`ariadne-store` exists, replace the smoke receipt with a real domain operation:
the UI creates or edits an item, the production command commits through the
shared store, the test reads its operation receipt/revision and domain state
from the isolated project root, and relaunch shows the persisted change.
Never make the scaffold fixture the authoritative domain store. Remove the scaffold
form and ping-only application path once the real domain journey replaces it.

Add the V08 five-message FIFO case when dispatcher integration exists. Only the
provider transport may be deterministic fake: submit five messages through the
native UI, retain the real invoke/dispatcher/store path, and assert five ordered
distinct input/attempt/result receipts with no coalescing or cross-binding
effects. Native `invoke` mocks and a detached backend are forbidden in this
acceptance suite. Live Claude/Codex transport proof remains the separately
budgeted M7 gate.

## Commit and release gates

From the first app commit, `npm run test:e2e` invokes this wrapper and fails
closed. Every app commit also runs all maintained-code lint, meaningful unit
and functional tests, fresh Rust/TypeScript LCOV and >=80% weighted overall
application coverage, including untested production files. A native test pass
does not imply a coverage percentage. Missing reports or native prerequisites
must block the commit/CI result. Record exact package/toolchain/macOS versions,
command, binary hash, run nonce, PID witness and assertions in the verification
ledger only after an actual run.

`cargo clippy --all-features` may compile the optional test plugins for lint;
that artifact is never packaged. Packaging uses a separate clean target/dist
directory, the base Tauri config and the explicit production feature set,
with `e2e`, `--all-features`, test overlay and `VITE_ARIADNE_E2E` excluded.
The release boundary checker verifies resolved production Cargo dependencies
exclude both WDIO crates, merged capability/config excludes WDIO permissions
and global Tauri, frontend output excludes the WDIO module, and the launched
packaged binary never opens the embedded driver port even when supplied
`TAURI_WEBDRIVER_PORT`. Do not infer exclusion from a filename grep alone.

Organization security guidance was not fetched under the owner's explicit
Seezo/MCP waiver. This plan does not claim Seezo review or native execution.
