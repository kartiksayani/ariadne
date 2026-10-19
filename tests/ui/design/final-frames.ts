// The registry of final-board states the app is held to (see README.md in this folder). One entry per board state:
// where the board draws it (part + sid), what the app is put in to match it (an AppFixture), whether the app is
// compared yet (`pending`), and who is expected to turn that on. Thresholds live in final-thresholds.json.
// Kept free of app imports: Node (final.spec.mts) and Vite (final-gallery.tsx) read it alike.
import { Q1, Q2, note1, type MarkSet } from './final-world';

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
export interface Draft { readonly item: string; readonly pick?: number; readonly note?: string; readonly own?: string;
  /** Words typed in the item's Details composer (the reply, note or follow-up box), not in an answer's cards (3.3). */ readonly reply?: string }

/** A step taken in the app after it mounts, to reach a state that is not data (an open menu, a hover). */
export type Step =
  | { readonly key: string }
  | { readonly click: string }
  | { readonly hover: string }
  | { readonly type: string }
  /** Time passing in the app: milliseconds waited, for what a dwell does (the 1 s that clears a marker, 9.10). */
  | { readonly wait: number }
  /** The Map's own scroller (the Tree's, or the Graph's), moved to its top: 8.5 (the selected row is out of view below) and the Graph states
   * (ALPHA20-REPLAN §3a: the app opens the Graph scrolled to the selected node, the board at the canvas top). */
  | { readonly scroll: 'top' }
  /** A notice the app raises by itself in real life (alpha.21 W5, final.spec.mts `noticeSpecs`), put in the store with the board's words. */
  | { readonly notice: 'save' | 'recovered' | 'agentrm' | 'stuck' }
  /** The app's transport changes under it (12.8: a read fails after a good one; 12.9: the next save is lost on its way back). */
  | { readonly drive: 'read-fails' | 'save-unsure' };

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
    /** Items the owner parked ("Later"): kept in the preferences, not on the item. */ readonly later?: readonly string[];
    /** Items the agent removed into the bin at 21:19, each with the owner's unsent message the removal cancelled (10.1, 10.11, 11.3). */
    readonly binned?: readonly { readonly item: string; readonly words?: string }[] };
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
  readonly map?: MapWorld;
  readonly act?: readonly Step[];
}
/**
 * The Map of alpha.20 (the reading state, final-world.ts): the findings to ack, related and dependent items, the topic brief and the
 * owner's recent trail. Present (even as `{}`), the state gets them; absent, it renders as it did before the Map was redone.
 * - marks: which rows carry New / Changed, from a seen baseline at 20:40 (`base`), moved back three days (`long`), or after the owner
 *   answered "prefix bump timing" (`because`). Absent: no baseline, so no markers.
 * - seen: items the owner already marked seen one by one (5.3).
 * - filter: the statuses saved in the view's filter (8.2).
 * - focus: the item the Map is focused on (8.4).
 */
export interface MapWorld {
  readonly marks?: MarkSet;
  readonly seen?: readonly string[];
  readonly filter?: readonly ('waiting_on_me' | 'open' | 'in_progress' | 'decided' | 'done' | 'replaced')[];
  readonly focus?: string;
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
  connection: [] as readonly Connection[]
};

/**
 * The values a state's fixture sets that the fixture builder (final-fixtures.ts) accepts but cannot yet put the current app
 * in: the "Show more" links, the connection states the app has no data for, and an open session other than
 * the default. It is derived from the values the state sets: a field is flagged when its value is on the `notYet` list (`shown`
 * whenever set). A state that lists any of them cannot match the board until the app grows the feature; its frame
 * JSON records them as `unhonoured`, so a builder knows the mismatch is the feature, not a fixture mistake.
 */
export function unhonoured(app: AppFixture, list: typeof notYet = notYet): string[] {
  const { view, chrome, sessions } = app, out: string[] = [];
  if (view?.shown) out.push(`view.shown=${view.shown.join(',')}`);
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
  readonly owner: 'shell' | 'dock' | 'nav-state' | 'topbar' | 'details'
    // alpha.20, the Map: its rows (W2), the topic band (W3), the filter (W4), the changes (W5), the Graph (W1).
    | 'rows' | 'band' | 'filter' | 'changes' | 'graph'
    // alpha.21: remove, archive and the bin (W7).
    | 'remove';
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
  /** The rectangle is where the app draws it, and the board draws it `dy` rows lower (a negative `dy`: higher). For a layer the app sits lower under the
   * band's second line (ALPHA20-REPLAN §3a, D10 follow-on): the same pixels are compared, not a bigger tolerance. */
  readonly dy?: number;
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
  { id: '1.3', part: 'Window', sid: 'b-graph', owner: 'details', pending: false, title: 'Graph', app: { view: { selected: 'a6', mode: 'graph', details: 'folded', dock: 'line' },
    // Neither the Graph nor a folded Details is saved data the fixture can set: the owner's two clicks reach them.
    act: [{ click: 'Graph' }, { click: 'Fold Details' }] } },
  { id: '1.4', part: 'Window', sid: 'b-long', owner: 'shell', pending: false, title: 'Long text', app: { items: { longText: true }, view: { selected: 'a8', details: 'open', dock: 'line', shown: ['a7'] } } },
  // 2. Answering in the dock
  { id: '2.1', part: 'Answering', sid: 'd-opts', owner: 'dock', pending: false, title: 'Three options, one recommended, with a note on the picked one', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 0, note: note1 })] } },
  { id: '2.2', part: 'Answering', sid: 'd-own', owner: 'dock', pending: false, title: 'Writing my own answer instead of picking one', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { own: 'Add the note, but link to the deploy docs instead of explaining the rebuild.' })] } },
  { id: '2.3', part: 'Answering', sid: 'd-long', owner: 'dock', pending: false, title: 'A long question with long options', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1 }, drafts: [d(Q2, { pick: 0 })] } },
  { id: '2.4', part: 'Answering', sid: 'd-send', owner: 'dock', pending: false, title: 'Sending, then sent, then waiting for the agent', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 0 })],
    // The Sent bar is the 2.7 s hold right after Send, so the app gets there by sending, not by saved data.
    act: [{ click: 'Send' }] } },
  { id: '2.5', part: 'Answering', sid: 'd-fail', owner: 'dock', pending: true, title: 'A send that failed', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d(Q1, { pick: 1, note: 'Keep it under five lines, and link the deploy docs.' })], questions: { failed: [Q1] } } },
  { id: '2.6', part: 'Answering', sid: 'd-none', owner: 'dock', pending: false, title: 'Nothing waiting on me', app: { view: { selected: null, dock: 'line' }, questions: { sent: [Q1, Q2] } } },
  { id: '2.7', part: 'Answering', sid: 'd-other', owner: 'dock', pending: false, title: 'Questions waiting in other sessions', app: { view: { selected: Q1, dock: 'open', dockQuestion: 0 }, drafts: [d('schema-1', { pick: 0 })], chrome: { otherPopover: 'schema-1' } } },
  { id: '2.8', part: 'Answering', sid: 'd-move', owner: 'dock', pending: false, title: 'Moving between waiting questions, with a draft kept on the first', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1 }, drafts: [d(Q1, { pick: 0, note: note1 })] } },
  { id: '2.9', part: 'Answering', sid: 'd-tall', owner: 'dock', pending: false, title: 'The dock dragged tall by its top edge', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1, dockHeight: 'tall' }, drafts: [d(Q2, { pick: 0 })] } },
  { id: '2.10', part: 'Answering', sid: 'd-short', owner: 'dock', pending: false, title: 'The dock dragged short', app: { view: { selected: Q2, dock: 'open', dockQuestion: 1, dockHeight: 'short' }, drafts: [d(Q2, { pick: 0 })] } },
  // 3. An item's conversation: where Details sits (its content is a later release)
  { id: '3.1', part: 'Conversation', sid: 'c-details', owner: 'details', pending: false, title: 'Details beside the Map', app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' } } },
  { id: '3.2', part: 'Conversation', sid: 'c-read', owner: 'details', pending: false, title: 'A bigger view for a long thread', app: { view: { selected: 'a2.2.1', details: 'bigger', dock: 'line' } } },
  // 3.3, 3.4, 3.5 and 3.7 stay pending (alpha.21 W4). The composer, the labels and the status line are built; what keeps the frame from matching is
  // outside them: the Details body above (W3's badge row, change box, actions and Related), and in 3.3 the fixture's frozen clock, which reads the agent as
  // reconnecting and greys Send. Run with FINAL_APP=1 to see them.
  { id: '3.3', part: 'Conversation', sid: 'c-reply', owner: 'details', pending: true, title: 'Replying to an item from Details', app: { view: { selected: 'a6', details: 'open', dock: 'line' },
    // Typed, not a saved draft: a draft the app loads at start is "back after a restart" (11.2), with its own chip and bar.
    act: [{ key: 'r' }, { type: 'Also mention the per-workspace fallback, and link to the SOP once it’s on the wiki.' }] } },
  { id: '3.4', part: 'Conversation', sid: 'c-wait', owner: 'details', pending: true, title: 'The item is waiting on me: answer it from Details', app: { view: { selected: Q1, details: 'open', dock: 'line' }, drafts: [d(Q1, { pick: 0 })] } },
  // 3.5: the app's fixture has no "queued" delivery stage (a sent answer is "received", which reads "Picked up"), so "Sent at … Undo" cannot be reached by data.
  { id: '3.5', part: 'Conversation', sid: 'c-sent', owner: 'details', pending: true, title: 'Answered from Details: my answer shows as a sent message', app: { view: { selected: Q1, details: 'open', dock: 'line' }, drafts: [d(Q1, { pick: 0, note: note1 })],
    questions: { sent: [Q1] } } },
  { id: '3.6', part: 'Conversation', sid: 'c-fold', owner: 'details', pending: false, title: 'Details folded to a strip, dock open', app: { view: { selected: 'a2.2.1.1', details: 'folded', dock: 'open', dockQuestion: 0 }, act: [{ click: 'Fold Details' }] } },
  { id: '3.7', part: 'Conversation', sid: 'c-picked', owner: 'details', pending: true, title: 'After the agent picks the answer up', app: { view: { selected: Q1, details: 'open', dock: 'line' }, drafts: [d(Q1, { pick: 0, note: note1 })],
    questions: { sent: [Q1] } } },
  // 11.2 and 11.5 stay pending: the notices come from the 5.7 hooks, which App.tsx mounts in W2's piece (the app side cannot show them before it).
  { id: '11.2', part: 'R4-Notices', sid: 'n-recovered', owner: 'details', pending: true, title: 'Unsent words back after a restart', app: { view: { selected: 'a2.2.1', details: 'open', dock: 'line' }, drafts: [d('a2.2.1', { reply: 'Keep the SOP short.' })] } },
  { id: '11.5', part: 'R4-Notices', sid: 'n-stuck', owner: 'details', pending: true, title: 'A reply that’s stuck', app: { view: { selected: 'a2.2.1', details: 'open', dock: 'line' } } },
  // 12. Connection (alpha.21 D3): the top bar, the line above the Map, the dock line and, for 12.7, the Map's panel are held to the board (`regionsById`).
  // 12.5 stays pending: the app reads the selected session before it draws anything (a hung read leaves the Projects page up), so the board's
  // loading frame (Map skeleton, "Connecting…", the dock's skeleton) cannot be reached at start; the dock's skeleton is a unit test's
  // (tests/ui/app/connection-line.test.tsx).
  { id: '12.1', part: 'R4-Connection', sid: 'c-live', owner: 'topbar', pending: false, title: 'Live', app: { sessions: { connection: 'live' }, chrome: { overlay: 'connection-card' }, act: [{ click: 'Live' }] } },
  { id: '12.2', part: 'R4-Connection', sid: 'c-none', owner: 'topbar', pending: false, title: 'Not connected', app: { sessions: { connection: 'none' }, act: [{ click: 'How to connect' }] } },
  { id: '12.3', part: 'R4-Connection', sid: 'c-off', owner: 'topbar', pending: false, title: 'Agent not running', app: { sessions: { connection: 'off' } } },
  { id: '12.4', part: 'R4-Connection', sid: 'c-closed', owner: 'topbar', pending: false, title: 'Session closed', app: { sessions: { connection: 'closed' } } },
  { id: '12.5', part: 'R4-Connection', sid: 'c-loading', owner: 'topbar', pending: true, title: 'Loading', app: { sessions: { connection: 'loading' } } },
  { id: '12.6', part: 'R4-Connection', sid: 'c-reconnect', owner: 'topbar', pending: false, title: 'Reconnecting', app: { sessions: { connection: 'reconnecting' } } },
  { id: '12.7', part: 'R4-Connection', sid: 'c-unreadable', owner: 'topbar', pending: false, title: 'This session can’t be read', app: { sessions: { connection: 'unreadable' } } },
  { id: '12.8', part: 'R4-Connection', sid: 'c-stale', owner: 'topbar', pending: false, title: 'Showing the last good copy', app: { sessions: { connection: 'stale' }, act: [{ drive: 'read-fails' }] } },
  { id: '12.9', part: 'R4-Connection', sid: 'c-unsaved', owner: 'topbar', pending: false, title: 'Your last change may not be saved', app: { sessions: { connection: 'unsaved' }, items: { later: ['a8'] }, act: [{ drive: 'save-unsure' }, { hover: '.tree-item[data-item-id="a2.2.2"]' }, { wait: 1100 }, { click: 'Later' }, { hover: '.tb' }, { hover: '.tb' }] } },
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

// The alpha.20 Map. Rule for its regions (details at `mapRegionsById`): no region spans the rows, because the app drops the board's +7/+4
// per-box row padding (ALPHA20-REPLAN D1) and so no row below the first box can line up; the band, the first row, the overlays and the
// Graph canvas are compared, and the rows' looks go to side-by-side PNGs for a human. D12 ("Continue here" is left out of the "…" menu)
// is why 10.12 compares the menu's first row only.
// Each state below is the Map half of a board state that is already registered above (1.3, 3.1, 3.6: those hold the
// top bar, the dock and the Details rail) or of one that has no entry yet (4 to 10). All are turned on (the pieces have merged), and are
// numbered like the board; the three whose board state already has an entry above end in `m` ("Map body").
// Their `act` steps name the built controls by role and accessible name ("Brief by the agent", "More actions for", "Filter by status").
// A region that fails is a real difference a piece should fix, or a harness problem; a (b) deviation or data difference is left out of the
// region with a comment (`bandPieces` below).
const marked = (marks: MarkSet, rest: Omit<NonNullable<AppFixture['map']>, 'marks'> = {}): NonNullable<AppFixture['map']> => ({ marks, ...rest });
/** The topic band's "What changed" opener: "5 new 5 changed since 20:40" (D18). Named by its counts: at a narrow band it drops "since …" (D10). */
const openChanges: Step = { click: '5 changed' };
const mapStateList: readonly FinalState[] = [
  { id: '1.3m', part: 'Window', sid: 'b-graph', owner: 'graph', pending: false, title: 'Graph: the Map body',
    app: { view: { selected: 'a6', mode: 'graph', details: 'folded', dock: 'line' }, map: {}, act: [{ click: 'Graph' }, { click: 'Fold Details' }, { scroll: 'top' }] } },
  { id: '3.1m', part: 'Conversation', sid: 'c-details', owner: 'rows', pending: false, title: 'Details beside the Map: the Map body',
    app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' }, map: {} } },
  { id: '3.6m', part: 'Conversation', sid: 'c-fold', owner: 'rows', pending: false, title: 'Details folded, dock open: the Map body',
    app: { view: { selected: 'a2.2.1.1', details: 'folded', dock: 'open', dockQuestion: 0 }, map: {}, act: [{ click: 'Fold Details' }] } },
  { id: '4.1', part: 'Acking', sid: 'k-toack', owner: 'rows', pending: false, title: 'Findings to ack: marked on the row, counted on the topic, with Ack all',
    app: { view: { selected: 'a9', details: 'open', dock: 'line' }, map: {} } },
  { id: '4.3', part: 'Acking', sid: 'k-confirm', owner: 'band', pending: false, title: 'Ack all: a short review before it saves',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ click: 'Ack all (3)' }] } },
  { id: '4.4', part: 'Acking', sid: 'k-all', owner: 'band', pending: false, title: 'After Ack all: Undo stays on the topic row',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ click: 'Ack all (3)' }, { click: 'Ack all' }] } },
  { id: '5.1', part: 'Changes', sid: 'w-glance', owner: 'changes', pending: false, title: 'Back after an hour: New and Changed on the rows, Next unseen',
    app: { view: { selected: null, dock: 'line' }, map: marked('base') } },
  { id: '5.2', part: 'Changes', sid: 'w-brief', owner: 'changes', pending: false, title: 'The topic brief, written by the agent',
    app: { view: { selected: null, dock: 'line' }, map: marked('base'), act: [openChanges, { click: 'Brief by the agent' }] } },
  // The board opens the rows of "note on workspace keys" and "cache warm-up script" on Before → after; "shared-cache retries" is already seen.
  { id: '5.3', part: 'Changes', sid: 'w-since', owner: 'changes', pending: false, title: 'Since you were here: before → after on demand, Mark all caught up',
    app: { view: { selected: null, dock: 'line' }, map: marked('base', { seen: ['a9'] }), act: [openChanges] } },
  { id: '5.4', part: 'Changes', sid: 'w-caught', owner: 'changes', pending: false, title: 'All caught up: the markers clear, Undo stays for a few seconds',
    app: { view: { selected: null, dock: 'line' }, map: marked('base'), act: [openChanges, { click: 'Mark all caught up' }] } },
  { id: '5.5', part: 'Changes', sid: 'w-long', owner: 'changes', pending: false, title: 'Back after two days: a calm summary first',
    app: { view: { selected: null, dock: 'line' }, map: marked('long'), act: [{ click: '30 changes' }] } },
  { id: '5.6', part: 'Changes', sid: 'w-because', owner: 'changes', pending: false, title: 'After I answer: Because you chose…',
    app: { items: { afterAnswer: true, edit: { [Q2]: { s: 'decided', o: 'Bump it in this release, and warm the cache from the deploy job.' } } },
      view: { selected: 'a5.1', details: 'open', dock: 'line' }, map: marked('because') } },
  { id: '5.7', part: 'Changes', sid: 'w-item', owner: 'changes', pending: false, title: 'On an item: what changed and why, with older history',
    app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' }, map: marked('base') } },
  { id: '7.2', part: 'Related', sid: 'r-graph', owner: 'graph', pending: false, title: 'In the Graph: related items as dashed lines',
    app: { view: { selected: 'a6', mode: 'graph', details: 'folded', dock: 'line' }, map: {}, act: [{ click: 'Graph' }, { click: 'Fold Details' }, { scroll: 'top' }] } },
  { id: '8.2', part: 'Find', sid: 'f-filter', owner: 'filter', pending: false, title: 'Filter by status, Waiting on me first',
    app: { view: { selected: null, dock: 'line' }, map: { filter: ['waiting_on_me', 'open'] }, act: [{ click: 'Filter by status' }] } },
  { id: '8.3', part: 'Find', sid: 'f-recent', owner: 'changes', pending: false, title: 'Recent: what I viewed and what changed lately',
    app: { view: { selected: null, dock: 'line' }, map: marked('base'), act: [{ click: 'Recent' }] } },
  { id: '8.4', part: 'Find', sid: 'f-focus', owner: 'band', pending: false, title: 'Focus: only the item and what is under it stay in the Map',
    app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' }, map: { focus: 'a2' } } },
  { id: '8.5', part: 'Find', sid: 'f-jump', owner: 'rows', pending: false, title: 'The selected item has scrolled out of view: one step back to it',
    app: { view: { selected: 'a9', details: 'open', dock: 'line' }, map: {}, act: [{ scroll: 'top' }] } },
  { id: '9.2', part: 'Markers', sid: 'm-next', owner: 'band', pending: false, title: 'n, or Next on the topic band, outlines the next unseen item',
    app: { view: { selected: null, dock: 'line' }, map: marked('base'), act: [{ key: 'n' }, { key: 'n' }, { key: 'n' }, { key: 'n' }, { key: 'n' }] } },
  { id: '9.9', part: 'Markers', sid: 'm-graph', owner: 'graph', pending: false, title: 'On Graph cards: the diamond alone, same shapes',
    app: { view: { selected: 'a6', mode: 'graph', details: 'folded', dock: 'line' }, map: marked('base'), act: [{ click: 'Graph' }, { click: 'Fold Details' }, { scroll: 'top' }] } },
  // alpha.21 W3 (Details body): the markers in the dock and in Details. Pending until W2's head is merged: the body starts where the head ends, so
  // the regions (the badge row, the change box, the actions row) are set on the integrated frame, not on this branch's.
  { id: '9.7', part: 'Markers', sid: 'm-dock', owner: 'changes', pending: true, title: 'In the answer dock: a question that changed since I last saw it',
    app: { view: { selected: null, dock: 'open', dockQuestion: 0 }, map: marked('base') } },
  { id: '9.8', part: 'Markers', sid: 'm-details', owner: 'changes', pending: true, title: 'In Details: the marker beside the status, and what changed',
    app: { view: { selected: 'a2.2.1.1', details: 'open', dock: 'line' }, map: marked('base') } },
  { id: '9.10', part: 'Markers', sid: 'm-seen', owner: 'changes', pending: true, title: 'Clearing: a second in Details clears it and shows Seen',
    app: { view: { selected: 'a6', details: 'open', dock: 'line' }, map: marked('base'), act: [{ wait: 1500 }] } },
  { id: '9.11', part: 'Markers', sid: 'm-reword', owner: 'changes', pending: true, title: 'A rewording alone: no marker anywhere, noted in the item’s history',
    app: { view: { selected: 'a8', details: 'open', dock: 'line' }, map: marked('base') } },
  { id: '10.12', part: 'R4-Dialogs', sid: 'd-tmenu', owner: 'band', pending: false, title: 'The topic’s … menu',
    // The board's R4 file draws this menu over the same marked Map as 5.1.
    app: { view: { selected: null, dock: 'line' }, map: marked('base'), act: [{ click: 'More actions for' }] } }
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
/** Where the dock line says where answers wait: between the question's text and the other-sessions chip. */
const dockChip = (limits?: Limits) => box('dock line chip: where answers wait', [700, 760, 390, 40], [600, 610, 160, 40], limits);
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
  '1.3': [...topBarMain(BAR), ...dockLine([0.003, 0.004]), ...detailsRail(760, 610)],
  '1.4': [...topBarMain(BAR), ...dockLine([0.003, 0.004])],
  '2.1': [...topBarMain(BAR), ...dockOpen(523, 301, [0.002, 0.002])],
  '2.2': [...topBarMain(BAR), ...dockOpen(527, 306, [0.002, 0.002])],
  '2.3': [...topBarMain(BAR), ...dockOpen(398, 260, [0.002, 0.003])],
  // The light frame's limit is wider: the board's token for the sent chip's colour resolves with dark-theme values there (see `dockLineQuiet`).
  '2.4': [...topBarMain(BAR), ...dockOpen(572, 351, [0.004, 0.003])],
  // 2.5 stays pending: recovery behaviour differs (the board leaves the other cards undimmed, words the failure otherwise and offers Copy and Retry only).
  '2.5': [...topBarMain(), ...dockOpen(523, 301)],
  // The board's first file words this clear line "Nothing waiting on you" and counts one sent answer (it counts a pick, not the send);
  // R4 (15.3, 15.4) adds "New questions open here." and the app follows R4. So this frame holds the line's icon and its chip only.
  '2.6': [...topBarMain(BAR), ...box('dock line icon', [0, 760, 32, 40], [0, 610, 32, 40]), ...box('dock line other-sessions chip', [1130, 760, 150, 40], [790, 610, 110, 40])],
  // The popover's own pixels (its 400px box, from its first row): the Map under its shadow is release 2's.
  '2.7': [...topBarMain(BAR), ...dockOpen(572, 351, [0.002, 0.002]), ...box('other-sessions popover', [870, 169, 400, 397], [490, 54, 400, 290], [0.002, 0.002])],
  '2.8': [...topBarMain(BAR), ...dockOpen(418, 260, [0.003, 0.002])],
  '2.9': [...topBarMain(BAR), ...dockOpen(170, 170, [0.002, 0.002])],
  '2.10': [...topBarMain(BAR), ...dockOpen(600, 450, [0.002, 0.002])],
  '3.1': [...topBarMain(BAR), ...dockLine([0.003, 0.004]), ...detailsEdge([0.002, 0.002])],
  '3.6': [...topBarMain(BAR), ...dockOpen(572, 351, [0.002, 0.002]), ...detailsRail(572, 351)],
  // The bigger view's head: the right-hand controls (Back and Forward draw greyed here, the board's enabled: under 1%). Masked: "← Map" (the app's button differs from the board's 26px ring button by about 12% of
  // its pixels, a visual nit for alpha.22) and the path between (the app's own text). The body (badge row, title, chat) is W3's and W4's.
  '3.2': [...topBarMain(BAR), ...dockLine([0.003, 0.004]), ...box('details head, right', [1080, 40, 200, 40], [700, 40, 200, 40], [0.01, 0.012])],
  // The board's second file (R4, states 12 to 16) draws the dock line's question in 72% text; its first file (1 to 3) in full text.
  // The app draws it as the first file does, so these states hold the line's pill and chips and leave the text between.
  // The board's R4 file also draws the dock's chevron in full text colour (the first file and the app: muted), so the chip region stops before it.
  // The line above the Map (D3) is held to the board's size and marks; its words differ from the board's only where data is missing (§3a: 12.6
  // has no drop time, 12.7 no line number, path chip or "Show the file", 12.9 no data folder: the app says it isn't sure the change was saved).
  // The dock's chip sits between the question's text (72% in R4's file, full in the app: left out) and the other-sessions chip.
  // 12.1 holds the card's title row only: the card's lines name the last message and what is on its way, which the frame's data does not have, and
  // its buttons say "Close session" and "Copy session ID" where the board says "Disconnect".
  '12.1': [...topBar(BAR), ...dockLineEnds(), ...box('connection card title', [316, 36, 324, 34], [316, 36, 324, 34], [0.01, 0.01])],
  // 12.2's steps: the head and the first step hold. The second step says where Codex's instruction comes from when no setup receipt is at hand
  // (the board's has a Copy instruction button), so it and the foot below it sit at another height.
  '12.2': [...topBar(BAR), ...box('connection line, head and first step', [0, 40, 1280, 82], [0, 40, 900, 82]), ...dockLineEnds(), ...dockChip([0.002, 0.002])],
  '12.3': [...topBar(BAR), ...box('connection line', [0, 40, 1280, 56], [0, 40, 900, 56]), ...dockLineEnds(), ...dockChip([0.002, 0.002])],
  '12.4': [...topBar(BAR), ...box('connection line', [0, 40, 1280, 56], [0, 40, 900, 56]), ...dockLine()],
  // 12.6 holds the line's icon and title and its button: the sentence between has no drop time (§3a).
  '12.6': [...topBar(BAR), ...box('connection line title', [0, 40, 260, 56], [0, 40, 260, 56]), ...box('connection line button', [1180, 40, 100, 56], [800, 40, 100, 56]),
    ...dockLineEnds(), ...dockChip([0.002, 0.002])],
  // 12.7 holds the line's icon and title and the dock's words. Left out: the top bar's chip of waiting questions in other sessions and the dock's chip of
  // them (not held here; the waiting list no longer gives up when one session can't be read), the line's sentence (no line number), its second
  // button, and the Map panel (no path chip, so its centred lines sit higher).
  '12.7': [...box('top bar left', [0, 0, 210, 40], [0, 0, 40, 40]), ...box('connection line title', [0, 40, 260, 56], [0, 40, 200, 32]),
    ...box('dock line text', [0, 760, 700, 40], [0, 610, 690, 40])],
  '12.8': [...topBar(BAR), ...box('connection line', [0, 40, 1280, 56], [0, 40, 900, 56], [0.001, 0.001]), ...dockLineEnds(), ...dockChip([0.002, 0.002])],
  // 12.9: the top bar's right-hand controls are disabled while the save is unsure (the board draws them live), and the line says less (§3a).
  '12.9': [...box('top bar left', [0, 0, 700, 40], [0, 0, 700, 40]), ...dockLineEnds()],
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
  '15.4': [...topBar(BAR), ...dockLineQuiet()],
  // The board's first run offers "Copy instruction" for Codex, but there is nothing to copy before a project is registered, so the
  // app says to register first and offers "Register a project". The taller card re-centres the page, so only the top bar compares
  // (dark measured 0.13%: the right-hand glyphs' anti-aliasing).
  '15.1': [...topBar([0.002, 0.002])]
};

/**
 * The regions of the Map states above (measured on the board's own frames: coverage/design/final/<id>-<size>-design.png).
 * The rule (agreed with the maintainer 2026-10-17): no region spans the Map's rows.
 * - D1: the board pads a row +7 / +4 per box that opens or closes at it; the app does not (ALPHA20-REPLAN D1), so below the first box the rows
 *   sit up to about 45px higher than the board's and a pixel compare of them could never pass. The rows' looks (tints, slices, thread,
 *   badges, hover bar) are looked at by eye instead: every Map state also writes the board and the app side by side to
 *   coverage/design/final/side-by-side/<id>-<size>.png (final.spec.mts).
 * - Compared instead: the topic band (W3), the first row where it comes before any box (no drift), and the overlays: What changed, Recent,
 *   Ack all, the filter row, the Back-to-selected pill, the "…" menu. Scrolled or selected states (3.6m, 4.1, 5.6, 8.4) leave the rows out
 *   altogether: the board scrolls by its own row heights. The Graph states have no rows, so their whole canvas is compared.
 * - D12: the board's "…" menu has "Continue here", which the app does not show, so the rows under it sit 43px lower in the board: 10.12
 *   compares the menu's first row only. D8 and D10 are in the band (one line where the board has two, "· N waiting" on strips): a band
 *   region that differs by the count text alone is reported as such.
 * Thresholds: 0.01; 0.02 for the overlays that are mostly text (a line a pixel off moves a few percent of a text box).
 */
const MAP: Limits = [0.01, 0.01], TEXT: Limits = [0.02, 0.02];
/** A region that applies to the wide sizes only (a narrow Map that Details squeezes lays its first row out differently). */
const wideOnly = (name: string, rect: Rect, limit: number): FrameRegion => ({ name, rect, variants: WIDE, threshold: limit });
/** ALPHA20-REPLAN §3a (D10 follow-on): a popover that hangs under the band sits lower where the app's band is taller than the board's. `rect` is the board's;
 * the app's region is `shift` lower, held against the board's pixels (`dy`). Ack all hangs off the band's buttons: 20px lower at 1280 (the board's band is one
 * line, the app's two), level at 900. What changed hangs off the band's bottom edge: 18px lower at 1280 (the band is 20px taller, the board sets the popover
 * 2px under it), 2px lower at 900 (62px against the board's 60). */
const BAND_SECOND_LINE = 20;
const underBand = (name: string, wide: Rect, narrow: Rect, limits: Limits, shift: readonly [wide: number, narrow: number] = [BAND_SECOND_LINE, 0]): FrameRegion[] => [
  { name, rect: [wide[0], wide[1] + shift[0], wide[2], wide[3]], variants: WIDE, threshold: limits[0], dy: -shift[0] },
  { name: `${name} (narrow)`, rect: [narrow[0], narrow[1] + shift[1], narrow[2], narrow[3]], variants: NARROW, threshold: limits[1], ...(shift[1] ? { dy: -shift[1] } : {}) }];
const underBandEdge = [18, 2] as const;
const graph = box('graph canvas', [0, 40, 1244, 720], [0, 40, 864, 570], MAP);
const mapRegionsById: Readonly<Record<string, readonly FrameRegion[]>> = {
  '1.3m': graph, '7.2': graph, '9.9': graph,
  '3.1m': [...box('topic band', [0, 40, 880, 62], [0, 40, 560, 113], MAP), wideOnly('first row', [0, 102, 880, 66], 0.01)],
  '3.6m': box('topic band', [0, 40, 1244, 42], [0, 40, 864, 62], MAP),
  '4.1': box('topic band', [0, 40, 880, 62], [0, 40, 560, 113], MAP),
  // ALPHA20-REPLAN §3a D10: the band is two fixed lines in the app and one when wide on the board, so the Ack all popover that hangs from it
  // sits 20px lower at 1280: the wide frame compares it 20px lower (`underBand`).
  '4.3': [...box('topic band', [0, 40, 1280, 42], [0, 40, 900, 62], MAP), ...underBand('Ack all popover', [929, 86, 341, 187], [549, 106, 341, 187], TEXT),
    ...box('first row', [0, 82, 925, 66], [0, 102, 545, 66], MAP)],
  // The held "Acked N results Undo" takes Ack all's place, so the board draws the counts on the title line at 900 as well (see `bandPieces`).
  '4.4': [{ name: 'topic band', rect: [0, 40, 1280, 42], variants: WIDE, threshold: MAP[0] },
    { name: 'topic band (narrow, counts on the title line)', rect: [0, 40, 900, 62], variants: NARROW, threshold: MAP[1] }, ...box('first row', [0, 82, 1280, 66], [0, 102, 900, 66], MAP)],
  '5.1': [...box('topic band', [0, 40, 1280, 62], [0, 40, 900, 62], MAP), ...box('first row', [0, 102, 1280, 66], [0, 102, 900, 66], MAP)],
  // The What changed popover covers the band's counts line and the first row's left part: the band is compared down to the popover's top edge.
  // The popover is compared at its head and its "Brief" line (the first 64px): below it the brief's items, the since-you-were-here rows and
  // the summary are the fixture's own data (the brief's length, the change records: ALPHA20-REPLAN §3a "data, not deviations").
  '5.2': [...box('topic band', [0, 40, 1280, 44], [0, 40, 900, 60], MAP), ...underBand('What changed popover (head and brief line)', [12, 84, 540, 64], [12, 100, 540, 64], TEXT, underBandEdge),
    ...box('first row (right of the popover)', [556, 102, 724, 66], [556, 102, 344, 66], MAP)],
  '5.3': [...box('topic band', [0, 40, 1280, 44], [0, 40, 900, 60], MAP), ...underBand('What changed popover (head and brief line)', [12, 84, 540, 64], [12, 100, 540, 64], TEXT, underBandEdge),
    ...box('first row (right of the popover)', [556, 102, 724, 66], [556, 102, 344, 66], MAP)],
  '5.4': [...box('topic band', [0, 40, 1280, 42], [0, 40, 900, 62], MAP), ...box('first row', [0, 82, 1280, 66], [0, 102, 900, 66], MAP)],
  '5.5': [...box('topic band', [0, 40, 1280, 42], [0, 40, 900, 60], MAP), ...underBand('What changed popover (title)', [12, 84, 130, 40], [12, 100, 130, 40], TEXT, underBandEdge),
    ...box('first row (right of the popover)', [556, 82, 724, 66], [556, 102, 344, 66], MAP)],
  '5.6': box('topic band', [0, 40, 880, 93], [0, 40, 560, 145], MAP),
  '5.7': [...box('topic band', [0, 40, 880, 93], [0, 40, 560, 145], MAP), wideOnly('first row', [0, 133, 880, 66], 0.01)],
  // The filter row is compared through its first two chips ("Waiting on me 2", "To ack 3"). From the third on the app's world differs: "Open 8" where the
  // board counts 5 (the three findings to ack count as open in the app), and the app's Blocked chip moves every chip after it (at 900 it wraps the row, so the narrow region stops above the second row, and the band under the wrapped row sits 34px lower than the board's: a data difference, so the narrow band is not compared).
  '8.2': [...box('filter row (first two chips)', [0, 40, 212, 40], [0, 40, 212, 34], TEXT), wideOnly('topic band', [0, 80, 1280, 42], MAP[0])],
  // 8.3 compares the popover's head and its Viewed group. "Changed lately" below it is the fixture's data (the world's own change records), so its rows differ.
  '8.3': [...box('topic band (left of the popover)', [0, 40, 800, 42], [0, 40, 562, 62], MAP), ...box('Recent popover (head and Viewed)', [802, 44, 340, 212], [566, 44, 300, 212], TEXT),
    ...box('first row (left of the popover)', [0, 82, 800, 66], [0, 102, 562, 66], MAP)],
  // The band only (ends above the first strip). The board draws no "N outside the focus" strips in 8.4; the app keeps them, with "· N waiting",
  // so no question outside the focus goes unseen: an approved deviation (ALPHA20-REPLAN §3a). It sits below this region, so none is masked here.
  '8.4': box('topic band', [0, 40, 880, 62], [0, 40, 560, 82], MAP),
  '8.5': [...box('topic band', [0, 40, 880, 62], [0, 40, 560, 114], MAP), // The pill's inside only: its rounded corners show the Map's rows behind it, which differ by D1 (row padding) and the scroll that follows.
    ...box('Back to selected pill', [336, 718, 208, 26], [176, 568, 208, 26], MAP),
    wideOnly('first row', [0, 102, 880, 66], 0.01)],
  '9.7': [], '9.8': [], '9.10': [], '9.11': [],
  '9.2': [...box('topic band', [0, 40, 1280, 62], [0, 40, 900, 62], MAP), ...box('first row', [0, 102, 1280, 66], [0, 102, 900, 66], MAP)],
  // The "…" menu, from its first row ("Reply to topic"); the band is compared left of the menu.
  '10.12': [...box('topic band', [0, 40, 1280, 38], [0, 40, 586, 62], MAP), ...box('menu: Reply to topic', [970, 78, 300, 58], [590, 78, 300, 58], TEXT),
    ...box('first row', [0, 82, 960, 66], [0, 102, 586, 66], MAP)]
};

/**
 * (b) A data difference, left out of the topic band regions: the band's counts line ("5 open · 16 closed" on the board, "8 open · 13 closed" in the
 * app: the app counts the three findings to ack as open where the board counts them closed, the world's ack modelling) and the Changes opener
 * on it, whose x moves with those counts. The band regions hold the title line only (its chevron, name, buttons); the counts line and the opener
 * go to the side-by-side PNGs. The title line is 30px from the band's top edge.
 */
const BAND_TITLE_HEIGHT = 30;
/**
 * (c) ALPHA20-REPLAN §3a D10 (two fixed lines): the title line is held to the board where the two draw it alike, and only there.
 * - A wide Map (1244 or 1280 px, the popover frames' 800): the board puts the counts on the title line, between the name and the buttons
 *   (x 440 to 870). The app keeps them on the second line. The region is the chevron and name (x 0 to 400), and the buttons (from x 870, or 1000 when no item is selected and Focus is not drawn).
 * - A narrow Map (560 px, 900 px window with Details open): the board wraps a long name over two lines where the app ends it in "…".
 *   The region is the chevron (36 px) and the buttons (from x 290).
 * - A Map of 900 px (900 px window, nothing selected) and 880 px (1280 px window with Details open): the title line is the same in both.
 */
const bandPieces = (region: FrameRegion): FrameRegion[] => {
  if (!region.name.startsWith('topic band')) return [region];
  const [x, y, width, height] = region.rect, line = Math.min(height, BAND_TITLE_HEIGHT);
  const piece = (label: string, left: number, span: number): FrameRegion => ({ ...region, name: `${region.name} (${label})`, rect: [x + left, y, span, line] });
  const onTitleLine = region.name.includes('counts on the title line');
  const wideMap = onTitleLine || (region.variants?.includes('light') && (width >= 1200 || region.name.includes('left of the popover')));
  // Where the buttons start: right of the counts' end (x 870 with Details folded). With no item selected the board draws no Focus and Ack all
  // sits beside Continue; the app holds Focus's 92px slot (alpha.20 final fix: the Map never moves on its own, so Ack all never slides into it).
  // Ack all (and, held, "Acked N Undo") is therefore 100px left of the board's, and the region starts at Continue (x 1100 in a 1280 Map, 830 in 900).
  const buttons = onTitleLine && width < 1000 ? 830 : width >= 1270 ? 1100 : 870;
  if (wideMap) return [piece('chevron and name', 0, 400), ...(width >= 1200 || onTitleLine ? [piece('buttons', buttons, width - buttons)] : [])];
  if (region.variants?.includes('narrow') && width <= 600) return [piece('chevron', 0, 36), piece('buttons', 290, width - 290)];
  // A 900px Map with no item selected: the board draws no Focus, so its Ack all (x 736 to 831) sits beside Continue; the app holds Focus's slot,
  // so its Ack all is 100px left. The name (x 0 to 600) and the buttons from Continue (x 830) are compared; Ack all goes to the side-by-side PNGs.
  if (region.variants?.includes('narrow') && width === 900) return [piece('chevron and name', 0, 600), piece('buttons', 830, 70)];
  return [{ ...region, rect: [x, y, width, line] }];
};

/**
 * (a) The first row is left out of every Map state: ALPHA20-REPLAN §3a D1 (the app drops the board's +7/+4 per-box row padding, so the row's text sits
 * 3 to 4px higher than the board's) and, at 1280, D10 (the band is two lines in the app, one on the board, so the row starts 20px lower). The rows'
 * looks go to the side-by-side PNGs.
 */
const withoutFirstRow = (region: FrameRegion): boolean => !region.name.startsWith('first row');

// alpha.21 W5: the notice stack (11.1, 11.4, 11.6) and two-step Continue (10.7, 10.8). Notices float over the Map below the topic band (ALPHA21-PLAN
// §3a.1, E20), where the board draws them in flow above it, so the Map under them differs by design: these frames stay `pending` and are read from
// the side-by-side PNGs (FINAL_APP=1), not asserted. 10.7's and 10.8's dialogs are compared where they sit (the card is centred).
const noticeStateList: readonly FinalState[] = [
  { id: '11.1', part: 'R4-Notices', sid: 'n-save', owner: 'shell', pending: true, title: 'A change that couldn’t be saved',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ notice: 'save' }] } },
  { id: '11.4', part: 'R4-Notices', sid: 'n-outside', owner: 'shell', pending: true, title: 'Showing an item outside my filter',
    app: { view: { selected: 'a4', details: 'open', dock: 'line' }, map: { filter: ['waiting_on_me'] } } },
  // The board lists the notices recovered, agentrm, save and shows the first two; the app shows the newest on top, so they are raised in the reverse order.
  { id: '11.6', part: 'R4-Notices', sid: 'n-many', owner: 'shell', pending: true, title: 'Several at once, with Details open',
    app: { view: { selected: 'a2.2.1', details: 'open', dock: 'line' }, map: {}, act: [{ notice: 'save' }, { notice: 'agentrm' }, { notice: 'recovered' }] } },
  { id: '10.7', part: 'R4-Dialogs', sid: 'd-continue', owner: 'shell', pending: true, title: 'Continue a topic: pick a session',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ click: 'Continue elsewhere' }] } },
  { id: '10.8', part: 'R4-Dialogs', sid: 'd-continue2', owner: 'shell', pending: true, title: 'Continue: review the summary',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ click: 'Continue elsewhere' }, { click: 'schema review' }] } }
];

// alpha.21 remove, archive and the bin (W7). The dialogs sit over the Map, whose rows never line up (D1), so each state compares its dialog,
// toast or strip only (`removeRegionsById`).
const removeRow: Step = { hover: '[role="treeitem"][data-item-id="a2.2.1"]' };
/** The board's bin: the agent removed "cache warm-up script", which cancelled one message of mine. */
const binned = [{ item: 'a11', words: 'Skip the script; the deploy job can warm the cache. Keep the twenty-minute budget in mind.' }] as const;
const openBin: readonly Step[] = [{ click: 'More actions for' }, { click: 'Open the bin' }];
const removeStateList: readonly FinalState[] = [
  { id: '10.1', part: 'R4-Dialogs', sid: 'd-confirm', owner: 'remove', pending: false, title: 'Confirm, for what can’t be undone: emptying the bin',
    app: { items: { binned }, view: { selected: null, dock: 'line' }, map: {}, act: [...openBin, { click: 'Empty the bin…' }] } },
  { id: '10.11', part: 'R4-Dialogs', sid: 'd-bin', owner: 'remove', pending: false, title: 'The bin, from the topic’s … menu',
    app: { items: { binned }, view: { selected: null, dock: 'line' }, map: {}, act: openBin } },
  // 11.3 stays pending: the notice is drawn where W5's notice placement (E20) puts it, which this piece does not have; it also keeps Restore.
  { id: '11.3', part: 'R4-Notices', sid: 'n-agentrm', owner: 'remove', pending: true, title: 'The agent removed items: a notice, and a strip marks the spot',
    app: { items: { binned }, view: { selected: null, dock: 'line' }, map: {} } },
  { id: '10.2', part: 'R4-Dialogs', sid: 'd-remove', owner: 'remove', pending: false, title: 'Remove an item and everything below it',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [removeRow, { click: 'Remove (⌫)' }] } },
  { id: '10.3', part: 'R4-Dialogs', sid: 'd-removed', owner: 'remove', pending: true, title: 'After Remove: Undo for 5 seconds, a strip keeps the spot',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [removeRow, { click: 'Remove (⌫)' }, { click: 'Remove 5 items' }] } },
  { id: '10.13', part: 'R4-Dialogs', sid: 'd-tarchive', owner: 'remove', pending: false, title: 'Archive a topic',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ click: 'More actions for' }, { click: 'Archive topic…' }] } },
  { id: '10.14', part: 'R4-Dialogs', sid: 'd-tremove', owner: 'remove', pending: false, title: 'Remove a topic',
    app: { view: { selected: null, dock: 'line' }, map: {}, act: [{ click: 'More actions for' }, { click: 'Remove topic…' }] } }
];
/**
 * A horizontal slice of a centred dialog `width` wide: from `top` (px below the dialog's top edge in the app) for `height` px. The app centres
 * its dialog by its own height, so where the app's dialog is shorter than the board's (a data difference) a slice is moved by `dy`.
 */
const dialogSlice = (name: string, width: number, app: readonly [wideTop: number, narrowTop: number], top: number, height: number,
  dy: readonly [wide: number, narrow: number] = [0, 0], limits: Limits = TEXT): FrameRegion[] => [
  { name, rect: [640 - width / 2, app[0] + top, width, height], variants: WIDE, threshold: limits[0], ...(dy[0] ? { dy: dy[0] } : {}) },
  { name: `${name} (narrow)`, rect: [450 - width / 2, app[1] + top, width, height], variants: NARROW, threshold: limits[1], ...(dy[1] ? { dy: dy[1] } : {}) }];
const removeRegionsById: Readonly<Record<string, readonly FrameRegion[]>> = {
  '10.13': dialogSlice('archive dialog', 520, [292, 217], 0, 215),
  '10.14': dialogSlice('remove topic dialog', 520, [286, 211], 0, 228),
  // (b) The app's world has no unsent message on "write the SOP", so its warning is one line (the board's two): the dialog is 14px shorter
  // and centred 7px lower. The head and the list with the buttons are compared, each where the board draws it.
  '10.2': [...dialogSlice('remove dialog head', 520, [215, 140], 0, 120, [-7, -7]), // The board's rows sit at fractional heights (12.5px at 80% text): a row a pixel apart is sub-pixel noise, measured 2.6%.
    ...dialogSlice('remove dialog list', 520, [215, 140], 168, 137, [7, 7], [0.03, 0.03]),
    ...dialogSlice('remove dialog buttons', 520, [215, 140], 308, 62, [7, 7])],
  // (b) and §3a.3: the bin holds the agent's removal only (no "removed by you" row), and the world's "cache warm-up script" has nothing below it
  // (the board's "3 items in all"), so the dialog is shorter. Its head and its buttons are compared.
  '10.11': [...dialogSlice('bin head', 560, [271, 196], 0, 90, [-34, -34]), ...dialogSlice('bin buttons', 560, [271, 196], 193, 63, [34, 34])],
  // (b) "The 2 removed items" on the board, "The removed item" in the app: the title, and the quote with the buttons, are compared.
  '10.1': [...dialogSlice('empty dialog title', 520, [283, 208], 0, 52), ...dialogSlice('empty dialog quote and buttons', 520, [283, 208], 100, 130)],
  // The strip alone (D1 puts the app's rows 7px higher here). 10.3 stays pending: the toast is W5's (no trash icon, a text Undo), and the
  // narrow strip's "· 5 items" wording is not built.
  '10.3': [{ name: 'removed strip', rect: [75, 353, 325, 24], variants: WIDE, threshold: TEXT[0], dy: 7 }]
};

export const finalStates: readonly FinalState[] = [...stateList.map(state => regionsById[state.id] ? { ...state, regions: regionsById[state.id]! } : state),
  ...mapStateList.map(state => ({ ...state, regions: mapRegionsById[state.id]!.filter(withoutFirstRow).flatMap(bandPieces) })),
  ...noticeStateList,
  ...removeStateList.map(state => removeRegionsById[state.id] ? { ...state, regions: removeRegionsById[state.id]! } : state)];

export const finalIds: readonly string[] = finalStates.map(state => state.id);

/** The state with this id; throws for an id that is not registered. */
export function finalState(id: string): FinalState {
  const state = finalStates.find(value => value.id === id);
  if (!state) throw new Error(`no final-board state ${id}`);
  return state;
}
