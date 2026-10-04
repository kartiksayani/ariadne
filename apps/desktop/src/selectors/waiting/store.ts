import { useSyncExternalStore } from 'react';
import type { Page, ProjectSummary, QueryCursor, SessionSummary, SummaryCounts } from '../../generated/domain/models';
import type { ProjectListResult, SessionListResult } from '../../generated/core';
import { CoreFailure, ServiceFailure, immutable, type Immutable, type OpenSessions, type RendererService, type Unsubscribe } from '../../data';
import { sentRows, waitingRows, type SentRow, type WaitingRow, type WaitingSession } from './rows';

export interface WaitingState {
  readonly status: 'loading' | 'ready' | 'stale' | 'unavailable';
  readonly counts: Immutable<SummaryCounts> | null;
  readonly waiting: readonly WaitingRow[];
  readonly sent: readonly SentRow[];
  readonly sessions: readonly WaitingSession[];
  readonly unavailableProjects: readonly Immutable<ProjectSummary>[];
  readonly error: CoreFailure | ServiceFailure | null;
}
async function pages<T>(read: (cursor: QueryCursor | null) => Promise<Page<T>>, view: 'projects' | 'sessions',
  key: (item: T) => string): Promise<readonly T[]> {
  const items: T[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: QueryCursor | null = null, revision: number | undefined, digest: string | undefined;
  do {
    const page = await read(cursor);
    if (!Number.isSafeInteger(page.snapshot_revision) || page.snapshot_revision <= 0 || page.items.length > 100
        || (revision !== undefined && page.snapshot_revision !== revision)) throw new ServiceFailure('invalid_response');
    revision = page.snapshot_revision;
    for (const item of page.items) {
      const id = key(item);
      if (ids.has(id)) throw new ServiceFailure('invalid_response');
      ids.add(id); items.push(item);
    }
    cursor = page.next_cursor;
    if (cursor) {
      const encoded = JSON.stringify(cursor);
      if (!page.items.length || cursor.schema !== 1 || cursor.view !== view || cursor.revision !== revision
          || cursor.after === null || (digest !== undefined && cursor.filter_digest !== digest) || cursors.has(encoded)) {
        throw new ServiceFailure('invalid_response');
      }
      digest = cursor.filter_digest; cursors.add(encoded);
    }
  } while (cursor);
  return items;
}
async function catalogue(service: RendererService, stopped: () => boolean): Promise<{ projects: readonly ProjectSummary[]; result: SessionListResult; sessions: readonly SessionSummary[] }> {
  let projectMetadata: string | undefined, sessionMetadata: string | undefined, result: SessionListResult | undefined;
  const projects = await pages(async cursor => {
    if (stopped()) throw new ServiceFailure('transport');
    const page: ProjectListResult = await service.query({ session: null,
      request: { command: 'project_list', params: { cursor, limit: 100 } } });
    if (stopped()) throw new ServiceFailure('transport');
    const metadata = JSON.stringify(page.counts);
    if (projectMetadata !== undefined && metadata !== projectMetadata) throw new ServiceFailure('invalid_response');
    projectMetadata = metadata;
    return page.projects;
  }, 'projects', project => project.project_id);
  const sessions = await pages(async cursor => {
    if (stopped()) throw new ServiceFailure('transport');
    const page = await service.query({ session: null,
      request: { command: 'session_list', params: { project_id: null, state: null, cursor, limit: 100 } } });
    if (stopped()) throw new ServiceFailure('transport');
    const metadata = JSON.stringify([page.counts, page.active_total, page.closed_total]);
    if (sessionMetadata !== undefined && metadata !== sessionMetadata) throw new ServiceFailure('invalid_response');
    sessionMetadata = metadata; result = page;
    return page.sessions;
  }, 'sessions', session => `${session.project_id}:${session.session_id}`);
  if (!result || projectMetadata !== JSON.stringify(result.counts)) throw new ServiceFailure('invalid_response');
  return { projects, sessions, result };
}

// Composition supplies the shared OpenSessions cache and owns its lifecycle.
// Stopping this reader never closes another screen's registered session store.
export class WaitingStore {
  private state: WaitingState = Object.freeze({ status: 'loading', counts: null, waiting: Object.freeze([]), sent: Object.freeze([]), sessions: Object.freeze([]), unavailableProjects: Object.freeze([]), error: null });
  private readonly listeners = new Set<() => void>();
  private subscriptions: Unsubscribe[] = [];
  private setup: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private requested = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly reconcile = () => { void this.refresh(); };
  private readonly visible = () => { if (document.visibilityState === 'visible') this.reconcile(); };
  constructor(private readonly service: RendererService, private readonly opened: OpenSessions) {}
  readonly getSnapshot = (): WaitingState => this.state;
  readonly subscribe = (receive: () => void): Unsubscribe => {
    this.listeners.add(receive); return () => { this.listeners.delete(receive); };
  };
  private publish(update: Partial<WaitingState>): void {
    if (this.stopped) return;
    this.state = Object.freeze({ ...this.state, ...update });
    this.listeners.forEach(receive => receive());
  }
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer !== null) return this.flight ?? Promise.resolve();
    if (this.timer === null) {
      this.timer = setInterval(this.reconcile, 2000);
      window.addEventListener('focus', this.reconcile); window.addEventListener('pageshow', this.reconcile);
      document.addEventListener('visibilitychange', this.visible);
    }
    return this.refresh();
  }
  private invalidate = (): void => {
    this.requested = true;
    if (this.state.counts) this.publish({ status: 'stale' });
    this.reconcile();
  };
  private ensureSubscriptions(): Promise<void> {
    if (this.setup) return this.setup;
    this.setup = (async () => {
      const results = await Promise.allSettled([
        this.service.subscribe('ariadne://session_changed', this.invalidate),
        this.service.subscribe('ariadne://presence_changed', this.invalidate),
      ]);
      const subscriptions = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (this.stopped || results.some(result => result.status === 'rejected')) {
        subscriptions.forEach(unsubscribe => unsubscribe());
        if (!this.stopped) throw new ServiceFailure('transport');
      } else this.subscriptions = subscriptions;
    })().catch((error: unknown) => { this.setup = null; throw error; });
    return this.setup;
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    this.requested = true;
    this.flight = this.load().finally(() => { this.flight = null; });
    return this.flight;
  }
  private async load(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      try {
        await this.ensureSubscriptions();
        if (this.stopped) return;
        const capture = await catalogue(this.service, () => this.stopped);
        if (this.stopped) return;
        const projects = new Map(capture.projects.map(project => [project.project_id, project]));
        const sessions: WaitingSession[] = [];
        // Sequential registered reads bound concurrent IO without truncating the catalogue.
        for (const summary of capture.sessions) {
          const project = projects.get(summary.project_id);
          if (!project) throw new ServiceFailure('invalid_response');
          const store = this.opened.open({ project_id: summary.project_id, session_id: summary.session_id });
          await store.refresh();
          if (this.stopped) return;
          const state = store.getSnapshot();
          if (state.error) throw state.error;
          if (!state.snapshot || state.snapshot.session.revision !== summary.revision) throw new ServiceFailure('invalid_response');
          sessions.push(Object.freeze({ project: immutable(project), summary: immutable(summary), session: state.snapshot.session }));
        }
        const waiting = waitingRows(sessions), sent = sentRows(sessions);
        this.publish({ sessions: Object.freeze(sessions), waiting, sent, counts: immutable(capture.result.counts),
          unavailableProjects: immutable(capture.projects.filter(project => project.availability === 'unavailable')),
          status: this.requested || sessions.some(session => this.opened.open({ project_id: session.session.project_id,
            session_id: session.session.id }).getSnapshot().status !== 'ready') ? 'stale' : 'ready', error: null });
      } catch (error: unknown) {
        const failure = error instanceof CoreFailure || error instanceof ServiceFailure ? error : new ServiceFailure('invalid_response');
        this.publish({ status: this.state.counts ? 'stale' : 'unavailable', error: failure });
      }
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    window.removeEventListener('focus', this.reconcile); window.removeEventListener('pageshow', this.reconcile);
    document.removeEventListener('visibilitychange', this.visible);
    this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = [];
    this.listeners.clear();
  }
}
export function useWaiting(store: WaitingStore): WaitingState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
