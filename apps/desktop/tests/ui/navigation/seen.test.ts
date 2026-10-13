import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerMutationRequest, PreferencesPatchEntry } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { sessionSeen, type SeenPatch } from '../../../src/state/preferences/seen';
import { AppTransport, route, secondId } from '../app/transport';

class SeenTransport extends AppTransport {
  beforePatch: (() => void) | null = null;
  holdPatch: Promise<void> | null = null;
  holdSession: Promise<void> | null = null;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    if (name === 'session_get' && this.holdSession) await this.holdSession;
    const request = args.request;
    if ('command' in request && request.command.command === 'preferences_patch') {
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
    transport.holdPatch = new Promise<void>(resolve => { release = resolve; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null });
    const saving = action === 'theme' ? store.saveTheme('dark', before.revision)
      : action === 'view' ? store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, before.revision)
        : action === 'hidden' ? store.setHidden({ ...route, item_id: '1' }, true, before.revision)
          : action === 'later' ? store.setLater({ ...route, item_id: '1' }, true, before.revision)
            : store.navigate({ kind: 'all_sessions' });
    transport.holdPatch = null; release();
    expect(await saving).toBe(true);
    expect(transport.mutations).toHaveLength(2);
    const command = transport.mutations[1].command;
    expect(command.command === 'preferences_patch' && command.params.expected_preferences_revision).toBe(2);
    expect(store.getSnapshot().error).toBeNull();
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
    transport.holdSession = null; release();
    expect(await navigating).toBe(true);
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

  it('retries once against fresh preferences with a new id and preserves upward-only foreign seen state', async () => {
    const { store, transport } = await setup();
    store.markItemSeen(route, '1');
    transport.beforePatch = () => {
      // A later navigation attempt does not invalidate an already viewed item.
      void store.navigate({ kind: 'all_sessions' });
      transport.preferences.global.pinned = true;
      transport.preferences.seen = [{ session: route, since: '2026-10-01T00:00:00.000Z',
        items: [{ item_id: '1', revision: 8 }, { item_id: '2', revision: 2 }], topics: [] }];
      ++transport.preferences.revision;
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(3);
    expect(transport.mutations[1].command.op_id).not.toBe(transport.mutations[0].command.op_id);
    expect(entries(transport.mutations[1])).toEqual(entries(transport.mutations[0]));
    expect(store.getSnapshot().preferences?.global.pinned).toBe(true);
    expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'all_sessions' });
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
    const firstWrite = store.getWritingCompletion()!;
    store.markItemSeen(route, '2');
    await vi.advanceTimersByTimeAsync(1000);
    transport.holdPatch = null; release();
    expect(await firstWrite).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(2);
    expect(seenEntries(transport.mutations[0])[0].items.map(item => item.item_id)).toEqual(['1']);
    expect(seenEntries(transport.mutations[1])[0].items.map(item => item.item_id)).toEqual(['2']);
  });

  it('keeps uncertain seen operations for explicit reconciliation without automatic replay', async () => {
    const { store, transport } = await setup();
    transport.failNext = 'preferences_patch';
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot().pendingOperationId).not.toBeNull();
    store.markItemSeen(route, '1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(1);
    expect(await store.retryMutation()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations[1]).toEqual(transport.mutations[0]);
    expect(transport.mutations).toHaveLength(3);
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

  it('serializes explicit reconciliation of an uncertain seen write with owner edits and rejects duplicate retries', async () => {
    const { store, transport } = await setup();
    transport.failNext = 'preferences_patch';
    await vi.advanceTimersByTimeAsync(1000);
    let release!: () => void;
    transport.holdPatch = new Promise<void>(resolve => { release = resolve; });
    const retry = store.retryMutation();
    expect(store.getSnapshot().writing).toBe(true);
    expect(await store.retryMutation()).toBe(false);
    const saving = store.saveTheme('dark', transport.preferences.revision);
    transport.holdPatch = null; release();
    expect(await retry).toBe(true);
    expect(await saving).toBe(true);
    expect(transport.mutations).toHaveLength(3);
    expect(transport.mutations[1]).toEqual(transport.mutations[0]);
    expect(transport.preferences.global.theme).toBe('dark');
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, error: null });
  });

  it('holds bookkeeping after a rejected owner edit so its error stays visible', async () => {
    const { store, transport } = await setup();
    expect(await store.saveTheme('dark', 0)).toBe(false);
    const error = store.getSnapshot().error;
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    expect(store.getSnapshot().error).toBe(error);
    expect(await store.saveTheme('dark', 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.mutations).toHaveLength(2);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.since).toBe(initialTime);
  });

  it('ignores absent items and cancels unsaved debounce work on disposal', async () => {
    const { store, transport } = await setup(false);
    store.markItemSeen(route, 'missing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.mutations).toHaveLength(0);
    store.markItemSeen(route, '1');
    store.stop();
    await vi.advanceTimersByTimeAsync(1000);
    store.markTopicCaughtUp(route, 'missing');
    expect(transport.mutations).toHaveLength(0);
  });
});
