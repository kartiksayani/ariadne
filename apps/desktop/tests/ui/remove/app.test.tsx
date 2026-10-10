// Remove through the composed app: the detail trash and ⌫ ask first, the row goes
// at once, Undo brings it back, and leaving the page runs the command.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { sessionButton } from '../app/open';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);

it('removes an item from the detail trash or ⌫ after asking, with Undo, and runs it when the page goes', async () => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  fireEvent.click(await sessionButton(route)); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
    });
  fireEvent.click(row('4')!);
  const trash = await screen.findByRole('button', { name: 'Remove item' });
  fireEvent.click(trash);
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByText(/This item is removed from Ariadne\. .+ is told, so it stops working on it/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove item' }));
  await waitFor(() => expect(row('4')).toBeNull());
  expect(screen.getByText(/is told in 5 seconds unless you undo\.$/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(row('4')).not.toBeNull());
  expect(transport.mutations.some(request => request.command.command === 'item_remove')).toBe(false);

  row('4')!.focus(); fireEvent.keyDown(row('4')!, { key: 'Delete' });
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove item' }));
  await waitFor(() => expect(row('4')).toBeNull());
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  await waitFor(() => expect(transport.mutations.find(request => request.command.command === 'item_remove')).toMatchObject({
    session: route, command: { params: { item_id: '4', expected_revision: 1 } } }));
  await waitFor(() => expect(screen.getByText(/was told and won’t bring it up again\.$/)).toBeTruthy());
  expect(row('4')).toBeNull();
});
