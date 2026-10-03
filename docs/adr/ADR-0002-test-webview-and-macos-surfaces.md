# ADR-0002: Test WebView behavior and macOS surfaces separately

Status: accepted (partially superseded)
Supersedes: none
Superseded by: [ADR-0018](ADR-0018-recalibrate-delivery.md)

Only cadence/local gate requirements are revised by ADR-0018; the original
application/native/release safety controls and pushed-head CI behavior remain.

## Context

The embedded WDIO driver exercises a real Tauri app, WebView, Rust command and
disk receipt. Its JavaScript-generated WebView events do not establish native
mouse/keyboard input, window behavior or accessible macOS menus and dialogs.
The owner requested the testing explanation and prerequisite setup before
production implementation. Replacing the established per-commit gate with OS
automation would lose its focused DOM and invoke assertions; using it alone
would leave the macOS interaction claims unsupported.

## Decision

Retain WDIO 1.4.0 with Tauri 2.12.1 as the per-commit WebView-to-Rust-to-disk
behavior gate. Add Appium 3.8.0 with Mac2 driver 4.3.6 and the same WebDriver
client as a bounded supplement for genuine OS window and keyboard actions and
native accessible menus/dialogs on a logged-in Mac. Verify the application's
actual accessibility hierarchy before claiming a tray or dialog test works.
Own the WebDriverAgentMac lifecycle and connect using supported
`webDriverAgentMacUrl` from a fresh Appium process. In
[Mac2 4.3.6](https://github.com/appium/appium-mac2-driver/blob/v4.3.6/lib/wda-mac.ts),
process cleanup kills only tracked PIDs, but default startup sends `DELETE /` to
an occupied configured WDA host/port assuming an obsolete agent, without proving
ownership. The external URL avoids that occupied-port takeover. Stop only this
test's processes, preserving unrelated listeners and test agents.

Keep measured Rust/frontend coverage and native behavioral results separate.
Native success implies no coverage percentage. External native-process profiling
is optional future work and requires a validated counter-flush recipe before
its reports can contribute to coverage.

## Consequences

Mac2 requires full Xcode and user-granted Accessibility/XCTest permissions when
required; desktop Tauri compilation alone can use Command Line Tools. Missing
permissions are reported blockers. Do not bypass TCC or automate security settings.
Test servers bind loopback, fixtures use private disposable data, and embedded
plugins remain restricted to test builds. AppleScript insecure features, Full
Disk Access and recording are not default prerequisites. Tool installation and
disposable probes do not complete an application milestone or release acceptance.

## Spec references

- [Native E2E contract](../planning/low-level/NATIVE_E2E.md)
- [Development checks](../planning/DEVELOPMENT_CHECKS.md)
- [Mac testing setup](../development/MACOS_TEST_SETUP.md)
