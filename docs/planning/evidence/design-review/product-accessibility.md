# Ordinary application accessibility and supplied-frame validation

P4.8 source starts at reviewed integrated parent
`9bfbc74ed1358e00e56848e8a35ab6e7f4aa08ef`. This record distinguishes renderer
fixture checks, immutable-source comparisons, and the real native journey.
Browser/native evidence is pending the pushed-head CI run; no local browser or
native build was run under the owner's resource constraint. After CI findings,
the owner authorized bounded local browser checks using existing warm Chrome
and isolated, pinned source-runtime dependencies.

## Concrete discrepancies and corrections

- The ordinary App omitted `a`, `b`, `r`, `d`, `o`, `e`, and tree-focused option
  shortcuts. The corrected path resolves the registered item before focusing
  its existing owner control. Reply chooses reply/note/follow-up by status;
  Replaced never exposes reopen. Options select without submitting. Archive
  opens the existing guard. A fresh Bring uses the maintainer's §7 decision;
  existing or attempted drafts are only revealed.
- Independent review reproduced an old delayed shortcut reopening a session
  after All sessions navigation or dismissal. The existing navigation intent
  counter now has a read-only accessor: stale route resolution is rejected before
  navigation, and failed/superseded navigation cannot authorize focus or Bring.
  The optional caller guard is rechecked after asynchronous session validation
  before dispatching preferences; an already dispatched durable write is unchanged.
  Its valid receipt still confirms the saved preferences, but an invalidated guard
  suppresses local reveal so a newer Escape cannot be undone by completion.
  Consumed focus tokens are acknowledged to App and cleared only when matching;
  an old editor callback cannot erase a newer request.
- Numeric selection previously bypassed disabled changed-target choices and
  replayed on detail remount. Both number paths now honor the rendered option
  eligibility, including revisions/binding, stale reads and frozen operations.
  A blocked number is consumed immediately, never replayed after explicit review.
- Focus after asynchronous reveal could return to the tree when navigation
  preferences completed. The focus request now follows that completion; repeating
  a shortcut has a new token and refocuses the control.
- Dialog Tab handling omitted textareas, disabled fieldset handling, and a safe
  focus fallback. It now enumerates current enabled controls, traps forward and
  reverse Tab, contains escaped focus, and restores the connected opener.
- Dialog Escape bubbled to App and closed the selected detail. The dialog consumes
  Escape; global shortcuts also respect modal/editor/default-prevented events.
  Cmd+F focuses search outside editors.
- Waiting had no polite event announcement. A persistent live region observes
  new question-revision episodes and known unresolved inputs transitioning to
  handled/cancelled/skipped. Initial data, duplicate refreshes, stale reads, message
  deltas, and removed rows do not manufacture announcements or move focus.
- Actual CI light-theme samples measured muted text at 4.328:1 and Open/Waiting
  statuses at 3.385:1/3.086:1. Product-only light foregrounds now retain the status
  hues with darker values; the immutable gallery and global tokens stay intact.
  Bounded browser measurements now exceed 4.5:1 for all 22 samples, including
  System appearance resolving to light.
- All ordinary controls receive the two-pixel focus outline. Reduced motion
  disables transitions/animation/animated scrolling in the product subtree.
  System appearance follows OS changes only while the saved theme is System.

## Capture coverage and proof boundaries

The existing reference gallery continues to compare every applicable immutable
source frame/region and component variant in dark/light at 1600×960 and 1000×700.
Frames 1j/1k/1s remain component sheets/diagrams, not new application pages.

`tests/visual/cases.ts` maps the other 27 frames to **ordinary DesktopApp** states.
The existing canonical demo/AppTransport/HistoryTransport supply its real renderer
service, navigation/session stores, owner drafts and screen components. The 1u
three-round/two-fork projection reuses the existing history fixture. This is
renderer fixture evidence, not native persistence or textual pixel parity with
the unrelated prototype example. Source-gallery region comparisons remain the
source-asset fidelity check.

Each ordinary capture checks the state it names, shell dimensions, 300px pinned
Waiting, horizontal center/detail overflow at minimum size, labelled reachable
chrome controls, and unmasked screenshots. Raster tolerance cannot override those
assertions. Both themes have computed WCAG text-contrast samples retained in the
browser artifacts; ratios must reach 4.5:1. Real browser keys prove editor/modal
suppression, repeated Reply focus, retained draft, Tab trap, Escape/return, visible
focus and reduced motion. Before screenshots execute tracked frontend source
extracted from the exact parent above with the same fixture, Vite, browser and
viewport; after screenshots execute the changed source. No app-generated golden
is treated as source parity.

The existing embedded native journey additionally invokes
`apps/desktop/tests/e2e/accessibility.spec.mjs` with real WebDriver keys and actual
DesktopApp/core/store. It proves retained Reply draft and editor typing, modal
Tab/Escape/opener return and unchanged demo domain bytes. Its draft is local
preferences only; it does not submit demo owner input. Existing tree/history/
history-action helpers retain their original real native acceptance.

## Validation

Observed locally with pinned Node 22, existing ignored dependency cache:

- `npm run check`: passed (ESLint, both TypeScript configurations, CSS lint).
- Focused desktop/reference UI selection: 176 tests passed, including all 27
  ordinary frame fixture mounts, original action tests, and new accessibility
  assertions.
- Scope selector regression tests: 16 passed after removing the stale history/rail capture exemptions.

Initial pushed-head [CI run 37249848470](https://github.com/kartiksayani/ariadne/actions/runs/37249848470)
failed the new ordinary captures: empty/filter fixtures incorrectly required a
nonempty visible tree, and actual light contrast failed. Its
[artifact](https://github.com/kartiksayani/ariadne/actions/runs/37249848470/artifacts/11320053426)
retains before screenshots, contrast and the passing immutable-gallery evidence.
The empty/filter checks now assert zero rows plus their exact semantic UI; Follow
up is scoped to its actual owner-action group. No tolerance or contrast threshold
was lowered. Local bounded checks cover all 27 states at dark minimum/light full
size, real keyboard behavior and light/System contrast; CI must still confirm all
four combinations at the final head.

Review repair validation: the final focused desktop/reference selection passed
228 tests across 12 files, including navigation validation cancellation, dismissed
Reply/Bring after dispatched preference saves, failed navigation, stale/frozen
number requests, remount and old/new token acknowledgment.
Normal type/lint/CSS checks passed. Local real-browser keyboard checks passed at
dark 1000×700, light 1600×960 and light 1000×700. Light/System samples have a
measured minimum 4.949:1. Existing warm Chrome was used; final CI still uses the
package-pinned Chromium. Exact pushed-head evidence will be appended.

The reviewed native-parent repair `cc11095` is merged with the composed journey
and accessibility helper preserved. Its launcher-fixture integration requires the
existing delivery phase explicitly; 23 process-contract tests passed using the
warm CLI without a native build. Parent native startup proof does not establish
the full composed P4.8 native acceptance.

Required pushed-head checks: `npm run capture:reference` (both themes/sizes,
immutable source gallery + ordinary captures), application tests/weighted coverage,
and the existing real native smoke/release checks selected by CI. Results and
artifact URLs will be appended when available. P4.8 is not claimed complete until
all original criteria and independent review are proved.

MCP/Seezo remained disabled under the explicit owner waiver. Organization security
guidance was not fetched; no organization approval is claimed.
