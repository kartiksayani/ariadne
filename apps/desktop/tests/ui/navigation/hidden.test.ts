import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { OwnerMutationRequest } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { AppTransport, route } from '../app/transport';

class ConflictingTransport extends AppTransport {
  beforePatch: (() => void) | null = null;
  holdPatch: Promise<void> | null = null;
  holdSession: { entered: () => void; release: Promise<void> } | null = null;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if (name === 'session_get' && this.holdSession) {
      const hold = this.holdSession;
      this.holdSession = null;
      const captured = await super.invoke<T>(name, args);
      hold.entered();
      await hold.release;
      return captured;
    }
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
afterEach(() => { stores.splice(0).forEach(store => store.stop()); });
const view = (transport: AppTransport) => transport.preferences.sessions[0];
const writtenView = (request: OwnerMutationRequest) => {
  if (request.command.command !== 'preferences_patch') throw new Error('Expected a preferences patch');
  const entry = request.command.params.entries[0];
  if (entry.kind !== 'set_session_view') throw new Error('Expected a session view');
  return entry.preferences;
};
async function setup(hidden: string[] = []) {
  const transport = new ConflictingTransport();
  view(transport).hidden_item_ids = hidden;
  const store = new NavigationStore(createDesktopService(transport));
  stores.push(store);
  await store.start();
  await store.opened.open(route).refresh();
  return { transport, store };
}

describe('hidden preference write admission and replay', () => {
  it('reserves the writer synchronously before another toggle or selection save', async () => {
    const { transport, store } = await setup();
    let release!: () => void;
    transport.holdPatch = new Promise<void>(resolve => { release = resolve; });
    const sessionReads = transport.queries.filter(request => request.request.command === 'session_get').length;
    const hiding = store.setHidden({ ...route, item_id: '1' }, true, 1);
    expect(store.getSnapshot().writing).toBe(true);
    expect(await store.setHidden({ ...route, item_id: '2' }, true, 1)).toBe(false);
    expect(await store.saveSessionView({ ...transport.view(), selected_item_id: '2' }, 1)).toBe(false);
    expect(transport.queries.filter(request => request.request.command === 'session_get')).toHaveLength(sessionReads);
    transport.holdPatch = null; release();
    expect(await hiding).toBe(true);
    expect(await store.setHidden({ ...route, item_id: '2' }, true, 2)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['1', '2']);
  });

  it('recomputes hide A after a conflicting hide B between the read and write', async () => {
    const { transport, store } = await setup();
    transport.beforePatch = () => {
      view(transport).hidden_item_ids = ['2'];
      view(transport).selected_item_id = '2';
      ++transport.preferences.revision;
    };
    expect(await store.setHidden({ ...route, item_id: '1' }, true, 1)).toBe(true);
    expect(transport.mutations).toHaveLength(2);
    expect(writtenView(transport.mutations[0]).hidden_item_ids).toEqual(['1']);
    expect(writtenView(transport.mutations[1]).hidden_item_ids).toEqual(['2', '1']);
    expect(view(transport).selected_item_id).toBe('2');
    expect(store.getSnapshot().preferences?.sessions[0].hidden_item_ids).toEqual(['2', '1']);
    expect(transport.mutations[1].command.op_id).not.toBe(transport.mutations[0].command.op_id);
  });

  it('writes an empty set when unhiding the last item after a conflicting selection save', async () => {
    const { transport, store } = await setup(['4']);
    transport.beforePatch = () => { view(transport).selected_item_id = '2'; ++transport.preferences.revision; };
    expect(await store.setHidden({ ...route, item_id: '4' }, false, 1)).toBe(true);
    expect(transport.mutations).toHaveLength(2);
    expect(transport.mutations.map(request => writtenView(request).hidden_item_ids)).toEqual([[], []]);
    expect(view(transport).hidden_item_ids).toEqual([]);
    expect(store.getSnapshot().preferences?.sessions[0]).toMatchObject({ hidden_item_ids: [], selected_item_id: '2' });
  });

  it('recomputes inherited unhide and retains independently hidden siblings and descendants', async () => {
    const { transport, store } = await setup(['1']);
    transport.beforePatch = () => {
      view(transport).hidden_item_ids = ['1', '1.1', '2']; ++transport.preferences.revision;
    };
    expect(await store.setHidden({ ...route, item_id: '1' }, false, 1)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['1.1', '2']);
    expect(await store.setHidden({ ...route, item_id: '1.1' }, false, 3)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['2']);
  });

  it('prunes removed ids only on write and preserves concurrent hides on selection retry', async () => {
    const { transport, store } = await setup(['99', '4']);
    expect(store.getSnapshot().preferences?.sessions[0].hidden_item_ids).toEqual(['99', '4']);
    expect(view(transport).hidden_item_ids).toEqual(['99', '4']);
    expect(transport.mutations).toHaveLength(0);
    transport.beforePatch = () => {
      view(transport).hidden_item_ids = ['99', '4', '2']; ++transport.preferences.revision;
    };
    expect(await store.saveSessionView({ ...view(transport), selected_item_id: '2' }, 1)).toBe(true);
    expect(writtenView(transport.mutations[0]).hidden_item_ids).toEqual(['4']);
    expect(view(transport).hidden_item_ids).toEqual(['4', '2']);
    expect(store.getSnapshot().preferences?.sessions[0].hidden_item_ids).toEqual(['4', '2']);
  });

  it('prunes removed ids during hide and unhide writes', async () => {
    const { transport, store } = await setup(['99', '4']);
    expect(await store.setHidden({ ...route, item_id: '2' }, true, 1)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['4', '2']);
    expect(await store.setHidden({ ...route, item_id: '4' }, false, 2)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['2']);
  });

  it('refreshes session before retry cleanup to retain a newly created hidden item', async () => {
    const { transport, store } = await setup();
    transport.beforePatch = () => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['99'] = { ...session.items['4']!, id: '99', ordinal: 99 };
      ++session.revision;
      view(transport).hidden_item_ids = ['99']; ++transport.preferences.revision;
    };
    expect(await store.setHidden({ ...route, item_id: '4' }, true, 1)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['99', '4']);
  });

  it('refreshes selection retry when a foreign write first adds hidden preferences', async () => {
    const { transport, store } = await setup();
    transport.beforePatch = () => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['99'] = { ...session.items['4']!, id: '99', ordinal: 99 };
      ++session.revision;
      view(transport).hidden_item_ids = ['99']; ++transport.preferences.revision;
    };
    expect(await store.saveSessionView({ ...view(transport), selected_item_id: '2' }, 1)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['99']);
  });

  it('retains a foreign hide learned before the next local toggle without a conflict', async () => {
    const { transport, store } = await setup();
    const session = transport.sessions.get(route.session_id)!;
    session.items['99'] = { ...session.items['4']!, id: '99', ordinal: 99 };
    ++session.revision;
    view(transport).hidden_item_ids = ['99']; ++transport.preferences.revision;
    await store.refresh();
    expect(await store.setHidden({ ...route, item_id: '4' }, true, 2)).toBe(true);
    expect(transport.mutations).toHaveLength(1);
    expect(view(transport).hidden_item_ids).toEqual(['99', '4']);
  });

  it('reads again after an older session capture already in flight when a hide conflicts', async () => {
    const { transport, store } = await setup();
    let captured!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { captured = resolve; });
    transport.holdSession = { entered: captured, release: new Promise<void>(resolve => { release = resolve; }) };
    const refreshing = store.opened.get(route)!.refresh();
    await entered;
    transport.beforePatch = () => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['99'] = { ...session.items['4']!, id: '99', ordinal: 99 };
      ++session.revision;
      view(transport).hidden_item_ids = ['99']; ++transport.preferences.revision;
    };
    const hiding = store.setHidden({ ...route, item_id: '4' }, true, 1);
    await waitFor(() => expect(transport.queries.filter(request => request.request.command === 'preferences_get')).toHaveLength(2));
    // Let the conflict refresh reach the held session read before releasing it.
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    release(); await refreshing;
    expect(await hiding).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['99', '4']);
    expect(store.opened.get(route)!.getSnapshot().snapshot?.session.items['99']).toBeTruthy();
  });

  it('pairs foreign hidden preferences with a fresh session even during its first read', async () => {
    const transport = new ConflictingTransport(), store = new NavigationStore(createDesktopService(transport));
    stores.push(store); await store.start();
    let captured!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { captured = resolve; });
    transport.holdSession = { entered: captured, release: new Promise<void>(resolve => { release = resolve; }) };
    const opened = store.opened.open(route);
    await entered;
    const session = transport.sessions.get(route.session_id)!;
    session.items['99'] = { ...session.items['4']!, id: '99', ordinal: 99 };
    ++session.revision;
    view(transport).hidden_item_ids = ['99']; ++transport.preferences.revision;
    const reading = store.refresh();
    await waitFor(() => expect(transport.queries.filter(request => request.request.command === 'preferences_get')).toHaveLength(2));
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(opened.getSnapshot().snapshot).toBeNull();
    expect(store.getSnapshot().preferences?.revision).toBe(1);
    release(); await reading;
    expect(await store.setHidden({ ...route, item_id: '4' }, true, 2)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['99', '4']);
  });

  it('retains unavailable session preferences without opening sessions for cleanup', async () => {
    const { transport, store } = await setup(['99', '4']);
    store.opened.close(route);
    const sessionReads = transport.queries.filter(request => request.request.command === 'session_get').length;
    expect(await store.saveSessionView({ ...view(transport), selected_item_id: '2' }, 1)).toBe(true);
    expect(view(transport).hidden_item_ids).toEqual(['99', '4']);
    expect(store.opened.get(route)).toBeUndefined();
    expect(transport.queries.filter(request => request.request.command === 'session_get')).toHaveLength(sessionReads);
  });

  it('surfaces removal during a conflict and releases the writer for the next action', async () => {
    const { transport, store } = await setup();
    transport.beforePatch = () => {
      const session = transport.sessions.get(route.session_id)!;
      delete session.items['4']; ++session.revision; ++transport.preferences.revision;
    };
    expect(await store.setHidden({ ...route, item_id: '4' }, true, 1)).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null,
      error: { error: { code: 'revision_conflict' } } });
    expect(await store.setHidden({ ...route, item_id: '2' }, true, 2)).toBe(true);
  });

  it('retains the exact hide command for explicit reconciliation after an uncertain response', async () => {
    const { transport, store } = await setup(['99']);
    transport.failNext = 'preferences_patch';
    expect(await store.setHidden({ ...route, item_id: '4' }, true, 1)).toBe(false);
    expect(store.getSnapshot().pendingOperationId).not.toBeNull();
    expect(await store.retryMutation()).toBe(true);
    expect(transport.mutations[1]).toEqual(transport.mutations[0]);
    expect(view(transport).hidden_item_ids).toEqual(['4']);
  });
});
