// A message whose delivery needs the owner's decision, in plain words.
// - The agent saved its answer: one button marks the message handled.
// - Otherwise one question with two answers: Send again, or Mark as done.
// The detailed audited form (RecoveryReview) stays behind "Advanced". No
// internal ids reach the owner. A decision whose row is visible is answered on
// that row (ui/answer/StuckNote); this banner lists only the rest and is gone
// once nothing is left. Once saved, sending resumes by itself.
import { createContext, useContext, useState } from 'react';
import { useSession, type Immutable } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import type { Attempt, Input, ResolutionKind, Session, TurnState } from '../../generated/domain/models';
import { Dialog } from '../../ui/dialogs/Dialog';
import { agentName } from '../../ui/shell/model';
import { ActionFailure } from '../edge-states/EdgeState';
import { SessionActions, useSessionActions } from '../bindings/actions';
import { qualifiedPresence } from '../bindings/presence';
import { inputAbout, recoveryProblem, stoppedAttempt } from '../../selectors/waiting/stuck';
import { targetRemoved } from '../../selectors/removed';
import '../bindings/controls.css';

export function resolveCommand(params: { input_id: string; attempt_id: string; expected_revision: number; decision: ResolutionKind;
  reason: string; evidence: Extract<OwnerCommand, { command: 'input_resolve' }>['params']['evidence'] }): OwnerCommand {
  return { command: 'input_resolve', api_version: 1, op_id: '', params };
}

const labels: Record<ResolutionKind, string> = { retry_unexecuted: 'Prepare retry', resend: 'Send again',
  request_result_repair: 'Request missing result', skip: 'Mark as done', confirm_evidence: 'Confirm evidence', accept_result: 'Mark as handled' };
const binnedMessage = 'This work is in the bin. Restore it first, or mark the message done.';
export function recoveryTargets(session: Immutable<Session>) {
  const targets: { input: Immutable<Input>; attempt: Immutable<Attempt> }[] = [];
  Object.values(session.inputs).forEach(input => {
    if (!input || input.binding_id !== session.active_binding_id) return;
    const conflicts = Object.values(session.operation_receipts).flatMap(bucket => bucket ?? []).filter(receipt =>
      receipt.actor_scope.kind === 'adapter' && receipt.actor_scope.binding_id === input.binding_id
      && receipt.result.data.kind === 'event_conflict' && receipt.result.data.input_id === input.id);
    input.attempts.forEach(attempt => {
      const historicalConflict = conflicts.some(receipt => receipt.result.data.kind === 'event_conflict'
        && receipt.result.data.attempt_id === attempt.id && !input.resolution_history.some(entry =>
          entry.attempt_id === attempt.id && (session.operation_receipts[entry.op_id] ?? []).some(ownerReceipt =>
            ownerReceipt.actor_scope.kind === 'owner' && ownerReceipt.result.revision > receipt.result.revision
            && ownerReceipt.result.data.kind === 'input_resolve' && ownerReceipt.result.data.input_id === input.id
            && ownerReceipt.result.data.attempt_id === attempt.id && ownerReceipt.result.data.resolution_kind === entry.kind)));
      if (historicalConflict || input.active_attempt_id === attempt.id && input.state === 'needs_attention') targets.push({ input, attempt });
    });
  });
  return targets.sort((a, b) => a.input.seq - b.input.seq);
}
function choices(input: Immutable<Input>, attempt: Immutable<Attempt>, session: Immutable<Session>) {
  if (input.active_attempt_id !== attempt.id || attempt.sealed_at !== null) return ['confirm_evidence'] as const;
  const binned = targetRemoved(session, input.target);
  const result: ResolutionKind[] = binned ? ['skip', 'confirm_evidence'] : ['resend', 'skip', 'confirm_evidence'];
  const conflict = Object.values(session.operation_receipts).some(bucket => bucket?.some(receipt =>
    receipt.actor_scope.kind === 'adapter' && receipt.actor_scope.binding_id === input.binding_id
    && receipt.result.data.kind === 'event_conflict' && receipt.result.data.input_id === input.id && receipt.result.data.attempt_id === attempt.id));
  if (!binned && !conflict && attempt.acceptance === 'rejected' && !attempt.acceptance_receipt && !attempt.host_turn_id
      && attempt.turn_state === 'unknown' && !attempt.domain_result) result.unshift('retry_unexecuted');
  if (attempt.turn_state === 'completed' && !attempt.domain_result && attempt.result_state !== 'committed') result.unshift('request_result_repair');
  return result;
}

/** The owner's word, when there is no machine evidence of it, that the agent isn't working on the message now. */
export const attestIdle = (attested = true) => ({ source: 'owner_attestation' as const, turn_state: 'unknown' as const,
  host_turn_id: null, owner_attested_idle: attested, at: new Date().toISOString() });

/**
 * Input ids whose stopped delivery is answered inline on a visible row (the
 * session tree provides it). The banner leaves those out; without a provider it
 * lists every target.
 */
export const InlineRecovery = createContext<ReadonlySet<string> | null>(null);
/** A target the inline fix answers: the current decision on a message whose row shows it. */
const inline = (shown: ReadonlySet<string> | null, input: Immutable<Input>, attempt: Immutable<Attempt>) =>
  !!shown?.has(input.id) && stoppedAttempt(input)?.id === attempt.id;

export function RecoveryPanel({ actions }: { actions: SessionActions }) {
  const state = useSession(actions.session), operation = useSessionActions(actions), shown = useContext(InlineRecovery);
  const [selected, setSelected] = useState<{ inputId: string; attemptId: string } | null>(null);
  /** The simple path's attestation, per message: the owner checked the agent isn't working on it. */
  const [checked, setChecked] = useState<string | null>(null);
  const snapshot = state.snapshot?.session;
  if (!snapshot) return null;
  const targets = recoveryTargets(snapshot).filter(({ input, attempt }) => !inline(shown, input, attempt));
  // Everything that needs a decision is on a visible row: no banner.
  if (!targets.length && !selected) return null;
  const binding = snapshot.active_binding_id ? snapshot.bindings[snapshot.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const presence = binding ? qualifiedPresence(binding, state.presence[binding.id]) : null;
  const disabled = state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  /** Mark as handled / Send again / Mark as done: reason may be empty; evidence only when liveness is unknown. */
  const quick = (input: Immutable<Input>, attempt: Immutable<Attempt>, kind: 'accept_result' | 'resend' | 'skip') => {
    if (disabled || kind === 'resend' && targetRemoved(snapshot, input.target)) return;
    const evidence = kind === 'accept_result' || presence?.idle ? null : attestIdle();
    void actions.execute(resolveCommand({ input_id: input.id, attempt_id: attempt.id, expected_revision: snapshot.revision,
      decision: kind, reason: '', evidence }), snapshot.revision);
  };
  const about = inputAbout;
  return <section className="lifecycle-recovery" aria-label="Delivery recovery">
    {!selected && <ActionFailure actions={actions} />}
    {targets.length > 0 && <h3>{targets.length === 1 ? 'A message needs your decision' : `${targets.length} messages need your decision`}</h3>}
    {targets.map(({ input, attempt }) => {
      const current = input.active_attempt_id === attempt.id && attempt.sealed_at === null && input.state === 'needs_attention';
      const committed = current && attempt.result_state === 'committed';
      const binned = targetRemoved(snapshot, input.target);
      // Without machine evidence that the agent is idle, Send again / Mark as done need the owner's word.
      const needsCheck = current && !committed && !presence?.idle;
      const ready = !disabled && !(current && !committed && presence?.busy) && (!needsCheck || checked === input.id);
      return <article className="lifecycle-recovery-row" key={`${input.id}/${attempt.id}`} data-input-id={input.id} data-attempt-id={attempt.id}>
        <div className="recovery-text"><strong>Your message on “{about(input)}”</strong>
          <p>{recoveryProblem(attempt, agent)}{current && !committed && !binned ? ' Send it again, or mark it done?' : ''}</p>
          {binned && <p>{binnedMessage}</p>}
          {current && !committed && presence?.busy && <p role="alert">{agent} is still working. Wait, or stop it in the terminal first.</p>}
          {needsCheck && !presence?.busy && <label className="recovery-check"><input type="checkbox" disabled={disabled} checked={checked === input.id}
            onChange={event => setChecked(event.target.checked ? input.id : null)} />I checked: {agent} isn’t working on this now.</label>}</div>
        <div className="recovery-actions">
          {committed && <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => quick(input, attempt, 'accept_result')}>
            Mark as handled — the agent saved its answer</button>}
          {current && !committed && <>
            {!binned && <button type="button" className="btn btn-primary" disabled={!ready} title="Sending again may repeat work the agent already did."
              onClick={() => quick(input, attempt, 'resend')}>Send again</button>}
            <button type="button" className="btn btn-secondary" disabled={!ready} onClick={() => quick(input, attempt, 'skip')}>Mark as done</button></>}
          <details className="recovery-advanced"><summary>Advanced</summary>
            <button type="button" className="btn btn-ghost" disabled={disabled}
              onClick={() => setSelected({ inputId: input.id, attemptId: attempt.id })}>Review recovery</button></details>
        </div>
      </article>;
    })}
    {operation.receipt && 'data' in operation.receipt && operation.receipt.data.kind === 'input_resolve'
      && <p role="status">Saved. Sending resumes by itself once nothing else needs your decision.</p>}
    {selected && <RecoveryReview actions={actions} inputId={selected.inputId} attemptId={selected.attemptId} onClose={() => setSelected(null)} />}
  </section>;
}

export interface RecoveryReviewProps {
  readonly actions: SessionActions;
  readonly inputId: string;
  readonly attemptId: string;
  readonly onClose: () => void;
}

/** The audited form for one stopped delivery: every choice, a reason, and the owner's evidence. */
export function RecoveryReview({ actions, inputId, attemptId, onClose }: RecoveryReviewProps) {
  const state = useSession(actions.session), operation = useSessionActions(actions);
  // The decision is made against the session as it was when the form opened.
  const [revision, setRevision] = useState(() => state.snapshot?.session.revision ?? -1);
  const [decision, setDecision] = useState<ResolutionKind | ''>('');
  const [reason, setReason] = useState('');
  const [idle, setIdle] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [turn, setTurn] = useState<TurnState>('unknown');
  const [hostTurn, setHostTurn] = useState('');
  const snapshot = state.snapshot?.session;
  if (!snapshot) return null;
  const target = recoveryTargets(snapshot).find(target => target.input.id === inputId && target.attempt.id === attemptId) ?? null;
  const binding = snapshot.active_binding_id ? snapshot.bindings[snapshot.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const presence = binding ? qualifiedPresence(binding, state.presence[binding.id]) : null;
  const disabled = state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const changed = revision !== snapshot.revision || !target;
  const available = target ? choices(target.input, target.attempt, snapshot) : [];
  const allowed = !!decision && available.some(choice => choice === decision);
  const close = () => { if (!operation.writing) onClose(); };
  const submit = async () => {
    if (!target || !decision || !allowed || changed || !reason.trim() || presence?.busy
        || !presence?.idle && !idle || decision === 'resend' && !duplicate) return;
    const evidence = decision === 'confirm_evidence' || idle ? { ...attestIdle(idle), turn_state: turn, host_turn_id: hostTurn || null } : null;
    if (await actions.execute(resolveCommand({ input_id: target.input.id, attempt_id: target.attempt.id, expected_revision: revision,
      decision, reason, evidence }), revision)) onClose();
  };
  const about = inputAbout;
  return <Dialog label="Resolve delivery" width={620} onCancel={close}>
      <div className="dialog-title">Resolve delivery</div>
      <div className="lifecycle-dialog">
        <ActionFailure actions={actions} />
        <p>{snapshot.title} · {agent}</p>
        {changed && <div role="alert"><p>The session or attempt changed. Review the current evidence before a new decision.</p>
          {target && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => {
            setRevision(snapshot.revision); setDecision(''); setIdle(false); setDuplicate(false);
          }}>Review current snapshot</button>}</div>}
        {target && <><p><strong>Your message on “{about(target.input)}”</strong></p>
          {targetRemoved(snapshot, target.input.target) && <p>{binnedMessage}</p>}
          <p className="lifecycle-preserve">{target.input.payload.text}</p>
          {target.input.payload.selected_option_id && <p>Saved choice: {target.input.payload.target_snapshot.options.find(option => option.id === target.input.payload.selected_option_id)?.label ?? 'an option that no longer exists'}</p>}
          <p>Delivery {target.attempt.acceptance} · turn {target.attempt.turn_state} · result {target.attempt.result_state}</p>
          <p>Prior result: {target.attempt.domain_result?.explanation ?? 'No committed explicit result for this attempt.'}</p>
          {target.attempt.domain_result && <p>Replies: {target.attempt.domain_result.reply_message_ids.length || 'none'}
            {' · '}follow-up items: {target.attempt.domain_result.followup_item_ids.join(', ') || 'none'}</p>}
          <details><summary tabIndex={0}>Earlier attempts and effects</summary>{target.input.attempts.map((attempt, index) => <div key={attempt.id}>
            <p>Attempt {index + 1} · {attempt.purpose.replace(/_/g, ' ')} · {attempt.turn_state} · {attempt.result_state}</p>
            {attempt.domain_result && <><p>{attempt.domain_result.explanation}</p><p>Replies: {attempt.domain_result.reply_message_ids.length || 'none'}
              {' · '}follow-up items: {attempt.domain_result.followup_item_ids.join(', ') || 'none'}</p></>}
          </div>)}</details>
          {target.input.resolution_history.map(entry => <p key={entry.op_id}>{labels[entry.kind]} · {entry.reason || 'no reason given'} · {entry.at}</p>)}
          <label>Recovery choice<select tabIndex={0} value={decision} disabled={operation.writing || !!operation.pending} onChange={event => { setDecision(event.target.value as ResolutionKind | ''); setDuplicate(false); }}>
            <option value="">Choose deliberately</option>{available.map(choice => <option key={choice} value={choice}>{labels[choice]}</option>)}
          </select></label>
          <label>Reason<input value={reason} required disabled={operation.writing || !!operation.pending} onChange={event => setReason(event.target.value)} /></label>
          {decision === 'request_result_repair' && <p>Request a new result-only model turn that inspects completed work. It can still make mistakes. Review prior effects before resuming.</p>}
          {decision === 'skip' && <p>This records Skipped, preserving prior results and replies. It does not mark the message as handled.</p>}
          {decision === 'resend' && <><p className="pw-dialog-warn" role="alert">Resending may repeat work and side effects. Ariadne cannot guarantee exactly-once host execution after a lost acknowledgement.</p>
            <label><input type="checkbox" disabled={operation.writing || !!operation.pending} checked={duplicate} onChange={event => setDuplicate(event.target.checked)} />I reviewed the duplicate-work risk.</label></>}
          {decision === 'confirm_evidence' && <><p>Record attributed owner evidence. This does not create an agent result or successful host completion.</p>
            <label>Observed outcome<select tabIndex={0} value={turn} disabled={operation.writing || !!operation.pending} onChange={event => setTurn(event.target.value as TurnState)}>
              {(['unknown', 'running', 'completed', 'failed', 'interrupted'] as const).map(value => <option key={value}>{value}</option>)}</select></label>
            <label>Known host turn (optional)<input value={hostTurn} disabled={operation.writing || !!operation.pending} onChange={event => setHostTurn(event.target.value)} /></label></>}
          <p>{presence?.label ?? 'Host state unknown'}</p>
          {presence?.busy ? <p role="alert">The host is running or waiting for approval. Interrupt it in the terminal before recovery.</p>
            : !presence?.idle && <label><input type="checkbox" disabled={operation.writing || !!operation.pending} checked={idle} onChange={event => setIdle(event.target.checked)} />I confirm the terminal is stopped or idle now. This is my attestation, not machine evidence.</label>}
        </>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={disabled || changed || !allowed || !reason.trim()
          || !!presence?.busy || !presence?.idle && !idle || decision === 'resend' && !duplicate}
          onClick={() => { void submit(); }}>Save recovery decision</button>
      </div></Dialog>;
}
