import { useSyncExternalStore } from 'react';
import type { Item } from '../../generated/domain/models';
import { CoreFailure, plainFailure, type RendererService } from '../../data';
import type { Immutable } from '../../data/session-store';
import type { SessionActions } from '../../components/bindings/actions';
import { ackTarget } from '../../selectors/ack';
import { notices } from '../pages/notices';
import { toasts } from '../shell/toast';
import { navigationVisits } from '../navigation/visits';
import { isViewConflict } from './conflictNotice';
import { shortLabel } from './short';
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
  /**
   * A view that is mounted and would draw "✓ Acked · Undo" for these items says so, and calls the returned function when it
   * goes away. While an item is held and nothing shows it, a toast carries the Undo; the toast leaves when a view shows it again.
   */
  showing(itemIds: Iterable<string>): () => void;
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
  /** Views drawing each item's Undo right now, counted. */
  private readonly shown = new Map<string, number>();
  /** Items whose Undo is carried by a notice at the moment. */
  private readonly announced = new Set<string>();
  /** Items whose save failed and was tried again from the notice: their success says so in a toast. */
  private readonly retried = new Set<string>();
  /** The items inside their 6 s window. A new set only when it changes, so subscribers can compare by identity. */
  held: ReadonlySet<string> = NO_ITEMS;
  constructor(readonly actions: SessionActions) {}
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Items a single Ack owns, in their window or being saved. Ack all leaves these out. */
  claimed = (): ReadonlySet<string> => new Set(this.entries.keys());
  private publish() {
    const holding = [...this.entries].filter(([, entry]) => !entry.saving).map(([id]) => id);
    this.held = holding.length ? new Set(holding) : NO_ITEMS;
    this.reconcile();
    this.listeners.forEach(listener => listener());
    registryListeners.forEach(listener => listener());
  }
  /** Every held item has an Undo somewhere: in a view that shows it, else in the toast (E19). */
  private reconcile() {
    for (const [id, entry] of this.entries) {
      const unshown = !entry.saving && !(this.shown.get(id) ?? 0);
      if (unshown && !this.announced.has(id)) {
        this.announced.add(id);
        // The producer owns Undo's life: save() and undo() end it with toasts.expire.
        toasts.show({ id: this.heldNoticeId(id), text: `Acked “${shortLabel(entry.reviewed)}”`, ms: ACK_HOLD_MS, undo: () => { this.undo(id); } });
      } else if (!unshown && this.announced.has(id)) {
        this.announced.delete(id);
        if (entry.saving) toasts.expire(this.heldNoticeId(id)); else toasts.dismiss(this.heldNoticeId(id));
      }
    }
    for (const id of [...this.announced]) if (!this.entries.has(id)) { this.announced.delete(id); toasts.expire(this.heldNoticeId(id)); }
  }
  readonly showing = (itemIds: Iterable<string>) => {
    const ids = [...itemIds];
    ids.forEach(id => this.shown.set(id, (this.shown.get(id) ?? 0) + 1));
    this.reconcile();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) { const left = (this.shown.get(id) ?? 1) - 1; if (left > 0) this.shown.set(id, left); else this.shown.delete(id); }
      this.reconcile();
    };
  };
  private noticeId(itemId: string) {
    const route = this.actions.session.getSnapshot().route;
    return JSON.stringify(['item-ack', route.project_id, route.session_id, itemId]);
  }
  private refuse(itemId: string, text: string, retry?: Immutable<Item>) {
    notices.push({ id: this.noticeId(itemId), icon: 'ph ph-warning-circle', tone: 'problem', dismissible: true, text,
      // SPEC 11.1: a save that definitely failed can be tried again; the toast "Saved your Ack on “x”." follows the retry's save.
      ...(retry ? { actions: [{ label: 'Try again', dismissOnRun: true, run: () => { this.retried.add(itemId); this.ack(retry); if (!this.entries.has(itemId)) this.retried.delete(itemId); } }] } : {}) });
  }
  /** A failed save offers Try again unless the controller holds an uncertain write, which only its exact retry may settle. */
  private retryable(reviewed: Immutable<Item>) { return this.actions.getSnapshot().pending ? undefined : reviewed; }
  /** Where no row or Details shows the held Ack, this toast is the owner's only Undo. */
  private heldNoticeId(itemId: string) { return JSON.stringify(['ack-held', this.noticeId(itemId)]); }
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
    toasts.dismiss(this.heldNoticeId(itemId));
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
    // The Undo window is over; the toast's text stays until its display time ends.
    toasts.expire(this.heldNoticeId(id));
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
      if (saved) {
        navigationVisits.record(this.actions.session.getSnapshot().route, id, 'acked');
        if (this.retried.delete(id)) toasts.show({ text: `Saved your Ack on “${shortLabel(reviewed)}”.` });
      } else if (failure && !isViewConflict(failure)) this.refuse(id, ackFailure(failure), this.retryable(reviewed));
    } catch (failure) { this.refuse(id, ackFailure(failure), this.retryable(reviewed)); }
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
