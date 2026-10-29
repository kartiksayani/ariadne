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
  // The top bar's funnel (badge 1: Open is picked) shows the chip row. Its summary explains the statuses only; the search's
  // count is the top bar's (SPEC §4: a search finds in place).
  fireEvent.click(await screen.findByRole('button', { name: /^Filter by status, 1 status picked/ }));
  const filterRow = await screen.findByRole('group', { name: 'Filter items' });
  expect(within(filterRow).getByText('Showing 3 of 9 items')).toBeTruthy();
  await waitFor(() => expect(document.querySelector('.tb-search-count')?.textContent).toBe('1 of 1'));
  // The top bar's search box shows while it holds words; an empty search is the closed "Search the Map" button.
  const searchValue = () => document.querySelector<HTMLInputElement>('.tb-search-input')?.value ?? '';
  expect(searchValue()).toBe('receipt');
  fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
  expect(searchValue()).toBe('');
  expect(document.querySelector('.tb-search-count')).toBeNull();
  expect(within(filterRow).getByText('Showing 3 of 9 items')).toBeTruthy();
  await waitFor(() => expect(transport.preferences.sessions[0]!.filters.search).toBe(''));
  expect(transport.preferences.sessions[0]!.filters.statuses).toEqual(['open']);
  // Open is still picked.
  expect(within(filterRow).getByRole('button', { name: /^Open \d+$/ }).getAttribute('aria-pressed')).toBe('true');
});

it('saves an explicit clear before switching to another session and typing there', async () => {
  const transport = new AppTransport();
  transport.preferences.sessions[0]!.filters.search = 'receipt';
  transport.preferences.sessions[0]!.filters.statuses = ['open'];
  transport.preferences.sessions.push(transport.view(secondId));
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  const clear = await screen.findByRole<HTMLButtonElement>('button', { name: 'Clear the search' });
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

it('lights a note hit in Details from the top bar search, and stops when the search clears', async () => {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  session.items['8']!.note = 'Needs the zebra export too.';
  transport.preferences.sessions[0]!.filters.search = 'zebra export';
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  fireEvent.click(await screen.findByText(session.items['8']!.question));
  const notes = await screen.findByRole('region', { name: 'Notes' });
  await waitFor(() => expect([...notes.querySelectorAll('.tree-hit')].map(hit => hit.textContent)).toEqual(['zebra', 'export']));
  // The Map row names the same match.
  expect(document.querySelector('[data-row="8"] .tree-note-hit')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
  await waitFor(() => expect(notes.querySelector('.tree-hit')).toBeNull());
});
