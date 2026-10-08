// The item detail panel's view model (handoff README §5, Ariadne.dc.html
// lines 324-464 and 1953-2079), built from the session snapshot the store
// already holds. A single transcript keeps messages and delivery actions together.
import type { Immutable } from '../../data/session-store';
import type { SupervisorHealth } from '../../data/service';
import type { Input, InputKind, Item, ItemOption, LinkKind, Message, PresenceObservation, Round, Session } from '../../generated/domain/models';
import { connectionOf, reconnectingNote } from '../shared/connection';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentName } from '../shell/model';
import { shortLabel } from '../shared/short';
import { excerptView, messageNumber, type ExcerptView } from '../shared/excerpt';
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
export interface LinkView { readonly kind: LinkKind; readonly icon: string; readonly label: string; readonly meta: string; /** Where the link points: an item, web address or file path. */ readonly target: string }
/** An unsettled owner message, with its delivery controls attached to its chat entry. */
export interface PendingView {
  readonly input: Immutable<Input>;
  /** What was sent: the chosen option (`chose`), the owner's words (`said`) or a one-press request (`action`). */
  readonly how: 'chose' | 'said' | 'action';
  readonly text: string;
  readonly note: string;
  /** Original message source, before the display label or whitespace shortening. */
  readonly source: string;
  /** Where it stands, in a few words. */
  readonly caption: string;
  /** Why it hasn't reached the agent, with what fixes it (ui/answer/StuckNote); null while saving. */
  readonly stuck: Stuck | null;
}
export interface ChatEntry {
  readonly id: string;
  readonly message: ExcerptView;
  readonly marker: string;
  readonly note: string;
  readonly asks: readonly { readonly text: string; readonly now: boolean; readonly ordinal: number }[];
  readonly you: Pick<PendingView, 'how' | 'text' | 'note'> | null;
  readonly pending: PendingView | null;
  readonly unsent: NotSent | null;
  readonly result: string;
  readonly forks: readonly Kid[];
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
  /** The owner's messages still on their way, oldest first. */
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
  /** One transcript in saved message order, including pending messages in place. */
  readonly chat: readonly ChatEntry[];
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
function sentView(input: Immutable<Input>): Pick<PendingView, 'how' | 'text' | 'note'> {
  const request = ({ bring: 'Bring it up', drop: 'Drop it', reopen: 'Back to Open', continue: 'Topic summary for the agent', removed: 'Removal notice for the agent' } as Partial<Record<InputKind, string>>)[input.kind];
  if (request) return { how: 'action', text: request, note: input.payload.text };
  const option = input.payload.selected_option_id ? input.payload.target_snapshot.options.find(value => value.id === input.payload.selected_option_id) : null;
  return option ? { how: 'chose', text: option.label, note: input.payload.text } : { how: 'said', text: input.payload.text, note: '' };
}
const CAPTION: Readonly<Partial<Record<Input['state'], string>>> = { queued: 'Not sent yet', in_flight: 'On its way', needs_attention: 'Not delivered' };

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
  const outbox = active.map((input): PendingView => ({ input, ...sentView(input), source: byId.get(input.message_id)?.body ?? input.payload.text, caption: CAPTION[input.state] ?? '',
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
      open = { title: 'While the agent works', hint: 'Your note goes to the agent and joins the chat. The item stays In progress.',
        actions: [action('note', 'r', 'Add a note', 'ph ph-chat-text', 'Add something while the agent works')] };
    } else if (isClosed) {
      open = { title: 'Revisit',
        hint: mode === 'followup' ? 'A comment joins the chat. A new question becomes a branch under this item; this item stays closed.'
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

  const rounds = Object.values(session.rounds).filter((round): round is Immutable<Round> => !!round && round.item_id === item.id).sort((a, b) => a.ordinal - b.ordinal);
  const entries = new Map<string, ChatEntry>();
  const add = (id: string | undefined, marker = '', note = '') => {
    const message = id ? byId.get(id) : undefined;
    if (!message || withdrawn(session, message)) return null;
    const old = entries.get(message.id);
    const entry: ChatEntry = old ? { ...old, marker: [old.marker, marker].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(' · '), note: note || old.note }
      : { id: message.id, message: excerptView(message, now, earlierAgent), marker, note, asks: [], you: null, pending: null,
        unsent: notSent(session, message), result: '', forks: [] };
    entries.set(message.id, entry);
    return entry;
  };
  const parent = item.parent ? session.items[item.parent] : undefined;
  if (parent) add(parent.created_message_id, 'Parent raised here', `From: ${parent.question}`);
  add(item.created_message_id, created?.author === 'owner' ? 'You asked here' : 'Agent raised this');
  item.updated_message_ids.forEach(id => add(id));
  session.messages.forEach(message => { if (message.item_id === item.id || message.items_touched.includes(item.id)) add(message.id); });
  rounds.forEach(round => {
    add(round.opened_message_id);
    [...round.agent_message_ids, ...round.owner_message_ids].forEach(id => add(id));
  });
  // Inputs can arrive before their message page. Keep delivery controls reachable during that refresh.
  active.forEach(input => {
    if (!byId.has(input.message_id)) {
      const message: Immutable<Message> = { id: input.message_id, number: Math.max(0, ...session.messages.map(message => message.number)) + input.seq,
        author: 'owner', kind: 'owner_input', body: input.payload.text, created_at: input.created_at, item_id: item.id,
        topic_id: input.target.topic_id, items_touched: [item.id], binding_id: input.binding_id, input_id: input.id,
        attempt_id: null, host_turn_id: null, round_id: null, origin: null };
      byId.set(message.id, message);
    }
    add(input.message_id);
  });
  const ordered = () => [...entries.values()].sort((a, b) => byId.get(a.id)!.number - byId.get(b.id)!.number);
  const owner = ordered().filter(entry => entry.message.author === 'me');
  const kept = new Set<string>();
  for (const entry of owner) {
    const message = byId.get(entry.id)!;
    const input = Object.values(session.inputs).find(value => value?.message_id === entry.id);
    const answer = session.answers.find(value => value.message_id === entry.id);
    const choice = answer?.selected_option_id ? answer.options_snapshot.find(option => option.id === answer.selected_option_id) : null;
    const you = choice && counted(session, message) ? { how: 'chose' as const, text: choice.label, note: answer!.text }
      : answer && counted(session, message) ? { how: 'said' as const, text: answer.text || message.body, note: '' }
      : input && counted(session, message) && sentView(input).how !== 'said' ? sentView(input) : { how: 'said' as const, text: message.body, note: '' };
    const next = owner.find(value => byId.get(value.id)!.number > message.number);
    const fullReply = ordered().some(value => value.message.author === 'agent' && byId.get(value.id)!.number > message.number
      && (!next || byId.get(value.id)!.number < byId.get(next.id)!.number));
    const round = rounds.find(value => value.owner_message_ids.includes(entry.id));
    const results = (round?.result_input_ids ?? (input ? [input.id] : [])).flatMap(id => session.inputs[id]?.attempts.flatMap(attempt => attempt.domain_result ? [attempt.domain_result] : []) ?? []);
    // A result belongs under the last owner message it handled. A full reply in that message's interval makes the summary redundant.
    const result = results.filter(value => value.handled_through_message_number >= message.number
      && (!next || value.handled_through_message_number < byId.get(next.id)!.number)).at(-1);
    const answeredAfter = (round?.agent_message_ids ?? []).some(id => (byId.get(id)?.number ?? 0) > message.number)
      || results.some(value => value.handled_through_message_number >= message.number);
    const pending = outbox.find(value => value.input.message_id === entry.id) ?? null;
    if (pending?.input.state === 'in_flight' && answeredAfter) kept.add(entry.id);
    entries.set(entry.id, { ...entry, you, pending: kept.has(entry.id) ? null : pending, result: counted(session, message) && !fullReply ? result?.explanation ?? '' : '' });
  }
  const answered = active.some(input => (input.kind === 'answer' || input.kind === 'reply') && !heldInput(session, input));
  rounds.forEach((round, index) => {
    const ask = (index === rounds.length - 1 ? item.ask : null) ?? round.ask_snapshot ?? round.question_snapshot;
    const opening = byId.get(round.opened_message_id)?.number ?? 0;
    const nextOpening = byId.get(rounds[index + 1]?.opened_message_id)?.number ?? Infinity;
    const matched = [...ordered()].reverse().find(entry => {
      const message = byId.get(entry.id)!;
      const belongs = message.round_id === round.id || round.agent_message_ids.includes(entry.id) || entry.id === round.opened_message_id
        || message.round_id === null && message.number >= opening && message.number < nextOpening;
      return belongs && entry.message.author === 'agent' && entry.message.body.trim().includes(ask.trim());
    });
    const anchor = matched ?? entries.get(round.opened_message_id);
    const replied = round.owner_message_ids.some(id => {
      const message = byId.get(id);
      return message && counted(session, message) && !active.some(input => input.message_id === id);
    }) || round.owner_message_ids.some(id => kept.has(id));
    const waiting = index === rounds.length - 1 && item.status === 'waiting_on_me' && !replied && !answered;
    if (anchor) entries.set(anchor.id, { ...anchor, asks: [...anchor.asks, { text: matched || ask.trim() === item.question.trim() ? '' : ask, now: waiting, ordinal: round.ordinal }] });
    round.fork_item_ids.forEach(id => {
      const fork = session.items[id];
      if (!fork) return;
      const at = entries.get(fork.created_message_id) ?? ordered().filter(entry => round.agent_message_ids.includes(entry.id)).at(-1) ?? anchor;
      if (at) { const current = entries.get(at.id)!; entries.set(at.id, { ...current, forks: [...current.forks, kid(fork)] }); }
    });
  });
  if (!rounds.length && item.status === 'waiting_on_me' && item.ask) {
    const ask = item.ask;
    const anchor = [...ordered()].reverse().find(entry => entry.message.author === 'agent' && entry.message.body.includes(ask)) ?? entries.get(item.created_message_id);
    if (anchor) entries.set(anchor.id, { ...anchor, asks: [{ text: anchor.message.body.includes(ask) || ask === item.question ? '' : ask, now: !answered, ordinal: 1 }] });
  }
  const chat = ordered();
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
    // The chat carries the ask once; the composer only carries the answer control.
    answer: answerable ? { heading: !showSteps, ask: null, options: item.options, recommended, blocked } : null,
    outcome: item.outcome ? { label: outLabel ?? 'Outcome', text: item.outcome, color: `var(--st-${status})` } : null,
    note: item.note && status === 'progress' ? item.note : null,
    why: item.why,
    replaced: replacement ? kid(replacement) : null,
    kidLabel: `Branched into ${kids.length} item${kids.length > 1 ? 's' : ''}`,
    kids: kids.map(kid),
    links: item.links.map(link => ({ kind: link.kind, icon: LINKICON[link.kind] ?? 'ph ph-link', target: link.target, label: link.label, meta: (link as typeof link & { meta?: string }).meta ?? '' })),
    prev: reopened ? { status: statusKey[reopened.old_status], outcome: reopened.previous_outcome ?? '' } : null,
    chat,
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
