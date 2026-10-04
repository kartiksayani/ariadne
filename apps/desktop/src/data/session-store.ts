import { useSyncExternalStore } from 'react';
import type { PresenceChangedHint, SessionChangedHint, SessionListResult, SessionRef, SessionSnapshot } from '../generated/core';
import type { PresenceObservation, QueryCursor } from '../generated/domain/models';
import { CoreFailure, ServiceFailure, type RendererService, type Unsubscribe } from './service';

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
  private publish(update: Partial<SessionState>): void {
    if (this.closed) return;
    this.state = Object.freeze({ ...this.state, ...update });
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
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.flight) return this.flight;
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
        const presence = Object.fromEntries(Object.entries(this.state.presence).filter(([id, observation]) =>
          snapshot.session.active_binding_id === id && snapshot.session.bindings[id]?.generation === observation.generation
          && snapshot.session.bindings[id]?.dispatch_state !== 'disconnected'));
        const previous = this.state.snapshot;
        // Durable contents change with the canonical session revision. Keep the
        // immutable session identity when polling only refreshes qualification.
        const next = previous && previous.session.revision === revision
          ? Object.freeze({ session: previous.session, freshness: snapshot.freshness }) : immutable(snapshot);
        this.publish({ snapshot: next, presence: Object.freeze(presence), error: null,
          status: revision < this.hintedRevision || snapshot.freshness !== 'fresh' ? 'stale' : 'ready' });
        // Presence is volatile and separate from durable session freshness. A
        // failed seed keeps the actual snapshot; later refresh/live hints recover.
        try { await this.seedPresence(snapshot); } catch { /* retain known facts */ }
      } catch (error: unknown) {
        const failure = error instanceof CoreFailure || error instanceof ServiceFailure ? error : new ServiceFailure('transport');
        const inaccessible = failure instanceof CoreFailure && ['permission_denied', 'not_found', 'io_error'].includes(failure.error.code);
        this.publish({ status: inaccessible || !this.state.snapshot ? 'inaccessible' : 'stale', error: failure });
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

export class OpenSessions {
  private readonly stores = new Map<string, SessionStore>();
  constructor(private readonly service: RendererService) {}
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
