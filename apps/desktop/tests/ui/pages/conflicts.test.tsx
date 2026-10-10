import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopService, CoreFailure } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { SessionActions } from '../../../src/components/bindings/actions';
import { DraftConflictNotices } from '../../../src/components/edge-states/DraftConflictNotices';
import { ActionFailure } from '../../../src/components/edge-states/EdgeState';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { NoticeStore, Notices, notices } from '../../../src/ui/pages/notices';
import { conflictNotice, updatedText } from '../../../src/ui/shared/conflictNotice';
import { AppTransport, route } from '../app/transport';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(store => store.closeAll()); notices.clear(); vi.useRealTimers(); });
const conflict = () => new CoreFailure({ code: 'revision_conflict', message: 'View changed', hint: '', retryable: true, field_errors: [] });

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
    expect(notices.getSnapshot()[0]!.text).toBe(updatedText);
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
    render(<><DraftConflictNotices drafts={drafts} opened={sessions} /><Notices />
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
});
