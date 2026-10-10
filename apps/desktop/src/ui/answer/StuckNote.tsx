// A message that hasn't reached the agent explains itself (selectors/waiting/stuck)
// and offers what fixes it: Resume; for a message not sent yet, Edit ("Review and
// send again" when held) and Delete; Retry and Mark as done (or Mark as handled)
// for a stopped delivery, with the audited form behind "More options"; a received
// message offers result repair and Stop waiting instead. Shared by the tree rows, the detail tracker and
// the Waiting "Sent" rows; every write goes through the session's write barrier.
import { useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSession, type Immutable } from '../../data/session-store';
import type { OwnerCommand } from '../../generated/core';
import type { Input } from '../../generated/domain/models';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { useDispatch } from '../../components/bindings/DispatchChip';
import { qualifiedPresence } from '../../components/bindings/presence';
import { ActionFailure } from '../../components/edge-states/EdgeState';
import { attestIdle, RecoveryReview, resolveCommand } from '../../components/recovery/RecoveryPanel';
import { agentReceived, awaitingAnswer, keepsLateAnswer, skipWithoutIdle, stoppedAttempt, type Stuck } from '../../selectors/waiting/stuck';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { ALREADY_SENT, editable, NOT_TAKEN_BACK, TAKEN_BACK_NOT_LOADED, type ReviewOutcome } from './held';
import '../../components/bindings/controls.css';

export interface StuckNoteProps {
  readonly actions: SessionActions;
  readonly input: Immutable<Input>;
  readonly stuck: Stuck;
  /** Not sent yet: take the queued message back, then put it in the owner's editor (held.ts `editQueued`). */
  readonly onEdit?: () => Promise<ReviewOutcome>;
  /** Queued cards use small Edit/Delete icons on their bottom line. */
  readonly compactActions?: boolean;
}

/** What Edit ("Review and send again") says when it could not simply move the message. */
export function ReviewResult({ outcome }: { readonly outcome: ReviewOutcome }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  if (outcome.kind === 'moved') return null;
  if (outcome.kind === 'unavailable') return <div className="stuck-failure" role="alert">Your editor is busy saving. Try again in a moment.</div>;
  if (outcome.kind === 'already_sent') return <div className="stuck-failure" role="alert">{ALREADY_SENT}</div>;
  if (outcome.kind === 'not_taken_back') return <div className="stuck-failure" role="alert">{NOT_TAKEN_BACK}</div>;
  if (outcome.kind === 'taken_back') return <div className="stuck-failure" role="alert">{TAKEN_BACK_NOT_LOADED}</div>;
  const { text } = outcome, copy = () => {
    try { void navigator.clipboard.writeText(text).then(() => setCopied('copied'), () => setCopied('failed')); } catch { setCopied('failed'); }
  };
  // Its clicks and keys must not reach a tree row (select, shortcuts).
  return <div className="stuck-held-copy" role="status" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <span>You already started a new message, so it stays as you wrote it. Your earlier message is here to copy:</span>
    <textarea className="stuck-held-text" readOnly aria-label="Your earlier message" value={text} rows={3} />
    <span className="stuck-actions"><button type="button" className="btn btn-secondary dispatch-action" onClick={copy}>
      <i className="ph ph-copy" aria-hidden="true" />{copied === 'copied' ? 'Copied' : 'Copy'}</button>
      {copied === 'failed' && <span>Couldn’t copy. Select the text and copy it yourself.</span>}</span>
  </div>;
}

export function StuckNote({ actions, input, stuck, onEdit, compactActions = false }: StuckNoteProps) {
  const state = useSession(actions.session), operation = useSessionActions(actions), dispatch = useDispatch(actions);
  /** This note wrote last: a failure of that write shows here. */
  const [acted, setActed] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [review, setReview] = useState<{ readonly running: boolean; readonly outcome: ReviewOutcome | null }>({ running: false, outcome: null });
  const runReview = () => {
    if (!onEdit || review.running) return;
    setReview({ running: true, outcome: null });
    void onEdit().then(outcome => setReview({ running: false, outcome }), () => setReview({ running: false, outcome: { kind: 'unavailable' } }));
  };
  const session = state.snapshot?.session;
  const busy = !session || state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const binding = session?.bindings[input.binding_id];
  const presence = binding ? qualifiedPresence(binding, state.presence[binding.id]) : null;
  const attempt = stoppedAttempt(input);
  const waiting = awaitingAnswer(input);
  const received = agentReceived(input.attempts.find(value => value.id === input.active_attempt_id));
  const repair = waiting && attempt?.turn_state === 'completed' && !attempt.domain_result;
  const stopWithoutIdle = skipWithoutIdle(attempt);
  const quiet = (run: () => void) => (event: MouseEvent) => { event.stopPropagation(); run(); };
  const write = (command: OwnerCommand) => {
    if (!session || busy) return;
    setActed(true); void actions.execute(command, session.revision);
  };
  const cancel = () => {
    if (session) write({ command: 'input_cancel', api_version: 1, op_id: '', params: { input_id: input.id, expected_revision: session.revision } });
  };
  // Sending again needs idle evidence; stopping a missing-answer wait sends nothing.
  const resolve = (decision: 'resend' | 'skip' | 'accept_result' | 'request_result_repair') => {
    const needsIdle = decision !== 'accept_result' && !(decision === 'skip' && stopWithoutIdle);
    if (!session || !attempt || needsIdle && presence?.busy) return;
    write(resolveCommand({ input_id: input.id, attempt_id: attempt.id, expected_revision: session.revision,
      decision, reason: '', evidence: !needsIdle || presence?.idle ? null : attestIdle() }));
  };
  const agent = dispatch.agent;
  const working = presence?.busy ? `${agent} is still working. Wait, or stop it in the terminal first.` : null;
  const onItsWay = stuck.kind === 'sent';
  // Before receipt the owner can cancel; queued messages can also be edited or deleted.
  const unsent = input.state === 'queued', canEdit = unsent && !!onEdit && editable(input.kind);
  const icons = compactActions && unsent;
  return <div className="stuck-note" data-stuck={stuck.kind} data-stuck-input={input.id}>
    {!onItsWay && <i className={stuck.kind === 'paused' ? 'ph ph-pause-circle' : stuck.kind === 'decision' || stuck.kind === 'blocked' || stuck.kind === 'held'
      ? 'ph ph-warning-circle' : 'ph ph-hourglass-medium'} aria-hidden="true" />}
    {!onItsWay && <span role="status">{stuck.text}</span>}
    <span className={`stuck-actions${icons ? ' stuck-actions-compact' : ''}`}>
      {canEdit && <button type="button" className={icons ? 'btn btn-ghost btn-icon' : stuck.kind === 'held' ? 'btn btn-secondary dispatch-action' : 'btn btn-ghost dispatch-action'}
        disabled={busy || review.running} aria-label={icons ? 'Edit message' : undefined} title={icons ? 'Edit message' : 'Put it back in your editor to change it; it won’t be sent until you send it again'}
        onClick={quiet(runReview)}>{icons ? <i className="ph ph-pencil-simple" aria-hidden="true" /> : stuck.kind === 'held' ? 'Review and send again' : 'Edit'}</button>}
      {stuck.resume && <button type="button" className="btn btn-secondary dispatch-action" disabled={dispatch.busy}
        onClick={quiet(() => { void dispatch.resume(); })}><i className="ph ph-play" aria-hidden="true" />Resume</button>}
      {waiting && stuck.settle === 'skip' && <button type="button" className="btn btn-primary dispatch-action" disabled={busy || !stopWithoutIdle && !!working}
        title={!stopWithoutIdle && working ? working : (session && keepsLateAnswer(session, input) ? `Stop waiting for an answer. If ${agent} answers later, its answer will still show.` : 'Stop waiting for an answer.')}
        onClick={quiet(() => resolve('skip'))}>Stop waiting</button>}
      {repair && <button type="button" className="btn btn-secondary dispatch-action" disabled={busy || !!working}
        title={`Asks ${agent} to save its answer now. An answer it’s still working on won’t be linked to this message.`}
        onClick={quiet(() => resolve('request_result_repair'))}>Ask for the answer</button>}
      {stuck.retry && <button type="button" className={`btn ${waiting ? 'btn-ghost' : received ? 'btn-primary' : 'btn-secondary'} dispatch-action`} disabled={busy || !!working}
        title={working ?? (presence?.idle ? 'Send it again' : `Send it again. Use this only if ${agent} isn’t working on it now.`)}
        onClick={quiet(() => { if (received && attempt) setResending(attempt.id); else resolve('resend'); })}>{received ? 'Send again' : 'Retry'}</button>}
      {!waiting && stuck.settle === 'skip' && <button type="button" className="btn btn-secondary dispatch-action" disabled={busy || !stopWithoutIdle && !!working}
        title={received ? working ?? 'Stop waiting for an answer.' : working ?? 'Stop trying; the message stays in the history as not delivered'}
        onClick={quiet(() => resolve('skip'))}>{received ? 'Stop waiting' : 'Mark as done'}</button>}
      {stuck.settle === 'accept_result' && <button type="button" className="btn btn-primary dispatch-action" disabled={busy}
        title="The agent saved its answer" onClick={quiet(() => resolve('accept_result'))}>Mark as handled</button>}
      {unsent ? <button type="button" className={icons ? 'btn btn-ghost btn-icon' : 'btn btn-ghost dispatch-action'} disabled={busy} aria-label={icons ? 'Delete message' : undefined} title={icons ? 'Delete message' : 'Delete this message; it won’t be sent'}
        onClick={quiet(cancel)}><i className="ph ph-trash" aria-hidden="true" />{!icons && 'Delete'}</button>
        : !received && <button type="button" className="btn btn-ghost dispatch-action" disabled={busy} title="Cancel this message; it won’t be sent"
          onClick={quiet(cancel)}>Cancel message</button>}
      {attempt && <button type="button" className="btn btn-ghost dispatch-action" disabled={busy}
        onClick={quiet(() => setAdvanced(true))}>More options</button>}
    </span>
    {review.outcome && <ReviewResult outcome={review.outcome} />}
    {/* An Edit whose take-back is unconfirmed holds the session's writes: its "Check again" shows here too. */}
    {(acted || review.outcome?.kind === 'not_taken_back' && operation.pending?.command.command === 'input_cancel') && !advanced && <div className="stuck-failure" onClick={event => event.stopPropagation()}><ActionFailure actions={actions} /></div>}
    {/* Out of the row's layout; its clicks and keys must not reach the row (select, tree shortcuts). */}
    {advanced && attempt && createPortal(<div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <RecoveryReview actions={actions} inputId={input.id} attemptId={attempt.id} onClose={() => setAdvanced(false)} /></div>, document.body)}
    {resending && createPortal(<div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <ConfirmDialog title="Send again?" body={`${agent} already has this message. Send it again anyway?`} confirmLabel="Send again"
        busy={busy || !!working || !received || attempt?.id !== resending} onCancel={() => setResending(null)}
        onConfirm={() => { resolve('resend'); setResending(null); }} /></div>, document.body)}
  </div>;
}
