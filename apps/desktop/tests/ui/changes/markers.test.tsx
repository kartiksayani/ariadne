// Owner rule: never miss a change. A New or Changed marker clears only after the item has been open in Details or the dock for
// a second in a visible, focused window (D20), or through an owner action (the row's own button, Mark all caught up).
// Peeking, hovering, searching, scrolling, `n`, Ack and filters never clear one. Every trigger runs against the whole app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { goToSession } from '../app/open';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete (document as { visibilityState?: unknown }).visibilityState; localStorage.clear(); });

const NEW_ID = '1.1', CHANGED_ID = '3', ACK_ID = '4';
const viewOf = (transport: AppTransport) => transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
/** Item ids carried by mark_seen saves so far, in the order they were sent. */
const marked = (transport: AppTransport) => transport.mutations.flatMap(request => request.command.command === 'preferences_patch'
  ? request.command.params.entries.flatMap(entry => entry.kind === 'mark_seen' ? entry.items.map(item => item.item_id) : []) : []);
/** What the band says is unseen in the topic: the markers still on the Map, counted. */
const band = () => screen.queryByRole('button', { name: /new|changed|changes since|All caught up/ })?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** The band's count, checked once the band is on screen. */
const bandReads = (pattern: RegExp, negate = false) => { (negate ? expect(band()).not : expect(band())).toMatch(pattern); };
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;

async function open() {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const now = Date.now();
  session.items[NEW_ID]!.created_at = new Date(now - 30_000).toISOString(); session.items[NEW_ID]!.changes = [];
  Object.assign(session.items[CHANGED_ID]!, { revision: 2, changes: [{ revision: 2, at: new Date(now - 20_000).toISOString(), cause_message_id: session.items[CHANGED_ID]!.created_message_id, before: { note: 'Earlier' } }] });
  Object.assign(session.items[ACK_ID]!, { type: 'finding', status: 'open', ack_to: 'done', ask: null });
  session.updated_at = new Date(now - 20_000).toISOString();
  transport.preferences.seen = [{ session: route, since: new Date(now - 60_000).toISOString(), items: [], topics: [] }];
  viewOf(transport).expanded_item_ids = ['1', '3'];
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
  await waitFor(() => expect(band()).toMatch(/1 new 1 changed/));
  vi.useFakeTimers();
  return transport;
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const search = async (text: string) => {
  if (!screen.queryByRole('textbox', { name: 'Search the Map' })) fireEvent.click(screen.getByRole('button', { name: 'Search the Map' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search the Map' }), { target: { value: text } });
};
/** Picks one status in the filter UI, whichever shape it has. */
const filter = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Filter by status' }));
  const group = screen.getByRole('group', { name: 'Filter items' });
  const button = within(group).queryByRole('button', { name: /^Filter/ });
  if (button) fireEvent.click(button);
  const option = screen.queryAllByRole('menuitemcheckbox')[0] ?? within(group).getAllByRole('button').find(candidate => /Decided|Done|Open/.test(candidate.textContent ?? ''));
  fireEvent.click(option!);
};

describe('what leaves a marker alone', () => {
  it.each<[string, (transport: AppTransport) => unknown]>([
    ['hovering a row long enough to peek it', async () => { fireEvent.mouseEnter(row(NEW_ID)); await wait(2000); }],
    ['scrolling the Map', async () => { const box = screen.getByTestId('map-scroll'); box.scrollTop = 40; fireEvent.scroll(box); await wait(2000); }],
    ['pressing n, again and again', async () => { const map = screen.getByRole('region', { name: 'Session tree' }); for (let step = 0; step < 4; step++) fireEvent.keyDown(map, { key: 'n' }); await wait(2000); }],
    ['searching for a marked item', async () => { await search('receipt'); await wait(2000); }],
    ['opening Recent', async () => { fireEvent.click(screen.getByRole('button', { name: 'Recent' })); await wait(2000); }],
    ['opening What changed', async () => { fireEvent.click(screen.getByRole('button', { name: /new/ })); await wait(2000); }],
    ['choosing a status filter', async () => { filter(); await wait(2000); }],
    ['acking another item', async () => { fireEvent.click(within(row(ACK_ID)).getByRole('button', { name: 'Ack → Done' })); await wait(2000); }],
  ])('%s', async (_name, trigger) => {
    const transport = await open();
    await trigger(transport);
    expect(marked(transport).filter(id => id === NEW_ID || id === CHANGED_ID)).toEqual([]);
    bandReads(/1 new 1 changed|2 changes since/);
  });
  it('a hidden or blurred window with the item open in Details', async () => {
    const transport = await open();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.hasFocus = () => false;
    await act(async () => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); });
    fireEvent.click(row(CHANGED_ID));
    await wait(10_000);
    expect(marked(transport)).toEqual([]);
    bandReads(/1 new 1 changed/);
  });
});

describe('what clears a marker', () => {
  it('a second with the item open in Details, in a visible and focused window', async () => {
    const transport = await open();
    fireEvent.click(row(CHANGED_ID));
    await wait(900);
    expect(marked(transport)).toEqual([]);
    await wait(1500);
    expect(marked(transport)).toContain(CHANGED_ID);
    bandReads(/1 new/); bandReads(/changed/, true);
  });
  it('the row’s own button in What changed, and only that row', async () => {
    const transport = await open();
    fireEvent.click(screen.getByRole('button', { name: /new/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Mark .* seen$/ })[0]!);
    await wait(1500);
    expect(marked(transport).length).toBe(1);
    expect(band()).toMatch(/1 (new|changed)$|1 (new|changed) since/);
  });
  it('Mark all caught up, after its Undo window', async () => {
    const transport = await open();
    fireEvent.click(screen.getByRole('button', { name: /new/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mark all caught up/ }));
    expect(marked(transport)).toEqual([]);
    await wait(9000);
    expect(marked(transport).sort()).toEqual([CHANGED_ID, NEW_ID].sort());
  });
});
