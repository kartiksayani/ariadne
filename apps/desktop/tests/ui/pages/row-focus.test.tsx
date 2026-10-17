// Rename and Close from a page row hand focus back to that row when they finish: the keyboard owner stays where they were.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';

afterEach(() => { cleanup(); notices.clear(); });

async function allSessions() {
  const transport = new AppTransport();
  render(<DesktopApp service={createDesktopService(transport)} />);
  const list = await screen.findByRole('region', { name: 'All sessions' });
  await waitFor(() => expect(within(list).getByRole<HTMLButtonElement>('button', { name: 'Rename Notes review' }).disabled).toBe(false));
  return { transport, list };
}
const rowOf = (id: string) => document.querySelector<HTMLElement>(`button[data-session-id="${id}"]`)!.closest<HTMLElement>('.sl-row')!;

describe('focus after a row action', () => {
  it('Rename: focus returns to the same row, whose button survives the new name', async () => {
    const { list } = await allSessions();
    const rename = within(list).getByRole<HTMLButtonElement>('button', { name: 'Rename Notes review' });
    const row = rowOf(route.session_id);
    rename.focus();
    fireEvent.click(rename);
    const dialog = await screen.findByRole('dialog', { name: 'Name this session' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Zebra review' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /^Save name/ })); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull());
    await within(list).findByRole('button', { name: 'Rename Zebra review' });
    expect(rowOf(route.session_id)).toBe(row);
    await waitFor(() => expect(row.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON').toBe(true));
  });

  it('Close: focus returns to the row, though the closed row moves and its Close button turns off', async () => {
    const { list, transport } = await allSessions();
    const close = within(list).getByRole<HTMLButtonElement>('button', { name: 'Close Notes review' });
    const row = rowOf(route.session_id);
    close.focus();
    fireEvent.click(close);
    const review = await screen.findByRole('dialog', { name: /^Close / });
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Close session' })); });
    await waitFor(() => expect(transport.mutations.map(request => request.command.command)).toContain('session_close'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Close / })).toBeNull());
    await waitFor(() => expect(within(list).getByRole<HTMLButtonElement>('button', { name: 'Close Notes review' }).disabled).toBe(true));
    expect(rowOf(route.session_id)).toBe(row);
    await waitFor(() => expect(row.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON').toBe(true));
  });
});
