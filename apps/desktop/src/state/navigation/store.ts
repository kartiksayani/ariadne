import { useSyncExternalStore } from 'react';
import type { BindingConnectParams, ItemRoute, MutationReceipt, NavigationSelection, OwnerMutationRequest,
  PreferencesPatchEntry, PreferencesSnapshot, ProjectListResult, SessionListResult, SessionPreferences, SessionRef, Theme } from '../../generated/core';
import type { RevealedItem } from '../../data/routes';
import { RegisteredRoutes } from '../../data/routes';
import { immutable, OpenSessions, type Immutable, type SessionStore } from '../../data/session-store';
import { CoreFailure, ServiceFailure, type RendererService, type Unsubscribe } from '../../data/service';
import { initialExpansion } from '../../selectors/tree/rows';
import * as catalogue from './catalogue';

type Failure = CoreFailure | ServiceFailure;
type PendingMutation = { request: OwnerMutationRequest; confirmed: (receipt: MutationReceipt) => void };
type NavigationPatch = Extract<PreferencesPatchEntry, { kind: 'set_global' | 'set_session_view' | 'set_later' }>;
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
}
const sameRoute = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
const fail = (error: unknown): Failure => error instanceof CoreFailure || error instanceof ServiceFailure
  ? error : new ServiceFailure('transport');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class NavigationStore {
  readonly opened: OpenSessions;
  readonly routes: RegisteredRoutes;
  private state: NavigationState = Object.freeze({ preferences: null, projects: null, sessions: null,
    sessionProjectId: null, status: 'loading', error: null, writing: false, pendingOperationId: null, reveal: null, setup: null });
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
  // Reconciled reads recover their own errors, not the last rejected edit.
  private mutationFailure: Failure | null = null;
  // Write operations that settled with a definite revision_conflict (already cleared and refreshed).
  private readonly conflicted = new WeakSet<Promise<boolean>>();
  private readonly reconcile = () => { void this.refresh(); };
  private readonly visibility = () => { if (document.visibilityState === 'visible') this.reconcile(); };

  constructor(private readonly service: RendererService, private readonly operationId = () => crypto.randomUUID()) {
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
  readonly settledAsConflict = (completion: Promise<boolean>) => this.conflicted.has(completion);
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
        this.publish({ preferences: immutable(preferences), projects: immutable(projects), sessions: immutable(sessions),
          sessionProjectId: projectId, status: 'ready', error: this.mutationFailure });
        this.flushStartupRoute();
      } catch (error: unknown) {
        if (epoch === this.epoch) this.publish({ status: this.state.projects ? 'stale' : 'unavailable', error: fail(error) });
      }
    }
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
  private patch(preferences: PreferencesSnapshot, entries: NavigationPatch[], confirmed: () => void = () => {}): Promise<boolean> {
    return this.execute({ session: null, command: { api_version: 1, command: 'preferences_patch', op_id: this.operationId(),
      params: { expected_preferences_revision: preferences.revision, entries } } }, receipt => {
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
        for (const entry of entries) {
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
        this.publish({ preferences: immutable(saved) });
      }
      confirmed();
    });
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
    this.publish({ setup: null });
    return this.execute({ session: null, command: { api_version: 1, command: 'binding_connect',
      op_id: this.operationId(), params } }, receipt => {
      if (!('session_id' in receipt) || receipt.data.kind !== 'binding_connect') throw new ServiceFailure('invalid_response');
      this.publish({ setup: immutable(receipt) });
    });
  }
  private async execute(request: OwnerMutationRequest, confirmed: (receipt: MutationReceipt) => void): Promise<boolean> {
    if (this.stopped || this.pending) return false;
    this.pending = { request: structuredClone(request), confirmed };
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
    const clear = () => { if (this.activeMutation === operation) this.activeMutation = null; };
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
      this.mutationFailure = failure;
      // An unknown completion retains the exact command and operation ID.
      // Definitive typed rejection permits a new, explicitly chosen action.
      if (failure instanceof CoreFailure && !['commit_uncertain', 'delivery_uncertain'].includes(failure.error.code)) this.pending = null;
      this.publish({ writing: false, pendingOperationId: this.pending?.request.command.op_id ?? null, error: failure });
      if (failure instanceof CoreFailure && failure.error.code === 'revision_conflict') {
        this.conflicted.add(operation());
        await this.refresh();
      }
      return false;
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
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
