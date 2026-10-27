import { useSyncExternalStore } from 'react';
import { ReadingLane } from '../preferences/reading';
import type { BindingConnectParams, GlobalPreferences, ItemRoute, MutationReceipt, NavigationSelection, OwnerMutationRequest,
  PreferencesPatchEntry, PreferencesSnapshot, ProjectListResult, SessionListResult, SessionPreferences, SessionRef, Theme } from '../../generated/core';
import type { RevealedItem } from '../../data/routes';
import type { ItemStatus, Session } from '../../generated/domain/models';
import { RegisteredRoutes } from '../../data/routes';
import { immutable, OpenSessions, type Immutable, type SessionStore } from '../../data/session-store';
import { changesNothing, sameFailure, sameValue } from '../../data/same';
import { CoreFailure, ServiceFailure, type RendererService, type Unsubscribe } from '../../data/service';
import { navigationFailure, OwnFailure } from '../../data/plain';
import { initialExpansion } from '../../selectors/tree/rows';
import * as catalogue from './catalogue';
import { lastSessionFrom } from './switcher';
import type { PageView } from './view';
import { applySeen, queueSeen, sessionSeen, type SeenPatch } from '../preferences/seen';

type Failure = CoreFailure | ServiceFailure;
// `retry` exists only for owner preference patches. It rebuilds the same owner
// action against the refreshed snapshot with a new operation id, after a definite revision_conflict.
type PendingMutation = { request: OwnerMutationRequest; confirmed: (receipt: MutationReceipt) => void;
  failed?: (failure: Failure) => void;
  retry?: () => PendingMutation | null | Promise<PendingMutation | null>;
  retrySeen?: (preferences: PreferencesSnapshot) => Promise<PendingMutation | null>;
  prepare?: () => Promise<PendingMutation>;
  followupIntent?: number;
  /** Written by the automatic Recent trail, never by an owner edit. */
  recent?: boolean;
  attempted?: boolean;
  current?: () => boolean };
type QueuedNavigation = { selection: NavigationSelection; reveal: RevealedItem | null; isCurrent: () => boolean;
  resolveReveal?: () => Promise<RevealedItem | null>;
  failed?: (failure: Failure) => void;
  request: number; started: number; running: boolean; confirmed: boolean; fresh: boolean;
  resolve: (saved: boolean) => void; completion: Promise<boolean>; confirm: (saved: boolean) => void;
  timer: ReturnType<typeof setTimeout> };
type NavigationPatch = Extract<PreferencesPatchEntry, { kind: 'set_global' | 'set_session_view' | 'set_later' | 'resolve_unsent_input' }>;
type ReplayEntries = (preferences: PreferencesSnapshot) => NavigationPatch[] | null;
/**
 * Runs once a receipt confirms a write (a retry, or a later Check again, included), handed `land`, which publishes the saved
 * preferences. The hook calls it where its own changes must land in the same update; it publishes after the hook otherwise,
 * and also when the hook throws (the write stays confirmed).
 */
export type Committing = (land: () => void) => void;
/** A hide's own view changes, made on the view it writes (the first write and every rebase), and its hook. */
export interface HideWrite {
  readonly edit?: (view: SessionPreferences) => void;
  readonly committing?: Committing;
}
/** Draft bookkeeping shares seen admission and provenance with navigation. */
export interface PreferencesWriteCoordination {
  prepare(): { ready: Promise<void>; release(): void };
  seenOnlySince(revision: number, preferences: PreferencesSnapshot): boolean;
}
export interface NavigationState {
  /** The session pages return to while the saved selection is not a session (an older release saved a page). */
  readonly lastSession: SessionRef | null;
  /** The page shown in place of the Map. In memory only: pages are never saved (C7). */
  readonly page: PageView | null;
  readonly preferences: Immutable<PreferencesSnapshot> | null;
  readonly projects: Immutable<ProjectListResult> | null;
  readonly sessions: Immutable<SessionListResult> | null;
  readonly sessionProjectId: string | null;
  readonly status: 'loading' | 'ready' | 'stale' | 'unavailable';
  readonly error: Failure | null;
  readonly writing: boolean;
  readonly pendingOperationId: string | null;
  readonly pendingNavigation: Immutable<NavigationSelection> | null;
  readonly reveal: RevealedItem | null;
  /**
   * Counts the navigations that asked to reveal an item (a link, Back or Forward, the peek's "Go to", the dock, a native route),
   * moved when each is asked for, not when it publishes: publishing waits behind a pending save and the item lookup. The Graph
   * drops the late answer to its own click when this moved since the click: the jump asked for last wins.
   */
  readonly revealAsks: number;
  readonly setup: Immutable<Extract<MutationReceipt, { session_id: string }>> | null;
  readonly setupAdapterId: string | null;
  /** The project whose page shows the setup card: the one the session was connected in. */
  readonly setupProjectId: string | null;
}
/** Renderer layout choices saved with the global preferences. */
export type LayoutChange = Partial<Pick<GlobalPreferences, 'detail_width' | 'waiting_collapsed' | 'session_archive_expanded_project_ids'>>;
const sameRoute = (a: SessionRef, b: SessionRef) => a.project_id === b.project_id && a.session_id === b.session_id;
const fail = (error: unknown): Failure => error instanceof CoreFailure || error instanceof ServiceFailure
  ? error : new ServiceFailure('transport');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const filterStatuses: Record<ItemStatus, true> = { open: true, waiting_on_me: true, in_progress: true,
  decided: true, done: true, dropped: true, replaced: true };
function normalizeStatusFilters(preferences: PreferencesSnapshot, registered?: ReadonlySet<string>): PreferencesSnapshot {
  return { ...preferences, global: { ...preferences.global,
    ...(preferences.global.session_archive_expanded_project_ids ? { session_archive_expanded_project_ids:
      preferences.global.session_archive_expanded_project_ids.filter(id => !registered || registered.has(id)) } : {}) }, sessions: preferences.sessions.map(view => Object.keys(filterStatuses).every(status => view.filters.statuses.includes(status as ItemStatus))
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
/** The session view with `item` hidden or shown again (a new view when the session has none saved). */
function hiddenView(preferences: PreferencesSnapshot, session: Immutable<Session>, item: ItemRoute, hidden: boolean): SessionPreferences {
  const current = preferences.sessions.find(saved => sameRoute(saved.session, item));
  const view: SessionPreferences = current ? structuredClone(current) : {
    session: { project_id: item.project_id, session_id: item.session_id }, tab_open: false, selected_item_id: null,
    tab_order: Math.max(-1, ...preferences.sessions.map(saved => saved.tab_order)) + 1,
    expanded_item_ids: [...initialExpansion(session)],
    filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, scroll: null,
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
  return view;
}

export class NavigationStore {
  readonly reading = new ReadingLane(entry => this.enqueueSeen(entry));
  readonly opened: OpenSessions;
  readonly routes: RegisteredRoutes;
  private state: NavigationState = Object.freeze({ lastSession: null, page: null, preferences: null, projects: null, sessions: null,
    sessionProjectId: null, status: 'loading', error: null, writing: false, pendingOperationId: null, pendingNavigation: null, reveal: null, revealAsks: 0, setup: null, setupAdapterId: null, setupProjectId: null });
  private readonly listeners = new Set<() => void>();
  private subscriptions: Unsubscribe[] = [];
  private setup: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private requested = false;
  private stopped = false;
  private epoch = 0;
  private navigationRequest = 0;
  private navigationIntent = 0;
  private queuedNavigation: QueuedNavigation | null = null;
  private preferencesFloor = 0;
  private startupRoute: { selection: NavigationSelection; reveal: RevealedItem | null;
    resolveReveal?: () => Promise<RevealedItem | null> } | null = null;
  private startupRouteFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: PendingMutation | null = null;
  private activeMutation: Promise<boolean> | null = null;
  private preparingRecent = false;
  private textScaleTarget: { value: number; expectedRevision: number | null } | null = null;
  private textScaleFlight: Promise<boolean> | null = null;
  private readonly seenQueue = new Map<string, SeenPatch>();
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  private seenDue = false;
  private seenFlight: Promise<boolean> | null = null;
  private seenEntries: SeenPatch[] = [];
  private seenFailures = 0;
  private seenGeneration = 0;
  private readonly seenCommits = new Set<number>();
  private readonly seenWaits = new Set<() => void>();
  private seenCapture: { preferences: PreferencesSnapshot; entries: SeenPatch[] } | null = null;
  private seenAdvance: { from: number; to: number } | null = null;
  private ownerPreparing = 0;
  // Reconciled reads recover their own errors, not the last rejected edit.
  private mutationFailure: Failure | null = null;
  getMutationFailure(): Failure | null { return this.mutationFailure; }
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
  /** True while the unsettled preferences write (running or unconfirmed) is the automatic Recent trail. */
  readonly isRecentPending = () => this.pending?.recent === true;
  readonly getRefreshCompletion = () => this.flight;
  readonly hasQueuedTextScale = () => this.textScaleTarget !== null;
  readonly subscribe = (receive: () => void): Unsubscribe => {
    this.listeners.add(receive);
    return () => { this.listeners.delete(receive); };
  };
  private publish(update: Partial<NavigationState>): void {
    if (this.stopped) return;
    this.state = Object.freeze({ ...this.state, ...update });
    this.listeners.forEach(receive => receive());
  }
  /**
   * Equality contract (alpha.23 F6): a poll that read the same data publishes nothing and keeps `preferences`,
   * `projects` and `sessions` (and the view objects inside `preferences`) as they were, by identity. Only a real change
   * moves them, once. Other publishes (an owner write, a navigation) are events and still publish as they did.
   */
  private publishChanges(update: Partial<NavigationState>): void {
    if (!changesNothing(this.state, update)) this.publish(update);
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
        this.service.subscribe('ariadne://route', route => {
          const selection: NavigationSelection = { kind: 'session', session: {
            project_id: route.project_id, session_id: route.session_id,
          } };
          // Native links reserve navigation before the registered item lookup,
          // just like a renderer link. Validation still uses RegisteredRoutes.
          const resolveReveal = route.item_id === null ? undefined
            : () => this.routes.revealItem({ ...route, item_id: route.item_id! });
          if (route.item_id === null) this.opened.open(selection.session);
          // Native acknowledges listener readiness before our initial catalogue
          // read finishes. Retain the latest registered intent until preferences
          // are available, including when that first read needs reconciliation.
          if (!this.state.preferences) {
            this.startupRoute = { selection, reveal: null, resolveReveal };
            this.flushStartupRoute();
          } else void this.navigate(selection, null, undefined, resolveReveal);
        }),
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
        this.observeSeenCommit(preferences);
        if (preferences.revision < Math.max(this.state.preferences?.revision ?? 0, this.preferencesFloor)) {
          throw new ServiceFailure('invalid_response');
        }
        const selection = preferences.global.selected_navigation;
        // A single project's page reads only that project's sessions; every other view reads them all.
        const page = this.state.page;
        const projectId = page ? page.projectId ?? null : selection.kind === 'project' ? selection.project_id : null;
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
        await this.pairHiddenItems(preferences);
        if (this.stopped || epoch !== this.epoch || preferences.revision < Math.max(this.state.preferences?.revision ?? 0, this.preferencesFloor)) continue;
        if (this.seenAdvance && preferences.revision > this.seenAdvance.to) this.seenAdvance = null;
        const captured = immutable(normalizeStatusFilters(preferences, registered)), previous = this.state.preferences;
        // Reconciliation of seen bookkeeping must keep unchanged view objects
        // stable too, including when the native hint arrives before its receipt.
        const stable = previous ? sameValue(previous, captured) ? previous : Object.freeze({ ...captured,
          global: equal(previous.global, captured.global) ? previous.global : captured.global,
          sessions: equal(previous.sessions, captured.sessions) ? previous.sessions : captured.sessions,
          later: equal(previous.later, captured.later) ? previous.later : captured.later }) : captured;
        const heldLast = this.state.lastSession;
        const lastSession = selection.kind === 'session' ? heldLast && sameRoute(heldLast, selection.session) ? heldLast : selection.session
          : heldLast ?? lastSessionFrom(selection, stable.sessions);
        this.publishChanges({ lastSession, preferences: stable,
          projects: this.state.projects && sameValue(this.state.projects, projects) ? this.state.projects : immutable(projects),
          sessions: this.state.sessions && sameValue(this.state.sessions, sessions) ? this.state.sessions : immutable(sessions),
          sessionProjectId: projectId, status: 'ready', error: this.mutationFailure, ...this.setupAfter(sessions, projectId) });
        if (selection.kind === 'session') this.initializeSeen(selection.session);
        this.flushStartupRoute();
      } catch (error: unknown) {
        if (epoch === this.epoch) {
          const failure = fail(error), shown = this.state.error;
          // A repeat of the read failure already shown keeps that object. A failed save is another matter: the page tells a save
          // failure from a read failure by this object's identity (`getMutationFailure`), so a read failure never reuses it.
          this.publishChanges({ status: this.state.projects ? 'stale' : 'unavailable',
            error: shown && shown !== this.mutationFailure && sameFailure(shown, failure) ? shown : failure });
        }
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
    if (!route) return;
    this.startupRoute = null;
    this.startupRouteFlight = true;
    void this.navigate(route.selection, route.reveal, undefined, route.resolveReveal).finally(() => {
      this.startupRouteFlight = false;
      this.flushStartupRoute();
    });
  }
  selectedSession(): SessionStore | null {
    const selection = this.state.preferences?.global.selected_navigation;
    return selection?.kind === 'session' ? this.opened.open(selection.session) : null;
  }
  private initializeSeen(session: SessionRef): void {
    const inFlight = this.seenEntries.some(entry => sameRoute(entry.session, session));
    if (!sessionSeen(this.state.preferences, session) && !inFlight && !this.seenQueue.has(JSON.stringify([session.project_id, session.session_id]))) {
      this.enqueueSeen({ kind: 'mark_seen', session, at: new Date().toISOString(), items: [], topics: [] });
    }
  }
  /** Details and future preview dwell record the revision actually displayed. */
  markItemSeen(session: SessionRef, itemId: string, observedRevision?: number): boolean {
    if (this.stopped) return false;
    const state = this.opened.get(session)?.getSnapshot(), item = state?.snapshot?.session.items[itemId];
    // An explicit revision describes text already displayed, even while a new hint
    // makes the store stale. An uncaptured read still requires a fresh snapshot.
    if (!item || observedRevision === undefined && (state?.status !== 'ready' || state.snapshot?.freshness !== 'fresh')) return false;
    const revision = observedRevision ?? item.revision;
    if (revision > item.revision || revision < 1) return false;
    if ((sessionSeen(this.state.preferences, session)?.items.find(value => value.item_id === itemId)?.revision ?? 0) >= revision) return true;
    this.reading.mark({ kind: 'mark_seen', session, at: new Date().toISOString(), items: [{ item_id: itemId, revision }], topics: [] });
    return true;
  }
  /** A topic catches up after all its unseen items have been read, or by an owner shortcut. */
  markTopicCaughtUp(session: SessionRef, topicId: string, observedRevision?: number): void {
    if (this.stopped) return;
    const current = this.opened.get(session)?.getSnapshot();
    if (current?.status !== 'ready' || current.snapshot?.freshness !== 'fresh' || !current.snapshot.session.topics[topicId]) return;
    if (observedRevision !== undefined && observedRevision !== current.snapshot.session.revision) return;
    const at = current.snapshot.session.updated_at;
    if (Date.parse(sessionSeen(this.state.preferences, session)?.topics.find(value => value.topic_id === topicId)?.at ?? '') >= Date.parse(at)) return;
    this.reading.mark({ kind: 'mark_seen', session, at: new Date().toISOString(), items: [], topics: [{ topic_id: topicId, at }] });
  }
  private enqueueSeen(entry: SeenPatch): void {
    if (this.stopped) return;
    queueSeen(this.seenQueue, entry);
    ++this.seenGeneration;
    this.seenFailures = 0;
    this.scheduleSeen(1000);
  }
  private scheduleSeen(delay: number): void {
    this.seenDue = false;
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      this.seenDue = true;
      void this.flushSeen();
    }, delay);
  }
  private flushSeen(): Promise<boolean> {
    if (this.seenFlight) return this.seenFlight;
    // Give admitted owner edits priority; no new batch can race their preparation.
    if (this.stopped || this.pending || this.ownerPreparing || !this.seenDue || !this.seenQueue.size) return Promise.resolve(false);
    const entries = [...this.seenQueue.values()], generation = this.seenGeneration;
    this.seenQueue.clear();
    this.seenEntries = entries;
    this.seenDue = false;
    const flight = this.writeSeen(entries, generation);
    this.seenFlight = flight;
    void flight.then(() => {
      if (this.seenFlight !== flight) return;
      this.seenFlight = null;
      this.seenEntries = [];
      if (this.seenDue) void this.flushSeen();
    });
    return flight;
  }
  private async writeSeen(entries: SeenPatch[], generation: number, closing = false): Promise<boolean> {
    try {
      // Drafts and native preferences writers can advance independently of the
      // navigation capture. Read immediately before each background attempt.
      const preferences = await this.service.query({ session: null, request: { command: 'preferences_get', params: {} } });
      if (this.stopped && !closing) return false;
      this.observeSeenCommit(preferences);
      if (!closing && (this.pending || this.ownerPreparing)) {
        entries.forEach(entry => queueSeen(this.seenQueue, entry));
        this.seenDue = true;
        return false;
      }
      const opId = this.operationId();
      this.seenCapture = { preferences: structuredClone(preferences), entries: structuredClone(entries) };
      const receipt = await this.service.executeOwner({ session: null, command: { api_version: 1, command: 'preferences_patch', op_id: opId,
        params: { expected_preferences_revision: preferences.revision, entries } } });
      if (this.stopped && !closing) return false;
      if (!('preferences_revision' in receipt) || receipt.operation_id !== opId || receipt.preferences_revision <= preferences.revision) {
        throw new ServiceFailure('invalid_response');
      }
      if (this.stopped && closing) return true;
      if (receipt.preferences_revision === preferences.revision + 1) this.recordSeenCommit(receipt.preferences_revision);
      this.preferencesFloor = Math.max(this.preferencesFloor, receipt.preferences_revision);
      const previous = this.state.preferences;
      if (previous && previous.revision <= receipt.preferences_revision) {
        const saved = structuredClone(preferences);
        saved.revision = receipt.preferences_revision;
        entries.forEach(entry => applySeen(saved, entry));
        const sameViews = equal(previous.global, saved.global) && equal(previous.sessions, saved.sessions) && equal(previous.later, saved.later);
        this.seenAdvance = sameViews ? { from: this.seenAdvance?.to === previous.revision ? this.seenAdvance.from : previous.revision,
          to: saved.revision } : null;
        // Preserve stable view identities and every field captured from foreign
        // writers. An older receipt must never replace a newer owner capture.
        const captured = immutable(normalizeStatusFilters(saved));
        this.publish({ preferences: Object.freeze({ ...captured,
          global: equal(previous.global, captured.global) ? previous.global : captured.global,
          sessions: equal(previous.sessions, captured.sessions) ? previous.sessions : captured.sessions,
          later: equal(previous.later, captured.later) ? previous.later : captured.later }) });
      }
      this.seenFailures = 0;
      return true;
    } catch (error: unknown) {
      if (closing) {
        if (error instanceof CoreFailure && error.error.code === 'revision_conflict' && generation < 2) return this.writeSeen(entries, generation + 1, true);
        return false;
      }
      if (this.stopped && !closing) return false;
      if (error instanceof CoreFailure && !['commit_uncertain', 'delivery_uncertain'].includes(error.error.code)) this.seenCapture = null;
      entries.forEach(entry => queueSeen(this.seenQueue, entry));
      // Marking is upward-only, so even an uncertain completion can be retried
      // under a fresh id. Three attempts, then wait quietly for another mark.
      if (generation === this.seenGeneration) {
        if (++this.seenFailures < 3) this.scheduleSeen(1000 * 2 ** (this.seenFailures - 1));
      } else if (!this.seenTimer && !this.seenDue) this.scheduleSeen(1000);
      return false;
    }
  }
  private recordSeenCommit(revision: number): void {
    this.seenCommits.add(revision);
    // A pending owner prevents new batches, so only recent commits can race it.
    if (this.seenCommits.size > 64) this.seenCommits.delete(this.seenCommits.values().next().value!);
  }
  private onlySeenSince(revision: number, current: number): boolean {
    if (current <= revision || current - revision > this.seenCommits.size) return false;
    for (let next = revision + 1; next <= current; ++next) if (!this.seenCommits.has(next)) return false;
    return true;
  }
  private observeSeenCommit(preferences: PreferencesSnapshot): void {
    // The native commit can be visible before its response arrives (or after an
    // uncertain response). Recognize only the exact effect of our captured batch.
    const capture = this.seenCapture;
    if (!capture || preferences.revision !== capture.preferences.revision + 1) return;
    const expected = structuredClone(capture.preferences);
    expected.revision = preferences.revision;
    capture.entries.forEach(entry => applySeen(expected, entry));
    if (equal(expected, preferences)) this.recordSeenCommit(preferences.revision);
  }
  private waitForSeen(flight = this.seenFlight, timeout = 500): Promise<void> {
    if (!flight || this.stopped) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.seenWaits.delete(finish); resolve(); };
      // A lost response must not hold an owner action indefinitely. Neither the
      // success flag nor a background error changes admission of that action.
      const timer = setTimeout(finish, timeout);
      this.seenWaits.add(finish);
      void flight.then(finish, finish);
    });
  }
  readonly preferenceWrites: PreferencesWriteCoordination = {
    prepare: () => {
      // Reserve before yielding so a due seen batch cannot start during a draft
      // preferences read or any of its definite-conflict retries.
      ++this.ownerPreparing;
      let released = false;
      return { ready: this.waitForSeen(), release: () => {
        if (released) return;
        released = true;
        --this.ownerPreparing;
        if (this.seenDue) void this.flushSeen();
      } };
    },
    seenOnlySince: (revision, preferences) => {
      this.observeSeenCommit(preferences);
      return this.onlySeenSince(revision, preferences.revision);
    },
  };
  private async capturePreferences(): Promise<PreferencesSnapshot> {
    const preferences = await this.service.query({ session: null, request: { command: 'preferences_get', params: {} } });
    if (this.stopped) return preferences;
    this.observeSeenCommit(preferences);
    // An independently registered project can already have archive preferences.
    // Pair unknown ids with the catalogue before a global patch cleans them up.
    const missingProject = this.state.projects && preferences.global.session_archive_expanded_project_ids
      ?.some(id => !this.state.projects!.projects.items.some(project => project.project_id === id));
    const [projects] = await Promise.all([missingProject ? catalogue.projects(this.service) : Promise.resolve(null),
      this.pairHiddenItems(preferences)]);
    if (this.stopped) return preferences;
    const previous = this.state.preferences;
    if (previous && preferences.revision < Math.max(previous.revision, this.preferencesFloor)) return this.preferences();
    const captured = immutable(normalizeStatusFilters(preferences));
    this.publish({ ...(projects ? { projects: immutable(projects) } : {}), preferences: previous ? Object.freeze({ ...captured,
      global: equal(previous.global, captured.global) ? previous.global : captured.global,
      sessions: equal(previous.sessions, captured.sessions) ? previous.sessions : captured.sessions,
      later: equal(previous.later, captured.later) ? previous.later : captured.later }) : captured });
    return this.preferences();
  }
  private async pairHiddenItems(preferences: PreferencesSnapshot): Promise<void> {
    // Only a fresh session capture can distinguish a foreign new hide from an
    // obsolete id before the owner's rebased view goes through cleanup.
    await Promise.all(preferences.sessions.flatMap(view => {
      const store = this.opened.get(view.session), snapshot = store?.getSnapshot().snapshot;
      return store && view.hidden_item_ids?.some(id => !snapshot?.session.items[id])
        ? [store.refresh(true)] : [];
    }));
  }
  private matchesPreferences(expectedRevision: number, currentRevision: number): boolean {
    return expectedRevision === currentRevision || this.onlySeenSince(expectedRevision, currentRevision) || !!this.seenAdvance
      && currentRevision === this.seenAdvance.to && expectedRevision >= this.seenAdvance.from && expectedRevision < currentRevision;
  }
  private preferences(): PreferencesSnapshot {
    if (!this.state.preferences) throw new ServiceFailure('transport');
    return structuredClone(this.state.preferences) as PreferencesSnapshot;
  }
  private patch(preferences: PreferencesSnapshot, entries: NavigationPatch[], confirmed: () => void = () => {}, replay?: ReplayEntries,
    seenWaited = false, current?: () => boolean, failed?: (failure: Failure) => void, committing?: Committing): Promise<boolean> {
    const mutation = this.patchMutation(preferences, entries, confirmed, true, replay, current, failed, committing);
    const flight = this.seenFlight;
    if (flight) mutation.prepare = async () => {
      if (!seenWaited) await this.waitForSeen(flight);
      if (this.stopped) return mutation;
      const fresh = await this.capturePreferences();
      const rebased = replay ? replay(fresh) : rebaseEntries(entries, preferences, fresh);
      if (!rebased) throw new ServiceFailure('invalid_response');
      return this.patchMutation(fresh, rebased, confirmed, true, replay, current, failed, committing);
    };
    // Reserve the owner writer synchronously even during the bounded wait.
    return this.execute(mutation);
  }
  private pruneHidden(entries: NavigationPatch[]): NavigationPatch[] {
    return entries.map(entry => {
      if (entry.kind === 'set_global' && this.state.projects && this.state.status === 'ready') {
        const registered = new Set(this.state.projects.projects.items.map(project => project.project_id));
        return { ...entry, preferences: { ...entry.preferences,
          ...(entry.preferences.session_archive_expanded_project_ids ? { session_archive_expanded_project_ids:
            entry.preferences.session_archive_expanded_project_ids.filter(id => registered.has(id)) } : {}) } };
      }
      if (entry.kind !== 'set_session_view' || !entry.preferences.hidden_item_ids?.length) return entry;
      const state = this.opened.get(entry.preferences.session)?.getSnapshot();
      if (!state?.snapshot || state.status !== 'ready' || state.snapshot.freshness !== 'fresh') return entry;
      return { ...entry, preferences: { ...entry.preferences,
        hidden_item_ids: entry.preferences.hidden_item_ids.filter(id => !!state.snapshot!.session.items[id]) } };
    });
  }
  /**
   * `committing` runs once the receipt confirms the write and is handed the publish of its saved preferences (see `Committing`).
   */
  private patchMutation(preferences: PreferencesSnapshot, entries: NavigationPatch[], confirmed: () => void, retryable: boolean, replay?: ReplayEntries, current?: () => boolean, failed?: (failure: Failure) => void, committing?: Committing): PendingMutation {
    // Keep the owner's original fields for rebasing; cleanup must never replay a
    // stale whole set over a concurrent hide. Only the outgoing write is pruned.
    const written = this.pruneHidden(entries);
    const request: OwnerMutationRequest = { session: null, command: { api_version: 1, command: 'preferences_patch', op_id: this.operationId(),
      params: { expected_preferences_revision: preferences.revision, entries: written } } };
    // Foreign conflicts retain the existing one-shot retry. Navigation checks
    // its current intent on every replay, including our own seen-only conflicts.
    // Our own seen commits cannot invalidate or consume that owner retry.
    const reapply = async (capture: PreferencesSnapshot | null, seenOnly: boolean): Promise<PendingMutation | null> => {
      // Fresh preferences may hide an item created since the loaded session.
      // Refresh before recomputing ancestry or treating absence as removal.
      const sessions = entries.flatMap(entry => entry.kind === 'set_session_view'
        && (replay || entry.preferences.hidden_item_ids?.length || this.state.preferences?.sessions
          .find(view => sameRoute(view.session, entry.preferences.session))?.hidden_item_ids?.length)
        ? [this.opened.get(entry.preferences.session)] : []);
      await Promise.all(sessions.map(store => store?.refresh(true)));
      if (current && !current()) return null;
      const captured = capture ?? this.state.preferences;
      if (!captured || captured.revision <= preferences.revision) return null;
      const fresh = structuredClone(captured) as PreferencesSnapshot;
      const rebased = replay ? replay(fresh) : rebaseEntries(entries, preferences, fresh);
      return rebased && this.patchMutation(fresh, rebased, confirmed, seenOnly && retryable, replay, current, failed, committing);
    };
    const retry = retryable ? () => reapply(null, false) : undefined;
    return { request, retry, retrySeen: fresh => reapply(fresh, true), current, failed, confirmed: receipt => {
      if (!('preferences_revision' in receipt) || receipt.preferences_revision < preferences.revision) {
        throw new ServiceFailure('invalid_response');
      }
      this.preferencesFloor = Math.max(this.preferencesFloor, receipt.preferences_revision);
      // The receipt confirms these exact typed view writes. Reflect their saved
      // effect even if the follow-up read fails; an older replay cannot replace
      // a newer authoritative preferences snapshot.
      let landed = false;
      const land = () => {
        if (landed || (this.state.preferences?.revision ?? 0) > receipt.preferences_revision) { landed = true; return; }
        landed = true;
        const saved = structuredClone(preferences);
        saved.revision = receipt.preferences_revision;
        for (const entry of written) {
          if (entry.kind === 'set_global') saved.global = structuredClone(entry.preferences);
          else if (entry.kind === 'set_session_view') {
            const index = saved.sessions.findIndex(view => sameRoute(view.session, entry.preferences.session));
            if (index < 0) saved.sessions.push(structuredClone(entry.preferences));
            else saved.sessions[index] = structuredClone(entry.preferences);
          } else if (entry.kind === 'set_later') {
            saved.later = saved.later.filter(item => !sameRoute(item, entry.item) || item.item_id !== entry.item.item_id);
            if (entry.later) saved.later.push(structuredClone(entry.item));
          } else {
            saved.resolved_unsent_input_ids = [...new Set([...(saved.resolved_unsent_input_ids ?? []), entry.input_id])].slice(-10_000);
          }
        }
        this.seenAdvance = null;
        this.publish({ preferences: immutable(normalizeStatusFilters(saved)) });
      };
      // The write is saved whatever the hook does: a hook that throws shows less, and the receipt still confirms.
      try { committing?.(land); } catch (error: unknown) { console.error('Ariadne could not show a saved view change', error); } finally { land(); }
      confirmed();
    } };
  }
  private async editingPreferences(expectedRevision: number): Promise<PreferencesSnapshot | null> {
    if (this.stopped || this.pending) return null;
    const preferences = this.preferences();
    if (this.matchesPreferences(expectedRevision, preferences.revision)) return preferences;
    this.mutationFailure = new CoreFailure({ code: 'revision_conflict', message: 'These preferences changed after this view was rendered.',
      hint: 'Reload the view before choosing this edit again.', retryable: false, field_errors: [], current_revision: preferences.revision });
    const refreshed = this.refresh();
    this.publish({ error: this.mutationFailure });
    await refreshed;
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
  /** Resolves one unsent notice; admission refusal returns false, its own save failure throws. */
  async resolveUnsentInput(inputId: string): Promise<boolean> {
    try {
      if (this.stopped || this.pending || !this.state.preferences) return false;
      const preferences = this.preferences();
      if (preferences.resolved_unsent_input_ids?.includes(inputId)) return true;
      let failure: Failure | undefined;
      const saved = await this.patch(preferences, [{ kind: 'resolve_unsent_input', input_id: inputId }], undefined, undefined,
        false, undefined, ownFailure => { failure = ownFailure; });
      if (failure) throw failure;
      return saved;
    } catch (error: unknown) {
      const failure = fail(error);
      this.publish({ error: failure });
      throw failure;
    }
  }
  /**
   * Saves a session's view. `committing` runs when the receipt confirms this write (a retry or a later Check again
   * included), just before the saved preferences publish: the Map's queued view edits leave its effective view in the same
   * update that brings the saved view carrying them (`viewEdits.ts`).
   */
  async saveSessionView(view: SessionPreferences, expectedPreferencesRevision: number, committing?: () => void): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      const current = preferences.sessions.find(saved => sameRoute(saved.session, view.session));
      if (!current) throw new ServiceFailure('invalid_response');
      // Tree edits retain navigation's tab lifetime/order. The captured revision
      // prevents older selection/filter/scroll values overwriting newer views.
      return await this.patch(preferences, [{ kind: 'set_session_view', preferences: {
        ...structuredClone(view), tab_open: current.tab_open, tab_order: current.tab_order,
      } }], undefined, undefined, false, undefined, undefined, committing && (land => { committing(); land(); }));
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  /** Waiting previews retain their trail without opening a tab or changing navigation. */
  async saveRecentItems(session: SessionRef, recentItems: NonNullable<SessionPreferences['recent_items']>, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      const current = preferences.sessions.find(view => sameRoute(view.session, session));
      let view: SessionPreferences;
      if (current) view = structuredClone(current);
      else {
        const opened = this.opened.get(session)?.getSnapshot().snapshot?.session;
        const snapshot = opened ?? (await this.service.query({ session, request: { command: 'session_get', params: {} } })).session;
        if (!sameRoute(session, { project_id: snapshot.project_id, session_id: snapshot.id })) throw new ServiceFailure('invalid_response');
        if (this.stopped || this.pending) return false;
        // Match the existing unopened-view defaults used by hiding and opening a session.
        view = { session, tab_open: false, selected_item_id: null,
          tab_order: Math.max(-1, ...preferences.sessions.map(saved => saved.tab_order)) + 1,
          expanded_item_ids: [...initialExpansion(snapshot)],
          filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, scroll: null };
      }
      const entries: ReplayEntries = fresh => {
        const saved = fresh.sessions.find(value => sameRoute(value.session, session));
        const base = saved ?? { ...view, tab_order: Math.max(-1, ...fresh.sessions.map(value => value.tab_order)) + 1 };
        return [{ kind: 'set_session_view', preferences: { ...base, recent_items: structuredClone(recentItems) } }];
      };
      this.preparingRecent = true;
      let completion: Promise<boolean>;
      try { completion = this.patch(preferences, entries(preferences)!, undefined, entries); }
      finally { this.preparingRecent = false; }
      return await completion;
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  /**
   * Hiding is an owner view preference; no domain mutation reaches the agent. `write.edit` changes the same view write (the
   * selection the hide moves to rides in it), and `write.committing` runs when the receipt confirms it.
   */
  async setHidden(item: ItemRoute, hidden: boolean, expectedPreferencesRevision: number, write: HideWrite = {}): Promise<boolean> {
    ++this.ownerPreparing;
    try {
      if (this.stopped || this.pending) return false;
      const store = this.opened.get(item), state = store?.getSnapshot();
      // A session_changed hint makes a valid capture stale while its read is
      // in flight. Wait for a fresh capture before rebuilding the hide set.
      if (store && (state?.status !== 'ready' || state.snapshot?.freshness !== 'fresh')) {
        await store.refresh(true);
        if (this.stopped || this.pending) return false;
      }
      const preferences = this.preferences();
      if (!this.matchesPreferences(expectedPreferencesRevision, preferences.revision)) {
        await this.editingPreferences(expectedPreferencesRevision);
        return false;
      }
      const replay: ReplayEntries = fresh => {
        const entry = this.hiddenEntry(fresh, item, hidden);
        if (entry?.kind === 'set_session_view') write.edit?.(entry.preferences);
        return entry ? [entry] : null;
      };
      const entries = replay(preferences);
      if (!entries) throw new ServiceFailure('invalid_response');
      // Reserve the canonical writer before yielding: another x or selection
      // save must see writing=true, never race an extra session_get round trip.
      return await this.patch(preferences, entries, undefined, replay, false, undefined, undefined, write.committing);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
    finally { --this.ownerPreparing; if (this.seenDue) void this.flushSeen(); }
  }
  private hiddenEntry(preferences: PreferencesSnapshot, item: ItemRoute, hidden: boolean): NavigationPatch | null {
    const state = this.opened.get(item)?.getSnapshot(), session = state?.snapshot?.session;
    if (!session?.items[item.item_id] || state?.status !== 'ready' || state.snapshot?.freshness !== 'fresh') return null;
    return { kind: 'set_session_view', preferences: hiddenView(preferences, session, item, hidden) };
  }
  /**
   * The session view a hide (or unhide) of `item` would write now, from the loaded session: the view `setHidden` builds, a new
   * one for a session with none saved. Null before preferences or the session load.
   */
  viewWithHidden(item: ItemRoute, hidden: boolean): SessionPreferences | null {
    const session = this.opened.get(item)?.getSnapshot().snapshot?.session;
    if (!this.state.preferences || !session?.items[item.item_id]) return null;
    return hiddenView(this.preferences(), session, item, hidden);
  }
  async setLater(item: ItemRoute, later: boolean, expectedPreferencesRevision: number): Promise<boolean> {
    try {
      const preferences = await this.editingPreferences(expectedPreferencesRevision);
      if (!preferences || this.stopped || this.pending) return false;
      return await this.patch(preferences, [{ kind: 'set_later', item: structuredClone(item), later }]);
    } catch (error: unknown) { this.publish({ error: fail(error) }); return false; }
  }
  navigate(selection: NavigationSelection, reveal: RevealedItem | null = null, isCurrent: () => boolean = () => true,
    resolveReveal?: () => Promise<RevealedItem | null>, failed?: (failure: Failure) => void): Promise<boolean> {
    if (this.stopped || !isCurrent()) return Promise.resolve(false);
    ++this.navigationIntent;
    this.startupRoute = null;
    const request = ++this.navigationRequest;
    const previous = this.queuedNavigation;
    if (previous) this.finishNavigation(previous, false);
    let confirm!: (saved: boolean) => void;
    const completion = new Promise<boolean>(resolve => { confirm = resolve; });
    const result = new Promise<boolean>(resolve => {
      // Return control even if an existing operation loses its response. Keep
      // the destination visible and resume it after explicit reconciliation;
      // this timeout never retries or changes an uncertain operation.
      const timer = setTimeout(() => resolve(false), 1000);
      this.queuedNavigation = { selection: structuredClone(selection), reveal, resolveReveal, failed, isCurrent, request, started: Date.now(),
        running: false, confirmed: false, fresh: !!this.pending, resolve, completion, confirm, timer };
    });
    // A page stays on screen until the destination is confirmed, so the old session never flashes back.
    this.publish({ pendingNavigation: immutable(selection),
      ...(reveal || resolveReveal ? { revealAsks: this.state.revealAsks + 1 } : {}) });
    this.flushNavigation();
    return result;
  }
  /** Reveals with a continuation follow confirmation, even after the bounded UI handoff. */
  getNavigationCompletion(request: number): Promise<boolean> {
    return this.queuedNavigation?.request === request ? this.queuedNavigation.completion : Promise.resolve(false);
  }
  private finishNavigation(queued: QueuedNavigation, saved: boolean): void {
    clearTimeout(queued.timer);
    queued.resolve(saved);
    queued.confirm(saved);
    if (this.queuedNavigation === queued) {
      this.queuedNavigation = null;
      this.publish({ pendingNavigation: null });
    }
  }
  private flushNavigation(): void {
    const queued = this.queuedNavigation;
    if (!queued || this.stopped) return;
    if (!queued.isCurrent()) { this.finishNavigation(queued, false); return; }
    if (queued.confirmed) { this.finishNavigation(queued, true); return; }
    if (queued.running) return;
    if (this.pending) { queued.fresh = true; return; }
    queued.running = true;
    void this.applyNavigation(queued).then(saved => {
      queued.running = false;
      if (this.queuedNavigation === queued) {
        if (saved || queued.confirmed) this.finishNavigation(queued, true);
        else if (!this.pending) this.finishNavigation(queued, false);
        else queued.fresh = true;
      }
      this.flushNavigation();
    });
  }
  private async applyNavigation(queued: QueuedNavigation): Promise<boolean> {
    const { selection, request, isCurrent } = queued;
    const current = () => !this.stopped && this.queuedNavigation === queued && request === this.navigationRequest && isCurrent();
    ++this.ownerPreparing;
    try {
      if (queued.resolveReveal) {
        const reveal = await queued.resolveReveal();
        if (!current() || !reveal) return false;
        queued.reveal = reveal;
        delete queued.resolveReveal;
      }
      const reveal = queued.reveal;
      const seenWaited = this.seenFlight !== null;
      if (seenWaited) await this.waitForSeen(this.seenFlight, Math.max(0, 500 - (Date.now() - queued.started)));
      if (!current() || this.pending) return false;
      const preferences = seenWaited || queued.fresh ? await this.capturePreferences() : this.preferences();
      if (!current() || this.pending) return false;
      const entries: NavigationPatch[] = [{ kind: 'set_global', preferences: { ...preferences.global, selected_navigation: selection } }];
      if (selection.kind === 'session') {
        const snapshot = await this.service.query({ session: selection.session, request: { command: 'session_get', params: {} } });
        if (!current() || this.pending) return false;
        if (!sameRoute(selection.session, { project_id: snapshot.session.project_id, session_id: snapshot.session.id })) {
          throw new ServiceFailure('invalid_response');
        }
        const existing = preferences.sessions.find(view => sameRoute(view.session, selection.session));
        const view: SessionPreferences = existing ?? { session: selection.session, tab_open: true, selected_item_id: null,
          tab_order: Math.max(-1, ...preferences.sessions.map(session => session.tab_order)) + 1, expanded_item_ids: [...initialExpansion(snapshot.session)],
          filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, scroll: null };
        entries.push({ kind: 'set_session_view', preferences: { ...view, tab_open: true,
          selected_item_id: reveal?.kind === 'item' ? reveal.route.item_id : view.selected_item_id } });
        if (equal(preferences.global.selected_navigation, selection) && existing && !reveal) {
          await this.opened.open(selection.session).refresh();
          if (!current()) return false;
          if (this.state.page) this.publish({ page: null });
          this.initializeSeen(selection.session);
          return true;
        }
      } else if (selection.kind === 'project' && !this.state.projects?.projects.items.some(project => project.project_id === selection.project_id)) {
        throw new ServiceFailure('invalid_response');
      }
      if (!current()) return false;
      // Navigation explicitly chooses its destination even when it matches the
      // captured view. A conflict must not treat that choice as an unchanged
      // field and retain a different destination from the fresh preferences.
      const replay: ReplayEntries = fresh => rebaseEntries(entries, preferences, fresh).map(entry => {
        if (entry.kind === 'set_global') return { ...entry, preferences: { ...entry.preferences, selected_navigation: selection } };
        if (entry.kind === 'set_session_view') return { ...entry, preferences: { ...entry.preferences, tab_open: true,
          ...(reveal?.kind === 'item' ? { selected_item_id: reveal.route.item_id } : {}) } };
        return entry;
      });
      const saved = await this.patch(preferences, entries, () => {
        queued.confirmed = true;
        if (!current()) return;
        // Only a removal saves a page selection now; it leaves no session to return to.
        this.publish({ reveal, page: null, lastSession: selection.kind === 'session' ? selection.session : null });
        if (selection.kind === 'session') { this.opened.open(selection.session); this.initializeSeen(selection.session); }
      }, replay, seenWaited, current);
      return saved && current();
    } catch (error: unknown) {
      if (current()) {
        const failure = fail(error);
        if (queued.failed) queued.failed(failure);
        else this.publish({ error: failure instanceof CoreFailure
          ? new OwnFailure({ ...failure.error, message: navigationFailure(failure), hint: '' }) : failure });
      }
      return false;
    }
    finally { --this.ownerPreparing; if (this.seenDue) void this.flushSeen(); }
  }
  /**
   * Shows a page in place of the Map. Nothing is saved: the selection stays the last session, so a restart (or an
   * older release) opens that session. A queued session navigation is the older intent and is cancelled.
   */
  openPage(page: PageView): boolean {
    if (this.stopped) return false;
    ++this.navigationIntent;
    ++this.navigationRequest;
    this.startupRoute = null;
    const queued = this.queuedNavigation;
    if (queued) this.finishNavigation(queued, false);
    this.publish({ page: Object.freeze({ kind: 'page', page: page.page, ...(page.projectId ? { projectId: page.projectId } : {}) }), reveal: null });
    // Pages list what the catalogue holds now, as navigating to them always did.
    void this.refresh();
    return true;
  }
  async register(canonicalRoot: string): Promise<boolean> {
    return this.execute({ request: { session: null, command: { api_version: 1, command: 'project_register',
      op_id: this.operationId(), params: { canonical_root: canonicalRoot } } }, confirmed: receipt => {
      if (!('project_id' in receipt)) throw new ServiceFailure('invalid_response');
    } });
  }
  async bind(params: BindingConnectParams): Promise<boolean> {
    if (this.stopped || this.pending) return false;
    this.publish({ setup: null, setupAdapterId: null, setupProjectId: null });
    return this.execute({ request: { session: null, command: { api_version: 1, command: 'binding_connect',
      op_id: this.operationId(), params } }, confirmed: receipt => {
      if (!('session_id' in receipt) || receipt.data.kind !== 'binding_connect') throw new ServiceFailure('invalid_response');
      this.publish({ setup: immutable(receipt), setupAdapterId: params.adapter_id, setupProjectId: params.project_id });
    } });
  }
  private async execute(mutation: PendingMutation): Promise<boolean> {
    if (this.stopped || this.pending) return false;
    this.pending = { ...mutation, recent: this.preparingRecent, followupIntent: this.navigationIntent, request: structuredClone(mutation.request) };
    return this.retryMutation();
  }
  retryMutation(): Promise<boolean> {
    const pending = this.pending;
    if (this.stopped || !pending || this.state.writing) return Promise.resolve(false);
    this.mutationFailure = null;
    ++this.epoch;
    const operation: Promise<boolean> = Promise.resolve().then(() => this.completeMutation(pending));
    this.activeMutation = operation;
    if (this.preparingRecent) {
      // A background visit can invalidate an in-flight catalogue capture.
      // Retain its requested refresh rather than waiting for the next poll.
      if (this.flight) this.requested = true;
    }
    this.seenAdvance = null;
    this.publish({ writing: true, pendingOperationId: pending.request.command.op_id, error: null });
    const clear = () => {
      if (this.activeMutation === operation) this.activeMutation = null;
      this.flushNavigation();
      if (this.textScaleTarget && !this.textScaleFlight && !this.pending && !this.stopped) void this.flushTextScale();
      if (this.seenDue && !this.pending && !this.stopped) void this.flushSeen();
    };
    void operation.then(clear, clear);
    return operation;
  }
  private async completeMutation(pending: PendingMutation): Promise<boolean> {
    if (this.stopped) return false;
    try {
      if (!pending.attempted && pending.current && !pending.current()) return this.discardNavigation();
      if (pending.prepare) {
        const recent = pending.recent;
        pending = await pending.prepare();
        if (this.stopped) return false;
        pending.recent = recent;
        this.pending = pending;
        this.publish({ pendingOperationId: pending.request.command.op_id });
      }
      if (!pending.attempted && pending.current && !pending.current()) return this.discardNavigation();
      pending.attempted = true;
      delete pending.prepare;
      const receipt = await this.service.executeOwner(pending.request);
      if (this.stopped) return false;
      pending.confirmed(receipt);
      this.pending = null;
      if (this.state.writing || this.state.pendingOperationId !== null) this.publish({ writing: false, pendingOperationId: null });
      this.flushNavigation();
      // View/Later/recovery receipts already publish the exact saved preferences. Their
      // completion must not wait for unrelated catalogue reads, which can remain
      // busy under periodic reconciliation. Navigation/global and domain edits
      // retain their immediate refresh; view edits reconcile on the normal timer.
      const command = pending.request.command;
      const viewOnly = command.command === 'preferences_patch' && command.params.entries.every(entry =>
        entry.kind === 'set_session_view' || entry.kind === 'set_later' || entry.kind === 'resolve_unsent_input');
      if (!viewOnly) await this.refresh();
      if ('project_id' in receipt && pending.followupIntent === this.navigationIntent) {
        this.openPage({ kind: 'page', page: 'sessions', projectId: receipt.project_id });
      }
      return true;
    } catch (error: unknown) {
      const failure = fail(error);
      // Preparation cannot have saved anything. Release the writer rather than
      // retaining an unsent command as an uncertain operation to check again.
      if (!pending.attempted) {
        if (pending.current && !pending.current()) return this.discardNavigation();
        this.pending = null;
        this.mutationFailure = failure;
        pending.failed?.(failure);
        this.publish({ writing: false, pendingOperationId: null, error: failure });
        return false;
      }
      if (failure instanceof CoreFailure && !['commit_uncertain', 'delivery_uncertain'].includes(failure.error.code)
        && pending.current && !pending.current()) {
        const discarded = this.discardNavigation();
        void this.refresh();
        return discarded;
      }
      const command = pending.request.command;
      const seenMayHaveCommitted = command.command === 'preferences_patch' && !!(this.seenFlight
        || this.seenCapture && this.seenCapture.preferences.revision >= command.params.expected_preferences_revision
        || [...this.seenCommits].some(revision => revision > command.params.expected_preferences_revision));
      if (pending.retrySeen && failure instanceof CoreFailure && failure.error.code === 'revision_conflict' && seenMayHaveCommitted) {
        try {
          const fresh = await this.capturePreferences();
          if (this.stopped) return false;
          if (this.onlySeenSince(command.params.expected_preferences_revision, fresh.revision)) {
            const next = await pending.retrySeen(fresh);
            if (next) {
              next.recent = pending.recent;
              this.pending = next;
              this.publish({ pendingOperationId: next.request.command.op_id });
              return this.completeMutation(next);
            }
          }
        } catch { /* Reconciliation below can recover a failed classification read. */ }
      }
      // Only a definite revision_conflict on a navigation patch is re-applied, once, against the
      // refreshed revision with a new operation id. Uncertain and every other rejection fall through.
      if ((pending.retry || pending.retrySeen && seenMayHaveCommitted)
        && failure instanceof CoreFailure && failure.error.code === 'revision_conflict') {
        try {
          await this.refresh();
          if (this.stopped) return false;
          const current = this.state.preferences;
          const next = pending.retrySeen && command.command === 'preferences_patch' && current
            && this.onlySeenSince(command.params.expected_preferences_revision, current.revision)
            ? await pending.retrySeen(structuredClone(current) as PreferencesSnapshot) : await pending.retry?.();
          if (next) {
            next.recent = pending.recent;
            this.pending = next;
            this.publish({ pendingOperationId: next.request.command.op_id });
            return this.completeMutation(next);
          }
        } catch { /* A failed rebase must still release the owner writer below. */ }
      }
      // A newer destination can arrive during the asynchronous rebase itself.
      if (failure instanceof CoreFailure && !['commit_uncertain', 'delivery_uncertain'].includes(failure.error.code)
        && pending.current && !pending.current()) {
        return this.discardNavigation();
      }
      this.mutationFailure = failure;
      pending.failed?.(failure);
      // An unknown completion retains the exact command and operation ID.
      // Definitive typed rejection permits a new, explicitly chosen action.
      if (failure instanceof CoreFailure && !['commit_uncertain', 'delivery_uncertain'].includes(failure.error.code)) this.pending = null;
      const refreshed = failure instanceof CoreFailure && failure.error.code === 'revision_conflict' ? this.refresh() : null;
      this.publish({ writing: false, pendingOperationId: this.pending?.request.command.op_id ?? null, error: failure });
      if (failure instanceof CoreFailure && failure.error.code === 'revision_conflict') {
        await refreshed;
      }
      return false;
    }
  }
  private discardNavigation(): false {
    this.pending = null;
    this.publish({ writing: false, pendingOperationId: null });
    this.flushNavigation();
    return false;
  }
  stop(): void {
    if (this.stopped) return;
    this.reading.stop();
    const finalMarks = new Map<string, SeenPatch>();
    // An upgrade baseline is automatic initialization, not an owner observation.
    // It can be cancelled on disposal; explicit reads and catch-up must survive.
    [...this.seenEntries, ...this.seenQueue.values()].forEach(entry => {
      if (entry.items.length || entry.topics.length) queueSeen(finalMarks, entry);
    });
    if (this.queuedNavigation) this.finishNavigation(this.queuedNavigation, false);
    this.stopped = true;
    this.textScaleTarget = null;
    this.seenQueue.clear();
    if (this.seenTimer) clearTimeout(this.seenTimer);
    this.seenTimer = null;
    this.seenWaits.forEach(finish => finish());
    this.seenCapture = null;
    this.seenCommits.clear();
    this.startupRoute = null;
    ++this.epoch;
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener('focus', this.reconcile);
    window.removeEventListener('pageshow', this.reconcile);
    document.removeEventListener('visibilitychange', this.visibility);
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.opened.closeAll();
    this.listeners.clear();
    // Finish pending read/catch-up observations on fresh preferences without delaying teardown.
    if (finalMarks.size) void this.writeSeen([...finalMarks.values()], 0, true);
  }
}

export function useNavigation(store: NavigationStore): NavigationState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
