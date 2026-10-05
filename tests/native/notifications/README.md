# Packaged notification acceptance

`run.mjs` is a bounded ordinary-release Mac2 supplement for P6.2/D13. The desktop
operator starts the existing Appium port4723 and XCTest/WDA port10100 runtime,
with exclusive Mac ownership and no other Ariadne App running. The runner uses
the same release boundary evidence and private installed package layout as the
packaged route/window checks; it performs no builds or global settings changes.

After the owner approves the actual macOS permission choice, run:

```sh
node tests/native/notifications/run.mjs \
  --bundle /absolute/proved/Ariadne.app \
  --cli /absolute/proved/ariadne \
  --release-evidence /absolute/coverage/release-boundary/run-id \
  --permission allow
```

Choose `deny` for the genuine denial case. It clicks the scoped Ariadne prompt's
Don’t Allow button, then answers the real provider question through the native
Waiting controls and checks the exact canonical answer and ordinary host
admission. `allow` clicks Allow and proves generic delivered notification clicks
with the App hidden and visible. `existing` exercises those click cases only
when the owner already enabled notifications. The runner never resets an
existing permission or toggles System Settings; if the chosen prompt is absent,
it fails. Permission is attached to the app identity, so a second private data
directory does not create another prompt or permit testing both decisions.

Arrivals use the existing deterministic provider endpoint and real
CLI/Core/Store. No renderer service, native callback or session file is replaced.
The complete initial native watermark precedes arrival publication. Click checks
require native app attribution, generic body, physical target hittability,
notification-driven foreground restoration, exact persisted session/item,
current detail and unchanged canonical session/process/socket/lease identity.
Native selectors deliberately fail on absent or ambiguous targets; physical
validation may identify an OS-specific AX layout adjustment. The runner records
only its own app tree and scoped Ariadne notification/prompt attributes, never
the complete Notification Center tree or other apps' cards.

Evidence and source identity go to `coverage/native-notifications/<run-id>`.
Private roots remain available for inspection. An actual tray Quit must finish;
forced cleanup never counts as successful Quit. Existing operator services stay
running, and session deletion preserves both Ariadne and system apps.

```sh
node --test tests/native/notifications/acceptance.test.mjs
ARIADNE_FIXTURE_TEST_CLI=/absolute/existing/ariadne \
  node --test tests/native/notifications/acceptance.test.mjs
```

The source tests prove admission/assertion boundaries and CLI wire validation,
not actual notification permission, rendering or clicks. Physical execution is
still required. The shared `test:native -- --suite notifications` selector is
not implemented by this bounded contribution.

Cold-click is blocked on safe ordinary OS launch isolation: Notification Center
does not preserve the runner's private HOME/ARIADNE_HOME environment when it
relaunches an exited app. Doing so now could open the owner's actual data.
Already-answered click, cold launch, burst grouping and full tray parity remain
unproved; this supplement does not mark P6.2 complete. Actual native
reconciliation may remove answered notifications before a running click.

Mac2's [AUT switching](https://appium.github.io/appium-mac2-driver/latest/guides/app-under-test/),
[native execute methods](https://appium.github.io/appium-mac2-driver/latest/reference/execute-methods/)
and [explicit interruption handling](https://appium.github.io/appium-mac2-driver/latest/reference/settings/)
define the transport used here. MCP/Seezo remain disabled under the owner's
waiver; organizational security guidance was not checked.
