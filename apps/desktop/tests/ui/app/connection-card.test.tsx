// The connection card (SPEC 5.12) in the composed app: the session bar's Close, Reopen, Restore, Copy ID and dispatch
// chip moved here. Each acts through the session's lifecycle (C3) on the session the top bar shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { copyText } from '../../../src/ui/shared/clipboard';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from './transport';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); notices.clear(); vi.resetAllMocks(); });

const session = (transport: AppTransport) => transport.sessions.get(route.session_id)!;
const commands = (transport: AppTransport) => transport.mutations.map(request => request.command.command).filter(name => name.startsWith('session_'));
const dot = () => document.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]')!;

async function setup(change: (transport: AppTransport) => void = () => {}) {
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
  change(transport);
  render(<DesktopApp service={createDesktopService(transport)} />);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(dot()).not.toBeNull();
    expect(dot().disabled).toBe(false);
  });
  return transport;
}
/** Opens the card from the dot by the session name. */
async function openCard() {
  fireEvent.click(dot());
  await waitFor(() => expect(document.querySelector('.cc')).not.toBeNull());
  return within(document.querySelector<HTMLElement>('.cc')!);
}

describe('connection card session actions (were the session bar’s)', { timeout: 15_000 }, () => {
  it('Copy session ID copies the reference without showing it, says so, and keeps the card open', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    await setup();
    const view = await openCard();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Copy session ID' })); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Connection reference copied.']));
    expect(view.getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(document.querySelector('.cc')!.innerHTML).not.toContain(route.session_id);
    expect(document.querySelector('.tb')!.innerHTML).not.toContain(route.session_id);
  });

  it('Close session closes the card, asks once through the lifecycle review, then offers Reopen', async () => {
    const transport = await setup();
    const view = await openCard();
    fireEvent.click(view.getByRole('button', { name: 'Close session' }));
    expect(document.querySelector('.cc')).toBeNull();
    const review = await screen.findByRole('dialog', { name: /^Close / });
    expect(commands(transport)).toEqual([]);
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Close session' })); });
    await waitFor(() => expect(commands(transport)).toEqual(['session_close']));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Close / })).toBeNull());
    await waitFor(() => expect(dot().getAttribute('aria-label')).toMatch(/^Closed/));
    const after = await openCard();
    expect(after.queryByRole('button', { name: 'Close session' })).toBeNull();
    expect(after.getByRole('button', { name: 'Reopen session' })).toBeTruthy();
  });

  it('Reopen session on a closed session asks, then reopens it', async () => {
    const transport = await setup(value => { session(value).state = 'closed'; session(value).closed_at = session(value).updated_at; });
    const view = await openCard();
    expect(view.queryByRole('button', { name: 'Close session' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Reopen session' }));
    const review = await screen.findByRole('dialog', { name: 'Reopen this session?' });
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Reopen session' })); });
    await waitFor(() => expect(commands(transport)).toEqual(['session_reopen']));
  });

  it('on an archived session the card says Restore session, and it restores at once', async () => {
    const transport = await setup(value => {
      session(value).state = 'closed'; session(value).closed_at = session(value).updated_at; session(value).archived_at = session(value).updated_at;
    });
    const view = await openCard();
    expect(view.queryByRole('button', { name: 'Reopen session' })).toBeNull();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Restore session' })); });
    await waitFor(() => expect(commands(transport)).toEqual(['session_restore']));
    expect(screen.queryByRole('dialog', { name: /^Reopen/ })).toBeNull();
  });

  it('with no agent connected and no setup receipt, the line’s steps have no Copy instruction and say what to do instead', async () => {
    await setup(value => { session(value).active_binding_id = null; });
    const line = await screen.findByRole('status', { name: 'Connection' });
    fireEvent.click(within(line).getByRole('button', { name: 'How to connect' }));
    expect(within(line).getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(within(line).queryByRole('button', { name: 'Copy instruction' })).toBeNull();
    expect(line.textContent).toContain('Using Codex? Choose “Connect existing session” on the project’s page');
  });

  it('while a session change is unconfirmed, Copy stays and Close waits', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const transport = await setup();
    transport.failNext = 'session_close';
    fireEvent.click((await openCard()).getByRole('button', { name: 'Close session' }));
    const review = await screen.findByRole('dialog', { name: /^Close / });
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Close session' })); });
    await waitFor(() => expect(within(review).getByRole('button', { name: 'Check again' })).toBeTruthy());
    fireEvent.click(within(review).getByRole('button', { name: 'Cancel' }));
    const view = await openCard();
    expect(view.queryByRole('button', { name: 'Close session' })).toBeNull();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Copy session ID' })); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
  });

  it('Cancel on the Close review gives focus back to the connection button the card came from', async () => {
    await setup();
    dot().focus();
    const view = await openCard();
    fireEvent.click(view.getByRole('button', { name: 'Close session' }));
    const review = await screen.findByRole('dialog', { name: /^Close / });
    fireEvent.click(within(review).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Close / })).toBeNull());
    expect(document.activeElement).toBe(dot());
  });

  it('a closed session opened from its All sessions row offers Reopen on its card, and Reopen works (SPEC 14.2: the row has none)', async () => {
    const transport = new AppTransport(), closed = session(transport);
    closed.state = 'closed'; closed.closed_at = closed.updated_at;
    render(<DesktopApp service={createDesktopService(transport)} />);
    const list = await screen.findByRole('region', { name: 'All sessions' });
    fireEvent.click(within(list).getByRole('button', { name: /^Closed/ }));
    const row = await waitFor(() => list.querySelector<HTMLElement>(`[data-session-id="${route.session_id}"]`)!.closest<HTMLElement>('.sl-row')!);
    expect(within(row).queryByRole('button', { name: /^Reopen/ })).toBeNull();
    expect(within(row).getByRole('button', { name: `Close ${row.querySelector('.sl-name')!.textContent}` }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(row.querySelector<HTMLButtonElement>('.sl-name')!);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
    const view = await openCard();
    fireEvent.click(view.getByRole('button', { name: 'Reopen session' }));
    const review = await screen.findByRole('dialog', { name: 'Reopen this session?' });
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Reopen session' })); });
    await waitFor(() => expect(commands(transport)).toEqual(['session_reopen']));
    await waitFor(() => expect(dot().getAttribute('aria-label')).not.toMatch(/^Closed/));
  });

  it('the top bar stays mounted across a session switch: the control that had focus keeps it', async () => {
    await setup();
    const theme = screen.getByRole('button', { name: /^Switch to (light|dark)$/ });
    theme.focus();
    fireEvent.keyDown(theme, { key: 'o', metaKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Switch session or project' });
    fireEvent.click(within(menu).getByRole('option', { name: /Separate session/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Switch session or project/ }).textContent).toContain('Separate session'));
    expect(theme.isConnected).toBe(true);
    expect(document.activeElement).toBe(theme);
  });

  it('Sending… opens the Sending dialog with Pause and Resume (was the dispatch chip)', async () => {
    const transport = await setup();
    const view = await openCard();
    fireEvent.click(view.getByRole('button', { name: 'Sending…' }));
    const sending = await screen.findByRole('dialog', { name: /^Sending to / });
    await act(async () => { fireEvent.click(within(sending).getByRole('button', { name: 'Pause sending' })); });
    expect(transport.mutations.map(request => request.command.command)).toContain('binding_pause');
    await waitFor(() => expect(sending.querySelector('dd[data-dispatch]')?.textContent).toBe('Paused (by you)'));
  });
});
