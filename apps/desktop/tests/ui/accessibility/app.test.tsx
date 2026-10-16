import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from '../app/transport';
import { goToPage, goToSession } from '../app/open';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
/** The connection dot in the top bar: its card holds Copy session ID and Close session. */
const connection = () => document.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]')!;
/** The top bar's search box, once search is open. */
const searchBox = () => document.querySelector<HTMLInputElement>('.tb-search-input')!;
/** Item keys act on the selected item, so a test selects the row first (a click) and then presses the key on it. */
const select = async (id: string) => {
  const row = document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
  fireEvent.click(row); await screen.findByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${id}"]` });
  return row;
};
async function setup(configure?: (transport: AppTransport) => void) {
  const transport = new AppTransport(); configure?.(transport); render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route, open => act(async () => { fireEvent.click(open); }));
  await screen.findByRole('tree', { name: 'Session items' });
  // Check the bar trigger (the connection dot opens the card that holds Close session) and session readiness without leaving it open.
  expect(connection()).toBeTruthy();
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
  return transport;
}
it('focuses search with Cmd+F outside editors and suppresses workspace shortcuts inside modal controls', async () => {
  await setup();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Switch to light' }), { key: 'f', metaKey: true });
  await waitFor(() => expect(searchBox()).toBeTruthy()); const search = searchBox(); expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: 'g' }); expect(screen.getByRole('tree')).toBeTruthy();
  const row = await select('1'); row.focus();
  expect(fireEvent.keyDown(row, { key: '/' })).toBe(false); expect(document.activeElement).toBe(search);
  // ⌫ on the selected row asks to remove it (handoff README "Keyboard"); Cancel leaves everything as it was.
  row.focus(); expect(fireEvent.keyDown(row, { key: 'Backspace' })).toBe(false);
  const asking = screen.getByRole('alertdialog'); expect(within(asking).getByRole('button', { name: /^Remove/ })).toBeTruthy();
  fireEvent.click(within(asking).getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(document.querySelector('[data-item-id="1"]')!); await screen.findByRole('group', { name: 'Item actions' });
  const pause = connection(); pause.focus(); fireEvent.click(pause);
  fireEvent.click(await screen.findByRole('button', { name: 'Close session' }));
  const dialog = screen.getByRole('dialog'), cancel = within(dialog).getByRole('button', { name: 'Cancel' });
  fireEvent.keyDown(cancel, { key: 'g' }); fireEvent.keyDown(cancel, { key: 'm' }); fireEvent.keyDown(cancel, { key: '/' });
  expect(screen.getByRole('tree')).toBeTruthy(); expect(screen.queryByRole('log')).toBeNull(); expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('group', { name: 'Item actions' })).toBeTruthy(); expect(document.activeElement).toBe(pause);
}, 10_000);
it('announces a new waiting episode and committed input resolution once without stealing editor focus', async () => {
  const transport = await setup(), session = transport.sessions.get(route.session_id)!;
  const updates = screen.getByRole('status', { name: 'Queue updates' });
  expect(updates.textContent).toBe(''); expect(updates.getAttribute('aria-live')).toBe('polite');
  fireEvent.click(screen.getByRole('button', { name: 'Search the Map' })); await waitFor(() => expect(searchBox()).toBeTruthy());
  const search = searchBox(); search.focus();
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
  await waitFor(() => expect(updates.textContent).toBe('1 owner reply resolved.'));
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

it('routes owner shortcuts from roving rows, repeats focus requests and never submits option/drop/archive implicitly', async () => {
  const transport = await setup(transport => {
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.options = [
      { id: 'morning', label: 'Morning', consequence: 'Deliver before lunch.', recommended: true },
      { id: 'afternoon', label: 'Afternoon', consequence: 'Deliver after lunch.', recommended: false },
    ];
    // Item 3's in-flight reply would hide its actions while the agent has it.
    for (const input of Object.values(session.inputs)) if (input?.target.item_id === '3' && input.state === 'in_flight') input.state = 'cancelled';
  });
  // Async act drains shortcut navigation and focus work before querying the full app again. Item keys act on the selected item.
  const press = async (id: string, key: string) => {
    const row = await select(id);
    await act(async () => { row.focus(); fireEvent.keyDown(row, { key }); });
  };
  // r opens the answer in Details (the tree row has no answer box; a is Ack only); the number keys then change the picked option.
  await press('2', 'r');
  await waitFor(() => expect(document.querySelector('.shell-detail-scroll .detail-answer-slot .answer')).not.toBeNull());
  await press('2', '2');
  await waitFor(() => expect(transport.preferences.drafts.some(value => value.target.item_id === '2' && value.selected_option_id === transport.sessions.get(route.session_id)!.items['2']!.options[1].id)).toBe(true));
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
  await press('8', 'r'); await screen.findByLabelText('Reply message'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply message')));
  const theme = screen.getByLabelText('Switch to light');
  await act(async () => { theme.focus(); fireEvent.keyDown(theme, { key: 'r' }); });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply message')));
  fireEvent.keyDown(screen.getByLabelText('Reply message'), { key: 'g' }); expect(screen.getByRole('tree')).toBeTruthy();
  await press('3', 'r'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Note message')));
  await press('6', 'r'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Follow-up message')));
  // A replaced item stays replaced, so o on #7 sends nothing.
  await press('7', 'o');
  await press('8', 'd'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Drop reason')));
  // e (archive topic) is unbound (SPEC 7, Removed): it opens nothing.
  await press('8', 'e'); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
}, 10_000);
it('sends Back to Open as one press from the o shortcut (Ariadne.dc.html:1207)', async () => {
  const transport = await setup();
  const row = await select('1');
  row.focus(); fireEvent.keyDown(row, { key: 'o' });
  await waitFor(() => expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(1));
  expect(transport.mutations.find(value => value.command.command === 'input_submit')!.command)
    .toMatchObject({ params: { kind: 'reopen', text: 'Let’s reopen this: Keep the full reply history?', target: { item_id: '1' } } });
});
// Converted: a used to answer the oldest waiting item when the selected item was not waiting. a is Ack only now (SPEC 6.1, 7 "Removed"),
// so on an item with nothing to ack it opens no answer anywhere and sends nothing.
it('does not open the oldest waiting question when a is pressed on an item that is not waiting', async () => {
  const transport = await setup(); const row = await select('4');
  row.focus(); fireEvent.keyDown(row, { key: 'a' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(document.querySelector('[data-detail-item-id="4"]')).not.toBeNull();
  expect(document.querySelector('[data-detail-item-id="2"]')).toBeNull(); expect(document.querySelector('.shell-detail-scroll .detail-answer-slot .answer')).toBeNull();
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});

it('queues a fresh Bring once with its visible fixed text and reveals its receipt on repeat', async () => {
  const transport = await setup(), row = await select('4');
  row.focus(); fireEvent.keyDown(row, { key: 'b' }); fireEvent.keyDown(row, { key: 'b' }); fireEvent.keyDown(row, { key: 'b', repeat: true });
  await waitFor(() => expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(1));
  expect(transport.mutations.find(value => value.command.command === 'input_submit')!.command).toMatchObject({ params: { kind: 'bring', text: 'Bring this up.', target: { item_id: '4' } } });
  await waitFor(() => expect(within(screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' })).getByRole('region', { name: 'Your request' })).toBeTruthy());
  row.focus(); fireEvent.keyDown(row, { key: 'b' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(1);
}, 10_000);
it.each([false, true])('opens the item over an existing Bring draft without editing/submitting/retrying it (attempted %s)', async attempted => {
  const transport = await setup(transport => {
    const session = transport.sessions.get(route.session_id)!, item = session.items['4']!;
    transport.preferences.drafts.push({ op_id: '00000000-0000-4000-8000-000000001234', session: route, binding_id: session.active_binding_id!,
      target: { topic_id: item.topic_id, item_id: item.id }, target_revision: item.revision, question_revision: item.question_revision,
      intent: 'bring', selected_option_id: null, text: 'Keep my deliberate text.', supersedes_answer_id: null, submission_attempted: attempted });
  });
  const before = structuredClone(transport.preferences.drafts[0]);
  const row = await select('4'); row.focus(); fireEvent.keyDown(row, { key: 'b' });
  // Bring it up is one press in the handoff; the detail has no Bring editor to reveal the draft in.
  expect(await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' })).toBeTruthy();
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
  const transport = await setup(), row = await select('4'), pending = await delayedReveal(transport);
  row.focus(); fireEvent.keyDown(row, { key }); await waitFor(() => expect(pending.started()).toBe(true));
  await goToPage('All sessions');
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
  await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' }); const pending = await delayedReveal(transport);
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
  const row = await select('2');
  row.focus(); fireEvent.keyDown(row, { key: '2' });
  await waitFor(() => expect(document.querySelector('.shell-detail-scroll .detail-answer-slot .answer')).not.toBeNull());
  const detail = within(document.querySelector('.shell-detail-scroll')!);
  expect(detail.getByRole('button', { name: /^Afternoon/ }).hasAttribute('disabled')).toBe(true);
  expect(detail.getByRole('button', { name: /^Morning/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.keyDown(detail.getByRole('group', { name: 'Answer' }), { key: '2' });
  expect(transport.preferences.drafts[0].selected_option_id).toBe('morning');
  fireEvent.click(detail.getByRole('button', { name: 'Review this question' }));
  await waitFor(() => expect(transport.preferences.drafts[0].selected_option_id).toBeNull());
  expect(detail.getByRole('button', { name: /^Afternoon/ }).getAttribute('aria-pressed')).toBe('false');
  row.focus(); fireEvent.keyDown(row, { key: '2' });
  await waitFor(() => expect(transport.preferences.drafts[0].selected_option_id).toBe('afternoon'));
  expect(transport.preferences.drafts[0].text).toBe('Retain deliberate draft.');
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});
it('consumes a numeric request so detail remount preserves the owner’s later choice', async () => {
  const transport = await setup(transport => { transport.sessions.get(route.session_id)!.items['2']!.options = [
    { id: 'morning', label: 'Morning', consequence: 'Before lunch.', recommended: true }, { id: 'afternoon', label: 'Afternoon', consequence: 'After lunch.', recommended: false }]; });
  const row = await select('2');
  row.focus(); fireEvent.keyDown(row, { key: '2' });
  const saved = () => transport.preferences.drafts.find(value => value.intent === 'answer' && value.target.item_id === '2')!;
  await waitFor(() => expect(saved().selected_option_id).toBe('afternoon'));
  const editor = document.querySelector<HTMLElement>('.shell-detail-scroll .detail-answer-slot .answer')!;
  fireEvent.click(within(editor).getByRole('button', { name: /^Morning/ })); await waitFor(() => expect(saved().selected_option_id).toBe('morning'));
  // Esc in the answer returns focus to the row (Ariadne.dc.html:1412); Esc there closes detail.
  fireEvent.keyDown(editor, { key: 'Escape' }); expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  fireEvent.click(row); await waitFor(() => expect(document.querySelector('.shell-detail-scroll .detail-answer-slot .answer')).not.toBeNull());
  expect(within(document.querySelector('.shell-detail-scroll')!).getByRole('button', { name: /^Morning/ }).getAttribute('aria-pressed')).toBe('true');
  expect(saved().selected_option_id).toBe('morning');
});

it.each(['r', 'b'])('failed preference navigation cannot authorize %s focus or Bring submission', async key => {
  const transport = await setup(), invoke = transport.invoke.bind(transport);
  // The item is selected (item keys act on the selection) with its detail closed, so the key has to reopen it through a navigation save.
  const row = await select('4'); fireEvent.keyDown(row, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'preferences_patch') {
      return { api_version: 1, ok: false, error: { code: 'commit_uncertain', message: 'Navigation save unknown.', hint: 'Reconcile explicitly.', retryable: true, field_errors: [] } };
    }
    return invoke(name, args);
  });
  row.focus(); fireEvent.keyDown(row, { key });
  await screen.findByText('Ariadne isn’t sure that change was saved.');
  expect(screen.queryByLabelText('Reply message')).toBeNull(); expect(screen.queryByLabelText('Bring up message')).toBeNull();
  expect(document.activeElement).toBe(row); expect(transport.preferences.drafts).toEqual([]);
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
});
it.each([{ key: 'r', id: '4' }, { key: 'b', id: '4' }, { key: 'r', id: '3' }, { key: 'b', id: '3' }])('keeps a dismissed detail closed when dispatched $key selects #$id', async ({ key, id }) => {
  // Item keys act on the selected item only (SPEC 6.1), so the item is selected first; the key then runs for it.
  const transport = await setup(); await select(id);
  await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe(id));
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
  expect(transport.mutations.slice(beforeMutations).filter(request => request.command.command !== 'preferences_patch'
    || request.command.params.entries.some(entry => entry.kind !== 'mark_seen'))).toHaveLength(1);
  expect(transport.preferences.drafts).toEqual([]);
  fireEvent.click(row); expect(await screen.findByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${id}"]` })).toBeTruthy();
});
it('keeps detail dismissed when shortcut navigation session read completes afterward', async () => {
  const transport = await setup(); fireEvent.click(document.querySelector('[data-item-id="4"]')!); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
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
// Converted: the a key used to answer the oldest waiting question, in another session when this one had none. a is Ack only now, and the
// switcher (⌘O) is how a waiting question in another session is reached (SPEC 6.5), so the dispatched session change comes from there.
it('keeps detail dismissed after a dispatched switcher choice changes session, then opens deliberate navigation back', async () => {
  const transport = await setup(value => {
    const first = value.sessions.get(route.session_id)!, second = structuredClone(first);
    // The other session waits on the same question, with nothing sent yet, so the dock lists it.
    second.id = secondId; second.title = 'Separate session'; second.inputs = {}; value.sessions.set(secondId, second);
    first.items['2']!.status = 'open';
  });
  fireEvent.click(document.querySelector('[data-item-id="4"]')!); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
  await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('4'));
  const invoke = transport.invoke.bind(transport); let dispatched = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'preferences_patch'
      && args.request.command.params.entries.some(entry => entry.kind === 'set_global')) { dispatched = true; await gate; }
    return invoke(name, args);
  });
  const control = screen.getByRole('button', { name: 'Switch to light' });
  control.focus(); fireEvent.keyDown(control, { key: 'o', metaKey: true });
  const switcher = await screen.findByRole('dialog', { name: 'Switch session or project' });
  fireEvent.click(within(switcher).getByRole('option', { name: /Which delivery window/ })); await waitFor(() => expect(dispatched).toBe(true));
  fireEvent.keyDown(control, { key: 'Escape' }); expect(document.querySelector('.shell-detail')).toBeNull();
  await act(async () => { release(); await gate; await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
  // The dock opens at the question (SPEC 6.5); Details stays shut.
  await waitFor(() => expect(screen.getByRole('region', { name: 'Answer dock' }).getAttribute('data-open')).toBe('true'));
  expect(document.querySelector('.answer-dock-current')).not.toBeNull();
  expect(document.querySelector('.shell-detail')).toBeNull(); const focusStayed = document.activeElement === control;
  expect(transport.preferences.drafts).toEqual([]);
  await goToSession(route);
  expect(await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' })).toBeTruthy();
  // Last, so a lost focus does not hide the checks above. Focus stays where the owner was; the dispatched change does not take it.
  expect(focusStayed).toBe(true);
});
