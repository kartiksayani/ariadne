# Production window lifecycle acceptance

Status: **prepared; physical execution has not run**. This supplement starts at
reviewed PR96 `6d04e545`. It does not complete P6.1, P6.2 or P6.4. The existing
PR96 packaged route check proves the cold registered route and installed CLI
second-instance route; this supplement reuses its private package fixture,
canonical `ui.json`, primary identity, control socket and physical instance lease
helpers without changing them.

## Bounded check

`tests/native/window/run.mjs` attaches the existing Mac2/XCTest driver to an
independently launched ordinary production App in a new private HOME and data
directory. Its App and CLI hashes must match a successful retained PR96 release
boundary run, including route and cleanup evidence. The maintainer must verify
that release run's recorded source head is the intended reviewed application
head before execution. The supplement records both source identities and hashes.
It builds nothing and uses no WebView JavaScript or product test command.

The single physical journey will:

1. Inspect and retain the real AX hierarchy. Drag the genuine native title using
   its observed bounds; confirm the moved outer frame against canonical geometry.
2. Click the native close control and then the native minimize control, with an
   actual tray **Show Ariadne** between them. Each action must preserve the
   primary PID/birth/executable, socket/lease inodes, selected registered route
   and canonical session bytes. Hide/minimize must remove the hittable close
   control; Show must restore it and the canonical outer frame. Mac2's `displayed`
   endpoint reports only existence and is deliberately not visibility evidence.
3. Click native tray **Pin**, require a new canonical preference revision and
   agreeing native checked state, then click **Quit Ariadne**. Confirm PID exit,
   no additional private packaged PID, socket removal and an independently
   acquired instance lease. Forced cleanup cannot satisfy Quit assertions.
4. Restart the same private ordinary package without an explicit route. Confirm
   the committed selection, moved geometry and Pin survive, including the native
   checked state. Quit again through the real tray and prove release again.

The AX title, controls and tray must be uniquely observable in the actual app.
Selectors currently follow the retained disposable Mac2 probe and production
menu titles; their viability in production is **unproved**. Missing/ambiguous
hierarchy or unavailable check state fails with retained XML/command trace. There
is no fallback to guessed screen coordinates, an injected route or simulated OS
event. Allow one bounded accessibility attempt, then report a blocker rather
than expanding the harness.

## Run after the maintainer releases the native session

Do not run while another worker owns a native App/cache session. Use the pinned
Node22 environment. Supply absolute paths to the ordinary release artifacts and
its retained evidence directory; the script does not use a personal install:

```sh
rtk proxy node --test tests/native/window/*.test.mjs
rtk proxy node tests/native/window/run.mjs \
  --bundle /absolute/ordinary-release/Ariadne.app \
  --cli /absolute/ordinary-release/ariadne \
  --release-evidence /absolute/coverage/release-boundary/run-id \
  --tools /Users/kartik.sayani/Library/Caches/ariadne-devtools/macos-ui
```

The existing tools are documented in
[macOS testing setup](../../../development/MACOS_TEST_SETUP.md#recheck-the-prerequisites).
The script starts the retained WDA build with `test-without-building`, owns its
process group and a fresh loopback Appium server, checks ports 10100/4723 are free,
and requires `webDriverAgentMacUrl` to prevent occupied-port takeover. It enables
no insecure Appium feature, recording, AppleScript or permission changes. Cleanup
stops only spawned groups. SIGINT and SIGTERM abort ordinary requests/waits and
reach the same cleanup; handlers remain installed until cleanup finishes, and
session teardown retains its bounded deadline. Disposable subprocess tests prove
both signals exit with failure and remove all three owned detached Node stand-ins,
without starting an App or native driver. Private fixture roots and every run's XML, canonical
snapshot, command trace, failed samples and cleanup logs stay under their recorded
paths; successful evidence is written only after the journey and cleanup succeed.

The meaningful pure tests reject stale/different release artifacts, process
replacement/PID reuse, changed lease/socket ownership, lost routes, changed
session bytes, stale Pin commits, wrong native Pin state, inner-vs-outer geometry,
lost geometry/Pin at restart and incomplete Quit release. Passing them proves
these assertions, not OS acceptance. Source syntax and the commit hook are also
required before publication.

## Explicit remaining acceptance

- **Physical display disconnect and reachable monitor clamping:** owner action;
  existing pure clamp tests do not prove a real display transition.
- **Genuine system sleep/wake and reconciliation:** owner action; the existing
  synthetic did-wake observer test does not prove waking this Mac.
- **Any new Accessibility/XCTest authorization:** owner action. A concrete prompt
  or denial is a blocker; the runner never changes OS permission settings.
- **Dock reopen:** not exercised by this bounded tray Show journey.
- **Native always-on-top overlap:** Pin's menu state and canonical persistence
  do not establish ordering above another app's actual window.
- **Quit during a held external host turn:** unproved here. The existing ordinary
  scripted Codex provider is the allowed future seam; no paid/live host or fake
  dispatch is introduced. This runner composes no external host turn and cannot
  claim it survived.
- **Notifications/counts and actual owner install:** separate P6.2/P6.4 acceptance.

Contracts: [P6.1 catalogue](../../../delivery/tasks.json),
[native lifecycle](../../low-level/UI_AND_NATIVE.md#8-native-macos-service), and
[desktop shutdown](../../low-level/QUEUES_AND_RECOVERY.md#5-desktop-shutdown-and-worker-recovery).
MCP/Seezo remain disabled under the owner's explicit current-session waiver;
organization security guidance was not checked and no approval is claimed.
