// The registry of final-board states the app is held to (see README.md in this folder). One entry per board state:
// where the board draws it (part + sid), what the app is put in to match it (an AppFixture), whether the app is
// compared yet (`pending`), and who is expected to turn that on. Thresholds live in final-thresholds.json.
// Kept free of app imports: Node (final.spec.mts) and Vite (final-gallery.tsx) read it alike.
import { Q1, Q2, note1 } from './final-world';

/** The three renders of every state: the board's light and dark at 1280 x 800, and its light at 900 x 650. */
export type Variant = 'light' | 'dark' | 'narrow';
export const variants: Readonly<Record<Variant, { theme: 'light' | 'dark'; width: number; height: number; vi: 0 | 1; shot: string }>> = {
  light: { theme: 'light', width: 1280, height: 800, vi: 0, shot: 'light' },
  dark: { theme: 'dark', width: 1280, height: 800, vi: 0, shot: 'dark' },
  narrow: { theme: 'light', width: 900, height: 650, vi: 1, shot: 'light-900' }
};
export const variantNames = Object.keys(variants) as readonly Variant[];

/** The board's clock: 7 Oct 2026 21:25 UTC (final-world.ts `clock`). Every final frame, board and app, runs on it. */
export const finalNow = Date.UTC(2026, 9, 7, 21, 25);

/** What the owner has typed in one waiting question's box (the board's `drafts`). `own` is "Write my own answer". */
export interface Draft { readonly item: string; readonly pick?: number; readonly note?: string; readonly own?: string }

/** A step taken in the app after it mounts, to reach a state that is not data (an open menu, a hover). */
export type Step =
  | { readonly key: string }
  | { readonly click: string }
  | { readonly hover: string }
  | { readonly type: string };

/** Fields of a world item (final-world.ts) a state changes. */
export interface ItemEdit { readonly s?: 'decided' | 'done' | 'in_progress' | 'open' | 'waiting_on_me' | 'replaced'; readonly q?: string; readonly o?: string; readonly why?: string }

/**
 * What the app is put in to match one board state. Everything is optional: the default is the board's base window
 * (the world of final-world.ts, "cache PR review" open, nothing selected, the dock a 40px line).
 * - sessions: which session is open and what state the others are in.
 * - items: edits to the world's items; `afterAnswer` adds the two warm-up items the agent writes after "prefix bump timing" is answered.
 * - questions: which of the two waiting questions have been answered (sent, or failed to send); the questions in other sessions.
 * - drafts: what is typed in a waiting question's box.
 * - view: what the owner has open (selection, Tree or Graph, Details, the dock).
 * - chrome: the top bar, the line above the Map, a page or an empty Map.
 * - act: steps taken after mount.
 */
export interface AppFixture {
  readonly sessions?: { readonly current?: string; readonly connection?: Connection; readonly unnamed?: boolean };
  readonly items?: { readonly edit?: Readonly<Record<string, ItemEdit>>; readonly afterAnswer?: boolean; readonly longText?: boolean; readonly hidden?: readonly string[]; readonly empty?: boolean;
    /** Items the owner parked ("Later"): kept in the preferences, not on the item. */ readonly later?: readonly string[] };
  readonly questions?: { readonly sent?: readonly string[]; readonly failed?: readonly string[]; readonly othersSent?: boolean };
  readonly drafts?: readonly Draft[];
  readonly view?: {
    readonly selected?: string | null; readonly mode?: 'tree' | 'graph';
    /** Default: open when something is selected. */
    readonly details?: 'open' | 'folded' | 'bigger';
    readonly dock?: 'open' | 'line'; /** Which waiting question the open dock is on: 0 = first. */ readonly dockQuestion?: 0 | 1;
    /** Dragged height of the open dock: px, or the board's 'tall' (window - 40 - 130) / 'short' (200) / 'chip' (45% of the window: the dock the page chip opens, 14.5). */
    readonly dockHeight?: number | 'tall' | 'short' | 'chip';
    /** Which "Show more" links are open (item keys); the board opens "self-hosted cache" in 1.4. */
    readonly shown?: readonly string[];
  };
  readonly chrome?: { readonly page?: Page; readonly overlay?: Overlay; readonly otherPopover?: string };
  readonly act?: readonly Step[];
}
/**
 * The values of the AppFixture fields the app cannot yet be put in, one entry per value. `unhonoured` below reads a state's
 * field values against this list: it knows nothing about what the app really does. A builder who makes the app honour one
 * value (say `chrome.overlay: 'help-keys'`) deletes that one entry, and every other value stays flagged.
 */
export const notYet = {
  // Every overlay renders (the switcher, Help, the connection card, the Projects menu): the dock, the other-sessions popover
  // and the overlays are reached by the fixture and the spec's steps, and a mismatch in them is a real difference.
  overlay: [] as readonly Overlay[],
  connection: ['unreadable', 'stale', 'unsaved'] as readonly Connection[]
};

/**
 * The values a state's fixture sets that the fixture builder (final-fixtures.ts) accepts but cannot yet put the current app
 * in: the "Show more" links, a bigger Details, the connection states the app has no data for, and an open session other than
 * the default. It is derived from the values the state sets: a field is flagged when its value is on the `notYet` list (`shown`
 * and `bigger` whenever set). A state that lists any of them cannot match the board until the app grows the feature; its frame
 * JSON records them as `unhonoured`, so a builder knows the mismatch is the feature, not a fixture mistake.
 */
export function unhonoured(app: AppFixture, list: typeof notYet = notYet): string[] {
  const { view, chrome, sessions } = app, out: string[] = [];
  if (view?.shown) out.push(`view.shown=${view.shown.join(',')}`);
  if (view?.details === 'bigger') out.push('view.details=bigger');
  if (chrome?.overlay && list.overlay.includes(chrome.overlay)) out.push(`chrome.overlay=${chrome.overlay}`);
  if (sessions?.connection && list.connection.includes(sessions.connection)) out.push(`sessions.connection=${sessions.connection}`);
  if (sessions?.current && sessions.current !== 's2') out.push(`sessions.current=${sessions.current}`);
  return out;
}
export type Connection ='live' | 'none' | 'off' | 'closed' | 'loading' | 'reconnecting' | 'unreadable' | 'stale' | 'unsaved';
export type Page = 'projects' | 'sessions' | 'archive' | 'first' | 'project-empty';
export type Overlay = 'switcher' | 'switcher-search' | 'help-keys' | 'help-marks' | 'connection-card' | 'projects-menu';

export interface FinalState {
  /** "2.1": the screen and the state, numbered as in this list. */
  readonly id: string;
  /** Where the board draws it: the part and state id of its `only` mechanism (the `PARTS` list of the board source). */
  readonly part: string;
  readonly sid: string;
  readonly title: string;
  /** While true the app side is not compared (the board side still renders and is checked). The owner turns it off when the app matches. */
  readonly pending: boolean;
  /** Which release 1 builder turns `pending` off. */
  readonly owner: 'shell' | 'dock' | 'nav-state' | 'topbar' | 'details';
  readonly app: AppFixture;
  /**
   * The parts of the frame the app is held to. Absent: the whole frame is compared against the state's threshold. Present: only
   * these rectangles are compared and asserted (the whole frame's ratio is still written to the JSON, never asserted). A release
   * that redesigns only some of a screen (the dock, the top bar) names those parts here and leaves the rest to a later release.
   * Only the regions that apply to a size count; a size none of them applies to is compared whole.
   */
  readonly regions?: readonly FrameRegion[];
}

/** One rectangle of a frame the app is compared in, in frame pixels: `rect` is [x, y, width, height] from the frame's top left. */
export interface FrameRegion {
  readonly name: string;
  readonly rect: readonly [x: number, y: number, width: number, height: number];
  /** The largest mismatch ratio (mismatched pixels over the rectangle's area) that passes. Default 0: it must match exactly. */
  readonly threshold?: number;
  /** The sizes the rectangle applies to (the narrow frame lays out differently). Default: all three. */
  readonly variants?: readonly Variant[];
}

/** The regions of a state that apply to one size. */
export const regionsFor = (state: Pick<FinalState, 'regions'>, variant: Variant): readonly FrameRegion[] =>
  (state.regions ?? []).filter(region => region.variants?.includes(variant) ?? true);

const d = (item: string, draft: Omit<Draft, 'item'>): Draft => ({ item, ...draft });

const WIDE: readonly Variant[] = ['light', 'dark'], NARROW: readonly Variant[] = ['narrow'];
type Rect = FrameRegion['rect'];
/** The largest mismatch ratio of a region at 1280 x 800 (light and dark) and at 900 x 650 (narrow); absent: it must match exactly. */
type Limits = readonly [wide: number, narrow: number];
/** A rectangle that is not where it is at the other size: one region for light and dark, one for narrow. */
const box = (name: string, wide: Rect, narrow: Rect, limits?: Limits): FrameRegion[] => [
  { name, rect: wide, variants: WIDE, ...(limits ? { threshold: limits[0] } : {}) },
  { name: `${name} (narrow)`, rect: narrow, variants: NARROW, ...(limits ? { threshold: limits[1] } : {}) }];
/** A full-width band: its rows at 1280 x 800 and at 900 x 650. */
const band = (name: string, wide: readonly [y: number, height: number], narrow: readonly [y: number, height: number], limits?: Limits): FrameRegion[] =>
  box(name, [0, wide[0], 1280, wide[1]], [0, narrow[0], 900, narrow[1]], limits);
/** The top bar's right-hand glyphs rasterise a few pixels apart (measured 0.05% at most). */
const BAR: Limits = [0.001, 0.001];
const topBar = (limits?: Limits) => band('top bar', [0, 40], [0, 40], limits);
const dockLine = (limits?: Limits) => band('dock line', [760, 40], [610, 40], limits);
/** The open dock, from its top edge (the board's, in the frame) to the foot of the window. */
const dockOpen = (wideTop: number, narrowTop: number, limits?: Limits) => band('dock', [wideTop, 800 - wideTop], [narrowTop, 650 - narrowTop], limits);
/** Details folded to its 36px rail, down to `wideFoot` / `narrowFoot` (the dock's top edge, or the window's foot above the dock line). */
const detailsRail = (wideFoot: number, narrowFoot: number, limits?: Limits) => box('details rail', [1244, 40, 36, wideFoot - 40], [864, 40, 36, narrowFoot - 40], limits);

const stateList: readonly FinalState[] = [
  // 1. The window and the Map
  { id: '1.1', part: 'Window', sid: 'b-wait', owner: 'dock', pending: false, title: 'Question waiting', app: { view: { dock: 'open', dockQuestion: 0 } } },
  { id: '1.2', part: 'Window', sid: 'b-sel', owner: 'details', pending: false, title: 'Item selected', app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' } } },
  { id: '1.3', part: 'Window', sid: 'b-graph', owner: 'details', pending: true, title: 'Graph', app: { view: { selected: 'a6', mode: 'graph', details: 'folded', dock: 'line' },
    // Neither the Graph nor a folded Details is saved data the fixture can set: the owner's two clicks reach them.
    act: [{ click: 'Graph' }, { click: 'Fold Details' }] } },
  { id: '1.4', part: 'Window', sid: 'b-long', owner: 'shell', pending: false, title: 'Long text', app: { items: { longText: true }, view: { selected: 'a8', details: 'open', dock: 'line', shown: ['a7'] } } },
  // 2. Answering in the dock
  { id: '2.1', part: 'Answering', sid: 'd-opts', owner: 'dock', pending: false, title: 'Three options, one recommended, with a note on the picked one', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 0, note: note1 })] } },
  { id: '2.2', part: 'Answering', sid: 'd-own', owner: 'dock', pending: true, title: 'Writing my own answer instead of picking one', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { own: 'Add the note, but link to the deploy docs instead of explaining the rebuild.' })] } },
  { id: '2.3', part: 'Answering', sid: 'd-long', owner: 'dock', pending: false, title: 'A long question with long options', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1 }, drafts: [d(Q2, { pick: 0 })] } },
  { id: '2.4', part: 'Answering', sid: 'd-send', owner: 'dock', pending: true, title: 'Sending, then sent, then waiting for the agent', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 0 })],
    // The Sent bar is the 2.7 s hold right after Send, so the app gets there by sending, not by saved data.
    act: [{ click: 'Send' }] } },
  { id: '2.5', part: 'Answering', sid: 'd-fail', owner: 'dock', pending: true, title: 'A send that failed', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 1, note: 'Keep it under five lines, and link the deploy docs.' })], questions: { failed: [Q1] } } },
  { id: '2.6', part: 'Answering', sid: 'd-none', owner: 'dock', pending: false, title: 'Nothing waiting on me', app: { view: { selected: null, dock: 'line' }, questions: { sent: [Q1, Q2] } } },
  { id: '2.7', part: 'Answering', sid: 'd-other', owner: 'dock', pending: true, title: 'Questions waiting in other sessions', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d('schema-1', { pick: 0 })], chrome: { otherPopover: 'schema-1' } } },
  { id: '2.8', part: 'Answering', sid: 'd-move', owner: 'dock', pending: false, title: 'Moving between waiting questions, with a draft kept on the first', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1 }, drafts: [d(Q1, { pick: 0, note: note1 })] } },
  { id: '2.9', part: 'Answering', sid: 'd-tall', owner: 'dock', pending: false, title: 'The dock dragged tall by its top edge', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1, dockHeight: 'tall' }, drafts: [d(Q2, { pick: 0 })] } },
  { id: '2.10', part: 'Answering', sid: 'd-short', owner: 'dock', pending: true, title: 'The dock dragged short', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1, dockHeight: 'short' }, drafts: [d(Q2, { pick: 0 })] } },
  // 3. An item's conversation: where Details sits (its content is a later release)
  { id: '3.1', part: 'Conversation', sid: 'c-details', owner: 'details', pending: false, title: 'Details beside the Map', app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' } } },
  // 3.2 stays pending: the bigger view of Details is release 3.
  { id: '3.2', part: 'Conversation', sid: 'c-read', owner: 'details', pending: true, title: 'A bigger view for a long thread', app: { view: { selected: 'a2.2.1', details: 'bigger', dock: 'line' } } },
  { id: '3.6', part: 'Conversation', sid: 'c-fold', owner: 'details', pending: true, title: 'Details folded to a strip, dock open', app: { view: { selected: 'a2.2.1.1', details: 'folded', dock: 'open', dockQuestion: 0 }, act: [{ click: 'Fold Details' }] } },
  // 12. Connection. 12.2 to 12.9 stay pending: the connection states and their banners (the connect guide, the last good copy, the unsaved-change notice,
  // the loading skeleton, "This session can't be read") are release 3 (ENGINEERING-PLAN: D3); 12.1's card is above.
  { id: '12.1', part: 'R4-Connection', sid: 'c-live', owner: 'topbar', pending: true, title: 'Live', app: { sessions: { connection: 'live' }, chrome: { overlay: 'connection-card' }, act: [{ click: 'Live' }] } },
  { id: '12.2', part: 'R4-Connection', sid: 'c-none', owner: 'topbar', pending: true, title: 'Not connected', app: { sessions: { connection: 'none' } } },
  { id: '12.3', part: 'R4-Connection', sid: 'c-off', owner: 'topbar', pending: true, title: 'Agent not running', app: { sessions: { connection: 'off' } } },
  { id: '12.4', part: 'R4-Connection', sid: 'c-closed', owner: 'topbar', pending: true, title: 'Session closed', app: { sessions: { connection: 'closed' } } },
  { id: '12.5', part: 'R4-Connection', sid: 'c-loading', owner: 'topbar', pending: true, title: 'Loading', app: { sessions: { connection: 'loading' } } },
  { id: '12.6', part: 'R4-Connection', sid: 'c-reconnect', owner: 'topbar', pending: true, title: 'Reconnecting', app: { sessions: { connection: 'reconnecting' } } },
  { id: '12.7', part: 'R4-Connection', sid: 'c-unreadable', owner: 'topbar', pending: true, title: 'This session can’t be read', app: { sessions: { connection: 'unreadable' } } },
  { id: '12.8', part: 'R4-Connection', sid: 'c-stale', owner: 'topbar', pending: true, title: 'Showing the last good copy', app: { sessions: { connection: 'stale' } } },
  { id: '12.9', part: 'R4-Connection', sid: 'c-unsaved', owner: 'topbar', pending: true, title: 'Your last change may not be saved', app: { sessions: { connection: 'unsaved' }, items: { later: ['a8'] } } },
  // 13. Session and project switcher
  { id: '13.1', part: 'R4-Switcher', sid: 's-open', owner: 'nav-state', pending: false, title: 'Open', app: { chrome: { overlay: 'switcher' }, act: [{ key: 'Meta+o' }] } },
  { id: '13.2', part: 'R4-Switcher', sid: 's-search', owner: 'nav-state', pending: false, title: 'Typing finds sessions and projects by name', app: { chrome: { overlay: 'switcher-search' }, act: [{ key: 'Meta+o' }, { type: 'sch' }] } },
  // 14. Pages
  { id: '14.1', part: 'R4-Pages', sid: 'p-projects', owner: 'nav-state', pending: false, title: 'Projects', app: { chrome: { page: 'projects' } } },
  { id: '14.2', part: 'R4-Pages', sid: 'p-sessions', owner: 'nav-state', pending: false, title: 'All sessions', app: { chrome: { page: 'sessions' }, act: [{ click: 'All 6' }] } },
  // A page is never saved (old ui.json), so the Archive is opened from the Map's top bar.
  { id: '14.3', part: 'R4-Pages', sid: 'p-archive', owner: 'nav-state', pending: false, title: 'Archive', app: { chrome: { page: 'archive' }, act: [{ click: 'Archive' }] } },
  { id: '14.4', part: 'R4-Pages', sid: 'p-projmenu', owner: 'nav-state', pending: false, title: 'Projects, with its … menus',
    app: { chrome: { page: 'projects', overlay: 'projects-menu' }, act: [{ click: 'Register a project, discover sessions' }] } },
  { id: '14.5', part: 'R4-Pages', sid: 'p-chip', owner: 'nav-state', pending: false, title: 'From a page back to the dock', app: { view: { selected: null, dock: 'open', dockQuestion: 0, dockHeight: 'chip' } } },
  // 15. Empty and first-run states
  { id: '15.1', part: 'R4-Empty', sid: 'e-first', owner: 'nav-state', pending: false, title: 'No projects yet', app: { chrome: { page: 'first' } } },
  // 15.2 stays pending: the app draws a "Connect existing session" link under the empty project's card; the board has none there.
  { id: '15.2', part: 'R4-Empty', sid: 'e-nosess', owner: 'nav-state', pending: true, title: 'A project with no sessions', app: { chrome: { page: 'project-empty' } } },
  { id: '15.3', part: 'R4-Empty', sid: 'e-emptymap', owner: 'nav-state', pending: false, title: 'Empty Map', app: { sessions: { unnamed: true }, items: { empty: true }, view: { dock: 'line' } } },
  { id: '15.4', part: 'R4-Empty', sid: 'e-nowait', owner: 'nav-state', pending: false, title: 'Nothing waiting on me', app: { questions: { sent: [Q1], othersSent: false }, items: { edit: { [Q2]: { s: 'in_progress' } } }, view: { dock: 'line' } } },
  // 16. Help
  { id: '16.1', part: 'R4-Help', sid: 'h-keys', owner: 'topbar', pending: false, title: 'Keys, grouped by what I’m doing', app: { chrome: { overlay: 'help-keys' }, act: [{ key: '?' }] } },
  { id: '16.2', part: 'R4-Help', sid: 'h-marks', owner: 'topbar', pending: false, title: 'Markers and statuses', app: { chrome: { overlay: 'help-marks' }, act: [{ key: '?' }, { click: 'Markers and statuses' }] } }
];

/** The Details column's left edge (its 1px border and the column's ground): where it sits, not what it says (Details' content is release 3). */
const detailsEdge = (limits?: Limits) => box('details edge', [880, 40, 3, 616], [560, 40, 3, 467], limits);
/**
 * The top bar of the first board file's states (1 to 3): all of it but the connection chip's dot and "Live", which sit 1px
 * further right in the second file (R4: padding 7px, 66%) than in the first (6px, 62%). The app follows R4; see `regionsById`.
 */
const topBarMain = (limits?: Limits) => [...box('top bar left', [0, 0, 276, 40], [0, 0, 200, 40], limits), ...box('top bar right', [330, 0, 950, 40], [224, 0, 676, 40], limits)];
/** The top bar of an unnamed session (15.3): its logo and its right-hand controls; the name between is the app's own form ("agent · where"), not the board's. */
const topBarUnnamed = (limits?: Limits) => [...box('top bar logo', [0, 0, 40, 40], [0, 0, 40, 40], limits), ...box('top bar controls', [560, 0, 720, 40], [690, 0, 210, 40], limits)];
/** The dock line's text and its other-sessions chip, without the sent chip: the board's token for the sent chip's colour resolves with dark-theme values in light frames. */
const dockLineQuiet = (limits?: Limits) => [...box('dock line text', [0, 760, 700, 40], [0, 610, 690, 40], limits), ...box('dock line other-sessions chip', [1130, 760, 150, 40], [790, 610, 110, 40], limits)];
/** The dock line's two ends: its pill and its chips. The text between is left out where the board's own files disagree (see `regionsById`). */
const dockLineEnds = (limits?: Limits) => [...box('dock line pill', [0, 760, 100, 40], [0, 610, 100, 40], limits), ...box('dock line chip', [1090, 760, 150, 40], [740, 610, 128, 40], limits)];

/**
 * What release 1 holds the app to, per state: the shell, the top bar, the dock, the Details rail and the overlays. The Map's
 * rows, the topic brief and Details' content are releases 2 and 3 and are left out of every region. A state with no entry
 * here is compared whole (final-thresholds.json).
 */
const regionsById: Readonly<Record<string, readonly FrameRegion[]>> = {
  // The limits below are what each region measured on 2026-10-17, plus a little: a few pixels of the dock's grip (its rounded ends rasterise a
  // fraction of a pixel apart), of the top bar's right-hand glyphs and of the chevron. A region with no limit matches exactly.
  '1.1': [...topBarMain(BAR), ...dockOpen(572, 351, [0.002, 0.002])],
  '1.2': [...topBarMain(BAR), ...dockLine([0.003, 0.004]), ...detailsEdge([0.002, 0.002])],
  // 1.3 and 3.6 stay pending: the rail's glyphs (», the status mark, the vertical label) sit 1px right of the board's in the app (about 1% of the rail).
  '1.3': [...topBarMain(), ...dockLine(), ...detailsRail(760, 610)],
  '1.4': [...topBarMain(BAR), ...dockLine([0.003, 0.004])],
  '2.1': [...topBarMain(BAR), ...dockOpen(523, 301, [0.002, 0.002])],
  // 2.2 and 2.10 stay pending: the option cards start 1px higher in the app than in the board (1.3% and 5.1% of the dock).
  '2.2': [...topBarMain(), ...dockOpen(527, 306)],
  '2.3': [...topBarMain(BAR), ...dockOpen(398, 260, [0.002, 0.003])],
  // 2.4 stays pending: the own-answer box is dimmed after Send (the board leaves it bright) and the sent button carries another icon.
  '2.4': [...topBarMain(), ...dockOpen(572, 351)],
  // 2.5 stays pending: recovery behaviour differs (the board leaves the other cards undimmed, words the failure otherwise and offers Copy and Retry only).
  '2.5': [...topBarMain(), ...dockOpen(523, 301)],
  // The board's first file words this clear line "Nothing waiting on you" and counts one sent answer (it counts a pick, not the send);
  // R4 (15.3, 15.4) adds "New questions open here." and the app follows R4. So this frame holds the line's icon and its chip only.
  '2.6': [...topBarMain(BAR), ...box('dock line icon', [0, 760, 32, 40], [0, 610, 32, 40]), ...box('dock line other-sessions chip', [1130, 760, 150, 40], [790, 610, 110, 40])],
  // 2.7 stays pending: the other-sessions popover is about 5px shorter than the board's (its top edge sits 4px lower); 14% of the popover differs.
  '2.7': [...topBarMain(), ...dockOpen(572, 351), ...box('other-sessions popover', [868, 168, 404, 400], [487, 52, 406, 296])],
  '2.8': [...topBarMain(BAR), ...dockOpen(418, 260, [0.003, 0.002])],
  '2.9': [...topBarMain(BAR), ...dockOpen(170, 170, [0.002, 0.002])],
  '2.10': [...topBarMain(), ...dockOpen(600, 450)],
  '3.1': [...topBarMain(BAR), ...dockLine([0.003, 0.004]), ...detailsEdge([0.002, 0.002])],
  '3.6': [...topBarMain(), ...dockOpen(572, 351), ...detailsRail(572, 351)],
  // The board's second file (R4, states 12 to 16) draws the dock line's question in 72% text; its first file (1 to 3) in full text.
  // The app draws it as the first file does, so these states hold the line's pill and chips and leave the text between.
  // The board's R4 file also draws the dock's chevron in full text colour (the first file and the app: muted), so the chip region stops before it.
  // 12.1 stays pending: the connection card says other things (its last-message time, the queue sentence, "Disconnect" for "Close session" and "Copy session ID").
  '12.1': [...topBar(), ...dockLineEnds(), ...box('connection card', [316, 36, 324, 142], [316, 36, 324, 142])],
  '13.1': [...topBar(BAR), ...dockLineEnds(), ...box('switcher card', [31, 39, 398, 454], [31, 39, 398, 454], [0.004, 0.004])],
  '13.2': [...topBar(BAR), ...dockLineEnds(), ...box('switcher card', [31, 39, 398, 218], [31, 39, 398, 218], [0.003, 0.003])],
  // The R4 board's dock path runs to the question itself ("note on workspace keys"), the first file's and the app's to its parent ("which cache keys"): about 0.25% of the dock.
  '14.5': [...topBar(BAR), ...dockOpen(440, 357, [0.004, 0.006])],
  // The key lists' rows sit a pixel off at some fractional line heights: a few hundred pixels of key caps and legends.
  '16.1': [...topBar(BAR), ...dockLineEnds(), ...box('help panel', [614, 46, 644, 588], [10, 46, 880, 564], [0.003, 0.003])],
  '16.2': [...topBar(BAR), ...dockLineEnds(), ...box('help panel', [614, 46, 644, 470], [10, 46, 880, 430], [0.001, 0.001])],
  // R4's empty-Map line (clear0) keeps "New questions open here." at 900 wide; its "Nothing waiting" line (15.4) drops it. The app trims both, so 15.3 narrow holds the icon only.
  '15.3': [...topBarUnnamed(BAR), { name: 'dock line text', rect: [0, 760, 700, 40], variants: WIDE }, { name: 'dock line icon (narrow)', rect: [0, 610, 36, 40], variants: NARROW },
    ...box('dock line other-sessions chip', [1130, 760, 150, 40], [790, 610, 110, 40])],
  '15.4': [...topBar(BAR), ...dockLineQuiet()]
};

export const finalStates: readonly FinalState[] = stateList.map(state => regionsById[state.id] ? { ...state, regions: regionsById[state.id]! } : state);

export const finalIds: readonly string[] = finalStates.map(state => state.id);

/** The state with this id; throws for an id that is not registered. */
export function finalState(id: string): FinalState {
  const state = finalStates.find(value => value.id === id);
  if (!state) throw new Error(`no final-board state ${id}`);
  return state;
}
