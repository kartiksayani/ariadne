import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopService, CoreFailure } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActions } from '../../../src/components/bindings/actions';
import { useDispatch } from '../../../src/components/bindings/DispatchChip';
import { DraftConflictNotices } from '../../../src/components/edge-states/DraftConflictNotices';
import { ActionFailure } from '../../../src/components/edge-states/EdgeState';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { NoticeStore, Notices, notices } from '../../../src/ui/pages/notices';
import { conflictNotice, updatedText } from '../../../src/ui/shared/conflictNotice';
import { AppTransport, route, secondId } from '../app/transport';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(store => store.closeAll()); notices.clear(); vi.useRealTimers(); });
const conflict = () => new CoreFailure({ code: 'revision_conflict', message: 'View changed', hint: '', retryable: true, field_errors: [] });
const secondRoute = { ...route, session_id: secondId };

async function failedDraft() {
  const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
  opened.push(sessions);
  const store = sessions.open(route), drafts = new OwnerDraftStore(service);
  await Promise.all([store.refresh(), drafts.load()]);
  const id = drafts.begin(store.getSnapshot().snapshot!.session, '1.1', 'reply')!;
  await drafts.editSaved(id, { text: 'Keep this draft.' });
  const invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'input_submit') return { api_version: 1, ok: false, error: conflict().error };
    return invoke(name, args);
  });
  expect(await drafts.submit(id)).toBe(false);
  return { transport, service, sessions, store, drafts, id };
}

function DispatchFailure({ actions, label = 'Pause here' }: { readonly actions: SessionActions; readonly label?: string }) {
  const control = useDispatch(actions);
  return <><button onClick={() => { void control.pause(); }}>{label}</button><span>{control.error}</span></>;
}

describe('conflict notices', () => {
  it('automatically refreshes a stale view and reports only the confirmed update', async () => {
    const store = new NoticeStore(), refresh = vi.fn(async () => true);
    await conflictNotice(conflict(), { id: 'changed', draftAtRisk: false, refresh, store });
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual([expect.objectContaining({ text: updatedText })]);
    expect(store.getSnapshot()[0]!.actions).toBeUndefined();
    store.clear();
  });

  it('keeps Refresh when the automatic read fails, without claiming the view updated', async () => {
    const store = new NoticeStore(), refresh = vi.fn(async () => false);
    await conflictNotice(conflict(), { id: 'changed', draftAtRisk: false, refresh, store });
    expect(store.getSnapshot()[0]!.actions?.[0]?.label).toBe('Refresh');
    expect(store.getSnapshot()[0]!.text).not.toBe(updatedText);
    store.clear();
  });

  it('does not refresh input involved in a conflict until the owner asks', async () => {
    const store = new NoticeStore(), refresh = vi.fn(async () => true);
    await conflictNotice(conflict(), { id: 'changed', draftAtRisk: true, refresh, store });
    expect(refresh).not.toHaveBeenCalled();
    expect(store.getSnapshot()[0]!.text).toContain('Your text is kept.');
    store.getSnapshot()[0]!.actions![0]!.run();
    await waitFor(() => expect(store.getSnapshot()).toEqual([]));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('drops a completed refresh after the caller has left the affected view', async () => {
    const store = new NoticeStore();
    let finish!: (value: boolean) => void;
    let current = true;
    const completion = conflictNotice(conflict(), { id: 'changed', draftAtRisk: false, store,
      isCurrent: () => current, refresh: () => new Promise(resolve => { finish = resolve; }) });
    current = false;
    finish(true);
    await completion;
    expect(store.getSnapshot()).toEqual([]);
  });

  it('keeps a newer conflict when an older Refresh finishes', async () => {
    const store = new NoticeStore();
    let finish!: (value: boolean) => void;
    await conflictNotice(conflict(), { id: 'changed', draftAtRisk: true, store,
      refresh: () => new Promise(resolve => { finish = resolve; }) });
    store.getSnapshot()[0]!.actions![0]!.run();
    await conflictNotice(conflict(), { id: 'changed', draftAtRisk: true, store, refresh: async () => false });
    const replacement = store.getSnapshot()[0];
    finish(true);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual([replacement]);
    store.clear();
  });

  it('refreshes a rejected session action without retrying the write', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const invoke = transport.invoke.bind(transport);
    const spy = vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'binding_pause') {
        ++transport.sessions.get(route.session_id)!.revision;
        return { api_version: 1, ok: false, error: conflict().error };
      }
      return invoke(name, args);
    });
    const actions = new SessionActions(service, store), session = store.getSnapshot().snapshot!.session;
    const binding = session.bindings[session.active_binding_id!]!;
    const read = vi.spyOn(store, 'refresh');
    const saved = await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision);
    expect(saved).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    expect(actions.getSnapshot().pending).toBeNull();
    const failure = render(<ActionFailure actions={actions} />);
    expect(failure.container.textContent).toBe('');
    expect(notices.getSnapshot()[0]!.text).toContain(updatedText);
    expect(notices.getSnapshot()[0]!.text).toContain('session');
    expect(store.getSnapshot().snapshot!.session.revision).toBe(session.revision + 1);
    expect(spy.mock.calls.filter(([, args]) => 'command' in args.request && args.request.command.command === 'binding_pause')).toHaveLength(1);
  });

  it('retains every draft byte and exact failed send when Refresh is clicked', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route), drafts = new OwnerDraftStore(service);
    await Promise.all([store.refresh(), drafts.load()]);
    const text = '  Keep these words.\nAnd this next line.  ';
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '1.1', 'reply')!;
    drafts.edit(id, { text });
    const invoke = transport.invoke.bind(transport);
    let writes = 0;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') {
        ++writes;
        return { api_version: 1, ok: false, error: conflict().error };
      }
      return invoke(name, args);
    });
    vi.useFakeTimers();
    render(<><DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={route} /><Notices />
      <ItemDetail store={store} drafts={drafts} itemId="1.1" later={false} onOpenItem={vi.fn()} /></>);
    await act(async () => { expect(await drafts.submit(id)).toBe(false); });
    const entry = drafts.getSnapshot().entries[id]!, read = vi.spyOn(store, 'refresh');
    expect(read).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(read).toHaveBeenCalledOnce();
    expect(drafts.getSnapshot().entries[id]).toEqual(entry);
    expect(drafts.getSnapshot().entries[id]!.draft.text).toBe(text);
    expect(screen.getByRole('textbox', { name: 'Reply message' }).getAttribute('disabled')).not.toBeNull();
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(text);
    expect(writes).toBe(1);
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('does not reopen a closed tab to report a retained draft conflict', async () => {
    const { sessions, drafts, id } = await failedDraft();
    sessions.close(route);
    const open = vi.spyOn(sessions, 'open'), entry = drafts.getSnapshot().entries[id];
    render(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={route} />);
    expect(open).not.toHaveBeenCalled();
    expect(sessions.get(route)).toBeUndefined();
    expect(notices.getSnapshot()).toEqual([]);
    expect(drafts.getSnapshot().entries[id]).toEqual(entry);
  });

  it('dismisses a draft notice as soon as its reader closes', async () => {
    const { sessions, drafts } = await failedDraft();
    render(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={route} />);
    expect(notices.getSnapshot()).toHaveLength(1);
    act(() => { sessions.close(route); });
    expect(notices.getSnapshot()).toEqual([]);
    expect(sessions.get(route)).toBeUndefined();
  });

  it('dismisses draft notices on navigation and disables their old Refresh callbacks', async () => {
    const { sessions, store, drafts } = await failedDraft();
    const second = sessions.open(secondRoute); await second.refresh();
    const view = render(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={route} />);
    const refresh = notices.getSnapshot()[0]!.actions![0]!, read = vi.spyOn(store, 'refresh'), otherRead = vi.spyOn(second, 'refresh');
    view.rerender(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={secondRoute} />);
    expect(notices.getSnapshot()).toEqual([]);
    await act(async () => { refresh.run(); });
    expect(read).not.toHaveBeenCalled();
    expect(otherRead).not.toHaveBeenCalled();
  });

  it('does not report a late draft conflict after navigation to another session', async () => {
    const { sessions, drafts, service, id } = await failedDraft();
    const view = render(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={route} />);
    let reject!: (error: unknown) => void;
    vi.spyOn(service, 'executeOwner').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    let completion!: Promise<boolean>;
    act(() => { completion = drafts.submit(id); });
    expect(notices.getSnapshot()).toEqual([]);
    view.rerender(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={secondRoute} />);
    await act(async () => { reject(conflict()); expect(await completion).toBe(false); });
    expect(notices.getSnapshot()).toEqual([]);
    expect(drafts.getSnapshot().entries[id]!.draft.text).toBe('Keep this draft.');
  });

  it('keeps Refresh bound to the same reader across unrelated draft changes', async () => {
    const { sessions, store, drafts } = await failedDraft();
    const second = sessions.open(secondRoute); await second.refresh();
    render(<DraftConflictNotices drafts={drafts} opened={sessions} selectedSession={route} />);
    const notice = notices.getSnapshot()[0]!, read = vi.spyOn(store, 'refresh'), otherRead = vi.spyOn(second, 'refresh');
    act(() => { drafts.begin(store.getSnapshot().snapshot!.session, '1.1', 'note'); });
    expect(notices.getSnapshot()[0]).toBe(notice);
    await act(async () => { notice.actions![0]!.run(); });
    expect(read).toHaveBeenCalledOnce();
    expect(otherRead).not.toHaveBeenCalled();
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('names a persisted session action conflict and refreshes that session after navigation', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    transport.sessions.get(route.session_id)!.name = 'Original work';
    transport.sessions.get(secondId)!.name = 'Other work';
    const store = sessions.open(route), other = sessions.open(secondRoute);
    await Promise.all([store.refresh(), other.refresh()]);
    const actions = new SessionActions(service, store), otherActions = new SessionActions(service, other);
    const invoke = transport.invoke.bind(transport);
    let unavailable = true, writes = 0;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'binding_pause') {
        ++writes;
        return { api_version: 1, ok: false, error: conflict().error };
      }
      if (name === 'session_get' && args.request.session?.session_id === route.session_id && unavailable) {
        return { api_version: 1, ok: false, error: { ...conflict().error, code: 'io_error' } };
      }
      return invoke(name, args);
    });
    const view = render(<ActionFailure actions={actions} />), session = store.getSnapshot().snapshot!.session;
    const binding = session.bindings[session.active_binding_id!]!;
    await act(async () => { await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision); });
    view.rerender(<ActionFailure actions={otherActions} />);
    const notice = notices.getSnapshot()[0]!;
    expect(notice.text).toContain('the “Original work” session');
    expect(notice.text).not.toContain('Other work');
    const read = vi.spyOn(store, 'refresh'), otherRead = vi.spyOn(other, 'refresh');
    unavailable = false;
    await act(async () => { notice.actions![0]!.run(); });
    expect(read).toHaveBeenCalledOnce();
    expect(otherRead).not.toHaveBeenCalled();
    expect(writes).toBe(1);
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('drops an action conflict whose automatic refresh finishes after the tab closes', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActions(service, store), session = store.getSnapshot().snapshot!.session;
    const binding = session.bindings[session.active_binding_id!]!;
    vi.spyOn(service, 'executeOwner').mockRejectedValue(conflict());
    let finish!: () => void;
    const read = vi.spyOn(store, 'refresh').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const completion = actions.execute({ command: 'binding_pause', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    sessions.close(route);
    finish();
    expect(await completion).toBe(false);
    expect(notices.getSnapshot()).toEqual([]);
    expect(sessions.get(route)).toBeUndefined();
  });

  it('updates an already visible action conflict without hiding it for another display delay', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActions(service, store), session = store.getSnapshot().snapshot!.session;
    const binding = session.bindings[session.active_binding_id!]!;
    const command = { command: 'binding_pause' as const, api_version: 1 as const, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } };
    vi.spyOn(service, 'executeOwner').mockRejectedValue(conflict());
    vi.useFakeTimers();
    render(<Notices />);
    await act(async () => { await actions.execute(command, session.revision); await vi.advanceTimersByTimeAsync(300); });
    const card = document.querySelector('[data-notice-id^="action-conflict:"]');
    expect(card).not.toBeNull();
    let finish!: () => void;
    const read = vi.spyOn(store, 'refresh').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let completion!: Promise<boolean>;
    await act(async () => { completion = actions.execute(command, session.revision); });
    expect(read).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-notice-id^="action-conflict:"]')).toBe(card);
    await act(async () => { finish(); await completion; });
    expect(document.querySelector('[data-notice-id^="action-conflict:"]')).toBe(card);
    expect(notices.getVisibleSnapshot()).toHaveLength(1);
  });

  it('releases the action notice reader subscription when the owner dismisses its toast', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActions(service, store), session = store.getSnapshot().snapshot!.session;
    const binding = session.bindings[session.active_binding_id!]!;
    vi.spyOn(service, 'executeOwner').mockRejectedValue(conflict());
    const subscribe = store.subscribe, unsubscribe = vi.fn();
    vi.spyOn(store, 'subscribe').mockImplementation(listener => {
      const release = subscribe(listener);
      return () => { release(); unsubscribe(); };
    });
    await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision);
    expect(unsubscribe).not.toHaveBeenCalled();
    notices.dismiss(notices.getSnapshot()[0]!.id);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('ignores the old action Refresh after a tab closes and its controller attaches a new reader', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActions(service, store), session = store.getSnapshot().snapshot!.session;
    const binding = session.bindings[session.active_binding_id!]!;
    vi.spyOn(service, 'executeOwner').mockRejectedValue(conflict());
    const invoke = transport.invoke.bind(transport);
    const failedRead = vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') return { api_version: 1, ok: false, error: { ...conflict().error, code: 'io_error' } };
      return invoke(name, args);
    });
    await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, session.revision);
    const refresh = notices.getSnapshot()[0]!.actions![0]!;
    sessions.close(route);
    failedRead.mockRestore();
    const replacement = sessions.open(route); await replacement.refresh();
    actions.attachSession(replacement);
    const read = vi.spyOn(store, 'refresh'), replacementRead = vi.spyOn(replacement, 'refresh');
    await act(async () => { refresh.run(); });
    expect(read).not.toHaveBeenCalled();
    expect(replacementRead).not.toHaveBeenCalled();
    expect(notices.getSnapshot()).toEqual([]);
  });

  it.each(['navigate', 'close', 'unmount'] as const)('drops a late dispatch failure after %s', async leave => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route), other = sessions.open(secondRoute);
    await Promise.all([store.refresh(), other.refresh()]);
    const actions = new SessionActions(service, store), otherActions = new SessionActions(service, other);
    let finish!: (value: boolean) => void;
    vi.spyOn(actions, 'execute').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<DispatchFailure actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause here' }));
    if (leave === 'navigate') view.rerender(<DispatchFailure actions={otherActions} />);
    if (leave === 'close') act(() => { sessions.close(route); });
    if (leave === 'unmount') view.unmount();
    await act(async () => { finish(false); });
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText('Pausing didn’t go through. Try again.')).toBeNull();
  });

  it('dismisses an existing dispatch failure when its view is left', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActions(service, store);
    vi.spyOn(actions, 'execute').mockResolvedValue(false);
    const view = render(<DispatchFailure actions={actions} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause here' })); });
    expect(notices.getSnapshot()).toHaveLength(1);
    view.unmount();
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('keeps the active dispatch notice when another consumer of the same session unmounts', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActions(service, store);
    vi.spyOn(actions, 'execute').mockResolvedValue(false);
    const view = render(<><DispatchFailure key="active" actions={actions} label="Active dispatch" />
      <DispatchFailure key="passive" actions={actions} label="Passive dispatch" /></>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Active dispatch' })); });
    const notice = notices.getSnapshot()[0]!;
    view.rerender(<><DispatchFailure key="active" actions={actions} label="Active dispatch" /></>);
    expect(notices.getSnapshot()).toEqual([notice]);
    view.unmount();
    expect(notices.getSnapshot()).toEqual([]);
  });
});
