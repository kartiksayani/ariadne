// Remove through the composed app: the detail trash and ⌫ ask first, the row goes
// at once, Undo brings it back, and leaving the page runs the command.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { goToSession } from '../app/open';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);

const ready = async () => {
  await goToSession(route); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
  });
};
const removeKey = async (id: string) => {
  fireEvent.click(row(id)!);
  await waitFor(() => expect(row(id)!.getAttribute('aria-selected')).toBe('true'));
  row(id)!.focus(); fireEvent.keyDown(row(id)!, { key: 'Delete' });
};
const strip = (name: RegExp) => screen.findByRole('button', { name });

// Never lose typed text (E28): each row's words are quoted with Copy before the command runs, or it goes at once only
// when there are none. Fixture: item 4 has a cancelled note and a queued drop; item 1 has a cancelled answer and 1.1 below.
it.each([
  ['a leaf with none of your words goes at once', '8', null, 0],
  ['a leaf with words asks, quoting each one', '4', 'Remove item', 2],
  ['a parent asks, listing what goes together', '1', 'Remove 2 items', 1],
] as const)('%s', async (_, id, confirm, quotes) => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  await ready();
  await removeKey(id);
  if (confirm) {
    const dialog = await screen.findByRole('dialog', { name: /^Remove “/ });
    expect(within(dialog).getAllByTestId('dialog-quote')).toHaveLength(quotes);
    expect(within(dialog).getAllByRole('button', { name: 'Copy' })).toHaveLength(quotes);
    if (id === '1') expect(within(dialog).getByRole('region', { name: 'Removed together' }).querySelectorAll('li')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
  } else expect(screen.queryByRole('dialog')).toBeNull();
  // The rows give way to one strip in their place; the toast says when the agent is told.
  await waitFor(() => expect(row(id)).toBeNull());
  await strip(/^Removed “/);
  expect(screen.getByTestId('toast').textContent).toMatch(/is told in 5 s\./);
  expect(transport.mutations.some(request => request.command.command === 'item_remove')).toBe(false);
}, 10_000);

it('the strip undoes; leaving the page runs the command and the strip goes', async () => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  await ready();
  await removeKey('8');
  fireEvent.click(await strip(/^Removed “/));
  await waitFor(() => expect(row('8')).not.toBeNull());
  expect(screen.queryByRole('button', { name: /^Removed “/ })).toBeNull();
  await removeKey('8');
  await strip(/^Removed “/);
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  await waitFor(() => expect(transport.mutations.find(request => request.command.command === 'item_remove')).toMatchObject({
    session: route, command: { params: { item_id: '8' } } }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Removed “/ })).toBeNull());
  expect(row('8')).toBeNull();
}, 10_000);
