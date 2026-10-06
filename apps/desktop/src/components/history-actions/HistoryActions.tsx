import { useState } from 'react';
import { CoreFailure, useSession, type ServiceFailure } from '../../data';
import type { ItemRoute, OwnerCommand, SessionRef } from '../../generated/core';
import { SessionActions, useSessionActions } from '../bindings/actions';
import { ReferenceDialog } from '../reference/ReferenceDialog';
import { ContinueDialog, type ContinueTarget } from './ContinueDialog';
import { dispatchQuiesced, lifecycleBlockers } from './selectors';
import './history-actions.css';

type Lifecycle = 'topic_archive' | 'topic_restore' | 'session_close' | 'session_reopen';
interface Review { kind: Lifecycle; topicId: string | null; revision: number; sessionRevision: number; error: CoreFailure | ServiceFailure | null }
export function HistoryActions({ actions, targets, actionsForTarget, revealItem, openSession }: {
  actions: SessionActions; targets: readonly ContinueTarget[]; actionsForTarget: (route: SessionRef) => SessionActions;
  revealItem: (route: ItemRoute) => void; openSession: (route: SessionRef) => void;
}) {
  const state = useSession(actions.session), operation = useSessionActions(actions);
  const [review, setReview] = useState<Review | null>(null);
  const [pauseReview, setPauseReview] = useState(false);
  const [continuing, setContinuing] = useState<string | null>(null);
  const session = state.snapshot?.session;
  if (!session) return null;
  const route = { project_id: session.project_id, session_id: session.id };
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const disabled = state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const changing = review && review.sessionRevision !== session.revision;
  const guarded = review?.kind === 'topic_archive' || review?.kind === 'session_close';
  const error = review?.error instanceof CoreFailure ? review.error.error : undefined;
  const blockers = review && guarded ? lifecycleBlockers(session, review.topicId, error) : [];
  const mustPause = review?.kind === 'session_close' && !dispatchQuiesced(binding);
  const alreadyStopped = review?.kind === 'session_close' && !!binding && binding.dispatch_state !== 'paused' && dispatchQuiesced(binding);
  const historyPending = operation.pending?.command.command.startsWith('topic_') || operation.pending?.command.command.startsWith('session_');
  const historyReceipt = operation.receipt && 'data' in operation.receipt && ['topic_lifecycle', 'session_lifecycle', 'continuation'].includes(operation.receipt.data.kind);
  const label = review?.kind.replace(/_/g, ' ') ?? '';
  const resetReview = () => { setReview(null); setPauseReview(false); };
  const prepare = (kind: Lifecycle, topicId: string | null = null) => setReview({ kind, topicId,
    revision: topicId ? session.topics[topicId]!.revision : session.revision, sessionRevision: session.revision, error: null });
  const recordFailure = (attempted: Review, previousError: typeof operation.error) => {
    const error = actions.getSnapshot().error;
    if (error !== previousError) setReview(current => current === attempted ? { ...current, error } : current);
  };
  const confirm = async () => {
    if (!review || disabled || changing || blockers.length || mustPause) return;
    const command: OwnerCommand = review.kind === 'topic_archive' || review.kind === 'topic_restore'
      ? { command: review.kind, api_version: 1, op_id: '', params: { topic_id: review.topicId!, expected_revision: review.revision } }
      : { command: review.kind, api_version: 1, op_id: '', params: { expected_revision: review.revision } };
    const previousError = actions.getSnapshot().error;
    if (await actions.execute(command, review.sessionRevision)) resetReview();
    else recordFailure(review, previousError);
  };
  const pause = async () => {
    if (!review || !binding || disabled || changing) return;
    const previousError = actions.getSnapshot().error;
    if (await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '', params: {
      binding_id: binding.id, expected_generation: binding.generation,
    } }, review.sessionRevision)) {
      const current = actions.session.getSnapshot().snapshot?.session;
      if (current) setReview({ ...review, revision: current.revision, sessionRevision: current.revision, error: null });
      setPauseReview(false);
    } else recordFailure(review, previousError);
  };
  return <section className="ariadne-reference history-action-controls" aria-label="History actions">
    <button type="button" className="ref-button ref-secondary" disabled={disabled} onClick={() => prepare(session.state === 'closed' ? 'session_reopen' : 'session_close')}>
      {session.state === 'closed' ? 'Reopen session' : 'Close session'}</button>
    {Object.values(session.topics).filter(topic => !!topic).sort((a, b) => a!.order - b!.order).map(topic => topic && <div key={topic.id} className="history-action-topic" data-topic-id={topic.id}>
      <strong>{topic.name}</strong>
      <button type="button" className="ref-button ref-secondary" data-shortcut-archive-topic={topic.archived_at ? undefined : topic.id} disabled={disabled} onClick={() => prepare(topic.archived_at ? 'topic_restore' : 'topic_archive', topic.id)}>
        {topic.archived_at ? 'Restore' : 'Archive'} {topic.name}</button>
      <button type="button" className="ref-button ref-secondary" disabled={state.status !== 'ready' || !!state.error || operation.writing} onClick={() => setContinuing(topic.id)}>Continue {topic.name}</button>
    </div>)}
    {!review && historyPending && operation.error && <p role="alert">{operation.error.message}</p>}
    {!review && historyPending && <button type="button" className="ref-button ref-secondary" disabled={operation.writing} onClick={() => { void actions.retry(); }}>Reconcile saved action</button>}
    {historyReceipt && !review && <p role="status">History action saved. Full history is retained.</p>}
    {review && <ReferenceDialog title={pauseReview ? 'Confirm Pause dispatch' : `Confirm ${label}`} onCancel={() => { if (!operation.writing) resetReview(); }} actions={<>
      <button type="button" className="ref-button ref-secondary" disabled={operation.writing} onClick={resetReview}>Cancel</button>
      {operation.pending ? <button type="button" className="ref-button ref-primary" disabled={operation.writing} onClick={() => {
        const previousError = actions.getSnapshot().error;
        void actions.retry().then(saved => {
          if (!saved) { recordFailure(review, previousError); return; }
          if (operation.pending?.command.command === 'binding_pause') {
            const current = actions.session.getSnapshot().snapshot?.session;
            if (current) setReview({ ...review, revision: current.revision, sessionRevision: current.revision, error: null });
            setPauseReview(false);
          } else resetReview();
        });
      }}>Reconcile saved action</button> : pauseReview
        ? <button type="button" className="ref-button ref-primary" disabled={disabled || !!changing} onClick={() => { void pause(); }}>Confirm Pause dispatch</button>
        : mustPause ? <button type="button" className="ref-button ref-primary" disabled={disabled || !!changing} onClick={() => setPauseReview(true)}>Pause dispatch</button>
          : <button type="button" className="ref-button ref-primary" disabled={disabled || !!changing || blockers.length > 0} onClick={() => { void confirm(); }}>Confirm {label}</button>}
    </>}><div className="history-action-dialog">
      <p>{session.title}{review.topicId && ` · ${session.topics[review.topicId]?.name}`}</p>
      <p>{pauseReview ? 'Persist an owner pause first. Already delivered host work can continue. Close requires a separate confirmation afterward.'
        : 'This changes Ariadne metadata and retains IDs, binding and complete history. The external host keeps running.'}</p>
      {review.kind === 'session_reopen' && <p>Reopening does not resume dispatch.</p>}
      {mustPause && !pauseReview && <p>Pause dispatch, wait for persisted paused state, then confirm Close separately.</p>}
      {alreadyStopped && !pauseReview && <p>Dispatch is already stopped (binding not connected). Confirm Close.</p>}
      {blockers.map(blocker => <button key={blocker.key} type="button" className="ref-button ref-secondary" onClick={() => {
        resetReview(); if (blocker.item) revealItem(blocker.item); else openSession(route);
      }}>{blocker.label}</button>)}
      {changing && <p role="alert">The session changed. Review the current state before confirming.</p>}
      {changing && !operation.pending && <button type="button" className="ref-button ref-secondary" onClick={() => {
        prepare(review.kind, review.topicId); setPauseReview(false);
      }}>Review current state</button>}
      {(review.error || operation.pending && operation.error) && <p role="alert">{(review.error ?? operation.error)?.message} {operation.pending && 'Completion is unknown. Reconcile the saved action before a new confirmation.'}</p>}
    </div></ReferenceDialog>}
    {continuing && <ContinueDialog actions={actions} topicId={continuing} targets={targets} actionsForTarget={actionsForTarget} revealItem={revealItem} onCancel={() => setContinuing(null)} />}
  </section>;
}
