// The handoff frames this harness reproduces, with the props each frame passes
// to <dc-import name="Ariadne"> in Ariadne Mockups.dc.html. Kept free of app
// imports so the Playwright spec can read it in Node.

export type Scenario = 'default' | 'project' | 'archive' | 'sessions' | 'session' | 'projects' | 'projectpage' | 'review' | 'thread' | 'reveal' | 'sent' | 'failed'
  | 'reconnecting' | 'first' | 'continue' | 'notrunning';
export interface FrameSpec {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly theme: 'dark' | 'light';
  readonly scenario: Scenario;
  readonly state: 'ready' | 'empty' | 'loading' | 'clear';
  readonly selected?: string;
  readonly detail?: boolean;
  /** App-only saved detail width, exercised through the resize separator. */
  readonly detailWidth?: number;
  readonly answering?: string;
  readonly view?: 'graph';
  readonly openMode?: 'reply' | 'followup';
  /** A harness state of another board frame: the frame whose card is drawn, then put in this state. */
  readonly design?: string;
  /** The tree row the pointer rests on (Item Row.dc.html: hover band, row actions and the id). */
  readonly hoverItem?: string;
  /** Topic names the frame shows folded (the review scenario folds t1-t3). */
  readonly collapseTopics?: readonly string[];
  /** App-only answer frames exercise the dock independently of the immutable handoff. */
  readonly answerOptions?: number;
  /** M3 conversation fixture keeps the thread and exercises four pinned choices. */
  readonly conversationOptions?: number;
  readonly expandedAnswer?: number;
  readonly hiddenItems?: readonly string[];
  /** Compact dock states are app-only, independent of immutable handoff comparisons. */
  readonly dockState?: 'question' | 'open' | 'pending';
  /** Compare a stopped turn after delivery with a rejection before delivery. */
  readonly acceptedFailure?: boolean;
  /** App-only Paperwhite session frame with a controlled transient toast. */
  readonly toast?: boolean;
  /** Opens Waiting even when the window squeezes the centre column. */
  readonly peekWaiting?: boolean;
  /** App-only M2 changes states, independent of the original handoff baselines. */
  readonly changes?: 'typed' | 'choice' | 'away';
}

const wide = { width: 1600, height: 960 } as const, narrow = { width: 1280, height: 800 } as const;
const base = { ...wide, theme: 'dark', scenario: 'default', state: 'ready' } as const;
// TOPICS t1-t3 (Ariadne.dc.html:530-532), folded by the review scenarios (Ariadne.dc.html:940).
const reviewFolds = ["Reviewer's comments on the SDK cache PR (#226)", 'Cache entries the SDK can’t read', 'Agent instructions in the repo'] as const;
const specs: readonly FrameSpec[] = [
  { ...base, id: '1a' },
  { ...base, id: '1b', selected: '1.3.1.2', detail: true },
  { ...base, id: '1c', selected: '2.1.1', answering: '2.1.1' },
  { ...base, id: '1d', view: 'graph', selected: '1.3.1.2' },
  { ...base, id: '1e', theme: 'light', selected: '3.1', detail: true },
  { ...base, id: '1f', theme: 'light', view: 'graph', selected: '1.2.2.1' },
  { ...base, ...narrow, id: '1g', state: 'empty' },
  { ...base, ...narrow, id: '1h', state: 'loading' },
  { ...base, ...narrow, id: '1i', theme: 'light', state: 'clear' },
  { ...base, id: '1l', scenario: 'sent', selected: '2.1.1', detail: true },
  { ...base, id: '1m', scenario: 'failed', selected: '3.1', detail: true },
  { ...base, id: '1n', scenario: 'reveal', selected: '1.3.1.2', detail: true },
  { ...base, ...narrow, id: '1o', scenario: 'reconnecting', selected: '3.1', detail: true },
  { ...base, ...narrow, id: '1p', scenario: 'first' },
  { ...base, id: '1q', selected: '1.4', detail: true },
  { ...base, ...narrow, id: '1r', theme: 'light', selected: '1.4', detail: true, openMode: 'reply' },
  { ...base, id: '1t', scenario: 'review', selected: '4.4', detail: true, collapseTopics: reviewFolds },
  { ...base, id: '1u', scenario: 'thread', selected: '4.1', detail: true, collapseTopics: reviewFolds },
  { ...base, id: 'conversation-four-options', scenario: 'thread', selected: '4.1', detail: true, conversationOptions: 4, collapseTopics: reviewFolds },
  { ...base, ...narrow, id: '1v', selected: '1.3.1', detail: true, openMode: 'followup' },
  { ...base, id: '1w', scenario: 'project', selected: '5.3', detail: true },
  { ...base, id: '1x', scenario: 'archive' },
  { ...base, id: '1y', scenario: 'continue' },
  { ...base, id: '1z', scenario: 'sessions' },
  { ...base, id: '1aa', scenario: 'session' },
  { ...base, id: '1ab', scenario: 'projects' },
  { ...base, id: '1ac', scenario: 'projectpage' },
  { ...base, id: '1ad', scenario: 'notrunning', selected: '5.3', detail: true },
  // 1b with the pointer on a row: a plain row gets the hover band; the selected row keeps its own band.
  { ...base, id: '1b-hover', design: '1b', selected: '1.3.1.2', detail: true, hoverItem: '1.3.1' },
  { ...base, id: '1b-hover-selected', design: '1b', selected: '1.3.1.2', detail: true, hoverItem: '1.3.1.2' },
  { ...base, width: 1400, height: 830, id: 'answer-two-long', selected: '3.1', detail: true, answerOptions: 2 },
  { ...base, width: 1400, height: 830, id: 'answer-two-expanded', selected: '3.1', detail: true, answerOptions: 2, expandedAnswer: 0 },
  { ...base, width: 1400, height: 830, id: 'answer-nine', selected: '3.1', detail: true, answerOptions: 9 },
  { ...base, width: 1400, height: 830, id: 'answer-one', selected: '3.1', detail: true, answerOptions: 1 },
  { ...base, width: 1400, height: 830, id: 'answer-text', selected: '3.1', detail: true, answerOptions: 0 },
  { ...base, width: 1400, height: 500, id: 'answer-short', selected: '3.1', detail: true, answerOptions: 2 },
  { ...base, width: 1400, height: 830, id: 'detail-hidden', selected: '3.1', detail: true, answerOptions: 2, hiddenItems: ['3.1'] },
  { ...base, width: 1400, height: 830, id: 'detail-hidden-parent', selected: '2.1.1', detail: true, answerOptions: 2, hiddenItems: ['2.1'] },
  { ...base, width: 1400, height: 830, id: 'detail-hidden-with-parent', selected: '2.1.1', detail: true, answerOptions: 2, hiddenItems: ['2.1', '2.1.1'] },
  { ...base, width: 1400, height: 830, id: 'question-resting', selected: '3.1', detail: true, dockState: 'question' },
  { ...base, width: 1400, height: 830, id: 'nonquestion-resting', selected: '3.1', detail: true, dockState: 'open' },
  { ...base, width: 1280, height: 1240, id: 'nonquestion-pending', selected: '3.1', detail: true, dockState: 'pending' },
  { ...base, id: 'delivery-stopped', scenario: 'failed', selected: '3.1', detail: true, acceptedFailure: true },
  { ...base, ...narrow, id: 'session-toast-light', theme: 'light', toast: true },
  { ...base, ...narrow, id: 'session-toast-detail', selected: '3.1', detail: true, toast: true },
  { ...base, width: 1920, id: 'session-toast-detail-wide', selected: '3.1', detail: true, detailWidth: 800, toast: true },
  { ...base, width: 1080, height: 800, id: 'session-toast-narrow', selected: '3.1', detail: true, peekWaiting: true, toast: true },
  { ...base, width: 1280, height: 900, id: 'changes-typed', selected: '3.1', detail: true, changes: 'typed' },
  { ...base, width: 1280, height: 900, id: 'changes-choice', selected: '3.1', detail: true, changes: 'choice' },
  { ...base, width: 1000, height: 800, id: 'changes-away', changes: 'away' },
];

/** Harness states drawn from another board frame's card (FrameSpec.design). */
export const variantIds: readonly string[] = specs.filter(spec => spec.design).map(spec => spec.id);

export const answerFrameIds: readonly string[] = specs.filter(spec => spec.answerOptions !== undefined).map(spec => spec.id);

export const dockFrameIds: readonly string[] = specs.filter(spec => spec.dockState !== undefined).map(spec => spec.id);

export const toastFrameIds: readonly string[] = specs.filter(spec => spec.toast).map(spec => spec.id);

/** The fixed wall clock of the handoff page: 7 Oct 2026 15:10 UTC, after the last message of every frame (1i answers until 15:10). */
export const designNow = Date.UTC(2026, 9, 7, 15, 10);

/**
 * The app's clock for one frame: the prototype's own clock (Ariadne.dc.html:915),
 * 15:06, advanced by the messages its scenario adds (1i's answers until 15:10,
 * 1l's answer at 15:07); the review and thread scenarios start at 15:15 and 15:28.
 * "Waiting N min" is measured from it.
 */
export function frameNow(spec: FrameSpec): number {
  const minutes = spec.scenario === 'thread' ? 28 : spec.scenario === 'review' ? 15
    : spec.state === 'clear' ? 10 : spec.scenario === 'sent' ? 7 : 6;
  return Date.UTC(2026, 9, 7, 15, minutes);
}

/** Frame ids with a written fixture. */
export const frameIds: readonly string[] = specs.map(spec => spec.id);

/** The frame's props; throws "fixture not written" for any other handoff frame. */
export function frameSpec(id: string): FrameSpec {
  const spec = specs.find(value => value.id === id);
  if (!spec) throw new Error(`fixture not written: ${id}`);
  return spec;
}

/**
 * The scrolling body of the detail column is left out of the comparison on every frame that shows it:
 * the chat-style pane (reference on top, conversation after it, composer docked at the bottom) departs
 * on purpose from the handoff's stacked sections. The pane's header strip, the other columns and the
 * shell are still compared. The pane is guarded by tests/e2e/owner-input/layout.spec.mts and the UI
 * tests of tests/ui/inputs and tests/ui/history instead.
 */
export const detailMask = { reason: 'chat-style detail pane, owner request 2026-10-08; covered by tests/e2e/owner-input/layout.spec.mts + UI tests', selector: '.shell-detail-scroll' } as const;
export const detailMasked = (spec: FrameSpec): boolean => !!spec.detail;

/** Graph frames: the handoff's view="graph" or the session scenario (Ariadne.dc.html:961). */
export const graphFrame = (spec: FrameSpec): boolean => spec.view === 'graph' || spec.scenario === 'session';
