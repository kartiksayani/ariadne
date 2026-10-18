import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { dispatchIntent } from '../../../src/ui/intents';
import { AppTransport, route } from '../app/transport';
import { goToSession } from '../app/open';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const viewOf = (transport: AppTransport) => transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
const recentButton = () => screen.getByRole('button', { name: 'Recent' });
const popover = () => screen.getByRole('dialog', { name: 'Recent items' });

async function openSession(configure?: (transport: AppTransport) => void) {
  const transport = new AppTransport(); configure?.(transport);
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
  return transport;
}

describe('the Recent popover from the top bar', () => {
  it('opens and closes with the clock button and with ⌘E, and the button reads pressed while it is open', async () => {
    await openSession(transport => { viewOf(transport).recent_items = [{ item_id: '2', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }]; });
    expect(recentButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(recentButton());
    expect(popover()).toBeTruthy();
    expect(recentButton().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(recentButton());
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
    let handled = false;
    act(() => { handled = dispatchIntent('recent.open'); });
    expect(handled).toBe(true);
    expect(popover()).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
    expect(document.activeElement).toBe(recentButton());
  });

  it('is titled "Recent · viewed and changed", lists Viewed before Changed lately, and each row has a status icon and an underlined name', async () => {
    await openSession(transport => { viewOf(transport).recent_items = [{ item_id: '2', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }]; });
    fireEvent.click(recentButton());
    const dialog = popover();
    expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe('Recent · viewed and changed');
    const regions = within(dialog).getAllByRole('region').map(region => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Viewed', 'Changed lately']);
    for (const region of within(dialog).getAllByRole('region')) {
      for (const row of within(region).getAllByRole('button').filter(button => button.classList.contains('recent-item'))) {
        expect(within(row).getByRole('img'), 'the status icon').toBeTruthy();
        expect(row.querySelector('time')).not.toBeNull();
        expect(row.querySelector('.recent-name')!.textContent).not.toBe('');
      }
    }
  });

  it('lists what was viewed with its action and what changed lately, and a click selects the item and closes it', async () => {
    const transport = await openSession(transport => {
      viewOf(transport).recent_items = [{ item_id: '2', action: 'peeked', visited_at: '2026-10-13T11:00:00.000Z' }];
    });
    fireEvent.click(recentButton());
    const viewed = within(popover()).getByRole('region', { name: 'Viewed' });
    fireEvent.click(within(viewed).getByRole('button', { name: /peeked/ }));
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('2'));
    expect(transport.sessions.get(route.session_id)!.items['2']!.status).toBe('waiting_on_me');
  });

  it('keeps a pick from it through a held automatic Recent save, then opens that item', async () => {
    const transport = await openSession(transport => { viewOf(transport).recent_items = [{ item_id: '2', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }]; });
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.recent_items?.[0]?.item_id === '3')) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    fireEvent.click(recentButton());
    // Opening item 3 records it as viewed; that save is held while the popover is still open.
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="3"]')!);
    await waitFor(() => expect(entered).toBe(true));
    fireEvent.click(within(within(popover()).getByRole('region', { name: 'Viewed' })).getByRole('button', { name: /viewed/ }));
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('2'));
  });

  it('never marks anything seen by opening, hovering or choosing from it', async () => {
    const mark = vi.spyOn(NavigationStore.prototype, 'markItemSeen');
    const transport = await openSession(transport => {
      const session = transport.sessions.get(route.session_id)!;
      session.items['1.1']!.created_at = new Date(Date.now() - 30_000).toISOString();
      transport.preferences.seen = [{ session: route, since: new Date(Date.now() - 60_000).toISOString(), items: [], topics: [] }];
      viewOf(transport).recent_items = [{ item_id: '1.1', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }];
    });
    vi.useFakeTimers();
    fireEvent.click(recentButton());
    fireEvent.mouseEnter(within(popover()).getAllByRole('button', { name: /viewed/ })[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mark).not.toHaveBeenCalled();
    expect(transport.preferences.seen![0]!.items).toEqual([]);
  });

  it('with the conversation in the bigger view, ⌘E opens it and a pick opens that item', async () => {
    const transport = await openSession(transport => {
      Object.assign(viewOf(transport), { tab_open: true, selected_item_id: '4' });
      viewOf(transport).recent_items = [{ item_id: '2', action: 'viewed', visited_at: '2026-10-13T11:00:00.000Z' }];
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Open the conversation in a bigger view' }));
    const bigger = await screen.findByRole('region', { name: 'Item conversation' });
    fireEvent.keyDown(bigger, { key: 'e', metaKey: true });
    const viewed = within(await screen.findByRole('dialog', { name: 'Recent items' })).getByRole('region', { name: 'Viewed' });
    // Opening item 4 recorded it as viewed just now; item 2 was viewed days ago, so it is the last entry.
    fireEvent.click(within(viewed).getAllByRole('button', { name: /viewed/ }).at(-1)!);
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
    await waitFor(() => expect(viewOf(transport).selected_item_id).toBe('2'));
    await waitFor(() => expect(screen.getByRole('article').getAttribute('data-detail-item-id')).toBe('2'));
  });

  it('gives its first Escape to an open peek and closes on the next', async () => {
    await openSession();
    fireEvent.click(recentButton());
    const closed = vi.fn();
    const peek = document.body.appendChild(document.createElement('div'));
    peek.className = 'item-peek';
    const close = peek.appendChild(document.createElement('button'));
    close.setAttribute('aria-label', 'Close peek'); close.onclick = () => { closed(); peek.remove(); };
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(popover()).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
  });

  it('closes on a press outside it', async () => {
    await openSession();
    fireEvent.click(recentButton());
    expect(popover()).toBeTruthy();
    // A press anywhere outside closes it; the switcher's own trigger is such a press.
    fireEvent.pointerDown(document.querySelector('[data-popover-trigger="switcher"]')!);
    expect(screen.queryByRole('dialog', { name: 'Recent items' })).toBeNull();
  });
});
