// The v2 handoff states the app-only layout checks (design.spec.mts) and the fixture builders (fixtures.ts) still use, with the
// props each passes to <dc-import name="Ariadne"> in Ariadne Mockups.dc.html. The v2 board's whole-screen frames are retired
// (the final board, final-frames.ts, holds the redesigned screens). Kept free of app imports so the Playwright spec can read it in Node.

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
  readonly view?: 'graph';
  /** Topic names the frame shows folded (the review scenario folds t1-t3). */
  readonly collapseTopics?: readonly string[];
  /** The agent's connection is reconnecting, so answering is blocked (any scenario; `scenario: 'reconnecting'` also does this). */
  readonly reconnecting?: boolean;
  /** Items hidden by the saved view only, with their text untouched. */
  readonly foldedItems?: readonly string[];
  /** Compact states of the Details composer are app-only, independent of immutable handoff comparisons. */
  readonly dockState?: 'open' | 'pending';
  /** Compare a stopped turn after delivery with a rejection before delivery. */
  readonly acceptedFailure?: boolean;
  /** App-only M2 changes states, independent of the original handoff baselines. */
  readonly changes?: 'typed' | 'choice' | 'away' | 'long';
  /** The frame's own wall clock in ms (the final-board frames); the handoff frames derive theirs from the scenario. */
  readonly now?: number;
  /** The project the 'projectpage' scenario shows (default: the handoff's current project, 'notes'). */
  readonly projectPage?: string;
  /** Answers already on their way (the final-board frames): the item, the option picked, and how far the send got. */
  readonly submissions?: readonly { readonly item: string; readonly choice: number; readonly stage: 'received' | 'failed' | 'stopped' | 'checking'; readonly message?: number }[];
}

const wide = { width: 1600, height: 960 } as const, narrow = { width: 1280, height: 800 } as const;
const base = { ...wide, theme: 'dark', scenario: 'default', state: 'ready' } as const;
// TOPICS t1-t3 (Ariadne.dc.html:530-532), folded by the review scenarios (Ariadne.dc.html:940).
const reviewFolds = ["Reviewer's comments on the SDK cache PR (#226)", 'Cache entries the SDK can’t read', 'Agent instructions in the repo'] as const;
const specs: readonly FrameSpec[] = [
  { ...base, id: '1a' },
  { ...base, id: '1m', scenario: 'failed', selected: '3.1', detail: true },
  { ...base, id: '1u', scenario: 'thread', selected: '4.1', detail: true, collapseTopics: reviewFolds },
  { ...base, id: '1ac', scenario: 'projectpage' },
  { ...base, width: 1400, height: 830, id: 'nonquestion-resting', selected: '3.1', detail: true, dockState: 'open' },
  { ...base, width: 1280, height: 1240, id: 'nonquestion-pending', selected: '3.1', detail: true, dockState: 'pending' },
  { ...base, id: 'delivery-stopped', scenario: 'failed', selected: '3.1', detail: true, acceptedFailure: true },
  { ...base, width: 1280, height: 900, id: 'changes-typed', selected: '3.1', detail: true, changes: 'typed' },
  { ...base, width: 1280, height: 900, id: 'changes-choice', selected: '3.1', detail: true, changes: 'choice' },
  { ...base, width: 1000, height: 800, id: 'changes-away', changes: 'away' },
  // Map layout frames: the brief with many decided names, and the plain Map with the selected thread passing the topic cards.
  { ...base, ...narrow, id: 'map-brief-long', selected: '3.1', changes: 'long' },
  { ...base, width: 900, height: 650, id: 'map-brief-long-small', selected: '3.1', changes: 'long' },
  { ...base, ...narrow, id: 'map-thread', selected: '1.3.1.2' },
  { ...base, width: 900, height: 650, id: 'map-thread-small', selected: '1.3.1.2' },
  // The Graph with hidden siblings folded into a stub (the Tree's "N items hidden" rule).
  { ...base, ...narrow, id: 'graph-hidden', view: 'graph', selected: '1.3.1.2', foldedItems: ['1.1', '1.4', '2.2'] },
  { ...base, width: 900, height: 650, id: 'graph-hidden-small', view: 'graph', selected: '1.3.1.2', foldedItems: ['1.1', '1.4', '2.2'] },
];

export const dockFrameIds: readonly string[] = specs.filter(spec => spec.dockState !== undefined).map(spec => spec.id);

/** The fixed wall clock of the handoff page: 7 Oct 2026 15:10 UTC, after the last message of every frame (1i answers until 15:10). */
export const designNow = Date.UTC(2026, 9, 7, 15, 10);

/**
 * The app's clock for one frame: the prototype's own clock (Ariadne.dc.html:915),
 * 15:06, advanced by the messages its scenario adds (1i's answers until 15:10,
 * 1l's answer at 15:07); the review and thread scenarios start at 15:15 and 15:28.
 * "Waiting N min" is measured from it.
 */
export function frameNow(spec: FrameSpec): number {
  if (spec.now !== undefined) return spec.now;
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

/** Graph frames: the handoff's view="graph" or the session scenario (Ariadne.dc.html:961). */
export const graphFrame = (spec: FrameSpec): boolean => spec.view === 'graph' || spec.scenario === 'session';
