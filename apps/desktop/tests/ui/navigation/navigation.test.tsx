import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import demo from '../../../../../fixtures/domain/demo/session.json';
import inventory from '../../../../../fixtures/contracts/core/inventory.json';
import type { CoreError, MutationEnvelope, OwnerMutationRequest, PreferencesSnapshot, ProjectListResult,
  QueryEnvelope, SessionListResult, SessionPreferences, SessionRef } from '../../../src/generated/core';
import type { ItemStatus, Page, ProjectSummary, QueryCursor, Session, SessionSummary, SummaryCounts } from '../../../src/generated/domain/models';
import { createDesktopService, type DesktopTransport, type HintPayloads } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import * as catalogue from '../../../src/state/navigation/catalogue';
import { NavigationWorkspace, type AdapterChoice } from '../../../src/components/navigation/NavigationWorkspace';
import { sessionCardText } from '../../../src/ui/pages/model';
import { BindSession, RegisterProject } from '../../../src/components/navigation/Registration';

const projectId = demo.project_id;
const route: SessionRef = { project_id: projectId, session_id: demo.id };
const operationId = '00000000-0000-4000-8000-000000000400';
const error: CoreError = { code: 'snapshot_changed', message: 'Catalogue changed.', hint: 'Restart this read.', retryable: false, field_errors: [] };
const counts = sessionsFixture.items[0].counts as SummaryCounts;
const prefsCommand = inventory.owner_commands.find(command => command.command === 'preferences_patch')!;
function preferences(revision = 1): PreferencesSnapshot {
  const entries = prefsCommand.params as { entries: { preferences?: unknown; draft?: unknown }[] };
  const session = structuredClone(entries.entries[1].preferences) as SessionPreferences;
  session.selected_item_id = '1.1';
  session.expanded_item_ids = ['1'];
  session.filters.search = 'keep exact café\nsearch';
  session.scroll = { item_id: '1.1', offset: 124 };
  return { schema_version: 1, revision, global: structuredClone(entries.entries[0].preferences) as PreferencesSnapshot['global'],
    sessions: [session], later: [], drafts: [structuredClone(entries.entries.find(entry => entry.draft)!.draft) as PreferencesSnapshot['drafts'][number]] };
}
function projectResult(): ProjectListResult {
  return { projects: structuredClone(projectsFixture) as Page<ProjectSummary>, counts: { ...structuredClone(counts), completeness: 'partial' } };
}
function sessionResult(): SessionListResult {
  return { sessions: structuredClone(sessionsFixture) as Page<SessionSummary>, counts: structuredClone(counts), active_total: 9, closed_total: 3, archived_total: 0 };
}
const loaded = () => success('session_get', { session: structuredClone(demo) as Session, freshness: 'fresh' });
function success(kind: Extract<QueryEnvelope, { ok: true }>['data']['kind'], data: unknown): QueryEnvelope {
  return { api_version: 1, ok: true, data: { kind, data } } as QueryEnvelope;
}
function patchReceipt(revision = 2): MutationEnvelope {
  return { api_version: 1, ok: true, data: { operation_id: operationId, preferences_revision: revision } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Transport implements DesktopTransport {
  readonly calls: { name: string; request: OwnerMutationRequest | Parameters<DesktopTransport['invoke']>[1]['request'] }[] = [];
  readonly responses = new Map<string, (QueryEnvelope | MutationEnvelope | Promise<QueryEnvelope | MutationEnvelope> | Error)[]>();
  readonly listeners = new Map<keyof HintPayloads, Set<(hint: never) => void>>();
  readonly unsubscribed: string[] = [];
  enqueue(name: string, ...responses: (QueryEnvelope | MutationEnvelope | Promise<QueryEnvelope | MutationEnvelope> | Error)[]) {
    const queue = this.responses.get(name) ?? []; queue.push(...responses); this.responses.set(name, queue);
  }
  async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    this.calls.push({ name, request: structuredClone(args.request) });
    const response = this.responses.get(name)?.shift();
    if (!response) throw new Error(`Test script exhausted: ${name}`);
    if (response instanceof Error) throw response;
    return await response as T;
  }
  async listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void) {
    const callbacks = this.listeners.get(event) ?? new Set(); callbacks.add(receive as (hint: never) => void); this.listeners.set(event, callbacks);
    return () => { callbacks.delete(receive as (hint: never) => void); this.unsubscribed.push(event); };
  }
  emit<E extends keyof HintPayloads>(event: E, hint: HintPayloads[E]) { this.listeners.get(event)?.forEach(receive => receive(hint as never)); }
}
const stores: NavigationStore[] = [];
function setup() {
  const transport = new Transport(); const service = createDesktopService(transport);
  const store = new NavigationStore(service, () => operationId); stores.push(store);
  return { transport, service, store };
}
function read(transport: Transport, prefs = preferences(), projects = projectResult(), sessions = sessionResult()) {
  transport.enqueue('preferences_get', success('preferences_get', prefs));
  transport.enqueue('project_list', success('project_list', projects));
  transport.enqueue('session_list', success('session_list', sessions));
}
async function deferredStartup(transport: Transport, store: NavigationStore) {
  const initial = preferences(); initial.global.selected_navigation = { kind: 'projects' }; initial.sessions = [];
  const blocked = deferred<QueryEnvelope>();
  transport.enqueue('preferences_get', blocked.promise);
  transport.enqueue('project_list', success('project_list', projectResult()));
  transport.enqueue('session_list', success('session_list', sessionResult()));
  const startup = store.start();
  await waitFor(() => expect(transport.calls.some(call => call.name === 'preferences_get')).toBe(true));
  return { initial, blocked, startup };
}
const cursor = (view: 'projects' | 'sessions', revision = 21): QueryCursor => ({ schema: 1, view,
  revision, filter_digest: 'a'.repeat(64), after: view === 'projects' ? { kind: 'project', canonical_root: '/fixtures/ariadne-demo', id: projectId }
    : { kind: 'session', project_id: projectId, id: demo.id, updated_at: demo.updated_at } });
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); });

describe('complete registered navigation reads', () => {
  it.each([false, true])('normalizes every loaded full status set to All with duplicates=%s', async duplicates => {
    const { transport, store } = setup();
    const statuses: ItemStatus[] = ['open', 'waiting_on_me', 'in_progress', 'decided', 'done', 'dropped', 'replaced'];
    const initial = preferences();
    initial.sessions[0].filters.statuses = duplicates ? [...statuses, 'open', 'done'] : statuses;
    const before = structuredClone(initial);
    read(transport, initial);
    await store.start();
    expect(store.getSnapshot().preferences).toEqual({ ...before,
      sessions: [{ ...before.sessions[0], filters: { ...before.sessions[0].filters, statuses: [] } }] });
    expect(initial).toEqual(before);
    expect(transport.calls.some(call => 'command' in call.request)).toBe(false);

    const refreshed = preferences(2);
    refreshed.sessions[0].filters.statuses = ['open', 'open', 'waiting_on_me'];
    read(transport, refreshed); await store.refresh();
    expect(store.getSnapshot().preferences?.sessions[0].filters.statuses).toEqual(['open', 'open', 'waiting_on_me']);
    const full = preferences(3);
    full.sessions[0].filters.statuses = [...statuses, 'replaced'];
    read(transport, full); await store.refresh();
    expect(store.getSnapshot().preferences?.sessions[0].filters.statuses).toEqual([]);
  });
  it('subscribes before loading and captures every project/session page with backend counts', async () => {
    const { transport, store } = setup();
    transport.enqueue('preferences_get', success('preferences_get', preferences()));
    const projects = projectResult(); const second = structuredClone(projects);
    projects.projects.items = [projects.projects.items[0]]; projects.projects.next_cursor = cursor('projects');
    second.projects.items = [second.projects.items[1]];
    transport.enqueue('project_list', success('project_list', projects), success('project_list', second));
    const sessions = sessionResult(); const next = structuredClone(sessions);
    sessions.sessions.next_cursor = cursor('sessions');
    next.sessions.items = [{ ...next.sessions.items[0], session_id: '00000000-0000-4000-8000-000000000003', title: 'Closed', state: 'closed', closed_at: demo.updated_at }];
    transport.enqueue('session_list', success('session_list', sessions), success('session_list', next));
    await store.start();
    expect(transport.listeners.has('ariadne://route')).toBe(true);
    expect(store.getSnapshot().projects?.projects.items).toHaveLength(2);
    expect(store.getSnapshot().sessions?.sessions.items).toHaveLength(2);
    expect(store.getSnapshot().sessions?.active_total).toBe(9);
    expect(store.getSnapshot().sessions?.closed_total).toBe(3);
    expect(store.getSnapshot().projects?.counts.completeness).toBe('partial');
    expect(transport.calls.filter(call => call.name === 'session_list').map(call => call.request)).toEqual([
      { session: null, request: { command: 'session_list', params: { project_id: null, state: null, cursor: null, limit: 100 } } },
      { session: null, request: { command: 'session_list', params: { project_id: null, state: null, cursor: cursor('sessions'), limit: 100 } } },
    ]);
    expect(Object.isFrozen(store.getSnapshot().projects?.projects.items[0].counts)).toBe(true);
  });
  it('preserves the last complete catalogue on continuation failure and restarts from null', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const before = store.getSnapshot().projects;
    const first = projectResult(); first.projects.items = [first.projects.items[0]]; first.projects.next_cursor = cursor('projects');
    transport.enqueue('preferences_get', success('preferences_get', preferences()));
    transport.enqueue('project_list', success('project_list', first), { api_version: 1, ok: false, error });
    transport.enqueue('session_list', success('session_list', sessionResult()));
    await store.refresh();
    expect(store.getSnapshot().status).toBe('stale');
    expect(store.getSnapshot().projects).toBe(before);
    read(transport); await store.refresh();
    expect(transport.calls.filter(call => call.name === 'project_list').slice(-1)[0]?.request).toMatchObject({ request: { params: { cursor: null } } });
    expect(store.getSnapshot().status).toBe('ready');
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().error).toBeNull();
  });
  it.each(['revision', 'digest', 'duplicate', 'counts', 'empty'] as const)('rejects %s changes during a page capture', async mismatch => {
    const { transport, service } = setup();
    const first = projectResult(); const next = structuredClone(first);
    first.projects.items = [first.projects.items[0]]; first.projects.next_cursor = cursor('projects'); next.projects.items = [next.projects.items[1]];
    if (mismatch === 'revision') next.projects.snapshot_revision = 22;
    if (mismatch === 'digest') next.projects.next_cursor = { ...cursor('projects'), filter_digest: 'b'.repeat(64) };
    if (mismatch === 'duplicate') next.projects.items = first.projects.items;
    if (mismatch === 'counts') next.counts.waiting_unanswered++;
    if (mismatch === 'empty') { next.projects.items = []; next.projects.next_cursor = cursor('projects'); }
    transport.enqueue('project_list', success('project_list', first), success('project_list', next));
    await expect(catalogue.projects(service)).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('rejects a contradictory project filter and retains uncomposed Unsupported as an error', async () => {
    const { transport, service, store } = setup(); transport.enqueue('session_list', success('session_list', sessionResult()));
    await expect(catalogue.sessions(service, '00000000-0000-4000-8000-000000000009')).rejects.toMatchObject({ reason: 'invalid_response' });
    transport.enqueue('preferences_get', { api_version: 1, ok: false, error: { ...error, code: 'unsupported', message: 'Preferences are not composed.' } });
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', projects: null, sessions: null, preferences: null });
    expect(store.getSnapshot().error?.message).toBe('Preferences are not composed.');
  });
  it('ignores responses after stop and releases route/hint subscriptions', async () => {
    const { transport, store } = setup(); const pending = deferred<QueryEnvelope>();
    transport.enqueue('preferences_get', pending.promise); const started = store.start();
    await waitFor(() => expect(transport.calls).toHaveLength(1));
    store.stop(); pending.resolve(success('preferences_get', preferences())); await started;
    expect(store.getSnapshot().preferences).toBeNull();
    expect(transport.unsubscribed.sort()).toEqual(['ariadne://preferences_changed', 'ariadne://route', 'ariadne://session_changed']);
    expect(transport.calls).toHaveLength(1);
  });
  it('does not drop sessions whose project was absent from the independent project capture', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const previous = store.getSnapshot().sessions;
    const result = sessionResult(); result.sessions.items[0].project_id = '00000000-0000-4000-8000-000000000007';
    read(transport, preferences(), projectResult(), result); await store.refresh();
    expect(store.getSnapshot().sessions).toBe(previous);
    expect(store.getSnapshot().status).toBe('stale');
    expect(store.getSnapshot().error).toMatchObject({ reason: 'invalid_response' });
  });
  it('refreshes on wake/focus/poll and preserves state when preference revision regresses', async () => {
    vi.useFakeTimers(); const { transport, store } = setup(); read(transport, preferences(3)); await store.start();
    read(transport, preferences(4)); window.dispatchEvent(new Event('focus')); await store.refresh();
    // A refresh coalesced while in flight requests one follow-up capture.
    const previous = store.getSnapshot().preferences;
    transport.enqueue('preferences_get', success('preferences_get', preferences(2))); await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSnapshot().preferences).toBe(previous);
    expect(store.getSnapshot().error).toMatchObject({ reason: 'invalid_response' });
    const count = transport.calls.length; store.stop(); await vi.advanceTimersByTimeAsync(4000); expect(transport.calls.length).toBe(count);
  });
});

describe('canonical preference mutations', () => {
  it.each(['confirmed', 'uncertain', 'rejected', 'stopped'] as const)('exposes only the executing write completion when it is %s', async outcome => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const held = deferred<MutationEnvelope>(); transport.enqueue('preferences_patch', held.promise);
    const edit = structuredClone(prefs.sessions[0]); edit.scroll = { item_id: '1', offset: 12 };
    expect(store.getWritingCompletion()).toBeNull();
    const saved = store.saveSessionView(edit, prefs.revision);
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    const completion = store.getWritingCompletion(); expect(completion).not.toBeNull();
    expect(store.getWritingCompletion()).toBe(completion);
    if (outcome === 'stopped') store.stop();
    held.resolve(outcome === 'uncertain' || outcome === 'rejected'
      ? { api_version: 1, ok: false, error: { ...error, code: outcome === 'uncertain' ? 'commit_uncertain' : 'invalid_transition' } }
      : patchReceipt());
    expect(await completion).toBe(outcome === 'confirmed');
    expect(await saved).toBe(outcome === 'confirmed');
    expect(store.getWritingCompletion()).toBeNull();
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().pendingOperationId).toBe(outcome === 'uncertain' || outcome === 'stopped' ? operationId : null);
    expect(store.getSnapshot().preferences?.sessions[0].scroll).toEqual(outcome === 'confirmed' ? edit.scroll : prefs.sessions[0].scroll);
  });
  it('settles a revision_conflict as current, unblocked and reported only for that rejection', async () => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const held = deferred<MutationEnvelope>(); transport.enqueue('preferences_patch', held.promise);
    const edit = structuredClone(prefs.sessions[0]); edit.scroll = { item_id: '1', offset: 12 };
    const saved = store.saveSessionView(edit, prefs.revision);
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    const completion = store.getWritingCompletion()!;
    expect(store.settledAsConflict(completion)).toBe(false);
    // Both the first attempt and its single re-apply conflict, so the failure surfaces.
    read(transport, preferences(prefs.revision + 1));
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 3 } });
    read(transport, preferences(prefs.revision + 2));
    held.resolve({ api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 2 } });
    expect(await saved).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null });
    expect(store.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
    expect(store.settledAsConflict(completion)).toBe(true);
    const next = deferred<MutationEnvelope>(); transport.enqueue('preferences_patch', next.promise);
    const again = store.saveSessionView(edit, prefs.revision + 2);
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    expect(store.settledAsConflict(store.getWritingCompletion()!)).toBe(false);
    expect(store.settledAsConflict(completion)).toBe(true);
    next.resolve(patchReceipt()); await again;
  });
  it('stops reporting a conflict once a later write is rejected with a different failure', async () => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const held = deferred<MutationEnvelope>(); transport.enqueue('preferences_patch', held.promise);
    const edit = structuredClone(prefs.sessions[0]); edit.scroll = { item_id: '1', offset: 12 };
    const saved = store.saveSessionView(edit, prefs.revision);
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    const completion = store.getWritingCompletion()!;
    read(transport, preferences(prefs.revision + 1));
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 3 } });
    read(transport, preferences(prefs.revision + 2));
    held.resolve({ api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 2 } });
    expect(await saved).toBe(false);
    expect(store.settledAsConflict(completion)).toBe(true);
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'invalid_transition' } });
    expect(await store.saveSessionView(edit, prefs.revision + 2)).toBe(false);
    expect(store.getSnapshot().error).toMatchObject({ error: { code: 'invalid_transition' } });
    expect(store.settledAsConflict(completion)).toBe(false);
  });
  it('cancels older unsubmitted intent on a current busy navigation attempt while ignoring stale callbacks', async () => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const held = deferred<MutationEnvelope>(); transport.enqueue('preferences_patch', held.promise);
    const saved = store.saveSessionView(prefs.sessions[0], prefs.revision);
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    const intent = store.getNavigationIntent(), request = store.getNavigationRequest();
    expect(await store.navigate({ kind: 'all_sessions' }, null, () => false)).toBe(false);
    expect(store.getNavigationIntent()).toBe(intent);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(false);
    expect(store.getNavigationIntent()).toBe(intent! + 1);
    expect(store.getNavigationRequest()).toBe(request);
    held.resolve(patchReceipt()); expect(await saved).toBe(true);
    store.stop(); expect(store.getNavigationIntent()).toBeNull();
    expect(await store.navigate({ kind: 'projects' })).toBe(false);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
  });
  it('closing a tab preserves all view settings and drafts and sends only preference entries', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'session', session: route };
    read(transport, prefs); await store.start();
    const next = structuredClone(prefs); next.revision = 2; next.sessions[0].tab_open = false; next.global.selected_navigation = { kind: 'projects' };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    const intent = store.getNavigationRequest();
    expect(await store.closeTab(route)).toBe(true);
    expect(store.getNavigationRequest()).toBe(intent + 1);
    const command = transport.calls.find(call => call.name === 'preferences_patch')!.request as OwnerMutationRequest;
    expect(command).toEqual({ session: null, command: { api_version: 1, op_id: operationId, command: 'preferences_patch',
      params: { expected_preferences_revision: 1, entries: [
        { kind: 'set_session_view', preferences: { ...prefs.sessions[0], tab_open: false } },
        { kind: 'set_global', preferences: { ...prefs.global, selected_navigation: { kind: 'projects' } } },
      ] } } });
    expect(store.getSnapshot().preferences?.drafts).toEqual(prefs.drafts);
    expect(transport.calls.every(call => !['session_close', 'binding_pause', 'input_cancel'].includes(call.name))).toBe(true);
  });
  it('reopening a tab keeps filters, selection and draft bytes without resuming dispatch', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.sessions[0].tab_open = false;
    read(transport, prefs); await store.start(); transport.enqueue('session_get', loaded(), loaded());
    const next = structuredClone(prefs); next.revision = 2; next.sessions[0].tab_open = true; next.global.selected_navigation = { kind: 'session', session: route };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    expect(await store.navigate({ kind: 'session', session: route })).toBe(true);
    expect(store.getSnapshot().preferences?.sessions[0]).toEqual({ ...prefs.sessions[0], tab_open: true });
    expect(store.getSnapshot().preferences?.drafts).toEqual(prefs.drafts);
    expect(transport.calls.some(call => call.name === 'binding_resume')).toBe(false);
  });
  it('a slow old session click cannot overwrite a newer navigation action', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const slow = deferred<QueryEnvelope>(); transport.enqueue('session_get', slow.promise);
    const intent = store.getNavigationRequest();
    const older = store.navigate({ kind: 'session', session: route });
    expect(store.getNavigationRequest()).toBe(intent + 1);
    const next = preferences(2); next.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(true);
    expect(store.getNavigationRequest()).toBe(intent + 2);
    slow.resolve(loaded()); expect(await older).toBe(false);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().preferences?.global.selected_navigation.kind).toBe('all_sessions');
  });
  it('abandons a canceled owner reveal before dispatch or publication when session validation finishes', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const before = store.getSnapshot(), slow = deferred<QueryEnvelope>(); let current = true;
    transport.enqueue('session_get', slow.promise);
    const pending = store.navigate({ kind: 'session', session: route }, null, () => current);
    expect(store.getNavigationRequest()).toBe(1); current = false; slow.resolve(loaded());
    expect(await pending).toBe(false);
    expect(store.getSnapshot().preferences).toBe(before.preferences); expect(store.getSnapshot().reveal).toBe(before.reveal);
    expect(transport.calls.some(call => call.name === 'preferences_patch')).toBe(false);
    const reads = transport.calls.length;
    expect(await store.navigate({ kind: 'all_sessions' }, null, () => false)).toBe(false);
    expect(transport.calls).toHaveLength(reads); expect(store.getNavigationRequest()).toBe(1);
  });
  it('unknown mutation completion retains the exact operation, prevents another command and reconciles with the same ID', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'commit_uncertain', message: 'Preference commit is uncertain.' } }, patchReceipt());
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(false);
    expect(store.getSnapshot().pendingOperationId).toBe(operationId);
    const failure = store.getSnapshot().error;
    read(transport); await store.refresh();
    expect(store.getSnapshot().error).toBe(failure);
    expect(store.getSnapshot().pendingOperationId).toBe(operationId);
    expect(await store.navigate({ kind: 'projects' })).toBe(false);
    const next = preferences(2); next.global.selected_navigation = { kind: 'all_sessions' }; read(transport, next);
    expect(await store.retryMutation()).toBe(true);
    const calls = transport.calls.filter(call => call.name === 'preferences_patch'); expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
    expect(store.getSnapshot().pendingOperationId).toBeNull();
  });
  it('a confirmed tab close stays visible when the follow-up read fails or returns an older revision', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'session', session: route };
    read(transport, prefs); await store.start(); transport.enqueue('preferences_patch', patchReceipt());
    transport.enqueue('preferences_get', success('preferences_get', prefs));
    expect(await store.closeTab(route)).toBe(true);
    expect(store.getSnapshot().preferences?.revision).toBe(2);
    expect(store.getSnapshot().preferences?.sessions[0].tab_open).toBe(false);
    expect(store.getSnapshot().preferences?.global.selected_navigation.kind).toBe('projects');
    expect(store.getSnapshot().status).toBe('stale');
    expect(store.getSnapshot().error).toMatchObject({ reason: 'invalid_response' });
    expect(store.selectedSession()).toBeNull();
  });
  it('reconciliation of an old saved receipt cannot regress a newer preferences snapshot', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('preferences_patch', new Error('Completion unknown'), patchReceipt(2));
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(false);
    const newer = preferences(3); newer.global.selected_navigation = { kind: 'project', project_id: projectId };
    read(transport, newer); await store.refresh();
    read(transport, newer); expect(await store.retryMutation()).toBe(true);
    expect(store.getSnapshot().preferences?.revision).toBe(3);
    expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual(newer.global.selected_navigation);
  });
  it.each(['preferences', 'catalogue'] as const)('retains a native item route during the deferred initial %s read', async (blockedRead) => {
    const { transport, store } = setup();
    const initial = preferences(); initial.global.selected_navigation = { kind: 'projects' }; initial.sessions = [];
    const blocked = deferred<QueryEnvelope>();
    transport.enqueue('preferences_get', blockedRead === 'preferences' ? blocked.promise : success('preferences_get', initial));
    transport.enqueue('project_list', blockedRead === 'catalogue' ? blocked.promise : success('project_list', projectResult()));
    transport.enqueue('session_list', success('session_list', sessionResult()));
    const startup = store.start();
    await waitFor(() => expect(transport.calls.some(call => call.name === (blockedRead === 'preferences' ? 'preferences_get' : 'project_list'))).toBe(true));
    transport.enqueue('reveal_item', success('reveal_item', { ...route, item_id: '1.1' }));
    transport.enqueue('session_get', loaded(), loaded());
    transport.enqueue('preferences_patch', patchReceipt(2));
    const next = preferences(2); next.global.selected_navigation = { kind: 'session', session: route };
    read(transport, next);
    // The newly opened SessionStore also reads the ordinary presence catalogue.
    transport.enqueue('session_list', success('session_list', sessionResult()));
    transport.emit('ariadne://route', { ...route, item_id: '1.1' });
    await waitFor(() => expect(store.opened.open(route).getSnapshot().status).toBe('ready'));
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(0);
    blocked.resolve(blockedRead === 'preferences' ? success('preferences_get', initial) : success('project_list', projectResult()));
    await startup;
    await waitFor(() => expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'session', session: route }));
    expect(store.getSnapshot().preferences?.sessions[0].selected_item_id).toBe('1.1');
    expect(store.getSnapshot().reveal).toMatchObject({ kind: 'item', route: { ...route, item_id: '1.1' } });
    expect(store.getSnapshot().error).toBeNull();
    const patches = transport.calls.filter(call => call.name === 'preferences_patch');
    expect(patches).toHaveLength(1);
    expect((patches[0].request as OwnerMutationRequest).command.params).toMatchObject({ expected_preferences_revision: 1 });
  });
  it('applies only the latest registered item route retained before startup completes', async () => {
    const { transport, store } = setup();
    const { initial, blocked, startup } = await deferredStartup(transport, store);
    transport.enqueue('reveal_item', success('reveal_item', { ...route, item_id: '1.1' }), success('reveal_item', { ...route, item_id: '3' }));
    transport.enqueue('session_get', loaded(), loaded(), loaded());
    transport.emit('ariadne://route', { ...route, item_id: '1.1' });
    await waitFor(() => expect(store.opened.open(route).getSnapshot().status).toBe('ready'));
    transport.emit('ariadne://route', { ...route, item_id: '3' });
    await waitFor(() => expect(transport.calls.filter(call => call.name === 'session_get')).toHaveLength(2));
    transport.enqueue('preferences_patch', patchReceipt(2));
    const next = preferences(2); next.global.selected_navigation = { kind: 'session', session: route }; next.sessions[0].selected_item_id = '3';
    read(transport, next);
    transport.enqueue('session_list', success('session_list', sessionResult()), success('session_list', sessionResult()));
    blocked.resolve(success('preferences_get', initial)); await startup;
    await waitFor(() => expect(store.getSnapshot().preferences?.sessions[0]?.selected_item_id).toBe('3'));
    expect(store.getSnapshot().reveal).toMatchObject({ kind: 'item', route: { ...route, item_id: '3' } });
    const patches = transport.calls.filter(call => call.name === 'preferences_patch');
    expect(patches).toHaveLength(1);
    expect((patches[0].request as OwnerMutationRequest).command.params).toMatchObject({ entries: [
      { kind: 'set_global' }, { kind: 'set_session_view', preferences: { selected_item_id: '3' } },
    ] });
  });
  it('retains a later item route whose validation crosses the pending startup route write', async () => {
    const { transport, store } = setup();
    const { initial, blocked, startup } = await deferredStartup(transport, store);
    const later = deferred<QueryEnvelope>(), firstWrite = deferred<MutationEnvelope>();
    transport.enqueue('reveal_item', success('reveal_item', { ...route, item_id: '1.1' }), later.promise);
    transport.enqueue('session_get', loaded(), loaded(), loaded(), loaded());
    transport.enqueue('preferences_patch', firstWrite.promise, patchReceipt(3));
    const first = preferences(2); first.global.selected_navigation = { kind: 'session', session: route };
    const second = structuredClone(first); second.revision = 3; second.sessions[0].selected_item_id = '3';
    read(transport, first); read(transport, second);
    transport.enqueue('session_list', success('session_list', sessionResult()), success('session_list', sessionResult()));
    transport.emit('ariadne://route', { ...route, item_id: '1.1' });
    await waitFor(() => expect(store.opened.open(route).getSnapshot().status).toBe('ready'));
    transport.emit('ariadne://route', { ...route, item_id: '3' });
    await waitFor(() => expect(transport.calls.filter(call => call.name === 'reveal_item')).toHaveLength(2));
    blocked.resolve(success('preferences_get', initial)); await startup;
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    later.resolve(success('reveal_item', { ...route, item_id: '3' }));
    await waitFor(() => expect(transport.calls.filter(call => call.name === 'session_get')).toHaveLength(3));
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    firstWrite.resolve(patchReceipt(2));
    await waitFor(() => expect(store.getSnapshot().preferences?.revision).toBe(3));
    expect(store.getSnapshot().preferences?.sessions[0].selected_item_id).toBe('3');
    expect(store.getSnapshot().reveal).toMatchObject({ kind: 'item', route: { ...route, item_id: '3' } });
    const patches = transport.calls.filter(call => call.name === 'preferences_patch');
    expect(patches).toHaveLength(2);
    expect(patches.map(call => (call.request as OwnerMutationRequest).command.params)).toMatchObject([
      { expected_preferences_revision: 1, entries: [{ kind: 'set_global' }, { kind: 'set_session_view', preferences: { selected_item_id: '1.1' } }] },
      { expected_preferences_revision: 2, entries: [{ kind: 'set_global' }, { kind: 'set_session_view', preferences: { selected_item_id: '3' } }] },
    ]);
  });
  it('retains an early session route across a failed initial read and a later reconciliation', async () => {
    const { transport, store } = setup();
    const { initial, blocked, startup } = await deferredStartup(transport, store);
    transport.enqueue('session_get', loaded(), loaded());
    transport.enqueue('session_list', success('session_list', sessionResult()));
    transport.emit('ariadne://route', { ...route, item_id: null });
    blocked.resolve({ api_version: 1, ok: false, error }); await startup;
    expect(store.getSnapshot().status).toBe('unavailable');
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(0);
    // The failed preferences read did not consume the first catalogue responses.
    transport.enqueue('preferences_get', success('preferences_get', initial));
    transport.enqueue('preferences_patch', patchReceipt(2));
    const next = preferences(2); next.global.selected_navigation = { kind: 'session', session: route };
    read(transport, next); await store.refresh();
    await waitFor(() => expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'session', session: route }));
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().error).toBeNull();
  });
  it('stopping during the first read discards retained routes and cannot write after read completion', async () => {
    const { transport, store } = setup();
    const { initial, blocked, startup } = await deferredStartup(transport, store);
    transport.emit('ariadne://route', { ...route, item_id: null });
    store.stop(); const calls = transport.calls.length;
    blocked.resolve(success('preferences_get', initial)); await startup;
    transport.emit('ariadne://route', { ...route, item_id: null }); await store.refresh();
    expect(transport.calls).toHaveLength(calls);
    expect(store.getSnapshot().preferences).toBeNull();
    expect(transport.unsubscribed.sort()).toEqual(['ariadne://preferences_changed', 'ariadne://presence_changed', 'ariadne://route', 'ariadne://session_changed', 'ariadne://session_changed']);
  });
  it('replays an uncertain startup route mutation with its original operation and no second queued write', async () => {
    const { transport, store } = setup();
    const { initial, blocked, startup } = await deferredStartup(transport, store);
    transport.emit('ariadne://route', { ...route, item_id: null });
    transport.enqueue('session_get', loaded(), loaded());
    transport.enqueue('session_list', success('session_list', sessionResult()));
    transport.enqueue('preferences_patch', new Error('Completion unknown'), patchReceipt(2));
    blocked.resolve(success('preferences_get', initial)); await startup;
    await waitFor(() => expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: operationId, error: { reason: 'transport' } }));
    const next = preferences(2); next.global.selected_navigation = { kind: 'session', session: route };
    read(transport, next); expect(await store.retryMutation()).toBe(true);
    const patches = transport.calls.filter(call => call.name === 'preferences_patch');
    expect(patches).toHaveLength(2); expect(patches[1].request).toEqual(patches[0].request);
    expect(store.getSnapshot().pendingOperationId).toBeNull();
    expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'session', session: route });
  });
  it('registered session route hints use exact SessionRef fields without leaking nullable item routing into preferences', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('session_get', loaded(), loaded());
    const next = preferences(2); next.global.selected_navigation = { kind: 'session', session: route };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    transport.emit('ariadne://route', { ...route, item_id: null });
    await waitFor(() => expect(store.getSnapshot().preferences?.revision).toBe(2));
    const command = transport.calls.find(call => call.name === 'preferences_patch')?.request as OwnerMutationRequest;
    if (command.command.command !== 'preferences_patch') throw new Error('Wrong test command');
    const first = command.command.params.entries[0];
    if (first.kind !== 'set_global' || first.preferences.selected_navigation.kind !== 'session') throw new Error('Wrong test entry');
    expect(first.preferences.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(Object.keys(first.preferences.selected_navigation.session).sort()).toEqual(['project_id', 'session_id']);
  });
  it('a missing-item reveal preserves the saved selection and exposes its banner without invented ancestors', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('reveal_item', { api_version: 1, ok: false, error: { ...error, code: 'not_found', message: 'The item was deleted.' } });
    transport.enqueue('session_get', loaded(), loaded());
    const next = preferences(2); next.global.selected_navigation = { kind: 'session', session: route };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    transport.emit('ariadne://route', { ...route, item_id: '999' });
    await waitFor(() => expect(store.getSnapshot().preferences?.revision).toBe(2));
    expect(store.getSnapshot().preferences?.sessions[0].selected_item_id).toBe('1.1');
    expect(store.getSnapshot().reveal).toMatchObject({ kind: 'missing_item', requestedItemId: '999', banner: 'Ariadne can’t find that any more. It may have been removed.' });
  });
});

const adapter: AdapterChoice = { adapter_id: 'demo.local', label: 'Installed adapter', configuration: { namespace: 'demo.local', values: {} } };
describe('source-backed navigation views and explicit registration', () => {
  it.each(['projects', 'project', 'all_sessions'] as const)('blocks %s navigation during explicit Refresh until fresh preferences are published', async kind => {
    const { transport, store } = setup(); const prefs = preferences();
    prefs.global.selected_navigation = kind === 'project' ? { kind, project_id: projectId } : { kind };
    read(transport, prefs);
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} renderSession={() => null} />);
    const allSessions = screen.getByRole('button', { name: /^All sessions/ });
    await waitFor(() => expect((allSessions as HTMLButtonElement).disabled).toBe(false));
    const conflict: CoreError = { ...error, code: 'revision_conflict', message: 'Preferences revision changed.', current_revision: 3 };
    const native = structuredClone(prefs); native.revision = 3;
    native.global.window = { x: 100, y: 100, width: 1000, height: 700, monitor_id: 'main' };
    // The single re-apply against the refreshed revision conflicts too, so the banner surfaces.
    // A foreign write bumps the revision to 2 before the first attempt lands, and again to 3 before the retry lands.
    const first = structuredClone(prefs); first.revision = 2;
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...conflict, current_revision: 2 } }, { api_version: 1, ok: false, error: conflict });
    read(transport, first); read(transport, native);
    await act(async () => { fireEvent.click(allSessions); });
    expect(store.getSnapshot().preferences).toEqual(native);
    expect(screen.getByRole('alert').textContent).toContain('This changed while you were working. Look at it as it is now, then try again.');
    expect((allSessions as HTMLButtonElement).disabled).toBe(false);

    const fresh = structuredClone(native); fresh.revision = 4; fresh.global.notification_watermark = demo.updated_at;
    const preferenceRead = deferred<QueryEnvelope>(); const projectRead = deferred<QueryEnvelope>();
    transport.enqueue('preferences_get', preferenceRead.promise);
    transport.enqueue('project_list', projectRead.promise);
    transport.enqueue('session_list', success('session_list', sessionResult()));
    const readCount = transport.calls.filter(call => call.name === 'preferences_get').length;
    // The listing pages read each session's snapshot for its card; Refresh must not open a session.
    const sessionReads = () => transport.calls.filter(call => call.name === 'session_get').length;
    const snapshotReads = sessionReads();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement).disabled).toBe(true);
    const tabs = screen.getByRole('navigation', { name: 'Projects and sessions' });
    within(tabs).getAllByRole('button').forEach(button => {
      expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button);
    });
    if (kind === 'projects') {
      expect((screen.getByRole('button', { name: 'Register project' }) as HTMLButtonElement).disabled).toBe(true);
      const cards = [...document.querySelectorAll<HTMLButtonElement>('.pw-project-open')]; expect(cards).not.toHaveLength(0);
      cards.forEach(card => { expect(card.disabled).toBe(true); fireEvent.click(card); fireEvent.click(card.closest('.pw-project-card')!); });
    } else {
      const open = document.querySelector<HTMLButtonElement>(`button[data-session-id="${demo.id}"]`)!;
      expect(open.disabled).toBe(true); fireEvent.click(open);
      if (kind === 'project') expect((screen.getByRole('button', { name: 'Connect existing session' }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Refreshing…' }));
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(2);
    expect(sessionReads()).toBe(snapshotReads);
    await waitFor(() => expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(readCount + 1));
    await act(async () => { preferenceRead.resolve(success('preferences_get', fresh)); });
    expect(store.getSnapshot().preferences).toEqual(native);
    expect((allSessions as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeTruthy();
    await act(async () => { projectRead.resolve(success('project_list', projectResult())); });
    expect(store.getSnapshot().preferences).toEqual(fresh);
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
    expect((allSessions as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('This changed while you were working. Look at it as it is now, then try again.');
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(2);
    expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(readCount + 1);

    const saved = structuredClone(fresh); saved.revision = 5; saved.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', patchReceipt(5)); read(transport, saved);
    await act(async () => { fireEvent.click(allSessions); });
    const mutations = transport.calls.filter(call => call.name === 'preferences_patch'); expect(mutations).toHaveLength(3);
    expect(mutations[2].request).toMatchObject({ command: { params: { expected_preferences_revision: 4,
      entries: [{ kind: 'set_global', preferences: saved.global }] } } });
    expect(store.getSnapshot().preferences).toEqual(saved);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'All sessions', level: 1 })).toBeTruthy();
  });
  it('clears explicit Refresh progress after a failed read and keeps failure visible without changing navigation', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'projects' };
    read(transport, prefs);
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[]} renderSession={() => null} />);
    const allSessions = screen.getByRole('button', { name: /^All sessions/ });
    await waitFor(() => expect((allSessions as HTMLButtonElement).disabled).toBe(false));
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error });
    await act(async () => { fireEvent.click(allSessions); });
    const before = store.getSnapshot(); const pending = deferred<QueryEnvelope>();
    transport.enqueue('preferences_get', pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((allSessions as HTMLButtonElement).disabled).toBe(true);
    const failure: CoreError = { ...error, message: 'Preferences read failed.', hint: 'Try refreshing again.' };
    await act(async () => { pending.resolve({ api_version: 1, ok: false, error: failure }); });
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
    expect((allSessions as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('This changed while you were working. Look at it as it is now, then try again.');
    expect(screen.getByRole('alert').textContent).not.toContain(failure.message);
    expect(screen.getByRole('alert').textContent).not.toContain(failure.hint);
    expect(screen.getByText('Showing the last complete catalogue. Refresh failed.')).toBeTruthy();
    expect(store.getSnapshot().preferences).toBe(before.preferences);
    expect(store.getSnapshot().projects).toBe(before.projects);
    expect(store.getSnapshot().sessions).toBe(before.sessions);
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'All sessions', level: 1 })).toBeNull();
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
  });
  it('shows nullable unavailable project metadata, backend totals, grouped closed sessions and functional tabs', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'all_sessions' };
    const result = sessionResult(); result.sessions.items.push({ ...result.sessions.items[0], session_id: '00000000-0000-4000-8000-000000000003', title: 'Closed work', state: 'closed', closed_at: demo.updated_at });
    read(transport, prefs, projectResult(), result);
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} renderSession={() => <p>Session workspace</p>} />);
    expect(await screen.findByRole('heading', { name: 'All sessions', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Closed · \d+$/, level: 3 })).toBeTruthy();
    const closed = document.querySelector('[data-session-card="00000000-0000-4000-8000-000000000003"]')!;
    expect(within(closed as HTMLElement).getByRole('button', { name: 'Reopen' })).toBeTruthy();
    const next = preferences(2); transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Projects' })); });
    expect(await screen.findByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
    expect(screen.getByText(/^Counts are incomplete\./)).toBeTruthy();
    expect(screen.getByText('Unavailable project')).toBeTruthy();
    expect(screen.getByText('/fixtures/unavailable-demo')).toBeTruthy();
  });
  it('registers the exact root under canonical Registry scope', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('project_register', { api_version: 1, ok: true, data: { operation_id: operationId, project_id: projectId, registry_revision: 2 } }); read(transport);
    const close = vi.fn(); render(<RegisterProject store={store} disabled={false} close={close} />);
    fireEvent.change(screen.getByLabelText('Project root'), { target: { value: '/registered/café project' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Register project' })); });
    expect(transport.calls.find(call => call.name === 'project_register')?.request).toEqual({ session: null, command: {
      api_version: 1, command: 'project_register', op_id: operationId, params: { canonical_root: '/registered/café project' },
    } }); expect(close).toHaveBeenCalledOnce();
  });
  it('sends a home-relative root as typed and shows a missing folder in plain words', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('project_register', { api_version: 1, ok: false, error: { code: 'not_found', message: 'Folder not found: /home/owner/missing',
      hint: 'Check the folder path, then register again.', retryable: false, field_errors: [] } });
    const close = vi.fn(); render(<RegisterProject store={store} disabled={false} close={close} />);
    expect(screen.getByLabelText('Project root').getAttribute('placeholder')).toBe('~/path/to/project');
    fireEvent.change(screen.getByLabelText('Project root'), { target: { value: '~/missing' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Register project' })); });
    expect(transport.calls.find(call => call.name === 'project_register')?.request).toMatchObject({ command: { params: { canonical_root: '~/missing' } } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Folder not found: /home/owner/missing Check the folder path, then register again.');
    expect(close).not.toHaveBeenCalled();
  });
  it('explicitly attaches a fresh host to a registered unfinished session and displays only saved setup', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const binding = Object.values((demo as Session).bindings)[0]!;
    transport.enqueue('binding_connect', { api_version: 1, ok: true, data: { operation_id: operationId, session_id: demo.id, revision: 22,
      data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities,
        setup_instruction: 'Read Ariadne structured context, then summarize unresolved questions.' } } }); read(transport);
    const close = vi.fn(); render(<BindSession store={store} project={projectsFixture.items[0] as ProjectSummary} sessions={sessionsFixture.items as SessionSummary[]} adapters={[adapter]} disabled={false} close={close} />);
    fireEvent.change(screen.getByLabelText('External session ID'), { target: { value: 'fresh host conversation' } });
    fireEvent.change(screen.getByLabelText('Socket path'), { target: { value: '/tmp/verified bridge.sock' } });
    fireEvent.click(screen.getByLabelText('Attach to an existing Ariadne session'));
    fireEvent.change(screen.getByLabelText('Registered Ariadne session'), { target: { value: demo.id } });
    expect(screen.queryByText('Read Ariadne structured context, then summarize unresolved questions.')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect existing session' })); });
    expect(transport.calls.find(call => call.name === 'binding_connect')?.request).toEqual({ session: null, command: { api_version: 1,
      command: 'binding_connect', op_id: operationId, params: { project_id: projectId, adapter_id: adapter.adapter_id,
        configuration: adapter.configuration, endpoint: { kind: 'unix_socket', path: '/tmp/verified bridge.sock' }, external_session_id: 'fresh host conversation', existing_session_id: demo.id } } });
    expect(store.getSnapshot().setup?.data).toMatchObject({ kind: 'binding_connect', setup_instruction: 'Read Ariadne structured context, then summarize unresolved questions.' });
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([
    ['codex', /Paste this setup instruction into the selected Codex thread.*connects and uses the Ariadne skill.*Ariadne skill for Codex unless its link was skipped/, /once per binding/, true],
    ['claude_code_mod', /Run \/ariadne-connect in the selected Claude conversation/, /Nothing to paste/, false],
    ['demo.local', /Paste this setup instruction into the selected host conversation.*connects and uses the Ariadne skill/, /once per binding/, true],
  ])('tells the owner how to give the saved setup instruction to a %s host', async (adapterId, wording, frequency, showsInstruction) => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'project', project_id: projectId };
    read(transport, prefs);
    const binding = Object.values((demo as Session).bindings)[0]!;
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} renderSession={() => <p>Session workspace</p>} />);
    await screen.findByRole('navigation', { name: 'Projects and sessions' });
    transport.enqueue('binding_connect', { api_version: 1, ok: true, data: { operation_id: operationId, session_id: demo.id, revision: 22,
      data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities,
        setup_instruction: 'Saved Ariadne rules.' } } }); read(transport, prefs);
    await act(async () => { await store.bind({ project_id: projectId, adapter_id: adapterId, configuration: adapter.configuration,
      external_session_id: 'thread', endpoint: { kind: 'local_bridge', name: 'local' }, existing_session_id: demo.id }); });
    const banner = await screen.findByLabelText('Session setup');
    expect(within(banner).getByText(wording)).toBeTruthy();
    expect(within(banner).getByText(/Connecting sent nothing to the model/)).toBeTruthy();
    expect(within(banner).getByText(frequency)).toBeTruthy();
    if (showsInstruction) expect(within(banner).getByText('Saved Ariadne rules.')).toBeTruthy();
    else expect(within(banner).queryByText('Saved Ariadne rules.')).toBeNull();
  });
  it('shows the connect card under the project header with Copy and only unavailable capabilities', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'project', project_id: projectId };
    read(transport, prefs);
    const binding = Object.values((demo as Session).bindings)[0]!;
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} renderSession={() => <p>Session workspace</p>} />);
    await screen.findByRole('navigation', { name: 'Projects and sessions' });
    transport.enqueue('binding_connect', { api_version: 1, ok: true, data: { operation_id: operationId, session_id: demo.id, revision: 22,
      data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities,
        setup_instruction: 'Run /opt/ariadne read --binding B.' } } }); read(transport, prefs);
    await act(async () => { await store.bind({ project_id: projectId, adapter_id: 'codex', configuration: adapter.configuration,
      external_session_id: 'thread', endpoint: { kind: 'local_bridge', name: 'local' }, existing_session_id: demo.id }); });
    const card = await screen.findByLabelText('Session setup');
    const active = await screen.findByRole('heading', { name: /^Active sessions · \d+$/, level: 3 });
    expect(card.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).queryByRole('list')).toBeNull();
    expect(within(card).getByText('Unavailable capabilities: domain mcp, streaming output.')).toBeTruthy();
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Copy instruction' })); });
    expect(writeText).toHaveBeenCalledWith('Run /opt/ariadne read --binding B.');
    expect(within(card).getByText('Copied')).toBeTruthy();
  });
  it('omits the unavailable line when every capability is supported and keeps the Claude Mod variant free of an instruction', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'project', project_id: projectId };
    read(transport, prefs);
    const binding = Object.values((demo as Session).bindings)[0]!;
    const capabilities = structuredClone(binding.capabilities);
    for (const value of Object.values(capabilities)) if (typeof value === 'object') value.supported = true;
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} renderSession={() => <p>Session workspace</p>} />);
    await screen.findByRole('navigation', { name: 'Projects and sessions' });
    transport.enqueue('binding_connect', { api_version: 1, ok: true, data: { operation_id: operationId, session_id: demo.id, revision: 22,
      data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities,
        setup_instruction: 'Saved Ariadne rules.' } } }); read(transport, prefs);
    await act(async () => { await store.bind({ project_id: projectId, adapter_id: 'claude_code_mod', configuration: adapter.configuration,
      external_session_id: 'thread', endpoint: { kind: 'local_bridge', name: 'local' }, existing_session_id: demo.id }); });
    const card = await screen.findByLabelText('Session setup');
    expect(within(card).queryByText(/Unavailable capabilities/)).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Copy instruction' })).toBeNull();
    expect(card.querySelector('pre')).toBeNull();
  });
  it('passes the hidden item and unhide action to the detail header', async () => {
    const { transport, store } = setup(); read(transport, preferences());
    const hide = vi.fn();
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} hidden onHide={hide}
      detail={<p>Hidden item detail</p>} renderSession={() => null} />);
    const button = await screen.findByRole('button', { name: 'Unhide item' });
    expect(button.title).toBe('Unhide (x)');
    fireEvent.click(button); expect(hide).toHaveBeenCalledOnce();
  });

  it('saves the Waiting column fold and the detail width with the global preferences and applies them at once', async () => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs);
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} detail={<p>Detail</p>} renderSession={() => <p>Session workspace</p>} />);
    await screen.findByRole('navigation', { name: 'Projects and sessions' });
    transport.enqueue('preferences_patch', patchReceipt(2));
    const folded = structuredClone(prefs); folded.revision = 2; folded.global.waiting_collapsed = true; read(transport, folded);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide Waiting on me' })); });
    const patches = () => transport.calls.filter(call => call.name === 'preferences_patch');
    expect(patches()[0].request).toMatchObject({ command: { params: { expected_preferences_revision: 1,
      entries: [{ kind: 'set_global', preferences: { ...prefs.global, waiting_collapsed: true } }] } } });
    expect(screen.getByRole('button', { name: /^Show Waiting on me/ })).toBeTruthy();
    await waitFor(() => expect(store.getSnapshot().preferences?.revision).toBe(2));
    transport.enqueue('preferences_patch', patchReceipt(3));
    const resized = structuredClone(folded); resized.revision = 3; resized.global.detail_width = 416; read(transport, resized);
    const edge = screen.getByRole('separator', { name: 'Resize detail panel' });
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(edge, { key: 'ArrowLeft' });
      await act(async () => { vi.advanceTimersByTime(600); });
    } finally { vi.useRealTimers(); }
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].request).toMatchObject({ command: { params: { expected_preferences_revision: 2,
      entries: [{ kind: 'set_global', preferences: { ...folded.global, detail_width: 416 } }] } } });
    expect(edge.getAttribute('aria-valuenow')).toBe('416');
  });
  it('keeps the setup card on its own project page, collapsed, without a session ID, until dismissed or its session is gone', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'project', project_id: projectId };
    read(transport, prefs);
    const binding = Object.values((demo as Session).bindings)[0]!;
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[adapter]} renderSession={() => <p>Session workspace</p>} />);
    await screen.findByRole('navigation', { name: 'Projects and sessions' });
    const connect = async () => {
      transport.enqueue('binding_connect', { api_version: 1, ok: true, data: { operation_id: operationId, session_id: demo.id, revision: 22,
        data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities,
          setup_instruction: 'Saved Ariadne rules.' } } }); read(transport, prefs);
      await act(async () => { await store.bind({ project_id: projectId, adapter_id: 'codex', configuration: adapter.configuration,
        external_session_id: 'thread', endpoint: { kind: 'local_bridge', name: 'local' }, existing_session_id: demo.id }); });
      return screen.findByLabelText('Session setup');
    };
    let card = await connect();
    // The instruction sits in a collapsed code box; the card names no internal ID.
    expect(card.querySelector('details')?.open).toBe(false);
    expect(within(card).getByText('Show instruction')).toBeTruthy();
    expect(card.textContent).not.toContain(demo.id);
    // Another page never shows it.
    const other = preferences(2); other.global.selected_navigation = { kind: 'projects' }; read(transport, other);
    await act(async () => { await store.refresh(); });
    expect(screen.queryByLabelText('Session setup')).toBeNull();
    const back = preferences(3); back.global.selected_navigation = { kind: 'project', project_id: projectId }; read(transport, back);
    await act(async () => { await store.refresh(); });
    card = await screen.findByLabelText('Session setup');
    // Dismiss closes it.
    fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('Session setup')).toBeNull();
    expect(store.getSnapshot().setup).toBeNull();
    // A removed session takes its card with it at the next complete capture.
    prefs.revision = 3; await connect();
    const gone = sessionResult(); gone.sessions.items = gone.sessions.items.filter(session => session.session_id !== demo.id);
    read(transport, back, projectResult(), gone);
    await act(async () => { await store.refresh(); });
    expect(screen.queryByLabelText('Session setup')).toBeNull();
    expect(store.getSnapshot().setup).toBeNull();
  });
  it('prefills the Codex socket path from the adapter default without overwriting an edited path', () => {
    const { store } = setup();
    const codex: AdapterChoice = { adapter_id: 'codex', label: 'Codex', configuration: { namespace: 'codex', values: {} }, default_socket_path: '/home/u/.codex/app-server-control/app-server-control.sock' };
    render(<BindSession store={store} project={projectsFixture.items[0] as ProjectSummary} sessions={[]} adapters={[adapter, codex]} disabled={false} close={() => {}} />);
    const socket = () => (screen.getByLabelText('Socket path') as HTMLInputElement).value;
    expect(socket()).toBe('');
    fireEvent.change(screen.getByLabelText('Adapter'), { target: { value: 'codex' } });
    expect(socket()).toBe(codex.default_socket_path);
    fireEvent.change(screen.getByLabelText('Socket path'), { target: { value: '/custom.sock' } });
    fireEvent.change(screen.getByLabelText('Adapter'), { target: { value: 'demo.local' } });
    expect(socket()).toBe('/custom.sock');
  });
  it('retains actionable rebind guard errors without showing setup or changing session data', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('binding_connect', { api_version: 1, ok: false, error: { ...error, code: 'invalid_transition', message: 'Old binding has queued inputs.', hint: 'Resolve its queued inputs before rebinding.' } });
    expect(await store.bind({ project_id: projectId, adapter_id: adapter.adapter_id, configuration: adapter.configuration,
      external_session_id: 'fresh', endpoint: { kind: 'local_bridge', name: 'local' }, existing_session_id: demo.id })).toBe(false);
    expect(store.getSnapshot().error?.message).toBe('Old binding has queued inputs.');
    expect(store.getSnapshot().setup).toBeNull(); expect(store.getSnapshot().pendingOperationId).toBeNull();
    expect(store.getSnapshot().sessions?.sessions.items[0].counts.items_by_status).toEqual(counts.items_by_status);
    render(<BindSession store={store} project={projectsFixture.items[0] as ProjectSummary} sessions={sessionsFixture.items as SessionSummary[]} adapters={[adapter]} disabled={false} close={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('Resolve its queued inputs before rebinding.');
  });
  it('words the card like the session bar: sending, paused, not sending with a reason, disconnected', () => {
    const session = structuredClone(sessionsFixture.items[0]) as SessionSummary;
    const binding = session.active_binding!, text = () => sessionCardText(session, null, Date.now());
    binding.connection_state = 'connected'; binding.dispatch_state = 'enabled'; binding.owner_paused = false; binding.pause_reason = null;
    binding.presence = null; session.counts.sent_inputs.needs_attention = 0;
    expect(text()).toMatchObject({ run: 'Sending', runColor: 'var(--st-done)', runDot: 'var(--st-done)' });
    // Paused or blocked is never the green "running" state, and its dot is a ring.
    binding.owner_paused = true; binding.dispatch_state = 'paused';
    expect(text()).toMatchObject({ run: 'Paused (by you)', runDot: 'transparent' }); expect(text().dispatch.action).toBe('resume');
    binding.owner_paused = false; binding.dispatch_state = 'enabled'; session.counts.sent_inputs.needs_attention = 1;
    expect(text()).toMatchObject({ run: 'Not sending: a message needs your decision', runDot: 'transparent' });
    session.counts.sent_inputs.needs_attention = 0; binding.pause_reason = 'result_missing'; binding.dispatch_state = 'recovery_required';
    expect(text().run).toBe('Not sending: the agent hasn’t saved its answer yet');
    binding.pause_reason = null; binding.dispatch_state = 'enabled';
    expect(sessionCardText(session, null, Date.now(), null, { binding_id: binding.id, generation: binding.generation, state: 'backing_off',
      reason: 'codex exited', retry_in_seconds: 4.2, updated_at: new Date().toISOString() }).run).toBe('Not sending: codex exited · retrying in 5s');
    binding.connection_state = 'disconnected'; expect(text().run).toBe('Disconnected');
    binding.connection_state = 'connected'; session.state = 'closed';
    expect(text()).toMatchObject({ run: 'Session closed', closed: true });
    session.state = 'active'; session.active_binding = null; expect(text()).toMatchObject({ agent: 'No agent', run: 'No agent connected' });
  });
  it('offers tab close separately from session lifecycle controls', async () => {
    const { transport, store } = setup(); read(transport);
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[]} renderSession={() => <p>Session workspace</p>} />);
    const tabs = screen.getByRole('navigation', { name: 'Projects and sessions' });
    const close = /^Close .* tab$/;
    await waitFor(() => expect(within(tabs).getByRole('button', { name: close })).toBeTruthy());
    const next = preferences(2); next.sessions[0].tab_open = false;
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    await act(async () => { fireEvent.click(within(tabs).getByRole('button', { name: close })); });
    expect(within(tabs).queryByRole('button', { name: close })).toBeNull();
    expect(transport.calls.some(call => call.name === 'session_close')).toBe(false);
  });
  it('renders the opened-session seam with retained selection/filter/scroll preferences', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'session', session: route };
    read(transport, prefs); transport.enqueue('session_get', loaded());
    const received: Parameters<typeof NavigationWorkspace>[0]['renderSession'] = view => <div>
      <p>Selected item {view.preferences?.selected_item_id}</p><p>{view.preferences?.filters.search}</p>
      <p>Scroll {view.preferences?.scroll?.offset}</p><p>{view.store.getSnapshot().snapshot?.session.title}</p>
    </div>;
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[]} renderSession={received} />);
    expect(await screen.findByText('Selected item 1.1')).toBeTruthy();
    expect(screen.getByText('Scroll 124')).toBeTruthy();
    expect(await screen.findByText('Canonical domain v1 demo', { selector: 'p' })).toBeTruthy();
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe('keep exact café\nsearch');
  });
  it('reuses the source dialog focus trap, Escape and focus return', async () => {
    const { transport, store } = setup(); read(transport);
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[]} renderSession={() => null} />);
    await screen.findByRole('heading', { name: 'Projects', level: 1 });
    const opener = screen.getByRole('button', { name: 'Register project' }); opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Register project' });
    // The Paperwhite dialog holds focus on its card first (ui/dialogs/Dialog).
    expect(document.activeElement).toBe(dialog);
    const input = within(dialog).getByLabelText('Project root'); input.focus(); fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Register project' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(transport.calls.some(call => call.name === 'project_register')).toBe(false);
  });
});


describe('tree edits through canonical navigation preferences', () => {
  it('keeps a confirmed search receipt when an overlapping refresh finishes its catalogues and uses that revision for the next filter', async () => {
    const { transport, store } = setup(), prefs = preferences();
    prefs.sessions[0].filters = { search: 'native', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false };
    read(transport, prefs); await store.start();
    // The header search and the tree's status chips both write through saveSessionView with the current revision.
    const view = () => structuredClone(store.getSnapshot().preferences!.sessions[0]) as SessionPreferences;
    const receipt = deferred<MutationEnvelope>(), projects = deferred<QueryEnvelope>();
    transport.enqueue('preferences_patch', receipt.promise);
    const cleared = view(); cleared.filters.search = '';
    let search!: Promise<boolean>;
    await act(async () => { search = store.saveSessionView(cleared, store.getSnapshot().preferences!.revision); });
    expect(store.getSnapshot().writing).toBe(true);
    transport.enqueue('preferences_get', success('preferences_get', prefs));
    transport.enqueue('project_list', projects.promise);
    transport.enqueue('session_list', success('session_list', sessionResult()));
    let refresh!: Promise<void>;
    await act(async () => { refresh = store.refresh(); });
    expect(transport.calls.filter(call => call.name === 'project_list')).toHaveLength(2);
    await act(async () => { receipt.resolve(patchReceipt(2)); });
    expect(store.getSnapshot().preferences?.revision).toBe(2);
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe('');
    await act(async () => { projects.resolve(success('project_list', projectResult())); await refresh; });
    expect(store.getSnapshot().preferences?.revision).toBe(2);
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe('');
    expect(store.getSnapshot().status).toBe('ready'); expect(store.getSnapshot().error).toBeNull();
    expect(await search).toBe(true);
    transport.enqueue('preferences_patch', patchReceipt(3));
    const open = view(); open.filters.statuses = ['open'];
    await act(async () => { await store.saveSessionView(open, store.getSnapshot().preferences!.revision); });
    expect(store.getSnapshot().preferences?.revision).toBe(3);
    expect(store.getSnapshot().preferences?.sessions[0]).toEqual({ ...prefs.sessions[0],
      filters: { ...prefs.sessions[0].filters, search: '', statuses: ['open'] } });
    expect(store.getSnapshot().preferences?.global).toEqual(prefs.global);
    expect(store.getSnapshot().preferences?.drafts).toEqual(prefs.drafts);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(2);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')[1].request).toMatchObject({ command: {
      params: { expected_preferences_revision: 2, entries: [{ kind: 'set_session_view',
        preferences: { filters: { search: '', statuses: ['open'] } } }] },
    } });
  });
  // The temporary-reveal sequence (outside-filter reveal, Resume, reselect) is covered by tests/ui/tree/component.test.tsx
  // now that the workspace, not the tree, owns the reveal.
  it('completes saved view edits while a catalogue refresh is blocked and rejects its older snapshot', async () => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const blocked = deferred<QueryEnvelope>(); transport.enqueue('preferences_get', blocked.promise);
    const refresh = store.refresh();
    await waitFor(() => expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(2));
    const edit = structuredClone(prefs.sessions[0]); edit.filters.search = 'first saved search';
    transport.enqueue('preferences_patch', patchReceipt(2), patchReceipt(3));
    let completed: boolean | undefined;
    const save = store.saveSessionView(edit, 1).then(value => { completed = value; });
    try {
      await waitFor(() => expect(completed).toBe(true), { timeout: 200 });
      const second = structuredClone(edit); second.filters.search = 'second saved search';
      expect(await store.saveSessionView(second, 2)).toBe(true);
      expect(store.getSnapshot().preferences?.revision).toBe(3);
      expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(2);
    } finally { blocked.resolve(success('preferences_get', prefs)); await refresh; await save; }
    expect(store.getSnapshot().preferences?.revision).toBe(3);
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe('second saved search');
  });
  it('retains periodic reconciliation and its errors after a confirmed view edit', async () => {
    vi.useFakeTimers();
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const edit = structuredClone(prefs.sessions[0]); edit.filters.search = 'saved before background failure';
    transport.enqueue('preferences_patch', patchReceipt());
    expect(await store.saveSessionView(edit, 1)).toBe(true);
    expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(1);
    transport.enqueue('preferences_get', new Error('Background read unavailable'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSnapshot().status).toBe('stale'); expect(store.getSnapshot().error).not.toBeNull();
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe(edit.filters.search);
    const next = structuredClone(prefs); next.revision = 2; next.sessions[0] = edit; read(transport, next);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSnapshot().status).toBe('ready'); expect(store.getSnapshot().error).toBeNull();
  });
  it('saves only the current session view while preserving tab state, other sessions, global state and drafts', async () => {
    const { transport, store } = setup(); const prefs = preferences();
    prefs.sessions.push({ ...structuredClone(prefs.sessions[0]), session: { ...route, session_id: projectId }, tab_order: 3 });
    read(transport, prefs); await store.start();
    const edit = structuredClone(prefs.sessions[0]); edit.tab_open = false; edit.tab_order = 99; edit.filters.search = 'new exact\nsearch';
    transport.enqueue('preferences_patch', patchReceipt()); transport.enqueue('preferences_get', new Error('Follow-up read unavailable'));
    expect(await store.saveSessionView(edit, 1)).toBe(true);
    const saved = store.getSnapshot().preferences!;
    expect(saved.sessions[0]).toEqual({ ...edit, tab_open: prefs.sessions[0].tab_open, tab_order: prefs.sessions[0].tab_order });
    expect(saved.sessions[1]).toEqual(prefs.sessions[1]); expect(saved.global).toEqual(prefs.global); expect(saved.drafts).toEqual(prefs.drafts);
    expect(transport.calls.find(call => call.name === 'preferences_patch')!.request).toMatchObject({ command: { params: { expected_preferences_revision: 1 } } });
  });
  it('rejects a captured local revision mismatch and refreshes without submitting stale changes', async () => {
    const { transport, store } = setup(); const prefs = preferences(2); read(transport, prefs); await store.start();
    const newer = preferences(3); newer.sessions[0].selected_item_id = '2'; read(transport, newer);
    expect(await store.saveSessionView(preferences().sessions[0], 1)).toBe(false);
    expect(transport.calls.some(call => call.name === 'preferences_patch')).toBe(false);
    expect(store.getSnapshot().preferences).toEqual(newer);
  });
  it('refreshes a definitive backend revision conflict without automatically overwriting newer state', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const conflict: MutationEnvelope = { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict' } };
    transport.enqueue('preferences_patch', conflict, conflict);
    // Foreign writes: revision 3 before the first attempt lands, 4 before the retry lands.
    const newer = preferences(3); newer.sessions[0].filters.search = 'newer owner choice'; read(transport, newer);
    const newest = preferences(4); newest.sessions[0].filters.search = 'newest owner choice'; read(transport, newest);
    expect(await store.setLater({ ...route, item_id: '1' }, true, 1)).toBe(false);
    expect(store.getSnapshot().preferences).toEqual(newest);
    // One re-apply, then the failure surfaces; there is no third attempt.
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(2);
    expect(store.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
    expect(store.getSnapshot().pendingOperationId).toBeNull();
  });
  it('re-applies a conflicted navigation write once against the refreshed revision with a new operation id', async () => {
    const ids: ReturnType<typeof crypto.randomUUID>[] = ['00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000402']; let next = 0;
    const transport = new Transport(); const store = new NavigationStore(createDesktopService(transport), () => ids[next++]); stores.push(store);
    const prefs = preferences(); prefs.global.selected_navigation = { kind: 'projects' }; read(transport, prefs); await store.start();
    // A native writer saved window geometry between this view's render and the click.
    const native = structuredClone(prefs); native.revision = 2; native.global.window = { x: 1, y: 2, width: 900, height: 600, monitor_id: 'main' };
    const saved = structuredClone(native); saved.revision = 3; saved.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 2 } },
      { api_version: 1, ok: true, data: { operation_id: ids[1], preferences_revision: 3 } });
    read(transport, native); read(transport, saved);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(true);
    const calls = transport.calls.filter(call => call.name === 'preferences_patch');
    expect(calls).toHaveLength(2);
    expect(calls[0].request).toMatchObject({ command: { op_id: ids[0], params: { expected_preferences_revision: 1 } } });
    // Only the owner's field is replayed; the foreign window change is carried, not overwritten.
    expect(calls[1].request).toMatchObject({ command: { op_id: ids[1], params: { expected_preferences_revision: 2,
      entries: [{ kind: 'set_global', preferences: { ...native.global, selected_navigation: { kind: 'all_sessions' } } }] } } });
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    expect(store.getSnapshot().preferences?.global.window).toEqual(native.global.window);
    expect(store.getSnapshot().preferences?.drafts).toEqual(prefs.drafts);
  });
  it('does not re-apply a conflicted navigation write after the owner chose a different target meanwhile', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'projects' };
    read(transport, prefs); await store.start();
    const held = deferred<MutationEnvelope>(); transport.enqueue('preferences_patch', held.promise);
    const native = structuredClone(prefs); native.revision = 2; read(transport, native); read(transport, native);
    const clickA = store.navigate({ kind: 'all_sessions' });
    await waitFor(() => expect(store.getSnapshot().writing).toBe(true));
    // Click B arrives while A's write is pending and is dropped, but it supersedes A as the owner's intent.
    expect(await store.navigate({ kind: 'project', project_id: projectId })).toBe(false);
    held.resolve({ api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 2 } });
    expect(await clickA).toBe(false);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
    expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'projects' });
  });
  it('retries a conflicted session-view edit without overwriting a foreign change to another field', async () => {
    const { transport, store } = setup(); const prefs = preferences(); read(transport, prefs); await store.start();
    const native = structuredClone(prefs); native.revision = 2; native.sessions[0].selected_item_id = '2'; native.sessions[0].filters.search = 'foreign search';
    const edit = structuredClone(prefs.sessions[0]); edit.scroll = { item_id: '1', offset: 12 };
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict', current_revision: 2 } }, patchReceipt(3));
    read(transport, native);
    expect(await store.saveSessionView(edit, 1)).toBe(true);
    const retried = transport.calls.filter(call => call.name === 'preferences_patch')[1].request as OwnerMutationRequest;
    expect(retried).toMatchObject({ command: { params: { expected_preferences_revision: 2, entries: [{ kind: 'set_session_view',
      preferences: { ...native.sessions[0], scroll: edit.scroll } }] } } });
    const view = store.getSnapshot().preferences!.sessions[0];
    expect(view).toMatchObject({ selected_item_id: '2', scroll: edit.scroll }); expect(view.filters.search).toBe('foreign search');
  });
  it.each(['commit_uncertain', 'invalid_transition'] as const)('never re-applies a navigation write rejected as %s', async code => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code } });
    const edit = preferences().sessions[0]; edit.scroll = { item_id: '1', offset: 12 };
    expect(await store.saveSessionView(edit, 1)).toBe(false);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().error).toMatchObject({ error: { code } });
  });
  it('never re-applies a conflicted draft or other non-navigation write', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('project_register', { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict' } });
    read(transport, preferences(2));
    expect(await store.register('/registered/root')).toBe(false);
    expect(transport.calls.filter(call => call.name === 'project_register')).toHaveLength(1);
  });
  it('refreshes preferences when a native writer announces a newer revision and ignores an already-known one', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    const reads = () => transport.calls.filter(call => call.name === 'preferences_get').length;
    const before = reads();
    transport.emit('ariadne://preferences_changed', { revision: 1 });
    await Promise.resolve(); expect(reads()).toBe(before);
    const native = preferences(2); native.global.window = { x: 1, y: 2, width: 900, height: 600, monitor_id: 'main' }; read(transport, native);
    transport.emit('ariadne://preferences_changed', { revision: 2 });
    await waitFor(() => expect(store.getSnapshot().preferences?.revision).toBe(2));
    expect(reads()).toBe(before + 1);
    expect(store.getSnapshot().preferences?.global.window).toEqual(native.global.window);
  });
  it('keeps rejected navigation actionable across native preference refreshes until a new explicit attempt succeeds', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'projects' };
    read(transport, prefs); await store.start();
    const conflict: CoreError = { ...error, code: 'revision_conflict', message: 'Preferences revision changed.', current_revision: 3 };
    // The one re-apply conflicts as well; only then does the rejection surface and stay actionable.
    // A foreign write bumps the revision to 2 before the first attempt lands, and again to 3 before the retry lands.
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...conflict, current_revision: 2 } }, { api_version: 1, ok: false, error: conflict });
    const first = structuredClone(prefs); first.revision = 2;
    const native = structuredClone(prefs); native.revision = 3;
    native.global.notification_watermark = demo.updated_at;
    native.global.window = { x: 100, y: 100, width: 1000, height: 700, monitor_id: 'main' };
    read(transport, first); read(transport, native);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(false);
    expect(store.getSnapshot().error).toMatchObject({ error: conflict });
    expect(store.getSnapshot().preferences).toEqual(native); expect(store.getSnapshot().pendingOperationId).toBeNull();
    read(transport, native); await store.refresh();
    expect(store.getSnapshot().error).toMatchObject({ error: conflict });
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(2);
    const saved = structuredClone(native); saved.revision = 4; saved.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', patchReceipt(4)); read(transport, saved);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(true);
    expect(store.getSnapshot().error).toBeNull(); expect(store.getSnapshot().preferences).toEqual(saved);
    const calls = transport.calls.filter(call => call.name === 'preferences_patch'); expect(calls).toHaveLength(3);
    expect(calls[2].request).toMatchObject({ command: { params: { expected_preferences_revision: 3,
      entries: [{ kind: 'set_global', preferences: { ...native.global, selected_navigation: { kind: 'all_sessions' } } }] } } });
    expect(store.getSnapshot().preferences?.drafts).toEqual(prefs.drafts);
  });
  it('retains uncertain tree operations with the original revision and exact body until explicit retry', async () => {
    const { transport, store } = setup(); read(transport); await store.start();
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'commit_uncertain' } }, patchReceipt());
    const edit = preferences().sessions[0]; edit.filters.search = 'immutable choice';
    expect(await store.saveSessionView(edit, 1)).toBe(false); edit.filters.search = 'later mutation';
    expect(await store.setLater({ ...route, item_id: '2' }, true, 1)).toBe(false);
    const next = preferences(2); next.sessions[0].filters.search = 'immutable choice'; read(transport, next);
    expect(await store.retryMutation()).toBe(true);
    const calls = transport.calls.filter(call => call.name === 'preferences_patch');
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe('immutable choice');
  });
  it('sends Later through the same canonical mutation path and preserves unrelated preferences', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.sessions[0].filters.search = '';
    read(transport, prefs); await store.start();
    const next = structuredClone(prefs); next.revision = 2; next.later = [{ ...route, item_id: '1' }];
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    await act(async () => { await store.setLater({ ...route, item_id: '1' }, true, 1); });
    await waitFor(() => expect(store.getSnapshot().preferences?.later).toEqual(next.later));
    expect(transport.calls.find(call => call.name === 'preferences_patch')!.request).toEqual({ session: null, command: {
      api_version: 1, command: 'preferences_patch', op_id: operationId, params: { expected_preferences_revision: 1,
        entries: [{ kind: 'set_later', item: { ...route, item_id: '1' }, later: true }] } } });
    expect(store.getSnapshot().preferences?.global).toEqual(prefs.global);
    expect(store.getSnapshot().preferences?.drafts).toEqual(prefs.drafts);
  });
});


it('initializes active branch expansion only when a registered session view is first created', async () => {
  const { transport, store } = setup(); const prefs = preferences(); prefs.sessions = [];
  read(transport, prefs); await store.start(); transport.enqueue('session_get', loaded());
  transport.enqueue('preferences_patch', patchReceipt()); transport.enqueue('preferences_get', new Error('Read unavailable'));
  expect(await store.navigate({ kind: 'session', session: route })).toBe(true);
  const view = store.getSnapshot().preferences!.sessions[0]; expect(view.expanded_item_ids).toContain('1');
  expect(view.filters.owners).toEqual([]);
});
