# Design harness

`npm run test:design` runs two projects.

| Project | Source (read-only archive) | Frames | Thresholds | Spec |
|---|---|---|---|---|
| `design` | `designs/Ariadne-UI-mockups-v2.zip` (older): its prototype data only | `frames.ts` | none | `design.spec.mts` |
| `final` | `designs/Ariadne-final-board.zip` (the board the redesign follows) | `final-frames.ts` | `final-thresholds.json` | `final.spec.mts` |

`final` holds the app to the board, pixel for pixel. `design` no longer compares anything with the v2 board: the redesign replaced the screens that board drew (tab bar, header, Waiting column, footer, the old answer boxes), so its whole-screen frames are retired. It keeps app-only layout checks of the Map, the Graph, the changes cards and the Details composer, on the v2 prototype's data (`frames.ts` states, built by `fixtures.ts`). Release 2 and 3 retire what is left of it when they redo the Map and Details.

`final` uses `compare.mts` (the pixel diff, `captureFrame`). The board is untrusted data: it is only unzipped and rendered in an offline page (`final-source.mts`, `final-board.mts`); nothing in it runs in Node.

## The final board: what a test does

One test per state, per size: `light` and `dark` at 1280 x 800, `narrow` (light) at 900 x 650. Titles read `final 2.1 light: <title>`.

1. **Board side, always.** `final-board.mts` renders the state by its part and state id (`Window` + `b-wait`) on a fake clock, with fonts loaded and no motion, and checks the frame is the right size and (after the frame's files are written) the board asked for nothing outside its files.
2. **App side, once `pending` is `false`.** `final-gallery.tsx` mounts the real `DesktopApp` in the state's fixture. The two frames are compared; the mismatch ratio must be at most the state's threshold. Pixels differ when a channel differs by more than 16. Two things are done to the board's frame so that it compares like for like: the design canvas puts it at a fractional y (67.19 px), so the page is moved the fraction (`boardFrame(..., aligned)`) and the frame starts on a whole pixel, as the app's does (without it every element at a fractional position rasterised a row off, a floor of 0.3 to 0.5% on text-heavy frames); and the four window corners (12 x 12 px) are left out, because the board draws its window rounded and the app's window is the page. The loader's self-check compares the board with Claude Design's own screenshots and so uses neither.
3. Everything lands in `coverage/design/final/`: `<id>-<size>-design.png` (the board), `-app.png`, `-diff.png` (mismatches red), `frames/<id>-<size>.json`, and `report.json`.

## Run one state

From the worktree root:

```
npx playwright test --config tests/ui/design/playwright.config.ts --project=final -g "final 2.1 "
```

The trailing space matters: `final 2.1 ` does not match `2.10`. Add `light`, `dark` or `narrow` to pick one size. `FINAL_APP=1` also draws the app for states that are still `pending`, and records the ratio without asserting it. Use it to see how far a state is. Look at `coverage/design/final/2.1-light-diff.png`.

## Add a state

Add one line to `finalStates` in `final-frames.ts`:

```ts
{ id: '2.1', part: 'Answering', sid: 'd-opts', owner: 'dock', pending: true, title: 'Three options, one recommended',
  app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 0, note: note1 })] } },
```

- `id`: the screen and state number, as the neighbouring entries of `finalStates` number them.
- `part`, `sid`: where the board draws it. Open the board source in the archive (`Ariadne Final Board.dc.html` or `Ariadne Final Board R4.dc.html`, unzipped to `coverage/design/final-source/` by the first run) and find its `PARTS` list: each entry's `id` is a `part`, and each of its states' `id` is a `sid`.
- `owner`: who turns it on (`shell`, `dock`, `nav-state`, `topbar`, `details`).
- The last argument is the app fixture (below). It starts `pending: true`.

## Turn `pending` off

A builder turns a state on in the same PR that makes the app match it:

1. Run it with `FINAL_APP=1` (above) and make the app match.
2. Change that state's `pending: true` to `pending: false` in `final-frames.ts`.
3. Set its threshold (next section) and run the three sizes.

CI runs `final` on every push with the rest of `npm run test:design`. A `pending` state still renders the board, so a broken loader or a changed archive fails CI. One pending state, 12.1 light, also runs its app side in CI with `threshold: null` (record only: the ratio is written, never asserted), so the gallery, the loading wait and the `act` steps stay exercised while it is `pending`; `canaryState` in `final.spec.mts` names it. Every state that is not `pending` runs its app side in CI and fails on a region over its threshold.

## Set a threshold

`final-thresholds.json` maps `"<id>"` (all three sizes) or `"<id> <size>"` to the largest mismatch ratio that passes. A state with no entry must match exactly (0). Set it to what the app measures plus a little room (about 0.001). A threshold absorbs anti-aliasing and sub-pixel noise (the board's frame sits at a fractional y, so an element at a fractional position rasterises one row off, about 0.3 to 0.5% of a text-heavy page) and nothing else. Never raise it to hide a real difference: fix the app, or name the part that really differs as a region, and say why in the PR. A state whose release-1 part still differs stays `pending` and is reported, with its region and its `-diff.png`.

## The app fixture

`AppFixture` (in `final-frames.ts`) says what the app is put in; `final-fixtures.ts` builds the data from it and `final-world.ts` holds the board's mock world (the topic, its items, the two waiting questions, the other sessions and projects, the conversations). All fields are optional; the default is the board's base window.

| Field | What it sets |
|---|---|
| `sessions` | the open session, its connection (`live`, `none`, `off`, `closed`, `loading`, `reconnecting`, ...), whether it is unnamed |
| `items` | edits to world items (`edit`), the two warm-up items after an answer (`afterAnswer`), the long-text state, hidden items, items parked as `later` (the owner's mark, kept in the preferences), an empty Map |
| `questions` | which waiting questions are `sent` or `failed`; whether the other sessions' questions are answered |
| `drafts` | what is typed in a waiting question's box: `pick` (option index), `note`, or `own` (write my own answer) |
| `view` | selection, `mode` (`tree` or `graph`), `details` (`open`, `folded`, `bigger`), the dock (`open` or `line`, which question, dragged height) |
| `chrome` | a page (`projects`, `sessions`, `archive`, `first`, `project-empty`), an overlay (switcher, Help, connection card), the other-sessions popover |
| `act` | steps after mount: `{ key }`, `{ click }` (a named button, tab or menu item), `{ hover }` (a CSS selector), `{ type }` |

Data fields are built into the session, preferences and drafts. State that is not data yet (a folded Details, the connection line, the dock's height) is reached with `act` steps, or by extending `final-fixtures.ts`. A field the fixture builder cannot yet honour is a gap for the builder who turns the state on to fill.

**Values the fixture cannot yet honour.** The fixture accepts these but cannot put the app in them yet: `view.shown`, `sessions.connection` of `unreadable`, `stale` or `unsaved`, and `sessions.current` other than `s2`. (`view.details: 'bigger'` is honoured: the runner presses "Read in a bigger view". `live` is the default, so it needs nothing. The dock, its height, the other-sessions popover and every `chrome.overlay` value render now: the dock is opened by `]` and sized through the browser-local dock height, the rest by the spec's `act` steps.) Every frame's JSON lists the ones its state sets under `unhonoured`. That list is derived from the field values the state sets, read against the `notYet` list in `final-frames.ts` (`unhonoured()`); it does not look at what the app does. A mismatch in such a state is the missing feature, not a fixture mistake. The builder who adds the feature makes `final-fixtures.ts` honour the value (or reaches it with `act`) and deletes just that value's entry from `notYet`, for example `'help-keys'` from `overlay`, so every other value stays flagged.

## Compare only some regions

A release that redesigns only part of a screen (the dock, the top bar, the Details placement) cannot match the whole board frame yet: the Map is redesigned later. Give the state `regions` in `final-frames.ts` and the app is compared in those rectangles only:

```ts
{ id: '2.1', part: 'Answering', sid: 'd-opts', owner: 'dock', pending: false, title: 'Three options, one recommended', app: { ... },
  regions: [
    { name: 'dock', rect: [320, 560, 640, 240] },                          // [x, y, width, height] in frame pixels; must match exactly
    { name: 'top bar', rect: [0, 0, 1280, 48], threshold: 0.002 },        // may differ in at most 0.2% of its pixels
    { name: 'details', rect: [880, 48, 400, 512], variants: ['light', 'dark'] } // only at 1280 x 800; the narrow frame is laid out differently
  ] },
```

- A region's ratio is its own: mismatched pixels (a channel off by more than 16) over the rectangle's area. `threshold` defaults to 0.
- With `regions`, the whole frame is not asserted (`final-thresholds.json` is not consulted); its ratio is still written to the JSON. A size that none of the regions applies to (`variants`) is compared whole, as without `regions`.
- Each frame's JSON gets `regions: [{ name, rect, ratio, threshold }]`. `-diff.png` still shows the whole frame, so a region's ratio and the red over its rectangle tell you how far it is. A `pending` state records the ratios without asserting them.

## What the board may reach

The board is untrusted, and `coverage/` is uploaded publicly. Its context (`boardContext` in `final-board.mts`) serves `/final/` and the pinned runtime and fonts and nothing else: another origin is blocked, a same-origin request outside `/final/` (the dev server is rooted at the repo) gets a 404, a WebSocket is closed at once, and service workers are blocked. Every one is recorded. Playwright's WebSocket block and its service-worker block are page-level replacements that board script can undo (the replacement's `_apiConnect()` opens a real socket), so they are backed by what the page cannot reach: every same-origin answer carries `Content-Security-Policy: worker-src 'none'; connect-src 'self'; report-uri /csp-report` (no worker, and no fetch, XHR or WebSocket to another origin; the 404s and the 500 carry it too, because an iframe of any URL of the origin is a document with a realm of its own; a violation is reported to `/csp-report`, which is recorded), and the board's browser is launched (`launchBoardBrowser`) with `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` (no name but the loopback resolves), `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (no STUN or other UDP) and `--proxy-server=http://127.0.0.1:1 --proxy-bypass-list="<-loopback>;<the dev server's host:port>"` (a proxy nothing listens on takes every connection but the dev server's, loopback ports included, which also shuts WebRTC's TURN over TCP). Each layer is tested alone: the CSP in a browser launched without the proxy, the proxy and resolver rules in a page with no CSP, and WebRTC against a local UDP and TCP listener, each with a control run in an unrestricted browser so a count of 0 cannot be vacuous. Each frame's JSON carries `denied`, the requests that render asked for (`[]` when clean), in both projects; the test asserts it is empty after the frame and its JSON (and its diff, when compared) are written, so a denied request leaves evidence. A render that times out or draws too little also writes its JSON, with `failed` and `denied`. A pending frame writes no diff.

## The loader's self-check

`selfcheck <id> <size>` tests render the board locally and compare it with the Claude Design screenshots (`~/Documents/Code/ariadne-mocks/final-design/shots/`; set `ARIADNE_FINAL_SHOTS` to move them). Twelve states across the screens run by default; `FINAL_SELFCHECK=all` runs every state at every size. They skip when the screenshots are absent, as in CI. Every one must match exactly (0 pixels over the comparison's tolerance). Two kinds of difference are handled in `final.spec.mts`, not by a threshold:

- 2.1 light and 3.1 narrow: the shot carries a "Back to" pill that only appears after a real scroll. Its rectangle is masked (blue in the diff).
- 2.6 (all sizes) and 3.1 light and dark: the shot was captured mid-scroll, so its Map is scrolled to another place than a fresh render. These are skipped, with that reason.

## The archive

`designs/Ariadne-final-board.zip` holds the two board files (`Ariadne Final Board.dc.html`, `Ariadne Final Board R4.dc.html`), the design-canvas runtime (`support.js`) and `ariadne-ds/` (tokens and CSS). It has no summary, no abandoned options, no fonts and no React or Babel: the runtime is served from the same pinned packages as the `design` project (SRI-checked against `support.js`), and the six fonts that `ariadne-ds/fonts/fonts.css` names from `apps/desktop/public`. The font route serves only those six base names, each checked against a SHA-384 pin in `final-source.mts` (`fontPins`); any other name, a `..` or an encoded one, gets a 404. Before a shot, the loader checks that JetBrains Mono and Phosphor are loaded. Before replacing it, run the private-word and account-identifier scan: `unzip -p designs/Ariadne-final-board.zip | grep -i -c -E -f ~/.config/ariadne/private-words.txt` must print 0, and no email, claude.ai URL or project id may appear.

## The alpha.20 Map states

`final-frames.ts` ends its list with the Map states of alpha.20 (1.3m, 3.1m, 3.6m, 4.1, 4.3, 4.4, 5.1 to 5.7, 7.2, 8.2 to 8.5, 9.2, 9.9, 10.12; an `m` marks the Map half of a state registered above). They are `pending` until the piece that draws them has merged.

- **World data.** `AppFixture.map` (even `{}`) puts the reading state of `final-world.ts` in the app: findings to ack, related and dependent items, the topic brief, the recent trail, and, with `marks` (`base`, `long`, `because`), a seen baseline at 20:40 with the change records behind each Changed row. A state without `map` renders as before. `final-fixtures.ts` `mapWorld` builds it.
- **Regions.** No region spans the Map's rows: ALPHA20-REPLAN D1 drops the board's per-box row padding, so rows cannot line up (see `mapRegionsById`). The band, the first row, the overlays and the Graph canvas are compared. D12 is why 10.12 compares the "…" menu's first row only.
- **Side by side.** Every Map state that draws the app also writes the board and the app side by side to `coverage/design/final/side-by-side/<id>-<size>.png`, for the rows' looks. Look at them; they assert nothing.
- **Steps.** `{ scroll: 'top' }` moves the Map's scroller to its top. A step that names a control the app does not draw yet fails in 20 s (a pending state run with `FINAL_APP=1`).
