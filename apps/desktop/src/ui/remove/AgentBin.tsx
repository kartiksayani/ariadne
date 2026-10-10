import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentRemoval, Session } from '../../generated/domain/models';
import type { SessionRef } from '../../generated/core';
import { plainFailure, type Immutable } from '../../data';
import { SessionActions, useSessionActions } from '../../components/bindings/actions';
import { heldInputs, heldInputsRestored, itemRemoved, removedRoots, removedSubtree } from '../../selectors/removed';
import { waitForLifecycleReady } from '../shared/lifecycleReady';
import { shortLabel } from '../shared/short';
import type { RemoveTarget } from '../dialogs/remove';
import './agent-bin.css';
import { STATUS, statusKey } from '../shared/status';
import { Dialog } from '../dialogs/Dialog';
import { notices } from '../pages/notices';
import { isViewConflict } from '../shared/conflictNotice';

const keyOf = (route: SessionRef, topicId: string | null) => JSON.stringify([route.project_id, route.session_id, topicId]);
/** A View notice can open a bin after navigation mounts its session. */
class BinView {
  private value: { key: string; sequence: number } = { key: '', sequence: 0 };
  private listeners = new Set<() => void>();
  readonly getSnapshot = () => this.value;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  reveal(route: SessionRef, topicId: string | null) { this.value = { key: keyOf(route, topicId), sequence: this.value.sequence + 1 }; this.listeners.forEach(listener => listener()); }
}
export const binView = new BinView();

/** Capture revisions only after stale refresh and the existing session write barrier. */
type BinAttempt = { cancelled: boolean; readonly cancellation: Promise<boolean>; readonly cancel: () => void;
  readonly confirmRestore?: (session: Immutable<Session>, count: number) => Promise<boolean> };
export async function restoreRemoved(actions: SessionActions, topicId: string, itemId: string | null, attempt?: BinAttempt): Promise<string | null> {
  const ready = await waitForLifecycleReady(actions, attempt);
  if (!ready.ok) return ready.error;
  const session = ready.session, topic = session.topics[topicId], item = itemId ? session.items[itemId] : null;
  if (!topic || itemId && !item) return 'This work is no longer available.';
  if (itemId ? !item?.removed_at || !!topic.removed_at || item.parent && itemRemoved(session, item.parent) : !topic.removed_at) return 'This work has already changed. View the bin and try again.';
  const held = heldInputsRestored(session, topicId, itemId).length;
  if (held && !attempt?.confirmRestore) return `Restoring this work makes ${held} held message${held === 1 ? '' : 's'} visible again. View the bin to confirm Restore.`;
  if (held && attempt?.confirmRestore) {
    if (!await attempt.confirmRestore(session, held) || attempt.cancelled) return null;
    // Confirmation can wait while another writer changes which messages a restore exposes.
    const current = await waitForLifecycleReady(actions, attempt);
    if (!current.ok) return current.error;
    if (current.session.revision !== session.revision) return restoreRemoved(actions, topicId, itemId, attempt);
  }
  const saved = await actions.execute(itemId ? { command: 'item_restore', api_version: 1, op_id: '', params: { item_id: itemId, expected_revision: item!.revision } }
    : { command: 'topic_removed_restore', api_version: 1, op_id: '', params: { topic_id: topicId, expected_revision: topic.revision } }, session.revision);
  return saved ? null : plainFailure(actions.getSnapshot().error, 'The work could not be restored. Try again.');
}

/** Both the bin and removal notices explain the queued messages a Restore releases. */
export function useRestoreConfirmation(actions?: SessionActions) {
  const [confirmation, setConfirmation] = useState<{ count: number; resolve: (confirmed: boolean) => void } | null>(null);
  const pending = useRef<BinAttempt | null>(null);
  useEffect(() => () => { pending.current?.cancel(); setConfirmation(null); }, [actions]);
  const restore = async (actions: SessionActions, topicId: string, itemId: string | null) => {
    if (pending.current) return { error: 'Finish the current restore first.', restored: false };
    let cancel!: () => void;
    const cancellation = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    let decide: ((confirmed: boolean) => void) | null = null;
    const attempt: BinAttempt = { cancelled: false, cancellation, cancel: () => { attempt.cancelled = true; cancel(); decide?.(false); },
      confirmRestore: (_session, count) => new Promise<boolean>(resolve => {
        decide = resolve; setConfirmation({ count, resolve: confirmed => {
          setConfirmation(null); if (!confirmed) attempt.cancel(); resolve(confirmed);
        } });
      }) };
    pending.current = attempt;
    try { const error = await restoreRemoved(actions, topicId, itemId, attempt); return { error, restored: !error && !attempt.cancelled }; }
    finally { pending.current = null; }
  };
  const dialog = confirmation && <Dialog label="Restore work" width={480} onCancel={() => confirmation.resolve(false)} onConfirm={() => confirmation.resolve(true)}>
    <div className="dialog-title">Restore work</div>
    <p>Restoring this work makes {confirmation.count} held message{confirmation.count === 1 ? '' : 's'} visible again. {confirmation.count === 1 ? 'It will' : 'They will'} send when sending can resume.</p>
    <div className="dialog-actions">
      <button type="button" className="btn btn-ghost" onClick={() => confirmation.resolve(false)}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={() => confirmation.resolve(true)}>Restore</button>
    </div>
  </Dialog>;
  return { restore, dialog };
}

export function removalNotice(session: Immutable<Session>, removal: Immutable<AgentRemoval>): string {
  const name = removal.item_id ? session.items[removal.item_id] ? shortLabel(session.items[removal.item_id]!) : 'an item' : session.topics[removal.topic_id]?.name ?? 'a topic';
  const work = removal.item_id ? removal.item_ids.length > 1 : removal.item_ids.length > 0;
  return `The agent removed “${name}”${work ? ` and its work (${removal.item_ids.length} item${removal.item_ids.length === 1 ? '' : 's'})` : ''}.`
    + (removal.waiting_questions ? ` ${removal.waiting_questions} waiting question${removal.waiting_questions === 1 ? '' : 's'} left your panel.` : '')
    + (removal.cancelled_input_ids.length ? ` ${removal.cancelled_input_ids.length} unsent message${removal.cancelled_input_ids.length === 1 ? ' was' : 's were'} cancelled. Your words are kept in the bin.` : '');
}

/** A collapsed bin per live topic, or one per session for removed topics. */
export function AgentBin({ session, actions, topicId = null, onRemove }: {
  readonly session: Immutable<Session>; readonly actions: SessionActions; readonly topicId?: string | null;
  readonly onRemove: (target: Extract<RemoveTarget, { kind: 'item' | 'topic' }>) => void;
}) {
  const request = useSyncExternalStore(binView.subscribe, binView.getSnapshot), operation = useSessionActions(actions);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const pending = useRef<BinAttempt | null>(null);
  const restoreConfirmation = useRestoreConfirmation(actions);
  useEffect(() => () => { if (pending.current) { pending.current.cancelled = true; pending.current.cancel(); } }, [actions]);
  const route = { project_id: session.project_id, session_id: session.id }, key = keyOf(route, topicId);
  const immediateError = operation.pending || isViewConflict(operation.error) && error === plainFailure(operation.error) ? null : error;
  useEffect(() => {
    if (!immediateError) return;
    const id = `agent-bin-action:${key}`;
    notices.push({ id, icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true, text: immediateError });
    return () => notices.dismiss(id);
  }, [key, immediateError]);
  useEffect(() => { if (request.key === key) setOpen(true); }, [request, key]);
  const entries = topicId ? removedRoots(session, topicId).map(item => ({ topicId, itemId: item.id, name: shortLabel(item), items: removedSubtree(session, item.id) }))
    : Object.values(session.topics).filter(topic => !!topic?.removed_at).map(topic => ({ topicId: topic!.id, itemId: null, name: topic!.name,
      items: Object.values(session.items).filter(item => item?.topic_id === topic!.id) }));
  if (!entries.length) return null;
  const count = topicId ? entries.reduce((sum, entry) => sum + entry.items.length, 0) : entries.length;
  const beginWait = () => {
    let cancel!: () => void;
    const cancellation = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    const attempt = { cancelled: false, cancel, cancellation };
    pending.current = attempt;
    return attempt;
  };
  const restore = async (topic: string, item: string | null) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { setError((await restoreConfirmation.restore(actions, topic, item)).error); }
    finally { running.current = false; setBusy(false); }
  };
  const remove = async (topic: string, item: string | null) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    const attempt = beginWait();
    try {
      const ready = await waitForLifecycleReady(actions, attempt);
      if (!ready.ok) { setError(ready.error); return; }
      const current = ready.session;
      if (item ? !current.items[item]?.removed_at : !current.topics[topic]?.removed_at) {
        setError('This work has already changed. View the bin and try again.'); return;
      }
      onRemove(item ? { kind: 'item', item: { ...route, item_id: item } } : { kind: 'topic', session: route, topic_id: topic });
    } finally { pending.current = null; running.current = false; if (!attempt.cancelled) setBusy(false); }
  };
  return <div className="agent-bin" data-agent-bin={topicId ?? 'topics'}>
    <button type="button" className="btn btn-ghost agent-bin-fold" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <i className={open ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />Removed by agent · {count}</button>
    {operation.pending && error && <p role="alert">{error}</p>}
    {open && <div className="agent-bin-entries">{entries.map(entry => {
      const ids = new Set(entry.items.map(item => item?.id));
      const cancelled = Object.values(session.inputs).filter(input => input?.kind !== 'removed' && input?.state === 'cancelled' && input.cancel_cause === 'agent_removed'
        && (entry.itemId ? !!input.target.item_id && ids.has(input.target.item_id) : input.target.topic_id === entry.topicId));
      const held = heldInputs(session).filter(input => entry.itemId ? !!input.target.item_id && ids.has(input.target.item_id) : input.target.topic_id === entry.topicId);
      const rounds = Object.values(session.rounds).filter(round => round && ids.has(round.item_id));
      const roundIds = new Set(rounds.map(round => round!.id));
      const messageIds = new Set(rounds.flatMap(round => [round!.opened_message_id, ...round!.owner_message_ids, ...round!.agent_message_ids]));
      const conversation = session.messages.filter(message => message.kind !== 'lifecycle' && (entry.itemId
        ? message.item_id && ids.has(message.item_id) || message.items_touched.some(id => ids.has(id)) || messageIds.has(message.id) || message.round_id && roundIds.has(message.round_id)
        : message.topic_id === entry.topicId || message.item_id && ids.has(message.item_id) || messageIds.has(message.id)))
        .sort((left, right) => left.number - right.number);
      return <div className="agent-bin-entry" key={entry.itemId ?? entry.topicId}>
        <span className="agent-bin-name">{entry.name}{entry.items.length > 1 ? ` · ${entry.items.length} items` : ''}</span>
        <button type="button" className="btn btn-ghost" disabled={busy || operation.writing || !!operation.pending} onClick={() => { void restore(entry.topicId, entry.itemId); }}>Restore</button>
        <button type="button" className="btn btn-ghost" disabled={busy || operation.writing || !!operation.pending} onClick={() => { void remove(entry.topicId, entry.itemId); }}>Delete forever</button>
        <div className="agent-bin-work">{entry.items.map(item => item && <div className="agent-bin-item" key={item.id}>
          <span className="agent-bin-status">{STATUS[statusKey[item.status]].label}</span>
          <p>{item.question}</p>
          {item.ask && item.ask !== item.question && <p>{item.ask}</p>}
          {item.note && <p>{item.note}</p>}
          {item.outcome && <p>{item.outcome}</p>}
          {item.why && <p>{item.why}</p>}
          {!!item.options.length && <ul>{item.options.map(option => <li key={option.id}>{option.label}</li>)}</ul>}
        </div>)}</div>
        {cancelled.map(input => <p className="agent-bin-cancelled" key={input!.id}>Cancelled unsent message: {input!.payload.text}</p>)}
        {held.map(input => <p className="agent-bin-held" key={input.id}>Held — sends if you restore: {input.payload.text}</p>)}
        {!!conversation.length && <section className="agent-bin-conversation" aria-label="Retained conversation">
          <h3>Conversation</h3>
          {conversation.map(message => <div className="agent-bin-message" key={message.id}>
            <span className="agent-bin-status">{message.author === 'owner' ? 'You' : message.author === 'agent' ? 'The agent' : 'Ariadne'}</span>
            <p>{message.body}</p>
          </div>)}
        </section>}
      </div>;
    })}</div>}
    {restoreConfirmation.dialog}
  </div>;
}
