import { useState } from 'react';
import { useSession, type Immutable } from '../../data';
import type { Attempt, Input, ResolutionKind, Session, TurnState } from '../../generated/domain/models';
import { Dialog } from '../../ui/dialogs/Dialog';
import { ActionFailure } from '../edge-states/EdgeState';
import { SessionActions, useSessionActions } from '../bindings/actions';
import { qualifiedPresence } from '../bindings/presence';
import '../bindings/controls.css';

const labels: Record<ResolutionKind, string> = { retry_unexecuted: 'Prepare retry', resend: 'Prepare resend',
  request_result_repair: 'Request missing result', skip: 'Skip and continue', confirm_evidence: 'Confirm evidence' };
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
  const result: ResolutionKind[] = ['resend', 'skip', 'confirm_evidence'];
  const conflict = Object.values(session.operation_receipts).some(bucket => bucket?.some(receipt =>
    receipt.actor_scope.kind === 'adapter' && receipt.actor_scope.binding_id === input.binding_id
    && receipt.result.data.kind === 'event_conflict' && receipt.result.data.input_id === input.id && receipt.result.data.attempt_id === attempt.id));
  if (!conflict && attempt.acceptance === 'rejected' && !attempt.acceptance_receipt && !attempt.host_turn_id
      && attempt.turn_state === 'unknown' && !attempt.domain_result) result.unshift('retry_unexecuted');
  if (attempt.turn_state === 'completed' && !attempt.domain_result && attempt.result_state !== 'committed') result.unshift('request_result_repair');
  return result;
}
export function RecoveryPanel({ actions }: { actions: SessionActions }) {
  const state = useSession(actions.session), operation = useSessionActions(actions);
  const [selected, setSelected] = useState<{ inputId: string; attemptId: string; revision: number } | null>(null);
  const [decision, setDecision] = useState<ResolutionKind | ''>('');
  const [reason, setReason] = useState('');
  const [idle, setIdle] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [turn, setTurn] = useState<TurnState>('unknown');
  const [hostTurn, setHostTurn] = useState('');
  const snapshot = state.snapshot?.session;
  if (!snapshot) return null;
  const targets = recoveryTargets(snapshot);
  const target = selected ? targets.find(target => target.input.id === selected.inputId && target.attempt.id === selected.attemptId) : null;
  const binding = snapshot.active_binding_id ? snapshot.bindings[snapshot.active_binding_id] : null;
  const presence = binding ? qualifiedPresence(binding, state.presence[binding.id]) : null;
  const disabled = state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const changed = !!selected && (selected.revision !== snapshot.revision || !target);
  const submit = async () => {
    if (!selected || !target || !decision || changed || !reason.trim() || presence?.busy
        || !presence?.idle && !idle || decision === 'resend' && !duplicate) return;
    const evidence = decision === 'confirm_evidence' || idle ? { source: 'owner_attestation' as const, turn_state: turn,
      host_turn_id: hostTurn || null, owner_attested_idle: idle, at: new Date().toISOString() } : null;
    if (await actions.execute({ command: 'input_resolve', api_version: 1, op_id: '', params: {
      input_id: target.input.id, attempt_id: target.attempt.id, expected_revision: selected.revision, decision, reason, evidence,
    } }, selected.revision)) setSelected(null);
  };
  return <section className="lifecycle-recovery" aria-label="Delivery recovery">
    {!selected && <ActionFailure actions={actions} />}
    {targets.length > 0 && <><h3>Delivery needs attention</h3><p>Inspect the exact input, prior replies and effects. Recovery never sends or resumes automatically.</p></>}
    {targets.map(({ input, attempt }) => <article className="lifecycle-recovery-row" key={`${input.id}/${attempt.id}`} data-input-id={input.id} data-attempt-id={attempt.id}>
      <div><strong>{input.payload.target_snapshot.item_question ?? input.payload.target_snapshot.topic_name}</strong>
        <p>Input {input.seq} · {input.kind} · {attempt.acceptance === 'uncertain' ? 'Delivery uncertain' : attempt.result_state === 'missing' ? 'Missing result' : input.state}
          {' · '}host turn {attempt.turn_state} · {attempt.purpose.replace(/_/g, ' ')}</p></div>
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => {
        setSelected({ inputId: input.id, attemptId: attempt.id, revision: snapshot.revision });
        setDecision(''); setReason(''); setIdle(false); setDuplicate(false); setTurn('unknown'); setHostTurn('');
      }}>Review recovery</button>
    </article>)}
    {operation.receipt && 'data' in operation.receipt && operation.receipt.data.kind === 'input_resolve'
      && <p role="status">Recovery decision saved. Inspect the refreshed queue. Resume dispatch is a separate explicit action.</p>}
    {selected && <Dialog label="Resolve delivery" width={620} onCancel={() => { if (!operation.writing) setSelected(null); }}>
      <div className="dialog-title">Resolve delivery</div>
      <div className="lifecycle-dialog">
        <ActionFailure actions={actions} />
        <p>{snapshot.title} · {binding?.external_session_id} · generation <code>{binding?.generation}</code></p>
        <p>Input <code>{selected.inputId}</code> · attempt <code>{selected.attemptId}</code></p>
        {changed && <div role="alert"><p>The session or attempt changed. Review the current evidence before a new decision.</p>
          {target && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => {
            setSelected({ ...selected, revision: snapshot.revision }); setDecision(''); setIdle(false); setDuplicate(false);
          }}>Review current snapshot</button>}</div>}
        {target && <><p className="lifecycle-preserve">{target.input.payload.text}</p>
          {target.input.payload.selected_option_id && <p>Saved choice: {target.input.payload.target_snapshot.options.find(option => option.id === target.input.payload.selected_option_id)?.label ?? target.input.payload.selected_option_id}</p>}
          <p>Delivery {target.attempt.acceptance} · turn {target.attempt.turn_state} · result {target.attempt.result_state}</p>
          <p>Prior result: {target.attempt.domain_result?.explanation ?? 'No committed explicit result for this attempt.'}</p>
          {target.attempt.domain_result && <p>Prior reply references: {target.attempt.domain_result.reply_message_ids.join(', ') || 'none'}
            {' · '}follow-up items: {target.attempt.domain_result.followup_item_ids.join(', ') || 'none'}</p>}
          <details><summary tabIndex={0}>Earlier attempts and effects</summary>{target.input.attempts.map(attempt => <div key={attempt.id}>
            <p><code>{attempt.id}</code> · {attempt.purpose} · {attempt.turn_state} · {attempt.result_state}</p>
            {attempt.domain_result && <><p>{attempt.domain_result.explanation}</p><p>Replies: {attempt.domain_result.reply_message_ids.join(', ') || 'none'}
              {' · '}follow-up items: {attempt.domain_result.followup_item_ids.join(', ') || 'none'}</p></>}
          </div>)}</details>
          {target.input.resolution_history.map(entry => <p key={entry.op_id}>{labels[entry.kind]} · {entry.reason} · {entry.at}</p>)}
          <label>Recovery choice<select tabIndex={0} value={decision} disabled={operation.writing || !!operation.pending} onChange={event => { setDecision(event.target.value as ResolutionKind | ''); setDuplicate(false); }}>
            <option value="">Choose deliberately</option>{choices(target.input, target.attempt, snapshot).map(choice => <option key={choice} value={choice}>{labels[choice]}</option>)}
          </select></label>
          <label>Reason<input value={reason} required disabled={operation.writing || !!operation.pending} onChange={event => setReason(event.target.value)} /></label>
          {decision === 'request_result_repair' && <p>Request a new result-only model turn that inspects completed work. It can still make mistakes. Review prior effects before resuming.</p>}
          {decision === 'skip' && <p>This records Skipped, preserving prior results and replies. It does not mark the input Handled.</p>}
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
        <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={() => setSelected(null)}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={disabled || changed || !decision || !reason.trim()
          || !!presence?.busy || !presence?.idle && !idle || decision === 'resend' && !duplicate}
          onClick={() => { void submit(); }}>Save recovery decision</button>
      </div></Dialog>}
  </section>;
}
