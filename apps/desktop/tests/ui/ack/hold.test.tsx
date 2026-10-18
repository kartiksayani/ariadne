import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ACK_HOLD_MS, ackHoldFor, attachAckHolds, flushAckHold, stopAckHolds, useAckHeld } from '../../../src/ui/shared/ack';
import { ACK_ALL_HOLD_MS, ackAllFor, ackAllItems } from '../../../src/ui/navigation/ackAllController';
import { notices } from '../../../src/ui/pages/notices';
import { route } from '../app/transport';
import { toasts } from '../../../src/ui/shell/toast';
import { acked, acks, change, clearToast, heldToast, itemOf, noticeTexts, ready, stores, type Ready } from './ackFixture';

afterEach(() => { cleanup(); stores.forEach(store => store.close()); stores.length = 0; notices.clear(); clearToast(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the single-Ack hold', () => {
  it('holds an Ack for 6 s without writing, then saves it once', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    expect(r.hold).toBe(ackHoldFor(route.session_id, r.actions));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS - 1);
    expect(acks(r.transport)).toHaveLength(0);
    expect(itemOf(r).ack_to).toBe('done');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acked(r.transport)).toEqual(['1']);
    expect(itemOf(r)).toMatchObject({ ack_to: null, status: 'done' });
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 3);
    expect(acks(r.transport)).toHaveLength(1);
  });

  it('lists the item in useAckHeld during the window and not after Undo or the save', async () => {
    const r = await ready(); vi.useFakeTimers();
    function Probe() { return <p data-testid="held">{[...useAckHeld(route.session_id)].join(',')}</p>; }
    render(<Probe />);
    expect(screen.getByTestId('held').textContent).toBe('');
    act(() => { r.hold.ack(itemOf(r)); });
    expect(screen.getByTestId('held').textContent).toBe('1');
    act(() => { r.hold.undo('1'); });
    expect(screen.getByTestId('held').textContent).toBe('');
    act(() => { r.hold.ack(itemOf(r)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1); });
    expect(screen.getByTestId('held').textContent).toBe('');
  });

  it('Undo writes nothing, before and after the window would have ended, and the item stays to ack', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS - 1000);
    r.hold.undo('1');
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    await stopAckHolds(r.service);
    expect(acks(r.transport)).toHaveLength(0);
    expect(itemOf(r).ack_to).toBe('done');
    expect(noticeTexts()).toEqual([]);
    r.hold.undo('never-held');
  });

  it('saves at most once however often it is asked: repeats, a flush, the timer, and a click during the save', async () => {
    const r = await ready(); vi.useFakeTimers();
    let release!: () => void;
    r.transport.gate = new Promise<void>(resolve => { release = resolve; });
    const item = itemOf(r);
    r.hold.ack(item); r.hold.ack(item);
    const flushing = r.hold.flush(), again = r.hold.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(acks(r.transport)).toHaveLength(1);
    r.hold.ack(item);       // while the save is in flight
    r.hold.undo('1');       // Undo is too late once the save started
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(1);
    release(); await Promise.all([flushing, again]);
    r.hold.ack(itemOf(r));  // acknowledged now: not eligible, and never written again
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(1);
    expect(new Set(acks(r.transport).map(value => value.command.op_id)).size).toBe(1);
  });

  describe('a proposal that changed during the hold is never acked', () => {
    const edits: readonly [string, (item: NonNullable<Ready['session']['items'][string]>) => void][] = [
      ['its words', item => { item.question = 'Rewritten result'; }],
      ['its target', item => { item.ack_to = 'dropped'; }],
      ['its target is gone', item => { item.ack_to = null; }],
      ['a question appears', item => { item.ask = 'Should this change?'; }],
      ['its outcome', item => { item.outcome = 'A different outcome'; }],
      ['its reason', item => { item.why = 'A different reason'; }],
      ['a revision with the same words', () => undefined],
      ['its topic', item => { item.topic_id = 'other-topic'; }],
    ];
    it.each(edits)('%s', async (_name, edit) => {
      const r = await ready(); vi.useFakeTimers();
      r.hold.ack(itemOf(r));
      await change(r, edit);
      await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(acks(r.transport)).toHaveLength(0);
      if (r.session.items['1']!.ack_to) expect(itemOf(r).ack_to).toBe(r.session.items['1']!.ack_to);
      expect(noticeTexts()).toContain('Not acked: it changed');
    });

    it('also when it changed and changed back to other words before the flush', async () => {
      const r = await ready(); vi.useFakeTimers();
      r.hold.ack(itemOf(r));
      await change(r, item => { item.question = 'Another wording'; });
      await r.hold.flush();
      expect(acks(r.transport)).toHaveLength(0);
      expect(noticeTexts()).toContain('Not acked: it changed');
    });

    it('and the item can be acked again from its new proposal', async () => {
      const r = await ready(); vi.useFakeTimers();
      r.hold.ack(itemOf(r));
      await change(r, item => { item.question = 'Another wording'; });
      await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
      expect(acks(r.transport)).toHaveLength(0);
      r.hold.ack(itemOf(r));
      await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
      expect(acked(r.transport)).toEqual(['1']);
    });

    it('and a stale click on a result that already moved is refused at once', async () => {
      const r = await ready(); vi.useFakeTimers();
      const stale = itemOf(r);
      await change(r, item => { item.question = 'Another wording'; });
      r.hold.ack(stale);
      await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
      expect(acks(r.transport)).toHaveLength(0);
      expect(noticeTexts()).toContain('Not acked: it changed');
    });
  });

  it('a Tree to Graph switch (an unmounted view) does not flush, and the hold still saves on time', async () => {
    const r = await ready(); vi.useFakeTimers();
    function View() { return <p data-testid="held">{[...useAckHeld(route.session_id)].join(',')}</p>; }
    const mounted = render(<View />);
    act(() => { r.hold.ack(itemOf(r)); });
    mounted.unmount();
    render(<View />);
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS - 1000);
    expect(acks(r.transport)).toHaveLength(0);
    expect(screen.getByTestId('held').textContent).toBe('1');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(0); });
    expect(acked(r.transport)).toEqual(['1']);
  });

  it('a session switch flushes that session now, once, and its timer saves nothing more', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r)); r.hold.ack(itemOf(r, '1.1'));
    await flushAckHold(route.session_id);
    expect(acked(r.transport)).toEqual(['1', '1.1']);
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(2);
    await flushAckHold('no-such-session');
  });

  it('a session switch does not save an Undone Ack or a changed one', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r)); r.hold.ack(itemOf(r, '1.1'));
    r.hold.undo('1');
    await change(r, item => { item.question = 'Moved'; }, '1.1');
    await flushAckHold(route.session_id);
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('closing the application flushes every hold once: pagehide, beforeunload and the stop join one save', async () => {
    const r = await ready(); vi.useFakeTimers();
    const detach = attachAckHolds(r.service);
    r.hold.ack(itemOf(r));
    window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('beforeunload'));
    await stopAckHolds(r.service); await stopAckHolds(r.service);
    detach();
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acked(r.transport)).toEqual(['1']);
  });

  it('a hidden window or a blur does not flush', async () => {
    const r = await ready(); vi.useFakeTimers();
    const detach = attachAckHolds(r.service);
    r.hold.ack(itemOf(r));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1000);
    detach();
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('a failed save leaves the item to ack, shows the Ack error and does not retry by itself', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.transport.refuse = true;
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acks(r.transport)).toHaveLength(1);
    expect(itemOf(r).ack_to).toBe('done');
    expect(noticeTexts().join(' ')).toContain('can’t be acknowledged now');
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 3);
    expect(acks(r.transport)).toHaveLength(1);
  });

  it('offers Try again after a definite failure; the retry holds again and then says "Saved your Ack"', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.transport.refuse = true;
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    const failure = notices.getSnapshot().find(notice => notice.text.includes('can’t be acknowledged now'))!;
    expect(failure.actions?.map(action => action.label)).toEqual(['Try again']);
    r.transport.refuse = false;
    failure.actions![0]!.run();
    expect(acks(r.transport)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acks(r.transport)).toHaveLength(2);
    expect(toasts.current()?.text).toBe('Saved your Ack on “Result 1”.');
    expect(toasts.current()?.undo).toBeUndefined();
  });

  it('Undo after Try again forgets the retry: a later plain Ack of that result does not say “Saved your Ack”', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.transport.refuse = true;
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    const failure = notices.getSnapshot().find(notice => notice.text.includes('can’t be acknowledged now'))!;
    r.transport.refuse = false;
    failure.actions![0]!.run();
    r.hold.undo('1');
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(1);
    expect(toasts.current()).toBeNull();
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acks(r.transport)).toHaveLength(2);
    expect(toasts.current()).toBeNull();
  });

  it('a plain Ack that saves says nothing in a toast', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts.current()).toBeNull();
  });

  it('refuses at click time while another change is being saved, writing nothing and holding nothing', async () => {
    const r = await ready(); vi.useFakeTimers();
    vi.spyOn(r.actions, 'getSnapshot').mockReturnValue({ ...r.actions.getSnapshot(), writing: true });
    r.hold.ack(itemOf(r));
    expect(noticeTexts()).toContain('Another change is being saved. Wait for it, then try Ack again.');
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('is silent when Ack all already saved the held result, and writes nothing more', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    const reviewed = itemOf(r);
    // The same result is acknowledged elsewhere during the window.
    expect(await r.actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: '1', expected_revision: reviewed.revision } },
      r.store.getSnapshot().snapshot!.session.revision)).toBe(true);
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acks(r.transport)).toHaveLength(1);
    expect(noticeTexts()).toEqual([]);
  });
});

describe('Ack all and single holds', () => {
  it('Ack all leaves out items a single Ack holds and acks each result once', async () => {
    const r = await ready(); vi.useFakeTimers();
    const controller = ackAllFor(r.actions);
    r.hold.ack(itemOf(r));
    expect(controller.confirm(r.topicId, 'Results', ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId))).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'holding', total: 1 });
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acked(r.transport).sort()).toEqual(['1', '1.1']);
    expect(new Set(acked(r.transport)).size).toBe(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 1 });
  });

  it('Ack all refuses a batch made only of held items', async () => {
    const r = await ready(); vi.useFakeTimers();
    const controller = ackAllFor(r.actions);
    r.hold.ack(itemOf(r)); r.hold.ack(itemOf(r, '1.1'));
    expect(controller.confirm(r.topicId, 'Results', ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId))).toBe(false);
  });

  it('an item held after Ack all was confirmed is skipped by Ack all and saved once, by its own hold', async () => {
    const r = await ready(); vi.useFakeTimers();
    const controller = ackAllFor(r.actions);
    expect(controller.confirm(r.topicId, 'Results', ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId))).toBe(true);
    // The hold is still running when Ack all's window ends, so Ack all leaves the item to it.
    await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS - ACK_HOLD_MS + 3000);
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 3);
    expect(acked(r.transport).sort()).toEqual(['1', '1.1']);
    expect(new Set(acked(r.transport)).size).toBe(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 1, total: 1 });
  });

  it('an item held and saved before Ack all\'s window ends is counted by Ack all as done, with no second write', async () => {
    const r = await ready(); vi.useFakeTimers();
    const controller = ackAllFor(r.actions);
    expect(controller.confirm(r.topicId, 'Results', ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId))).toBe(true);
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS * 2);
    expect(acked(r.transport).sort()).toEqual(['1', '1.1']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2, total: 2 });
  });

  it('an Undone single Ack is not skipped by Ack all', async () => {
    const r = await ready(); vi.useFakeTimers();
    const controller = ackAllFor(r.actions);
    expect(controller.confirm(r.topicId, 'Results', ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId))).toBe(true);
    r.hold.ack(itemOf(r)); r.hold.undo('1');
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 3);
    expect(acked(r.transport).sort()).toEqual(['1', '1.1']);
  });

  it('shares one write lane: a single save waits for a running Ack all and nothing overlaps', async () => {
    const r = await ready(); vi.useFakeTimers();
    let release!: () => void;
    r.transport.gate = new Promise<void>(resolve => { release = resolve; });
    const controller = ackAllFor(r.actions);
    r.hold.ack(itemOf(r, '1.1'));
    const session = r.store.getSnapshot().snapshot!.session;
    controller.confirm(r.topicId, 'Results', ackAllItems(session, r.topicId));
    const flushing = controller.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(acked(r.transport)).toEqual(['1']);
    const single = r.hold.flush();
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS);
    expect(acked(r.transport)).toEqual(['1']);          // the single save is queued behind Ack all's write
    r.transport.gate = null; release();
    await Promise.all([flushing, single]);
    expect(acked(r.transport)).toEqual(['1', '1.1']);
    expect(r.transport.maxInFlight).toBe(1);
  });

  it('two single holds saved together write one at a time', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r)); r.hold.ack(itemOf(r, '1.1'));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acked(r.transport)).toEqual(['1', '1.1']);
    expect(r.transport.maxInFlight).toBe(1);
  });
});

describe('a held Ack with no row or Details to show it (the Graph, a peek)', () => {
  const held = () => heldToast();
  const shown = async () => { await vi.advanceTimersByTimeAsync(0); return held(); };

  it('announces itself with an Undo, and the Undo writes nothing', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    const notice = await shown();
    expect(notice?.text).toBe('Acked “Result 1”');
    expect(typeof notice?.undo).toBe('function');
    toasts.runUndo(notice!.id);
    expect(held()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('loses its Undo when the save starts, while the text may stay; hovering cannot bring it back', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    const toast = (await shown())!;
    toasts.pause(toast.id);
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS);
    expect(toasts.current()).toMatchObject({ id: toast.id, expired: true });
    toasts.runUndo(toast.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(acked(r.transport)).toEqual(['1']);
  });

  it('is gone when the save starts, and the Ack is written once', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    await shown();
    expect(held()).toBeDefined();
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS);
    expect(held()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(acked(r.transport)).toEqual(['1']);
  });

  it('a flush (a session switch) removes the notice too', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    await shown();
    await r.hold.flush();
    expect(held()).toBeUndefined();
  });

  it('does not announce when a row or Details shows the Undo', async () => {
    const r = await ready(); vi.useFakeTimers();
    const release = r.hold.showing(['1']);
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(400);
    expect(held()).toBeUndefined();
    release();
  });

  it('hands the Undo to a notice when the view showing it goes away mid-hold (a Tree to Graph switch), and the Undo writes nothing', async () => {
    const r = await ready(); vi.useFakeTimers();
    const release = r.hold.showing(['1']);
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(2000);
    expect(held()).toBeUndefined();
    release();
    expect(held()?.text).toBe('Acked “Result 1”');
    toasts.runUndo(held()!.id);
    expect(held()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('does not flush on that switch: the hold goes on and the Ack is written once at 6 s', async () => {
    const r = await ready(); vi.useFakeTimers();
    const release = r.hold.showing(['1']);
    r.hold.ack(itemOf(r));
    release();
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS - 1000);
    expect(acks(r.transport)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(0);
    expect(acked(r.transport)).toEqual(['1']);
    expect(held()).toBeUndefined();
  });

  it('withdraws the notice when a view shows the item again', async () => {
    const r = await ready(); vi.useFakeTimers();
    r.hold.ack(itemOf(r));
    expect(held()).toBeDefined();
    const release = r.hold.showing(['1']);
    expect(held()).toBeUndefined();
    release();
    expect(held()).toBeDefined();
  });

  it('counts the views: one of two going away leaves the Undo where the other draws it', async () => {
    const r = await ready(); vi.useFakeTimers();
    const row = r.hold.showing(['1', '1.1']), details = r.hold.showing(['1']);
    r.hold.ack(itemOf(r));
    row();
    expect(held()).toBeUndefined();
    details();
    expect(held()).toBeDefined();
    details();                                                  // a second release changes nothing
    expect(held()).toBeDefined();
  });

  it('a view showing a different item does not carry this item\'s Undo', async () => {
    const r = await ready(); vi.useFakeTimers();
    const other = r.hold.showing(['1.1']);
    r.hold.ack(itemOf(r));
    expect(held()).toBeDefined();
    other();
  });

  it('shows no notice for an item whose save has started', async () => {
    const r = await ready(); vi.useFakeTimers();
    const release = r.hold.showing(['1']);
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS);
    release();
    expect(held()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
  });
});
