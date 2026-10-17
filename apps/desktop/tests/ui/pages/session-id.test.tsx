// Copy session ID has one home, the connection card of the session on screen (SPEC 14.2: the All sessions row no longer copies it).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { copyText } from '../../../src/ui/shared/clipboard';
import { AppTransport, route } from '../app/transport';
import { notices } from '../../../src/ui/pages/notices';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); notices.clear(); vi.resetAllMocks(); });

describe('session ID actions', () => {
  it('lists a session without its ID or a Copy ID action, then copies it from the connection card once opened', async () => {
    const transport = new AppTransport();
    render(<DesktopApp service={createDesktopService(transport)} />);
    const list = await screen.findByRole('region', { name: 'All sessions' });
    vi.mocked(copyText).mockResolvedValue(undefined);
    await within(list).findByRole('button', { name: 'Rename Notes review' });
    expect(within(list).queryByRole('button', { name: /^Copy the ID of/ })).toBeNull();
    // (Rows carry the ID only as a data-session-id hook for tests and automation, never as text.)
    expect(list.textContent).not.toContain(route.session_id);
    expect(copyText).not.toHaveBeenCalled();
    fireEvent.click([...list.querySelectorAll<HTMLButtonElement>('.sl-name')].find(button => button.textContent === 'Notes review')!);
    await screen.findByRole('region', { name: 'Session tree' });
    const bar = document.querySelector<HTMLElement>('.tb')!;
    expect(bar.innerHTML).not.toContain(route.session_id);
    await waitFor(() => expect(bar.querySelector('[data-popover-trigger="connection"]')).not.toBeNull());
    fireEvent.click(bar.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]')!);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy session ID' })); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toContain('Connection reference copied.'));
    expect(bar.innerHTML).not.toContain(route.session_id);
  });
});
