// Edit for a message that hasn't been sent yet (queued), and "Review and send
// again" for a held one (written for an older revision of its question): the
// queued message is taken back first (`input_cancel` with purpose edit), and only
// once core confirmed that does its text and chosen option go into the owner's
// editor for that item or topic. A message the owner already started there is
// never overwritten. `putBackCancelled` loads a message that was already cancelled
// (taken back to edit, or by archive or close) by the same rule; nothing is cancelled.
//
// The safety rule: the editor never holds a queued message's words while that
// message can still be sent. Writing them only after the confirmed cancel means
// the same words can never go out twice. A cancel that fails or is unconfirmed
// changes nothing; if it later turns out to have landed, the message shows
// "Taken back to edit" with "Put back in reply box", so its text is never lost.
import type { Immutable } from '../../data/session-store';
import type { Input, InputKind, Session } from '../../generated/domain/models';
import type { SessionActions } from '../../components/bindings/actions';
import { ownerActions, TOPIC_REPLY, type DraftEntry, type DraftState, type OwnerDraftStore, type OwnerIntent } from '../../state/drafts/store';

/** The editor a message goes back to: an item's answer, reply, note or follow-up box, or the topic's reply box. */
export type EditTarget = 'answer' | 'reply' | 'note' | 'followup' | 'topic_reply';
/**
 * - `moved`: the message is taken back (or was already cancelled) and its text is saved in the `intent` editor.
 * - `kept`: the owner already started a different message in the `intent` editor; it stays and the earlier `text` is shown
 *   to copy. Before the cancel nothing is cancelled; after it, the message's "Taken back to edit" line can put it back later.
 * - `unavailable`: the editor can't take it now (still saving, or a save is unconfirmed); nothing changed.
 * - `already_sent`: core refused because the message already left the queue; nothing changed.
 * - `not_taken_back`: the cancel was refused, never ran, or is unconfirmed; nothing changed.
 * - `taken_back`: the message is taken back, but its text could not go in the editor; its "Not sent" line puts it back.
 */
export type ReviewOutcome = { readonly kind: 'moved'; readonly intent: EditTarget } | { readonly kind: 'unavailable' }
  | { readonly kind: 'kept'; readonly intent: EditTarget; readonly text: string } | { readonly kind: 'already_sent' }
  | { readonly kind: 'not_taken_back' } | { readonly kind: 'taken_back' };

/** The outcomes that leave the message's editor worth opening: it holds the message, or the owner's own words. */
export const inEditor = (outcome: ReviewOutcome): outcome is Extract<ReviewOutcome, { readonly intent: EditTarget }> =>
  outcome.kind === 'moved' || outcome.kind === 'kept';

/** What the owner is told when core refused the take-back because the message already left the queue. */
export const ALREADY_SENT = 'This message was already sent, so it can’t be edited.';
/** What the owner is told when the take-back was refused, never ran or is unconfirmed. Nothing changed. */
export const NOT_TAKEN_BACK = 'Couldn’t take this message back. Try again.';
/** What the owner is told when the message is taken back but the editor could not take its text. */
export const TAKEN_BACK_NOT_LOADED = 'Taken back, but your editor was busy. Use “Put back in reply box” on the message.';

const kept = new Set<InputKind>(['answer', 'reply', 'note', 'followup']);
/**
 * Only the owner's own words can be edited: an answer, reply, note, follow-up or topic reply. Bring, drop and reopen
 * carry no text to change (Edit would only delete them) and agent notices (continue, removed) are not the owner's words:
 * those can be deleted, not edited.
 */
export const editable = (kind: InputKind) => kept.has(kind) || kind === TOPIC_REPLY;

/** Where a message's words go and what they are. */
interface Plan {
  readonly intent: EditTarget;
  readonly text: string;
  /** The chosen option, kept only for an answer whose option still exists. */
  readonly selected: string | null;
}

/**
 * Where `input`'s words would go, checked against the editor as it is now without changing anything: `kept` when the
 * owner already started a different message there, `unavailable` when it is busy. `from` is the state `input` must be in.
 */
async function plan(drafts: OwnerDraftStore, session: Immutable<Session> | null | undefined, input: Immutable<Input>,
  from: 'queued' | 'cancelled'): Promise<ReviewOutcome | Plan> {
  const unavailable = { kind: 'unavailable' } as const;
  // The tree and the Waiting rail may not have read the saved drafts yet.
  if (!drafts.getSnapshot().ready) await drafts.load();
  const state = drafts.getSnapshot();
  if (!session || !state.ready || state.preferenceUncertain || !editable(input.kind) || session.inputs[input.id]?.state !== from) return unavailable;
  const itemId = input.target.item_id, item = itemId ? session.items[itemId] : undefined;
  if (itemId ? !item : input.kind !== TOPIC_REPLY || !session.topics[input.target.topic_id]) return unavailable;
  // The draft of its own kind: an answer while the question waits, a note or follow-up while the item isn't waiting (a
  // waiting item shows only its answer and reply boxes); anything else goes to the reply draft. The detail's box edits any
  // draft of words in place and names what it will be sent as, so a note put back on an open item shows at once in the
  // docked box, with no extra step.
  const waiting = item?.status === 'waiting_on_me';
  const fits = (kind: InputKind) => kept.has(kind) && ownerActions(item!).includes(kind as OwnerIntent) && (kind === 'answer' || kind === 'reply' || !waiting);
  const intent: EditTarget = !item ? 'topic_reply' : fits(input.kind) ? input.kind as Exclude<EditTarget, 'topic_reply'> : 'reply';
  const option = input.payload.selected_option_id;
  const selected = intent === 'answer' && option && item?.options.some(value => value.id === option) ? option : null;
  const planned = { intent, text: input.payload.text, selected };
  return occupied(find(drafts, session, input, intent), planned) ?? planned;
}

const find = (drafts: OwnerDraftStore, session: Immutable<Session>, input: Immutable<Input>, intent: EditTarget): DraftEntry | undefined => {
  const route = { project_id: session.project_id, session_id: session.id }, itemId = input.target.item_id;
  return itemId ? drafts.find(route, itemId, intent as OwnerIntent) : drafts.findTopic(route, input.target.topic_id);
};

/** Why the editor can't take the words now: busy, or it holds a different message the owner started. Null when it can. */
function occupied(existing: DraftEntry | undefined, { intent, text, selected }: Plan): ReviewOutcome | null {
  if (existing && (existing.saving || existing.uncertain)) return { kind: 'unavailable' };
  if (!existing || existing.receipt) return null;
  const { draft } = existing, same = draft.text === text && draft.selected_option_id === selected;
  return (draft.text.trim() || draft.selected_option_id) && !same ? { kind: 'kept', intent, text } : null;
}

/**
 * Saves the words in their editor. Call only when `input` can no longer be sent (it is cancelled). The editor is checked
 * again right before writing, with no wait in between: a message the owner started meanwhile is never overwritten.
 */
async function load(drafts: OwnerDraftStore, session: Immutable<Session>, input: Immutable<Input>, planned: Plan): Promise<ReviewOutcome> {
  const { intent, text, selected } = planned, unavailable = { kind: 'unavailable' } as const;
  if (drafts.getSnapshot().preferenceUncertain) return unavailable;
  const existing = find(drafts, session, input, intent), blocked = occupied(existing, planned);
  if (blocked) return blocked;
  if (existing?.receipt) drafts.another(existing.draft.op_id, session);
  const itemId = input.target.item_id;
  const id = find(drafts, session, input, intent)?.draft.op_id
    ?? (itemId ? drafts.begin(session, itemId, intent as OwnerIntent) : drafts.beginTopic(session, input.target.topic_id));
  const entry = id ? drafts.getSnapshot().entries[id] : undefined;
  if (!id || !entry || entry.saving || entry.uncertain) return unavailable;
  drafts.review(id, session);
  if (!await drafts.editSaved(id, { text, selected_option_id: selected })) return unavailable;
  // The owner may have typed while it saved: their words stay.
  if (drafts.getSnapshot().entries[id]?.draft.text !== text) return { kind: 'kept', intent, text };
  return { kind: 'moved', intent };
}

/**
 * True while the owner's editor is sending, or has just sent, the same words to the same item or topic as the cancelled
 * `input`: the session view has not caught up yet, so `NotSent.again` is still false. Put back must offer nothing then:
 * loading the words again would put a second copy in the box. A send that core refused, or whose message was cancelled
 * again, is not counted: those words are not on their way.
 */
export function sendingAgain(state: DraftState, session: Immutable<Session>, input: Immutable<Input>): boolean {
  const text = input.payload.text.trim(), option = input.payload.selected_option_id;
  if (!text && !option) return false;
  return Object.values(state.entries).some(entry => {
    const { draft } = entry;
    if (draft.session.project_id !== session.project_id || draft.session.session_id !== session.id
      || draft.target.item_id !== input.target.item_id || draft.target.topic_id !== input.target.topic_id) return false;
    const sent = entry.receipt ? entry.sent : entry.saving || entry.uncertain && !entry.rejected ? draft : null;
    if (!sent || sent.text.trim() !== text || sent.selected_option_id !== option) return false;
    // Once the session shows the message it speaks for itself (`NotSent.again`), unless that message was cancelled too.
    const saved = entry.receipt?.data.kind === 'input_submit' ? session.inputs[entry.receipt.data.input_id] : undefined;
    return !saved || saved.state !== 'cancelled' && saved.state !== 'skipped';
  });
}

/**
 * Why a cancelled message can't go back in its editor yet (the session is closed, or its topic is archived: nothing
 * could be sent from there), or null when it can. The Not sent line shows this instead of the button.
 */
export function putBackBlocked(session: Immutable<Session>, input: Immutable<Input>): string | null {
  return session.archived_at != null ? 'Restore the session, then reopen it to put it back in the reply box.' : session.state !== 'active' ? 'Reopen the session to put it back in the reply box.'
    : session.topics[input.target.topic_id]?.archived_at ? 'Restore the topic to put it back in the reply box.' : null;
}

/** Loads a cancelled message (taken back to edit, or by archive or close) into its editor by the same safe rule. Nothing is cancelled. */
export async function putBackCancelled(drafts: OwnerDraftStore, session: Immutable<Session> | null | undefined,
  input: Immutable<Input>): Promise<ReviewOutcome> {
  const planned = await plan(drafts, session, input, 'cancelled');
  if ('kind' in planned) return planned;
  // The same words are already on their way from the editor: loading them again would send them twice.
  if (sendingAgain(drafts.getSnapshot(), session!, input)) return { kind: 'already_sent' };
  return load(drafts, session!, input, planned);
}

/** Takes the queued `input` back, waits for core to confirm it, and only then puts its words in the owner's editor. */
export async function editQueued(drafts: OwnerDraftStore, session: Immutable<Session> | null | undefined, input: Immutable<Input>,
  actions: SessionActions): Promise<ReviewOutcome> {
  // An editor holding a different message keeps it, and nothing is cancelled.
  const planned = await plan(drafts, session, input, 'queued');
  if ('kind' in planned) return planned;
  // Cancel against the session as it is now, and wait for core's answer.
  const live = actions.session.getSnapshot().snapshot?.session ?? session;
  const before = live?.inputs[input.id]?.state;
  if (!live || before !== 'queued') return before && before !== 'cancelled' ? { kind: 'already_sent' } : { kind: 'not_taken_back' };
  const confirmed = await actions.execute({ command: 'input_cancel', api_version: 1, op_id: '',
    params: { input_id: input.id, expected_revision: live.revision, purpose: 'edit' } }, live.revision);
  const now = actions.session.getSnapshot().snapshot?.session ?? live, state = now.inputs[input.id]?.state;
  const saved = actions.getSnapshot().receipt, receipt = saved && 'data' in saved ? saved.data : undefined;
  // Taken back: core confirmed it, or the session already shows it cancelled. Either way it can never be sent now.
  const taken = confirmed ? receipt?.kind === 'input_cancel' && receipt.input_id === input.id && receipt.state === 'cancelled' : state === 'cancelled';
  if (!taken) {
    // Unconfirmed (kept for "Check again"), refused while still queued, or never sent: nothing changed.
    const pending = actions.getSnapshot().pending?.command;
    if (pending?.command === 'input_cancel' && pending.params.input_id === input.id) return { kind: 'not_taken_back' };
    return state && state !== 'queued' && state !== 'cancelled' ? { kind: 'already_sent' } : { kind: 'not_taken_back' };
  }
  const outcome = await load(drafts, now, input, planned);
  return outcome.kind === 'unavailable' ? { kind: 'taken_back' } : outcome;
}
