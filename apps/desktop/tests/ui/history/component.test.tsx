import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { QueryResult } from '../../../src/generated/core';
import { ItemDetail, itemTimeline } from '../../../src/components/history/ItemDetail';
import { MessageRail } from '../../../src/components/rail/MessageRail';
import { immutable } from '../../../src/data/session-store';
import { deferred, extraMessage, page, projections, setup } from './fixtures';

const opened: ReturnType<typeof setup>[] = [];
async function ready() { const value = setup(); opened.push(value); await value.store.refresh(); return value; }
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });

describe('complete item detail', () => {
  it('renders five rounds, exact full answer/reply/result bodies, two registered forks and terminal follow-up', async () => {
    const value = await ready(), reveal = vi.fn(), intent = vi.fn();
    render(<ItemDetail {...value} itemId="1" onReveal={reveal} onIntent={intent} />);
    await waitFor(() => expect(screen.getAllByRole('region', { name: /^Round / })).toHaveLength(5));
    const expected = projections(value.transport.session);
    for (let index = 0; index < 5; index++) {
      const round = screen.getByRole('region', { name: `Round ${index + 1}` });
      expect(round.textContent).toContain(expected.rounds[index].round.ask_snapshot);
      expect(round.textContent).toContain(expected.rounds[index].answers.items[0].text);
      expect(round.textContent).toContain(expected.rounds[index].agent_messages.items[0].body);
      expect(round.textContent).toContain(expected.rounds[index].results.items[0].result.explanation);
      expect(round.querySelectorAll('[data-message-id="'+expected.rounds[index].owner_messages.items[0].id+'"]').length).toBe(0);
    }
    expect(screen.getAllByRole('button', { name: /^Fork ·/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /^Fork · Item 1.1/ }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'item', route: expect.objectContaining({ item_id: '1.1' }) })));
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect(intent).toHaveBeenCalledWith('followup', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Request reopen' }));
    expect(intent).toHaveBeenCalledWith('reopen', '1');
    fireEvent.click(screen.getByRole('button', { name: /^Timeline ·/ }));
    const messages = document.querySelectorAll('.history-timeline [data-message-id]');
    expect(new Set([...messages].map(element => element.getAttribute('data-message-id'))).size).toBe(messages.length);
  });
  it('keeps former outcome/reason after reopen and never offers replaced-item reopen', async () => {
    const value = await ready(), item = value.transport.session.items['1']!;
    item.status = 'open'; item.outcome = null;
    item.status_history.push({ ...item.status_history[0], old_status: 'done', new_status: 'open',
      previous_outcome: 'Former exact outcome\nretained', previous_why: 'Former exact reason', reason: 'Owner requested more work' });
    render(<ItemDetail {...value} itemId="1" onReveal={vi.fn()} onIntent={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Former outcome' }).some(section => section.textContent?.includes('Former exact outcome\nretained'))).toBe(true));
    expect(screen.getByText('Former exact reason')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request reopen' })).toBeNull();
    cleanup(); item.status = 'replaced';
    render(<ItemDetail {...value} itemId="1" onReveal={vi.fn()} onIntent={vi.fn()} />);
    await screen.findByRole('button', { name: 'Follow up' });
    expect(screen.queryByRole('button', { name: 'Request reopen' })).toBeNull();
  });
  it('deduplicates activity backlinks as one timeline event, without manufacturing another conversation reply', () => {
    const value = setup(); value.sessions.closeAll();
    const projection = projections(value.transport.session);
    const activity = value.transport.session.messages[0];
    activity.items_touched = ['1', '2'];
    projection.read.updated_messages.items.push(activity, activity);
    const timeline = itemTimeline(immutable({ conversation: projection.conversation, item: projection.read,
      rounds: { item_id: '1', rounds: page(projection.rounds) } }));
    expect(timeline.filter(message => message.id === activity.id)).toHaveLength(1);
    expect(projection.conversation.messages.items.every(message => message.kind === 'owner_input' || message.kind === 'reply')).toBe(true);
  });
  it('retains previous complete history on failure and retries without clearing bodies', async () => {
    const value = await ready();
    const intent = vi.fn();
    render(<ItemDetail {...value} itemId="1" onReveal={vi.fn()} onIntent={intent} />);
    await screen.findByText('Round 5 exact question');
    value.transport.session.revision = 22;
    value.transport.override = request => {
      if ('request' in request && request.request.command === 'item_rounds') throw new Error('fixture transport unavailable');
      return;
    };
    await act(() => value.store.refresh());
    await screen.findByRole('alert');
    expect(screen.getByText('Round 5 exact question')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('previous complete history');
    expect((screen.getByRole('button', { name: 'Follow up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' })); expect(intent).not.toHaveBeenCalled();
    value.transport.override = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry history read' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('reads location, children and complete link targets; closed sessions and archived topics disable owner intents', async () => {
    const value = await ready(), item = value.transport.session.items['1']!, intent = vi.fn(), reveal = vi.fn();
    item.links = [{ kind: 'file', label: 'Exact source', target: 'src/full/path.ts:40' }];
    const rendered = render(<ItemDetail {...value} itemId="1" onReveal={reveal} onIntent={intent} />);
    await screen.findByText('src/full/path.ts:40', { exact: false });
    expect(screen.getByRole('navigation', { name: 'Item location' }).textContent).toContain(value.transport.session.topics[item.topic_id]!.name);
    const children = screen.getByRole('region', { name: 'Child items' });
    fireEvent.click(within(children).getByRole('button', { name: /^Item 1.1/ }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'item', route: expect.objectContaining({ item_id: '1.1' }) })));
    value.transport.session.state = 'closed'; value.transport.session.revision++;
    await act(() => value.store.refresh());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Follow up' }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' })); expect(intent).not.toHaveBeenCalled();
    value.transport.session.state = 'active'; value.transport.session.topics[item.topic_id]!.archived_at = '2026-10-04T00:00:00.000Z'; value.transport.session.revision++;
    await act(() => value.store.refresh());
    await screen.findByText(`done · decision · history revision ${value.transport.session.revision}`);
    expect((screen.getByRole('button', { name: 'Request reopen' }) as HTMLButtonElement).disabled).toBe(true);
    rendered.unmount();
  });
  it('never publishes a superseded selected item or a closed-store read', async () => {
    const value = await ready(), pending = deferred<QueryResult>();
    value.transport.override = request => 'request' in request && request.request.command === 'item_messages' && request.request.params.item_id === '1' ? pending.promise : undefined;
    const rendered = render(<ItemDetail {...value} itemId="1" onReveal={vi.fn()} />);
    await waitFor(() => expect(value.transport.calls.some(request => 'request' in request && request.request.command === 'item_messages')).toBe(true));
    rendered.rerender(<ItemDetail {...value} itemId={null} onReveal={vi.fn()} />);
    await act(async () => { pending.resolve({ kind: 'item_messages', data: projections(value.transport.session).conversation }); });
    expect(screen.queryByText('Round 1 exact question')).toBeNull();
    expect(screen.getByText('Select an item to read its complete history.')).toBeTruthy();
    expect(value.transport.calls.filter(request => 'request' in request && ['item_rounds', 'session_read'].includes(request.request.command))).toHaveLength(0);
    rendered.rerender(<ItemDetail {...value} itemId="1" onReveal={vi.fn()} />);
    await act(() => value.sessions.closeAll());
    expect(screen.queryByText('Round 1 exact question')).toBeNull();
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
});
