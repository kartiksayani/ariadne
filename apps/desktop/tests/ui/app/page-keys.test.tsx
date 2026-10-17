// Item keys belong to the Map. While a page (Projects, All sessions, Archive) shows, the session the Map last showed
// stays selected in the background, and no key may act on it: no core call, no saved preference, no dialog, no focus move.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { goToPage, goToSession } from './open';
import { AppTransport, route } from './transport';

afterEach(() => { cleanup(); notices.clear(); });

const keys: readonly { readonly name: string; readonly key: string }[] = [
  { name: 'a', key: 'a' }, { name: 'd', key: 'd' }, { name: 'h', key: 'h' }, { name: 'z', key: 'z' }, { name: 'Backspace', key: 'Backspace' },
  { name: 'r', key: 'r' }, { name: 'b', key: 'b' }, { name: 'o', key: 'o' }, { name: 'Escape', key: 'Escape' },
  ...Array.from({ length: 9 }, (_, index) => ({ name: String(index + 1), key: String(index + 1) })),
];

describe.each(['Projects', 'All sessions', 'Archive'] as const)('item keys on the %s page', page => {
  it('do nothing to the session the Map last showed', async () => {
    const transport = new AppTransport();
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0]!, { tab_open: true, selected_item_id: '4' });
    render(<DesktopApp service={createDesktopService(transport)} />);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false);
    });
    await screen.findByRole('article', { name: /^Detail of / });
    await goToPage(page);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session tree' })).toBeNull());
    const before = { mutations: transport.mutations.length, preferences: JSON.stringify(transport.preferences) };
    for (const { key } of keys) {
      for (const target of [document.body, document.querySelector<HTMLElement>('main') ?? document.body]) fireEvent.keyDown(target, { key });
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(transport.mutations.length).toBe(before.mutations);
    expect(JSON.stringify(transport.preferences)).toBe(before.preferences);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Session tree' })).toBeNull();
    // Esc on a page must not have closed the Map's detail either: it is still open on return.
    await goToSession(route);
    await screen.findByRole('article', { name: /^Detail of / });
  }, 15_000);
});
