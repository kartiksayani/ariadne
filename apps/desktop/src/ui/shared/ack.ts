import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Item } from '../../generated/domain/models';
import { CoreFailure, plainFailure, type RendererService } from '../../data';
import type { Immutable } from '../../data/session-store';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { ackTarget } from '../../selectors/ack';
import { notices } from '../pages/notices';
import { navigationVisits } from '../navigation/visits';
import { isViewConflict } from './conflictNotice';
import { STATUS, statusKey } from './status';

export { ackTarget } from '../../selectors/ack';
export const ackTitle = (target: NonNullable<Item['ack_to']>, status: Item['status']) => `Ack → ${target === status && target === 'open'
  ? 'keeps it open' : target === status && target === 'in_progress' ? 'keeps it in progress' : STATUS[statusKey[target]].label}`;

class AckUnavailable extends Error {}
/** The held proposal is not the item's proposal any more: nothing was saved and the item stays to ack. */
class AckChanged extends AckUnavailable { constructor() { super('Not acked: it changed'); } }
/** Everything an Ack acts on. Two Acks agree when the owner read the same words on the same revision. */
export const ackProposal = (item: Immutable<Item>) => JSON.stringify([item.revision, item.type, item.topic_id,
  item.question, item.ask, item.ack_to, item.outcome, item.why]);
/** A manual Ack changes only the reviewed result's acknowledgement state. */
export function alreadyAcknowledged(item: Immutable<Item>, reviewed: Immutable<Item>): boolean {
  const terminal = ['decided', 'done', 'dropped'].includes(reviewed.ack_to!);
  return item.revision === reviewed.revision + 1 && item.ack_to == null && item.status === reviewed.ack_to
    && item.type === reviewed.type && item.topic_id === reviewed.topic_id
    && item.question === reviewed.question && item.ask === reviewed.ask
    && item.outcome === (terminal ? reviewed.outcome ?? 'Acknowledged by the owner.' : reviewed.outcome)
    && item.why === (terminal ? reviewed.why ?? 'The owner read this item.' : reviewed.why);
}
const ackRefusal = 'This item can’t be acknowledged now. Check its current status and any question waiting for you.';
const archivedRefusal = 'This session is archived. Restore it, then reopen it to acknowledge this item.';
const waiting = new WeakMap<SessionActions, { readonly cancelled: () => boolean }>();
export const ackWaiting = (actions: SessionActions) => { const attempt = waiting.get(actions); return !!attempt && !attempt.cancelled(); };
export const ackBlocked = (actions: SessionActions): string | null => {
  const state = actions.getSnapshot();
  if (state.writing) return 'Another change is being saved. Wait for it, then try Ack again.';
  if (state.pending) return 'Ariadne isn’t sure your last change was saved. Check again before trying Ack.';
  return ackWaiting(actions) ? 'Another change is being saved. Wait for it, then try Ack again.' : null;
};

export function ackFailure(failure: unknown): string {
  if (failure instanceof AckUnavailable) return failure.message;
  if (failure instanceof CoreFailure && failure.error.code === 'invalid_transition' && failure.error.message === archivedRefusal) return archivedRefusal;
  return failure instanceof CoreFailure && failure.error.code === 'invalid_transition'
    ? 'This item can’t be acknowledged now. Check its current status and any question waiting for you.'
    : plainFailure(failure, 'Ack could not be saved. Try again.');
}

/**
 * The shared action controller keeps uncertain saves available for exact retry.
 * `reviewed` is the proposal the owner read at click time; an item that moved on from it is never saved.
 */
export async function acknowledge(actions: SessionActions, itemId: string, cancelled: () => boolean = () => false,
  reviewed?: Immutable<Item>): Promise<boolean> {
  const blocked = ackBlocked(actions);
  if (blocked) throw new AckUnavailable(blocked);
  const store = actions.session, proposal = reviewed ?? store.getSnapshot().snapshot?.session.items[itemId];
  const attempt = { cancelled };
  waiting.set(actions, attempt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) {
      await Promise.race([
        store.refresh(true),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
      ]);
    }
    if (cancelled()) return false;
    const current = store.getSnapshot(), session = current.snapshot?.session, item = session?.items[itemId];
    if (actions.session !== store || current.status !== 'ready' || current.error || !session) throw new AckUnavailable("Ariadne is still loading this session's latest changes. Try again.");
    if (session.archived_at != null) throw new AckUnavailable(archivedRefusal);
    // A result another Ack already saved (Ack all got there first) is acknowledged: there is nothing left to write.
    if (reviewed && item && alreadyAcknowledged(item, reviewed)) return true;
    if (!item || !ackTarget(session, item)) throw reviewed ? new AckChanged() : new AckUnavailable(ackRefusal);
    const moved = reviewed ? ackProposal(item) !== ackProposal(reviewed)
      : !proposal || item.ack_to !== proposal.ack_to || item.question !== proposal.question || item.ask !== proposal.ask
        || item.outcome !== proposal.outcome || item.why !== proposal.why;
    if (moved) throw reviewed ? new AckChanged() : new AckUnavailable('This item changed. Read its current proposal, then try Ack again.');
    const state = actions.getSnapshot();
    if (state.writing) throw new AckUnavailable('Another change is being saved. Wait for it, then try Ack again.');
    if (state.pending) throw new AckUnavailable('Ariadne isn’t sure your last change was saved. Check again before trying Ack.');
    const saved = await actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: item.id, expected_revision: item.revision } }, session.revision);
    if (!saved && !actions.getSnapshot().error) throw new AckUnavailable('Ack could not be saved. Try again.');
    return saved;
  } finally { clearTimeout(timeout); if (waiting.get(actions) === attempt) waiting.delete(actions); }
}

export const ACK_HOLD_MS = 6000;
const lanes = new WeakMap<SessionActions, { tail: Promise<void>; queued: number }>();
/** Every Ack write of a session runs here, one at a time: single holds and Ack all share this one queue. */
export function ackLane<T>(actions: SessionActions, task: () => Promise<T>): Promise<T> {
  let lane = lanes.get(actions);
  if (!lane) { lane = { tail: Promise.resolve(), queued: 0 }; lanes.set(actions, lane); }
  const own = lane;
  // An idle lane starts the write at once; a busy one starts it when the write before it has finished.
  const run = own.queued === 0 ? task() : own.tail.then(task);
  own.queued++;
  own.tail = run.then(() => undefined, () => undefined).then(() => { own.queued--; });
  return run;
}

export interface AckHold {
  /** Captures the proposal the owner is reading now, shows it held for 6 s, then saves exactly that proposal. */
  ack(item: Immutable<Item>): void;
  /** Cancels a held Ack with no write. Does nothing once the save has started. */
  undo(itemId: string): void;
  /** Saves every held Ack now. Used when the owner leaves the session and when the application closes. */
  flush(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
interface Held { readonly reviewed: Immutable<Item>; timer: ReturnType<typeof setTimeout> | undefined; saving: boolean }
const NO_ITEMS: ReadonlySet<string> = new Set();
const registryListeners = new Set<() => void>();
class SessionAckHold implements AckHold {
  private readonly entries = new Map<string, Held>();
  private readonly running = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  /** The items inside their 6 s window. A new set only when it changes, so subscribers can compare by identity. */
  held: ReadonlySet<string> = NO_ITEMS;
  constructor(readonly actions: SessionActions) {}
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Items a single Ack owns, in their window or being saved. Ack all leaves these out. */
  claimed = (): ReadonlySet<string> => new Set(this.entries.keys());
  private publish() {
    const holding = [...this.entries].filter(([, entry]) => !entry.saving).map(([id]) => id);
    this.held = holding.length ? new Set(holding) : NO_ITEMS;
    this.listeners.forEach(listener => listener());
    registryListeners.forEach(listener => listener());
  }
  private noticeId(itemId: string) {
    const route = this.actions.session.getSnapshot().route;
    return JSON.stringify(['item-ack', route.project_id, route.session_id, itemId]);
  }
  private refuse(itemId: string, text: string) {
    notices.push({ id: this.noticeId(itemId), icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true, text });
  }
  readonly ack = (item: Immutable<Item>) => {
    // A second click on a held or saving item never starts a second Ack.
    if (this.entries.has(item.id)) return;
    const blocked = ackBlocked(this.actions);
    if (blocked) { this.refuse(item.id, blocked); return; }
    const session = this.actions.session.getSnapshot().snapshot?.session, current = session?.items[item.id];
    if (!session) { this.refuse(item.id, "Ariadne is still loading this session's latest changes. Try again."); return; }
    if (session.archived_at != null) { this.refuse(item.id, archivedRefusal); return; }
    if (!current || !ackTarget(session, current)) { this.refuse(item.id, ackRefusal); return; }
    if (ackProposal(current) !== ackProposal(item)) { this.refuse(item.id, new AckChanged().message); return; }
    notices.dismiss(this.noticeId(item.id));
    this.entries.set(item.id, { reviewed: item, saving: false, timer: setTimeout(() => { void this.save(item.id); }, ACK_HOLD_MS) });
    this.publish();
  };
  readonly undo = (itemId: string) => {
    const entry = this.entries.get(itemId);
    if (!entry || entry.saving) return;
    clearTimeout(entry.timer);
    this.entries.delete(itemId);
    this.publish();
  };
  readonly flush = (): Promise<void> => {
    [...this.entries.keys()].forEach(id => { void this.save(id); });
    return Promise.all([...this.running]).then(() => undefined);
  };
  private save(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.saving) return Promise.resolve();
    clearTimeout(entry.timer); entry.timer = undefined; entry.saving = true;
    this.publish();
    const run: Promise<void> = ackLane(this.actions, () => this.write(id, entry.reviewed)).finally(() => {
      this.entries.delete(id); this.running.delete(run); this.publish();
    });
    this.running.add(run);
    return run;
  }
  /** Saves the proposal captured at click time. An item that changed since then is left to ack. */
  private async write(id: string, reviewed: Immutable<Item>) {
    try {
      const saved = await acknowledge(this.actions, id, () => false, reviewed);
      const failure = this.actions.getSnapshot().error;
      if (saved) navigationVisits.record(this.actions.session.getSnapshot().route, id, 'acked');
      else if (failure && !isViewConflict(failure)) this.refuse(id, ackFailure(failure));
    } catch (failure) { this.refuse(id, ackFailure(failure)); }
  }
}
const holds = new WeakMap<SessionActions, SessionAckHold>();
const holdsBySession = new Map<string, SessionAckHold>();
const lifetimes = new WeakMap<RendererService, Set<SessionAckHold>>();
/** The session's hold, registered on first use. Its timers belong to the session, never to a mounted view. */
export function ackHoldFor(sessionId: string, actions: SessionActions): AckHold {
  let hold = holds.get(actions);
  if (!hold) {
    hold = new SessionAckHold(actions); holds.set(actions, hold);
    let lifetime = lifetimes.get(actions.service);
    if (!lifetime) { lifetime = new Set(); lifetimes.set(actions.service, lifetime); }
    lifetime.add(hold);
  }
  const earlier = holdsBySession.get(sessionId);
  if (earlier !== hold) { holdsBySession.set(sessionId, hold); if (earlier) void earlier.flush(); }
  return hold;
}
/** Items inside their 6 s window, for the row's and Details' "✓ Acked · Undo". */
export function useAckHeld(sessionId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    listener => { registryListeners.add(listener); return () => { registryListeners.delete(listener); }; },
    () => holdsBySession.get(sessionId)?.held ?? NO_ITEMS, () => NO_ITEMS);
}
/** Items a single Ack holds or is saving, which Ack all leaves out. */
export const ackClaimed = (actions: SessionActions): ReadonlySet<string> => holds.get(actions)?.claimed() ?? NO_ITEMS;
/** The owner left this session: its held Acks are saved now rather than later. */
export function flushAckHold(sessionId: string): Promise<void> {
  return holdsBySession.get(sessionId)?.flush() ?? Promise.resolve();
}
/** Application-owned teardown waits for held Acks before closing their readers. */
export function stopAckHolds(service: RendererService): Promise<void> {
  const lifetime = lifetimes.get(service);
  if (!lifetime) return Promise.resolve();
  const stopping = [...lifetime];
  return Promise.all(stopping.map(hold => hold.flush())).then(() => { stopping.forEach(hold => lifetime.delete(hold)); });
}
/** Closing the window saves held Acks. A Tree→Graph switch or a hidden window does not. */
export function attachAckHolds(service: RendererService, target: Window = window): () => void {
  const flush = () => { lifetimes.get(service)?.forEach(hold => { void hold.flush(); }); };
  target.addEventListener('pagehide', flush);
  target.addEventListener('beforeunload', flush);
  return () => { target.removeEventListener('pagehide', flush); target.removeEventListener('beforeunload', flush); };
}

export function useAck(actions: SessionActions, selectedId: string | null) {
  const state = useSessionActions(actions);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    ++request.current;
    setError(null);
    setLoading(false);
    return () => { ++request.current; };
  }, [actions, selectedId]);
  useEffect(() => {
    if (state.receipt && 'data' in state.receipt && state.receipt.data.kind === 'item_ack') setError(null);
  }, [state.receipt]);
  return {
    busy: loading || state.writing || !!state.pending,
    error,
    run: async (itemId: string) => {
      const blocked = ackBlocked(actions);
      if (blocked) { setError(blocked); return false; }
      const attempted = ++request.current;
      setError(null);
      setLoading(true);
      try {
        const saved = await acknowledge(actions, itemId, () => attempted !== request.current);
        const failure = actions.getSnapshot().error;
        if (attempted === request.current && !saved && failure) setError(ackFailure(failure));
        return saved;
      } catch (failure) {
        if (attempted === request.current) setError(ackFailure(failure));
        return false;
      } finally { if (attempted === request.current) setLoading(false); }
    },
  };
}
