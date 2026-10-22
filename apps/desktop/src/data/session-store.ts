import { useSyncExternalStore } from 'react';
import type { PresenceChangedHint, SessionChangedHint, SessionListResult, SessionRef, SessionSnapshot } from '../generated/core';
import type { PresenceObservation, QueryCursor } from '../generated/domain/models';
import { CoreFailure, ServiceFailure, type RendererService, type Unsubscribe } from './service';
import { changesNothing, sameFailure, sameValue } from './same';

export type Immutable<T> = T extends readonly (infer V)[] ? readonly Immutable<V>[]
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export interface SessionState {
  readonly route: Immutable<SessionRef>;
  readonly snapshot: Immutable<SessionSnapshot> | null;
  readonly presence: Readonly<Record<string, Immutable<PresenceObservation>>>;
  readonly status: 'loading' | 'ready' | 'stale' | 'inaccessible' | 'closed';
  readonly error: CoreFailure | ServiceFailure | null;
}
export function immutable<T>(value: T): Immutable<T> {
  const copy = structuredClone(value);
  function freeze(object: unknown): void {
    if (!object || typeof object !== 'object' || Object.isFrozen(object)) return;
    Object.values(object).forEach(freeze);
    Object.freeze(object);
  }
  freeze(copy);
  return copy as Immutable<T>;
}

export class SessionStore {
  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private unlisten: Unsubscribe[] = [];
  private setup: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private requested = false;
  private closed = false;
  private hintedRevision = 0;
  private readonly presenceVersions = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly reconcile = () => { void this.refresh(); };
  private readonly visibility = () => { if (document.visibilityState === 'visible') this.reconcile(); };

  constructor(private readonly service: RendererService, route: SessionRef) {
    this.state = Object.freeze({ route: immutable(route), snapshot: null, presence: Object.freeze({}), status: 'loading', error: null });
    this.timer = setInterval(this.reconcile, 2000);
    window.addEventListener('focus', this.reconcile);
    window.addEventListener('pageshow', this.reconcile);
    document.addEventListener('visibilitychange', this.visibility);
  }
  readonly getSnapshot = (): SessionState => this.state;
  readonly subscribe = (receive: () => void): Unsubscribe => {
    this.listeners.add(receive);
    return () => { this.listeners.delete(receive); };
  };
  /**
   * Equality contract (alpha.23 F6): this store publishes only a real change. A poll that read the same data publishes
   * nothing and keeps the state, `snapshot` and `presence` objects (and so every `item` inside the snapshot) exactly as
   * they were, by identity. Something real is a new revision, `freshness`, `status`, `error`, or a presence entry whose
   * content changed; each publishes once. Rows built from this state may rely on that identity.
   *
   * `snapshot` itself is a new object on more than a new revision: also when `freshness` changes and on the first good
   * read after a failed one (the recovery), both over the same `snapshot.session`. So derived rows (and anything built
   * from the items) must key on `snapshot.session` or the items inside it, never on `snapshot`, or they rebuild on a
   * freshness flip or a recovery that changed none of their data.
   */
  private publish(update: Partial<SessionState>): void {
    if (this.closed || changesNothing(this.state, update)) return;
    this.state =Object.freeze({ ...this.state, ...update });
    this.listeners.forEach((receive) => receive());
  }
  private changed = (hint: SessionChangedHint): void => {
    if (this.closed || hint.session_id !== this.state.route.session_id
        || !Number.isSafeInteger(hint.revision) || hint.revision <= 0
        || hint.revision <= (this.state.snapshot?.session.revision ?? 0)
        || hint.revision <= this.hintedRevision) return;
    this.hintedRevision = hint.revision;
    this.publish({ status: 'stale' });
    this.requested = true;
    this.reconcile();
  };
  private observed = (hint: PresenceChangedHint): void => {
    const binding = this.state.snapshot?.session.bindings[hint.binding_id];
    if (this.closed || !binding || !hint.observation
        || this.state.snapshot?.session.active_binding_id !== hint.binding_id
        || hint.generation !== hint.observation.generation || hint.generation !== binding.generation) return;
    const previous = this.state.presence[hint.binding_id];
    if (previous && sameValue(previous, hint.observation)) return;
    if (previous?.instance_id === hint.observation.instance_id) {
      const previousAt = previous.last_seen_at ? Date.parse(previous.last_seen_at) : -Infinity;
      const nextAt = hint.observation.last_seen_at ? Date.parse(hint.observation.last_seen_at) : -Infinity;
      if (nextAt < previousAt || (nextAt === previousAt && hint.observation.freshness === 'fresh')) return;
    }
    this.presenceVersions.set(hint.binding_id, (this.presenceVersions.get(hint.binding_id) ?? 0) + 1);
    this.publish({ presence: Object.freeze({ ...this.state.presence, [hint.binding_id]: immutable(hint.observation) }) });
  };
  private async seedPresence(snapshot: SessionSnapshot): Promise<void> {
    const id = snapshot.session.active_binding_id, binding = id ? snapshot.session.bindings[id] : null;
    if (!id || !binding || binding.dispatch_state === 'disconnected') return;
    const version = this.presenceVersions.get(id) ?? 0;
    let cursor: QueryCursor | null = null;
    // The canonical list is paged at its existing bound. Stop at this session;
    // never load unrelated domain snapshots or accumulate the whole project.
    for (;;) {
      const result: SessionListResult = await this.service.query({ session: null, request: { command: 'session_list', params: {
        project_id: this.state.route.project_id, state: null, cursor, limit: 100,
      } } });
      if (this.closed || this.requested || this.state.snapshot?.session.active_binding_id !== id
          || this.state.snapshot.session.bindings[id]?.generation !== binding.generation
          || (this.presenceVersions.get(id) ?? 0) !== version) return;
      const page = result?.sessions;
      if (!page || !Array.isArray(page.items)) return;
      const summary = page.items.find(value => value.project_id === this.state.route.project_id && value.session_id === this.state.route.session_id);
      if (summary) {
        const selected = summary.active_binding;
        if (selected?.id === id && selected.generation === binding.generation && selected.presence) {
          this.observed({ binding_id: id, generation: binding.generation, observation: selected.presence });
        }
        return;
      }
      if (!page.next_cursor || JSON.stringify(page.next_cursor) === JSON.stringify(cursor)) return;
      cursor = page.next_cursor;
    }
  }
  private ensureSubscriptions(): Promise<void> {
    if (this.setup) return this.setup;
    this.setup = (async () => {
      const results = await Promise.allSettled([
        this.service.subscribe('ariadne://session_changed', this.changed),
        this.service.subscribe('ariadne://presence_changed', this.observed),
      ]);
      const subscriptions = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (this.closed || results.some((result) => result.status === 'rejected')) {
        subscriptions.forEach((unsubscribe) => unsubscribe());
        if (!this.closed) throw new ServiceFailure('transport');
      } else {
        this.unlisten = subscriptions;
      }
    })().catch((error: unknown) => {
      this.setup = null;
      throw error;
    });
    return this.setup;
  }
  refresh(afterCurrent = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) {
      if (afterCurrent) this.requested = true;
      return this.flight;
    }
    this.requested = true;
    this.flight = this.load().finally(() => { this.flight = null; });
    return this.flight;
  }
  private async load(): Promise<void> {
    while (this.requested && !this.closed) {
      this.requested = false;
      try {
        await this.ensureSubscriptions();
        if (this.closed) return;
        this.requested = false;
        const snapshot = await this.service.query({ session: this.state.route, request: { command: 'session_get', params: {} } });
        if (this.closed) return;
        const revision = snapshot?.session?.revision;
        if (!Number.isSafeInteger(revision) || revision <= 0
            || snapshot.session.id !== this.state.route.session_id || snapshot.session.project_id !== this.state.route.project_id
            || revision < (this.state.snapshot?.session.revision ?? 0)) {
          throw new ServiceFailure('invalid_response');
        }
        const entries = Object.entries(this.state.presence).filter(([id, observation]) =>
          snapshot.session.active_binding_id === id && snapshot.session.bindings[id]?.generation === observation.generation
          && snapshot.session.bindings[id]?.dispatch_state !== 'disconnected');
        // The entries are the stored observations, so an unchanged map keeps the published object.
        const presence = entries.length === Object.keys(this.state.presence).length ? this.state.presence
          : Object.freeze(Object.fromEntries(entries));
        const previous = this.state.snapshot;
        // Durable contents change with the canonical session revision. Keep the immutable session identity when polling
        // only refreshes qualification, and the whole snapshot when its freshness is unchanged too. The first good read after
        // a failed one is a new capture, though: it gets a new snapshot object (same session), because App clears a "still
        // loading" refusal only on a capture that differs from the one it was reported against.
        const recovered = this.state.error !== null;
        const next = previous && previous.session.revision === revision
          ? previous.freshness === snapshot.freshness && !recovered ? previous : Object.freeze({ session: previous.session, freshness: snapshot.freshness })
          : immutable(snapshot);
        // A poll that changes nothing publishes nothing. While the read is fresh it is still a good read, so re-stamp it.
        // A read that stays stale is not: "the last good copy" must not move, or it would jump on an unrelated redraw.
        if (snapshot.freshness === 'fresh' || next !== previous) stampRead(next);
        this.publish({ snapshot: next, presence, error: null,
          status: revision < this.hintedRevision || snapshot.freshness !== 'fresh' ? 'stale' : 'ready' });
        // Presence is volatile and separate from durable session freshness. A
        // failed seed keeps the actual snapshot; later refresh/live hints recover.
        try { await this.seedPresence(snapshot); } catch { /* retain known facts */ }
      } catch (error: unknown) {
        const failure = error instanceof CoreFailure || error instanceof ServiceFailure ? error : new ServiceFailure('transport');
        const inaccessible = failure instanceof CoreFailure && ['permission_denied', 'not_found', 'io_error'].includes(failure.error.code);
        // The same failure again keeps the one already shown.
        this.publish({ status: inaccessible || !this.state.snapshot ? 'inaccessible' : 'stale',
          error: sameFailure(this.state.error, failure) ? this.state.error : failure });
      }
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    window.removeEventListener('focus', this.reconcile);
    window.removeEventListener('pageshow', this.reconcile);
    document.removeEventListener('visibilitychange', this.visibility);
    this.unlisten.forEach((unsubscribe) => unsubscribe());
    this.unlisten = [];
    this.state = Object.freeze({ ...this.state, status: 'closed' });
    this.listeners.forEach((receive) => receive());
    this.listeners.clear();
  }
}

const readTimes = new WeakMap<object, number>();
/**
 * When this read of the session was taken. The store stamps each read as it publishes it, so "the last good copy, from 21:24"
 * names the read and not the moment something first drew it; a snapshot built elsewhere is stamped by its first ask.
 */
export function readAt(snapshot: object): number {
  let at = readTimes.get(snapshot);
  if (at === undefined) { at = Date.now(); readTimes.set(snapshot, at); }
  return at;
}
/**
 * Stamps a read now, replacing an earlier stamp. The store calls it for every fresh read, including a poll that found
 * nothing new and so publishes the same snapshot object again: "the last good copy, from 21:24" must name that read.
 * A read that stays stale, or is new, is stamped only when it publishes a changed state.
 */
export function stampRead(snapshot: object, at = Date.now()): void {
  readTimes.set(snapshot, at);
}

export class OpenSessions {
  private readonly stores = new Map<string, SessionStore>();
  constructor(private readonly service: RendererService) {}
  get(route: SessionRef): SessionStore | undefined {
    return this.stores.get(JSON.stringify([route.project_id, route.session_id]));
  }
  open(route: SessionRef): SessionStore {
    const key = JSON.stringify([route.project_id, route.session_id]);
    const existing = this.stores.get(key);
    if (existing) return existing;
    const store = new SessionStore(this.service, route);
    this.stores.set(key, store);
    void store.refresh();
    return store;
  }
  close(route: SessionRef): void {
    const key = JSON.stringify([route.project_id, route.session_id]);
    this.stores.get(key)?.close();
    this.stores.delete(key);
  }
  closeAll(): void {
    this.stores.forEach((store) => store.close());
    this.stores.clear();
  }
}
export function useSession(store: SessionStore): SessionState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
