// The session lifecycle (C3) as the workspace shares it. The table:
//
// | Control         | Session now | Result                                             |
// |-----------------|-------------|----------------------------------------------------|
// | Close           | active      | the Close review                                   |
// | Close           | archived    | nothing sent; "archived meanwhile" (never restore) |
// | Reopen          | active      | nothing sent; no review; "open now"                |
// | Restore         | archived    | session_restore at once                            |
// | Copy, then Copy | any         | only the latest copy reports                       |
//
// One owner: two views reading the owner's instance show one review dialog, and both see it open.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { SessionActionControllers, type SessionActions } from '../../../src/components/bindings/actions';
import { SessionLifecycleOwner, useSessionLifecycleFor } from '../../../src/ui/shared/SessionLifecycleOwner';
import type { SessionLifecycle } from '../../../src/ui/shared/useSessionLifecycle';
import { notices } from '../../../src/ui/pages/notices';
import { copyText } from '../../../src/ui/shared/clipboard';
import { AppTransport, route } from '../app/transport';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
const navigations: NavigationStore[] = [];
afterEach(() => { cleanup(); notices.clear(); navigations.splice(0).forEach(navigation => navigation.stop()); vi.resetAllMocks(); });

async function setup(archived = false) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  if (archived) { session.state = 'closed'; session.closed_at = session.updated_at; session.archived_at = session.updated_at; }
  const service = createDesktopService(transport), navigation = new NavigationStore(service);
  navigations.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route); await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store);
  return { transport, actions };
}
const sent = (transport: AppTransport) => transport.mutations.map(request => request.command.command).filter(command => command !== 'preferences_patch');

/** A view that reads the lifecycle and hands it to the test. */
function View({ actions, name, onLifecycle }: { actions: SessionActions; name: string; onLifecycle: (lifecycle: SessionLifecycle) => void }) {
  const lifecycle = useSessionLifecycleFor(actions);
  onLifecycle(lifecycle);
  return <section aria-label={name} data-reviewing={lifecycle.reviewing}>{lifecycle.dialog}</section>;
}
function owned(actions: SessionActions) {
  const seen: Record<string, SessionLifecycle> = {};
  render(<SessionLifecycleOwner actions={actions}>
    <View actions={actions} name="Top bar" onLifecycle={lifecycle => { seen.bar = lifecycle; }} />
    <View actions={actions} name="Map" onLifecycle={lifecycle => { seen.map = lifecycle; }} />
  </SessionLifecycleOwner>);
  return seen;
}

describe('session lifecycle controls act only on the standing they were offered for', () => {
  it('Close on an active session opens the Close review', async () => {
    const { actions } = await setup(), seen = owned(actions);
    await act(async () => { seen.bar!.close(); });
    expect(await screen.findByRole('dialog', { name: /^Close / })).toBeTruthy();
  });

  it('Close on a session archived meanwhile sends nothing and never restores it', async () => {
    const { transport, actions } = await setup(true), seen = owned(actions);
    await act(async () => { seen.bar!.close(); });
    await waitFor(() => expect(seen.bar!.error).toBe('This session was archived meanwhile. Nothing changed.'));
    expect(sent(transport)).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Reopen on an active session sends nothing and opens no review', async () => {
    const { transport, actions } = await setup(), seen = owned(actions);
    await act(async () => { seen.bar!.reopen(); });
    await waitFor(() => expect(seen.bar!.error).toBe('This session is open now. Nothing changed.'));
    expect(sent(transport)).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Restore on an archived session restores it at once', async () => {
    const { transport, actions } = await setup(true), seen = owned(actions);
    await act(async () => { seen.bar!.restoreSession(); });
    await waitFor(() => expect(sent(transport)).toEqual(['session_restore']));
  });
});

describe('one lifecycle owner per screen', () => {
  it('the top bar and the Map share one review: one dialog, both see it open, and either side closes it', async () => {
    const { actions } = await setup(), seen = owned(actions);
    await act(async () => { seen.bar!.close(); });
    await screen.findByRole('dialog', { name: /^Close / });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Top bar' }).getAttribute('data-reviewing')).toBe('true');
    expect(screen.getByRole('region', { name: 'Map' }).getAttribute('data-reviewing')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('region', { name: 'Map' }).getAttribute('data-reviewing')).toBe('false');
  });

  it('a view outside any owner keeps its own instance, with its dialog', async () => {
    const { actions } = await setup();
    let lifecycle: SessionLifecycle | undefined;
    render(<View actions={actions} name="Alone" onLifecycle={value => { lifecycle = value; }} />);
    await act(async () => { lifecycle!.close(); });
    expect(await screen.findByRole('dialog', { name: /^Close / })).toBeTruthy();
  });
});

describe('copy session ID', () => {
  it('reports only the latest copy: a slower earlier copy says nothing', async () => {
    const { actions } = await setup(), seen = owned(actions);
    let first!: () => void;
    vi.mocked(copyText).mockReturnValueOnce(new Promise<void>(resolve => { first = resolve; })).mockResolvedValueOnce(undefined);
    act(() => { seen.bar!.copySessionId(); });
    await act(async () => { seen.bar!.copySessionId(); });
    await act(async () => { first(); });
    expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Connection reference copied.']);
  });
});
