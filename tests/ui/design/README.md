# Design harness

`npm run test:design` holds the app to two Claude Design sources. Each has its own project, frames and thresholds.

| Project | Source (read-only archive) | Frames | Thresholds | Spec |
|---|---|---|---|---|
| `design` | `designs/Ariadne-UI-mockups-v2.zip` (older) | `frames.ts` | `thresholds.json` | `design.spec.mts` |
| `final` | `designs/Ariadne-final-board.zip` (the board the redesign follows) | `final-frames.ts` | `final-thresholds.json` | `final.spec.mts` |

Both share `compare.mts` (the pixel diff, `captureFrame`). The board is untrusted data: it is only unzipped and rendered in an offline page (`final-source.mts`, `final-board.mts`); nothing in it runs in Node.

## The final board: what a test does

One test per state, per size: `light` and `dark` at 1280 x 800, `narrow` (light) at 900 x 650. Titles read `final 2.1 light: <title>`.

1. **Board side, always.** `final-board.mts` renders the state by its part and state id (`Window` + `b-wait`) on a fake clock, with fonts loaded and no motion, and checks the frame is the right size and the board asked for nothing outside its files.
2. **App side, once `pending` is `false`.** `final-gallery.tsx` mounts the real `DesktopApp` in the state's fixture. The two frames are compared; the mismatch ratio must be at most the state's threshold. Pixels differ when a channel differs by more than 16.
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

CI runs `final` on every push with the rest of `npm run test:design`. A `pending` state still renders the board, so a broken loader or a changed archive fails CI. One state, 13.2 light, also runs its app side in CI with `threshold: null` (record only: the ratio is written, never asserted), so the gallery, the loading wait and the `act` steps stay exercised while every state is `pending`; `canaryState` in `final.spec.mts` names it.

## Set a threshold

`final-thresholds.json` maps `"<id>"` (all three sizes) or `"<id> <size>"` to the largest mismatch ratio that passes. A state with no entry must match exactly (0). Set it to what the app measures plus a little room. The file is empty today: no state is compared yet. Never raise it to hide a real difference: mask or fix the difference instead, and say why in the PR.

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

**Fields the current app ignores.** The fixture accepts these but cannot put the app in them yet: `view.dock`, `view.dockQuestion`, `view.dockHeight`, `view.shown`, `view.details: 'bigger'`, `chrome.overlay`, `chrome.otherPopover`, `sessions.connection` of `unreadable`, `stale` or `unsaved`, and `sessions.current` other than `s2`. (`live` is the default, so it needs nothing.) Every frame's JSON lists the ones its state sets under `unhonoured`: a mismatch in such a state is the missing feature, not a fixture mistake. The builder who adds the feature makes `final-fixtures.ts` honour the field (or reaches it with `act`) and removes it from `unhonoured` in `final-frames.ts`.

## The loader's self-check

`selfcheck <id> <size>` tests render the board locally and compare it with the Claude Design screenshots (`~/Documents/Code/ariadne-mocks/final-design/shots/`; set `ARIADNE_FINAL_SHOTS` to move them). Twelve states across the screens run by default; `FINAL_SELFCHECK=all` runs every state at every size. They skip when the screenshots are absent, as in CI. Every one must match exactly (0 pixels over the comparison's tolerance). Two kinds of difference are handled in `final.spec.mts`, not by a threshold:

- 2.1 light and 3.1 narrow: the shot carries a "Back to" pill that only appears after a real scroll. Its rectangle is masked (blue in the diff).
- 2.6 (all sizes) and 3.1 light and dark: the shot was captured mid-scroll, so its Map is scrolled to another place than a fresh render. These are skipped, with that reason.

## The archive

`designs/Ariadne-final-board.zip` holds the two board files (`Ariadne Final Board.dc.html`, `Ariadne Final Board R4.dc.html`), the design-canvas runtime (`support.js`) and `ariadne-ds/` (tokens and CSS). It has no summary, no abandoned options, no fonts and no React or Babel: the runtime is served from the same pinned packages as the `design` project (SRI-checked against `support.js`), and the six fonts that `ariadne-ds/fonts/fonts.css` names from `apps/desktop/public`. The font route serves only those six base names, each checked against a SHA-384 pin in `final-source.mts` (`fontPins`); any other name, a `..` or an encoded one, gets a 404. Before a shot, the loader checks that JetBrains Mono and Phosphor are loaded. Before replacing it, run the private-word and account-identifier scan: `unzip -p designs/Ariadne-final-board.zip | grep -i -c -E -f ~/.config/ariadne/private-words.txt` must print 0, and no email, claude.ai URL or project id may appear.
