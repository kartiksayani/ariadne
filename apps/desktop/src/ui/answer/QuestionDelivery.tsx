import { useMemo, useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { sessionActionsFor, useSessionActions } from '../../components/bindings/actions';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { deliveryEvidence } from '../../selectors/waiting/delivery';
import { agentReceived, stuckInput } from '../../selectors/waiting/stuck';
import { copyText } from '../shared/clipboard';
import { editQueued } from './held';
import { ReviewResult, StuckNote } from './StuckNote';
import type { ReviewOutcome } from './held';

/** Shared saved-answer view. Undo is an atomic take-back, never abandonment of outbound words. */
export function QuestionDelivery({ drafts, store, itemId, inputId }: {
  readonly drafts: OwnerDraftStore; readonly store: SessionStore; readonly itemId: string; readonly inputId?: string;
}) {
  useOwnerDrafts(drafts);
  const state = useSession(store), session = state.snapshot?.session;
  const actions = useMemo(() => sessionActionsFor(drafts.service, store), [drafts, store]);
  const operation = useSessionActions(actions);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null), [busy, setBusy] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const entry = drafts.find(state.route, itemId, 'answer');
  const receiptId = entry?.receipt?.data.kind === 'input_submit' ? entry.receipt.data.input_id : null;
  const input = inputId ? session?.inputs[inputId] : (receiptId ? session?.inputs[receiptId] : null)
    ?? Object.values(session?.inputs ?? {}).filter(value => value && ['answer', 'reply', 'note', 'followup', 'drop'].includes(value.kind) && value.target.item_id === itemId
      && value.payload.target_snapshot.question_revision === session?.items[itemId]?.question_revision
      && !['cancelled', 'skipped'].includes(value.state)).sort((a, b) => b!.seq - a!.seq)[0];
  const binding = input ? session?.bindings[input.binding_id] ?? null : null;
  const presence = binding ? state.presence[binding.id] ?? null : null;
  const evidence = input ? deliveryEvidence(input, binding ? { ...binding, presence } : null, session?.operation_receipts, presence) : null;
  const attempt = input?.attempts.find(value => value.id === input.active_attempt_id);
  const received = input?.state === 'handled' || agentReceived(attempt);
  const content = input?.payload ?? (!inputId || receiptId === inputId ? entry?.sent : null);
  const option = input?.payload.target_snapshot.options.find(value => value.id === content?.selected_option_id)
    ?? session?.items[itemId]?.options.find(value => value.id === content?.selected_option_id);
  const words = [option?.label, content?.text].filter(Boolean).join('\n\n');
  const queued = evidence?.kind === 'queued';
  const failed = evidence?.kind === 'failed' || evidence?.kind === 'rejected';
  const checking = evidence?.kind === 'uncertain' || evidence?.kind === 'unavailable';
  const stuck = failed && !received && input && session ? stuckInput(session, input, presence) : null;
  const undo = async () => {
    if (busy || !input || input.state !== 'queued') return;
    setBusy(true);
    try { setOutcome(await editQueued(drafts, session, input, actions)); }
    finally { setBusy(false); }
  };
  return <div className="question-delivery">
    <p role="status">{checking ? 'Checking delivery. Your answer is kept.' : failed ? 'Not sent. Your answer is kept.'
      : received ? 'Picked up by the agent.' : queued ? 'Queued · delivers when this session’s agent is running.' : 'Sent · waiting for the agent to pick it up.'}</p>
    {words && <p className="question-sent-words">{words}</p>}
    <button type="button" className="btn btn-secondary" onClick={() => { void copyText(words).catch(() => setCopyFailed(true)); }}>Copy answer</button>
    {copyFailed && <textarea aria-label="Copy your answer" readOnly value={words} />}
    {input?.state === 'queued' && !received && <button type="button" className="btn btn-secondary" disabled={busy || operation.writing || !!operation.pending || state.status !== 'ready'}
      onClick={() => { void undo(); }}>Undo</button>}
    {checking && <button type="button" className="btn btn-secondary" onClick={() => { void store.refresh(); }}>Check delivery</button>}
    {stuck && input && <StuckNote actions={actions} input={input} stuck={stuck} />}
    {outcome && <ReviewResult outcome={outcome} />}
  </div>;
}
