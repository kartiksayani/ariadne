import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from './transport';
import { goToSession } from './open';

afterEach(cleanup);

it('explains a saved search and clears it in the box and saved view while keeping status chips', async () => {
  const transport = new AppTransport(), view = transport.preferences.sessions[0]!;
  view.filters.search = 'receipt';
  view.filters.statuses = ['open'];
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  expect(await screen.findByText('Showing 1 of 9 items matching “receipt” in the statuses you picked')).toBeTruthy();
  // The top bar's search box shows while it holds words; an empty search is the closed "Search the Map" button.
  const searchValue = () => document.querySelector<HTMLInputElement>('.tb-search-input')?.value ?? '';
  expect(searchValue()).toBe('receipt');
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(searchValue()).toBe('');
  expect(screen.queryByText(/items matching/)).toBeNull();
  await waitFor(() => expect(transport.preferences.sessions[0]!.filters.search).toBe(''));
  expect(transport.preferences.sessions[0]!.filters.statuses).toEqual(['open']);
  // The top bar's funnel (badge 1: Open is still picked) shows the filter row; its menu lists the picked status.
  fireEvent.click(screen.getByRole('button', { name: /^Filter by status, 1 status picked/ }));
  fireEvent.click(within(await screen.findByRole('group', { name: 'Filter items' })).getByRole('button', { name: /^Filter/ }));
  expect(screen.getByRole('menuitemcheckbox', { name: /^Open/ }).getAttribute('aria-checked')).toBe('true');
});

it('saves an explicit clear before switching to another session and typing there', async () => {
  const transport = new AppTransport();
  transport.preferences.sessions[0]!.filters.search = 'receipt';
  transport.preferences.sessions[0]!.filters.statuses = ['open'];
  transport.preferences.sessions.push(transport.view(secondId));
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  const clear = await screen.findByRole<HTMLButtonElement>('button', { name: 'Clear search' });
  await waitFor(() => expect(clear.disabled).toBe(false));
  fireEvent.click(clear);
  // Switch from the top bar's switcher (SPEC 5.13).
  const switcher = document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]')!;
  await waitFor(() => expect(switcher.disabled).toBe(false));
  fireEvent.click(switcher);
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Switch session or project' })).getByRole('option', { name: /Separate session/ }));
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).textContent).toContain('No items yet'));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Search the Map' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Search the Map' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Search the Map' }), { target: { value: 'Something else' } });
  await waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)!.filters.search).toBe('Something else'));
  const first = transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
  expect(first.filters.search).toBe('');
  expect(first.filters.statuses).toEqual(['open']);
});
