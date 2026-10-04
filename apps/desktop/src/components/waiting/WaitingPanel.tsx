import { useEffect } from 'react';
import type { ItemRoute, SessionRef } from '../../generated/core';
import { CoreFailure } from '../../data';
import { GlobalWaitingPanel, type DeliveryLabel } from '../reference/GlobalWaitingPanel';
import type { AnswerControlProps } from '../reference/AnswerControl';
import { deliveryEvidence, type DeliveryEvidence } from '../../selectors/waiting/delivery';
import { useWaiting, type WaitingStore } from '../../selectors/waiting/store';
import type { WaitingRow } from '../../selectors/waiting/rows';

export interface WaitingPanelProps {
  readonly store: WaitingStore;
  readonly revealItem: (route: ItemRoute) => void;
  readonly openSession: (route: SessionRef) => void;
  readonly answerControl?: (row: WaitingRow) => AnswerControlProps;
}
function deliveryLabel(evidence: DeliveryEvidence): DeliveryLabel {
  const warning = ['uncertain', 'rejected', 'failed', 'missing', 'unavailable'].includes(evidence.kind);
  return { text: evidence.label, icon: warning ? 'ph ph-warning' : 'ph ph-clock',
    color: warning ? 'var(--a-warn)' : 'color-mix(in srgb, var(--color-text) 64%, transparent)' };
}
// The composition owns this store and the actual answer/draft control. This
// read module neither simulates submissions nor creates inert answer controls.
export function WaitingPanel({ store, revealItem, openSession, answerControl }: WaitingPanelProps) {
  const state = useWaiting(store);
  useEffect(() => { void store.start(); }, [store]);
  const incomplete = state.counts?.completeness === 'partial' || state.unavailableProjects.length > 0;
  const current = state.status === 'ready';
  const sentCounts = state.counts?.sent_inputs;
  const notice = <>
    {state.status === 'stale' && <p className="ref-warning" role="status">Showing the last complete queue read. Refresh is pending.</p>}
    {state.error && <div className="ref-warning" role="alert"><p>{state.error.message}</p>
      {state.error instanceof CoreFailure && <p>{state.error.error.hint}</p>}
      <button type="button" className="ref-button ref-secondary" onClick={() => { void store.refresh(); }}>Refresh queue</button></div>}
    {incomplete && <div className="ref-warning" role="status">Queue counts are incomplete. Unavailable registered data is not counted as empty.
      {state.unavailableProjects.map(project => <p key={project.project_id}>{project.project?.display_name ?? 'Unavailable project'} · {project.canonical_root}</p>)}
      {state.counts?.unavailable_session_ids.map(id => <p key={id}>Unavailable session {id}</p>)}</div>}
  </>;
  const cards = state.waiting.map(row => ({
    id: row.id, question: row.item.question, path: `${row.projectLabel} / ${row.sessionLabel} / ${row.item.id}`,
    ask: row.item.ask ?? undefined,
    earlier: row.item.origin ? 'Continued from an earlier session. Details preserve the source history.' : undefined,
    previousRound: row.item.current_round_id ? `Question revision ${row.item.question_revision}` : undefined,
    age: `since ${row.item.waiting_since}`, messageTag: `#${row.askedMessageNumber}`, ring: 'none',
    onOpen: () => revealItem({ ...row.route }),
  }));
  const editable = current && !state.error && answerControl;
  return <GlobalWaitingPanel count={state.counts ? `${state.counts.waiting_unanswered}${incomplete ? ' · incomplete' : ''}` : '—'}
    loading={state.status === 'loading'} notice={notice}
    emptyHeading={!current ? 'Queue is unavailable or stale' : incomplete ? 'No waiting questions in available sessions' : 'Nothing waiting on you'}
    emptyIcon={current && !incomplete ? 'ph ph-check-circle' : 'ph ph-warning'}
    emptyText={current && !incomplete ? 'All registered sessions are up to date.' : 'Refresh or restore access to see the complete queue.'}
    sentCaption={sentCounts ? `${sentCounts.queued} queued · ${sentCounts.in_flight} in flight · ${sentCounts.needs_attention} need attention` : 'delivery unavailable'}
    waiting={editable ? cards.map((card, index) => ({ ...card, answer: editable(state.waiting[index]) })) : []}
    readOnlyWaiting={editable ? [] : cards} sent={state.sent.map(row => {
      const summary = state.sessions.find(session => session.session.id === row.session.session_id)?.summary;
      const evidence = deliveryEvidence(row.input, summary?.active_binding ?? null);
      const target = row.input.payload.target_snapshot;
      const option = target.options.find(option => option.id === row.input.payload.selected_option_id);
      return { id: row.id, question: target.item_question ?? target.topic_name, delivery: deliveryLabel(evidence),
        onOpen: () => { if (row.route) revealItem({ ...row.route }); else openSession({ ...row.session }); },
        detail: <div className="ref-waiting-context"><div>
          <p>{row.projectLabel} / {row.sessionLabel} · {row.input.kind}</p>
          <p>{evidence.detail}</p>
          {target.ask && <p>{target.ask}</p>}
          {option && <p>Saved choice: {option.label} · {option.consequence}</p>}
          {row.input.payload.text && <p style={{ whiteSpace: 'pre-wrap' }}>{row.input.payload.text}</p>}
          {row.changedQuestion && <p>The current question changed. This input retains question revision {target.question_revision} and its saved options.</p>}
        </div></div> };
    })} />;
}
