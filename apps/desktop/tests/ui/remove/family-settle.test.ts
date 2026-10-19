// The continuation-family check while the waiting reader is settling (alpha.21 E34): a reader that is 'stale' or 'loading' with no error is
// waited for (the Remove dialog says "Checking other sessions…" meanwhile). A stale reader that kept a read error (a session changed while
// it was read: it heals on the next read) is asked to read again once; it blocks only if that read still fails. Unavailable sessions and a
// reader that never settles still block. The archived sessions are read once per check.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Immutable } from '../../../src/data/session-store';
import type { RendererService } from '../../../src/data/service';
import type { Session, Topic } from '../../../src/generated/domain/models';
import type { WaitingState } from '../../../src/selectors/waiting/store';
import { NoticeStore } from '../../../src/ui/pages/notices';
import { FAMILY_SETTLE_MS as LIMIT, RemovalQueue } from '../../../src/ui/remove/queue';

const session = demo as unknown as Immutable<Session>;
const T10 = '00000000-0000-4000-8000-000000000010';
const topic = session.topics[T10] as Immutable<Topic>;
const counts = { completeness: 'complete', unavailable_session_ids: [] };
const state = (change: Partial<WaitingState> = {}): WaitingState =>
  ({ status: 'ready', counts, waiting: [], sent: [], sessions: [{ session }], unavailableProjects: [], error: null, ...change }) as unknown as WaitingState;

/** A queue over a scripted waiting reader: `set` publishes a new state to everyone subscribed. */
function setup(first: WaitingState, refreshTo?: WaitingState) {
  let current = first;
  const listeners = new Set<() => void>();
  const set = (next: WaitingState) => { current = next; [...listeners].forEach(listener => listener()); };
  const refresh = vi.fn(async () => { if (refreshTo) set(refreshTo); });
  const query = vi.fn(async () => ({ sessions: { items: [], next_cursor: null, snapshot_revision: 1 }, counts }));
  const queue = new RemovalQueue({ service: { query } as unknown as RendererService, notices: new NoticeStore(), read: async () => session,
    waiting: () => current, subscribeWaiting: receive => { listeners.add(receive); return () => { listeners.delete(receive); }; }, refreshWaiting: refresh });
  return { queue, set, refresh, query, listeners };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('family() while the waiting reader settles', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['stale', 'loading'] as const)('%s at open, ready a moment later: no family, so Remove can be enabled', async status => {
    const { queue, set, refresh, listeners } = setup(state({ status }));
    const result = queue.family(topic, session);
    await settle();
    let done = false; void result.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1500);
    expect(done, 'still checking while the reader is not ready').toBe(false);
    set(state());
    expect(await result).toEqual({ family: false, sessions: [] });
    expect(refresh).not.toHaveBeenCalled();
    expect(listeners.size, 'nothing stays subscribed').toBe(0);
  });

  it.each([
    ['unavailable', state({ status: 'unavailable' })],
    ['stale with an unavailable project', state({ status: 'stale', unavailableProjects: ['p'] as never })],
    ['stale with sessions that cannot be read', state({ status: 'stale', counts: { completeness: 'partial', unavailable_session_ids: ['x'] } as never })],
    ['ready but a session cannot be read', state({ counts: { completeness: 'partial', unavailable_session_ids: ['x'] } as never })],
  ])('%s: blocks at once and never waits', async (_name, reader) => {
    const { queue, refresh } = setup(reader);
    expect(await queue.family(topic, session)).toMatchObject({ family: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  const failed = () => state({ status: 'stale', error: new Error('read failed') as never });

  it('stale with a kept read error: the reader is asked to read again at once, and the fresh read decides', async () => {
    const { queue, refresh } = setup(failed(), state());
    expect(await queue.family(topic, session)).toEqual({ family: false, sessions: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stale with a kept read error that the fresh read repeats: blocked after one refresh, without waiting out the limit', async () => {
    const { queue, refresh } = setup(failed(), failed());
    expect(await queue.family(topic, session)).toMatchObject({ family: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stale with a kept read error and a refresh that never returns: blocked after the limit', async () => {
    const { queue, refresh } = setup(failed());
    refresh.mockImplementation(() => new Promise<void>(() => {}));
    const result = queue.family(topic, session);
    await vi.advanceTimersByTimeAsync(LIMIT - 1);
    let done = false; void result.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ family: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('an error that arrives while waiting is read again once, then decides', async () => {
    const { queue, set, refresh } = setup(state({ status: 'stale' }), failed());
    const result = queue.family(topic, session);
    await settle();
    set(failed());
    expect(await result).toMatchObject({ family: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('never settling: after the limit the reader is refreshed once; still not ready: blocked with the current text', async () => {
    const { queue, refresh } = setup(state({ status: 'stale' }));
    const result = queue.family(topic, session);
    await vi.advanceTimersByTimeAsync(LIMIT - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(await result).toMatchObject({ family: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('the refresh settles it: the check decides on the refreshed state', async () => {
    const { queue, refresh } = setup(state({ status: 'stale' }), state());
    const result = queue.family(topic, session);
    await vi.advanceTimersByTimeAsync(LIMIT);
    expect(await result).toEqual({ family: false, sessions: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reads the archived sessions once per check, however often the reader publishes', async () => {
    const { queue, set, query } = setup(state({ status: 'stale' }));
    const result = queue.family(topic, session);
    await settle();
    set(state({ status: 'stale' })); set(state({ status: 'loading' })); set(state({ status: 'stale' }));
    const listCalls = () => (query.mock.calls as unknown as readonly (readonly [{ request: { command: string } }])[]).filter(call => call[0].request.command === 'session_list').length;
    expect(listCalls()).toBe(1);
    set(state());
    await result;
    expect(listCalls()).toBe(1);
  });

  it('a reader that is already ready decides at once', async () => {
    const { queue } = setup(state());
    expect(await queue.family(topic, session)).toEqual({ family: false, sessions: [] });
  });
});
