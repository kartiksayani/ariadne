// A folded Details column shows only its rail, so the item it holds is not seen (owner rule: never miss). The seen dwell
// waits while Details is folded, starts from zero when it unfolds, and stops when Details folds mid-dwell. The rail's New
// diamond (SPEC 3.6) follows the same "New since you last looked" rule, so it stays until the owner has really looked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { FOLDED_KEY } from '../../../src/state/details/column';
import { SEEN_DWELL_MS } from '../../../src/ui/changes/useSeenDwell';
import { AppTransport, route } from '../app/transport';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

const ITEM = '2';
/**
 * The dwell is driven by the fake clock, not the wall clock, so a loaded machine cannot stretch or shrink it. The session
 * opens on real timers (the app loads through promises); the fake clock starts once it is open, before any dwell is running.
 */
const startClock = () => vi.useFakeTimers();
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const rail = () => screen.queryByRole('button', { name: 'Show Details' });
const diamond = () => rail()?.querySelector('[aria-label="New messages"]') ?? null;
/** A mark_seen of the item was sent (the reading lane sends each mark at once). */
const markedSeen = (transport: AppTransport) => transport.mutations.some(request => request.command.command === 'preferences_patch'
  && request.command.params.entries.some(entry => entry.kind === 'mark_seen' && entry.items.some(item => item.item_id === ITEM)));
/** Longer than the dwell plus the session's settling after it opens. */
const PAST_DWELL = SEEN_DWELL_MS * 2.5;
/** When the item was marked seen, by the clock: each mark carries the moment it was made, so a test can tell how long after an owner action it came. */
const markStamp = (transport: AppTransport) => Date.parse(transport.mutations.flatMap(request => request.command.command === 'preferences_patch'
  ? request.command.params.entries.flatMap(entry => entry.kind === 'mark_seen' && entry.items.some(item => item.item_id === ITEM) ? [entry.at] : []) : [])[0]!);
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
    startClock();
    await wait(PAST_DWELL);
    expect(markedSeen(transport)).toBe(false);
    expect(diamond()).not.toBeNull();
  });

  it('unfold: the dwell runs from zero, then the item is marked seen and the diamond clears', async () => {
    const transport = await open(true);
    startClock();
    await wait(PAST_DWELL);
    expect(markedSeen(transport)).toBe(false);
    const unfoldedAt = Date.now();
    await unfold();
    expect(rail()).toBeNull();
    // The folded time does not count toward the dwell: one tick short of a whole dwell after the unfold, nothing is marked.
    await wait(SEEN_DWELL_MS - 1);
    expect(markedSeen(transport)).toBe(false);
    // The mark is saved a moment after the dwell ends (saves are batched), so the wait runs past that.
    await wait(SEEN_DWELL_MS + 1);
    expect(markedSeen(transport)).toBe(true);
    // The mark is stamped with the moment the dwell ended, which on the fake clock is exactly one dwell after the unfold.
    expect(markStamp(transport) - unfoldedAt).toBe(SEEN_DWELL_MS);
    await fold();
    expect(rail()).not.toBeNull();
    expect(diamond()).toBeNull();
  });

  it('fold mid-dwell: the dwell stops and nothing is marked', async () => {
    // Opens folded and unfolds on the fake clock, so the dwell starts at a known zero (a wall-clock dwell started at open
    // could end before the fold on a loaded machine, which would make this case prove nothing).
    const transport = await open(true);
    startClock();
    await unfold();
    expect(rail()).toBeNull();
    await wait(SEEN_DWELL_MS / 2);
    expect(markedSeen(transport)).toBe(false);
    await fold();
    await wait(SEEN_DWELL_MS * 3);
    expect(markedSeen(transport)).toBe(false);
    expect(diamond()).not.toBeNull();
  });

  it.each([
    ['hidden', { visible: false, focused: false }],
    ['blurred', { visible: true, focused: false }],
  ])('a %s window never marks the open column’s item seen, and a full second after it returns does (D20)', async (_name, state) => {
    const window_ = (visible: boolean, focused: boolean) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
      document.hasFocus = () => focused;
    };
    window_(state.visible, state.focused);
    try {
      const transport = await open(false);
      startClock();
      await wait(PAST_DWELL * 4);
      expect(markedSeen(transport)).toBe(false);
      window_(true, true);
      await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await wait(SEEN_DWELL_MS - 100);
      expect(markedSeen(transport)).toBe(false);
      await wait(PAST_DWELL);
      expect(markedSeen(transport)).toBe(true);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});
