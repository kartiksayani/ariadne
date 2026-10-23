// What Help says (SPEC 5.16, 3.2, 3.3): the approved key map, the 11 statuses, the five branch hues.

export interface KeyGroup { readonly label: string; readonly keys: ReadonlyArray<readonly [readonly string[], string]> }

export const KEY_GROUPS: readonly KeyGroup[] = [
  { label: 'Move around the Map', keys: [
    [['↑', '↓'], 'Move up and down; j and k work too'],
    [['←', '→'], 'Collapse or go to the parent; expand or go to the first child'],
    [['↵'], 'Open the item in Details; on a topic, fold or unfold it'],
    [['Space'], 'Peek at an item; the Map stays put'],
    [['.'], 'Back to the selected item'],
    [['n'], 'Outline the next unseen item; Next on the topic band does the same'],
    [['⌥', '↑', '↓'], 'Scroll Details'],
  ] },
  { label: 'Answer and reply', keys: [
    [['[', ']'], 'Open the answer dock at the previous or next waiting question'],
    [['1–9'], 'Pick an option'],
    [['↵'], 'Send the picked option'],
    [['⌘', '↵'], 'Send what you wrote'],
    [['r'], 'Reply about the selected item, in Details'],
    [['esc'], 'Close the box; your words stay as a draft'],
    [['⌥', '1–9'], 'Choose and send'],
  ] },
  { label: 'On the selected item', keys: [
    [['a'], 'Ack'],
    [['b'], 'Bring it up with the agent'],
    [['z'], 'Later, or back from Later'],
    [['d'], 'Drop'],
    [['o'], 'Back to Open'],
    [['x'], 'Hide'],
    [['⌫'], 'Remove; asks first when items below it would go too'],
    [['⇧', 'F'], 'Focus on it, or Unfocus'],
  ] },
  { label: 'Find and switch', keys: [
    [['/'], 'Search the Map'],
    [['f'], 'Filter by status'],
    [['g'], 'Tree or Graph'],
    [['c'], 'Continue the topic in another session'],
    [['⌘', 'E'], 'Recent'],
    [['⌘', 'O'], 'Switch session or project'],
    [['F6'], 'Move into notices; esc dismisses one'],
    [['?'], 'This help'],
  ] },
];

export interface StatusHelp { readonly label: string; readonly icon: string; readonly color: string; readonly text: string }

/** The eleven statuses, in the order Help lists them (two columns, row by row). */
export const STATUS_HELP: readonly StatusHelp[] = [
  { label: 'Open', icon: 'ph ph-circle', color: 'var(--st-open)', text: 'not started or not settled' },
  { label: 'Waiting on me', icon: 'ph-fill ph-question', color: 'var(--st-waiting)', text: 'the agent needs my answer' },
  { label: 'Sent', icon: 'ph ph-paper-plane-tilt', color: 'var(--st-agent)', text: 'my words are with the agent, not picked up yet' },
  { label: 'Queued', icon: 'ph ph-hourglass-medium', color: 'var(--st-open)', text: 'goes out once, when the agent runs' },
  { label: 'In progress', icon: 'ph ph-circle-half', color: 'var(--st-progress)', text: 'the agent is working on it' },
  { label: 'Blocked', icon: 'ph ph-lock-simple', color: 'var(--st-open)', text: 'waits on another item' },
  { label: 'Decided', icon: 'ph ph-check-circle', color: 'var(--st-decided)', text: 'settled; the outcome sits below it' },
  { label: 'Done', icon: 'ph-fill ph-check-circle', color: 'var(--st-done)', text: 'finished; explanations say Explained' },
  { label: 'Later', icon: 'ph ph-clock', color: 'var(--st-open)', text: 'parked by me' },
  { label: 'Dropped', icon: 'ph ph-x-circle', color: 'var(--st-dropped)', text: 'no longer pursued' },
  { label: 'Replaced', icon: 'ph ph-arrows-clockwise', color: 'var(--st-replaced)', text: 'another item took it over' },
];

/** The hue table lives with the Map (ui/tree/branch.ts); Help shows the same five. */
export { BRANCH_HUES } from '../tree/branch';
