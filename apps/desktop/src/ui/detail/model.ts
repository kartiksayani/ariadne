// The item detail panel's view model (handoff README §5, Ariadne.dc.html
// lines 324-464 and 1953-2079), built from the session snapshot the store
// already holds. Strings are the prototype's; nothing here is invented copy.
import type { Immutable } from '../../data/session-store';
import type { SupervisorHealth } from '../../data/service';
import type { Input, InputKind, Item, ItemOption, Message, PresenceObservation, Round, Session } from '../../generated/domain/models';
import { connectionOf, reconnectingNote } from '../shared/connection';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentName } from '../shell/model';
import { shortLabel } from '../shared/short';
import { excerptView, messageNumber, type ExcerptView, type Mark } from '../shared/excerpt';
import { statusKey, type StatusKey } from '../shared/status';
import { deliveryLine as deliveryText, deliveryStage, deliverySteps, type DeliveryStage } from '../answer/delivery';
import { displayStatus } from '../../selectors/waiting/replied';
import { counted, heldInput, notSent, stuckInput, withdrawn, type NotSent, type Stuck } from '../../selectors/waiting/stuck';

export { statusKey, type StatusKey };
export const closedStatus: ReadonlySet<StatusKey> = new Set(['decided', 'done', 'dropped', 'replaced']);
const TYPE: Readonly<Record<Item['type'], string>> = { question: 'Question', decision: 'Decision', finding: 'Finding', task: 'Task', explanation: 'Explanation' };
const OUTLBL: Readonly<Partial<Record<StatusKey, string>>> = { decided: 'Decided', done: 'Done', dropped: 'Dropped', replaced: 'Replaced' };
const LINKICON: Readonly<Record<string, string>> = { pr: 'ph ph-git-pull-request', file: 'ph ph-file-code', doc: 'ph ph-file-text' };
const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;

export type OpenMode = 'reply' | 'drop' | 'note' | 'followup';
/** The owner's own words (outside an answer) go out as one of these. */
export type WordsKind = 'reply' | 'note' | 'followup';
/**
 * What the owner's words go out as for an item in this status: a reply on an open or waiting item, a note on one in
 * progress, a follow-up on a finished one. Core accepts all three at any status; this is the one that fits. Words written in
 * another box (the status changed since) are sent as this, and the box says so before they go.
 */
export function sentAs(status: StatusKey): WordsKind {
  return status === 'open' || status === 'waiting' ? 'reply' : status === 'progress' ? 'note' : 'followup';
}

export interface Crumb { readonly label: string; readonly itemId: string | null }
export interface Step { readonly label: string; readonly dotBg: string; readonly dotRing: string; readonly color: string; readonly weight: number; readonly line: boolean; readonly lineBg: string }
export interface DeliveryLine { readonly icon: string; readonly text: string; readonly color: string }
export type ActionKey = 'bring' | 'reply' | 'drop' | 'later' | 'note' | 'followup' | 'reopen';
export interface OpenAction {
  readonly action: ActionKey; readonly key: string; readonly label: string; readonly icon: string; readonly primary: boolean;
  readonly pressed: boolean; readonly disabled: boolean; readonly title: string;
}
export interface OpenSection { readonly title: string; readonly hint: string; readonly actions: readonly OpenAction[] }
export interface BoxText { readonly label: string; readonly placeholder: string; readonly button: string; readonly hint: string }
export interface Kid { readonly id: string; readonly question: string; readonly status: StatusKey; readonly closed: boolean }
export interface LinkView { readonly icon: string; readonly label: string; readonly meta: string; /** Where the link points: a web address or a file path. */ readonly target: string }
/** One exchange of the conversation: the agent's ask, the owner's reply, what the agent did with it, and the items it forked. */
export interface RoundView {
  /** The round's number: a test hook only, never shown. */
  readonly ordinal: number;
  /** Empty when it only repeats the item's question (the head shows it). */
  readonly ask: string; readonly now: boolean;
  readonly you: { readonly chosen: boolean; readonly text: string } | null; readonly result: string;
  readonly forks: readonly Kid[];
}
/** A message of the owner's that has not settled: it ends the conversation as a pending bubble. */
export interface PendingView {
  readonly input: Immutable<Input>;
  /** What was sent: the chosen option (`chose`), the owner's words (`said`) or a one-press request (`action`). */
  readonly how: 'chose' | 'said' | 'action';
  readonly text: string;
  /** Where it stands, in a few words. */
  readonly caption: string;
  /** Why it hasn't reached the agent, with what fixes it (ui/answer/StuckNote); null while saving. */
  readonly stuck: Stuck | null;
}
export interface TimelineEntry {
  readonly id: string; readonly message: ExcerptView; readonly mark: Mark; readonly label: string; readonly note: string; readonly last: boolean;
  /** Set on an owner message that archive or close cancelled before it went out: it stays, with why it wasn't sent. */
  readonly unsent: NotSent | null;
}
/** The props the shared Answer Control takes in full mode (README Components, Answer Control). */
export interface AnswerModel { readonly options: readonly Immutable<ItemOption>[]; readonly recommended: number; readonly blocked: string | null }

export interface DetailModel {
  readonly id: string;
  readonly question: string;
  readonly status: StatusKey;
  /** The header badge: the status, or Waiting on agent once the owner replied. */
  readonly display: StatusKey;
  readonly badgeLabel: string;
  readonly meta: string;
  readonly path: readonly Crumb[];
  readonly stepsTitle: string;
  readonly steps: readonly Step[] | null;
  readonly delivery: DeliveryLine | null;
  /** The owner's messages still on their way, oldest first: the pending bubbles at the end of the conversation. */
  readonly outbox: readonly PendingView[];
  readonly open: OpenSection | null;
  /**
   * What the owner's words go out as now (`sentAs`): a reply on an open or waiting item, a note on one in progress, a follow-up
   * on a finished one. Null when the session or topic is read-only. Words written in another box stay in their draft and go out as this.
   */
  readonly box: WordsKind | null;
  /** A waiting item whose input is in flight or queued: a reply queues behind it (owner FIFO). Named for what is sent: a reply. */
  readonly followUp: { readonly label: string; readonly hint: string; readonly disabled: boolean } | null;
  readonly answer: (AnswerModel & { readonly heading: boolean; readonly ask: string | null }) | null;
  readonly outcome: { readonly label: string; readonly text: string; readonly color: string } | null;
  readonly note: string | null;
  readonly why: string | null;
  readonly replaced: Kid | null;
  readonly kidLabel: string;
  readonly kids: readonly Kid[];
  readonly links: readonly LinkView[];
  readonly prev: { readonly status: StatusKey; readonly outcome: string } | null;
  /** The conversation, oldest first. */
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
  /** The host presence of the session's binding, when observed. */
  readonly presence?: Immutable<PresenceObservation> | null;
  /** The desktop supervisor's health for the session's binding, when known. */
  readonly health?: SupervisorHealth | null;
  /** The agent name an earlier session's messages carry (shared/excerpt earlierAgent). */
  readonly earlierAgent?: string | null;
  /** The follow-up box is open or holds a draft: it stays when its hold clears. */
  readonly replyDraft?: boolean;
}

const ACTIVE_INPUT = new Set<Input['state']>(['queued', 'in_flight', 'needs_attention']);
const TRACKED = new Set<InputKind>(['answer', 'bring', 'reply', 'drop', 'reopen']);
/**
 * Newest first, but a stopped delivery needing a decision before everything: later messages cannot go out until it
 * is settled, so its Retry / Mark as done must stay in view (as on the tree row).
 */
const byDecisionThenNewest = (a: Immutable<Input>, b: Immutable<Input>) =>
  Number(b.state === 'needs_attention') - Number(a.state === 'needs_attention') || b.seq - a.seq;

/**
 * The submission whose delivery the stepper follows: one being saved, else the latest unresolved input. Newest, not
 * a stopped one ahead of it: an answer queued behind a stopped delivery still keeps the answer box closed.
 */
function submission(session: Immutable<Session>, item: Immutable<Item>, saving: InputKind | null) {
  if (saving) return { kind: saving, stage: 'sending' as DeliveryStage, label: '' };
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
    const stage = deliveryStage(deliveryEvidence(latest, summary, session.operation_receipts).kind) ?? 'sending';
    return { kind: latest.kind, stage, label };
  }
  return { kind: latest.kind, stage: null, label };
}

/** The stepper's dots and lines (Ariadne.dc.html stepsOf) over the shared step states of ui/answer/delivery. */
function stepsOf(stage: DeliveryStage | null, status: StatusKey): Step[] | null {
  return deliverySteps(stage, status === 'progress' ? 'in_progress' : 'resolved')?.map((step, index) => {
    const current = step.state === 'current', done = step.state === 'done';
    return { label: step.label,
      dotBg: done || (current && index === 3) ? 'var(--color-accent)' : 'transparent',
      dotRing: current ? `inset 0 0 0 1.5px ${step.failed ? 'var(--a-warn)' : 'var(--color-accent)'}` : done ? 'none' : `inset 0 0 0 1.5px ${neutral(30)}`,
      color: current ? (step.failed ? 'var(--a-warn)' : 'var(--color-text)') : done ? neutral(76) : neutral(56),
      weight: current ? 500 : 400, line: index < 3, lineBg: done ? 'var(--color-accent)' : 'var(--color-divider)' };
  }) ?? null;
}

/** The shared delivery line. A stopped delivery shows its fix instead (`stuck`). */
const deliveryOf = (stage: DeliveryStage, kind: InputKind, label: string, agent: string): DeliveryLine =>
  deliveryText(stage, kind, label || '…', agent);

/** What the owner sent, as a bubble: the chosen option, a one-press request, or their own words. */
function sentView(input: Immutable<Input>): Pick<PendingView, 'how' | 'text'> {
  const request = ({ bring: 'Bring it up', drop: 'Drop it', reopen: 'Back to Open', continue: 'Topic summary for the agent', removed: 'Removal notice for the agent' } as Partial<Record<InputKind, string>>)[input.kind];
  if (request) return { how: 'action', text: request };
  const option = input.payload.selected_option_id ? input.payload.target_snapshot.options.find(value => value.id === input.payload.selected_option_id) : null;
  return option ? { how: 'chose', text: option.label } : { how: 'said', text: input.payload.text.trim() };
}
const CAPTION: Readonly<Partial<Record<Input['state'], string>>> = { queued: 'Not sent yet', in_flight: 'On its way', needs_attention: 'Not delivered' };

/**
 * `pending`: owner messages still on their way; they end the conversation as pending bubbles instead of sitting in their round.
 * `delivered`: the pending ones already with the agent (in flight). Once their round has its result, they stay in the round,
 * so the exchange reads ask, answer, result; each one so kept is added to `kept` and leaves the pending bubbles.
 * `answered`: an answer or reply written for the current question is on its way.
 */
function roundView(session: Immutable<Session>, item: Immutable<Item>, round: Immutable<Round>, last: boolean, pending: ReadonlySet<string>, delivered: ReadonlySet<string>,
  kept: Set<string>, answered: boolean): RoundView {
  // A message deleted before it was sent, or cancelled by archive or close, is not part of the round: the agent never got it.
  const messages = (ids: readonly string[]) => ids.map(id => session.messages.find(message => message.id === id))
    .filter((message): message is Immutable<Message> => !!message && counted(session, message));
  const agent = messages(round.agent_message_ids);
  const results = round.result_input_ids.flatMap(id => session.inputs[id]?.attempts.flatMap(attempt => attempt.domain_result ? [attempt.domain_result] : []) ?? []);
  const result = results.at(-1)?.explanation ?? agent.at(-1)?.body ?? '';
  const owner = messages(round.owner_message_ids).filter(message => {
    if (!pending.has(message.id)) return true;
    if (!result || !delivered.has(message.id)) return false;
    kept.add(message.id);
    return true;
  });
  const answer = session.answers.filter(value => value.item_id === item.id && owner.some(message => message.id === value.message_id)).sort((a, b) => b.seq - a.seq)[0];
  const chosen = answer?.selected_option_id ? answer.options_snapshot.find(option => option.id === answer.selected_option_id)?.label ?? null : null;
  const you = chosen ? { chosen: true, text: chosen } : answer?.text.trim() ? { chosen: false, text: answer.text.trim() }
    : owner.length ? { chosen: false, text: owner.at(-1)!.body } : null;
  // Still waiting on the owner unless an answer or reply to this ask is on its way. Core files every owner input of the item in
  // its open round, a Bring or a note too, so being in the round proves nothing: only the kind and the question it was written for do.
  const now = last && !you && !answered && item.status === 'waiting_on_me';
  return { ordinal: round.ordinal, ask: round.ask_snapshot ?? round.question_snapshot, now, you, result,
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
export function detailModel({ session, itemId, now, mode, later, saving, presence = null, health = null, earlierAgent = null, replyDraft = false }: DetailInput): DetailModel | null {
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
  const offline = connectionOf(binding, presence) === 'reconnecting';
  const sub = submission(session, item, saving);
  // The latest unsettled message to this item, or a stopped one needing a decision. A held one (written for an older question)
  // doesn't hold the answer box: the newer ask wins and the owner answers it.
  // `active` is oldest first: it is the order of the pending bubbles that end the conversation.
  const active = Object.values(session.inputs).filter((input): input is Immutable<Input> => !!input && input.target.item_id === item.id
    && ACTIVE_INPUT.has(input.state)).sort((a, b) => a.seq - b.seq);
  const tracked = [...active].sort(byDecisionThenNewest)[0] ?? null;
  // Held is the newest message's state, as `submission` follows it: a stopped delivery ranked first by `tracked` must not
  // hide that the message behind it is held, or the answer box would stay closed on a question the owner can now answer.
  const newest = active.at(-1);
  const held = !saving && !!newest && heldInput(session, newest);
  const stuck = !saving && tracked ? stuckInput(session, tracked, presence, health) : null;
  const outbox = active.map((input): PendingView => ({ input, ...sentView(input), caption: CAPTION[input.state] ?? '',
    stuck: saving ? null : stuckInput(session, input, presence, health) }));
  const pending = !!sub?.stage && sub.stage !== 'failed' && !held;
  const outLabel = status === 'done' && item.type === 'explanation' ? 'Explained' : OUTLBL[status];
  const ownerLabel = item.owner.kind === 'me' ? 'you' : item.owner.kind === 'agent' ? 'the agent' : item.owner.name;
  const showSteps = sub && (sub.stage !== null || (status !== 'waiting' && status !== 'open'));

  let open: OpenSection | null = null;
  // The dock stays for an open or in-progress item while a message is on its way: its box is always there, and a second
  // message queues behind the first. Bring it up and Drop wait until it settles, so they are never sent twice.
  const keepsBox = status === 'open' || status === 'progress';
  if (!readOnly && (!pending || keepsBox) && status !== 'waiting') {
    const action = (value: ActionKey, key: string, label: string, icon: string, title: string, extra: Partial<OpenAction> = {}): OpenAction =>
      ({ action: value, key, label, icon, title, primary: false, pressed: mode === value, disabled: offline, ...extra });
    if (status === 'open') {
      open = { title: later ? 'Parked for later' : 'Not discussed yet',
        hint: mode === 'reply' ? 'The agent reads your reply and decides what happens next.'
          : mode === 'drop' ? 'Tells the agent to drop it. It stays in the tree, marked Dropped.'
          : pending ? 'Your message is on its way. You can write another; it goes out after.'
          : later ? 'Out of your way, still in the tree. Bring it up or unpark it any time.'
          : 'Bring it up asks the agent to raise this now, with options for you. Later keeps it open but out of your way.',
        actions: [
          action('bring', 'b', 'Bring it up', 'ph ph-megaphone-simple', 'Ask the agent to raise this as a question for you', { primary: true, pressed: false }),
          action('reply', 'r', 'Reply', 'ph ph-chat-text', 'Reply in your own words'),
          action('drop', 'd', 'Drop', 'ph ph-x-circle', 'Tell the agent to drop it'),
          action('later', 'z', later ? 'Unpark' : 'Later', later ? 'ph ph-arrow-u-up-left' : 'ph ph-clock', later ? 'Bring it back into view' : 'Park it, still open', { pressed: false, disabled: false }),
        ].filter(value => !pending || value.action === 'reply' || value.action === 'later') };
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
  // The answer slot hides while its input is pending; a follow-up reply still queues behind it.
  // A reply being written stays when the hold clears, next to the answer box. A waiting item's words go out as a reply
  // (`sentAs`), so the button says reply: "follow-up" is only ever the kind sent on a finished item.
  const followUp = !readOnly && status === 'waiting' && (pending || replyDraft) ? { label: `Add a ${sentAs(status)}`,
    hint: pending ? 'Queued behind the answer in flight' : 'Your reply is kept. Send it, or answer below.', disabled: offline } : null;
  const recommended = item.options.findIndex(option => option.recommended);
  const blocked = session.state !== 'active' ? 'This session is closed. Reopen it to answer.'
    : offline ? reconnectingNote(agent) : null;

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
  // One deleted (or taken back to edit) before it was sent leaves the timeline; one that archive or close cancelled stays, marked not sent.
  session.messages.forEach(message => { if (message.author === 'owner' && message.item_id === item.id && !withdrawn(session, message)) add(message.id, 'updated'); });
  const roleLabel = (role: Mark, me: boolean) => role === 'origin' ? 'Parent raised here' : role === 'created' ? (me ? 'You asked here' : 'Agent raised this') : (me ? 'You replied' : 'Agent updated');
  const ordered = [...entries.values()].sort((a, b) => a.message.number - b.message.number);
  const timeline = ordered.map((entry, index): TimelineEntry => ({
    id: entry.message.id, message: excerptView(entry.message, now, earlierAgent), mark: entry.roles.includes('created') ? 'created' : entry.roles[0],
    label: entry.roles.map(role => roleLabel(role, entry.message.author === 'owner')).join(' · '),
    note: entry.note, last: index === ordered.length - 1, unsent: notSent(session, entry.message) }));

  const rounds = Object.values(session.rounds).filter((round): round is Immutable<Round> => !!round && round.item_id === item.id).sort((a, b) => a.ordinal - b.ordinal);
  const lastRound = rounds.at(-1), lastAsk = lastRound ? (lastRound.ask_snapshot ?? lastRound.question_snapshot).trim() : null;
  const onItsWay = new Set(active.map(input => input.message_id));
  // An answer or a reply that is on its way and was written for the current question (not held for an older one) answers the newest ask.
  const answered = active.some(input => (input.kind === 'answer' || input.kind === 'reply') && !heldInput(session, input));
  const delivered = new Set(active.filter(input => input.state === 'in_flight').map(input => input.message_id)), kept = new Set<string>();
  const roundViews = rounds.map((round, index) => roundView(session, item, round, index === rounds.length - 1, onItsWay, delivered, kept, answered));
  // The head already shows the question: a lone ask that only repeats it is not said twice.
  if (roundViews.length === 1 && roundViews[0].ask.trim() === item.question.trim()) roundViews[0] = { ...roundViews[0], ask: '' };
  const reopened = isClosed ? undefined : [...item.status_history].reverse().find(entry => closedStatus.has(statusKey[entry.old_status]) && !closedStatus.has(statusKey[entry.new_status]));
  const replacement = item.replaced_by ? session.items[item.replaced_by] : undefined;
  const kids = items.filter(value => value.parent === item.id).sort((a, b) => a.ordinal - b.ordinal);

  return {
    id: item.id, question: item.question, status, display: statusKey[displayStatus(session, item)], badgeLabel: outLabel ?? '',
    meta: `${TYPE[item.type]} · next action: ${ownerLabel} · raised in ${created ? messageNumber(created, earlierAgent) : 'an earlier session'}`,
    path,
    stepsTitle: sub && sub.kind !== 'answer' ? 'Your request' : 'Your answer',
    steps: showSteps ? stepsOf(sub.stage, status) : null,
    // An in-flight message keeps its delivery line; the `sent` note only adds Cancel.
    delivery: sub?.stage && (!stuck || stuck.kind === 'sent') ?deliveryOf(sub.stage, sub.kind, sub.label, agent) : null,
    outbox: outbox.filter(pending => !kept.has(pending.input.message_id)),
    open,
    box: readOnly ? null : sentAs(status),
    followUp,
    // The conversation's last message carries the open ask; the composer repeats it only when it is a different one.
    answer: answerable ? { heading: !showSteps, ask: item.ask && item.ask.trim() !== lastAsk ? item.ask : null, options: item.options, recommended, blocked } : null,
    outcome: item.outcome ? { label: outLabel ?? 'Outcome', text: item.outcome, color: `var(--st-${status})` } : null,
    note: item.note && status === 'progress' ? item.note : null,
    why: item.why,
    replaced: replacement ? kid(replacement) : null,
    kidLabel: `Branched into ${kids.length} item${kids.length > 1 ? 's' : ''}`,
    kids: kids.map(kid),
    links: item.links.map(link => ({ icon: LINKICON[link.kind] ?? 'ph ph-link', target: link.target, label: link.label, meta: (link as typeof link & { meta?: string }).meta ?? '' })),
    prev: reopened ? { status: statusKey[reopened.old_status], outcome: reopened.previous_outcome ?? '' } : null,
    rounds: roundViews,
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
