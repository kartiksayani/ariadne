import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup(configure?: (transport: AppTransport) => void) {
  const transport = new AppTransport(); configure?.(transport); render(<DesktopApp service={createDesktopService(transport)} />);
  const button = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(`[data-session-id="${route.session_id}"]`)!;
    expect(button).not.toBeNull(); expect(button.disabled).toBe(false); return button;
  });
  fireEvent.click(button); await screen.findByRole('tree', { name: 'Sentences' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause dispatch' }).hasAttribute('disabled')).toBe(false));
  return transport;
}
it('focuses search with Cmd+F outside editors and suppresses workspace shortcuts inside modal controls', async () => {
  await setup();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Theme: system' }), { key: 'f', metaKey: true });
  const search = screen.getByLabelText('Search questions and outcomes'); expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: 'g' }); expect(screen.getByRole('tree')).toBeTruthy();
  fireEvent.click(document.querySelector('[data-item-id="1"]')!); await screen.findByRole('group', { name: 'Owner actions' });
  const pause = screen.getByRole('button', { name: 'Pause dispatch' }); pause.focus(); fireEvent.click(pause);
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
    fireEvent.click(screen.getByRole('button', { name: 'Theme: system' })); await screen.findByRole('button', { name: 'Theme: light' });
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
  press('2', 'a');
  await waitFor(() => expect(document.activeElement?.closest('[aria-label="Owner input for #2"]')).not.toBeNull());
  press('2', '2');
  await waitFor(() => expect(transport.preferences.drafts.some(value => value.target.item_id === '2' && value.selected_option_id === transport.sessions.get(route.session_id)!.items['2']!.options[1].id)).toBe(true));
  expect(transport.mutations.filter(value => value.command.command === 'input_submit')).toHaveLength(0);
  press('4', 'r'); await screen.findByLabelText('Reply message'); await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Reply message')));
  screen.getByRole('button', { name: 'Theme: system' }).focus(); fireEvent.keyDown(document.activeElement!, { key: 'r' });
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
  await waitFor(() => expect(document.activeElement?.closest('[aria-label="Owner input for #2"]')).not.toBeNull());
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
