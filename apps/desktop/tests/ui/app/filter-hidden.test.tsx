// alpha.24 "filter with hidden items" through the whole app: the chip strip with every item hidden, "Show them" / "Hide them", the
// reveal's lifetime, saved and local chips, Focus, the Graph's note and the empty session (plan G1-G16).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { LOCAL_CHIPS_KEY } from '../../../src/selectors/tree/filter';
import { AppTransport, route } from './transport';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });

const saved = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)!;
const treeRow = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);
const funnel = () => screen.getByRole('button', { name: /^Filter by status/ });
const strip = () => {
  if (!screen.queryByRole('group', { name: 'Filter items' })) fireEvent.click(funnel());
  return screen.getByRole('group', { name: 'Filter items' });
};
const chip = (name: RegExp | string) => within(strip()).getByRole('button', { name });
const text = () => strip().textContent ?? '';
const EVERY = ['1', '2', '3', '4', '5', '6', '7', '8'];
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: /^Switch session or project/ })).toBeTruthy());
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(funnel().hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).hasAttribute('disabled')).toBe(false);
  });
}
async function mount(setup: (transport: AppTransport) => void = () => undefined) {
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  saved(transport).tab_open = true;
  setup(transport);
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' }); await ready();
  return transport;
}
/** The demo with every item hidden: 1 (done) with 1.1 (open), 2 (waiting), 3 (in progress), 4 (open), 5, 6, 7, and 8 (open) in the second topic. */
const allHidden = (transport: AppTransport) => { saved(transport).hidden_item_ids = [...EVERY]; };
async function pick(name: RegExp | string) { fireEvent.click(chip(name)); await ready(); }
const picked = (transport: AppTransport) => saved(transport).filters.statuses;

describe('the filter strip with every item hidden (G3)', () => {
  it('owner bug: draws a chip for each status the hidden items hold, each saying what is hidden, and Waiting on me still counts its question', async () => {
    await mount(allHidden);
    expect(text()).not.toBe('Pick a status');
    expect(chip('Open 0, 3 more hidden')).toBeTruthy();
    expect(chip('Done 0, 1 more hidden')).toBeTruthy();
    expect(chip('In progress 0, 1 more hidden')).toBeTruthy();
    expect(chip('Waiting on me 1')).toBeTruthy();
    expect(within(strip()).getByText('Pick a status')).toBeTruthy();
  });

  it('keeps a plain name for a chip with nothing hidden behind it', async () => {
    await mount(transport => { saved(transport).hidden_item_ids = ['4']; });
    expect(chip('Open 2, 1 more hidden')).toBeTruthy();
    expect(chip(/^Done \d+$/)).toBeTruthy();
  });
});

describe('Show them and Hide them (G1, G2, G4, G15)', () => {
  it('picking Open counts the hidden matches apart; Show them draws each dimmed, writes nothing, and Hide them puts them away', async () => {
    const transport = await mount(allHidden);
    await pick('Open 0, 3 more hidden');
    expect(picked(transport)).toEqual(['open']);
    expect(text()).toContain('Showing 0 of 0 items');
    expect(text()).toContain('+3 hidden match');
    for (const id of ['4', '8', '1.1']) expect(treeRow(id)).toBeNull();
    const writes = transport.mutations.length, hiddenBefore = [...saved(transport).hidden_item_ids ?? []];
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    for (const id of ['4', '8', '1.1']) expect(treeRow(id)?.classList.contains('tree-item-hidden')).toBe(true);
    expect(treeRow('2')).toBeNull();
    expect(text()).toContain('3 hidden shown');
    expect(within(strip()).queryByRole('button', { name: 'Show them' })).toBeNull();
    expect(transport.mutations.length).toBe(writes);
    expect(saved(transport).hidden_item_ids).toEqual(hiddenBefore); expect(saved(transport).focused_item_id ?? null).toBeNull();
    expect(picked(transport)).toEqual(['open']);
    fireEvent.click(within(strip()).getByRole('button', { name: 'Hide them' }));
    for (const id of ['4', '8', '1.1']) expect(treeRow(id)).toBeNull();
    expect(text()).toContain('+3 hidden match');
    expect(within(strip()).queryByRole('button', { name: 'Hide them' })).toBeNull();
    expect(transport.mutations.length).toBe(writes);
  });

  it('G4: Hide them leaves a group the owner opened by hand open, and its rows still obey the filter', async () => {
    const transport = await mount(transport => { saved(transport).hidden_item_ids = ['4', '8', '2']; });
    await pick(/^Open \d+, \d+ more hidden$/);
    expect(treeRow('4')).toBeNull(); expect(treeRow('8')).toBeNull();
    fireEvent.click(screen.getAllByRole('treeitem', { name: /^1 hidden/ })[0]!);
    expect(treeRow('4')).not.toBeNull();
    expect(treeRow('2')).toBeNull();
    expect(text()).toContain('+1 hidden match');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('8')).not.toBeNull();
    expect(text()).toContain('1 hidden shown');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Hide them' }));
    expect(treeRow('8')).toBeNull(); expect(treeRow('4')).not.toBeNull();
    expect(picked(transport)).toEqual(['open']);
  });

  it('G1, G12: any change of the picked chips ends the reveal, and the note counts again for the new filter', async () => {
    await mount(allHidden);
    await pick('Open 0, 3 more hidden');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('4')).not.toBeNull();
    await pick('Done 0, 1 more hidden');
    expect(treeRow('4')).toBeNull();
    expect(text()).toContain('+4 hidden match');
    expect(text()).not.toContain('hidden shown');
  });

  it('G1: Clear ends the reveal with the filter; a new pick starts from the hidden matches again', async () => {
    await mount(allHidden);
    await pick('Open 0, 3 more hidden');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('4')).not.toBeNull();
    fireEvent.click(within(strip()).getByRole('button', { name: 'Clear' }));
    await ready();
    expect(screen.queryByRole('group', { name: 'Filter items' })).toBeNull();
    expect(treeRow('4')).toBeNull();
    await pick('Open 0, 3 more hidden');
    expect(treeRow('4')).toBeNull();
    expect(text()).toContain('+3 hidden match'); expect(text()).not.toContain('hidden shown');
  });

  it('G9: folding a strip the filter opened closes it and takes it out of the filter\'s reveal', async () => {
    await mount(allHidden);
    await pick('Open 0, 3 more hidden');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('8')).not.toBeNull();
    // Topic two\'s group holds only item 8.
    const groups = screen.getAllByRole('treeitem', { name: /^1 hidden/ });
    fireEvent.click(groups[groups.length - 1]!);
    expect(treeRow('8')).toBeNull();
    expect(treeRow('4')).not.toBeNull();
    expect(text()).toContain('+1 hidden match'); expect(text()).toContain('2 hidden shown');
    // The same Show them brings it back, and Hide them still ends the rest.
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('8')).not.toBeNull();
    fireEvent.click(within(strip()).getByRole('button', { name: 'Hide them' }));
    for (const id of ['4', '8', '1.1']) expect(treeRow(id)).toBeNull();
  });

  it('G13: unhiding a revealed row keeps the rest of the reveal and draws the row undimmed in place', async () => {
    const transport = await mount(allHidden);
    await pick('Open 0, 3 more hidden');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    fireEvent.click(within(treeRow('4')!).getByRole('button', { name: 'Unhide (x)' }));
    await waitFor(() => expect(saved(transport).hidden_item_ids).not.toContain('4')); await ready();
    expect(treeRow('4')?.classList.contains('tree-item-hidden')).toBe(false);
    for (const id of ['8', '1.1']) expect(treeRow(id)?.classList.contains('tree-item-hidden')).toBe(true);
    expect(text()).toContain('2 hidden shown');
  });

  it('G8: a local chip is counted and revealed the same way, nothing is saved, and the funnel badge does not change', async () => {
    const transport = await mount(setup => {
      allHidden(setup);
      setup.preferences.later = [{ project_id: route.project_id, session_id: route.session_id, item_id: '4' }];
    });
    expect(chip('Later 0, 1 more hidden')).toBeTruthy();
    await pick('Later 0, 1 more hidden');
    expect(JSON.parse(localStorage.getItem(LOCAL_CHIPS_KEY) ?? '{}')).toEqual({ [route.session_id]: ['later'] });
    expect(picked(transport)).toEqual([]);
    expect(text()).toContain('+1 hidden match');
    const badge = funnel().getAttribute('aria-label'), writes = transport.mutations.length;
    expect(badge).toBe('Filter by status, 1 status picked');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('4')?.classList.contains('tree-item-hidden')).toBe(true);
    expect(funnel().getAttribute('aria-label')).toBe(badge);
    expect(transport.mutations.length).toBe(writes);
    expect(JSON.parse(localStorage.getItem(LOCAL_CHIPS_KEY) ?? '{}')).toEqual({ [route.session_id]: ['later'] });
    // Dropping the local chip ends the reveal too.
    await pick(/^Later /);
    expect(treeRow('4')).toBeNull();
  });
});

describe('Focus (G10)', () => {
  it('counts the matches outside the Focus apart, and Show them reveals the ones inside without leaving it', async () => {
    const transport = await mount(setup => { saved(setup).hidden_item_ids = ['1.1', '8']; saved(setup).focused_item_id = '1'; });
    await pick(/^Open \d+, \d+ more hidden$/);
    expect(text()).toContain('+1 hidden match (1 outside Focus)');
    expect(treeRow('1.1')).toBeNull();
    fireEvent.click(within(strip()).getByRole('button', { name: 'Show them' }));
    expect(treeRow('1.1')).not.toBeNull();
    expect(treeRow('8')).toBeNull();
    expect(saved(transport).focused_item_id).toBe('1');
    expect(text()).toContain('1 hidden shown'); expect(text()).toContain('1 hidden match outside Focus');
    expect(within(strip()).queryByRole('button', { name: 'Show them' })).toBeNull();
  });
});

describe('the Graph (G5, G16)', () => {
  it('names the hidden matches without a reveal, and leaves out the ones its selected route draws', async () => {
    await mount(setup => { allHidden(setup); saved(setup).selected_item_id = '4'; });
    await pick(/^Open 0, \d more hidden$/);
    // The Tree opened the selected item's group, which draws 4 and 1.1: one match (8) is left.
    expect(text()).toContain('+1 hidden match');
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await ready();
    // The Graph draws only the route to the selected item: 4 is drawn; 1.1 and 8 are not.
    await waitFor(() => expect(text()).toContain('+2 hidden match'));
    expect(within(strip()).queryByRole('button', { name: 'Show them' })).toBeNull();
    expect(within(strip()).queryByRole('button', { name: 'Hide them' })).toBeNull();
  });
});

describe('an empty session (G6)', () => {
  it('says "Nothing to filter" instead of an empty strip', async () => {
    await mount(setup => { const session = setup.sessions.get(route.session_id)!; session.items = {}; session.topics = {}; });
    expect(within(strip()).getByText('Nothing to filter')).toBeTruthy();
    expect(within(strip()).queryByText('Pick a status')).toBeNull();
    expect(within(strip()).queryByRole('button')).toBeNull();
  });
});
