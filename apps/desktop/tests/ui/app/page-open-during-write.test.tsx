// While an owner write is held (a theme or seen save), a session name on a page still opens the session: it queues
// behind the write as the newest navigation, as the switcher does. Rename, Close and Archive keep waiting for the write.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { goToPage } from './open';
import { HeldTransport } from './held';
import { secondId } from './transport';

afterEach(() => { cleanup(); notices.clear(); });

/** The session-name button on each page, and the session it opens. */
const nameButton = { Projects: ['.pj-sess', 'Notes review'], 'All sessions': ['.sl-name', 'Notes review'], Archive: ['.ar-open', 'Separate session'] } as const;
const nameOn = (page: keyof typeof nameButton) => {
  const [selector, text] = nameButton[page];
  return [...document.querySelectorAll<HTMLButtonElement>(selector)].find(button => button.textContent?.includes(text));
};

describe.each(['Projects', 'All sessions', 'Archive'] as const)('the %s page during a held save', page => {
  it('opens the session when its name is clicked', async () => {
    const transport = new HeldTransport();
    transport.preferences.global.selected_navigation = { kind: page === 'Projects' ? 'projects' : 'all_sessions' };
    if (page === 'Archive') transport.sessions.get(secondId)!.archived_at = '2026-01-01T00:00:00Z';
    render(<DesktopApp service={createDesktopService(transport)} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false));
    await goToPage(page);
    await waitFor(() => expect(nameOn(page)).toBeDefined());
    const name = nameOn(page)!;
    let release!: () => void;
    transport.hold = new Promise<void>(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: /^Switch to (light|dark)$/ }));
    await waitFor(() => expect(transport.held).toBe(1));
    fireEvent.click(name);
    await screen.findByText('Opening the session…');
    await act(async () => { release(); });
    await screen.findByRole('region', { name: 'Session tree' });
    await waitFor(() => expect(screen.queryByText('Opening the session…')).toBeNull());
  }, 15_000);
});
