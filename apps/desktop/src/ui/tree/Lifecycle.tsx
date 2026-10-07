// Close session, archive and restore topics: the guarded review flow ported
// from the old HistoryActions strip. Archive without blockers runs at once and
// leaves an "Archived" banner with Undo; anything guarded opens the review.
import { useState, type ReactNode } from 'react';
import { CoreFailure, useSession, type ServiceFailure } from '../../data';
import type { ItemRoute, OwnerCommand, SessionRef } from '../../generated/core';
import { SessionActions, useSessionActions } from '../../components/bindings/actions';
import { Dialog } from '../dialogs/Dialog';
import { dispatchQuiesced, lifecycleBlockers } from '../../components/history-actions/selectors';
import '../../components/history-actions/history-actions.css';

type Kind = 'topic_archive' | 'topic_restore' | 'session_close' | 'session_reopen';
interface Review { kind: Kind; topicId: string | null; revision: number; sessionRevision: number; error: CoreFailure | ServiceFailure | null }
export interface Archived { readonly topicId: string; readonly name: string; readonly waiting: number }
export interface Lifecycle {
  /** Close or reopen the session through the review. */
  readonly session: () => void;
  /** Archive at once when nothing blocks it, else review the blockers. */
  readonly archive: (topicId: string) => void;
  readonly restore: (topicId: string) => void;
  readonly archived: Archived | null;
  readonly undo: () => void;
  readonly dismiss: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** A saved session action whose completion is unknown ("binding pause"), reconciled from the column. */
  readonly pending: string | null;
  readonly reconcile: () => void;
  readonly dialog: ReactNode;
}

export function useLifecycle(actions: SessionActions, { revealItem, openSession }: {
  revealItem: (route: ItemRoute) => void; openSession: (route: SessionRef) => void;
}): Lifecycle {
  const state = useSession(actions.session), operation = useSessionActions(actions);
  const [review, setReview] = useState<Review | null>(null);
  const [pauseReview, setPauseReview] = useState(false);
  const [archived, setArchived] = useState<Archived | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = state.snapshot?.session ?? null;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const disabled = state.status !== 'ready' || !!state.error || operation.writing || !!operation.pending;
  const resetReview = () => { setReview(null); setPauseReview(false); };
  const prepare = (kind: Kind, topicId: string | null = null) => {
    if (!session) return;
    setError(null);
    setReview({ kind, topicId, revision: topicId ? session.topics[topicId]!.revision : session.revision, sessionRevision: session.revision, error: null });
  };
  const run = async (command: OwnerCommand) => {
    if (!session || disabled) return false;
    setError(null);
    const saved = await actions.execute(command, session.revision);
    if (!saved) setError(actions.getSnapshot().error?.message ?? 'The change was not saved. Reload the session and try again.');
    return saved;
  };
  const archive = (topicId: string) => {
    const topic = session?.topics[topicId];
    if (!session || !topic || topic.archived_at !== null) return;
    if (lifecycleBlockers(session, topicId).length || operation.pending) { prepare('topic_archive', topicId); return; }
    const waiting = Object.values(session.items).filter(item => item?.topic_id === topicId && item.status === 'waiting_on_me').length;
    const previousError = actions.getSnapshot().error;
    void run({ command: 'topic_archive', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } })
      .then(saved => {
        if (saved) { setArchived({ topicId, name: topic.name, waiting }); return; }
        // A definite rejection (blockers the core knows about, a newer revision) opens the review with its reasons.
        const failure = actions.getSnapshot(), current = actions.session.getSnapshot().snapshot?.session;
        if (!(failure.error instanceof CoreFailure) || failure.error === previousError || failure.pending || !current?.topics[topicId]) return;
        setError(null);
        setReview({ kind: 'topic_archive', topicId, revision: current.topics[topicId]!.revision, sessionRevision: current.revision, error: failure.error });
      });
  };
  const restore = (topicId: string) => {
    const topic = session?.topics[topicId];
    if (!topic || topic.archived_at === null) return;
    void run({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } });
  };
  const undo = () => {
    if (!archived) return;
    const topic = session?.topics[archived.topicId];
    if (!topic || topic.archived_at === null) { setArchived(null); return; }
    void run({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: topic.id, expected_revision: topic.revision } })
      .then(saved => { if (saved) setArchived(null); });
  };

  let dialog: ReactNode = null;
  if (review && session) {
    const route = { project_id: session.project_id, session_id: session.id };
    const changing = review.sessionRevision !== session.revision;
    const guarded = review.kind === 'topic_archive' || review.kind === 'session_close';
    const coreError = review.error instanceof CoreFailure ? review.error.error : undefined;
    const blockers = guarded ? lifecycleBlockers(session, review.topicId, coreError) : [];
    // A disconnected or unbound session is already quiesced: Close needs no pause first.
    const mustPause = review.kind === 'session_close' && !dispatchQuiesced(binding);
    const alreadyStopped = review.kind === 'session_close' && !!binding && binding.dispatch_state !== 'paused' && dispatchQuiesced(binding);
    const label = review.kind.replace(/_/g, ' ');
    const recordFailure = (attempted: Review, previousError: typeof operation.error) => {
      const next = actions.getSnapshot().error;
      if (next !== previousError) setReview(current => current === attempted ? { ...current, error: next } : current);
    };
    const confirm = async () => {
      if (disabled || changing || blockers.length || mustPause) return;
      const command: OwnerCommand = review.kind === 'topic_archive' || review.kind === 'topic_restore'
        ? { command: review.kind, api_version: 1, op_id: '', params: { topic_id: review.topicId!, expected_revision: review.revision } }
        : { command: review.kind, api_version: 1, op_id: '', params: { expected_revision: review.revision } };
      const previousError = actions.getSnapshot().error;
      if (await actions.execute(command, review.sessionRevision)) resetReview();
      else recordFailure(review, previousError);
    };
    const pause = async () => {
      if (!binding || disabled || changing) return;
      const previousError = actions.getSnapshot().error;
      if (await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '', params: {
        binding_id: binding.id, expected_generation: binding.generation,
      } }, review.sessionRevision)) {
        const current = actions.session.getSnapshot().snapshot?.session;
        if (current) setReview({ ...review, revision: current.revision, sessionRevision: current.revision, error: null });
        setPauseReview(false);
      } else recordFailure(review, previousError);
    };
    const title = pauseReview ? 'Confirm Pause dispatch' : `Confirm ${label}`;
    const buttons = <>
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={resetReview}>Cancel</button>
      {operation.pending ? <button type="button" className="btn btn-primary" disabled={operation.writing} onClick={() => {
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
        ? <button type="button" className="btn btn-primary" disabled={disabled || changing} onClick={() => { void pause(); }}>Confirm Pause dispatch</button>
        : mustPause ? <button type="button" className="btn btn-primary" disabled={disabled || changing} onClick={() => setPauseReview(true)}>Pause dispatch</button>
          : <button type="button" className="btn btn-primary" disabled={disabled || changing || blockers.length > 0} onClick={() => { void confirm(); }}>Confirm {label}</button>}
    </>;
    dialog = <Dialog label={title} width={580} onCancel={() => { if (!operation.writing) resetReview(); }}>
      <div className="dialog-title">{title}</div><div className="history-action-dialog">
      <p>{session.title}{review.topicId && ` · ${session.topics[review.topicId]?.name}`}</p>
      <p>{pauseReview ? 'Persist an owner pause first. Already delivered host work can continue. Close requires a separate confirmation afterward.'
        : 'This changes Ariadne metadata and retains IDs, binding and complete history. The external host keeps running.'}</p>
      {review.kind === 'session_reopen' && <p>Reopening does not resume dispatch.</p>}
      {mustPause && !pauseReview && <p>Pause dispatch, wait for persisted paused state, then confirm Close separately.</p>}
      {alreadyStopped && !pauseReview && <p>Dispatch is already stopped (binding not connected). Confirm Close.</p>}
      {blockers.length > 0 && <p>{review.kind === 'topic_archive' ? 'Archive needs every item in this topic closed and every sent input settled first:' : 'Close needs every item closed and every sent input settled first:'}</p>}
      {blockers.map(blocker => <button key={blocker.key} type="button" className="btn btn-secondary" onClick={() => {
        resetReview(); if (blocker.item) revealItem(blocker.item); else openSession(route);
      }}>{blocker.label}</button>)}
      {changing && <p role="alert">The session changed. Review the current state before confirming.</p>}
      {changing && !operation.pending && <button type="button" className="btn btn-secondary" onClick={() => {
        prepare(review.kind, review.topicId); setPauseReview(false);
      }}>Review current state</button>}
      {(review.error || operation.pending && operation.error) && <p role="alert">{(review.error ?? operation.error)?.message} {operation.pending && 'Completion is unknown. Reconcile the saved action before a new confirmation.'}</p>}
    </div><div className="dialog-actions">{buttons}</div></Dialog>;
  }
  return {
    session: () => { if (session) prepare(session.state === 'closed' ? 'session_reopen' : 'session_close'); },
    archive, restore, archived, undo, dismiss: () => setArchived(null), busy: disabled, error, dialog,
    pending: operation.pending && !review ? operation.pending.command.command.replace(/_/g, ' ') : null,
    reconcile: () => {
      if (operation.writing) return;
      void actions.retry().then(saved => { setError(saved ? null : actions.getSnapshot().error?.message ?? 'The saved action is still unconfirmed.'); });
    },
  };
}
