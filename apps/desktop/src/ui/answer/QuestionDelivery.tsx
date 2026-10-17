// What happens to an answer after Send (§6.14): Sending (locked, no Undo) → Sent or Queued (Undo while the input is
// still queued, through core's atomic input_cancel) → Picked up at HH:MM (the claim; no Undo) — or Failed: why, Copy and
// Retry in the bar (StuckNote's one resend of the same input; the note below keeps its other actions). Shared by the
// dock, Details, the peek and other sessions.
import { useMemo, useState, type ReactNode } from 'react';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { Input, Session } from '../../generated/domain/models';
import { sessionActionsFor, useSessionActions } from '../../components/bindings/actions';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentReceived, recoveryProblem, stuckInput } from '../../selectors/waiting/stuck';
import { ActionFailure } from '../../components/edge-states/EdgeState';
import { copyText } from '../shared/clipboard';
import { agentName, clock } from '../shell/model';
import { editQueued, type ReviewOutcome } from './held';
import { ReviewResult, StuckNote, useStuckRetry } from './StuckNote';
import type { AnswerBar } from './AnswerControl';

const replyKinds = ['answer', 'reply', 'note', 'followup', 'drop'];

/**
 * The owner input on the item's current question that still stands (not cancelled or skipped): its answer when it has one,
 * else the newest of its other words. A reply sent after the answer never takes the answer's place in the sealed cards.
 */
export function standingInput(session: Immutable<Session> | null | undefined, itemId: string): Immutable<Input> | null {
  const revision = session?.items[itemId]?.question_revision;
  const standing = Object.values(session?.inputs ?? {}).filter(value => !!value && replyKinds.includes(value.kind) && value.target.item_id === itemId
    && value.payload.target_snapshot.question_revision === revision && !['cancelled', 'skipped'].includes(value.state))
    .sort((a, b) => b!.seq - a!.seq);
  return standing.find(value => value!.kind === 'answer') ?? standing[0] ?? null;
}

/** An answer to the item's current question is queued, in flight or stuck: a new answer would be a second one. */
export const answerStanding = (session: Immutable<Session> | null | undefined, itemId: string): boolean => {
  const input = standingInput(session, itemId);
  return !!input && input.kind === 'answer' && ['queued', 'in_flight', 'needs_attention'].includes(input.state);
};

export interface Delivery {
  /** What went out: the picked option and the note or own words. Null before anything was sent. */
  readonly content: { readonly selected_option_id: string | null; readonly text: string } | null;
  readonly bar: AnswerBar | null;
  /** StuckNote, the Undo outcome and the copy fallback. */
  readonly extra: ReactNode;
  /** The option label and the words, as they went out (empty before anything was sent). */
  readonly words: string;
}

const button = (props: { label: string; icon: string; title?: string; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' | 'sending' }) =>
  <button type="button" className="answer-bar-button" title={props.title} disabled={props.disabled} key={props.label}
    data-primary={props.kind === 'primary' || undefined} data-ghost={props.kind === 'ghost' || undefined} data-sending={props.kind === 'sending' || undefined}
    aria-disabled={props.kind === 'ghost' || props.kind === 'sending' || undefined}
    onClick={props.kind === 'ghost' || props.kind === 'sending' ? undefined : props.onClick}>
    <i className={props.icon} aria-hidden="true" />{props.label}</button>;

/** When this window first saw core accept an input: every place showing it before the session read agrees on the time. */
const accepted = new Map<string, number>();
function acceptedAt(inputId: string): number {
  if (!accepted.has(inputId)) accepted.set(inputId, Date.now());
  return accepted.get(inputId)!;
}

export function useQuestionDelivery({ drafts, store, itemId, inputId }: {
  readonly drafts: OwnerDraftStore; readonly store: SessionStore; readonly itemId: string; readonly inputId?: string;
}): Delivery {
  useOwnerDrafts(drafts);
  const state = useSession(store), session = state.snapshot?.session;
  const actions = useMemo(() => sessionActionsFor(drafts.service, store), [drafts, store]);
  const operation = useSessionActions(actions);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null), [busy, setBusy] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const entry = drafts.find(state.route, itemId, 'answer');
  const receiptId = entry?.receipt?.data.kind === 'input_submit' ? entry.receipt.data.input_id : null;
  const input = inputId ? session?.inputs[inputId] ?? null : (receiptId ? session?.inputs[receiptId] : null) ?? standingInput(session, itemId);
  const content = input?.payload ?? (!inputId || receiptId === inputId ? entry?.sent ?? null : null);
  const option = input?.payload.target_snapshot.options.find(value => value.id === content?.selected_option_id)
    ?? session?.items[itemId]?.options.find(value => value.id === content?.selected_option_id);
  const words = [option?.label, content?.text].filter(Boolean).join('\n\n');
  const copy = () => { void copyText(words).then(() => setCopyFailed(false), () => setCopyFailed(true)); };
  const undo = async () => {
    if (busy || !input || input.state !== 'queued') return;
    setBusy(true);
    try { setOutcome(await editQueued(drafts, session, input, actions)); }
    finally { setBusy(false); }
  };
  const extraOf = (stuck: ReactNode) => <>{stuck}{outcome && <ReviewResult outcome={outcome} />}
    {copyFailed && <textarea className="answer-copy-fallback" aria-label="Copy your answer" readOnly value={words} />}</>;
  const done = (value: Omit<Delivery, 'words'>): Delivery => ({ ...value, words: value.content ? words : '' });
  const binding = input ? session?.bindings[input.binding_id] ?? null : null;
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const evidence = input ? deliveryEvidence(input, binding ? { ...binding, presence } : null, session?.operation_receipts, presence) : null;
  const attempt = input?.attempts.find(value => value.id === input.active_attempt_id);
  const failed = evidence?.kind === 'failed' || evidence?.kind === 'rejected' || evidence?.kind === 'stopped';
  // Failed before the agent had it: the bar says why and carries the Retry.
  const failedHere = !!input && failed && !agentReceived(attempt);
  const stuck = failedHere && session ? stuckInput(session, input, presence) : null;
  const retry = useStuckRetry(actions, failedHere ? input : null, stuck);
  if (!input) {
    if (!receiptId && !entry?.saving) return done({ content: null, bar: null, extra: extraOf(null) });
    const held = entry?.sent ?? (entry ? { selected_option_id: entry.draft.selected_option_id, text: entry.draft.text } : null);
    if (entry?.saving || !receiptId) return done({ content: held, extra: extraOf(null),
      bar: { icon: 'ph ph-circle-notch answer-spin', tone: 'accent', text: 'Sending to the agent…', sealed: true,
        actions: button({ label: 'Sending…', icon: 'ph ph-circle-notch', title: 'Already sending', kind: 'sending' }) } });
    // Core accepted it (the receipt is in) and the session read does not show it yet: sent, and Undo waits for that read.
    const at = clock(acceptedAt(receiptId));
    return done({ content: held, extra: extraOf(null),
      bar: { icon: 'ph ph-check', tone: 'done', text: `Sent at ${at}. Waiting for the agent to pick it up.`, narrow: `Sent at ${at}. Waiting for the agent.`, sealed: true,
        actions: button({ label: 'Sent', icon: 'ph ph-paper-plane-right', title: 'Already sent', kind: 'ghost' }) } });
  }
  const checking = evidence?.kind === 'uncertain' || evidence?.kind === 'unavailable';
  const sentAt = clock(Date.parse(input.created_at));
  const pickedAt = input.attempts[0]?.prepared_at;
  const copyButton = button({ label: 'Copy', icon: 'ph ph-copy', title: 'Copy your answer', onClick: copy });
  if (failedHere && session) {
    // Board 2.5: why, then Copy and Retry in the bar. Retry is StuckNote's: one resend of this same input.
    const why = attempt ? recoveryProblem(attempt, binding ? agentName(binding.adapter_id) : 'the agent') : null;
    const retryButton = retry && button({ label: 'Retry', icon: 'ph ph-arrow-clockwise', title: retry.title, disabled: retry.disabled, kind: 'primary', onClick: retry.run });
    return done({ content, extra: <>{stuck && <StuckNote actions={actions} input={input} stuck={stuck} retryInBar={!!retry} />}
      {retry?.acted && <div className="stuck-failure"><ActionFailure actions={actions} /></div>}{extraOf(null)}</>,
      bar: { icon: 'ph ph-warning-circle', tone: 'danger', text: `Not sent${why ? `: ${why}` : '.'} Your answer is kept.`, narrow: 'Not sent. Your words are kept.', sealed: true,
        actions: <>{copyButton}{retryButton}</> } });
  }
  if (checking) return done({ content, extra: extraOf(null),
    bar: { icon: 'ph ph-circle-notch', tone: 'accent', text: 'Checking delivery. Your answer is kept.', narrow: 'Checking delivery.', sealed: true,
      actions: <>{copyButton}{button({ label: 'Check delivery', icon: 'ph ph-arrows-clockwise', onClick: () => { void store.refresh(); } })}</> } });
  if (input.state === 'queued') {
    const undoButton = button({ label: 'Undo', icon: 'ph ph-arrow-counter-clockwise', title: 'Take the answer back; it works until the agent picks it up',
      disabled: busy || operation.writing || !!operation.pending || state.status !== 'ready', onClick: () => { void undo(); } });
    const queued = evidence?.kind === 'queued';
    // Queued behind a busy agent (connected, sending on, working) goes when it is free; otherwise when it runs again.
    const busyAgent = !!binding && binding.connection_state === 'connected' && !binding.owner_paused && binding.dispatch_state === 'enabled';
    return done({ content, extra: extraOf(null), bar: queued
      ? { icon: 'ph ph-hourglass-medium', text: `Queued at ${sentAt}. It goes when the agent is ${busyAgent ? 'free' : 'running'}.`, narrow: `Queued at ${sentAt}.`, sealed: true,
        actions: <>{undoButton}{button({ label: 'Queued', icon: 'ph ph-hourglass-medium', title: 'Already queued', kind: 'ghost' })}</> }
      : { icon: 'ph ph-check', tone: 'done', text: `Sent at ${sentAt}. Waiting for the agent to pick it up.`, narrow: `Sent at ${sentAt}. Waiting for the agent.`, sealed: true,
        actions: <>{undoButton}{button({ label: 'Sent', icon: 'ph ph-paper-plane-right', title: 'Already sent', kind: 'ghost' })}</> } });
  }
  const picked = pickedAt ? `Picked up at ${clock(Date.parse(pickedAt))}.` : 'Picked up by the agent.';
  return done({ content, extra: extraOf(null),
    bar: { icon: 'ph ph-check', tone: 'done', text: picked, sealed: true, actions: button({ label: 'Sent', icon: 'ph ph-paper-plane-right', title: 'Already sent', kind: 'ghost' }) } });
}

/** One sent answer as a line: the dock's Sent list. It shows the words exactly as they went out. */
export function QuestionDelivery(props: { readonly drafts: OwnerDraftStore; readonly store: SessionStore; readonly itemId: string; readonly inputId?: string }) {
  const { bar, extra, words } = useQuestionDelivery(props);
  return <div className="question-delivery">
    {words && <p className="question-sent-words">{words}</p>}
    {bar && <div className="answer-bar" data-tone={bar.tone}><i className={`${bar.icon} answer-bar-icon`} aria-hidden="true" />
      <span className="answer-bar-text" role="status">{bar.text}</span>{bar.actions}</div>}
    {extra}
  </div>;
}
