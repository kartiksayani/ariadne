import { useSyncExternalStore } from 'react';
import type { BindingConnectParams, GlobalPreferences, ItemRoute, MutationReceipt, NavigationSelection, OwnerMutationRequest,
  PreferencesPatchEntry, PreferencesSnapshot, ProjectListResult, SessionListResult, SessionPreferences, SessionRef, Theme } from '../../generated/core';
import type { RevealedItem } from '../../data/routes';
import type { ItemStatus } from '../../generated/domain/models';
import { RegisteredRoutes } from '../../data/routes';
import { immutable, OpenSessions, type Immutable, type SessionStore } from '../../data/session-store';
import { CoreFailure, ServiceFailure, type RendererService, type Unsubscribe } from '../../data/service';
import { initialExpansion } from '../../selectors/tree/rows';
import * as catalogue from './catalogue';

type Failure = CoreFailure | ServiceFailure;
// `retry` exists only for navigation-only preference patches. It rebuilds the same owner
// action against the refreshed snapshot with a new operation id, after a definite revision_conflict.
type PendingMutation = { request: OwnerMutationRequest; confirmed: (receipt: MutationReceipt) => void;
  retry?: () => PendingMutation | null | Promise<PendingMutation | null> };
type NavigationPatch = Extract<PreferencesPatchEntry, { kind: 'set_global' | 'set_session_view' | 'set_later' }>;
type ReplayEntries = (preferences: PreferencesSnapshot) => NavigationPatch[] | null;
export interface NavigationState {
  readonly preferences: Immutable<PreferencesSnapshot> | null;
  readonly projects: Immutable<ProjectListResult> | null;
  readonly sessions: Immutable<SessionListResult> | null;
  readonly sessionProjectId: string | null;
  readonly status: 'loading' | 'ready' | 'stale' | 'unavailable';
  readonly error: Failure | null;
  readonly writing: boolean;
  readonly pendingOperationId: string | null;
  readonly reveal: RevealedItem | null;
  readonly setup: Immutable<Extract<MutationReceipt, { session_id: string }>> | null;
  readonly setupAdapterId: string | null;
  /** The project whose page shows the setup card: the one the session was connected in. */
  readonly setupProjectId: string | null;
}
/** Renderer layout choices saved with the global preferences. */
export type LayoutChange = Partial<Pick<GlobalPreferences, 'detail_width' | 'waiting_collapsed'>>;
const sameRoute = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
const fail = (error: unknown): Failure => error instanceof CoreFailure || error instanceof ServiceFailure
  ? error : new ServiceFailure('transport');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const filterStatuses: Record<ItemStatus, true> = { open: true, waiting_on_me: true, in_progress: true,
  decided: true, done: true, dropped: true, replaced: true };
function normalizeStatusFilters(preferences: PreferencesSnapshot): PreferencesSnapshot {
  return { ...preferences, sessions: preferences.sessions.map(view => Object.keys(filterStatuses).every(status => view.filters.statuses.includes(status as ItemStatus))
    ? { ...view, filters: { ...view.filters, statuses: [] } } : view) };
}
// Patch semantics for a retry: apply only the fields the owner's action changed (`base` -> `desired`)
// onto the refreshed value, so a foreign change to a different field survives.
function replayFields<T extends object>(base: T, desired: T, current: T): T {
  const merged = structuredClone(current) as Record<string, unknown>;
  const before = base as Record<string, unknown>, after = desired as Record<string, unknown>;
  for (const key of Object.keys(after)) if (!equal(before[key], after[key])) merged[key] = structuredClone(after[key]);
  return merged as T;
}
function rebaseEntries(entries: NavigationPatch[], base: PreferencesSnapshot, current: PreferencesSnapshot): NavigationPatch[] {
  return entries.map((entry): NavigationPatch => {
    if (entry.kind === 'set_global') {
      return { kind: 'set_global', preferences: replayFields(base.global, entry.preferences, current.global) };
    }
    if (entry.kind === 'set_session_view') {
      const was = base.sessions.find(view => sameRoute(view.session, entry.preferences.session));
      const now = current.sessions.find(view => sameRoute(view.session, entry.preferences.session));
      return was && now ? { kind: 'set_session_view', preferences: replayFields(was, entry.preferences, now) } : structuredClone(entry);
    }
    return structuredClone(entry);
  });
}

export class NavigationStore {
  readonly opened: OpenSessions;
  readonly routes: RegisteredRoutes;
  private state: NavigationState = Object.freeze({ preferences: null, projects: null, sessions: null,
    sessionProjectId: null, status: 'loading', error: null, writing: false, pendingOperationId: null, reveal: null, setup: null, setupAdapterId: null, setupProjectId: null });
  private readonly listeners = new Set<() => void>();
  private subscriptions: Unsubscribe[] = [];
  private setup: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private requested = false;
  private stopped = false;
  private epoch = 0;
  private navigationRequest = 0;
  private navigationIntent = 0;
  private preferencesFloor = 0;
  private startupRoute: { selection: NavigationSelection; reveal: RevealedItem | null } | null = null;
  private startupRoutes = false;
  private startupRouteFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: PendingMutation | null = null;
  private activeMutation: Promise<boolean> | null = null;
  private textScaleTarget: { value: number; expectedRevision: number | null } | null = null;
  private textScaleFlight: Promise<boolean> | null = null;
  // Reconciled reads recover their own errors, not the last rejected edit.
  private mutationFailure: Failure | null = null;
  // Write operations that settled with a definite revision_conflict (already cleared and refreshed).
  // Keyed to the failure so a later, different rejection is not mistaken for it.
  private readonly conflicted = new WeakMap<Promise<boolean>, Failure>();
  private readonly reconcile = () => { void this.refresh(); };
  private readonly visibility = () => { if (document.visibilityState === 'visible') this.reconcile(); };

  constructor(readonly service: RendererService, private readonly operationId = () => crypto.randomUUID()) {
    this.opened = new OpenSessions(service);
    this.routes = new RegisteredRoutes(service, this.opened);
  }
  readonly getSnapshot = () => this.state;
  readonly getNavigationRequest = () => this.navigationRequest;
  // A current navigation attempt cancels older unsubmitted UI intent even when
  // the canonical writer cannot admit it. Dispatch/startup ordering is separate.
  readonly getNavigationIntent = () => this.stopped ? null : this.navigationIntent;
  // Observe only the already executing write; uncertain operations still need
  // explicit reconciliation. This neither schedules nor retries a mutation.
  readonly getWritingCompletion = () => !this.stopped && this.state.writing ? this.activeMutation : null;
  // True only when this exact write operation settled with a definite revision_conflict, which
  // the store has already cleared and refreshed. Uncertain and other rejections are never reported.
  readonly settledAsConflict = (completion: Promise<boolean>) => {
    const failure = this.conflicted.get(completion);
    // A newer write clears the failure on start; only a different, newer failure disqualifies it.
    return failure !== undefined && (this.mutationFailure === null || this.mutationFailure === failure);
  };
  readonly subscribe = (receive: () => void): Unsubscribe => {
    this.listeners.add(receive);
    return () => { this.listeners.delete(receive); };
  };
  private publish(update: Partial<NavigationState>): void {
    if (this.stopped) return;
    this.state = Object.freeze({ ...this.state, ...update });
    this.listeners.forEach(receive => receive());
  }
  async start(): Promise<void> {
    if (this.stopped) return;
    if (!this.timer) {
      this.timer = setInterval(this.reconcile, 2000);
      window.addEventListener('focus', this.reconcile);
      window.addEventListener('pageshow', this.reconcile);
      document.addEventListener('visibilitychange', this.visibility);
    }
    await this.refresh();
  }
  private ensureSubscriptions(): Promise<void> {
    if (this.setup) return this.setup;
    this.setup = (async () => {
      const results = await Promise.allSettled([
        this.service.subscribe('ariadne://session_changed', () => { this.requested = true; this.reconcile(); }),
        // A native writer (window geometry, pin/notification settings) saved preferences this
        // store did not write. Learn the new revision now instead of at the next 2 s poll.
        this.service.subscribe('ariadne://preferences_changed', hint => {
          if (this.state.preferences && hint.revision <= Math.max(this.state.preferences.revision, this.preferencesFloor)) return;
          this.requested = true; this.reconcile();
        }),
        this.routes.subscribe((route, reveal) => {
          const selection: NavigationSelection = { kind: 'session', session: {
            project_id: route.project_id, session_id: route.session_id,
          } };
          // Native acknowledges listener readiness before our initial catalogue
          // read finishes. Retain the latest registered intent until preferences
          // are available, including when that first read needs reconciliation.
          if (!this.state.preferences || this.startupRoutes) {
            this.startupRoutes = true;
            this.startupRoute = { selection, reveal };
            this.flushStartupRoute();
          } else void this.navigate(selection, reveal);
        },
          error => this.publish({ error })),
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
    this.requested = true;
    if (this.flight) return this.flight;
    this.flight = this.load().finally(() => { this.flight = null; });
    return this.flight;
  }
  private async load(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      const epoch = this.epoch;
      try {
        await this.ensureSubscriptions();
        if (this.stopped) return;
        const preferences = await this.service.query({ session: null, request: { command: 'preferences_get', params: {} } });
        if (this.stopped || epoch !== this.epoch) continue;
        if (preferences.revision < Math.max(this.state.preferences?.revision ?? 0, this.preferencesFloor)) {
          throw new ServiceFailure('invalid_response');
        }
        const selection = preferences.global.selected_navigation;
        const projectId = selection.kind === 'project' ? selection.project_id : null;
        const [projects, sessions] = await Promise.all([catalogue.projects(this.service), catalogue.sessions(this.service, projectId)]);
        if (this.stopped || epoch !== this.epoch) continue;
        // A receipt can advance preferences while these catalogue reads wait.
        // Discard a formerly valid capture without regressing that saved state
        // or reporting an invalid read; normal reconciliation captures it anew.
        if (preferences.revision < Math.max(this.state.preferences?.revision ?? 0, this.preferencesFloor)) continue;
        const registered = new Set(projects.projects.items.map(project => project.project_id));
        if (sessions.sessions.items.some(session => !registered.has(session.project_id))) {
          // Independent read captures can straddle registration. Keep the last
          // complete pair and restart instead of silently dropping orphan rows.
          throw new ServiceFailure('invalid_response');
        }
        // A foreign preferences writer may have hidden a newly created item.
        // Pair those ids with a session read after this preferences capture,
        // before exposing them to a synchronous hide/selection write's cleanup.
        await Promise.all(preferences.sessions.flatMap(view => {
          const store = this.opened.get(view.session), snapshot = store?.getSnapshot().snapshot;
          return store && view.hidden_item_ids?.some(id => !snapshot?.session.items[id])
            ? [store.refresh(true)] : [];
        }));
        if (this.stopped || epoch !== this.epoch || preferences.revision < Math.max(this.state.preferences?.revision ?? 0, this.preferencesFloor)) continue;
        this.publish({ preferences: immutable(normalizeStatusFilters(preferences)), projects: immutable(projects), sessions: immutable(sessions),
          sessionProjectId: projectId, status: 'ready', error: this.mutationFailure, ...this.setupAfter(sessions, projectId) });
        this.flushStartupRoute();
      } catch (error: unknown) {
        if (epoch === this.epoch) this.publish({ status: this.state.projects ? 'stale' : 'unavailable', error: fail(error) });
      }
    }
  }
  // The setup card outlives a removed session only until a complete capture of its project lacks it.
  private setupAfter(sessions: SessionListResult, projectId: string | null): Partial<NavigationState> {
    const { setup, setupProjectId } = this.state;
    if (!setup || (projectId !== null && projectId !== setupProjectId)) return {};
    const listed = sessions.sessions.items.some(session => session.project_id === setupProjectId && session.session_id === setup.session_id);
    return listed || sessions.counts.unavailable_session_ids.includes(setup.session_id) ? {} : { setup: null, setupAdapterId: null, setupProjectId: null };
  }
  /** The owner closed the "Session connected" card. */
  dismissSetup(): void {
    this.publish({ setup: null, setupAdapterId: null, setupProjectId: null });
  }
  private flushStartupRoute(): void {
    if (this.stopped || this.startupRouteFlight || this.pending || !this.state.preferences) return;
    const route = this.startupRoute;
    if (!route) { this.startupRoutes = false; return; }
    this.startupRoute = null;
    this.startupRouteFlight = true;
    void this.navigate(route.selection, route.reveal).finally(() => {
      this.startupRouteFlight = false;
      this.flushStartupRoute();
    });
  }
  selectedSession(): SessionStore | null {
    const selection = this.state.preferences?.global.selected_navigation;
    return selection?.kind === 'session' ? this.opened.open(selection.session) : null;
  }
  private preferences(): PreferencesSnapshot {
    if (!this.state.preferences) throw new ServiceFailure('transport');
    return structuredClone(this.state.preferences) as PreferencesSnapshot;
  }
  private patch(preferences: PreferencesSnapshot, entries: NavigationPatch[], confirmed: () => void = () => {}, replay?: ReplayEntries): Promise<boolean> {
    const mutation = this.patchMutation(preferences, entries, confirmed, true, replay);
    return this.execute(mutation.request, mutation.confirmed, mutation.retry);
  }
  private pruneHidden(entries: NavigationPatch[]): NavigationPatch[] {
    return entries.map(entry => {
      if (entry.kind !== 'set_session_view' || !entry.preferences.hidden_item_ids?.length) return entry;
      const state = this.opened.get(entry.preferences.session)?.getSnapshot();
      if (!state?.snapshot || state.status !== 'ready' || state.snapshot.freshness !== 'fresh') return entry;
      return { ...entry, preferences: { ...entry.preferences,
        hidden_item_ids: entry.preferences.hidden_item_ids.filter(id => !!state.snapshot!.session.items[id]) } };
    });
  }
  private patchMutation(preferences: PreferencesSnapshot, entries: NavigationPatch[], confirmed: () => void, retryable: boolean, replay?: ReplayEntries): PendingMutation {
    // Keep the owner's original fields for rebasing; cleanup must never replay a
    // stale whole set over a concurrent hide. Only the outgoing write is pruned.
    const written = this.pruneHidden(entries);
    const request: OwnerMutationRequest = { session: null, command: { api_version: 1, command: 'preferences_patch', op_id: this.operationId(),
      params: { expected_preferences_revision: preferences.revision, entries: written } } };
    // One re-apply per owner action; the second attempt never retries again.
    const intent = this.navigationIntent;
    const retry = retryable ? async () => {
      // Fresh preferences may hide an item created since the loaded session.
      // Refresh before recomputing ancestry or treating absence as removal.
      const sessions = entries.flatMap(entry => entry.kind === 'set_session_view'
        && (replay || entry.preferences.hidden_item_ids?.length || this.state.preferences?.sessions
          .find(view => sameRoute(view.session, entry.preferences.session))?.hidden_item_ids?.length)
        ? [this.opened.get(entry.preferences.session)] : []);
      await Promise.all(sessions.map(store => store?.refresh(true)));
      const current = this.state.preferences;
      // A newer owner navigation was dropped while this write was pending; do not let stale intent win.
      if (this.navigationIntent !== intent) return null;
      if (!current || current.revision <= preferences.revision) return null;
      const fresh = structuredClone(current) as PreferencesSnapshot;
      const rebased = replay ? replay(fresh) : rebaseEntries(entries, preferences, fresh);
      return rebased && this.patchMutation(fresh, rebased, confirmed, false);
    } : undefined;
    return { request, retry, confirmed: receipt => {
      if (!('preferences_revision' in receipt) || receipt.preferences_revision < preferences.revision) {
        throw new ServiceFailure('invalid_response');
      }
      this.preferencesFloor = Math.max(this.preferencesFloor, receipt.preferences_revision);
      // The receipt confirms these exact typed view writes. Reflect their saved
      // effect even if the follow-up read fails; an older replay cannot replace
      // a newer authoritative preferences snapshot.
      if ((this.state.preferences?.revision ?? 0) <= receipt.preferences_revision) {
        const saved = structuredClone(preferences);
        saved.revision = receipt.preferences_revision;
        for (const entry of written) {
          if (entry.kind === 'set_global') saved.global = structuredClone(entry.preferences);
          else if (entry.kind === 'set_session_view') {
            const index = saved.sessions.findIndex(view => sameRoute(view.session, entry.preferences.session));
            if (index < 0) saved.sessions.push(structuredClone(entry.preferences));
            else saved.sessions[index] = structuredClone(entry.preferences);
          } else {
            saved.later = saved.later.filter(item => !sameRoute(item, entry.item) || item.item_id !== entry.item.item_id);
            if (entry.later) saved.later.push(structuredClone(entry.item));
          }
        }
        this.publish({ preferences: immutable(normalizeStatusFilters(saved)) });
      }
      confirmed();
    } };
  }
  private async editingPreferences(expectedRevision: number): Promise<PreferencesSnapshot | null> {
    if (this.stopped || this.pending) return null;
    const preferences = this.preferences();
    if (preferences.revision === expectedRevision) return preferences;
    this.mutationFailure = new CoreFailure({ code: 'revision_conflict', message: 'These preferences changed after this view was rendered.',
      hint: 'Reload the view before choosing this edit again.', retryable: false, field_errors: [], current_revision: preferences.revision });
    this.publish({ error: this.mutationFailure });
    await this.refresh();
    return null;
  }
  async saveTheme(theme: Theme, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      return await this.patch(preferences, [{ kind: 'set_global', preferences: { ...preferences.global, theme } }]);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  saveTextScale(textScale: number, expectedPreferencesRevision: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    // Only the last unsubmitted size matters. A choice made during a write is
    // applied to its resulting preferences, preserving every unrelated field.
    this.textScaleTarget = { value: textScale,
      expectedRevision: this.pending || this.textScaleFlight ? null : expectedPreferencesRevision };
    return this.flushTextScale();
  }
  private flushTextScale(): Promise<boolean> {
    if (this.textScaleFlight) return this.textScaleFlight;
    const flight = Promise.resolve().then(() => this.saveQueuedTextScale());
    this.textScaleFlight = flight;
    const clear = () => { if (this.textScaleFlight === flight) this.textScaleFlight = null; };
    void flight.then(clear, clear);
    return flight;
  }
  private async saveQueuedTextScale(): Promise<boolean> {
    try {
      let saved = false;
      while (this.textScaleTarget && !this.stopped) {
        if (this.pending) {
          this.textScaleTarget.expectedRevision = null;
          const completion = this.getWritingCompletion();
          // An uncertain operation still needs the owner's explicit reconciliation.
          // Keep the size target for that completion, without replaying the write.
          if (!completion) return false;
          if (!await completion && this.pending) return false;
          continue;
        }
        const target = this.textScaleTarget;
        this.textScaleTarget = null;
        const preferences = target.expectedRevision === null ? this.preferences() : await this.editingPreferences(target.expectedRevision);
        if (this.stopped) return false;
        if (!preferences) {
          // A stale request's refresh can outlive a newer explicit size choice.
          if (this.textScaleTarget) continue;
          return false;
        }
        // Another preference action can be admitted while editingPreferences yields.
        if (this.pending) {
          this.textScaleTarget ??= { value: target.value, expectedRevision: null };
          continue;
        }
        saved = await this.patch(preferences, [{ kind: 'set_global', preferences: { ...preferences.global, text_scale: target.value } }]);
      }
      return saved;
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  /** Saves the detail panel width or the Waiting column fold. */
  async saveLayout(change: LayoutChange, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      return await this.patch(preferences, [{ kind: 'set_global', preferences: { ...preferences.global, ...change } }]);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  async saveSessionView(view: SessionPreferences, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      const current = preferences.sessions.find(saved => sameRoute(saved.session, view.session));
      if (!current) throw new ServiceFailure('invalid_response');
      // Tree edits retain navigation's tab lifetime/order. The captured revision
      // prevents older selection/filter/scroll values overwriting newer views.
      return await this.patch(preferences, [{ kind: 'set_session_view', preferences: {
        ...structuredClone(view), tab_open: current.tab_open, tab_order: current.tab_order,
      } }]);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  /** Hiding is an owner view preference; no domain mutation reaches the agent. */
  async setHidden(item: ItemRoute, hidden: boolean, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      if (this.stopped || this.pending) return false;
      const preferences = this.preferences();
      if (preferences.revision !== expectedPreferencesRevision) {
        await this.editingPreferences(expectedPreferencesRevision);
        return false;
      }
      const replay: ReplayEntries = fresh => {
        const entry = this.hiddenEntry(fresh, item, hidden);
        return entry ? [entry] : null;
      };
      const entries = replay(preferences);
      if (!entries) throw new ServiceFailure('invalid_response');
      // Reserve the canonical writer before yielding: another x or selection
      // save must see writing=true, never race an extra session_get round trip.
      return await this.patch(preferences, entries, undefined, replay);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  private hiddenEntry(preferences: PreferencesSnapshot, item: ItemRoute, hidden: boolean): NavigationPatch | null {
    const state = this.opened.get(item)?.getSnapshot(), session = state?.snapshot?.session;
    if (!session?.items[item.item_id] || state?.status !== 'ready' || state.snapshot?.freshness !== 'fresh') return null;
    const current = preferences.sessions.find(saved => sameRoute(saved.session, item));
    const view: SessionPreferences = current ? structuredClone(current) : {
      session: { project_id: item.project_id, session_id: item.session_id }, tab_open: false, selected_item_id: null,
      tab_order: Math.max(-1, ...preferences.sessions.map(saved => saved.tab_order)) + 1,
      expanded_item_ids: [...initialExpansion(session)],
      filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'waiting', scroll: null,
    };
    const ids = new Set((view.hidden_item_ids ?? []).filter(id => !!session.items[id]));
    if (hidden) ids.add(item.item_id);
    else {
      // Restoring an inherited hidden row opens its ancestors but keeps
      // independently hidden siblings and descendants.
      const seen = new Set<string>();
      for (let id: string | null = item.item_id; id && !seen.has(id); id = session.items[id]?.parent ?? null) {
        ids.delete(id); seen.add(id);
      }
    }
    view.hidden_item_ids = [...ids];
    return { kind: 'set_session_view', preferences: view };
  }
  async setLater(item: ItemRoute, later: boolean, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      return await this.patch(preferences, [{ kind: 'set_later', item: structuredClone(item), later }]);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  async navigate(selection: NavigationSelection, reveal: RevealedItem | null = null, isCurrent: () => boolean = () => true): Promise<boolean> {
    if (this.stopped || !isCurrent()) return false;
    ++this.navigationIntent;
    if (this.pending) return false;
    this.startupRoute = null;
    const request = ++this.navigationRequest;
    try {
      const preferences = this.preferences();
      const entries: NavigationPatch[] = [{ kind: 'set_global', preferences: { ...preferences.global, selected_navigation: selection } }];
      if (selection.kind === 'session') {
        const snapshot = await this.service.query({ session: selection.session, request: { command: 'session_get', params: {} } });
        if (this.stopped || this.pending || request !== this.navigationRequest || !isCurrent()) return false;
        if (!sameRoute(selection.session, { project_id: snapshot.session.project_id, session_id: snapshot.session.id })) {
          throw new ServiceFailure('invalid_response');
        }
        const existing = preferences.sessions.find(view => sameRoute(view.session, selection.session));
        const view: SessionPreferences = existing ?? { session: selection.session, tab_open: true, selected_item_id: null,
          tab_order: Math.max(-1, ...preferences.sessions.map(session => session.tab_order)) + 1, expanded_item_ids: [...initialExpansion(snapshot.session)],
          filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'waiting', scroll: null };
        entries.push({ kind: 'set_session_view', preferences: { ...view, tab_open: true,
          selected_item_id: reveal?.kind === 'item' ? reveal.route.item_id : view.selected_item_id } });
        if (equal(preferences.global.selected_navigation, selection) && existing?.tab_open && !reveal) {
          await this.opened.open(selection.session).refresh();
          return isCurrent() && request === this.navigationRequest;
        }
      } else if (selection.kind === 'project' && !this.state.projects?.projects.items.some(project => project.project_id === selection.project_id)) {
        throw new ServiceFailure('invalid_response');
      }
      if (!isCurrent() || request !== this.navigationRequest) return false;
      const saved = await this.patch(preferences, entries, () => {
        if (!isCurrent() || request !== this.navigationRequest) return;
        this.publish({ reveal });
        if (selection.kind === 'session') this.opened.open(selection.session);
      });
      return saved && isCurrent() && request === this.navigationRequest;
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  async closeTab(route: SessionRef): Promise<boolean> {
    if (this.stopped || this.pending) return false;
    ++this.navigationRequest;
    try {
      const preferences = this.preferences();
      const view = preferences.sessions.find(session => sameRoute(session.session, route));
      if (!view?.tab_open) return true;
      const entries: NavigationPatch[] = [{ kind: 'set_session_view', preferences: { ...view, tab_open: false } }];
      const selected = preferences.global.selected_navigation;
      if (selected.kind === 'session' && sameRoute(selected.session, route)) {
        entries.push({ kind: 'set_global', preferences: { ...preferences.global, selected_navigation: { kind: 'projects' } } });
      }
      return await this.patch(preferences, entries, () => { this.opened.close(route); this.publish({ reveal: null }); });
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  async register(canonicalRoot: string): Promise<boolean> {
    return this.execute({ session: null, command: { api_version: 1, command: 'project_register',
      op_id: this.operationId(), params: { canonical_root: canonicalRoot } } }, receipt => {
      if (!('project_id' in receipt)) throw new ServiceFailure('invalid_response');
    });
  }
  async bind(params: BindingConnectParams): Promise<boolean> {
    if (this.stopped || this.pending) return false;
    this.publish({ setup: null, setupAdapterId: null, setupProjectId: null });
    return this.execute({ session: null, command: { api_version: 1, command: 'binding_connect',
      op_id: this.operationId(), params } }, receipt => {
      if (!('session_id' in receipt) || receipt.data.kind !== 'binding_connect') throw new ServiceFailure('invalid_response');
      this.publish({ setup: immutable(receipt), setupAdapterId: params.adapter_id, setupProjectId: params.project_id });
    });
  }
  private async execute(request: OwnerMutationRequest, confirmed: (receipt: MutationReceipt) => void,
    retry?: PendingMutation['retry']): Promise<boolean> {
    if (this.stopped || this.pending) return false;
    this.pending = { request: structuredClone(request), confirmed, retry };
    return this.retryMutation();
  }
  retryMutation(): Promise<boolean> {
    const pending = this.pending;
    if (this.stopped || !pending || this.state.writing) return Promise.resolve(false);
    this.mutationFailure = null;
    ++this.epoch;
    const operation: Promise<boolean> = Promise.resolve().then(() => this.completeMutation(pending, () => operation));
    this.activeMutation = operation;
    this.publish({ writing: true, pendingOperationId: pending.request.command.op_id, error: null });
    const clear = () => {
      if (this.activeMutation === operation) this.activeMutation = null;
      if (this.textScaleTarget && !this.textScaleFlight && !this.pending && !this.stopped) void this.flushTextScale();
    };
    void operation.then(clear, clear);
    return operation;
  }
  private async completeMutation(pending: PendingMutation, operation: () => Promise<boolean>): Promise<boolean> {
    if (this.stopped) return false;
    try {
      const receipt = await this.service.executeOwner(pending.request);
      if (this.stopped) return false;
      pending.confirmed(receipt);
      this.pending = null;
      this.publish({ writing: false, pendingOperationId: null });
      // View/Later receipts already publish the exact saved preferences. Their
      // completion must not wait for unrelated catalogue reads, which can remain
      // busy under periodic reconciliation. Navigation/global and domain edits
      // retain their immediate refresh; view edits reconcile on the normal timer.
      const command = pending.request.command;
      const viewOnly = command.command === 'preferences_patch' && command.params.entries.every(entry =>
        entry.kind === 'set_session_view' || entry.kind === 'set_later');
      if (!viewOnly) await this.refresh();
      if ('project_id' in receipt) await this.navigate({ kind: 'project', project_id: receipt.project_id });
      return true;
    } catch (error: unknown) {
      const failure = fail(error);
      // Only a definite revision_conflict on a navigation-only patch is re-applied, once, against the
      // refreshed revision with a new operation id. Uncertain and every other rejection fall through.
      if (pending.retry && failure instanceof CoreFailure && failure.error.code === 'revision_conflict') {
        await this.refresh();
        const next = this.stopped ? null : await pending.retry();
        if (next) {
          this.pending = next;
          this.publish({ pendingOperationId: next.request.command.op_id });
          return this.completeMutation(next, operation);
        }
      }
      this.mutationFailure = failure;
      // An unknown completion retains the exact command and operation ID.
      // Definitive typed rejection permits a new, explicitly chosen action.
      if (failure instanceof CoreFailure && !['commit_uncertain', 'delivery_uncertain'].includes(failure.error.code)) this.pending = null;
      this.publish({ writing: false, pendingOperationId: this.pending?.request.command.op_id ?? null, error: failure });
      if (failure instanceof CoreFailure && failure.error.code === 'revision_conflict') {
        this.conflicted.set(operation(), failure);
        await this.refresh();
      }
      return false;
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.textScaleTarget = null;
    this.startupRoute = null;
    this.startupRoutes = false;
    ++this.epoch;
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener('focus', this.reconcile);
    window.removeEventListener('pageshow', this.reconcile);
    document.removeEventListener('visibilitychange', this.visibility);
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.opened.closeAll();
    this.listeners.clear();
  }
}

export function useNavigation(store: NavigationStore): NavigationState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
