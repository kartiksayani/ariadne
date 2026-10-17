// A question chosen from the top bar opens the dock on it even when the navigation waits behind an owner write for
// longer than the 1 s the click hands control back after.
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { goToPage } from './open';
import { HeldTransport } from './held';
import { route } from './transport';

afterEach(() => { cleanup(); notices.clear(); });

it('ends with the dock open on the question after a navigation held for more than a second', async () => {
  const transport = new HeldTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false);
  });
  await goToPage('Projects');
  const chip = await screen.findByRole('button', { name: /waiting (here|in this session)/ });
  let release!: () => void;
  transport.hold = new Promise<void>(resolve => { release = resolve; });
  fireEvent.click(screen.getByRole('button', { name: /^Switch to (light|dark)$/ }));
  await waitFor(() => expect(transport.held).toBe(1));
  fireEvent.click(chip);
  await screen.findByText('Opening the session…');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)); });
  await act(async () => { release(); });
  const dock = await screen.findByRole('region', { name: 'Answer dock' });
  await waitFor(() => expect(dock.getAttribute('data-open')).toBe('true'));
}, 15_000);
