// useSessionLifecycle (contract C3): the names the top bar uses are today's actions, unchanged, plus the session's
// lifecycle state and a copy of its connection reference. history-actions/actions.test.tsx pins the actions themselves.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { useSessionLifecycle, type SessionLifecycle } from '../../../src/ui/shared/useSessionLifecycle';
import { notices } from '../../../src/ui/pages/notices';
import { copyText } from '../../../src/ui/shared/clipboard';
import { route } from '../app/transport';
import { HistoryTransport } from '../history-actions/fixture';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); notices.clear(); vi.resetAllMocks(); opened.splice(0).forEach(sessions => sessions.closeAll()); });

async function setup(change?: (transport: HistoryTransport) => void) {
  const transport = new HistoryTransport();
  change?.(transport);
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store);
  return { transport, hook: renderHook(() => useSessionLifecycle(actions)) };
}

describe('session lifecycle names', () => {
  // Close, Reopen and Restore are the session action held to the standing each is offered for; the guard itself is
  // pinned in session-lifecycle-owner.test.tsx.
  it('runs topic actions through archive and restore', async () => {
    const lifecycle = (await setup()).hook.result.current;
    expect(lifecycle.archiveTopic).toBe(lifecycle.archive);
    expect(lifecycle.restoreTopic).toBe(lifecycle.restore);
  });
  it.each([
    ['Close', 'active', (lifecycle: SessionLifecycle) => lifecycle.close, undefined],
    ['Reopen', 'closed', (lifecycle: SessionLifecycle) => lifecycle.reopen, (transport: HistoryTransport) => { transport.source.state = 'closed'; }],
  ] as const)('%s on a %s session opens the session action’s review, as the toggle does', async (_name, _state, pick, change) => {
    const { result } = (await setup(change)).hook;
    await act(async () => { pick(result.current)(); });
    expect(result.current.reviewing).toBe(true);
    const toggled = (await setup(change)).hook;
    await act(async () => { toggled.result.current.session(); });
    expect(toggled.result.current.reviewing).toBe(true);
  });
  it.each([
    ['active', () => {}],
    ['closed', (transport: HistoryTransport) => { transport.source.state = 'closed'; }],
    ['archived', (transport: HistoryTransport) => { transport.source.state = 'closed'; transport.source.archived_at = transport.source.created_at; }],
  ] as const)('reports a %s session', async (state, change) => {
    const { result } = (await setup(change)).hook;
    expect(result.current.state).toBe(state);
  });
  it('copies the session id and says so', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const { result } = (await setup()).hook;
    await act(async () => { result.current.copySessionId(); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
    expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Connection reference copied.']);
  });
  it('says when the copy fails', async () => {
    vi.mocked(copyText).mockRejectedValue(new Error('denied'));
    const { result } = (await setup()).hook;
    await act(async () => { result.current.copySessionId(); });
    expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Copy failed. Try again.']);
  });
});
