import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { DetailPath, ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { MessageRail } from '../../../src/components/rail/MessageRail';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { extraMessage, setup } from './fixtures';

const opened: ReturnType<typeof setup>[] = [];
async function ready(change?: (session: ReturnType<typeof setup>['transport']['session']) => void) {
  const value = setup(); opened.push(value); change?.(value.transport.session); await value.store.refresh(); return value;
}
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });

describe('item detail panel', () => {
  const panel = (value: Awaited<ReturnType<typeof ready>>, itemId = '1', open = vi.fn()) =>
    <ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId={itemId} later={false} onOpenItem={open} />;

  it('reads every section from the session snapshot in the handoff order', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1']!, open = vi.fn();
    render(panel(value, '1', open));
    await screen.findByRole('heading', { name: item.question });
    const created = session.messages.find(message => message.id === item.created_message_id)!;
    expect(screen.getByText(`Decision · next action: you · raised in #${created.number}`)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toBe(`Done${item.outcome}`);
    expect(screen.getByText(item.why!)).toBeTruthy();
    const order = [...document.querySelectorAll('.item-detail > section, .item-detail > div')].map(element => element.getAttribute('aria-label') ?? element.className);
    expect(order.filter(name => ['Your answer', 'Revisit', 'Current outcome', 'Child items', 'Item links', 'Back and forth', 'Timeline'].includes(name)))
      .toEqual(['Your answer', 'Revisit', 'Current outcome', 'Child items', 'Item links', 'Back and forth', 'Timeline']);
    // The handled answer is the request the stepper follows.
    expect(within(screen.getByRole('region', { name: 'Your answer' })).getByText('Resolved')).toBeTruthy();
    const round = screen.getByLabelText('Round 1');
    expect(round.textContent).toContain('You chose “Keep complete history”');
    expect(round.textContent).toContain('Recorded the original reply and receipt-test follow-up.');
    fireEvent.click(within(round).getByRole('button', { name: /Add the receipt lookup test/ }));
    expect(open).toHaveBeenCalledWith('1.1');
    fireEvent.click(within(screen.getByRole('region', { name: 'Child items' })).getByRole('button', { name: /Add the receipt lookup test/ }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole('region', { name: 'Item links' })).getAllByRole('link').map(link => link.textContent)).toEqual(item.links.map(link => link.label));
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    // Owner messages on the item join as replies, as the handoff keeps them in `updated`.
    const replies = session.messages.filter(message => message.author === 'owner' && message.item_id === item.id).map(message => message.id);
    expect(replies.length).toBeGreaterThan(0);
    expect(timeline.querySelectorAll('.excerpt-timeline')).toHaveLength(new Set([item.created_message_id, ...item.updated_message_ids, ...replies]).size);
    expect(timeline.querySelector('.excerpt-created .excerpt-mark')!.textContent).toBe('Agent raised this');
    expect([...timeline.querySelectorAll('.excerpt-mark')].map(mark => mark.textContent)).toContain('You replied');
    expect(screen.getByText('Agent reference').parentElement!.querySelector('code')!.textContent).toBe('1');
  });
  it('deduplicates a message that both created and updated the item into one timeline entry', async () => {
    const value = await ready(session => {
      const item = session.items['1']!;
      item.updated_message_ids = [item.created_message_id, ...item.updated_message_ids, item.updated_message_ids[0]];
    }), item = value.transport.session.items['1']!;
    render(panel(value));
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    const replies = value.transport.session.messages.filter(message => message.author === 'owner' && message.item_id === item.id).map(message => message.id);
    const ids = new Set([...item.updated_message_ids, ...replies]);
    expect(timeline.querySelectorAll('.excerpt-timeline')).toHaveLength(ids.size);
    expect(timeline.querySelector('.excerpt-created .excerpt-mark')!.textContent).toBe('Agent raised this · Agent updated');
  });
  it('shows the outcome before reopening and never offers Back to Open on a replaced item', async () => {
    const reopened = await ready(session => {
      const item = session.items['1']!;
      item.status = 'open'; item.outcome = null;
      item.status_history.push({ ...item.status_history[0], old_status: 'done', new_status: 'open', previous_outcome: 'Former exact outcome', reason: 'Owner requested more work' });
    });
    render(panel(reopened));
    expect((await screen.findByText('Before you reopened it')).parentElement!.textContent).toContain('Done');
    expect(screen.getByText('Former exact outcome')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Not discussed yet' })).toBeTruthy();
    cleanup();
    const replaced = await ready(session => { session.items['1']!.status = 'replaced'; session.items['1']!.replaced_by = '4'; });
    render(panel(replaced));
    expect(((await screen.findByRole('button', { name: 'Back to Open' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Record retry limits/ })).toBeTruthy();
  });
  it('hides owner actions in closed sessions and archived topics', async () => {
    const value = await ready(), item = value.transport.session.items['1']!;
    const rendered = render(panel(value));
    await screen.findByRole('region', { name: 'Revisit' });
    value.transport.session.state = 'closed'; value.transport.session.revision++;
    await act(() => value.store.refresh());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Revisit' })).toBeNull());
    value.transport.session.state = 'active'; value.transport.session.topics[item.topic_id]!.archived_at = '2026-10-04T00:00:00.000Z'; value.transport.session.revision++;
    await act(() => value.store.refresh());
    expect(screen.queryByRole('region', { name: 'Revisit' })).toBeNull();
    expect(screen.getByRole('heading', { name: item.question })).toBeTruthy();
    rendered.unmount();
  });
  it('names the path by short labels, cutting long names at a word boundary', async () => {
    const value = await ready(session => { session.topics[session.items['1']!.topic_id]!.name = 'Delivery decisions for the whole receipt pipeline'; });
    render(<DetailPath store={value.store} itemId="1.1" onOpenItem={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Item location' }).textContent).toBe('Delivery decisions for…Keep the full reply…'));
  });
});

describe('complete message rail', () => {
  it('accepts ordinary inline parent callbacks without republishing unchanged selection, then updates the latest callback and cleans up once', async () => {
    const value = await ready();
    let renders = 0, calls = 0;
    const cleanupCalls: ReadonlySet<string>[] = [];
    function Parent() {
      const [selection, setSelection] = useState({ items: new Set<string>(), messages: new Set<string>() });
      const [generation, setGeneration] = useState(1);
      ++renders;
      return <><button type="button" onClick={() => setGeneration(current => current + 1)}>New parent callback</button>
        <output aria-label="Parent highlights">{generation}:{[...selection.items].join(',')}:{[...selection.messages].join(',')}</output>
        <MessageRail {...value} onReveal={vi.fn()} onHighlight={(items, messages) => {
          ++calls;
          if (generation === 2) cleanupCalls.push(messages);
          setSelection({ items: new Set(items), messages: new Set(messages) });
        }} /></>;
    }
    const rendered = render(<Parent />);
    const log = screen.getByRole('log');
    await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(value.transport.session.messages.length));
    expect(renders).toBeLessThan(10);
    const before = calls;
    fireEvent.click(screen.getByRole('button', { name: 'New parent callback' }));
    expect(calls).toBe(before);
    const message = value.transport.session.messages.find(message => message.item_id === '1')!;
    const card = log.querySelector(`[data-message-id="${message.id}"]`)!;
    fireEvent.mouseEnter(card);
    expect(screen.getByLabelText('Parent highlights').textContent).toBe(`2:1:${message.id}`);
    expect(calls).toBe(before + 1);
    expect(cleanupCalls.at(-1)).toEqual(new Set([message.id]));
    fireEvent.click(card.querySelector('.history-body')!);
    fireEvent.mouseLeave(card);
    expect(card.classList.contains('history-pinned')).toBe(true);
    expect(screen.getByLabelText('Parent highlights').textContent).toBe(`2:1:${message.id}`);
    const beforeUnmount = calls;
    rendered.unmount();
    expect(calls).toBe(beforeUnmount + 1);
    expect(cleanupCalls.at(-1)).toEqual(new Set());
  });
  it('cross-highlights canonical item links on hover/pin and selected item, preserving registered reveal', async () => {
    const value = await ready(), highlight = vi.fn(), reveal = vi.fn();
    const rendered = render(<MessageRail {...value} selectedItemId="2" onHighlight={highlight} onReveal={reveal} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(value.transport.session.messages.length));
    const message = value.transport.session.messages.find(message => message.item_id === '1')!;
    const card = log.querySelector(`[data-message-id="${message.id}"]`)!;
    fireEvent.mouseEnter(card);
    expect(highlight).toHaveBeenLastCalledWith(new Set(['1']), new Set([message.id]));
    fireEvent.click(card.querySelector('.history-body')!); fireEvent.mouseLeave(card);
    expect(card.classList.contains('history-pinned')).toBe(true);
    expect(highlight).toHaveBeenLastCalledWith(new Set(['1']), new Set([message.id]));
    const selected = value.transport.session.messages.find(message => message.item_id === '2')!;
    expect(log.querySelector(`[data-message-id="${selected.id}"]`)!.classList.contains('history-highlight')).toBe(true);
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Item 1' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'item' })));
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: `Unpin message ${message.number}` }));
    expect(highlight).toHaveBeenLastCalledWith(new Set(), new Set());
    rendered.unmount(); expect(highlight).toHaveBeenLastCalledWith(new Set(), new Set());
  });
  it('an update landing before the scroll event is delivered does not yank a reader scrolled up', async () => {
    const value = await ready();
    render(<MessageRail {...value} onHighlight={vi.fn()} onReveal={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(15));
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    log.scrollTop = 800; fireEvent.scroll(log);
    log.scrollTop = 250; // programmatic scroll whose scroll event has not been dispatched yet
    value.transport.session.messages.push(extraMessage(value.transport.session, 16));
    value.transport.session.revision = 22;
    await act(() => value.store.refresh());
    await screen.findByRole('button', { name: '1 new messages · Jump to latest' });
    expect(log.scrollTop).toBe(250);
  });
  it('upward scrolling pauses follow; new messages count without changing focus/scroll until an explicit jump', async () => {
    const value = await ready();
    render(<><input aria-label="Unsent draft" defaultValue="exact draft  " /><MessageRail {...value} onHighlight={vi.fn()} onReveal={vi.fn()} /></>);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(15));
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    log.scrollTop = 800; fireEvent.scroll(log); log.scrollTop = 250; fireEvent.scroll(log);
    const input = screen.getByLabelText('Unsent draft'); input.focus();
    value.transport.session.messages.push(extraMessage(value.transport.session, 16), extraMessage(value.transport.session, 17));
    value.transport.session.revision = 22;
    await act(() => value.store.refresh());
    await screen.findByRole('button', { name: '2 new messages · Jump to latest' });
    expect(log.scrollTop).toBe(250); expect(document.activeElement).toBe(input); expect((input as HTMLInputElement).value).toBe('exact draft  ');
    fireEvent.click(screen.getByRole('button', { name: '2 new messages · Jump to latest' }));
    expect(log.scrollTop).toBe(1000); expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    expect(document.activeElement).toBe(input);
    value.transport.session.messages.push(extraMessage(value.transport.session, 18)); value.transport.session.revision = 23;
    await act(() => value.store.refresh());
    await screen.findByText('New exact message 18');
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });
  it('a scrollTop that shrank only because the viewport grew keeps following after a jump', async () => {
    const value = await ready();
    render(<MessageRail {...value} onHighlight={vi.fn()} onReveal={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(15));
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, writable: true, value: 200 } });
    log.scrollTop = 800; fireEvent.scroll(log); log.scrollTop = 250; fireEvent.scroll(log);
    value.transport.session.messages.push(extraMessage(value.transport.session, 16));
    value.transport.session.revision = 22;
    await act(() => value.store.refresh());
    fireEvent.click(await screen.findByRole('button', { name: '1 new messages · Jump to latest' }));
    expect(log.scrollTop).toBe(1000);
    // The Jump button unmounted; the viewport grew, so the browser clamped scrollTop but it is still at the bottom.
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 240 });
    log.scrollTop = 760;
    value.transport.session.messages.push(extraMessage(value.transport.session, 17)); value.transport.session.revision = 23;
    await act(() => value.store.refresh());
    await screen.findByText('New exact message 17');
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    expect(log.scrollTop).toBe(1000);
  });
});
