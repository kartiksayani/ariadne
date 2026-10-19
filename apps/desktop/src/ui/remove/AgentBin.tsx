// The agent's removals: the bin request a strip, menu or notice makes, Restore with its held-message confirmation, and
// notice 11.3's words. The bin itself is a dialog (BinDialog, 10.11).
import { useEffect, useRef, useState } from 'react';
import type { AgentRemoval, Session } from '../../generated/domain/models';
import type { SessionRef } from '../../generated/core';
import { plainFailure, type Immutable } from '../../data';
import type { SessionActions } from '../../components/bindings/actions';
import { heldInputsRestored, itemRemoved } from '../../selectors/removed';
import { waitForLifecycleReady } from '../shared/lifecycleReady';
import { shortLabel } from '../shared/short';
import { Dialog } from '../dialogs/Dialog';

const keyOf = (route: SessionRef, topicId: string | null) => JSON.stringify([route.project_id, route.session_id, topicId]);
/** A View notice can open a bin after navigation mounts its session. */
class BinView {
  private value: { key: string; sequence: number } = { key: '', sequence: 0 };
  private listeners = new Set<() => void>();
  readonly getSnapshot = () => this.value;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private wanted: { readonly route: SessionRef; readonly topicId: string | null } | null = null;
  reveal(route: SessionRef, topicId: string | null) {
    this.wanted = { route, topicId };
    this.value = { key: keyOf(route, topicId), sequence: this.value.sequence + 1 }; this.listeners.forEach(listener => listener());
  }
  /** The bin asked for in `route` and not yet opened: taking it opens it once, so a remount never reopens it. */
  take(route: SessionRef): { readonly topicId: string | null } | null {
    const wanted = this.wanted;
    if (!wanted || wanted.route.project_id !== route.project_id || wanted.route.session_id !== route.session_id) return null;
    this.wanted = null;
    return { topicId: wanted.topicId };
  }
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
  /** The held-message confirmation waiting on the owner, for a dialog that shows it as its own step. */
  return { restore, dialog, confirmation };
}

/** Notice 11.3: "Claude Code removed “x” and its work (3 items). 1 unsent message was cancelled; your words are kept in the bin." */
export function removalNotice(session: Immutable<Session>, removal: Immutable<AgentRemoval>, agent = 'The agent'): string {
  const name = removal.item_id ? session.items[removal.item_id] ? shortLabel(session.items[removal.item_id]!) : 'an item' : session.topics[removal.topic_id]?.name ?? 'a topic';
  const work = removal.item_id ? removal.item_ids.length > 1 : removal.item_ids.length > 0;
  const cancelled = removal.cancelled_input_ids.length;
  return `${agent} removed “${name}”${work ? ` and its work (${removal.item_ids.length} item${removal.item_ids.length === 1 ? '' : 's'})` : ''}.`
    + (removal.waiting_questions ? ` ${removal.waiting_questions} waiting question${removal.waiting_questions === 1 ? '' : 's'} left your panel.` : '')
    + (cancelled ? ` ${cancelled} unsent message${cancelled === 1 ? ' was' : 's were'} cancelled; your words are kept in the bin.` : '');
}
