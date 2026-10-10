import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from './transport';
import { sessionButton } from './open';

afterEach(cleanup);

it('explains a saved search and clears it in the box and saved view while keeping status chips', async () => {
  const transport = new AppTransport(), view = transport.preferences.sessions[0]!;
  view.filters.search = 'receipt';
  view.filters.statuses = ['open'];
  render(<DesktopApp service={createDesktopService(transport)} />);
  fireEvent.click(await sessionButton(route));
  expect(await screen.findByText('Showing 1 of 9 items matching “receipt” in the statuses you picked')).toBeTruthy();
  const search = document.querySelector<HTMLInputElement>('[data-shell-search]')!;
  expect(search.value).toBe('receipt');
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search.value).toBe('');
  expect(screen.queryByText(/items matching/)).toBeNull();
  await waitFor(() => expect(transport.preferences.sessions[0]!.filters.search).toBe(''));
  expect(transport.preferences.sessions[0]!.filters.statuses).toEqual(['open']);
  fireEvent.click(screen.getByRole('button', { name: 'Filter: Open' }));
  expect(screen.getByRole('menuitemcheckbox', { name: /^Open/ }).getAttribute('aria-checked')).toBe('true');
});

it('saves an explicit clear before switching to another session and typing there', async () => {
  const transport = new AppTransport();
  transport.preferences.sessions[0]!.filters.search = 'receipt';
  transport.preferences.sessions[0]!.filters.statuses = ['open'];
  transport.preferences.sessions.push(transport.view(secondId));
  render(<DesktopApp service={createDesktopService(transport)} />);
  fireEvent.click(await sessionButton(route));
  const clear = await screen.findByRole<HTMLButtonElement>('button', { name: 'Clear search' });
  await waitFor(() => expect(clear.disabled).toBe(false));
  fireEvent.click(clear);
  const next = document.querySelector<HTMLButtonElement>(`[data-session-tab='${JSON.stringify([route.project_id, secondId])}']`)!;
  await waitFor(() => expect(next.disabled).toBe(false));
  fireEvent.click(next);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).textContent).toContain('No items yet'));
  fireEvent.change(document.querySelector<HTMLInputElement>('[data-shell-search]')!, { target: { value: 'Something else' } });
  await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)!.filters.search).toBe('Something else'));
  const first = transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
  expect(first.filters.search).toBe('');
  expect(first.filters.statuses).toEqual(['open']);
});
