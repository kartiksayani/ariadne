import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { AnswerSlot } from '../../../src/ui/detail/AnswerSlot';
import { AppTransport, route } from '../app/transport';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); vi.useRealTimers(); vi.restoreAllMocks(); });
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
  it.each([{ itemId: '1', action: 'Follow up', label: 'Follow-up message' }, { itemId: '1.1', action: 'Reply', label: 'Reply message' }])('keeps $action and its words locked until saved drafts load', async ({ itemId, action, label }) => {
    const transport = new AppTransport(), service = createDesktopService(transport);
    const store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
    stores.push(store);
    await store.refresh();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'preferences_get') await gate;
      return invoke(name, args);
    });
    render(<ItemDetail store={store} drafts={drafts} itemId={itemId} later={false} onOpenItem={vi.fn()} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: action }).disabled).toBe(true);
    const standing = screen.queryByLabelText<HTMLTextAreaElement>(label);
    if (standing) expect(standing.disabled).toBe(true);
    await act(async () => { release(); await drafts.load(); });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: action });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'Retain these words.' } });
    expect(screen.getByLabelText<HTMLTextAreaElement>(label).value).toBe('Retain these words.');
  });

  it.each(['click', 'key'] as const)('retains exactly one stale reopen by %s after an agent apply', async trigger => {
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
    expect(session.items['1']!.status).toBe('done');
    ++session.items['1']!.revision;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(store.getSnapshot().status).toBe('stale');
    if (trigger === 'click') {
      expect(reopen.disabled).toBe(false);
      fireEvent.click(reopen);
      fireEvent.click(reopen);
    } else view.rerender(<ItemDetail {...props} focusRequest={{ token: 1, intent: 'reopen' }} />);
    expect(sends(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'reopen', target: { item_id: '1' } } } });
    expect(drafts.find(route, '1', 'reopen')!.draft.target_revision).toBe(session.items['1']!.revision);
    expect(Object.values(session.inputs).filter(input => input?.kind === 'reopen' && input.target.item_id === '1')).toHaveLength(1);
    expect(screen.queryByText(loadingError)).toBeNull();
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
    view.rerender(<ItemDetail {...props} itemId="5" />);
    await act(async () => { release(); });
    await waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    expect(screen.queryByText(loadingError)).toBeNull();
    expect(sends(transport)).toHaveLength(0);
    expect(drafts.find(route, '1', 'reopen')).toBeUndefined();
  });

  it('opens Follow up while an agent apply is refreshing and sends exactly once after review', async () => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') await gate;
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    expect(session.items['1']!.status).toBe('done');
    ++session.items['1']!.revision;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    const followup = screen.getByRole<HTMLButtonElement>('button', { name: 'Follow up' });
    expect(followup.disabled).toBe(false);
    fireEvent.click(followup);
    fireEvent.change(screen.getByLabelText('Follow-up message'), { target: { value: 'Please check this once more.' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send follow-up' }).disabled).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'followup', text: 'Please check this once more.' } } });
    expect(drafts.find(route, '1', 'followup')!.draft.target_revision).toBe(session.items['1']!.revision);
    expect(Object.values(session.inputs).filter(input => input?.kind === 'followup' && input.target.item_id === '1')).toHaveLength(1);
  });

  it('shows a plain timeout and never replays a reopen when the late refresh finishes', async () => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="1" later={false} onOpenItem={vi.fn()} />);
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
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Open' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole('alert')).toHaveProperty('textContent', loadingError);
    await act(async () => { release(); await store.refresh(); });
    expect(screen.queryByText(loadingError)).toBeNull();
    expect(sends(transport)).toHaveLength(0);
    expect(drafts.find(route, '1', 'reopen')).toBeUndefined();
  });

  it.each(['reopen', 'followup'] as const)('sends one %s when the prior agent result has rendered but the store is still stale', async intent => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const session = transport.sessions.get(route.session_id)!;
    const result = session.messages.find(message => message.author === 'agent' && message.item_id === '1')!;
    result.body = 'The previous CLI-applied result is visible.';
    ++session.items['1']!.revision;
    ++session.revision;
    const invoke = transport.invoke.bind(transport);
    let stale = true, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') {
        if (stale) return { api_version: 1, ok: true, data: { kind: name, data: { session: structuredClone(session), freshness: 'stale' } } };
        await gate;
      }
      return invoke(name, args);
    });
    await act(async () => { await store.refresh(); });
    expect(screen.getByText(result.body)).toBeTruthy();
    expect(store.getSnapshot().status).toBe('stale');
    stale = false;
    fireEvent.click(screen.getByRole('button', { name: intent === 'reopen' ? 'Back to Open' : 'Follow up' }));
    if (intent === 'followup') {
      fireEvent.change(screen.getByLabelText('Follow-up message'), { target: { value: 'One deliberate follow-up.' } });
      void store.refresh();
    }
    await act(async () => { release(); await store.refresh(); });
    if (intent === 'followup') fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { kind: intent, target: { item_id: '1' } } });
    expect(session.items['1']!.status).toBe('done');
  });

  it.each(['question', 'binding', 'status', 'waiting', 'decided', 'outcome', 'why', 'refresh failure'] as const)('shows a plain refusal if %s changes during the reopen wait', async change => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') {
        await gate;
        if (change === 'refresh failure') throw new Error('Lost refresh');
      }
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Open' }));
    if (change === 'question') session.items['1']!.question = 'A different question';
    if (change === 'binding') session.active_binding_id = null;
    if (change === 'status') session.items['1']!.status = 'open';
    if (change === 'waiting') session.items['1']!.status = 'waiting_on_me';
    if (change === 'decided') session.items['1']!.status = 'decided';
    if (change === 'outcome') session.items['1']!.outcome = 'A different result to review.';
    if (change === 'why') session.items['1']!.why = 'A different rationale to review.';
    await act(async () => { release(); });
    const error = change === 'refresh failure' ? loadingError : 'This item changed. Review it before sending. Your text is kept.';
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', error);
    expect(sends(transport)).toHaveLength(0);
    expect(drafts.find(route, '1', 'reopen')).toBeUndefined();
  });

  it('shows one alert for a failed answer in the waiting detail and retains the owner’s text', async () => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const box = await screen.findByLabelText('Reply in your own words');
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'Keep my exact answer.' } });
    transport.failNext = 'input_submit';
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    await waitFor(() => expect(drafts.find(route, '2', 'answer')?.uncertain).toBe(true));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect((box as HTMLTextAreaElement).value).toBe('Keep my exact answer.');
    expect(sends(transport)).toHaveLength(1);
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'done'; ++session.items['2']!.revision; ++session.revision;
    await act(async () => { await store.refresh(); });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe('Keep my exact answer.');
    expect(screen.getByRole('button', { name: 'Try sending again' })).toBeTruthy();
  });

  it('shows one alert when saving a waiting answer draft fails before submission', async () => {
    const { transport, store, drafts } = await setup();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Reply in your own words');
    await waitFor(() => expect(box.disabled).toBe(false));
    transport.failNext = 'preferences_patch';
    fireEvent.change(box, { target: { value: 'Retain my unsent draft.' } });
    await waitFor(() => expect(drafts.getSnapshot().preferenceUncertain).toBe(true));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(box.value).toBe('Retain my unsent draft.');
    expect(sends(transport)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Try saving your draft again' })).toBeTruthy();
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
