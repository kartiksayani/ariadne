// A folded Details column shows only its rail, so the item it holds is not seen (owner rule: never miss). The seen dwell
// waits while Details is folded, starts from zero when it unfolds, and stops when Details folds mid-dwell. The rail's New
// diamond (SPEC 3.6) follows the same "New since you last looked" rule, so it stays until the owner has really looked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { FOLDED_KEY } from '../../../src/state/details/column';
import { SEEN_DWELL_MS } from '../../../src/ui/changes/useSeenDwell';
import { AppTransport, route } from '../app/transport';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

const ITEM = '2';
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const rail = () => screen.queryByRole('button', { name: 'Show Details' });
const diamond = () => rail()?.querySelector('[aria-label="New messages"]') ?? null;
/** A mark_seen of the item was sent (the reading lane sends each mark at once). */
const markedSeen = (transport: AppTransport) => transport.mutations.some(request => request.command.command === 'preferences_patch'
  && request.command.params.entries.some(entry => entry.kind === 'mark_seen' && entry.items.some(item => item.item_id === ITEM)));
/** Longer than the dwell plus the session's settling after it opens. */
const PAST_DWELL = SEEN_DWELL_MS * 2.5;
const seenSoon = (transport: AppTransport) => waitFor(() => expect(markedSeen(transport)).toBe(true), { timeout: PAST_DWELL });
async function click(element: Element) { await act(async () => { fireEvent.click(element); }); }
const fold = () => click(screen.getByRole('button', { name: 'Fold Details' }));
const unfold = () => click(rail()!);

/** The session opens on item 2, whose conversation has messages since the owner last looked (the seen baseline). */
async function open(folded: boolean) {
  if (folded) localStorage.setItem(FOLDED_KEY, 'true');
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true, selected_item_id: ITEM });
  transport.preferences.seen = [{ session: route, since: '2026-10-03T12:00:30.000Z', items: [], topics: [] }];
  await act(async () => { render(<DesktopApp service={createDesktopService(transport)} />); });
  await screen.findByRole('tree', { name: 'Session items' });
  await screen.findByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${ITEM}"]` });
  return transport;
}

describe('the seen dwell and a folded Details column', () => {
  it('folded and selected: never marked seen, and the New diamond stays', async () => {
    const transport = await open(true);
    expect(rail()).not.toBeNull();
    expect(diamond()).not.toBeNull();
    await wait(PAST_DWELL);
    expect(markedSeen(transport)).toBe(false);
    expect(diamond()).not.toBeNull();
  });

  it('unfold: the dwell runs from zero, then the item is marked seen and the diamond clears', async () => {
    const transport = await open(true);
    await wait(PAST_DWELL);
    expect(markedSeen(transport)).toBe(false);
    await unfold();
    expect(rail()).toBeNull();
    // The folded time does not count toward the dwell.
    await wait(SEEN_DWELL_MS * 0.5);
    expect(markedSeen(transport)).toBe(false);
    await seenSoon(transport);
    await fold();
    expect(rail()).not.toBeNull();
    expect(diamond()).toBeNull();
  });

  it('fold mid-dwell: the dwell stops and nothing is marked', async () => {
    const transport = await open(false);
    expect(rail()).toBeNull();
    await wait(SEEN_DWELL_MS * 0.6);
    expect(markedSeen(transport)).toBe(false);
    await fold();
    await wait(PAST_DWELL);
    expect(markedSeen(transport)).toBe(false);
    expect(diamond()).not.toBeNull();
  });

  it('a hidden or blurred window: unchanged, the open column still marks its item seen after the dwell', async () => {
    const transport = await open(false);
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await act(async () => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); });
      await seenSoon(transport);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (visibility) expect(document.visibilityState).toBe(visibility.get!.call(document));
    }
  });
});
