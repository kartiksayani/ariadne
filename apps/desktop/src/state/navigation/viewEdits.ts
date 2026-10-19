// The Map's queued view edits, per session (E12). An owner view change (a fold, a chip, Focus, the selection, the reading
// position) made while another preferences write is unsettled queues here, outside the Map, so it survives the Map going
// (a session switch, leaving for a page) and lands once that write settles. Each session has one effective view: its saved
// view plus the edits in flight plus the edits queued, so a Map drawn again before the write settles shows what the owner
// chose, never the older saved view. App quit loses what is not yet written; a write is never half-applied.
import { useSyncExternalStore } from 'react';
import type { Immutable } from '../../data/session-store';
import type { SessionPreferences, SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import { itemRemoved } from '../../selectors/removed';
import { notices } from '../../ui/pages/notices';
import type { NavigationStore } from './store';

/** Changes the saved view in place; applied to whatever saved view is current when it is written (rebased). */
export type ViewChange = (next: SessionPreferences) => void;
/** What an edit is about: an edit whose topic or item has gone from the session by the time it is written is dropped. */
export interface ViewSubject { readonly topicId?: string; readonly itemId?: string }

interface Edit { readonly change: ViewChange; readonly subject?: ViewSubject; readonly done: (saved: boolean) => void }
interface Lane {
  readonly session: SessionRef;
  queued: Edit[];
  /**
   * The edits of the write in flight. `committed` is set by the receipt just before its saved view publishes, so they leave
   * the effective view in that same update (a toggle is never applied twice). `uncertain`: the write's outcome is unknown
   * and navigation keeps its exact command for Check again; it resolves when navigation is idle again.
   */
  writing: { readonly edits: Edit[]; committed: boolean; uncertain: boolean } | null;
  /** A failed write waits here until another write settles, the saved preferences move or the owner edits again. */
  parked: boolean;
  version: number;
  cache: { readonly saved: Immutable<SessionPreferences>; readonly version: number; readonly value: Immutable<SessionPreferences> } | null;
}

const keyOf = (session: SessionRef) => JSON.stringify([session.project_id, session.session_id]);
const sameRoute = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
export const VIEW_SAVE_FAILED = 'tree-view-save-failed';

export class ViewEdits {
  private readonly lanes = new Map<string, Lane>();
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private flight = false;
  private scheduled = false;
  /** One clock for every lane: a version is never seen twice, even across a lane that went and came back. */
  private clock = 0;
  private wasBusy = false;
  private revision: number | null = null;

  constructor(private readonly navigation: NavigationStore) {}

  readonly subscribe = (receive: () => void) => {
    this.listeners.add(receive);
    return () => { this.listeners.delete(receive); };
  };
  /** Changes whenever a session's queued or in-flight edits change. */
  readonly version = (session: SessionRef) => this.lanes.get(keyOf(session))?.version ?? 0;
  /** The edits not yet confirmed for the session: queued, or in flight. */
  readonly pending = (session: SessionRef) => {
    const lane = this.lanes.get(keyOf(session));
    return lane ? lane.queued.length + (lane.writing && !lane.writing.committed ? lane.writing.edits.length : 0) : 0;
  };

  /** Queues an edit to the session's view; resolves true once a write carrying it is confirmed, false when it is dropped. */
  queue(session: SessionRef, change: ViewChange, subject?: ViewSubject): Promise<boolean> {
    if (this.navigation.getNavigationIntent() === null) return Promise.resolve(false);
    const key = keyOf(session);
    let lane = this.lanes.get(key);
    if (!lane) { lane = { session, queued: [], writing: null, parked: false, version: 0, cache: null }; this.lanes.set(key, lane); }
    const queued = lane;
    const done = new Promise<boolean>(resolve => { queued.queued.push({ change, subject, done: resolve }); });
    // The owner editing again is a new attempt for a write that failed.
    lane.parked = false;
    this.changed(lane);
    this.watch();
    // The flush starts once this task's edits are all in: one write for them, and a write the same click started first
    // (the Recent trail's) goes first, as before.
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.pump(); }); }
    return done;
  }

  /**
   * The session's effective view: the saved view, plus the edits in flight (until the receipt confirms them), plus those
   * queued, in order. The same object while nothing changes, so a Map drawn from it never re-renders for nothing.
   */
  view(session: SessionRef, saved: Immutable<SessionPreferences> | null): Immutable<SessionPreferences> | null {
    const lane = this.lanes.get(keyOf(session));
    const writing = lane?.writing && !lane.writing.committed ? lane.writing.edits : [];
    if (!saved || !lane || !writing.length && !lane.queued.length) return saved;
    if (lane.cache?.saved === saved && lane.cache.version === lane.version) return lane.cache.value;
    const next = structuredClone(saved) as SessionPreferences;
    [...writing, ...lane.queued].forEach(edit => edit.change(next));
    lane.cache = { saved, version: lane.version, value: next };
    return next;
  }

  private changed(lane: Lane, notify = true) {
    lane.version = ++this.clock;
    if (notify) this.listeners.forEach(receive => receive());
  }
  private watch() {
    if (this.unsubscribe) return;
    const state = this.navigation.getSnapshot();
    this.wasBusy = state.writing || state.pendingOperationId !== null;
    this.revision = state.preferences?.revision ?? null;
    this.unsubscribe = this.navigation.subscribe(this.pump);
  }
  private forget(lane: Lane) {
    if (lane.queued.length || lane.writing) return;
    this.lanes.delete(keyOf(lane.session));
    if (!this.lanes.size && this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
  }
  private unpark() {
    for (const lane of this.lanes.values()) lane.parked = false;
  }
  private session(session: SessionRef): Immutable<Session> | null {
    const state = this.navigation.opened.get(session)?.getSnapshot();
    return state?.status === 'ready' ? state.snapshot?.session ?? null : null;
  }
  /** An edit about a topic or item the session no longer has (removed meanwhile) is dropped, not written. */
  private gone(edit: Edit, session: Immutable<Session> | null): boolean {
    const subject = edit.subject;
    if (!subject || !session) return false;
    if (subject.topicId) { const topic = session.topics[subject.topicId]; if (!topic || topic.removed_at) return true; }
    return !!subject.itemId && (!session.items[subject.itemId] || itemRemoved(session, subject.itemId));
  }

  /** Writes the oldest session's queued edits, in order, once no other preferences write is unsettled. */
  private readonly pump = () => {
    const state = this.navigation.getSnapshot(), busy = state.writing || state.pendingOperationId !== null;
    // Another write settling, or the saved preferences moving, is the next try for a write that failed.
    if (this.wasBusy && !busy) this.unpark();
    this.wasBusy = busy;
    const revision = state.preferences?.revision ?? null;
    if (revision !== this.revision) { this.revision = revision; this.unpark(); }
    if (busy || this.flight) return;
    // An unknown outcome kept for Check again settles here: committed (its receipt came), or not (it was rejected).
    for (const lane of this.lanes.values()) if (lane.writing?.uncertain) this.settle(lane, lane.writing.committed);
    if (this.navigation.getNavigationIntent() === null || !state.preferences) return;
    for (const lane of this.lanes.values()) {
      if (lane.parked || lane.writing || !lane.queued.length) continue;
      const saved = state.preferences.sessions.find(view => sameRoute(view.session, lane.session));
      const session = this.session(lane.session);
      const edits = saved ? lane.queued.filter(edit => !this.gone(edit, session)) : [];
      lane.queued.filter(edit => !edits.includes(edit)).forEach(edit => edit.done(false));
      lane.queued = [];
      if (!saved || !edits.length) { this.changed(lane); this.forget(lane); continue; }
      const next = structuredClone(saved) as SessionPreferences;
      edits.forEach(edit => edit.change(next));
      const writing = { edits, committed: false, uncertain: false };
      lane.writing = writing;
      this.flight = true;
      this.changed(lane);
      void this.navigation.saveSessionView(next, state.preferences.revision, () => {
        // Silent: the saved view publishes right after this, and that one update draws the Map without these edits.
        writing.committed = true;
        this.changed(lane, false);
        queueMicrotask(() => this.listeners.forEach(receive => receive()));
      }).then(written => {
        this.flight = false;
        const now = this.navigation.getSnapshot();
        if (written || writing.committed) this.settle(lane, true);
        // The outcome is unknown and navigation keeps the exact command: wait for it, showing the edits meanwhile.
        else if (now.pendingOperationId !== null && !now.writing && !this.navigation.isRecentPending()) writing.uncertain = true;
        // Another writer won admission: these edits go first once it settles, as no failure.
        else if (now.writing) this.requeue(lane, false);
        else this.requeue(lane, true);
        this.pump();
      });
      return;
    }
  };
  private settle(lane: Lane, saved: boolean) {
    if (!saved) { this.requeue(lane, true); return; }
    const edits = lane.writing?.edits ?? [];
    lane.writing = null;
    this.changed(lane);
    edits.forEach(edit => edit.done(true));
    this.forget(lane);
  }
  /** The write's edits go back to the head of the queue; the effective view keeps showing them, so nothing on the Map moves. */
  private requeue(lane: Lane, failed: boolean) {
    const edits = lane.writing?.edits ?? [];
    lane.writing = null;
    lane.queued = [...edits, ...lane.queued];
    if (failed) {
      lane.parked = true;
      notices.push({ id: VIEW_SAVE_FAILED, icon: 'ph ph-warning-circle', text: 'The view preference could not be saved. Try again.' });
    }
    this.changed(lane);
  }
}

const stores = new WeakMap<NavigationStore, ViewEdits>();
/** The one edits store of a navigation store: it outlives every Map drawn from it. */
export function viewEditsFor(navigation: NavigationStore): ViewEdits {
  let edits = stores.get(navigation);
  if (!edits) { edits = new ViewEdits(navigation); stores.set(navigation, edits); }
  return edits;
}
/** Re-renders on the session's edits; read its effective view with `view`. */
export function useViewEdits(edits: ViewEdits, session: SessionRef): number {
  return useSyncExternalStore(edits.subscribe, () => edits.version(session), () => edits.version(session));
}
