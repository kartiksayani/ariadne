// The mock world of the final design board, as plain data: the one topic, its items, the two waiting
// questions, the questions waiting in other sessions, the conversations and the projects. It is written out
// here (not read from the board) because the board is untrusted data that only ever runs inside the rendering
// page. Names follow the board's mock data (SPEC.md section 4). Kept free of app imports so Node and Vite read it alike.

export type WStatus = 'decided' | 'done' | 'in_progress' | 'open' | 'waiting_on_me' | 'replaced';
export interface WOption { readonly label: string; readonly consequence: string; readonly recommended?: boolean }
export interface WItem {
  readonly k: string; readonly short: string; readonly s: WStatus;
  /** The board's "Question · raised by the agent at 20:44": the item's kind, and when it was raised. */
  readonly kind?: 'question' | 'task' | 'finding' | 'explanation'; readonly raised?: string;
  readonly q: string; readonly o?: string; readonly why?: string; readonly ask?: string;
  /** A finding or explanation the owner has not acked yet ("To ack"). */
  readonly ack?: boolean;
  /** Not drawn in the Map: counted in "1 hidden". */
  readonly hidden?: boolean;
  /** Only in the board's "Because you chose" state (the warm-up items the agent adds after the answer). */
  readonly afterAnswer?: boolean;
  readonly options?: readonly WOption[];
  readonly kids?: readonly WItem[];
}
export interface WMessage { readonly who: 'agent' | 'me'; readonly time: string; readonly text: string }

export const topicName = "Reviewer's comments on the SDK cache PR (#226)";
export const topicShort = 'SDK cache PR';
/** The two questions waiting on me, oldest first (the dock's "1 of 2"). */
export const Q1 = 'a2.2.1.1.1';
export const Q2 = 'a5.1';
export const note1 = 'Put it at the end, under “Not covered”.';

const q1Options: readonly WOption[] = [
  { label: 'Yes, add a one-line note', consequence: 'On-call won’t go looking for workspace keys during an incident.', recommended: true },
  { label: 'Add a short section instead', consequence: 'Explains why workspace keys rebuild on every deploy; a few more lines to keep current.' },
  { label: 'No, leave them out', consequence: 'The SOP stays shorter and doesn’t mention workspace keys at all.' }];
const q2Options: readonly WOption[] = [
  { label: 'Bump the prefix in this release', consequence: 'No mixed window. Every team starts with a cold shared cache on its first deploy, so the first hour after each deploy costs about one extra service read per profile.', recommended: true },
  { label: 'Hold the bump one release', consequence: 'Nothing changes for this release. Both entry shapes live in the shared cache until the next one, and new SDKs fall back to the per-workspace cache when they meet an old entry.' },
  { label: 'Bump it and warm the cache first', consequence: 'No mixed window and no cold start, but the release checklist gains a warm-up step that someone has to run before each deploy, and it takes about twenty minutes.' }];
/** The long body of the second question (SPEC 5.2, state 2.3). */
export const q2Body = [
  'The cache change moves profile and plan reads to the shared cache. If the key prefix stays the same, SDKs on the old release and on the new one read and write the same keys while teams roll out, which takes about two days for most of them.',
  'Old SDKs write entries without the version field. New SDKs treat those entries as unreadable and fall back to the per-workspace cache: slower, but correct. Nothing breaks, but the shared cache does little until most teams are on the new release.',
  'Bumping the prefix now avoids that mixed window. The cost is a cold shared cache for every team on its first deploy, roughly one extra service read per profile until entries are warm again.',
  'Holding the bump means one more release on the old prefix, with both entry shapes in the cache for a while. I can also warm the shared cache before the release so the bump costs nothing, but that adds a step to the release checklist.'];

/** The topic's items, as the board draws them (its TOPIC.items). */
export const items: readonly WItem[] = [
  { k: 'a1', short: 'shared cache default', s: 'decided', q: 'Should the SDK use the shared cache by default when no experiment is set?', o: 'Yes. Teams roll out with an experiment, then remove it and stay on the shared cache.' },
  { k: 'a2', short: 'stale plans', s: 'decided', q: 'Can cached plans go stale forever, since reads keep extending their life?', o: 'The service guarantees every change republishes the profile; no expiry cap.', kids: [
    { k: 'a2.1', short: 'maximum age check', s: 'done', ack: true, kind: 'explanation', raised: '20:36', q: 'What would a “maximum age” check involve?', o: 'It would need changes in the service too, and would cap cache life at that age.' },
    { k: 'h1', short: 'self-hosted warm-up', s: 'decided', hidden: true, kind: 'question', raised: '20:33', q: 'Should self-hosted installs warm the per-workspace cache on start?', o: 'No. Self-hosted installs start cold and warm up within minutes.' },
    { k: 'a2.2', short: 'stale-entry runbook', s: 'done', q: 'Do we need a runbook for fixing stale entries?', o: 'A task to write the SOP was created.', kids: [
      { k: 'a2.2.1', short: 'write the SOP', s: 'in_progress', kind: 'task', raised: '20:14', q: 'Write the SOP for finding and fixing stale profile-cache entries.', kids: [
        { k: 'a2.2.1.1', short: 'which cache keys', s: 'decided', kind: 'question', raised: '20:44', q: 'Which cache keys does the SOP cover?', o: 'Profile and plan keys. Workspace keys are rebuilt on every deploy.', why: 'Workspace keys never stay stale long enough to need fixing.', kids: [
          { k: Q1, short: 'note on workspace keys', s: 'waiting_on_me', kind: 'question', raised: '20:51', q: 'Should workspace keys still get a one-line note, so on-call knows to ignore them?', options: q1Options },
          { k: 'a2.2.1.1.2', short: 'commands for one key', s: 'open', q: 'List the commands for reading a single key from the shared cache.' }
        ] },
        { k: 'a2.2.1.2', short: 'where the SOP lives', s: 'open', q: 'Where should the SOP live: the on-call wiki or the repo’s docs folder?' }
      ] },
      { k: 'a2.2.2', short: 'SOP review', s: 'open', q: 'Review the SOP draft before it goes on the on-call wiki.' }
    ] }
  ] },
  { k: 'a3', short: 'test fixtures', s: 'decided', q: 'Are the byte-for-byte test fixtures worth keeping?', o: 'No. Removed them, along with the test-only encoder.', kids: [
    { k: 'a3.1', short: 'encoder removal', s: 'decided', q: 'Should the test-only encoder go with the fixtures?', o: 'Yes. Nothing else uses it.' },
    { k: 'a3.2', short: 'golden files', s: 'decided', q: 'Keep the golden files for the docs examples?', o: 'No. The examples run as tests now.' },
    { k: 'a3.3', short: 'fixture helpers', s: 'done', q: 'Remove the fixture helpers from the test utilities.', o: 'Removed.' },
    { k: 'a3.4', short: 'snapshot config', s: 'done', q: 'Drop the snapshot settings from the test config.', o: 'Dropped.' }
  ] },
  { k: 'a4', short: 'fallback logging', s: 'open', kind: 'question', raised: '21:10', q: 'Should the SDK log a warning when it falls back to the per-workspace cache?' },
  { k: 'a5', short: 'version in the cache key', s: 'decided', q: 'Should the cache key include the SDK version?', o: 'Yes, as a prefix, so a rollback never reads entries written by a newer SDK.', kids: [
    { k: Q2, short: 'prefix bump timing', s: 'waiting_on_me', kind: 'question', raised: '21:19', q: 'Bump the key prefix in the same release as the cache change?', ask: 'Approve PR #761.', options: q2Options, kids: [
      { k: 'a5.1.1', short: 'warm-up step in the deploy job', s: 'open', afterAnswer: true, kind: 'task', raised: '21:27', q: 'Add a step to the deploy job that warms the shared cache before traffic moves.' },
      { k: 'a5.1.2', short: 'warm-up timing', s: 'open', afterAnswer: true, kind: 'question', raised: '21:27', q: 'Is twenty minutes of warm-up acceptable inside the deploy window?' }
    ] },
    { k: 'a5.2', short: 'entries without a version', s: 'done', ack: true, kind: 'finding', raised: '21:21', q: 'Entries written before the change have no version field.', o: 'New SDKs treat them as unreadable and fall back to the per-workspace cache until they expire.' }
  ] },
  { k: 'a6', short: 'shared cache docs', s: 'in_progress', kind: 'task', raised: '20:22', q: 'Add a section on the shared cache to the SDK docs.' },
  { k: 'a7', short: 'self-hosted cache', s: 'decided', q: 'Is the per-workspace cache still needed for self-hosted installs?', o: 'Yes. Self-hosted installs have no shared cache service.' },
  { k: 'a8', short: 'separate hit metrics', s: 'open', q: 'Should metrics count shared and per-workspace cache hits separately?' },
  { k: 'a9', short: 'shared-cache retries', s: 'done', ack: true, kind: 'finding', raised: '21:16', q: 'The SDK retries a failed shared-cache read three times before it falls back.', o: 'On a cold miss that adds up to about 300 ms. Worth a line in the docs.' },
  { k: 'a11', short: 'cache warm-up script', s: 'replaced', kind: 'task', raised: '20:26', q: 'Write a script that warms the shared cache before each release.', o: 'Replaced by “prefix bump timing”, where warming the cache is one of the options.' }
];

/** The board's long-text state (SPEC 1.4): "separate hit metrics" gets a four-line question, "self-hosted cache" a long outcome. */
export const longText = {
  a8: { q: 'Should metrics count shared and per-workspace cache hits separately, and if they do, should the dashboard show them as two lines on the existing hit-rate chart, or as a new chart with its own alert threshold, so that a drop in shared-cache hits pages on-call before teams notice slower profile loads?' },
  a7: { o: 'Yes. Self-hosted installs have no shared cache service, so they keep the per-workspace cache. The SDK picks it whenever no shared cache endpoint is configured, which is the default for self-hosted. Teams that run their own shared cache can point the SDK at it with the same setting the hosted service uses, and the docs section on the shared cache explains both cases and links to the self-hosted install guide.' }
} as const;

/** Conversations, by item key (the board's CONV, without the "Parent raised here" lines, which belong to the parent). */
export const conversations: Readonly<Record<string, readonly WMessage[]>> = {
  'a2.2.1.1': [
    { who: 'agent', time: '20:44', text: 'Which cache keys does the SOP cover? I’d include profile, plan and workspace keys.' },
    { who: 'me', time: '20:49', text: 'Profile and plan only. Workspace keys are rebuilt on every deploy, so they never stay stale.' },
    { who: 'agent', time: '20:51', text: 'Decided: profile and plan keys. I’ve asked separately whether workspace keys need a note.' }],
  [Q1]: [
    { who: 'agent', time: '20:51', text: 'Should workspace keys still get a one-line note, so on-call knows to ignore them? Without it, someone may go looking for them during an incident.' }],
  'a2.2.1': [
    { who: 'agent', time: '20:14', text: 'Writing the SOP for finding and fixing stale profile-cache entries. I’ll start from the incident notes in the March postmortem and the service’s republish endpoint.' },
    { who: 'me', time: '20:20', text: 'Keep it to what on-call can do without the service team: find the entry, check its age, republish or delete.' },
    { who: 'agent', time: '20:31', text: 'Draft outline: spot a stale entry from the dashboard; read the entry and its write time; republish the profile; if republishing fails, delete the entry so the SDK falls back; confirm the next read is fresh.' },
    { who: 'me', time: '20:38', text: 'Good. The delete step needs a warning: deleting during a deploy can cause a burst of fallbacks.' },
    { who: 'agent', time: '20:41', text: 'Added the warning to the delete step, with a link to the deploy calendar. I’ve also split “which keys” into its own question.' },
    { who: 'agent', time: '21:04', text: 'The keys question is decided: profile and plan keys only. I’ve asked whether workspace keys still need a note.' },
    { who: 'agent', time: '21:12', text: 'Drafted the commands for reading a single key from the shared cache. They need a read-only token; the SOP says where on-call gets one.' },
    { who: 'agent', time: '21:20', text: 'The SOP draft is ready for review, apart from the note on workspace keys, which waits on your answer.' }],
  a6: [
    { who: 'agent', time: '20:22', text: 'Adding a section on the shared cache to the SDK docs: what it is, when the SDK uses it, and how to turn it off.' },
    { who: 'agent', time: '21:08', text: 'The first draft is in the docs folder. It covers the default and the experiment flag. It doesn’t mention the per-workspace fallback yet.' }],
  a9: [{ who: 'agent', time: '21:16', text: 'The SDK retries a failed shared-cache read three times before it falls back. On a cold miss that adds up to about 300 ms. Worth a line in the docs.' }],
  'a5.2': [{ who: 'agent', time: '21:21', text: 'Entries written before the change have no version field. New SDKs treat them as unreadable and fall back to the per-workspace cache until they expire.' }],
  'a2.1': [{ who: 'agent', time: '20:36', text: 'A maximum age check would need changes in the service too: it would have to stamp each entry with its write time. It would also cap cache life at that age, even for entries that are still correct.' }],
  [Q2]: [{ who: 'agent', time: '21:19', text: 'Bump the key prefix in the same release as the cache change? Bumping now avoids a mixed window; holding it keeps both entry shapes in the cache for a release. I can also warm the cache first.' }]
};

/** The board's clock: "Waiting 34 min" on the first question is 21:25 minus its 20:51. */
export const clock = '21:25';

export interface WProject { readonly id: string; readonly name: string; readonly path: string; readonly last: string }
export interface WSession {
  readonly id: string; readonly project: string; readonly name: string; readonly agent: 'claude-code' | 'codex'; readonly where: string;
  readonly range: string; readonly running: boolean; readonly status: 'active' | 'closed'; readonly status_line: string;
}
/** The first project is the current one ("notes-sdk"); ids match fixtures.ts' project scenario ('notes' is the current project). */
export const projects: readonly WProject[] = [
  { id: 'notes', name: 'notes-sdk', path: '~/code/notes-sdk', last: '21:25' },
  { id: 'api', name: 'notes-api', path: '~/code/notes-api', last: '21:22' },
  { id: 'web', name: 'notes-web', path: '~/code/notes-web', last: '21:10' },
  { id: 'site', name: 'notes-site', path: '~/code/notes-site', last: '12 Sep' }
];
/** The board's sessions (R4 SESS). `s2` is the current one, as in the project scenario of fixtures.ts. */
export const sessions: readonly WSession[] = [
  { id: 's2', project: 'notes', name: 'cache PR review', agent: 'claude-code', where: 'iTerm window 1', range: 'Today 20:10 – now', running: true, status: 'active', status_line: 'Live · iTerm window 1' },
  { id: 's1', project: 'api', name: 'schema review', agent: 'claude-code', where: 'iTerm window 2', range: 'Today 20:30 – now', running: true, status: 'active', status_line: 'Live · iTerm window 2' },
  { id: 's3', project: 'web', name: 'flaky tests', agent: 'claude-code', where: 'Terminal tab 3', range: 'Today 18:00 – now', running: true, status: 'active', status_line: 'Live · Terminal tab 3' },
  { id: 'c1', project: 'notes', name: 'retry backoff', agent: 'codex', where: 'Codex app', range: 'Today 19:00 – now', running: true, status: 'active', status_line: 'Live · Codex app' },
  { id: 's5', project: 'notes', name: 'docs pass', agent: 'claude-code', where: 'iTerm window 3', range: 'Yesterday 17:40 – 18:05', running: false, status: 'closed', status_line: 'Closed yesterday 18:05' },
  { id: 's6', project: 'api', name: 'rate limits', agent: 'codex', where: 'Codex app', range: 'Today 14:00 – 20:00', running: false, status: 'active', status_line: 'Not running · 1 queued' }
];

/** The Archive (SPEC 14.3): archived sessions, with the counts their rows show, and one archived topic of `s2`. */
export interface WArchivedSession {
  readonly id: string; readonly project: string; readonly name: string; readonly agent: 'claude-code' | 'codex';
  readonly topics: number; readonly items: number; readonly archived: string;
}
export const archivedSessions: readonly WArchivedSession[] = [
  { id: 'x1', project: 'api', name: 'March incident notes', agent: 'claude-code', topics: 4, items: 31, archived: '2026-10-03T16:00:00.000Z' },
  { id: 'x2', project: 'web', name: 'editor spike', agent: 'codex', topics: 2, items: 9, archived: '2026-09-28T16:00:00.000Z' },
  { id: 'x3', project: 'site', name: 'landing copy', agent: 'claude-code', topics: 1, items: 6, archived: '2026-09-12T16:00:00.000Z' }
];
export const archivedTopic = { session: 's2', name: 'Old cache metrics', short: 'old metrics', items: 6, archived: '19:40' } as const;

/** Questions waiting in other sessions (the board's OQ and OGROUPS): the switcher's "3 in other sessions". */
export interface WOther { readonly k: string; readonly session: string; readonly q: string; readonly short: string; readonly raised: string; readonly options: readonly WOption[] }
export const others: readonly WOther[] = [
  { k: 'schema-1', session: 's1', short: 'legacy ID column', raised: '21:13', q: 'Drop the unused legacy ID column in this migration?', options: [
    { label: 'Drop it in this migration', consequence: 'Nothing has read it since March; the migration removes it.', recommended: true },
    { label: 'Keep it one more release', consequence: 'It stays nullable and goes in the next migration.' }] },
  { k: 'schema-2', session: 's1', short: 'backfill hours', raised: '21:22', q: 'Run the backfill during business hours?', options: [
    { label: 'Run it tonight at 02:00', consequence: 'Lowest traffic; results are ready in the morning.', recommended: true },
    { label: 'Run it now', consequence: 'Done in about an hour, with extra load at peak.' }] },
  { k: 'flaky-1', session: 's3', short: 'editor tests', raised: '20:45', q: 'Quarantine the two flaky editor tests for a week?', options: [
    { label: 'Quarantine them for a week', consequence: 'They still run but don’t block merges; a task tracks the fix.', recommended: true },
    { label: 'Fix them first', consequence: 'Merges in notes-web wait until both pass.' }] }
];
