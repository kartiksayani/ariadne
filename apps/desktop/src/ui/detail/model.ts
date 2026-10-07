// The item detail panel's view model (handoff README §5, Ariadne.dc.html
// lines 324-464 and 1953-2079), built from the session snapshot the store
// already holds. Strings are the prototype's; nothing here is invented copy.
import type { Immutable } from '../../data/session-store';
import type { Input, InputKind, Item, ItemOption, ItemStatus, Message, Round, Session } from '../../generated/domain/models';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentName, clock, dayWord } from '../shell/model';
import { shortLabel } from '../shared/short';

/** The prototype's status keys; they name the `--st-*` colour tokens. */
export type StatusKey = 'open' | 'waiting' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';
export const statusKey: Readonly<Record<ItemStatus, StatusKey>> = {
  open: 'open', waiting_on_me: 'waiting', in_progress: 'progress', decided: 'decided', done: 'done', dropped: 'dropped', replaced: 'replaced',
};
export const closedStatus: ReadonlySet<StatusKey> = new Set(['decided', 'done', 'dropped', 'replaced']);
const TYPE: Readonly<Record<Item['type'], string>> = { question: 'Question', decision: 'Decision', finding: 'Finding', task: 'Task', explanation: 'Explanation' };
const OUTLBL: Readonly<Partial<Record<StatusKey, string>>> = { decided: 'Decided', done: 'Done', dropped: 'Dropped', replaced: 'Replaced' };
const LINKICON: Readonly<Record<string, string>> = { pr: 'ph ph-git-pull-request', file: 'ph ph-file-code', doc: 'ph ph-file-text' };
const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;
const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 38)}…` : text}”`;

export type OpenMode = 'reply' | 'drop' | 'note' | 'followup';
/** Which box `r` opens for an item (Ariadne.dc.html:1401). */
export const replyMode = (status: StatusKey): OpenMode => status === 'open' ? 'reply' : status === 'progress' ? 'note' : 'followup';

export interface Crumb { readonly label: string; readonly itemId: string | null }
export interface Step { readonly label: string; readonly dotBg: string; readonly dotRing: string; readonly color: string; readonly weight: number; readonly line: boolean; readonly lineBg: string }
export interface DeliveryLine { readonly icon: string; readonly text: string; readonly color: string; readonly retry: boolean }
export type ActionKey = 'bring' | 'reply' | 'drop' | 'later' | 'note' | 'followup' | 'reopen';
export interface OpenAction {
  readonly action: ActionKey; readonly key: string; readonly label: string; readonly icon: string; readonly primary: boolean;
  readonly pressed: boolean; readonly disabled: boolean; readonly title: string;
}
export interface OpenSection { readonly title: string; readonly hint: string; readonly actions: readonly OpenAction[] }
export interface BoxText { readonly label: string; readonly placeholder: string; readonly button: string; readonly hint: string }
export interface Kid { readonly id: string; readonly question: string; readonly status: StatusKey; readonly closed: boolean }
export interface LinkView { readonly icon: string; readonly label: string; readonly meta: string }
export interface RoundView {
  readonly label: string; readonly range: string; readonly ask: string; readonly now: boolean;
  readonly you: { readonly chosen: boolean; readonly text: string } | null; readonly result: string;
  readonly forks: readonly Kid[];
}
export interface ExcerptMessage { readonly tag: string; readonly author: 'me' | 'agent'; readonly when: string; readonly excerpt: string }
export type Mark = 'created' | 'updated' | 'origin';
export interface TimelineEntry { readonly id: string; readonly message: ExcerptMessage; readonly mark: Mark; readonly label: string; readonly note: string; readonly last: boolean }
/** The props the shared Answer Control takes in full mode (README Components, Answer Control). */
export interface AnswerModel { readonly options: readonly Immutable<ItemOption>[]; readonly recommended: number; readonly blocked: string | null }

export interface DetailModel {
  readonly id: string;
  readonly question: string;
  readonly status: StatusKey;
  readonly badgeLabel: string;
  readonly meta: string;
  readonly path: readonly Crumb[];
  readonly stepsTitle: string;
  readonly steps: readonly Step[] | null;
  readonly delivery: DeliveryLine | null;
  readonly open: OpenSection | null;
  readonly answer: (AnswerModel & { readonly heading: boolean; readonly ask: string | null }) | null;
  readonly outcome: { readonly label: string; readonly text: string; readonly color: string } | null;
  readonly note: string | null;
  readonly why: string | null;
  readonly replaced: Kid | null;
  readonly kidLabel: string;
  readonly kids: readonly Kid[];
  readonly links: readonly LinkView[];
  readonly prev: { readonly status: StatusKey; readonly outcome: string } | null;
  readonly roundsCount: string;
  readonly rounds: readonly RoundView[];
  readonly timeline: readonly TimelineEntry[];
}

export interface DetailInput {
  readonly session: Immutable<Session>;
  readonly itemId: string;
  readonly now: number;
  /** The open box, if any (reply, drop, note or follow-up). */
  readonly mode: OpenMode | null;
  /** Later is a local flag on Open items. */
  readonly later: boolean;
  /** An owner input for this item is being saved right now. */
  readonly saving: InputKind | null;
}

const ACTIVE_INPUT = new Set<Input['state']>(['queued', 'in_flight', 'needs_attention']);
const TRACKED = new Set<InputKind>(['answer', 'bring', 'reply', 'drop', 'reopen']);
const SENDING: Readonly<Record<string, string>> = { bring: 'Asking the agent to bring this up…', reply: 'Sending your reply…', drop: 'Sending your drop request…',
  note: 'Sending your note…', followup: 'Sending your follow-up…', reopen: 'Asking the agent to reopen this…' };
const RECEIVED: Readonly<Record<string, string>> = { bring: 'Asked the agent to bring this up · received, waiting for the agent', reply: 'Your reply was received · waiting for the agent',
  drop: 'Drop request received · waiting for the agent', note: 'Note received · the agent is folding it in', followup: 'Follow-up received · waiting for the agent',
  reopen: 'Reopen request received · waiting for the agent' };
type Stage = 'queued' | 'sending' | 'received' | 'failed' | 'checking';

export const messageTag = (message: Immutable<Message>) => `#${message.number}`;
export function excerptMessage(message: Immutable<Message>, now: number): ExcerptMessage {
  const at = Date.parse(message.created_at), day = dayWord(at, now);
  return { tag: messageTag(message), author: message.author === 'owner' ? 'me' : 'agent', when: day ? `${day} ${clock(at)}` : clock(at), excerpt: message.body };
}

/** The submission whose delivery the stepper follows: one being saved, else the latest unresolved input. */
function submission(session: Immutable<Session>, item: Immutable<Item>, saving: InputKind | null) {
  if (saving) return { kind: saving, stage: 'sending' as Stage, label: '' };
  // Cancelled and skipped inputs never reached the agent; they leave no trace here.
  const inputs = Object.values(session.inputs).filter((input): input is Immutable<Input> => !!input && input.target.item_id === item.id
    && (ACTIVE_INPUT.has(input.state) || (input.state === 'handled' && TRACKED.has(input.kind)))).sort((a, b) => b.seq - a.seq);
  const latest = inputs.find(input => ACTIVE_INPUT.has(input.state)) ?? inputs[0];
  if (!latest) return null;
  const option = latest.payload.selected_option_id ? latest.payload.target_snapshot.options.find(value => value.id === latest.payload.selected_option_id) : null;
  const label = ({ bring: 'Bring it up', drop: 'Drop it', reopen: 'Back to Open' } as Partial<Record<InputKind, string>>)[latest.kind] ?? option?.label ?? latest.payload.text.trim();
  if (ACTIVE_INPUT.has(latest.state)) {
    const binding = session.bindings[latest.binding_id];
    const summary = binding ? { id: binding.id, adapter_id: binding.adapter_id, external_session_id: binding.external_session_id, generation: binding.generation,
      dispatch_state: binding.dispatch_state, owner_paused: binding.owner_paused, pause_reason: binding.pause_reason, connection_state: binding.connection_state, presence: null } : null;
    const kind = deliveryEvidence(latest, summary, session.operation_receipts).kind;
    const stage: Stage = kind === 'queued' ? 'queued' : kind === 'uncertain' || kind === 'unavailable' ? 'checking'
      : ['failed', 'rejected', 'missing'].includes(kind) ? 'failed' : ['received', 'published', 'waiting_result'].includes(kind) ? 'received' : 'sending';
    return { kind: latest.kind, stage, label };
  }
  return { kind: latest.kind, stage: null, label };
}

function stepsOf(stage: Stage | null, status: StatusKey): Step[] | null {
  const fail = stage === 'failed';
  const current = stage ? (stage === 'received' ? 1 : 0) : status === 'progress' ? 2 : 3;
  return ['Sending', 'Received', 'In progress', 'Resolved'].map((text, index) => ({
    label: index === 0 && fail ? 'Not delivered' : index === 0 && stage === 'checking' ? 'Checking…' : index === 0 && stage === 'queued' ? 'Queued' : text,
    dotBg: index < current || (index === current && index === 3) ? 'var(--color-accent)' : 'transparent',
    dotRing: index === current ? `inset 0 0 0 1.5px ${fail ? 'var(--a-warn)' : 'var(--color-accent)'}` : index < current ? 'none' : `inset 0 0 0 1.5px ${neutral(30)}`,
    color: index === current ? (fail ? 'var(--a-warn)' : 'var(--color-text)') : index < current ? neutral(76) : neutral(56),
    weight: index === current ? 500 : 400, line: index < 3, lineBg: index < current ? 'var(--color-accent)' : 'var(--color-divider)',
  }));
}

function deliveryOf(stage: Stage, kind: InputKind, label: string, agent: string): DeliveryLine {
  const muted = neutral(66), said = quote(label || '…');
  if (stage === 'queued') return { icon: 'ph ph-hourglass-medium', color: muted, text: `Queued for ${agent} · delivers when it’s running again`, retry: false };
  if (stage === 'sending') return { icon: 'ph ph-paper-plane-tilt', color: muted, text: kind === 'answer' ? `Sending ${said}…` : SENDING[kind] ?? 'Sending…', retry: false };
  if (stage === 'received') {
    return { icon: 'ph ph-check', color: 'var(--a-acc-text)', text: kind === 'answer' ? `You answered ${said} · received, waiting for the agent` : RECEIVED[kind] ?? '', retry: false };
  }
  if (stage === 'checking') return { icon: 'ph ph-circle-notch', color: muted, text: `Checking whether ${said} was delivered…`, retry: false };
  return { icon: 'ph ph-warning-circle', color: 'var(--a-warn)', text: `Couldn’t deliver ${said}. Your answer is kept.`, retry: true };
}

function roundView(session: Immutable<Session>, item: Immutable<Item>, round: Immutable<Round>, last: boolean): RoundView {
  const messages = (ids: readonly string[]) => ids.map(id => session.messages.find(message => message.id === id)).filter((message): message is Immutable<Message> => !!message);
  const owner = messages(round.owner_message_ids), agent = messages(round.agent_message_ids);
  const numbers = [...new Set([session.messages.find(message => message.id === round.opened_message_id)?.number, ...owner.map(value => value.number), ...agent.map(value => value.number)]
    .filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
  const answer = session.answers.filter(value => value.item_id === item.id && round.owner_message_ids.includes(value.message_id)).sort((a, b) => b.seq - a.seq)[0];
  const chosen = answer?.selected_option_id ? answer.options_snapshot.find(option => option.id === answer.selected_option_id)?.label ?? null : null;
  const you = chosen ? { chosen: true, text: chosen } : answer?.text.trim() ? { chosen: false, text: answer.text.trim() }
    : owner.length ? { chosen: false, text: owner.at(-1)!.body } : null;
  const results = round.result_input_ids.flatMap(id => session.inputs[id]?.attempts.flatMap(attempt => attempt.domain_result ? [attempt.domain_result] : []) ?? []);
  const result = results.at(-1)?.explanation ?? agent.at(-1)?.body ?? '';
  const now = last && !you && item.status === 'waiting_on_me';
  return { label: `Round ${round.ordinal}`, range: numbers.length > 1 ? `#${numbers[0]}–#${numbers.at(-1)}` : numbers.length ? `#${numbers[0]}` : '',
    ask: round.ask_snapshot ?? round.question_snapshot, now, you, result,
    forks: round.fork_item_ids.flatMap(id => { const fork = session.items[id]; return fork ? [kid(fork)] : []; }) };
}

const kid = (item: Immutable<Item>): Kid => ({ id: item.id, question: item.question, status: statusKey[item.status], closed: closedStatus.has(statusKey[item.status]) });

/** The breadcrumb above an item: its topic, then each ancestor, by short label. */
export function detailPath(session: Immutable<Session>, itemId: string): Crumb[] {
  const item = session.items[itemId];
  if (!item) return [];
  const topic = session.topics[item.topic_id], ancestors: Immutable<Item>[] = [];
  for (let parent = item.parent ? session.items[item.parent] : undefined; parent; parent = parent.parent ? session.items[parent.parent] : undefined) ancestors.unshift(parent);
  return [...(topic ? [{ label: shortLabel(topic), itemId: null }] : []), ...ancestors.map(value => ({ label: shortLabel(value), itemId: value.id }))];
}

/** The detail panel for one item, or null when the item is not in the snapshot. */
export function detailModel({ session, itemId, now, mode, later, saving }: DetailInput): DetailModel | null {
  const item = session.items[itemId];
  if (!item) return null;
  const items = Object.values(session.items).filter((value): value is Immutable<Item> => !!value);
  const topic = session.topics[item.topic_id];
  const status = statusKey[item.status], isClosed = closedStatus.has(status);
  const path = detailPath(session, itemId);
  const byId = new Map(session.messages.map(message => [message.id, message]));
  const created = byId.get(item.created_message_id);
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const readOnly = session.state !== 'active' || !topic || topic.archived_at !== null;
  const offline = binding?.connection_state === 'reconnecting';
  const sub = submission(session, item, saving);
  const pending = !!sub?.stage && sub.stage !== 'failed';
  const outLabel = status === 'done' && item.type === 'explanation' ? 'Explained' : OUTLBL[status];
  const ownerLabel = item.owner.kind === 'me' ? 'you' : item.owner.kind === 'agent' ? 'the agent' : item.owner.name;
  const showSteps = sub && (sub.stage !== null || (status !== 'waiting' && status !== 'open'));

  let open: OpenSection | null = null;
  if (!readOnly && !pending && status !== 'waiting') {
    const action = (value: ActionKey, key: string, label: string, icon: string, title: string, extra: Partial<OpenAction> = {}): OpenAction =>
      ({ action: value, key, label, icon, title, primary: false, pressed: mode === value, disabled: offline, ...extra });
    if (status === 'open') {
      open = { title: later ? 'Parked for later' : 'Not discussed yet',
        hint: mode === 'reply' ? 'The agent reads your reply and decides what happens next.'
          : mode === 'drop' ? 'Tells the agent to drop it. It stays in the tree, marked Dropped.'
          : later ? 'Out of your way, still in the tree. Bring it up or unpark it any time.'
          : 'Bring it up asks the agent to raise this now, with options for you. Later keeps it open but out of your way.',
        actions: [
          action('bring', 'b', 'Bring it up', 'ph ph-megaphone-simple', 'Ask the agent to raise this as a question for you', { primary: true, pressed: false }),
          action('reply', 'r', 'Reply', 'ph ph-chat-text', 'Reply in your own words'),
          action('drop', 'd', 'Drop', 'ph ph-x-circle', 'Tell the agent to drop it'),
          action('later', 'z', later ? 'Unpark' : 'Later', later ? 'ph ph-arrow-u-up-left' : 'ph ph-clock', later ? 'Bring it back into view' : 'Park it, still open', { pressed: false, disabled: false }),
        ] };
    } else if (status === 'progress') {
      open = { title: 'While the agent works', hint: 'Your note goes to the agent and joins the timeline. The item stays In progress.',
        actions: [action('note', 'r', 'Add a note', 'ph ph-chat-text', 'Add something while the agent works')] };
    } else if (isClosed) {
      open = { title: 'Revisit',
        hint: mode === 'followup' ? 'A comment joins the timeline. A new question becomes a branch under this item; this item stays closed.'
          : 'Follow up to comment or ask for more. Back to Open asks the agent to reopen it; the current outcome stays in its history.',
        actions: [
          action('followup', 'r', 'Follow up', 'ph ph-chat-text', 'Comment, or ask for more'),
          // The core reopens decided, done and dropped items; a replaced item stays replaced.
          action('reopen', 'o', 'Back to Open', 'ph ph-arrow-counter-clockwise', 'Ask the agent to reopen it', { pressed: false, disabled: offline || status === 'replaced' }),
        ] };
    }
    if (offline && open) open = { ...open, hint: `Reconnecting to ${agent}. These come back with the connection.` };
  }

  const answerable = status === 'waiting' && !pending;
  const recommended = item.options.findIndex(option => option.recommended);
  const blocked = session.state !== 'active' ? 'This session is closed. Reopen it to answer.'
    : offline ? `Reconnecting to ${agent}. Your choice is kept; sending resumes when the connection is back.` : null;

  const parent = item.parent ? session.items[item.parent] : undefined;
  const entries = new Map<number, { message: Immutable<Message>; roles: Mark[]; note: string }>();
  const add = (id: string | undefined, role: Mark, note = '') => {
    const message = id ? byId.get(id) : undefined;
    if (!message) return;
    const entry = entries.get(message.number) ?? { message, roles: [], note: '' };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    if (note) entry.note = note;
    entries.set(message.number, entry);
  };
  if (parent) add(parent.created_message_id, 'origin', `From: ${parent.question}`);
  add(item.created_message_id, 'created');
  item.updated_message_ids.forEach(id => add(id, 'updated'));
  // Owner messages join the timeline as replies (Ariadne.dc.html keeps them in `updated`).
  session.messages.forEach(message => { if (message.author === 'owner' && message.item_id === item.id) add(message.id, 'updated'); });
  const roleLabel = (role: Mark, me: boolean) => role === 'origin' ? 'Parent raised here' : role === 'created' ? (me ? 'You asked here' : 'Agent raised this') : (me ? 'You replied' : 'Agent updated');
  const ordered = [...entries.values()].sort((a, b) => a.message.number - b.message.number);
  const timeline = ordered.map((entry, index): TimelineEntry => ({
    id: entry.message.id, message: excerptMessage(entry.message, now), mark: entry.roles.includes('created') ? 'created' : entry.roles[0],
    label: entry.roles.map(role => roleLabel(role, entry.message.author === 'owner')).join(' · '),
    note: entry.note, last: index === ordered.length - 1 }));

  const rounds = Object.values(session.rounds).filter((round): round is Immutable<Round> => !!round && round.item_id === item.id).sort((a, b) => a.ordinal - b.ordinal);
  const roundViews = rounds.map((round, index) => roundView(session, item, round, index === rounds.length - 1));
  const reopened = isClosed ? undefined : [...item.status_history].reverse().find(entry => closedStatus.has(statusKey[entry.old_status]) && !closedStatus.has(statusKey[entry.new_status]));
  const replacement = item.replaced_by ? session.items[item.replaced_by] : undefined;
  const kids = items.filter(value => value.parent === item.id).sort((a, b) => a.ordinal - b.ordinal);

  return {
    id: item.id, question: item.question, status, badgeLabel: outLabel ?? '',
    meta: `${TYPE[item.type]} · next action: ${ownerLabel} · raised in ${created ? messageTag(created) : 'an earlier session'}`,
    path,
    stepsTitle: sub && sub.kind !== 'answer' ? 'Your request' : 'Your answer',
    steps: showSteps ? stepsOf(sub.stage, status) : null,
    delivery: sub?.stage ? deliveryOf(sub.stage, sub.kind, sub.label, agent) : null,
    open,
    answer: answerable ? { heading: !showSteps, ask: item.ask, options: item.options, recommended, blocked } : null,
    outcome: item.outcome ? { label: outLabel ?? 'Outcome', text: item.outcome, color: `var(--st-${status})` } : null,
    note: item.note && status === 'progress' ? item.note : null,
    why: item.why,
    replaced: replacement ? kid(replacement) : null,
    kidLabel: `Branched into ${kids.length} item${kids.length > 1 ? 's' : ''}`,
    kids: kids.map(kid),
    links: item.links.map(link => ({ icon: LINKICON[link.kind] ?? 'ph ph-link', label: link.label, meta: (link as typeof link & { meta?: string }).meta ?? '' })),
    prev: reopened ? { status: statusKey[reopened.old_status], outcome: reopened.previous_outcome ?? '' } : null,
    roundsCount: `${rounds.length} round${rounds.length > 1 ? 's' : ''}`,
    rounds: rounds.length > 1 || (rounds.length === 1 && !!roundViews[0].you) ? roundViews : [],
    timeline,
  };
}

/** The box texts per mode (Ariadne.dc.html:2012-2016). */
export const boxText: Readonly<Record<'reply' | 'note' | 'followup', BoxText>> = {
  reply: { label: 'Reply message', placeholder: 'Reply in your own words…', button: 'Send reply', hint: '⌘↵ sends · Esc cancels, keeps your draft' },
  note: { label: 'Note message', placeholder: 'Add a note, e.g. also cover the 429 case', button: 'Send note', hint: '⌘↵ sends · it stays In progress' },
  followup: { label: 'Follow-up message', placeholder: 'Follow up, e.g. Could we also add a test for this?', button: 'Send follow-up', hint: '⌘↵ sends · Esc cancels, keeps your draft' },
};

/** What the agent is sent for one-press actions (Ariadne.dc.html:1207). */
export function actionText(kind: 'drop' | 'reopen', question: string, reason = ''): string {
  if (kind === 'reopen') return `Let’s reopen this: ${question}`;
  return `Let’s drop this${reason.trim() ? ` (${reason.trim()})` : ''}: ${question}`;
}
