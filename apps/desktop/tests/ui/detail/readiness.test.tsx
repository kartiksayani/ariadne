import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { SavedReceipt } from '../../../src/generated/domain/models';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { AnswerSlot } from '../../../src/ui/detail/AnswerSlot';
import { useDetailSubmit } from '../../../src/ui/detail/submit';
import type { ItemActionView } from '../../../src/ui/detail/itemActions';
import { AppTransport, route } from '../app/transport';
import { Notices, notices } from '../../../src/ui/pages/notices';
import { sessionClosedReason } from '../../../src/selectors/sessionClosed';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); notices.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
  it('opens own-answer mode once for a focus request without losing the saved option note', async () => {
    const { transport, store, drafts } = await setup();
    const source = transport.sessions.get(route.session_id)!;
    source.items['2']!.options = [{ id: 'keep', label: 'Keep it', consequence: 'Keep the design.', recommended: true }];
    ++source.revision; await store.refresh();
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    drafts.edit(id, { selected_option_id: 'keep', text: ' My saved note\non two lines. ' });
    const consume = vi.fn();
    const props = { drafts, store, itemId: '2', onEscape: vi.fn(), onFocusRequestConsumed: consume,
      focusRequest: { token: 1, intent: 'answer' as const, ownWords: true } };
    const view = render(<AnswerSlot {...props} />);
    const box = screen.getByLabelText<HTMLTextAreaElement>('Reply in your own words');
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe(' My saved note\non two lines. ');
    expect(drafts.find(route, '2', 'answer')?.draft.selected_option_id).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Keep it/ }));
    view.rerender(<AnswerSlot {...props} />);
    expect(drafts.find(route, '2', 'answer')?.draft.selected_option_id).toBe('keep');
    expect(consume).toHaveBeenCalledExactlyOnceWith(1);
    expect(sends(transport)).toHaveLength(0);
  });

  it.each(['closed', 'archived'] as const)('keeps a %s waiting question and draft visible with the right disabled reason', async state => {
    const { transport, store, drafts } = await setup();
    const source = transport.sessions.get(route.session_id)!;
    const entry = drafts.begin(source, '2', 'answer')!;
    drafts.edit(entry, { text: 'My unsent answer' });
    source.state = 'closed';
    if (state === 'archived') source.archived_at = source.updated_at;
    ++source.revision; await store.refresh();
    // Archived details keep the saved draft rather than offering a composer.
    render(<><ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />
      {state === 'archived' && <AnswerSlot store={store} drafts={drafts} itemId="2" onEscape={vi.fn()} />}</>);
    const reason = state === 'archived' ? 'This session is archived. Restore it, then reopen it to answer.' : sessionClosedReason;
    expect(screen.getByText('Session closed').title).toBe(reason);
    expect(screen.getByText('Waiting on me')).toBeTruthy();
    const answer = await screen.findByRole('group', { name: 'Answer' });
    const textarea = within(answer).getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('My unsent answer'); expect(textarea.disabled).toBe(true);
    expect(within(answer).getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    expect(within(answer).getByText(reason)).toBeTruthy();
    expect(sends(transport)).toEqual([]);
    expect(drafts.find(route, '2', 'answer')?.draft.text).toBe('My unsent answer');
  });
  it.each(['in_flight', 'handled'] as const)('keeps a %s answered question waiting on the agent with its saved answer after closing the session', async state => {
    const { transport, store, drafts } = await setup();
    const source = transport.sessions.get(route.session_id)!;
    const entry = drafts.begin(source, '2', 'answer')!;
    drafts.edit(entry, { text: 'Keep my delivered answer' });
    expect(await drafts.submit(entry)).toBe(true);
    const input = Object.values(source.inputs).find(value => value?.payload.text === 'Keep my delivered answer')!;
    // AppTransport saves the input; add core's canonical answer snapshot for the waiting episode.
    const answer = structuredClone(source.answers[source.answers.length - 1]!);
    answer.id = crypto.randomUUID(); answer.item_id = '2'; answer.question_revision = source.items['2']!.question_revision;
    answer.input_id = input.id; answer.message_id = input.message_id; answer.text = input.payload.text;
    answer.selected_option_id = null; answer.supersedes_answer_id = null; input.answer_id = answer.id;
    source.answers.push(answer);
    input.state = state;
    if (state === 'in_flight') {
      // A committed result waiting for host completion is handled by Close, rather than cancelled.
      const attempt = structuredClone(Object.values(source.inputs).find(value => value?.target.item_id === '2' && value.id !== input.id)!.attempts[0]!);
      // Its turn is still running on the host: the committed result is published, so the item reads Sent.
      attempt.id = crypto.randomUUID(); attempt.sealed_at = null; attempt.turn_state = 'running';
      input.active_attempt_id = attempt.id; input.attempts = [attempt];
    }
    ++source.revision;
    await store.refresh();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    expect(document.querySelector('.detail-status .status-badge')?.textContent).toBe('Sent');
    if (state === 'handled') {
      expect(await screen.findByText('Picked up by the agent.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Write another input' })).toBeNull();
    }
    await act(async () => {
      await drafts.service.executeOwner({ session: route, command: { command: 'session_close', api_version: 1, op_id: crypto.randomUUID(),
        params: { expected_revision: source.revision } } });
      await store.refresh();
    });
    expect(document.querySelector('.detail-status .status-badge')?.textContent).toBe('Sent');
    expect(screen.queryByText('Waiting on me')).toBeNull();
    expect(screen.queryByText('Session closed')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your answer' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Answer' })).toBeNull();
    expect(screen.getByText('Keep my delivered answer')).toBeTruthy();
    expect(input.state).toBe('handled');
    expect(drafts.find(route, '2', 'answer')?.receipt?.data.kind).toBe('input_submit');
  });
  // Copy reference is a row of the actions list Details hands to the head's "…" menu (alpha.21 §5.6), not a button in the body.
  const withActions = () => {
    const seen: { list: readonly ItemActionView[] | null } = { list: null };
    return { onActions: (list: readonly ItemActionView[] | null) => { seen.list = list; }, copy: () => seen.list!.find(action => action.id === 'copyRef')!.run() };
  };
  it('copies an item with generic toast feedback through the Copy reference action', async () => {
    const { store, drafts } = await setup();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { onActions, copy } = withActions();
    render(<ItemDetail store={store} drafts={drafts} itemId="1.1" later={false} onOpenItem={vi.fn()} onActions={onActions} />);
    expect(screen.queryByRole('button', { name: 'Copy reference' })).toBeNull();
    act(() => copy());
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Item copied.']));
    expect(writeText).toHaveBeenCalledOnce();
    expect(screen.queryByText('Copied')).toBeNull();
  });
  it('reports a copy failure with generic toast feedback', async () => {
    const { store, drafts } = await setup();
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('Clipboard failed with private item text.'); }) } });
    const { onActions, copy } = withActions();
    render(<ItemDetail store={store} drafts={drafts} itemId="1.1" later={false} onOpenItem={vi.fn()} onActions={onActions} />);
    act(() => copy());
    await waitFor(() => expect(notices.getSnapshot().map(notice => [notice.text, notice.tone])).toEqual([['Copy failed. Try again.', 'problem']]));
  });
  it.each(['item', 'unmount'] as const)('ignores a copy completion after the detail changes by %s', async change => {
    const { store, drafts } = await setup();
    let finish!: () => void;
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) } });
    const { onActions, copy } = withActions();
    const props = { store, drafts, itemId: '1.1', later: false, onOpenItem: vi.fn(), onActions };
    const view = render(<ItemDetail {...props} />);
    act(() => copy());
    if (change === 'item') view.rerender(<ItemDetail {...props} itemId="1" />);
    else view.unmount();
    await act(async () => { finish(); });
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('moves Later refusal to a toast, preserves dismissed state through rerenders and clears it on success', async () => {
    const { store, drafts } = await setup(), onLater = vi.fn(async () => false);
    const props = { store, drafts, itemId: '1.1', later: false, onLater, onOpenItem: vi.fn() };
    const view = render(<ItemDetail {...props} />);
    const message = 'Later was not saved. Keep the current view and try again.';
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual([message]));
    expect(screen.queryByText(message)).toBeNull();
    act(() => notices.dismiss(notices.getSnapshot()[0]!.id));
    view.rerender(<ItemDetail {...props} onOpenItem={vi.fn()} />);
    expect(notices.getSnapshot()).toEqual([]);
    onLater.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(onLater).toHaveBeenCalledTimes(2));
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('clears a visible Later refusal when the detail unmounts without showing it again', async () => {
    const { store, drafts } = await setup();
    vi.useFakeTimers();
    const view = render(<><ItemDetail store={store} drafts={drafts} itemId="1.1" later={false}
      onLater={async () => false} onOpenItem={vi.fn()} /><Notices /></>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Later' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByText('Later was not saved. Keep the current view and try again.')).toBeTruthy();
    view.unmount();
    expect(notices.getSnapshot()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(notices.getVisibleSnapshot()).toEqual([]);
  });

  it('moves Ack refusal to a toast and clears it when the item is acknowledged', async () => {
    const { transport, store, drafts } = await setup();
    const source = transport.sessions.get(route.session_id)!;
    source.items['1.1']!.ack_to = 'done'; source.items['1.1']!.ask = null; ++source.revision;
    await store.refresh();
    const invoke = transport.invoke.bind(transport);
    let refuse = true;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'ack') {
        if (refuse) return { api_version: 1, ok: false,
          error: { code: 'invalid_transition', message: 'Predicate changed.', hint: '', retryable: false, field_errors: [] } };
        const session = transport.sessions.get(route.session_id)!, item = session.items['1.1']!;
        item.status = 'done'; item.ack_to = null; ++item.revision; ++session.revision;
        return { api_version: 1, ok: true, data: { operation_id: args.request.command.op_id, session_id: session.id, revision: session.revision,
          data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status: 'done', message_id: crypto.randomUUID() } } };
      }
      return invoke(name, args);
    });
    render(<ItemDetail store={store} drafts={drafts} itemId="1.1" later={false} onOpenItem={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ack → Done' }));
    const message = 'This item can’t be acknowledged now. Check its current status and any question waiting for you.';
    await waitFor(() => expect(notices.getSnapshot().some(notice => notice.text === message)).toBe(true));
    expect(notices.getSnapshot()[0]!.id).toBe(JSON.stringify(['item-ack', route.project_id, route.session_id, '1.1']));
    expect(screen.queryByText(message)).toBeNull();
    refuse = false;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ack → Done' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Ack → Done' }));
    await waitFor(() => expect(notices.getSnapshot()).toEqual([]));
  });

  it('clears a refused send notice when saved drafts finish loading in an already ready session', async () => {
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
    const { result } = renderHook(() => useDetailSubmit(drafts, store, '1.1'));
    await act(async () => { expect(await result.current.send('reply', 'Keep these words.')).toBe(false); });
    expect(result.current.error).toBe(loadingError);
    expect(result.current.ready).toBe(false);
    expect(store.getSnapshot().status).toBe('ready');
    await act(async () => { release(); await drafts.load(); });
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
    expect(sends(transport)).toHaveLength(0);
  });

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
    // alpha.23: a refresh in flight (status stale) no longer holds the words Send off; the item-changed review still does after it lands.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send follow-up' }).disabled).toBe(false);
    await act(async () => { release(); });
    await waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Review this question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send follow-up' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'followup', text: 'Please check this once more.' } } });
    expect(drafts.find(route, '1', 'followup')!.draft.target_revision).toBe(session.items['1']!.revision);
    expect(Object.values(session.inputs).filter(input => input?.kind === 'followup' && input.target.item_id === '1')).toHaveLength(1);
  });

  /** An item's Reply box holding typed words, then a hint that marks the copy stale with its read held (alpha.23 F2). */
  async function staleReply(itemId = '1.1') {
    const { transport, store, drafts } = await setup();
    const props = { store, drafts, itemId, later: false, onOpenItem: vi.fn() };
    const view = render(<ItemDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Reply message'), { target: { value: 'Please go ahead.' } });
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
    const box = () => screen.getByLabelText<HTMLTextAreaElement>('Reply message');
    const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
    return { transport, store, drafts, session, props, view, release, box, send };
  }
  it('sends a reply clicked while a session refresh is in flight, once, with the text locked during the wait', async () => {
    const { transport, store, session, release, box, send } = await staleReply();
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    // The wait: read-only and busy, not disabled (focus and the caret stay); Send is busy; nothing has gone out yet.
    expect(box().readOnly).toBe(true); expect(box().disabled).toBe(false); expect(box().getAttribute('aria-busy')).toBe('true');
    expect(send().disabled).toBe(true); expect(send().getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('◌ Sending…')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'Changed during the wait.' } });
    fireEvent.click(send());
    expect(box().value).toBe('Please go ahead.');
    expect(sends(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'reply', text: 'Please go ahead.', target: { item_id: '1.1' } } } });
    expect(store.getSnapshot().status).toBe('ready');
    expect(Object.values(session.inputs).filter(input => input?.target.item_id === '1.1' && input.payload.text === 'Please go ahead.')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('sends once for a double click and a second key press during the wait, with no error', async () => {
    const { transport, release, box, send } = await staleReply();
    fireEvent.click(send()); fireEvent.click(send());
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { release(); });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    await act(async () => {});
    expect(sends(transport)).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('refuses a second send call for the same words while one waits, without a message', async () => {
    const { transport, store, drafts } = await setup();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') await gate;
      return invoke(name, args);
    });
    const { result } = renderHook(() => useDetailSubmit(drafts, store, '1.1'));
    const session = transport.sessions.get(route.session_id)!; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    let first!: Promise<boolean>;
    act(() => { first = result.current.send('reply', 'Once only.'); });
    await act(async () => { expect(await result.current.send('reply', 'Once only.')).toBe(false); });
    expect(result.current.error).toBeNull();
    expect(result.current.waiting('reply')).toBe(true);
    await act(async () => { release(); expect(await first).toBe(true); });
    expect(sends(transport)).toHaveLength(1);
    expect(result.current.waiting('reply')).toBe(false);
  });
  it('refuses a second send for the same words in the window where the store is ready but the wait has not ended', async () => {
    const { transport, store, drafts } = await setup();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, releaseRead!: () => void, held = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    // The refresh publishes `ready`, then seeds presence: holding that read keeps the wait open after the status has changed.
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const command = 'request' in args.request ? args.request.request.command : null;
      if (command === 'session_get') await readGate;
      if (command === 'session_list') { ++held; await gate; }
      return invoke(name, args);
    });
    const { result } = renderHook(() => useDetailSubmit(drafts, store, '1.1'));
    const session = transport.sessions.get(route.session_id)!; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(store.getSnapshot().status).toBe('stale');
    let first!: Promise<boolean>;
    act(() => { first = result.current.send('reply', 'Once only.'); });
    await act(async () => { releaseRead(); });
    await waitFor(() => expect(held).toBe(1));
    expect(store.getSnapshot().status).toBe('ready');
    expect(result.current.waiting('reply')).toBe(true);
    await act(async () => { expect(await result.current.send('reply', 'Once only.')).toBe(false); });
    expect(sends(transport)).toHaveLength(0);
    expect(result.current.error).toBeNull();
    await act(async () => { release(); expect(await first).toBe(true); });
    expect(sends(transport)).toHaveLength(1);
    expect(result.current.waiting('reply')).toBe(false);
  });
  it.each(['question', 'status', 'binding'] as const)('keeps the text and asks for a review when %s changes during the Send wait', async change => {
    const { transport, drafts, session, release } = await staleReply();
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    if (change === 'question') session.items['1.1']!.question = 'A different question';
    if (change === 'status') session.items['1.1']!.status = 'done';
    if (change === 'binding') session.active_binding_id = null;
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getAllByRole('alert').map(alert => alert.textContent))
      .toContain('This item changed. Review it before sending. Your text is kept.'));
    expect(sends(transport)).toHaveLength(0);
    expect(drafts.find(route, '1.1', 'reply')?.draft.text).toBe('Please go ahead.');
    expect(drafts.find(route, '1.1', 'reply')?.saving).toBe(false);
  });
  it('proceeds after five seconds when a usable copy exists, sending once after the item-changed check', async () => {
    const { transport, drafts, release, box, send } = await staleReply();
    const draft = () => drafts.find(route, '1.1', 'reply')!;
    vi.useFakeTimers();
    fireEvent.click(send());
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(box().readOnly).toBe(true); expect(draft().saving).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    // The wait is over and the send went on: the draft is saving (core's own fresh read of the session is still held).
    expect(draft().saving).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sends(transport)).toHaveLength(0);
    vi.useRealTimers();
    await act(async () => { release(); });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('unlocks with the text kept and keeps the loading message when no usable copy exists after five seconds', async () => {
    const { transport, store, drafts } = await setup();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, failing = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') {
        if (failing) throw new Error('Read failed');
        await gate;
      }
      return invoke(name, args);
    });
    await act(async () => { await store.refresh(); });
    expect(store.getSnapshot().error).not.toBeNull();
    failing = false;
    const { result } = renderHook(() => useDetailSubmit(drafts, store, '1.1'));
    expect(result.current.sendable).toBe(false);
    vi.useFakeTimers();
    let sent: Promise<boolean>;
    act(() => { sent = result.current.send('reply', 'Keep these words.'); });
    expect(result.current.waiting('reply')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await sent!).toBe(false);
    expect(result.current.waiting('reply')).toBe(false);
    expect(result.current.error).toBe(loadingError);
    // A copy lands later: the refusal stays until the owner's next send or review.
    await act(async () => { release(); await store.refresh(); });
    expect(store.getSnapshot().status).toBe('ready');
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBe(loadingError);
    expect(sends(transport)).toHaveLength(0);
    vi.useRealTimers();
    await act(async () => { expect(await result.current.send('reply', 'Keep these words.')).toBe(true); });
    expect(result.current.error).toBeNull();
    expect(sends(transport)).toHaveLength(1);
  });
  it('cancels a waiting Send when the owner moves to another item, unlocks and keeps the text', async () => {
    const { transport, drafts, props, view, release, box } = await staleReply();
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(box().readOnly).toBe(true);
    view.rerender(<ItemDetail {...props} itemId="5" />);
    await act(async () => { release(); });
    await act(async () => {});
    expect(sends(transport)).toHaveLength(0);
    view.rerender(<ItemDetail {...props} />);
    expect(drafts.find(route, '1.1', 'reply')?.draft.text).toBe('Please go ahead.');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply message').readOnly).toBe(false);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply message').value).toBe('Please go ahead.');
    expect(screen.queryByText(loadingError)).toBeNull();
  });
  it.each(['loading', 'error', 'inaccessible'] as const)('keeps Send off while the session is %s', async state => {
    const { transport, store, drafts } = await setup();
    const invoke = transport.invoke.bind(transport);
    const props = { store, drafts, itemId: '1.1', later: false, onOpenItem: vi.fn() };
    const view = render(<ItemDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByLabelText('Reply message'), { target: { value: 'Words to keep.' } });
    if (state === 'error') {
      vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
        if ('request' in args.request && args.request.request.command === 'session_get') throw new Error('Read failed');
        return invoke(name, args);
      });
      await act(async () => { await store.refresh(); });
      expect(store.getSnapshot().error).not.toBeNull();
    } else if (state === 'inaccessible') {
      vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
        if ('request' in args.request && args.request.request.command === 'session_get') {
          throw Object.assign(new Error('gone'), { code: 'not_found' });
        }
        return invoke(name, args);
      });
      await act(async () => { await store.refresh(); });
      expect(store.getSnapshot().error).not.toBeNull();
    } else {
      // Nothing is loaded yet: there is no copy to send against, and no box to send from.
      const fresh = new SessionStore(createDesktopService(transport), route); stores.push(fresh);
      const { result } = renderHook(() => useDetailSubmit(drafts, fresh, '1.1'));
      expect(fresh.getSnapshot().status).toBe('loading');
      expect(result.current.sendable).toBe(false);
      view.unmount();
      await act(async () => { expect(await result.current.send('reply', 'Words to keep.')).toBe(false); });
      expect(result.current.error).toBe(loadingError);
      expect(sends(transport)).toHaveLength(0);
      return;
    }
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send reply' }).disabled).toBe(true);
    expect(sends(transport)).toHaveLength(0);
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
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(drafts.find(route, '2', 'answer')?.uncertain).toBe(true));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByText('Ariadne isn’t sure this was sent. Check before sending again; your words are kept.')).toHaveLength(1);
    expect((box as HTMLTextAreaElement).value).toBe('Keep my exact answer.');
    expect(sends(transport)).toHaveLength(1);
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'done'; ++session.items['2']!.revision; ++session.revision;
    await act(async () => { await store.refresh(); });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.querySelector('.detail-answer')).toBeNull();
    expect(screen.queryByLabelText('Reply in your own words')).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Saved answer text').value).toBe('Keep my exact answer.');
    expect(screen.queryByRole('button', { name: 'Try sending again' })).toBeNull();
    expect(drafts.find(route, '2', 'answer')!.draft.text).toBe('Keep my exact answer.');
  });

  it('keeps exact answer recovery while an unrelated note is queued on the still-open question', async () => {
    const { transport, store, drafts } = await setup();
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    await drafts.editSaved(id, { text: 'Keep this unconfirmed answer.' });
    transport.failNext = 'input_submit';
    expect(await drafts.submit(id)).toBe(false);
    const note = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'note')!;
    await drafts.editSaved(note, { text: 'A separate queued note.' });
    expect(await drafts.submit(note)).toBe(true);
    await store.refresh();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    expect(await screen.findByRole('region', { name: 'Your answer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check delivery' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try sending again' })).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe('Keep this unconfirmed answer.');
    expect(screen.queryByRole('region', { name: 'Saved message' })).toBeNull();
    expect(drafts.getSnapshot().entries[id]!.uncertain).toBe(true);
    expect(sends(transport)).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check delivery' })); });
    expect(sends(transport)).toHaveLength(2);
    expect(drafts.getSnapshot().entries[id]!.uncertain).toBe(true);
  });

  it('holds Check delivery while the item is being removed and gives it back on Undo', async () => {
    const { transport, store, drafts } = await setup();
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    await drafts.editSaved(id, { text: 'Keep this unconfirmed answer.' });
    transport.failNext = 'input_submit';
    expect(await drafts.submit(id)).toBe(false);
    const props = { drafts, store, itemId: '2', onEscape: vi.fn() };
    const view = render(<AnswerSlot {...props} removing />);
    const check = await screen.findByRole<HTMLButtonElement>('button', { name: 'Check delivery' });
    expect(check.disabled).toBe(true);
    expect(check.title).toBe('Being removed · Undo first');
    fireEvent.click(check);
    expect(sends(transport)).toHaveLength(1);
    view.rerender(<AnswerSlot {...props} removing={false} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Check delivery' }).disabled).toBe(false);
    expect(drafts.getSnapshot().entries[id]!.draft.text).toBe('Keep this unconfirmed answer.');
  });

  it.each(['decided', 'done', 'dropped'] as const)('keeps an undelivered answer visible beside the %s outcome and actions', async status => {
    const { transport, store, drafts } = await setup();
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    await drafts.editSaved(id, { text: 'Keep these exact words.\nAnd this second paragraph.' });
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = status;
    session.items['2']!.outcome = 'The agent finished this question.';
    ++session.items['2']!.revision; ++session.revision;
    await store.refresh();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    expect(document.querySelector('.detail-answer')).toBeNull();
    expect(screen.queryByLabelText('Reply in your own words')).toBeNull();
    expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toContain('The agent finished this question.');
    expect(screen.getByRole('button', { name: 'Back to Open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow up' })).toBeTruthy();
    const saved = screen.getByRole('region', { name: 'Saved message' });
    const text = within(saved).getByRole<HTMLTextAreaElement>('textbox', { name: 'Saved answer text' });
    expect(text.value).toBe('Keep these exact words.\nAnd this second paragraph.');
    expect(text.readOnly).toBe(true);
    expect(text.disabled).toBe(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    fireEvent.click(within(saved).getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text.value));
    vi.unstubAllGlobals();
    expect(drafts.getSnapshot().entries[id]!.draft.text).toBe(text.value);
    expect(transport.preferences.drafts.find(draft => draft.op_id === id)!.text).toBe(text.value);
    expect(sends(transport)).toHaveLength(0);
    fireEvent.click(within(saved).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved message' })).toBeNull());
    expect(drafts.getSnapshot().entries[id]).toBeUndefined();
    expect(transport.preferences.drafts.some(draft => draft.op_id === id)).toBe(false);
    expect(sends(transport)).toHaveLength(0);
  });

  it('keeps an attempted saved message visible while Discard is saving and after an unconfirmed save', async () => {
    const { transport, store, drafts } = await setup();
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    await drafts.editSaved(id, { text: 'Keep these attempted words.' });
    transport.failNext = 'input_submit'; expect(await drafts.submit(id)).toBe(false);
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'done'; ++session.items['2']!.revision; ++session.revision;
    await store.refresh();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch') { entered = true; await gate; }
      return invoke(name, args);
    });
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const saved = screen.getByRole('region', { name: 'Saved message' });
    const discard = within(saved).getByRole<HTMLButtonElement>('button', { name: 'Discard' });
    transport.failNext = 'preferences_patch'; fireEvent.click(discard);
    await waitFor(() => expect(entered).toBe(true));
    expect(discard.disabled).toBe(true);
    expect(within(saved).getByLabelText<HTMLTextAreaElement>('Saved answer text').value).toBe('Keep these attempted words.');
    await act(async () => { release(); });
    await waitFor(() => expect(drafts.getSnapshot().preferenceUncertain).toBe(true));
    expect(within(saved).getByLabelText<HTMLTextAreaElement>('Saved answer text').value).toBe('Keep these attempted words.');
    expect(within(saved).getAllByRole('alert')).toHaveLength(1);
    expect(transport.preferences.drafts.find(draft => draft.op_id === id)!.text).toBe('Keep these attempted words.');
    fireEvent.click(within(saved).getByRole('button', { name: 'Try saving your draft again' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved message' })).toBeNull());
    expect(sends(transport)).toHaveLength(1);
  });

  it('shows one saved message for restored copies and Discard removes both', async () => {
    const { transport, store, drafts } = await setup();
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    await drafts.editSaved(id, { text: 'One piece of text.' });
    const copy = structuredClone(transport.preferences.drafts[0]!); copy.op_id = crypto.randomUUID();
    copy.submission_attempted = true; transport.preferences.drafts.unshift(copy);
    await drafts.load();
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'done'; ++session.items['2']!.revision; ++session.revision;
    await store.refresh();
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const saved = screen.getByRole('region', { name: 'Saved message' });
    expect(within(saved).getAllByRole('textbox')).toHaveLength(1);
    fireEvent.click(within(saved).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved message' })).toBeNull());
    expect(transport.preferences.drafts).toEqual([]);
    expect(drafts.getSnapshot().entries[id]).toBeUndefined(); expect(drafts.getSnapshot().entries[copy.op_id]).toBeUndefined();
    expect(sends(transport)).toHaveLength(0);
  });

  it('does not repeat an unrelated store error in each saved message', async () => {
    const { transport, store, drafts } = await setup();
    const session = store.getSnapshot().snapshot!.session;
    const first = drafts.begin(session, '2', 'answer')!;
    await drafts.editSaved(first, { text: 'First saved message.' });
    const second = drafts.begin(session, '2', 'answer', true)!;
    await drafts.editSaved(second, { text: 'Second saved message.' });
    const live = transport.sessions.get(route.session_id)!;
    live.items['2']!.status = 'done'; ++live.items['2']!.revision; ++live.revision;
    await store.refresh();
    const other = drafts.begin(store.getSnapshot().snapshot!.session, '1', 'note')!;
    transport.failNext = 'preferences_patch'; expect(await drafts.editSaved(other, { text: 'Elsewhere.' })).toBe(false);
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const saved = screen.getByRole('region', { name: 'Saved message' });
    expect(within(saved).getAllByRole('textbox')).toHaveLength(2);
    expect(within(saved).queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(saved).getAllByRole<HTMLButtonElement>('button', { name: 'Discard' }).every(button => button.disabled)).toBe(true);
  });

  it.each(['update', 'restart'] as const)('clears an uncertain delivered answer on %s and removes the answer box', async recovery => {
    const { transport, store, drafts } = await setup();
    const before = structuredClone(transport.sessions.get(route.session_id)!);
    let oldView = true;
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (oldView && 'request' in args.request && args.request.request.command === 'session_get') return {
        api_version: 1, ok: true, data: { kind: name, data: { session: structuredClone(before), freshness: 'fresh' } },
      };
      const response = await invoke(name, args);
      if ('command' in args.request && args.request.command.command === 'input_submit') {
        const receipt = (response as { data: SavedReceipt }).data;
        const session = transport.sessions.get(route.session_id)!;
        session.operation_receipts[receipt.operation_id] = [{ operation_id: receipt.operation_id, actor_scope: { kind: 'owner' },
          command_digest: '0'.repeat(64), result: receipt }];
        session.inputs[receipt.data.kind === 'input_submit' ? receipt.data.input_id : '']!.state = 'handled';
        throw new Error('Lost the committed receipt');
      }
      return response;
    });
    const id = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'answer')!;
    await drafts.editSaved(id, { text: 'The delivered answer.' });
    expect(await drafts.submit(id)).toBe(false);
    expect(drafts.getSnapshot().entries[id]!.uncertain).toBe(true);
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    expect(await screen.findByRole('region', { name: 'Your answer' })).toBeTruthy();
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'decided';
    session.items['2']!.question_revision++;
    session.items['2']!.outcome = 'Use the delivered answer.';
    ++session.items['2']!.revision; ++session.revision;
    // Core keeps the answered episode open at the previous question version.
    expect(session.rounds[session.items['2']!.current_round_id!]!.closed_at).toBeNull();
    oldView = false;
    let active = drafts;
    if (recovery === 'restart') {
      cleanup();
      active = new OwnerDraftStore(drafts.service);
      await active.load();
    }
    await act(async () => { await store.refresh(); });
    if (recovery === 'restart') render(<ItemDetail store={store} drafts={active} itemId="2" later={false} onOpenItem={vi.fn()} />);
    await waitFor(() => expect(active.getSnapshot().entries[id]!.receipt?.data.kind).toBe('input_submit'));
    expect(active.getSnapshot().entries[id]).toMatchObject({ uncertain: false, error: null, draft: { text: '', selected_option_id: null }, sent: { text: 'The delivered answer.' } });
    expect(document.querySelector('.detail-answer')).toBeNull();
    expect(screen.queryByLabelText('Reply in your own words')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Saved message' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toContain('Use the delivered answer.');
    expect(screen.getByRole('button', { name: 'Back to Open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow up' })).toBeTruthy();
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.op_id === id)).toBe(false));
    expect(sends(transport)).toHaveLength(1);
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

  it.each(['waiting', 'retained'] as const)('keeps a distinct draft-store failure visible beside a failed %s answer', async view => {
    const { transport, store, drafts } = await setup();
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') return {
        api_version: 1, ok: false, error: { code: 'queue_full', message: 'Queue full', hint: 'Retry.', retryable: true, field_errors: [] },
      };
      return invoke(name, args);
    });
    const session = store.getSnapshot().snapshot!.session;
    const answer = drafts.begin(session, '2', 'answer')!;
    drafts.edit(answer, { text: 'Keep the failed answer.' });
    expect(await drafts.submit(answer)).toBe(false);
    if (view === 'retained') {
      const live = transport.sessions.get(route.session_id)!;
      live.items['2']!.status = 'done'; ++live.items['2']!.revision; ++live.revision;
      await store.refresh();
    }
    transport.failNext = 'preferences_patch';
    const note = drafts.begin(store.getSnapshot().snapshot!.session, '2', 'note')!;
    drafts.edit(note, { text: 'Keep this separate note too.' });
    await waitFor(() => expect(drafts.getSnapshot().preferenceUncertain).toBe(true));
    render(<ItemDetail store={store} drafts={drafts} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const alerts = screen.getAllByRole('alert').map(alert => alert.textContent);
    expect(alerts).toEqual(expect.arrayContaining([
      'Too many messages are waiting. Let the agent catch up, then try again.',
      'Ariadne couldn’t reach its background service. Try again.',
    ]));
    expect(alerts).toHaveLength(2);
    expect(screen.getByLabelText<HTMLTextAreaElement>(view === 'waiting' ? 'Reply in your own words' : 'Saved answer text').value).toBe('Keep the failed answer.');
    expect(drafts.getSnapshot().entries[note]!.draft.text).toBe('Keep this separate note too.');
  });

  it('clears only the numeric shortcut loading notice when the session refresh becomes ready', async () => {
    const { transport, store, drafts } = await setup();
    const live = transport.sessions.get(route.session_id)!;
    live.items['2']!.options = [{ id: 'choice', label: 'Keep it', consequence: 'Keep this choice.', recommended: true }];
    ++live.revision;
    await store.refresh();
    const session = store.getSnapshot().snapshot!.session, item = session.items['2']!;
    const id = drafts.begin(session, item.id, 'answer')!;
    drafts.edit(id, { text: 'Keep my exact note.' });
    const invoke = transport.invoke.bind(transport);
    let stale = true;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (stale && 'request' in args.request && args.request.request.command === 'session_get') return {
        api_version: 1, ok: true, data: { kind: name, data: { session: structuredClone(live), freshness: 'stale' } },
      };
      return invoke(name, args);
    });
    await store.refresh();
    render(<AnswerSlot store={store} drafts={drafts} itemId={item.id} onEscape={vi.fn()}
      focusRequest={{ token: 1, intent: 'answer', sendOption: true, optionIndex: 0,
        answerTarget: { optionId: item.options[0]!.id, revision: item.revision, questionRevision: item.question_revision, bindingId: session.active_binding_id } }} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', loadingError);
    stale = false;
    await act(async () => { await store.refresh(); });
    expect(screen.queryByText(loadingError)).toBeNull();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe('Keep my exact note.');
    expect(sends(transport)).toHaveLength(0);
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
    await act(async () => { await store.refresh(); });
    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'The agent is reconnecting. Try again shortly.');
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
