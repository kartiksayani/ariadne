# Native tray publication checkpoint

Ariadne retains the published tray menu while its actionable capture is unchanged.
Changed captures publish a new menu; partial publication failures invalidate the
cache so the next capture retries. Native Pin events invalidate the cache before
saving, allowing the checkmark to reconcile with canonical state even after a
rejected or replayed save. Publication state belongs to one App lifetime, and
queued updates stop after disposal.

Six pure Rust tests cover capture equality and visible changes, partial-failure
retries, Pin invalidation, lifecycle disposal and bounded labels. These tests prove
Ariadne's publication decisions. This checkpoint adds no physical menu/window
harness and no screenshot-review requirement.

Historical physical run `c113cf8b`, using tray source `286bb37a` and runner source
`3eb7bafb`, observed title drag, Close → Show Ariadne and minimize → Show Ariadne.
It stopped at an unsupported Pin checked-state assertion; Quit and restoration
were not reached. Those retained observations are historical evidence, not current
merge gates. Earlier harness commits, worktrees and ignored run evidence remain
preserved; they are outside this PR's final scope.

This bounded repair does not claim P6.1 completion. Ariadne-owned geometry,
canonical preference persistence, route continuity and shutdown semantics retain
their applicable product contracts and existing acceptance; basic macOS Pin,
Show, minimize and menu behavior is outside this checkpoint's test scope.

Contracts: [P6.1 catalogue](../../../delivery/tasks.json),
[native lifecycle](../../low-level/UI_AND_NATIVE.md#8-native-macos-service), and
[desktop shutdown](../../low-level/QUEUES_AND_RECOVERY.md#5-desktop-shutdown-and-worker-recovery).
MCP/Seezo remain disabled under the owner's current-session waiver; organization
security guidance was not checked and no approval is claimed.
