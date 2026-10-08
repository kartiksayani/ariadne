// Close session, archive and restore topics. Archive never refuses (ADR-0090):
// a topic with open items or unsent messages asks one plain confirmation that
// says what stays and what is cancelled; one with neither archives at once.
// Either way an "Archived" banner offers Undo.
import { useRef, useState, type ReactNode } from 'react';
import { CoreFailure, plainFailure, useSession, type ServiceFailure } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import { SessionActions, useSessionActions } from '../../components/bindings/actions';
import { unconfirmedText } from '../../components/bindings/unconfirmed';
import { Dialog } from '../dialogs/Dialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { archiveImpact, archiveWarning, closeImpact, closeWarning } from '../../components/history-actions/selectors';
import { announceClosed } from '../pages/SessionDialogs';
import { agentName, ownerName, sessionPhrase, sessionWhen } from '../shell/model';
import { displayStatus } from '../../selectors/waiting/replied';
import '../../components/history-actions/history-actions.css';

type Kind = 'topic_archive' | 'topic_restore' | 'session_close' | 'session_reopen';
/** The review dialog's title and confirm button, in plain words (close has its own, longer title). */
const confirmWords: Record<Kind, { readonly title: string; readonly button: string }> = {
  topic_archive: { title: 'Archive this topic?', button: 'Archive topic' },
  topic_restore: { title: 'Restore this topic?', button: 'Restore topic' },
  session_close: { title: 'Close this session?', button: 'Close session' },
  session_reopen: { title: 'Reopen this session?', button: 'Reopen session' },
};
const loadingError = "Ariadne is still loading this session's latest changes. Try again.";
interface Review { kind: Kind; topicId: string | null; revision: number; sessionRevision: number; error: CoreFailure | ServiceFailure | null }
/** A saved archive: its waiting questions left the panel, and `cancelled` unsent messages were cancelled. */
export interface Archived { readonly topicId: string; readonly name: string; readonly waiting: number; readonly cancelled: number }
export interface Lifecycle {
  /** Close or reopen the session through the review. */
  readonly session: () => void;
  /** Archive: confirm first when open items stay or unsent messages are cancelled, else at once. */
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

export function useLifecycle(actions: SessionActions): Lifecycle {
  const state = useSession(actions.session), operation = useSessionActions(actions);
  const [review, setReview] = useState<Review | null>(null);
  /** The topic whose archive confirmation is open, with the failure of its last try. */
  const [confirming, setConfirming] = useState<{ readonly topicId: string; readonly error: string | null } | null>(null);
  const [archived, setArchived] = useState<Archived | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const session = state.snapshot?.session ?? null;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const disabled = waiting || operation.writing || !!operation.pending;
  const resetReview = () => setReview(null);
  const prepare = (kind: Kind, topicId: string | null = null) => {
    if (!session) return;
    setError(null);
    setReview({ kind, topicId, revision: topicId ? session.topics[topicId]!.revision : session.revision, sessionRevision: session.revision, error: null });
  };
  // Reserve before yielding so repeated clicks cannot queue duplicate writes.
  // Rebuild the action from the refreshed capture, retaining SessionActions' write barrier.
  const withReady = async (change: (current: NonNullable<typeof session>) => Promise<boolean> | boolean) => {
    if (running.current || actions.getSnapshot().writing || actions.getSnapshot().pending) return false;
    running.current = true;
    setWaiting(true);
    setError(null);
    try {
      const store = actions.session;
      if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) await store.refresh(true);
      const current = store.getSnapshot();
      if (actions.session !== store || current.status !== 'ready' || current.error || !current.snapshot) {
        setError(loadingError);
        setConfirming(value => value && { ...value, error: loadingError });
        return false;
      }
      if (actions.getSnapshot().writing || actions.getSnapshot().pending) return false;
      const result = change(current.snapshot.session);
      return typeof result === 'boolean' ? result : await result;
    } finally { running.current = false; setWaiting(false); }
  };
  const run = async (command: OwnerCommand, current: NonNullable<typeof session>) => {
    const saved = await actions.execute(command, current.revision);
    if (!saved) setError(plainFailure(actions.getSnapshot().error, 'The change was not saved. Reload the session and try again.'));
    return saved;
  };
  /** Archives the topic as it is now; returns whether it saved. */
  const archiveCurrent = async (topicId: string, current: NonNullable<typeof session>) => {
    const topic = current.topics[topicId];
    if (!topic || topic.archived_at !== null) return false;
    // Only questions still in the Waiting on me panel leave it; replied ones already wait on the agent.
    const waiting = Object.values(current.items).filter(item => item?.topic_id === topicId && displayStatus(current, item) === 'waiting_on_me').length;
    const saved = await run({ command: 'topic_archive', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } }, current);
    if (saved) {
      const receipt = actions.getSnapshot().receipt, data = receipt && 'data' in receipt ? receipt.data : undefined;
      setArchived({ topicId, name: topic.name, waiting, cancelled: data?.kind === 'topic_lifecycle' ? data.cancelled_input_ids?.length ?? 0 : 0 });
    }
    return saved;
  };
  const archive = (topicId: string) => {
    const topic = session?.topics[topicId];
    if (!session || !topic || topic.archived_at !== null) return;
    if (operation.pending) { prepare('topic_archive', topicId); return; }
    void withReady(current => {
      const topic = current.topics[topicId];
      if (!topic || topic.archived_at !== null) return false;
      if (archiveWarning(archiveImpact(current, topicId), agent)) { setConfirming({ topicId, error: null }); return false; }
      return archiveCurrent(topicId, current);
    });
  };
  const restore = (topicId: string) => {
    void withReady(current => {
      const topic = current.topics[topicId];
      if (!topic || topic.archived_at === null) return false;
      return run({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } }, current);
    });
  };
  const undo = () => {
    if (!archived) return;
    void withReady(current => {
      const topic = current.topics[archived.topicId];
      if (!topic || topic.archived_at === null) { setArchived(null); return false; }
      return run({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: topic.id, expected_revision: topic.revision } }, current);
    })
      .then(saved => { if (saved) setArchived(null); });
  };

  let dialog: ReactNode = null;
  const confirmed = confirming && session?.topics[confirming.topicId];
  if (confirming && session && confirmed && confirmed.archived_at === null && !operation.pending) {
    // The confirmation reads the topic as it is now; an agent write meanwhile only updates its words.
    const warning = archiveWarning(archiveImpact(session, confirmed.id), agent) ?? 'You can restore it any time.';
    dialog = <ConfirmDialog title={`Archive “${confirmed.name}”?`} body={warning} confirmLabel="Archive topic" busy={disabled}
      error={confirming.error} onCancel={() => { if (!running.current && !actions.getSnapshot().writing) setConfirming(null); }}
      onConfirm={() => {
        void withReady(current => archiveCurrent(confirmed.id, current)).then(saved => {
          // An unconfirmed save is reconciled from the column's banner, not here.
          if (saved || actions.getSnapshot().pending) { setConfirming(null); return; }
          setError(null);
          setConfirming(current => current && { ...current, error: actions.session.getSnapshot().status !== 'ready' || actions.session.getSnapshot().error
            ? loadingError : plainFailure(actions.getSnapshot().error, 'The topic was not archived. Try again.') });
        });
      }} />;
  } else if (review && session) {
    const closing = review.kind === 'session_close';
    // Close and reopen act on the session as it is now: an agent write meanwhile never holds them.
    const changing = !closing && review.kind !== 'session_reopen' && review.sessionRevision !== session.revision;
    const words = confirmWords[review.kind];
    const recordFailure = (attempted: Review, previousError: typeof operation.error) => {
      const next = actions.getSnapshot().error;
      if (next !== previousError) setReview(current => current === attempted ? { ...current, error: next } : current);
    };
    const confirm = () => withReady(async current => {
      if (changing || (!closing && review.kind !== 'session_reopen' && review.sessionRevision !== current.revision)) return false;
      const command: OwnerCommand = review.kind === 'topic_archive' || review.kind === 'topic_restore'
        ? { command: review.kind, api_version: 1, op_id: '', params: { topic_id: review.topicId!, expected_revision: review.revision } }
        : { command: review.kind, api_version: 1, op_id: '', params: { expected_revision: current.revision } };
      const previousError = actions.getSnapshot().error;
      if (await actions.execute(command, review.kind === 'topic_archive' || review.kind === 'topic_restore' ? review.sessionRevision : current.revision)) {
        if (closing) announceClosed(actions, agent, ownerName(current));
        resetReview();
        return true;
      }
      recordFailure(review, previousError);
      return false;
    });
    const title = closing ? `Close ${sessionPhrase(session, agent, sessionWhen(Date.parse(session.created_at), Date.now()))}?` : words.title;
    const warning = closing ? closeWarning(closeImpact(session), agent) : null;
    const buttons = <>
      <button type="button" className="btn btn-ghost" disabled={waiting || operation.writing} onClick={resetReview}>Cancel</button>
      {operation.pending ? <button type="button" className="btn btn-primary" disabled={operation.writing} onClick={() => {
        const previousError = actions.getSnapshot().error;
        void actions.retry().then(saved => { if (saved) resetReview(); else recordFailure(review, previousError); });
      }}>Check again</button>
        : <button type="button" className="btn btn-primary" disabled={disabled || changing} onClick={() => { void confirm(); }}>
          {words.button}</button>}
    </>;
    dialog = <Dialog label={title} width={580} onCancel={() => { if (!running.current && !actions.getSnapshot().writing) resetReview(); }}>
      <div className="dialog-title">{title}</div><div className="history-action-dialog">
      <p>{ownerName(session) ?? session.title}{review.topicId && ` · ${session.topics[review.topicId]?.name}`}</p>
      <p>{closing ? 'Ariadne marks the session Closed and keeps it read-only. The agent process isn’t touched.'
        : review.kind === 'session_reopen' ? `Ariadne marks the session Active again and resumes sending to ${agent}.`
          : 'Ariadne keeps the topic’s full history. The agent keeps running.'}</p>
      {warning && <p data-close-warning>{warning}</p>}
      {changing && <p role="alert">The session changed. Review the current state before confirming.</p>}
      {changing && !operation.pending && <button type="button" className="btn btn-secondary" onClick={() => prepare(review.kind, review.topicId)}>Review current state</button>}
      {(error || review.error || operation.pending && operation.error) && <p role="alert">{error ?? plainFailure(review.error ?? operation.error)} {operation.pending && 'Ariadne isn’t sure your last change was saved. Check again before confirming another.'}</p>}
    </div><div className="dialog-actions">{buttons}</div></Dialog>;
  }
  return {
    session: () => { if (session) prepare(session.state === 'closed' ? 'session_reopen' : 'session_close'); },
    archive, restore, archived, undo, dismiss: () => setArchived(null), busy: disabled, error, dialog,
    pending: operation.pending && !review ? unconfirmedText(operation.pending.command.command) : null,
    reconcile: () => {
      if (operation.writing) return;
      void actions.retry().then(saved => { setError(saved ? null : plainFailure(actions.getSnapshot().error, 'Ariadne still isn’t sure your last change was saved.')); });
    },
  };
}
