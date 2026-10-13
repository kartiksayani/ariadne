import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerMutationRequest, PreferencesPatchEntry, ProjectListResult, SessionPreferences } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { sessionSeen, type SeenPatch } from '../../../src/state/preferences/seen';
import { AppTransport, route, secondId } from '../app/transport';

class SeenTransport extends AppTransport {
  beforePatch: (() => void) | null = null;
  holdPatch: Promise<void> | null = null;
  holdSeen: Promise<void> | null = null;
  failSeen: (() => Promise<void>) | null = null;
  holdSession: Promise<void> | null = null;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    if (name === 'session_get' && this.holdSession) await this.holdSession;
    const request = args.request;
    if ('command' in request && request.command.command === 'preferences_patch') {
      if (request.command.params.entries.every(entry => entry.kind === 'mark_seen')) {
        if (this.holdSeen) await this.holdSeen;
        if (this.failSeen) {
          this.mutations.push(structuredClone(request));
          await this.failSeen();
        }
      }
      if (this.holdPatch) await this.holdPatch;
      const conflict = this.beforePatch;
      this.beforePatch = null;
      conflict?.();
      if (request.command.params.expected_preferences_revision !== this.preferences.revision) {
        this.mutations.push(structuredClone(request));
        return { api_version: 1, ok: false, error: { code: 'revision_conflict', message: 'Preferences changed.',
          hint: 'Reload before retrying.', retryable: false, field_errors: [], current_revision: this.preferences.revision } } as T;
      }
    }
    return super.invoke<T>(name, args);
  }
}

const stores: NavigationStore[] = [];
const initialTime = '2026-10-13T10:00:00.000Z';
const entries = (request: OwnerMutationRequest): PreferencesPatchEntry[] => {
  if (request.command.command !== 'preferences_patch') throw new Error('Expected preferences patch');
  return request.command.params.entries;
};
const seenEntries = (request: OwnerMutationRequest) => entries(request).filter((entry): entry is SeenPatch => entry.kind === 'mark_seen');
async function setup(selected = true, transport = new SeenTransport()) {
  if (selected) transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  const store = new NavigationStore(createDesktopService(transport));
  stores.push(store);
  await store.start();
  await store.opened.open(route).refresh();
  return { store, transport };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(initialTime); });
afterEach(() => { stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); });

describe('owner seen preference batching', () => {
  it.each(['theme', 'view', 'hidden', 'later', 'navigation'] as const)('admits an owner %s edit during a seen write without a stale-view conflict', async action => {
    const { store, transport } = await setup();
    const before = store.getSnapshot().preferences!;
    let release!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null });
    const saving = action === 'theme' ? store.saveTheme('dark', before.revision)
      : action === 'view' ? store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, before.revision)
        : action === 'hidden' ? store.setHidden({ ...route, item_id: '1' }, true, before.revision)
          : action === 'later' ? store.setLater({ ...route, item_id: '1' }, true, before.revision)
            : store.navigate({ kind: 'all_sessions' });
    // A stalled background write delays the owner only for the bounded wait.
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    expect(transport.mutations).toHaveLength(1);
    transport.holdSeen = null; release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(3);
    const command = transport.mutations[2].command;
    expect(command.command === 'preferences_patch' && command.params.expected_preferences_revision).toBe(2);
    expect(store.getSnapshot().error).toBeNull();
  });

  it('ignores a delayed seen receipt after a newer owner edit is saved', async () => {
    const { store, transport } = await setup();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const result = await invoke(name, args);
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.every(entry => entry.kind === 'mark_seen')) await gate;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.preferences.revision).toBe(2);
    // The delayed receipt leaves navigation at its old capture. After the bounded
    // wait, the owner reads the committed marks before saving its requested theme.
    const saving = store.saveTheme('dark', 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    const saved = store.getSnapshot().preferences!;
    expect(saved.revision).toBe(3);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().preferences).toBe(saved);
    expect(store.getSnapshot().preferences!.global.theme).toBe('dark');
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
  });

  it('persists an item selection after an in-flight seen write commits', async () => {
    const { store, transport } = await setup();
    let release!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    const saving = store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.mutations).toHaveLength(0);
    expect(store.getSnapshot().error).toBeNull();
    transport.holdSeen = null; release();
    expect(await saving).toBe(true);
    expect(transport.mutations).toHaveLength(2);
    const command = transport.mutations[1].command;
    expect(command.command === 'preferences_patch' && command.params.expected_preferences_revision).toBe(2);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items.map(item => item.item_id)).toEqual(['1']);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
  });

  it('refreshes a session before selection preparation prunes a newly created foreign hidden item', async () => {
    const transport = new SeenTransport(), session = transport.sessions.get(route.session_id)!;
    delete session.items['3'];
    const { store } = await setup(true, transport);
    const rendered = store.getSnapshot().preferences!;
    let release!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    await vi.advanceTimersByTimeAsync(1000);
    const view = structuredClone(rendered.sessions[0]) as SessionPreferences;
    const saving = store.saveSessionView({ ...view, selected_item_id: '2' }, rendered.revision);
    session.items['3'] = { ...session.items['2']!, id: '3', ordinal: 3 };
    ++session.revision;
    transport.preferences.sessions[0].hidden_item_ids = ['3'];
    ++transport.preferences.revision;
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    expect(transport.preferences.sessions[0]).toMatchObject({ selected_item_id: '2', hidden_item_ids: ['3'] });
    expect(store.opened.get(route)!.getSnapshot().snapshot?.session.items['3']?.id).toBe('3');
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    transport.holdSeen = null; release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['theme', 'layout'] as const)('retains a newly registered foreign project expansion while preparing a %s save', async action => {
    const { store, transport } = await setup();
    const rendered = store.getSnapshot().preferences!;
    const foreignProjectId = '00000000-0000-4000-8000-000000000099';
    let registered = false, release!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const result = await invoke(name, args);
      if (registered && 'request' in args.request && args.request.request.command === 'project_list') {
        const response = result as { data: { data: ProjectListResult } };
        const projects = response.data.data.projects;
        projects.items.push({ ...projects.items[0], project_id: foreignProjectId });
        ++projects.snapshot_revision;
      }
      return result;
    });
    await vi.advanceTimersByTimeAsync(1000);
    const saving = action === 'theme' ? store.saveTheme('dark', rendered.revision)
      : store.saveLayout({ waiting_collapsed: true }, rendered.revision);
    registered = true;
    transport.preferences.global.session_archive_expanded_project_ids = [foreignProjectId];
    ++transport.preferences.revision;
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    expect(transport.preferences.global.session_archive_expanded_project_ids).toEqual([foreignProjectId]);
    expect(store.getSnapshot().preferences?.global).toMatchObject(action === 'theme' ? { theme: 'dark' } : { waiting_collapsed: true });
    expect(store.getSnapshot().projects?.projects.items.some(project => project.project_id === foreignProjectId)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    transport.holdSeen = null; release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('accepts the rendered revision after refresh observes a seen commit whose receipt is held', async () => {
    const { store, transport } = await setup();
    const rendered = store.getSnapshot().preferences!;
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const receipt = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const result = await invoke(name, args);
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.every(entry => entry.kind === 'mark_seen')) await receipt;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.preferences.revision).toBe(2);
    await store.refresh();
    expect(store.getSnapshot().preferences?.revision).toBe(2);
    const view = structuredClone(rendered.sessions[0]) as SessionPreferences;
    const saving = store.saveSessionView({ ...view, selected_item_id: '2' }, rendered.revision);
    expect(store.getSnapshot().error).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    expect(transport.mutations).toHaveLength(2);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
    const saved = store.getSnapshot().preferences;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().preferences).toBe(saved);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
  });

  it('recovers a failed seen-conflict classification read without leaving the owner writer pending', async () => {
    const { store, transport } = await setup();
    let release!: () => void, committed!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    const seenCommitted = new Promise<void>(resolve => { committed = resolve; });
    const invoke = transport.invoke.bind(transport);
    let ownerAttempts = 0, failedReads = 0, failClassification = false;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('request' in request && request.request.command === 'preferences_get' && failClassification) {
        failClassification = false;
        ++failedReads;
        throw new Error('Classification read lost');
      }
      if ('command' in request && request.command.command === 'preferences_patch') {
        if (request.command.params.entries.every(entry => entry.kind === 'mark_seen')) {
          const result = await invoke(name, args);
          committed();
          return result;
        }
        if (++ownerAttempts === 1) {
          transport.holdSeen = null; release();
          await seenCommitted;
          failClassification = true;
        }
      }
      return invoke(name, args);
    });
    await vi.advanceTimersByTimeAsync(1000);
    const saving = store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1);
    // Observe a rejected promise as well as a false result: either must settle
    // the writer, and this recoverable read failure should still save the edit.
    const settled = saving.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(500);
    expect(failedReads).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    expect(await settled).toEqual({ value: true });
    expect(ownerAttempts).toBe(2);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
  });

  it.each([false, true])('rebases a seen commit between an owner read and send despite a changed navigation intent (delayed receipt: %s)', async delayedReceipt => {
    const { store, transport } = await setup();
    let release!: () => void, committed!: () => void, releaseReceipt!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    const seenCommitted = new Promise<void>(resolve => { committed = resolve; });
    const receipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const invoke = transport.invoke.bind(transport);
    let interleaved = false, navigating: Promise<boolean> | null = null;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('command' in request && request.command.command === 'preferences_patch') {
        if (request.command.params.entries.every(entry => entry.kind === 'mark_seen')) {
          const result = await invoke(name, args);
          committed();
          if (delayedReceipt) await receipt;
          return result;
        }
        if (!interleaved) {
          interleaved = true;
          // The admitted view edit keeps its fields while the latest navigation
          // waits for that owner writer, including its seen-conflict replay.
          navigating = store.navigate({ kind: 'all_sessions' });
          transport.holdSeen = null; release();
          await seenCommitted;
        }
      }
      return invoke(name, args);
    });
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    const saving = store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    releaseReceipt();
    expect(await navigating).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(4);
    expect(transport.mutations[2].command.op_id).not.toBe(transport.mutations[1].command.op_id);
    const command = transport.mutations[2].command;
    expect(command.command === 'preferences_patch' && command.params.expected_preferences_revision).toBe(2);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'all_sessions' });
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items.map(item => item.item_id)).toEqual(['1']);
    const saved = store.getSnapshot().preferences;
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().preferences).toBe(saved);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
  });

  it('keeps only the latest navigation requested during the seen wait', async () => {
    const { store, transport } = await setup();
    let release!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    await vi.advanceTimersByTimeAsync(1000);
    const first = store.navigate({ kind: 'session', session: { ...route, session_id: secondId } });
    await vi.advanceTimersByTimeAsync(100);
    const latest = store.navigate({ kind: 'all_sessions' });
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.mutations).toHaveLength(0);
    transport.holdSeen = null; release();
    expect(await first).toBe(false);
    expect(await latest).toBe(true);
    expect(transport.mutations).toHaveLength(2);
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'all_sessions' });
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
  });

  it.each([1, 2])('keeps the ordinary foreign-conflict retry budget after a seen conflict (%s foreign conflicts)', async foreignConflicts => {
    const { store, transport } = await setup();
    let release!: () => void, committed!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    const seenCommitted = new Promise<void>(resolve => { committed = resolve; });
    const invoke = transport.invoke.bind(transport);
    let ownerAttempts = 0;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('command' in request && request.command.command === 'preferences_patch') {
        if (request.command.params.entries.every(entry => entry.kind === 'mark_seen')) {
          const result = await invoke(name, args);
          committed();
          return result;
        }
        ++ownerAttempts;
        if (ownerAttempts === 1) {
          transport.holdSeen = null; release();
          await seenCommitted;
        } else if (ownerAttempts <= foreignConflicts + 1) {
          transport.preferences.global.pinned = true;
          ++transport.preferences.revision;
        }
      }
      return invoke(name, args);
    });
    await vi.advanceTimersByTimeAsync(1000);
    const saving = store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(foreignConflicts === 1);
    expect(ownerAttempts).toBe(3);
    expect(transport.preferences.global.pinned).toBe(true);
    expect(transport.preferences.sessions[0].selected_item_id).toBe(foreignConflicts === 1 ? '2' : null);
    if (foreignConflicts === 1) expect(store.getSnapshot().error).toBeNull();
    else expect(store.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null });
  });

  it('keeps a selection save unaffected by a seen failure while the owner write is pending', async () => {
    const { store, transport } = await setup();
    let releaseSeen!: () => void, releaseOwner!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { releaseSeen = resolve; });
    transport.holdPatch = new Promise<void>(resolve => { releaseOwner = resolve; });
    transport.failSeen = async () => { throw new Error('Lost seen response'); };
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    const saving = store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getSnapshot()).toMatchObject({ writing: true, error: null });
    transport.holdSeen = null; releaseSeen();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ writing: true, error: null });
    expect(store.getMutationFailure()).toBeNull();
    transport.failSeen = null;
    transport.holdPatch = null; releaseOwner();
    expect(await saving).toBe(true);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
    expect(store.getMutationFailure()).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(3);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items.map(item => item.item_id)).toEqual(['1']);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
  });

  it('bounds a hung seen wait and retains marks when the delayed batch conflicts', async () => {
    const { store, transport } = await setup();
    let release!: () => void;
    transport.holdSeen = new Promise<void>(resolve => { release = resolve; });
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    const saving = store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1);
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.mutations).toHaveLength(0);
    store.markItemSeen(route, '2');
    await vi.advanceTimersByTimeAsync(1);
    expect(await saving).toBe(true);
    expect(transport.mutations).toHaveLength(1);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('2');
    transport.holdSeen = null; release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(3);
    expect(seenEntries(transport.mutations[2])[0].items.map(item => item.item_id).sort()).toEqual(['1', '2']);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items.map(item => item.item_id).sort()).toEqual(['1', '2']);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
  });

  it('keeps navigation object identities and accepts only its own seen-only revision advances', async () => {
    const { store, transport } = await setup();
    const before = store.getSnapshot().preferences!;
    await vi.advanceTimersByTimeAsync(1000);
    await store.refresh();
    const after = store.getSnapshot().preferences!;
    expect(after.global).toBe(before.global);
    expect(after.sessions).toBe(before.sessions);
    expect(after.sessions[0]).toBe(before.sessions[0]);
    expect(after.later).toBe(before.later);
    expect(await store.saveTheme('dark', before.revision)).toBe(true);
    const captured = transport.preferences.revision;
    transport.preferences.global.pinned = true; ++transport.preferences.revision;
    await store.refresh();
    expect(await store.saveTheme('light', captured)).toBe(false);
    expect(store.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
    expect(transport.preferences.global.pinned).toBe(true);
  });

  it('waits for an owner navigation capture before starting a due seen patch', async () => {
    const { store, transport } = await setup();
    let release!: () => void;
    transport.holdSession = new Promise<void>(resolve => { release = resolve; });
    const navigating = store.navigate({ kind: 'session', session: { ...route, session_id: secondId } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    expect(await navigating).toBe(false);
    expect(store.getSnapshot().pendingNavigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
    transport.holdSession = null; release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
    expect(transport.mutations.flatMap(seenEntries).map(entry => entry.session.session_id)).toEqual([route.session_id, secondId]);
  });

  it('initializes the selected session with an empty baseline after one second', async () => {
    const { store, transport } = await setup();
    const revision = transport.sessions.get(route.session_id)!.revision;
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.mutations).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(seenEntries(transport.mutations[0])).toEqual([{ kind: 'mark_seen', session: route, at: initialTime, items: [], topics: [] }]);
    expect(sessionSeen(store.getSnapshot().preferences, route)).toEqual({ session: route, since: initialTime, items: [], topics: [] });
    expect(transport.sessions.get(route.session_id)?.revision).toBe(revision);
  });

  it('does not initialize a session captured in the background or mark a selected item implicitly', async () => {
    const { store, transport } = await setup(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    expect(await store.navigate({ kind: 'session', session: route })).toBe(true);
    expect(await store.saveSessionView({ ...transport.view(), selected_item_id: '1' }, transport.preferences.revision)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const marks = transport.mutations.flatMap(seenEntries);
    expect(marks).toHaveLength(1);
    expect(marks[0].items).toEqual([]);
  });

  it('preserves an existing baseline across reopen and refresh', async () => {
    const transport = new SeenTransport();
    const since = '2026-10-01T00:00:00.000Z';
    transport.preferences.seen = [{ session: route, since, items: [], topics: [] }];
    const { store } = await setup(true, transport);
    await store.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.since).toBe(since);
  });

  it('debounces details and peeks into one patch at their latest captured revisions', async () => {
    const { store, transport } = await setup();
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(600);
    const session = transport.sessions.get(route.session_id)!;
    session.items['1']!.revision = 4; ++session.revision;
    await store.opened.get(route)!.refresh();
    store.markItemSeen(route, '1');
    store.markItemSeen(route, '2');
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.mutations).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.mutations).toHaveLength(1);
    expect(seenEntries(transport.mutations[0])[0]).toMatchObject({ at: initialTime,
      items: [{ item_id: '1', revision: 4 }, { item_id: '2', revision: session.items['2']!.revision }] });
    expect(session.items['2']!.status).toBe('waiting_on_me');
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(1);
  });

  it('batches multiple sessions and explicit topic catch-up without merging their identities', async () => {
    const { store, transport } = await setup();
    const secondRoute = { ...route, session_id: secondId };
    const first = transport.sessions.get(route.session_id)!, second = transport.sessions.get(secondId)!;
    second.items = structuredClone(first.items);
    await store.opened.open(secondRoute).refresh();
    store.markItemSeen(route, '1');
    store.markItemSeen(secondRoute, '1');
    const topicId = Object.keys(first.topics)[0];
    store.markTopicCaughtUp(route, topicId);
    await vi.advanceTimersByTimeAsync(500);
    store.markTopicCaughtUp(route, topicId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(1);
    const marks = seenEntries(transport.mutations[0]);
    expect(marks).toHaveLength(2);
    expect(marks[0].topics).toEqual([{ topic_id: topicId, at: '2026-10-13T10:00:00.500Z' }]);
    expect(marks[1]).toMatchObject({ session: secondRoute, items: [{ item_id: '1', revision: first.items['1']!.revision }] });
    expect(transport.preferences.seen).toHaveLength(2);
  });

  it('retries conflicts against fresh preferences and preserves upward-only foreign seen state', async () => {
    const { store, transport } = await setup();
    store.markItemSeen(route, '1');
    transport.beforePatch = () => {
      transport.preferences.global.pinned = true;
      transport.preferences.seen = [{ session: route, since: '2026-10-01T00:00:00.000Z',
        items: [{ item_id: '1', revision: 8 }, { item_id: '2', revision: 2 }], topics: [] }];
      ++transport.preferences.revision;
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(2);
    expect(transport.mutations[1].command.op_id).not.toBe(transport.mutations[0].command.op_id);
    expect(entries(transport.mutations[1])).toEqual(entries(transport.mutations[0]));
    expect(store.getSnapshot().preferences?.global.pinned).toBe(true);
    expect(sessionSeen(store.getSnapshot().preferences, route)).toMatchObject({ since: '2026-10-01T00:00:00.000Z',
      items: [{ item_id: '1', revision: 8 }, { item_id: '2', revision: 2 }] });
    expect(store.getSnapshot().error).toBeNull();
  });

  it('waits for a busy preference writer and then patches its resulting revision', async () => {
    const { store, transport } = await setup();
    let release!: () => void;
    transport.holdPatch = new Promise<void>(resolve => { release = resolve; });
    const saving = store.saveTheme('dark', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    transport.holdPatch = null; release();
    expect(await saving).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(2);
    expect(transport.preferences.global.theme).toBe('dark');
    expect(sessionSeen(store.getSnapshot().preferences, route)?.since).toBe(initialTime);
  });

  it('retains a new observation queued during an in-flight seen batch', async () => {
    const { store, transport } = await setup();
    let release!: () => void;
    transport.holdPatch = new Promise<void>(resolve => { release = resolve; });
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getWritingCompletion()).toBeNull();
    store.markItemSeen(route, '2');
    await vi.advanceTimersByTimeAsync(1000);
    transport.holdPatch = null; release();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(2);
    expect(seenEntries(transport.mutations[0])[0].items.map(item => item.item_id)).toEqual(['1']);
    expect(seenEntries(transport.mutations[1])[0].items.map(item => item.item_id)).toEqual(['2']);
  });

  it.each(['transport', 'commit_uncertain', 'delivery_uncertain'] as const)('silently retries %s seen failures without blocking owner edits', async code => {
    const { store, transport } = await setup();
    store.markItemSeen(route, '1');
    const invoke = transport.invoke.bind(transport);
    let fail = true;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (fail && 'command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.every(entry => entry.kind === 'mark_seen')) {
        fail = false;
        if (code === 'transport') {
          transport.mutations.push(structuredClone(args.request));
          throw new Error('Lost response');
        }
        // Model an uncertain result whose monotonic marks actually committed.
        await invoke(name, args);
        return { api_version: 1, ok: false, error: { code, message: 'Unknown completion.', hint: '', retryable: true, field_errors: [] } };
      }
      return invoke(name, args);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, error: null });
    expect(store.getMutationFailure()).toBeNull();
    expect(store.getWritingCompletion()).toBeNull();
    expect(await store.navigate({ kind: 'all_sessions' })).toBe(true);
    store.markItemSeen(route, '2');
    await vi.advanceTimersByTimeAsync(1000);
    const marks = transport.mutations.filter(request => seenEntries(request).length);
    expect(marks).toHaveLength(2);
    expect(marks[1].command.op_id).not.toBe(marks[0].command.op_id);
    expect(seenEntries(marks[1])[0].items.map(item => item.item_id)).toEqual(['1', '2']);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items).toHaveLength(2);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.since).toBe(initialTime);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, error: null });
  });

  it('does not mark an item until a hinted session has a fresh capture', async () => {
    const { store, transport } = await setup(false);
    const session = transport.sessions.get(route.session_id)!;
    session.items['1']!.revision = 6; ++session.revision;
    let release!: () => void;
    transport.holdSession = new Promise<void>(resolve => { release = resolve; });
    transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
    expect(store.opened.get(route)!.getSnapshot().status).toBe('stale');
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    transport.holdSession = null; release();
    await store.opened.get(route)!.refresh();
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(seenEntries(transport.mutations[0])[0].items).toEqual([{ item_id: '1', revision: 6 }]);
  });

  it('reads fresh revisions and survives two conflicts caused by saved draft keystrokes', async () => {
    const { store, transport } = await setup();
    const drafts = new OwnerDraftStore(store.service);
    await drafts.load();
    const session = store.opened.get(route)!.getSnapshot().snapshot!.session;
    const draftId = drafts.begin(session, '2', 'answer')!;
    expect(draftId).toBeTruthy();
    expect(await drafts.editSaved(draftId, { text: 'A' })).toBe(true);
    expect(store.getSnapshot().preferences!.revision).toBe(1);
    const invoke = transport.invoke.bind(transport);
    let conflicts = 0;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.every(entry => entry.kind === 'mark_seen') && conflicts < 2) {
        ++conflicts;
        expect(args.request.command.params.expected_preferences_revision).toBe(transport.preferences.revision);
        expect(await drafts.editSaved(draftId, { text: conflicts === 1 ? 'AB' : 'ABC' })).toBe(true);
      }
      return invoke(name, args);
    });
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(conflicts).toBe(2);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    expect(await store.setHidden({ ...route, item_id: '1' }, true, store.getSnapshot().preferences!.revision)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    const marks = transport.mutations.filter(request => seenEntries(request).length);
    expect(marks).toHaveLength(3);
    expect(new Set(marks.map(request => request.command.op_id)).size).toBe(3);
    expect(transport.preferences.drafts.find(draft => draft.op_id === draftId)?.text).toBe('ABC');
    expect(transport.preferences.sessions[0].hidden_item_ids).toEqual(['1']);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items).toEqual([{ item_id: '1', revision: session.items['1']!.revision }]);
    expect(store.getSnapshot().error).toBeNull();
  });

  it('bounds repeated background failures and resumes retained marks on the next observation', async () => {
    const { store, transport } = await setup();
    transport.failSeen = async () => { throw new Error('Offline'); };
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.mutations).toHaveLength(3);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false, pendingOperationId: null });
    transport.failSeen = null;
    store.markItemSeen(route, '2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(4);
    expect(seenEntries(transport.mutations[3])[0]).toMatchObject({ at: initialTime,
      items: [{ item_id: '1', revision: transport.sessions.get(route.session_id)!.items['1']!.revision },
        { item_id: '2', revision: transport.sessions.get(route.session_id)!.items['2']!.revision }] });
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items).toHaveLength(2);
  });

  it('keeps a rejected owner error visible while background bookkeeping succeeds', async () => {
    const { store, transport } = await setup();
    expect(await store.saveTheme('dark', 0)).toBe(false);
    const error = store.getSnapshot().error;
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(1);
    expect(store.getSnapshot().error).toBe(error);
    expect(await store.saveTheme('dark', 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(2);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.since).toBe(initialTime);
  });

  it('cancels a queued upgrade baseline on disposal without submitting an owner observation', async () => {
    const { store, transport } = await setup();
    store.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.mutations).toHaveLength(0);
  });

  it('ignores absent items and finishes observed reads on disposal without blocking teardown', async () => {
    const { store, transport } = await setup(false);
    store.markItemSeen(route, 'missing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    store.markItemSeen(route, '1');
    store.stop();
    expect(store.getSnapshot().writing).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    store.markTopicCaughtUp(route, 'missing');
    expect(transport.mutations).toHaveLength(1);
    expect(seenEntries(transport.mutations[0])[0].items).toEqual([{ item_id: '1', revision: transport.sessions.get(route.session_id)!.items['1']!.revision }]);
  });

  it('records a displayed revision when a newer revision arrives before the dwell callback', async () => {
    const { store, transport } = await setup(false);
    const session = transport.sessions.get(route.session_id)!;
    session.items['1']!.revision = 3;
    ++session.revision;
    await store.opened.open(route).refresh();
    session.items['1']!.revision = 4;
    ++session.revision;
    await store.opened.open(route).refresh();
    store.markItemSeen(route, '1', 3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seenEntries(transport.mutations[0])[0].items).toEqual([{ item_id: '1', revision: 3 }]);
  });

  it('finishes pending catch-up on disposal, rebases a conflict and keeps errors silent', async () => {
    const { store, transport } = await setup(false);
    const session = transport.sessions.get(route.session_id)!, topicId = Object.keys(session.topics)[0];
    store.reading.catchUp({ kind: 'mark_seen', session: route, at: initialTime,
      items: [{ item_id: '1', revision: session.items['1']!.revision }], topics: [{ topic_id: topicId, at: session.updated_at }] });
    transport.beforePatch = () => { transport.preferences.global.pinned = true; ++transport.preferences.revision; };
    store.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(2);
    expect(sessionSeen(transport.preferences, route)?.topics).toEqual([{ topic_id: topicId, at: session.updated_at }]);
    expect(transport.preferences.global.pinned).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ error: null, writing: false });
    await vi.advanceTimersByTimeAsync(6000);
    expect(transport.mutations).toHaveLength(2);
  });
});
