import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from '../app/transport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup(configure?: (transport: AppTransport) => void) {
  const transport = new AppTransport(); configure?.(transport); render(<DesktopApp service={createDesktopService(transport)} />);
  const button = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(`[data-session-id="${route.session_id}"]`)!;
    expect(button).not.toBeNull(); expect(button.disabled).toBe(false); return button;
  });
  fireEvent.click(button); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close session' }).hasAttribute('disabled')).toBe(false));
  return transport;
}
it('focuses search with Cmd+F outside editors and suppresses workspace shortcuts inside modal controls', async () => {
  await setup();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Switch to light' }), { key: 'f', metaKey: true });
  const search = screen.getByLabelText('Search questions and outcomes'); expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: 'g' }); expect(screen.getByRole('tree')).toBeTruthy();
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!; row.focus();
  expect(fireEvent.keyDown(row, { key: '/' })).toBe(false); expect(document.activeElement).toBe(search);
  row.focus(); expect(fireEvent.keyDown(row, { key: 'Backspace' })).toBe(true); expect(document.activeElement).toBe(row);
  fireEvent.click(document.querySelector('[data-item-id="1"]')!); await screen.findByRole('group', { name: 'Owner actions' });
  const pause = screen.getByRole('button', { name: 'Close session' }); pause.focus(); fireEvent.click(pause);
  const dialog = screen.getByRole('dialog'), cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  fireEvent.keyDown(cancel, { key: 'g' }); fireEvent.keyDown(cancel, { key: 'm' }); fireEvent.keyDown(cancel, { key: '/' });
  expect(screen.getByRole('tree')).toBeTruthy(); expect(screen.queryByRole('log')).toBeNull(); expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('group', { name: 'Owner actions' })).toBeTruthy(); expect(document.activeElement).toBe(pause);
});
it('announces a new waiting episode and committed input resolution once without stealing editor focus', async () => {
  const transport = await setup(), session = transport.sessions.get(route.session_id)!;
  const updates = screen.getByRole('status', { name: 'Queue updates' });
  expect(updates.textContent).toBe(''); expect(updates.getAttribute('aria-live')).toBe('polite');
  const search = screen.getByLabelText('Search questions and outcomes'); search.focus();
  const update = async () => {
    session.revision++;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await waitFor(() => expect(transport.queries.filter(value => value.request.command === 'session_get')).not.toHaveLength(0));
  };
  session.items['2']!.question_revision++; await update();
  await waitFor(() => expect(updates.textContent).toBe('1 new waiting question.'));
  const span = updates.firstElementChild; await update();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(updates.firstElementChild).toBe(span); expect(document.activeElement).toBe(search);
  const input = Object.values(session.inputs).find(input => input?.state === 'queued')!;
  input.state = 'skipped'; await update();
  await waitFor(() => expect(updates.textContent).toBe('1 owner input resolved.'));
  const resolved = updates.firstElementChild; await update();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(updates.firstElementChild).toBe(resolved); expect(document.activeElement).toBe(search);
});
it('tracks OS appearance changes only while the saved theme is System', async () => {
  let change: (() => void) | undefined;
  const media = { matches: false, addEventListener: vi.fn((_name, listener) => { change = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  try {
    await setup(); expect(document.documentElement.dataset.theme).toBe('light');
    media.matches = true; act(() => { change?.(); }); expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' })); await screen.findByRole('button', { name: 'Switch to dark' });
    expect(document.documentElement.dataset.theme).toBe('light'); expect(media.removeEventListener).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('routes owner shortcuts from roving rows, repeats focus requests and never submits option/drop/reopen/archive implicitly', async () => {
  const transport = await setup(transport => { transport.sessions.get(route.session_id)!.items['2']!.options = [
    { id: 'morning', label: 'Morning', consequence: 'Deliver before lunch.', recommended: true },
    { id: 'afternoon', label: 'Afternoon', consequence: 'Deliver after lunch.', recommended: false },
  ]; });
  const press = (id: string, key: string) => {
    const row = document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
    row.focus(); fireEvent.keyDown(row, { key });
  };
  // a answers inline in the tree (frame 1c); the number keys then change the picked option.
  press('2', 'a');
  await waitFor(() => expect(document.querySelector('[role="treeitem"][data-item-id="2"] .answer-control')).not.toBeNull());
  press('2', '2');
  await waitFor(() => expect(transport.preferences.drafts.some(value => value.target.item_id === '2' && value.selected_option_id === transport.sessions.get(route.session_id)!.items['2']!.options[1].id)).toBe(true));
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
  press('4', 'r'); await screen.findByLabelText('Reply message'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply message')));
  screen.getByRole('button', { name: 'Switch to light' }).focus(); fireEvent.keyDown(document.activeElement!, { key: 'r' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply message')));
  fireEvent.keyDown(screen.getByLabelText('Reply message'), { key: 'g' }); expect(screen.getByRole('tree')).toBeTruthy();
  press('3', 'r'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Note message')));
  press('7', 'r'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Follow up message')));
  press('7', 'o'); expect(screen.queryByLabelText('Reopen message')).toBeNull();
  press('1', 'o'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reopen message')));
  press('4', 'd'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Drop message')));
  press('4', 'e'); expect(await screen.findByRole('dialog', { name: 'Confirm topic archive' })).toBeTruthy();
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});
it('answers the oldest waiting item when the focused item is not waiting', async () => {
  await setup(); const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key: 'a' });
  const waiting = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
  await waitFor(() => expect(waiting.querySelector('.answer-control')).not.toBeNull());
  expect(document.activeElement).toBe(waiting);
});

it('queues a fresh Bring once with its visible fixed text and reveals its receipt on repeat', async () => {
  const transport = await setup(), row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key: 'b' }); fireEvent.keyDown(row, { key: 'b' }); fireEvent.keyDown(row, { key: 'b', repeat: true });
  await waitFor(() => expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(1));
  expect(transport.mutations.find(value => value.command.command === 'input_submit')!.command).toMatchObject({ params: { kind: 'bring', text: 'Bring this up.', target: { item_id: '4' } } });
  await screen.findByText(/Saved · Queue position/);
  row.focus(); fireEvent.keyDown(row, { key: 'b' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(1);
});
it.each([false, true])('reveals an existing Bring draft without editing/submitting/retrying it (attempted %s)', async attempted => {
  const transport = await setup(transport => {
    const session = transport.sessions.get(route.session_id)!, item = session.items['4']!;
    transport.preferences.drafts.push({ op_id: '00000000-0000-4000-8000-000000001234', session: route, binding_id: session.active_binding_id!,
      target: { topic_id: item.topic_id, item_id: item.id }, target_revision: item.revision, question_revision: item.question_revision,
      intent: 'bring', selected_option_id: null, text: 'Keep my deliberate text.', supersedes_answer_id: null, submission_attempted: attempted });
  });
  const before = structuredClone(transport.preferences.drafts[0]);
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!; row.focus(); fireEvent.keyDown(row, { key: 'b' });
  expect((await screen.findByLabelText('Bring up message') as HTMLTextAreaElement).value).toBe(before.text);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(transport.preferences.drafts[0]).toEqual(before); expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});

async function delayedReveal(transport: AppTransport) {
  const invoke = transport.invoke.bind(transport);
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('request' in args.request && args.request.request.command === 'reveal_item') { started = true; await gate; }
    return invoke(name, args);
  });
  return { started: () => started, release: async () => { await act(async () => { release(); await gate; }); } };
}
// a answers inline in the tree without a reveal, so only r and b can be delayed.
it.each(['r', 'b'])('rejects delayed %s before it can undo newer All sessions navigation or mutate Bring', async key => {
  const transport = await setup(), pending = await delayedReveal(transport);
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key }); await waitFor(() => expect(pending.started()).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: /^All sessions/ }));
  await screen.findByRole('heading', { name: 'All sessions' });
  const selected = structuredClone(transport.preferences.global.selected_navigation), destination = document.activeElement;
  await pending.release(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(screen.getByRole('heading', { name: 'All sessions' })).toBeTruthy();
  expect(transport.preferences.global.selected_navigation).toEqual(selected); expect(document.activeElement).toBe(destination);
  expect(screen.queryByLabelText('Reply message')).toBeNull(); expect(screen.queryByLabelText('Bring up message')).toBeNull();
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});
it('rejects delayed Reply after detail dismissal', async () => {
  const transport = await setup(); fireEvent.click(document.querySelector('[data-item-id="4"]')!);
  await screen.findByLabelText('Reply message'); const pending = await delayedReveal(transport);
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key: 'r' }); await waitFor(() => expect(pending.started()).toBe(true));
  fireEvent.keyDown(row, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  await pending.release(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(document.querySelector('.shell-detail')).toBeNull(); expect(document.activeElement).toBe(row);
});
it.each(['item', 'question', 'binding'])('preserves retained option until explicit %s target review and requires a new number afterward', async change => {
  const transport = await setup(transport => {
    const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    item.options = [{ id: 'morning', label: 'Morning', consequence: 'Before lunch.', recommended: true }, { id: 'afternoon', label: 'Afternoon', consequence: 'After lunch.', recommended: false }];
    transport.preferences.drafts.push({ op_id: '00000000-0000-4000-8000-000000001234', session: route, binding_id: change === 'binding' ? '00000000-0000-4000-8000-000000001235' : session.active_binding_id!,
      target: { topic_id: item.topic_id, item_id: item.id }, target_revision: item.revision - (change === 'item' ? 1 : 0), question_revision: item.question_revision - (change === 'question' ? 1 : 0),
      intent: 'answer', selected_option_id: 'morning', text: 'Retain deliberate draft.', supersedes_answer_id: null, submission_attempted: false });
  });
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
  row.focus(); fireEvent.keyDown(row, { key: '2' }); await screen.findByLabelText('Reply in your own words');
  const detail = within(document.querySelector('.shell-detail-scroll')!);
  expect(detail.getByRole('button', { name: /^2Afternoon/ }).hasAttribute('disabled')).toBe(true);
  expect(detail.getByRole('button', { name: /^1Morning/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.keyDown(detail.getByRole('button', { name: 'Answer' }), { key: '2' });
  expect(transport.preferences.drafts[0].selected_option_id).toBe('morning');
  fireEvent.click(detail.getByRole('button', { name: 'Review current target' }));
  await waitFor(() => expect(transport.preferences.drafts[0].selected_option_id).toBeNull());
  expect(detail.getByRole('button', { name: /^2Afternoon/ }).getAttribute('aria-pressed')).toBe('false');
  row.focus(); fireEvent.keyDown(row, { key: '2' });
  await waitFor(() => expect(transport.preferences.drafts[0].selected_option_id).toBe('afternoon'));
  expect(transport.preferences.drafts[0].text).toBe('Retain deliberate draft.');
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});
it('consumes a numeric request so detail remount preserves the owner’s later choice', async () => {
  const transport = await setup(transport => { transport.sessions.get(route.session_id)!.items['2']!.options = [
    { id: 'morning', label: 'Morning', consequence: 'Before lunch.', recommended: true }, { id: 'afternoon', label: 'Afternoon', consequence: 'After lunch.', recommended: false }]; });
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
  row.focus(); fireEvent.keyDown(row, { key: '2' });
  const saved = () => transport.preferences.drafts.find(value => value.intent === 'answer' && value.target.item_id === '2')!;
  await waitFor(() => expect(saved().selected_option_id).toBe('afternoon'));
  const editor = document.querySelector<HTMLElement>('.shell-detail-scroll .owner-input')!;
  fireEvent.click(within(editor).getByRole('button', { name: /^1Morning/ })); await waitFor(() => expect(saved().selected_option_id).toBe('morning'));
  fireEvent.keyDown(editor, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  fireEvent.click(row); await waitFor(() => expect(document.querySelector('.shell-detail-scroll .owner-input')).not.toBeNull());
  expect(within(document.querySelector('.shell-detail-scroll')!).getByRole('button', { name: /^1Morning/ }).getAttribute('aria-pressed')).toBe('true');
  expect(saved().selected_option_id).toBe('morning');
});

it.each(['r', 'b'])('failed preference navigation cannot authorize %s focus or Bring submission', async key => {
  const transport = await setup(), invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'preferences_patch') {
      return { api_version: 1, ok: false, error: { code: 'commit_uncertain', message: 'Navigation save unknown.', hint: 'Reconcile explicitly.', retryable: true, field_errors: [] } };
    }
    return invoke(name, args);
  });
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key });
  await screen.findByText('Navigation save unknown.');
  expect(screen.queryByLabelText('Reply message')).toBeNull(); expect(screen.queryByLabelText('Bring up message')).toBeNull();
  expect(document.activeElement).toBe(row); expect(transport.preferences.drafts).toEqual([]);
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});
it.each([{ key: 'r', id: '4' }, { key: 'b', id: '4' }, { key: 'r', id: '3' }, { key: 'b', id: '3' }])('keeps a dismissed detail closed when dispatched $key selects #$id', async ({ key, id }) => {
  const transport = await setup(); fireEvent.click(document.querySelector('[data-item-id="4"]')!); await screen.findByLabelText('Reply message');
  await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('4'));
  const invoke = transport.invoke.bind(transport); let dispatched = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), beforeRevision = transport.preferences.revision;
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'preferences_patch'
      && args.request.command.params.entries.some(entry => entry.kind === 'set_global')) {
      dispatched = true; await gate;
    }
    return invoke(name, args);
  });
  const beforeMutations = transport.mutations.length, row = document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
  row.focus(); fireEvent.keyDown(row, { key }); await waitFor(() => expect(dispatched).toBe(true));
  fireEvent.keyDown(row, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  await act(async () => { release(); await gate; await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(document.querySelector('.shell-detail')).toBeNull(); expect(document.activeElement).toBe(row);
  expect(transport.preferences.revision).toBeGreaterThan(beforeRevision);
  expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
  expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe(id);
  expect(transport.mutations.slice(beforeMutations)).toHaveLength(1); expect(transport.preferences.drafts).toEqual([]);
  fireEvent.click(row); expect(await screen.findByLabelText(`Owner input for #${id}`)).toBeTruthy();
});
it('keeps detail dismissed when shortcut navigation session read completes afterward', async () => {
  const transport = await setup(); fireEvent.click(document.querySelector('[data-item-id="4"]')!); await screen.findByLabelText('Reply message');
  const invoke = transport.invoke.bind(transport); let reads = 0, resolving = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('request' in args.request && args.request.request.command === 'reveal_item') resolving = true;
    if (resolving && 'request' in args.request && args.request.request.command === 'session_get' && ++reads === 2) await gate;
    return invoke(name, args);
  });
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
  row.focus(); fireEvent.keyDown(row, { key: 'r' }); await waitFor(() => expect(reads).toBe(2));
  fireEvent.keyDown(row, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  await act(async () => { release(); await gate; await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(document.querySelector('.shell-detail')).toBeNull(); expect(document.activeElement).toBe(row);
});
it('keeps detail dismissed after a dispatched oldest-waiting shortcut changes session, then opens deliberate tab navigation', async () => {
  const transport = await setup(value => {
    const first = value.sessions.get(route.session_id)!, second = structuredClone(first);
    second.id = secondId; second.title = 'Separate session'; value.sessions.set(secondId, second);
    first.items['2']!.status = 'open';
  });
  fireEvent.click(document.querySelector('[data-item-id="4"]')!); await screen.findByLabelText('Reply message');
  await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('4'));
  const invoke = transport.invoke.bind(transport); let dispatched = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'preferences_patch'
      && args.request.command.params.entries.some(entry => entry.kind === 'set_global')) { dispatched = true; await gate; }
    return invoke(name, args);
  });
  const control = screen.getByRole('button', { name: 'Switch to light' });
  control.focus(); fireEvent.keyDown(control, { key: 'a' }); await waitFor(() => expect(dispatched).toBe(true));
  fireEvent.keyDown(control, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  await act(async () => { release(); await gate; await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
  expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.selected_item_id).toBe('2');
  expect(document.querySelector('.shell-detail')).toBeNull(); expect(document.activeElement).toBe(control);
  expect(transport.preferences.drafts).toEqual([]);
  const tab = document.querySelector<HTMLButtonElement>(`[data-session-tab="${CSS.escape(JSON.stringify([route.project_id, route.session_id]))}"]`)!;
  await waitFor(() => expect(tab.hasAttribute('disabled')).toBe(false)); fireEvent.click(tab);
  expect(await screen.findByLabelText('Owner input for #4')).toBeTruthy();
});
