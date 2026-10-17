import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { SessionActions } from '../../../src/components/bindings/actions';
import type { MutationReceipt, OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import { ACK_HOLD_MS, ackHoldFor, attachAckHolds, flushAckHold, stopAckHolds, useAckHeld } from '../../../src/ui/shared/ack';
import { ackAllFor, ackAllItems } from '../../../src/ui/navigation/ackAllController';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.forEach(store => store.close()); stores.length = 0; notices.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

class AckTransport extends AppTransport {
  gate: Promise<void> | null = null;
  refuse = false;
  inFlight = 0;
  maxInFlight = 0;
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const request = args.request;
    if (!('command' in request) || request.command.command !== 'ack') return super.invoke(name, args);
    this.mutations.push(structuredClone(request));
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await this.gate;
      if (this.refuse) return { api_version: 1, ok: false, error: {
        code: 'invalid_transition', message: 'Ack predicate no longer holds.', hint: 'Reload item state.', retryable: false, field_errors: [],
      } } as T;
      const command = request.command, session = this.sessions.get(request.session!.session_id)!, item = session.items[command.params.item_id]!;
      const status = item.ack_to!;
      item.status = status; item.ack_to = null; item.revision++; session.revision++;
      if (['decided', 'done', 'dropped'].includes(status)) { item.outcome ??= 'Acknowledged by the owner.'; item.why ??= 'The owner read this item.'; }
      const receipt: MutationReceipt = { operation_id: command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status, message_id: crypto.randomUUID() } };
      return { api_version: 1, ok: true, data: receipt } as T;
    } finally { --this.inFlight; }
  }
}
async function ready() {
  const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!;
  Object.values(session.items).forEach(item => { if (item) item.ack_to = null; });
  for (const [id, type] of [['1', 'finding'], ['1.1', 'explanation']] as const) {
    Object.assign(session.items[id]!, { type, status: 'open', ack_to: 'done', ask: null, question: `Result ${id}`, outcome: null, why: null });
  }
  const service = createDesktopService(transport), store = new SessionStore(service, route);
  stores.push(store); await store.refresh();
  const actions = new SessionActions(service, store), topicId = session.items['1']!.topic_id;
  return { transport, service, session, store, actions, topicId, hold: ackHoldFor(route.session_id, actions) };
}
type Ready = Awaited<ReturnType<typeof ready>>;
const acks = (transport: AppTransport) => transport.mutations.filter(value => value.command.command === 'ack');
const acked = (transport: AppTransport) => acks(transport).map(value => value.command.command === 'ack' && value.command.params.item_id);
const itemOf = (r: Ready, id = '1') => r.store.getSnapshot().snapshot!.session.items[id]!;
const noticeTexts = () => notices.getSnapshot().map(notice => notice.text);
/** Changes the server's item, then lets the session store read it. */
async function change(r: Ready, edit: (item: NonNullable<Ready['session']['items'][string]>) => void, id = '1') {
  const item = r.session.items[id]!;
  edit(item); item.revision++; r.session.revision++;
  await r.store.refresh(true);
}

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
    r.hold.ack(itemOf(r));
    await vi.advanceTimersByTimeAsync(ACK_HOLD_MS * 3);
    expect(acked(r.transport).sort()).toEqual(['1', '1.1']);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 1, total: 1 });
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
