import { itemRemoved } from '../../selectors/removed';
// Close session, archive and restore topics. Archive never refuses (ADR-0090):
// it always asks first (10.13), naming the questions waiting on the owner that
// leave with it. After it, the Map shows a strip in the topic's place and a toast,
// both with Undo, until Undo or a session switch (E33).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CoreFailure, plainFailure, type ServiceFailure } from '../../data';
import type { OwnerCommand } from '../../generated/core';
import type { SessionActions } from '../../components/bindings/actions';
import { unconfirmedText } from '../../components/bindings/unconfirmed';
import { Dialog } from '../dialogs/Dialog';
import { closeImpact, closeWarning } from '../../components/history-actions/selectors';
import { ArchiveTopicDialog, archiveWaiting } from '../dialogs/ArchiveTopicDialog';
import { announceClosed } from '../pages/SessionDialogs';
import { agentName, ownerName, sessionPhrase, sessionWhen } from '../shell/model';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { saveSessionLabel } from './SessionRename';
import { loadingError, savingError, waitForLifecycleReady } from './lifecycleReady';
import { copySessionReference } from './CopySessionId';
import '../../components/history-actions/history-actions.css';

type Kind = 'topic_archive' | 'topic_restore' | 'session_close' | 'session_reopen';
/** The review dialog's title and confirm button, in plain words (close has its own, longer title). */
const confirmWords: Record<Kind, { readonly title: string; readonly button: string }> = {
  topic_archive: { title: 'Archive this topic?', button: 'Archive topic' },
  topic_restore: { title: 'Restore this topic?', button: 'Restore topic' },
  session_close: { title: 'Close this session?', button: 'Close session' },
  session_reopen: { title: 'Reopen this session?', button: 'Reopen session' },
};
interface Review { kind: Kind; topicId: string | null; revision: number; sessionRevision: number; error: CoreFailure | ServiceFailure | string | null }
/** A saved archive: its waiting questions left the panel, and `cancelled` unsent messages were cancelled. */
export interface Archived { readonly topicId: string; readonly name: string; readonly waiting: number; readonly cancelled: number }
/** Where the session stands: what its Close, Reopen or Restore control does; null until it loads. */
export type SessionLifecycleState = 'active' | 'closed' | 'archived' | null;
export interface SessionLifecycle {
  /** Close or reopen the session through the review; restore an archived session (as Closed) at once. */
  readonly session: () => void;
  /**
   * The connection card's and the rows' Close, Reopen and Restore: `session`, run only while the session is still
   * active, closed or archived respectively; otherwise nothing changes and `error` says why.
   */
  readonly close: () => void;
  readonly reopen: () => void;
  readonly restoreSession: () => void;
  /** `archive` and `restore` under the names the top bar uses. */
  readonly archiveTopic: (topicId: string) => void;
  readonly restoreTopic: (topicId: string) => void;
  /** Copies the session's connection reference and says so in a notice. Resolves to whether the write landed. */
  readonly copySessionId: () => Promise<boolean>;
  readonly state: SessionLifecycleState;
  /** Rename against the latest ready session capture. */
  readonly rename: (name: string, description: string) => Promise<string | null>;
  /** Archive: always confirm first (10.13). */
  readonly archive: (topicId: string) => void;
  /** The open Archive confirmation's "Archive topic" (what its dialog runs); nothing when none is open. */
  readonly confirmArchive: () => void;
  readonly restore: (topicId: string) => void;
  readonly archived: Archived | null;
  readonly undo: () => void;
  readonly dismiss: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** How many times `error` was set or cleared: a view compares it with the count it saw when it began, to react only to its own errors. */
  readonly errorCount: number;
  /** A saved session action whose completion is unknown ("binding pause"), reconciled from the column. */
  readonly pending: string | null;
  readonly reconcile: () => void;
  readonly dialog: ReactNode;
  /** A review or confirmation is open (wherever its dialog renders). */
  readonly reviewing: boolean;
}

const noop = () => {};
const idleSubscribe = () => noop;
const idleSnapshot = () => null;
/** No session: every control does nothing and the lifecycle reads busy. */
const idle: SessionLifecycle = Object.freeze({
  session: noop, close: noop, reopen: noop, restoreSession: noop, archiveTopic: noop, restoreTopic: noop, copySessionId: () => Promise.resolve(false),
  state: null, rename: () => Promise.resolve(loadingError), archive: noop, confirmArchive: noop, restore: noop, archived: null, undo: noop, dismiss: noop,
  busy: true, error: null, errorCount: 0, pending: null, reconcile: noop, dialog: null, reviewing: false,
});
type SessionStanding = Exclude<SessionLifecycleState, null>;
const standing = (session: { readonly archived_at?: string | null; readonly state: string }): SessionStanding =>
  session.archived_at != null ? 'archived' : session.state === 'closed' ? 'closed' : 'active';
/** Said when a Close, Reopen or Restore click meets a session that another client changed meanwhile. */
const changedMeanwhile: Record<SessionStanding, string> = {
  active: 'This session is open now. Nothing changed.',
  closed: 'This session is already closed. Nothing changed.',
  archived: 'This session was archived meanwhile. Nothing changed.',
};

/**
 * Close, reopen and restore the session; rename it; archive and restore its topics. `input` is the session's
 * controller (`SessionActionControllers.forSession`), or null with no session (every control is then inert). The review
 * dialogs, the running guard and the Undo state are local to each call: mount it once per screen (SessionLifecycleOwner)
 * and read it with useSessionLifecycleFor. A new `input` (another session) starts from no review, error or Undo.
 */
export function useSessionLifecycle(input: SessionActions | null): SessionLifecycle {
  const state = useSyncExternalStore(input?.session.subscribe ?? idleSubscribe, input?.session.getSnapshot ?? idleSnapshot, input?.session.getSnapshot ?? idleSnapshot);
  const operation = useSyncExternalStore(input?.subscribe ?? idleSubscribe, input?.getSnapshot ?? idleSnapshot, input?.getSnapshot ?? idleSnapshot);
  const [review, setReview] = useState<Review | null>(null);
  /** The topic whose archive confirmation is open, with the failure of its last try. */
  const [confirming, setConfirming] = useState<{ readonly topicId: string; readonly error: string | null } | null>(null);
  const [archived, setArchived] = useState<Archived | null>(null);
  // `errorCount` rises on every set, so a view can tell an error its own action just raised from one left by an earlier action,
  // even when both say the same words.
  const [failure, setFailure] = useState<{ readonly message: string | null; readonly count: number }>({ message: null, count: 0 });
  const error = failure.message, errorCount = failure.count;
  const setError = (message: string | null) => { setFailure(previous => ({ message, count: previous.count + 1 })); };
  const [waiting, setWaiting] = useState(false);
  const [owner, setOwner] = useState(input);
  if (owner !== input) {
    setOwner(input); setReview(null); setConfirming(null); setArchived(null); setError(null); setWaiting(false);
  }
  /** The write in flight; a token, so a write that finishes after a session switch never clears the next one's guard. */
  const running = useRef<{ readonly key: string } | null>(null);
  const readyWait = useRef<{ cancelled: boolean; cancel: () => void } | null>(null);
  /** The latest copy; a superseded one (a newer copy, or another session) reports nothing. */
  const copies = useRef(0);
  useEffect(() => () => {
    if (readyWait.current) { readyWait.current.cancelled = true; readyWait.current.cancel(); }
    running.current = null; copies.current += 1;
  }, [input]);
  if (!input || !state || !operation) return idle;
  const actions = input;
  const session = state.snapshot?.session ?? null;
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const disabled = waiting || operation.writing || !!operation.pending;
  const cancelWait = () => {
    if (actions.getSnapshot().writing) return false;
    if (readyWait.current) { readyWait.current.cancelled = true; readyWait.current.cancel(); }
    return true;
  };
  const resetReview = () => { if (cancelWait()) setReview(null); };
  const prepare = (kind: Kind, topicId: string | null = null, current = session) => {
    if (!current) { setError(loadingError); return; }
    setError(null);
    setReview({ kind, topicId, revision: topicId ? current.topics[topicId]!.revision : current.revision, sessionRevision: current.revision, error: null });
  };
  // Reserve before yielding so repeated clicks cannot queue duplicate writes.
  // Rebuild the action from the refreshed capture, retaining SessionActions' write barrier.
  const withReady = async (key: string, change: (current: NonNullable<typeof session>) => Promise<boolean> | boolean, onFailure?: (message: string) => void) => {
    const report = (message: string) => {
      if (onFailure) onFailure(message);
      else {
        setError(message);
        setConfirming(value => value && { ...value, error: message });
      }
      return false;
    };
    if (running.current) return running.current.key === key ? false : report(savingError);
    const token = { key };
    running.current = token;
    let abandon!: () => void;
    const cancellation = new Promise<boolean>(resolve => { abandon = () => resolve(false); });
    const attempt = { cancelled: false, cancel: abandon, cancellation };
    readyWait.current = attempt;
    setWaiting(true);
    setError(null);
    try {
      const capture = waitForLifecycleReady(actions, attempt);
      const ready = capture instanceof Promise ? await capture : capture;
      if (!ready.ok) return ready.error ? report(ready.error) : false;
      readyWait.current = null;
      const result = change(ready.session);
      return typeof result === 'boolean' ? result : await result;
    } finally {
      if (running.current === token) { readyWait.current = null; running.current = null; setWaiting(false); }
    }
  };
  const rename = async (name: string, description: string) => {
    if (actions.getSnapshot().pending && !actions.getSnapshot().writing) return 'Ariadne isn’t sure your last change was saved. Check again before renaming this session.';
    let failure: string | null = 'Another change is being saved. Wait for it, then try again.';
    const saved = await withReady(JSON.stringify(['rename', name, description]), async current => {
      failure = await saveSessionLabel(actions, current.revision, name, description);
      return failure === null;
    }, message => { failure = message; });
    return saved ? null : actions.getSnapshot().pending && !actions.getSnapshot().writing
      ? 'Ariadne isn’t sure your last change was saved. Check again before renaming this session.' : failure;
  };
  const run = async (command: OwnerCommand, current: NonNullable<typeof session>) => {
    const saved = await actions.execute(command, current.revision);
    if (!saved) setError(plainFailure(actions.getSnapshot().error, 'The change was not saved. Reload the session and try again.'));
    return saved;
  };
  /** Archives the topic as it is now; returns whether it saved. */
  const archiveCurrent = async (topicId: string, current: NonNullable<typeof session>) => {
    const topic = current.topics[topicId];
    if (!topic || topic.archived_at !== null) { setError(topic ? 'This topic is already archived.' : 'This topic is no longer available. Reload the session and try again.'); return false; }
    // Only questions still in the Waiting on me panel leave it; replied ones already wait on the agent.
    const waiting = Object.values(current.items).filter(item => item?.topic_id === topicId && !itemRemoved(current, item.id) && waitingOnOwner(current, item)).length;
    const saved = await run({ command: 'topic_archive', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } }, current);
    if (saved) {
      const receipt = actions.getSnapshot().receipt, data = receipt && 'data' in receipt ? receipt.data : undefined;
      setArchived({ topicId, name: topic.name, waiting, cancelled: data?.kind === 'topic_lifecycle' ? data.cancelled_input_ids?.length ?? 0 : 0 });
    }
    return saved;
  };
  const archive = (topicId: string) => {
    if (operation.pending && !operation.writing) { if (session?.topics[topicId]) prepare('topic_archive', topicId); else setError(loadingError); return; }
    void withReady(`archive:${topicId}`, current => {
      const topic = current.topics[topicId];
      if (!topic || topic.archived_at !== null) { setError(topic ? 'This topic is already archived.' : 'This topic is no longer available. Reload the session and try again.'); return false; }
      // E33: archiving a topic always asks (SPEC 10.13).
      setConfirming({ topicId, error: null });
      return false;
    });
  };
  const restore = (topicId: string) => {
    void withReady(`restore:${topicId}`, current => {
      const topic = current.topics[topicId];
      if (!topic || topic.archived_at === null) { setError(topic ? 'This topic is already restored.' : 'This topic is no longer available. Reload the session and try again.'); return false; }
      return run({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } }, current);
    });
  };
  const undo = () => {
    if (!archived) return;
    void withReady(`restore:${archived.topicId}`, current => {
      const topic = current.topics[archived.topicId];
      if (!topic || topic.archived_at === null) { setArchived(null); return false; }
      return run({ command: 'topic_restore', api_version: 1, op_id: '', params: { topic_id: topic.id, expected_revision: topic.revision } }, current);
    })
      .then(saved => { if (saved) setArchived(null); });
  };

  let dialog: ReactNode = null;
  let confirmArchive = noop;
  const confirmed = confirming && session?.topics[confirming.topicId];
  if (confirming && session && confirmed && confirmed.archived_at === null && !operation.pending) {
    // The confirmation reads the topic as it is now; an agent write meanwhile only updates its words.
    const waitingNow = archiveWaiting(session, confirmed.id);
    const confirm = () => {
        if (disabled) return;
        setConfirming(value => value && { ...value, error: null });
        let warningChanged = false;
        void withReady(`archive:${confirmed.id}`, current => {
          if (archiveWaiting(current, confirmed.id) !== waitingNow) {
            warningChanged = true;
            setConfirming(value => value && { ...value, error: null });
            return false;
          }
          return archiveCurrent(confirmed.id, current);
        }).then(saved => {
          if (warningChanged) return;
          // An unconfirmed save is reconciled from the column's banner, not here.
          if (saved || actions.getSnapshot().pending) { setConfirming(null); return; }
          setError(null);
          setConfirming(current => current && { ...current, error: current.error ?? (actions.session.getSnapshot().status !== 'ready' || actions.session.getSnapshot().error
            ? loadingError : plainFailure(actions.getSnapshot().error, 'The topic was not archived. Try again.')) });
        });
      };
    confirmArchive = confirm;
    dialog = <ArchiveTopicDialog name={confirmed.name} items={Object.values(session.items).filter(item => item?.topic_id === confirmed.id && !itemRemoved(session, item.id)).length}
      waiting={waitingNow} agent={agent} busy={disabled} error={confirming.error} onCancel={() => { if (cancelWait()) setConfirming(null); }} onConfirm={confirm} />;
  } else if (review && session) {
    const closing = review.kind === 'session_close';
    // Close and reopen act on the session as it is now: an agent write meanwhile never holds them.
    const changing = !closing && review.kind !== 'session_reopen' && review.sessionRevision !== session.revision;
    const words = confirmWords[review.kind];
    const recordFailure = (attempted: Review, previousError: typeof operation.error) => {
      const next = actions.getSnapshot().error;
      setReview(current => current === attempted ? { ...current, error: next !== previousError && next
        ? next : 'The change was not saved. Reload the session and try again.' } : current);
    };
    const confirm = () => withReady(`${review.kind}:${review.topicId ?? ''}`, async current => {
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
    }, message => { setReview(current => current === review ? { ...current, error: message } : current); });
    const title = closing ? `Close ${sessionPhrase(session, agent, sessionWhen(Date.parse(session.created_at), Date.now()))}?` : words.title;
    const warning = closing ? closeWarning(closeImpact(session), agent) : null;
    const buttons = <>
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={resetReview}>Cancel</button>
      {operation.pending ? <button type="button" className="btn btn-primary" disabled={operation.writing} onClick={() => {
        const previousError = actions.getSnapshot().error;
        void actions.retry().then(saved => { if (saved) resetReview(); else recordFailure(review, previousError); });
      }}>Check again</button>
        : <button type="button" className="btn btn-primary" disabled={disabled || changing} onClick={() => { void confirm(); }}>
          {words.button}</button>}
    </>;
    dialog = <Dialog label={title} width={580} onCancel={resetReview}>
      <div className="dialog-title">{title}</div><div className="history-action-dialog">
      <p>{ownerName(session) ?? session.title}{review.topicId && ` · ${session.topics[review.topicId]?.name}`}</p>
      <p>{closing ? 'Ariadne marks the session Closed and keeps it read-only. The agent process isn’t touched.'
        : review.kind === 'session_reopen' ? `Ariadne marks the session Active again and resumes sending to ${agent}.`
          : 'Ariadne keeps the topic’s full history. The agent keeps running.'}</p>
      {warning && <p data-close-warning>{warning}</p>}
      {changing && <p role="alert">The session changed. Review the current state before confirming.</p>}
      {changing && !operation.pending && <button type="button" className="btn btn-secondary" onClick={() => prepare(review.kind, review.topicId)}>Review current state</button>}
      {(error || review.error || operation.pending && operation.error) && <p role="alert">{error ?? (typeof review.error === 'string' ? review.error : plainFailure(review.error ?? operation.error))} {operation.pending && 'Ariadne isn’t sure your last change was saved. Check again before confirming another.'}</p>}
    </div><div className="dialog-actions">{buttons}</div></Dialog>;
  }
  /**
   * The session's toggle, acting on the session as it is now. `expected` is the standing the clicked control was for
   * (Close: active, Reopen: closed, Restore: archived); a session in any other standing is left as it is, so a Close
   * click on a session another client just archived never restores it.
   */
  const sessionAction = (expected?: SessionStanding) => {
    const changed = (current: { readonly archived_at?: string | null; readonly state: string }) => {
      if (expected === undefined || standing(current) === expected) return false;
      setError(changedMeanwhile[standing(current)]);
      return true;
    };
    if (operation.pending && !operation.writing && expected !== 'archived') {
      if (!session) setError(loadingError);
      else if (!changed(session)) prepare(session.state === 'closed' ? 'session_reopen' : 'session_close');
      return;
    }
    void withReady('session', current => {
      if (changed(current)) return false;
      if (current.archived_at != null) return run({ command: 'session_restore', api_version: 1, op_id: '', params: { expected_revision: current.revision } }, current);
      prepare(current.state === 'closed' ? 'session_reopen' : 'session_close', null, current);
      return false;
    });
  };
  return {
    session: () => sessionAction(), close: () => sessionAction('active'), reopen: () => sessionAction('closed'), restoreSession: () => sessionAction('archived'),
    archiveTopic: archive, restoreTopic: restore,
    copySessionId: () => {
      const attempt = ++copies.current;
      return copySessionReference(actions.session.getSnapshot().route.session_id, () => copies.current === attempt);
    },
    state: !session ? null : session.archived_at != null ? 'archived' : session.state === 'closed' ? 'closed' : 'active',
    rename, archive, restore, archived, undo, dismiss: () => setArchived(null), busy: disabled, error, errorCount, dialog, reviewing: dialog !== null, confirmArchive,
    pending: operation.pending && !review ? unconfirmedText(operation.pending.command.command) : null,
    reconcile: () => {
      if (operation.writing) return;
      void actions.retry().then(saved => { setError(saved ? null : plainFailure(actions.getSnapshot().error, 'Ariadne still isn’t sure your last change was saved.')); });
    },
  };
}
