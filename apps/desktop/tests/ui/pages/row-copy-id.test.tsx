// A row of the sessions list copies exactly what the connection card copies: the session's ID, for /ariadne-connect.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { copyText } from '../../../src/ui/shared/clipboard';
import { AppTransport, route } from '../app/transport';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));

afterEach(() => { cleanup(); notices.clear(); vi.mocked(copyText).mockReset(); });

describe('Copy session ID on a list row', () => {
  it('copies the row\'s session ID and says so', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    render(<DesktopApp service={createDesktopService(new AppTransport())} />);
    const list = await screen.findByRole('region', { name: 'All sessions' });
    const copy = await within(list).findByRole<HTMLButtonElement>('button', { name: 'Copy session ID of Notes review' });
    await waitFor(() => expect(copy.disabled).toBe(false));
    await act(async () => { fireEvent.click(copy); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
    expect(copy.title).toBe('Copied');
    expect(notices.getSnapshot().some(notice => notice.text === 'Connection reference copied.')).toBe(true);
  });
});
