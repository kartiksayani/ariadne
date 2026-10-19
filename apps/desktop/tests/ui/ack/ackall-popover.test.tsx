import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AckAll } from '../../../src/ui/navigation/AckAll';
import { ACK_ALL_HOLD_MS, ackAllFor, ackAllItems } from '../../../src/ui/navigation/ackAllController';
import { ACK_HOLD_MS } from '../../../src/ui/shared/ack';
import { notices } from '../../../src/ui/pages/notices';
import { toasts } from '../../../src/ui/shell/toast';
import { acked, acks, clearToast, heldToast, itemOf, noticeTexts, ready, stores, type Ready } from './ackFixture';

afterEach(() => { cleanup(); stores.forEach(store => store.close()); stores.length = 0; notices.clear(); clearToast(); vi.useRealTimers(); vi.restoreAllMocks(); });

const mount = (r: Ready) => render(<div className="product-app"><div className="tree-topic">
  <AckAll actions={r.actions} topicId={r.topicId} topicName="Results" items={ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId)} /></div></div>);
const open = () => { fireEvent.click(screen.getByRole('button', { name: /^Ack all \(/ })); return screen.getByRole('dialog', { name: 'Acknowledge results in Results' }); };

describe('the Ack all review popover (D11, SPEC 4.3)', () => {
  it('is a popover under the band, not a modal dialog, listing the results by name', async () => {
    const r = await ready(); mount(r);
    const popover = open();
    expect(popover.getAttribute('aria-modal')).toBeNull();
    expect(popover.closest('.product-app')).not.toBeNull();
    expect(popover.closest('.tree-topic')).toBeNull();           // outside the band, so outside the Map's flow
    expect(within(popover).getByRole('heading', { name: 'Ack 2 results in “Results”?' })).toBeTruthy();
    expect(within(popover).getByText('They stay in the Map, marked as read. Questions and open items aren’t touched.')).toBeTruthy();
    expect(within(popover).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Result 1', 'Result 1.1']);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Ack all \(/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['Cancel', (popover: HTMLElement) => fireEvent.click(within(popover).getByRole('button', { name: 'Cancel' }))],
    ['Escape', (popover: HTMLElement) => fireEvent.keyDown(popover, { key: 'Escape' })],
    ['a press outside', () => fireEvent.pointerDown(document.body)],
    ['a Map scroll', () => fireEvent.scroll(document.body)],
    ['the opener again', () => fireEvent.click(screen.getByRole('button', { name: /^Ack all \(/ }))],
  ] as const)('closes on %s and writes nothing', async (_name, close) => {
    const r = await ready(); vi.useFakeTimers(); mount(r);
    const popover = open();
    close(popover);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ackAllFor(r.actions).getSnapshot().phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('keeps a scroll inside its own list from closing it', async () => {
    const r = await ready(); mount(r);
    const popover = open();
    fireEvent.scroll(within(popover).getByRole('list'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('keeps its keys to itself: a letter pressed inside never reaches the Map\'s shortcuts', async () => {
    const r = await ready();
    const seen = vi.fn();
    render(<div className="product-app" onKeyDown={seen}><div className="tree-topic">
      <AckAll actions={r.actions} topicId={r.topicId} topicName="Results" items={ackAllItems(r.store.getSnapshot().snapshot!.session, r.topicId)} /></div></div>);
    fireEvent.keyDown(open(), { key: 'a' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('confirming shows "Acked 2 results · Undo" for 8 s in the Ack all button\'s place, then saves each once', async () => {
    const r = await ready(); vi.useFakeTimers(); mount(r);
    fireEvent.click(within(open()).getByRole('button', { name: 'Ack all' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Ack all \(/ })).toBeNull();
    const held = screen.getByRole('status');
    expect(held.textContent).toBe('Acked 2 resultsUndo');
    expect(within(held).getByRole('button', { name: 'Undo Ack all' })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS - 1); });
    expect(acks(r.transport)).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await vi.advanceTimersByTimeAsync(0); });
    expect(acked(r.transport)).toEqual(['1', '1.1']);
    expect(ACK_ALL_HOLD_MS).toBe(8000);
  });

  it('Undo cancels the whole hold, writes nothing, and the Ack all button is back', async () => {
    const r = await ready(); vi.useFakeTimers(); mount(r);
    fireEvent.click(within(open()).getByRole('button', { name: 'Ack all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo Ack all' }));
    await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('leaves out an item a single Ack holds: the list, the count, and the saves', async () => {
    const r = await ready(); vi.useFakeTimers(); mount(r);
    act(() => { r.hold.ack(itemOf(r)); });
    expect(screen.getByRole('button', { name: 'Ack all (1)' })).toBeTruthy();
    const popover = open();
    expect(within(popover).getByRole('heading', { name: 'Ack 1 results in “Results”?' })).toBeTruthy();
    expect(within(popover).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Result 1.1']);
    fireEvent.click(within(popover).getByRole('button', { name: 'Ack all' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS + ACK_HOLD_MS); await vi.advanceTimersByTimeAsync(0); });
    expect(acked(r.transport).sort()).toEqual(['1', '1.1']);
    expect(new Set(acked(r.transport)).size).toBe(2);
  });

  it('with every result held singly there is no Ack all to press', async () => {
    const r = await ready(); mount(r);
    act(() => { r.hold.ack(itemOf(r)); r.hold.ack(itemOf(r, '1.1')); });
    expect(screen.queryByRole('button', { name: /^Ack all \(/ })).toBeNull();
  });

  it('shows the refusal in the popover when the results changed under it, and stays open', async () => {
    const r = await ready(); mount(r);
    const popover = open();
    r.session.items['1']!.question = 'Changed'; r.session.items['1']!.revision++; r.session.revision++;
    await act(async () => { await r.store.refresh(true); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Ack all' }));
    expect(within(popover).getByRole('alert').textContent).toContain('changed');
    expect(ackAllFor(r.actions).getSnapshot().phase).toBe('idle');
  });

  it('the band going away mid-hold moves the Undo to a notice; the band coming back takes it away again', async () => {
    const r = await ready(); vi.useFakeTimers();
    const view = mount(r);
    fireEvent.click(within(open()).getByRole('button', { name: 'Ack all' }));
    view.unmount();
    await vi.advanceTimersByTimeAsync(400);
    const notice = heldToast('Acked 2 results');
    expect(typeof notice?.undo).toBe('function');
    mount(r);
    expect(heldToast('Acked 2 results')).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Undo Ack all' })).toBeTruthy();
    expect(noticeTexts().some(text => text.startsWith('Ack 2 results'))).toBe(false);
  });

  it('the notice\'s Undo cancels the hold with no write', async () => {
    const r = await ready(); vi.useFakeTimers();
    const view = mount(r);
    fireEvent.click(within(open()).getByRole('button', { name: 'Ack all' }));
    view.unmount();
    await vi.advanceTimersByTimeAsync(400);
    toasts.runUndo(heldToast('Acked 2 results')!.id);
    await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS * 2);
    expect(acks(r.transport)).toHaveLength(0);
  });

  it('another topic\'s band going away does not announce this topic\'s hold', async () => {
    const r = await ready(); vi.useFakeTimers();
    const view = mount(r);
    fireEvent.click(within(open()).getByRole('button', { name: 'Ack all' }));
    const other = render(<AckAll actions={r.actions} topicId="another-topic" topicName="Other" items={[]} />);
    other.unmount();
    await vi.advanceTimersByTimeAsync(400);
    expect(heldToast()).toBeUndefined();
    view.unmount();
  });
});
