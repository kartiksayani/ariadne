// alpha.23 F6a/F6b: the stores publish only on a real change. While nothing changed, a poll must leave every
// published object (state, snapshot, presence, rows) exactly as it was, so the Map has nothing to redraw.
import { afterEach, describe, expect, it, vi } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { PresenceObservation } from '../../../src/generated/domain/models';
import type { OwnerQueryRequest } from '../../../src/generated/core';
import { createDesktopService, OpenSessions, ServiceFailure, SessionStore, readAt } from '../../../src/data';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { connectionView } from '../../../src/components/navigation/WorkspaceTopBar';
import { clock } from '../../../src/ui/shell/model';
import { AppTransport, route, secondId } from '../app/transport';

/** The fake desktop, with the two things a poll can answer differently: how fresh the session read is, and whether it fails. */
class Transport extends AppTransport {
  freshness: 'fresh' | 'stale' = 'fresh';
  failing = false;
  async invoke<T>(name: string, args: { request: OwnerQueryRequest }): Promise<T> {
    if (name === 'session_get' && this.failing) throw new Error('Read failed');
    const answer = await super.invoke<T>(name, args as never);
    if (name === 'session_get' && this.freshness !== 'fresh') {
      (answer as { data: { data: { freshness: string } } }).data.data.freshness = this.freshness;
    }
    return answer;
  }
}
const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach(close => close()); vi.useRealTimers(); });

/** Counts the publishes a store makes from now on. */
function counter(subscribe: (receive: () => void) => () => void) {
  let count = 0;
  const stop = subscribe(() => { count++; });
  closers.push(stop);
  return { get count() { return count; }, reset() { count = 0; } };
}
function sessionStore(transport = new Transport()) {
  const store = new SessionStore(createDesktopService(transport), route);
  closers.push(() => store.close());
  return { transport, store };
}
const presence = (transport: Transport, patch: Partial<PresenceObservation> = {}): PresenceObservation => {
  const session = transport.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!;
  return { instance_id: '00000000-0000-4000-8000-000000000030', generation: binding.generation, connection_state: 'connected',
    execution_state: 'running', last_seen_at: '2026-10-03T12:00:50.000Z', source: 'host_event', freshness: 'fresh',
    process_identity: { pid: 1234, started_at: '2026-10-03T12:00:00.000Z' }, ...patch } as PresenceObservation;
};
const hint = (transport: Transport, observation: PresenceObservation) => {
  const session = transport.sessions.get(route.session_id)!;
  transport.emit('ariadne://presence_changed', { binding_id: session.active_binding_id!, generation: observation.generation, observation });
};

describe('SessionStore publishes only real changes (F6a)', () => {
  it('an unchanged poll publishes nothing and keeps the state, snapshot and presence objects', async () => {
    const { store } = sessionStore();
    await store.refresh();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    expect(first.status).toBe('ready'); expect(first.snapshot).not.toBeNull();
    for (let poll = 0; poll < 3; poll++) await store.refresh();
    expect(published.count).toBe(0);
    expect(store.getSnapshot()).toBe(first);
    expect(store.getSnapshot().snapshot).toBe(first.snapshot);
    expect(store.getSnapshot().presence).toBe(first.presence);
  });

  it('a skipped poll re-stamps readAt so the top bar names the last good read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
    const { store } = sessionStore();
    await store.refresh();
    const snapshot = store.getSnapshot().snapshot!, published = counter(store.subscribe);
    expect(readAt(snapshot)).toBe(Date.parse('2026-10-22T10:00:00.000Z'));
    vi.setSystemTime(new Date('2026-10-22T10:01:00.000Z'));
    await store.refresh();
    expect(published.count).toBe(0);
    expect(store.getSnapshot().snapshot).toBe(snapshot);
    expect(readAt(snapshot)).toBe(Date.parse('2026-10-22T10:01:00.000Z'));
  });

  it('the top bar names the last good read, which a skipped poll moved forward', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = (minute: number) => new Date(2026, 9, 22, 10, minute, 0);
    vi.setSystemTime(at(0));
    const { store, transport } = sessionStore();
    await store.refresh();
    vi.setSystemTime(at(7)); await store.refresh();
    vi.setSystemTime(at(15)); transport.failing = true; await store.refresh();
    const view = connectionView(store.getSnapshot());
    expect(view.kind).toBe('stale');
    expect(view.lastGoodAt).toBe(clock(at(7).getTime()));
  });

  it('a freshness change publishes once, and so does the change back', async () => {
    const { store, transport } = sessionStore();
    await store.refresh();
    const before = store.getSnapshot().snapshot!, published = counter(store.subscribe);
    transport.freshness = 'stale';
    await store.refresh();
    expect(published.count).toBe(1);
    expect(store.getSnapshot().snapshot!.freshness).toBe('stale'); expect(store.getSnapshot().status).toBe('stale');
    expect(store.getSnapshot().snapshot!.session).toBe(before.session);
    await store.refresh(); await store.refresh();
    expect(published.count).toBe(1);
    transport.freshness = 'fresh';
    await store.refresh();
    expect(published.count).toBe(2);
    expect(store.getSnapshot().status).toBe('ready');
  });

  it('a new revision publishes once with a new session object', async () => {
    const { store, transport } = sessionStore();
    await store.refresh();
    const before = store.getSnapshot().snapshot!, published = counter(store.subscribe);
    transport.sessions.get(route.session_id)!.revision++;
    await store.refresh();
    expect(published.count).toBe(1);
    expect(store.getSnapshot().snapshot!.session).not.toBe(before.session);
    await store.refresh();
    expect(published.count).toBe(1);
  });

  it('a failed read publishes once, a repeat of it nothing, and the recovery once', async () => {
    const { store, transport } = sessionStore();
    await store.refresh();
    const good = store.getSnapshot().snapshot!, published = counter(store.subscribe);
    transport.failing = true;
    await store.refresh();
    expect(published.count).toBe(1);
    expect(store.getSnapshot()).toMatchObject({ status: 'stale', error: expect.any(ServiceFailure) });
    expect(store.getSnapshot().snapshot).toBe(good);
    await store.refresh(); await store.refresh();
    expect(published.count).toBe(1);
    transport.failing = false;
    await store.refresh();
    expect(published.count).toBe(2);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null });
    // The read after a failure is a new capture (App clears a "still loading" refusal on one), over the same session object.
    const recovered = store.getSnapshot().snapshot!;
    expect(recovered).not.toBe(good); expect(recovered.session).toBe(good.session);
    await store.refresh();
    expect(published.count).toBe(2);
    expect(store.getSnapshot().snapshot).toBe(recovered);
  });

  it('a presence change publishes once; the same observation again publishes nothing', async () => {
    const { store, transport } = sessionStore();
    await store.refresh();
    const id = demo.active_binding_id!, published = counter(store.subscribe);
    const before = store.getSnapshot().presence[id];
    hint(transport, presence(transport, { execution_state: 'idle', last_seen_at: '2026-10-03T12:01:00.000Z' }));
    expect(published.count).toBe(1);
    expect(store.getSnapshot().presence[id]).not.toBe(before);
    expect(store.getSnapshot().presence[id]!.execution_state).toBe('idle');
    hint(transport, presence(transport, { execution_state: 'idle', last_seen_at: '2026-10-03T12:01:00.000Z' }));
    expect(published.count).toBe(1);
    await store.refresh();
    expect(published.count).toBe(1);
  });

  it('a presence that is not fresh and has not moved is not published again', async () => {
    const { store, transport } = sessionStore();
    await store.refresh();
    const id = demo.active_binding_id!, published = counter(store.subscribe);
    const quiet = presence(transport, { freshness: 'stale', last_seen_at: '2026-10-03T12:01:00.000Z' });
    hint(transport, quiet);
    expect(published.count).toBe(1);
    const held = store.getSnapshot().presence[id];
    hint(transport, { ...quiet }); hint(transport, { ...quiet });
    expect(published.count).toBe(1);
    expect(store.getSnapshot().presence[id]).toBe(held);
  });
});

describe('WaitingStore publishes only real changes (F6b)', () => {
  async function waiting() {
    const transport = new Transport(), service = createDesktopService(transport), opened = new OpenSessions(service);
    const store = new WaitingStore(service, opened);
    closers.push(() => { store.stop(); opened.closeAll(); });
    await store.refresh();
    return { transport, store, opened };
  }
  it('an unchanged poll publishes nothing and keeps the state, rows and sessions', async () => {
    const { store } = await waiting();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    expect(first.sessions.length).toBeGreaterThan(0); expect(first.status).toBe('ready');
    await store.refresh(); await store.refresh();
    expect(published.count).toBe(0);
    const now = store.getSnapshot();
    expect(now).toBe(first);
    expect(now.waiting).toBe(first.waiting); expect(now.sent).toBe(first.sent); expect(now.sessions).toBe(first.sessions);
    expect(now.counts).toBe(first.counts); expect(now.unavailableProjects).toBe(first.unavailableProjects);
  });

  it('a captured session change still forwards one publish, with the rows left alone', async () => {
    const { store, opened, transport } = await waiting();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    const captured = opened.get(route)!, before = captured.getSnapshot();
    // The session read changes with no hint, so only the forward can tell the waiting store.
    transport.sessions.get(route.session_id)!.revision++;
    await captured.refresh();
    expect(captured.getSnapshot()).not.toBe(before);
    expect(published.count).toBe(1);
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().waiting).toBe(first.waiting); expect(store.getSnapshot().sessions).toBe(first.sessions);
  });

  it('a change in one session keeps the other sessions\' objects', async () => {
    const { store, transport } = await waiting();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    const other = first.sessions.find(entry => entry.session.id === secondId)!;
    const edited = transport.sessions.get(route.session_id)!;
    edited.revision++; edited.items['2']!.question = 'A question that changed';
    await store.refresh();
    expect(published.count).toBeGreaterThan(0);
    const now = store.getSnapshot();
    expect(now.waiting.find(row => row.item.id === '2' && row.route.session_id === route.session_id)!.item.question).toBe('A question that changed');
    expect(now.sessions.find(entry => entry.session.id === secondId)).toBe(other);
    const settled = published.count;
    await store.refresh();
    expect(published.count).toBe(settled);
  });

  it('a failed capture publishes once, a repeat nothing, and the recovery once', async () => {
    const { store, transport } = await waiting();
    const published = counter(store.subscribe);
    const query = transport.invoke.bind(transport);
    const spy = vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'project_list') throw new Error('Read failed');
      return query(name, args);
    });
    await store.refresh();
    expect(published.count).toBe(1); expect(store.getSnapshot()).toMatchObject({ status: 'stale', error: expect.any(ServiceFailure) });
    await store.refresh();
    expect(published.count).toBe(1);
    spy.mockRestore();
    await store.refresh();
    expect(published.count).toBe(2); expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null });
  });
});

describe('NavigationStore publishes only real changes (F6b)', () => {
  async function navigation() {
    const transport = new Transport(), navigation = new NavigationStore(createDesktopService(transport));
    closers.push(() => navigation.stop());
    await navigation.start();
    return { transport, navigation };
  }
  it('an unchanged poll publishes nothing and keeps preferences, projects and sessions', async () => {
    const { navigation: store } = await navigation();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    expect(first.status).toBe('ready'); expect(first.sessions).not.toBeNull();
    await store.refresh(); await store.refresh(); await store.refresh();
    expect(published.count).toBe(0);
    const now = store.getSnapshot();
    expect(now).toBe(first);
    expect(now.preferences).toBe(first.preferences); expect(now.projects).toBe(first.projects); expect(now.sessions).toBe(first.sessions);
  });

  it('a changed session list publishes once and keeps the objects that did not change', async () => {
    const { navigation: store, transport } = await navigation();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    transport.sessions.get(secondId)!.title = 'Renamed session';
    await store.refresh();
    expect(published.count).toBe(1);
    const now = store.getSnapshot();
    expect(now.sessions).not.toBe(first.sessions); expect(now.projects).toBe(first.projects); expect(now.preferences).toBe(first.preferences);
    await store.refresh();
    expect(published.count).toBe(1);
  });

  it('a changed preference publishes once', async () => {
    const { navigation: store, transport } = await navigation();
    const first = store.getSnapshot(), published = counter(store.subscribe);
    transport.preferences.global = { ...transport.preferences.global, pinned: true }; transport.preferences.revision++;
    await store.refresh();
    expect(published.count).toBe(1);
    expect(store.getSnapshot().preferences).not.toBe(first.preferences);
    expect(store.getSnapshot().preferences!.global.pinned).toBe(true);
    expect(store.getSnapshot().projects).toBe(first.projects);
  });

  it('a failed read publishes once, a repeat nothing, and the recovery once', async () => {
    const { navigation: store, transport } = await navigation();
    const published = counter(store.subscribe), query = transport.invoke.bind(transport);
    const spy = vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'preferences_get') throw new Error('Read failed');
      return query(name, args);
    });
    await store.refresh();
    expect(published.count).toBe(1); expect(store.getSnapshot()).toMatchObject({ status: 'stale', error: expect.any(ServiceFailure) });
    await store.refresh();
    expect(published.count).toBe(1);
    spy.mockRestore();
    await store.refresh();
    expect(published.count).toBe(2); expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null });
  });
});
