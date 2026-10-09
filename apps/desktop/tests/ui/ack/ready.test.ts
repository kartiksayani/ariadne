import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopService, CoreFailure } from '../../../src/data/service';
import { SessionStore } from '../../../src/data/session-store';
import { SessionActions } from '../../../src/components/bindings/actions';
import { acknowledge, ackFailure } from '../../../src/ui/shared/ack';
import { AppTransport, route } from '../app/transport';

const stores: SessionStore[] = [];
afterEach(() => { stores.forEach(store => store.close()); stores.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); });
async function ready() {
  const transport = new AppTransport(), service = createDesktopService(transport);
  transport.sessions.get(route.session_id)!.items['1.1']!.ack_to = 'done';
  const store = new SessionStore(service, route); stores.push(store); await store.refresh();
  const state = store.getSnapshot();
  vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...state, status: 'stale' });
  return { transport, store, state, actions: new SessionActions(service, store) };
}

it('reports a bounded stale Ack wait and never saves when the delayed refresh finishes after timeout', async () => {
  const { transport, store, state, actions } = await ready();
  vi.useFakeTimers();
  let release!: () => void;
  vi.spyOn(store, 'refresh').mockImplementation(() => new Promise<void>(resolve => { release = () => {
    vi.mocked(store.getSnapshot).mockReturnValue(state); resolve();
  }; }));
  const attempt = acknowledge(actions, '1.1').catch(ackFailure);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await attempt).toBe("Ariadne is still loading this session's latest changes. Try again.");
  release(); await Promise.resolve();
  expect(transport.mutations).toHaveLength(0);
});

it('rechecks Ack eligibility after refresh and reports a question that now needs answering', async () => {
  const { transport, store, state, actions } = await ready();
  vi.spyOn(store, 'refresh').mockImplementation(async () => {
    const snapshot = structuredClone(state.snapshot)!;
    vi.mocked(store.getSnapshot).mockReturnValue({ ...state, snapshot: { ...snapshot, session: { ...snapshot.session, items: { ...snapshot.session.items, '1.1': { ...snapshot.session.items['1.1']!, ask: 'Should these limits change?' } } } } });
  });
  expect(await acknowledge(actions, '1.1').catch(ackFailure)).toContain('any question waiting for you');
  expect(transport.mutations).toHaveLength(0);
});

it('refuses Ack plainly when a stale refresh reveals the session was archived', async () => {
  const { transport, store, state, actions } = await ready();
  vi.spyOn(store, 'refresh').mockImplementation(async () => {
    const snapshot = state.snapshot!;
    vi.mocked(store.getSnapshot).mockReturnValue({ ...state, snapshot: { ...snapshot,
      session: { ...snapshot.session, state: 'closed', archived_at: snapshot.session.updated_at } } });
  });
  expect(await acknowledge(actions, '1.1').catch(ackFailure)).toBe('This session is archived. Restore it, then reopen it to acknowledge this item.');
  expect(transport.mutations).toHaveLength(0);
});

it('preserves the plain archive refusal when Core rejects an Ack that raced with archive', () => {
  const message = 'This session is archived. Restore it, then reopen it to acknowledge this item.';
  expect(ackFailure(new CoreFailure({ code: 'invalid_transition', message, hint: 'Restore and reopen this session.', retryable: false, field_errors: [] }))).toBe(message);
});

it('abandons a stale Ack click when its selection changes before refresh returns', async () => {
  const { transport, store, state, actions } = await ready();
  let cancelled = false, release!: () => void;
  vi.spyOn(store, 'refresh').mockImplementation(() => new Promise<void>(resolve => { release = () => {
    vi.mocked(store.getSnapshot).mockReturnValue(state); resolve();
  }; }));
  const attempt = acknowledge(actions, '1.1', () => cancelled);
  cancelled = true; release();
  expect(await attempt).toBe(false);
  expect(transport.mutations).toHaveLength(0);
});


it.each(['ack_to', 'question', 'ask', 'outcome', 'why'] as const)('requires a fresh Ack click when %s changed during refresh', async field => {
  const { transport, store, state, actions } = await ready();
  vi.spyOn(store, 'refresh').mockImplementation(async () => {
    const snapshot = state.snapshot!, item = snapshot.session.items['1.1']!;
    const revised = { ...item, [field]: field === 'ack_to' ? 'dropped' as const : 'A new proposal to read.' };
    // A newly answered ask remains eligible, but its changed words still require reading.
    if (field === 'ask') revised.ask = '';
    vi.mocked(store.getSnapshot).mockReturnValue({ ...state, snapshot: { ...snapshot, session: { ...snapshot.session, items: { ...snapshot.session.items, '1.1': revised } } } });
  });
  expect(await acknowledge(actions, '1.1').catch(ackFailure)).toBe('This item changed. Read its current proposal, then try Ack again.');
  expect(transport.mutations).toHaveLength(0);
});

it('allows a new click to report its own readiness failure after the previous selection was abandoned', async () => {
  const { transport, store, actions } = await ready();
  vi.useFakeTimers();
  vi.spyOn(store, 'refresh').mockImplementation(() => new Promise<void>(() => {}));
  let cancelled = false;
  const first = acknowledge(actions, '1.1', () => cancelled);
  cancelled = true;
  const second = acknowledge(actions, '1.1').catch(ackFailure);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await first).toBe(false);
  expect(await second).toBe("Ariadne is still loading this session's latest changes. Try again.");
  expect(transport.mutations).toHaveLength(0);
});

it('explains an uncertain save that appeared while Ack waited for the ready session', async () => {
  const { transport, store, state, actions } = await ready();
  const action = actions.getSnapshot();
  vi.spyOn(store, 'refresh').mockImplementation(async () => {
    vi.mocked(store.getSnapshot).mockReturnValue(state);
    vi.spyOn(actions, 'getSnapshot').mockReturnValue({ ...action, pending: { session: route, command: {
      command: 'session_label_set', api_version: 1, op_id: crypto.randomUUID(), params: { name: 'Earlier name', description: null },
    } } });
  });
  expect(await acknowledge(actions, '1.1').catch(ackFailure))
    .toBe('Ariadne isn’t sure your last change was saved. Check again before trying Ack.');
  expect(transport.mutations).toHaveLength(0);
});
