import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { copyText } from '../../../src/ui/shared/clipboard';
import { SessionBar } from '../../../src/ui/tree/SessionBar';
import { sessionBar } from '../../../src/ui/tree/model';
import { AppTransport, route } from '../app/transport';
import { sessionButton } from '../app/open';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('session ID actions', () => {
  it.each(['active', 'closed'] as const)('copies from the %s session bar without displaying the ID', async state => {
    const session = new AppTransport().sessions.get(route.session_id)!;
    session.state = state;
    const { container } = render(<SessionBar bar={sessionBar(session, null, Date.now())!} busy={false} onClose={() => {}} />);
    expect(container.innerHTML).not.toContain(route.session_id);
    vi.mocked(copyText).mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy ID' })); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
    expect(screen.getByRole('menuitem', { name: 'Copied' }).querySelector('.ph-check')).not.toBeNull();
    expect(container.innerHTML).not.toContain(route.session_id);
  });

  it('copies the listed session before opening its tab, then copies it from its bar', async () => {
    const transport = new AppTransport();
    render(<DesktopApp service={createDesktopService(transport)} />);
    const open = await sessionButton(route), card = open.closest('.pw-session-card') as HTMLElement;
    expect(card.textContent).not.toContain(route.session_id);
    vi.mocked(copyText).mockResolvedValue(undefined);
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Copy ID' })); });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(route.session_id);
    expect(within(card).getByRole('button', { name: 'Copied' }).querySelector('.ph-check')).not.toBeNull();
    fireEvent.click(open);
    await screen.findByRole('region', { name: 'Session tree' });
    const bar = screen.getByLabelText('Session');
    expect(bar.textContent).not.toContain(route.session_id);
    fireEvent.click(within(bar).getByRole('button', { name: 'Session actions' }));
    await act(async () => { fireEvent.click(within(bar).getByRole('menuitem', { name: 'Copy ID' })); });
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenLastCalledWith(route.session_id);
    expect(within(bar).getByRole('menuitem', { name: 'Copied' }).querySelector('.ph-check')).not.toBeNull();
    expect(bar.textContent).not.toContain(route.session_id);
  });
});
