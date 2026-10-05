import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import demo from '../../../../../fixtures/domain/demo/session.json';
import inventory from '../../../../../fixtures/contracts/core/inventory.json';
import type { CoreError, MutationEnvelope, OwnerMutationRequest, PreferencesSnapshot, ProjectListResult,
  QueryEnvelope, SessionListResult, SessionPreferences, SessionRef } from '../../../src/generated/core';
import type { Page, ProjectSummary, QueryCursor, Session, SessionSummary, SummaryCounts } from '../../../src/generated/domain/models';
import { createDesktopService, type DesktopTransport, type HintPayloads } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import * as catalogue from '../../../src/state/navigation/catalogue';
import { bindingLabel, NavigationWorkspace, type AdapterChoice } from '../../../src/components/navigation/NavigationWorkspace';
import { BindSession, RegisterProject } from '../../../src/components/navigation/Registration';
import { NavigationSentenceTree } from '../../../src/components/tree/NavigationSentenceTree';

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
  return { sessions: structuredClone(sessionsFixture) as Page<SessionSummary>, counts: structuredClone(counts), active_total: 9, closed_total: 3 };
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
  readonly responses = new Map<string, (QueryEnvelope | MutationEnvelope | Promise<QueryEnvelope> | Error)[]>();
  readonly listeners = new Map<keyof HintPayloads, Set<(hint: never) => void>>();
  readonly unsubscribed: string[] = [];
  enqueue(name: string, ...responses: (QueryEnvelope | MutationEnvelope | Promise<QueryEnvelope> | Error)[]) {
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
const cursor = (view: 'projects' | 'sessions', revision = 21): QueryCursor => ({ schema: 1, view,
  revision, filter_digest: 'a'.repeat(64), after: view === 'projects' ? { kind: 'project', canonical_root: '/fixtures/ariadne-demo', id: projectId }
    : { kind: 'session', project_id: projectId, id: demo.id, updated_at: demo.updated_at } });
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); });

describe('complete registered navigation reads', () => {
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
    expect(transport.unsubscribed.sort()).toEqual(['ariadne://route', 'ariadne://session_changed']);
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
  it('closing a tab preserves all view settings and drafts and sends only preference entries', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'session', session: route };
    read(transport, prefs); await store.start();
    const next = structuredClone(prefs); next.revision = 2; next.sessions[0].tab_open = false; next.global.selected_navigation = { kind: 'projects' };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    expect(await store.closeTab(route)).toBe(true);
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
    const older = store.navigate({ kind: 'session', session: route });
    const next = preferences(2); next.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(true);
    slow.resolve(loaded()); expect(await older).toBe(false);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().preferences?.global.selected_navigation.kind).toBe('all_sessions');
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
    expect(store.getSnapshot().reveal).toMatchObject({ kind: 'missing_item', requestedItemId: '999', banner: 'The item was deleted.' });
  });
});

const adapter: AdapterChoice = { adapter_id: 'demo.local', label: 'Installed adapter', configuration: { namespace: 'demo.local', values: {} } };
const waiting = { count: '1', loading: true, emptyText: 'Waiting panel is supplied by its owner.', waiting: [], sent: [] };
describe('source-backed navigation views and explicit registration', () => {
  it.each(['projects', 'project', 'all_sessions'] as const)('blocks %s navigation during explicit Refresh until fresh preferences are published', async kind => {
    const { transport, store } = setup(); const prefs = preferences();
    prefs.global.selected_navigation = kind === 'project' ? { kind, project_id: projectId } : { kind };
    read(transport, prefs);
    render(<NavigationWorkspace store={store} waiting={waiting} adapterChoices={[adapter]} renderSession={() => null} />);
    const allSessions = screen.getByRole('button', { name: 'All sessions' });
    await waitFor(() => expect((allSessions as HTMLButtonElement).disabled).toBe(false));
    const conflict: CoreError = { ...error, code: 'revision_conflict', message: 'Preferences revision changed.', current_revision: 3 };
    const native = structuredClone(prefs); native.revision = 3;
    native.global.window = { x: 100, y: 100, width: 1000, height: 700, monitor_id: 'main' };
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: conflict }); read(transport, native);
    await act(async () => { fireEvent.click(allSessions); });
    expect(store.getSnapshot().preferences).toEqual(native);
    expect(screen.getByRole('alert').textContent).toContain(conflict.message);
    expect((allSessions as HTMLButtonElement).disabled).toBe(false);

    const fresh = structuredClone(native); fresh.revision = 4; fresh.global.notification_watermark = demo.updated_at;
    const preferenceRead = deferred<QueryEnvelope>(); const projectRead = deferred<QueryEnvelope>();
    transport.enqueue('preferences_get', preferenceRead.promise);
    transport.enqueue('project_list', projectRead.promise);
    transport.enqueue('session_list', success('session_list', sessionResult()));
    const readCount = transport.calls.filter(call => call.name === 'preferences_get').length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement).disabled).toBe(true);
    const tabs = screen.getByRole('navigation', { name: 'Projects and sessions' });
    within(tabs).getAllByRole('button').forEach(button => {
      expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button);
    });
    expect((screen.getByRole('button', { name: 'Register project' }) as HTMLButtonElement).disabled).toBe(true);
    if (kind === 'projects') {
      screen.getAllByRole('button', { name: /Registered root/ }).forEach(card => {
        expect(card.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(card); fireEvent.keyDown(card, { key: 'Enter' });
      });
    } else {
      expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      if (kind === 'project') expect((screen.getByRole('button', { name: 'Connect existing session' }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Refreshing…' }));
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(transport.calls.some(call => call.name === 'session_get')).toBe(false);
    await waitFor(() => expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(readCount + 1));
    await act(async () => { preferenceRead.resolve(success('preferences_get', fresh)); });
    expect(store.getSnapshot().preferences).toEqual(native);
    expect((allSessions as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeTruthy();
    await act(async () => { projectRead.resolve(success('project_list', projectResult())); });
    expect(store.getSnapshot().preferences).toEqual(fresh);
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
    expect((allSessions as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain(conflict.message);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(transport.calls.filter(call => call.name === 'preferences_get')).toHaveLength(readCount + 1);

    const saved = structuredClone(fresh); saved.revision = 5; saved.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', patchReceipt(5)); read(transport, saved);
    await act(async () => { fireEvent.click(allSessions); });
    const mutations = transport.calls.filter(call => call.name === 'preferences_patch'); expect(mutations).toHaveLength(2);
    expect(mutations[1].request).toMatchObject({ command: { params: { expected_preferences_revision: 4,
      entries: [{ kind: 'set_global', preferences: saved.global }] } } });
    expect(store.getSnapshot().preferences).toEqual(saved);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'All sessions', level: 1 })).toBeTruthy();
  });
  it('clears explicit Refresh progress after a failed read and keeps failure visible without changing navigation', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'projects' };
    read(transport, prefs);
    render(<NavigationWorkspace store={store} waiting={waiting} adapterChoices={[]} renderSession={() => null} />);
    const allSessions = screen.getByRole('button', { name: 'All sessions' });
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
    expect(screen.getByRole('alert').textContent).toContain(failure.message);
    expect(screen.getByRole('alert').textContent).toContain(failure.hint);
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
    render(<NavigationWorkspace store={store} waiting={waiting} adapterChoices={[adapter]} renderSession={() => <p>Session workspace</p>} />);
    expect(await screen.findByRole('heading', { name: 'All sessions', level: 1 })).toBeTruthy();
    expect(screen.getByText('9 active · 3 closed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Unavailable project' })).toBeTruthy();
    expect(screen.getByText('/fixtures/unavailable-demo')).toBeTruthy();
    expect(screen.getByText('Closed work')).toBeTruthy();
    const next = preferences(2); transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Projects' })); });
    expect(await screen.findByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
    expect(screen.getByText('0 waiting · incomplete')).toBeTruthy();
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
  it('qualifies running labels by fresh current-generation observation and preserves closed/unbound/paused states', () => {
    const session = structuredClone(sessionsFixture.items[0]) as SessionSummary;
    expect(bindingLabel(session)).toBe('Bound · running');
    session.active_binding!.presence!.freshness = 'stale'; expect(bindingLabel(session)).toBe('Bound · execution unknown');
    session.active_binding!.presence!.freshness = 'fresh'; session.active_binding!.presence!.generation = 'another'; expect(bindingLabel(session)).toBe('Bound · execution unknown');
    session.active_binding!.owner_paused = true; expect(bindingLabel(session)).toBe('Bound · owner paused');
    session.state = 'closed'; expect(bindingLabel(session)).toBe('Closed');
    session.state = 'active'; session.active_binding = null; expect(bindingLabel(session)).toBe('Unbound');
  });
  it('offers tab close separately from session lifecycle controls', async () => {
    const { transport, store } = setup(); read(transport);
    render(<NavigationWorkspace store={store} waiting={waiting} adapterChoices={[]} renderSession={() => <p>Session workspace</p>} />);
    const tabs = screen.getByRole('navigation', { name: 'Projects and sessions' });
    await waitFor(() => expect(within(tabs).getByRole('button', { name: `Close ${demo.title} tab` })).toBeTruthy());
    const next = preferences(2); next.sessions[0].tab_open = false;
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    await act(async () => { fireEvent.click(within(tabs).getByRole('button', { name: `Close ${demo.title} tab` })); });
    expect(within(tabs).queryByRole('button', { name: `Close ${demo.title} tab` })).toBeNull();
    expect(transport.calls.some(call => call.name === 'session_close')).toBe(false);
  });
  it('renders the opened-session seam with retained selection/filter/scroll preferences', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'session', session: route };
    read(transport, prefs); transport.enqueue('session_get', loaded());
    const received: Parameters<typeof NavigationWorkspace>[0]['renderSession'] = view => <div>
      <p>Selected item {view.preferences?.selected_item_id}</p><p>{view.preferences?.filters.search}</p>
      <p>Scroll {view.preferences?.scroll?.offset}</p><p>{view.store.getSnapshot().snapshot?.session.title}</p>
    </div>;
    render(<NavigationWorkspace store={store} waiting={waiting} adapterChoices={[]} renderSession={received} />);
    expect(await screen.findByText('Selected item 1.1')).toBeTruthy();
    expect(screen.getByText('Scroll 124')).toBeTruthy();
    expect(await screen.findByText('Canonical domain v1 demo', { selector: 'p' })).toBeTruthy();
    expect(store.getSnapshot().preferences?.sessions[0].filters.search).toBe('keep exact café\nsearch');
  });
  it('reuses the source dialog focus trap, Escape and focus return', async () => {
    const { transport, store } = setup(); read(transport);
    render(<NavigationWorkspace store={store} waiting={waiting} adapterChoices={[]} renderSession={() => null} />);
    await screen.findByRole('heading', { name: 'Projects', level: 1 });
    const opener = screen.getByRole('button', { name: 'Register project' }); opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Register project' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const input = within(dialog).getByLabelText('Project root'); input.focus(); fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Register project' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(transport.calls.some(call => call.name === 'project_register')).toBe(false);
  });
});


describe('tree edits through canonical navigation preferences', () => {
  it('keeps the newest tree selection reveal through Later and new search after dismissing an older external reveal', async () => {
    const { transport, store } = setup(), prefs = preferences(), session = structuredClone(demo) as Session;
    prefs.global.selected_navigation = { kind: 'session', session: route };
    prefs.sessions[0].filters.search = 'needle'; prefs.sessions[0].expanded_item_ids = [];
    const root = session.items['1']!, child = session.items['1.1']!;
    session.items = {
      '1': { ...root, question: 'Parent context' },
      '1.1': { ...child, question: 'Matching needle child' },
      '1.2': { ...child, id: '1.2', ordinal: 2, question: 'Sibling outside search' },
    };
    session.messages = [];
    const snapshot = () => success('session_get', { session, freshness: 'fresh' });
    read(transport, prefs); await store.start();
    transport.enqueue('session_get', snapshot());
    const opened = store.opened.open(route); await opened.refresh();
    const revealRoute = async (id: string, revision: number) => {
      transport.enqueue('reveal_item', success('reveal_item', { ...route, item_id: id }));
      transport.enqueue('session_get', snapshot(), snapshot());
      transport.enqueue('preferences_patch', patchReceipt(revision));
      await act(async () => { transport.emit('ariadne://route', { ...route, item_id: id }); });
      await waitFor(() => expect(store.getSnapshot().preferences?.revision).toBe(revision));
    };
    const ids = () => screen.queryAllByRole('treeitem').map(row => row.getAttribute('data-item-id'));
    const user = userEvent.setup();
    render(<NavigationSentenceTree navigation={store} store={opened} onReveal={() => {}} />);
    await revealRoute('1.2', 2);
    expect(screen.getByText('Item 1.2 is outside the current filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss temporary reveal' }));
    expect(ids()).toEqual(['1', '1.1']);
    transport.enqueue('reveal_item', success('reveal_item', { ...route, item_id: '1.1' }));
    transport.enqueue('session_get', snapshot()); transport.enqueue('preferences_patch', patchReceipt(3));
    await user.click(screen.getAllByRole('treeitem')[1]);
    await waitFor(() => expect(store.getSnapshot().preferences?.sessions[0].selected_item_id).toBe('1.1'));
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('1.1');
    transport.enqueue('preferences_patch', patchReceipt(4)); await user.keyboard('z');
    await waitFor(() => expect(store.getSnapshot().preferences?.later).toEqual([{ ...route, item_id: '1.1' }]));
    transport.enqueue('preferences_patch', patchReceipt(5)); vi.useFakeTimers();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'No canonical native tree question matches this phrase' } });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(screen.getByText('Item 1.1 is outside the current filters.')).toBeTruthy();
    expect(ids()).toEqual(['1', '1.1']);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss temporary reveal' }));
    expect(ids()).toEqual([]); expect(screen.getByText('No sentences match these filters.')).toBeTruthy();
    expect(store.getSnapshot().preferences?.sessions[0]).toEqual({ ...prefs.sessions[0], selected_item_id: '1.1',
      filters: { ...prefs.sessions[0].filters, search: 'No canonical native tree question matches this phrase' } });
    expect(store.getSnapshot().preferences?.later).toEqual([{ ...route, item_id: '1.1' }]);
    vi.useRealTimers(); await revealRoute('1.2', 6);
    expect(screen.getByText('Item 1.2 is outside the current filters.')).toBeTruthy();
    expect(ids()).toEqual(['1', '1.2']);
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('1.2');
  });
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
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'revision_conflict' } });
    const newer = preferences(3); newer.sessions[0].filters.search = 'newer owner choice'; read(transport, newer);
    expect(await store.setLater({ ...route, item_id: '1' }, true, 1)).toBe(false);
    expect(store.getSnapshot().preferences).toEqual(newer);
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    expect(store.getSnapshot().pendingOperationId).toBeNull();
  });
  it('keeps rejected navigation actionable across native preference refreshes until a new explicit attempt succeeds', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.global.selected_navigation = { kind: 'projects' };
    read(transport, prefs); await store.start();
    const conflict: CoreError = { ...error, code: 'revision_conflict', message: 'Preferences revision changed.', current_revision: 3 };
    transport.enqueue('preferences_patch', { api_version: 1, ok: false, error: conflict });
    const native = structuredClone(prefs); native.revision = 3;
    native.global.notification_watermark = demo.updated_at;
    native.global.window = { x: 100, y: 100, width: 1000, height: 700, monitor_id: 'main' };
    read(transport, native);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(false);
    expect(store.getSnapshot().error).toMatchObject({ error: conflict });
    expect(store.getSnapshot().preferences).toEqual(native); expect(store.getSnapshot().pendingOperationId).toBeNull();
    read(transport, native); await store.refresh();
    expect(store.getSnapshot().error).toMatchObject({ error: conflict });
    expect(transport.calls.filter(call => call.name === 'preferences_patch')).toHaveLength(1);
    const saved = structuredClone(native); saved.revision = 4; saved.global.selected_navigation = { kind: 'all_sessions' };
    transport.enqueue('preferences_patch', patchReceipt(4)); read(transport, saved);
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(true);
    expect(store.getSnapshot().error).toBeNull(); expect(store.getSnapshot().preferences).toEqual(saved);
    const calls = transport.calls.filter(call => call.name === 'preferences_patch'); expect(calls).toHaveLength(2);
    expect(calls[1].request).toMatchObject({ command: { params: { expected_preferences_revision: 3,
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
  it('composes real tree Later callbacks into the same canonical mutation path and preserves unrelated preferences', async () => {
    const { transport, store } = setup(); const prefs = preferences(); prefs.sessions[0].filters.search = '';
    read(transport, prefs); await store.start(); transport.enqueue('session_get', loaded());
    const opened = store.opened.open(route); await opened.refresh();
    render(<NavigationSentenceTree navigation={store} store={opened} onReveal={() => {}} />);
    const next = structuredClone(prefs); next.revision = 2; next.later = [{ ...route, item_id: '1' }];
    transport.enqueue('preferences_patch', patchReceipt()); read(transport, next);
    await act(async () => { fireEvent.keyDown(screen.getAllByRole('treeitem')[0], { key: 'z' }); });
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
