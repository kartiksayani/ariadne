import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { AnswerSlot } from '../../../src/ui/detail/AnswerSlot';
import { AppTransport, route } from '../app/transport';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
const loadingError = "Ariadne is still loading this session's latest changes. Try again.";
const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');

async function setup() {
  const transport = new AppTransport(), service = createDesktopService(transport);
  const store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
  stores.push(store);
  await Promise.all([store.refresh(), drafts.load()]);
  return { transport, store, drafts };
}

describe('detail actions while the owner view is stale', () => {
  it.each(['click', 'key'] as const)('explains a stale reopen by %s and requires a new action after refreshing', async trigger => {
    const { transport, store, drafts } = await setup();
    const props = { store, drafts, itemId: '1', later: false, onOpenItem: vi.fn() };
    const view = render(<ItemDetail {...props} />);
    const reopen = screen.getByRole<HTMLButtonElement>('button', { name: 'Back to Open' });
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') await gate;
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(store.getSnapshot().status).toBe('stale');
    if (trigger === 'click') {
      expect(reopen.disabled).toBe(false);
      fireEvent.click(reopen);
    } else view.rerender(<ItemDetail {...props} focusRequest={{ token: 1, intent: 'reopen' }} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', loadingError);
    expect(sends(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    expect(sends(transport)).toHaveLength(0);
    if (trigger === 'click') fireEvent.click(reopen);
    else view.rerender(<ItemDetail {...props} focusRequest={{ token: 2, intent: 'reopen' }} />);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'reopen', target: { item_id: '1' } } } });
  });

  it('does not replay a stale reopen after navigation to a different item', async () => {
    const { transport, store, drafts } = await setup();
    const props = { store, drafts, itemId: '1', later: false, onOpenItem: vi.fn() };
    const view = render(<ItemDetail {...props} />);
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') await gate;
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Open' }));
    await screen.findByText(loadingError);
    view.rerender(<ItemDetail {...props} itemId="5" />);
    await act(async () => { release(); });
    await waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    expect(screen.queryByText(loadingError)).toBeNull();
    expect(sends(transport)).toHaveLength(0);
    expect(drafts.find(route, '1', 'reopen')).toBeUndefined();
  });

  it('explains a numeric shortcut blocked after its request was queued and keeps the note', async () => {
    const { transport, store, drafts } = await setup();
    const live = transport.sessions.get(route.session_id)!;
    live.items['2']!.options = [{ id: 'choice', label: 'Keep it', consequence: 'Keep this choice.', recommended: true }];
    ++live.revision;
    await store.refresh();
    const session = store.getSnapshot().snapshot!.session, item = session.items['2']!;
    const id = drafts.begin(session, item.id, 'answer')!;
    drafts.edit(id, { text: 'Keep my exact note.' });
    render(<AnswerSlot store={store} drafts={drafts} itemId={item.id} blocked="The agent is reconnecting. Try again shortly."
      onEscape={vi.fn()} focusRequest={{ token: 1, intent: 'answer', sendOption: true, optionIndex: 0,
        answerTarget: { optionId: item.options[0]!.id, revision: item.revision, questionRevision: item.question_revision, bindingId: session.active_binding_id } }} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The agent is reconnecting. Try again shortly.');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe('Keep my exact note.');
    expect(sends(transport)).toHaveLength(0);
  });

  it('explains queued numeric requests overtaken by a save and never submits twice', async () => {
    const { transport, store, drafts } = await setup();
    const live = transport.sessions.get(route.session_id)!;
    live.items['2']!.options = [{ id: 'choice', label: 'Keep it', consequence: 'Keep this choice.', recommended: true }];
    ++live.revision;
    await store.refresh();
    const session = store.getSnapshot().snapshot!.session, item = session.items['2']!;
    const id = drafts.begin(session, item.id, 'answer')!;
    drafts.edit(id, { text: 'Keep my exact note.' });
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { entered = true; await gate; }
      return invoke(name, args);
    });
    const saving = drafts.submit(id);
    await waitFor(() => expect(entered).toBe(true));
    const props = { store, drafts, itemId: item.id, onEscape: vi.fn() };
    const request = { intent: 'answer' as const, sendOption: true, optionIndex: 0,
      answerTarget: { optionId: item.options[0]!.id, revision: item.revision, questionRevision: item.question_revision, bindingId: session.active_binding_id } };
    const view = render(<AnswerSlot {...props} focusRequest={{ ...request, token: 1 }} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This reply is being saved or needs a retry. Your note is kept.');
    expect(drafts.getSnapshot().entries[id]!.draft.text).toBe('Keep my exact note.');
    await act(async () => { release(); await saving; });
    view.rerender(<AnswerSlot {...props} focusRequest={{ ...request, token: 2 }} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This reply has already been sent.');
    expect(sends(transport)).toHaveLength(1);
    expect(sends(transport)[0]!.command).toMatchObject({ params: { text: 'Keep my exact note.', selected_option_id: null } });
  });
});
