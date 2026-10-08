import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { DetailPath, ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { MessageRail } from '../../../src/ui/rail/MessageRail';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { withdrawn } from '../../../src/selectors/waiting/stuck';
import { immutable } from '../../../src/data';
import { extraMessage, setup } from './fixtures';

const opened: ReturnType<typeof setup>[] = [];
async function ready(change?: (session: ReturnType<typeof setup>['transport']['session']) => void) {
  const value = setup(); opened.push(value); change?.(value.transport.session); await value.store.refresh(); return value;
}
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });
type FixtureSession = ReturnType<typeof setup>['transport']['session'];
/** The rail's message count: the owner messages cancelled before they were sent are left out. */
const shown = (session: FixtureSession) => session.messages.filter(message => !withdrawn(immutable(session), immutable(message))).length;

describe('item detail panel', () => {
  const panel = (value: Awaited<ReturnType<typeof ready>>, itemId = '1', open = vi.fn()) =>
    <ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId={itemId} later={false} onOpenItem={open} />;

  it('names the agent in an earlier session’s message numbers, in the detail and the rail', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1']!;
    const created = session.messages.find(message => message.id === item.created_message_id)!;
    render(<><ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} earlierAgent="codex" />
      <MessageRail {...value} onHighlight={() => {}} earlierAgent="codex" /></>);
    await screen.findByRole('heading', { name: item.question });
    expect(screen.getByText(`Decision · next action: you · raised in codex #${created.number}`)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getAllByText(`codex #${created.number}`).length).toBeGreaterThan(0);
    const log = await screen.findByRole('log');
    await waitFor(() => expect(log.querySelector(`[data-message-id="${created.id}"] .pw-excerpt-number`)?.textContent).toBe(`codex #${created.number}`));
  });

  it('reads every section from the session snapshot in the handoff order', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1']!, open = vi.fn();
    render(panel(value, '1', open));
    await screen.findByRole('heading', { name: item.question });
    const created = session.messages.find(message => message.id === item.created_message_id)!;
    expect(screen.getByText(`Decision · next action: you · raised in #${created.number}`)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getAllByText(`#${created.number}`).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toBe(`Done${item.outcome}`);
    expect(screen.getByText(item.why!)).toBeTruthy();
    // Reference first (scrolls), the conversation last; the revisit actions sit in the dock, outside the scrolling body.
    const detail = document.querySelector('.item-detail')!;
    expect([...detail.children].map(element => element.className)).toEqual(['detail-body', 'detail-dock']);
    const order = [...document.querySelectorAll('.detail-body > section, .detail-body > div')].map(element => element.getAttribute('aria-label') ?? element.className);
    const body = ['detail-head', 'Your answer', 'Current outcome', 'Child items', 'Item links', 'Timeline', 'detail-reference', 'Conversation'];
    expect(order.filter(name => body.includes(name))).toEqual(body);
    expect([...detail.querySelectorAll('.detail-dock > section')].map(element => element.getAttribute('aria-label'))).toEqual(['Revisit']);
    // The handled answer is the request the stepper follows.
    expect(within(screen.getByRole('region', { name: 'Your answer' })).getByText('Resolved')).toBeTruthy();
    expect(screen.queryByText('Back and forth')).toBeNull();
    expect(screen.queryByLabelText(/^Round \d/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Round \d/);
    const round = document.querySelector<HTMLElement>('[data-round="1"]')!;
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
  it('does not count an answer that archive cancelled as the owner’s answer: Waiting on you, with the not-sent line', async () => {
    const value = await ready(session => {
      // Item 2 is asked a second time (round 2); the owner answers it with a message that is still queued.
      const item = session.items['2']!, first = session.rounds[item.current_round_id!]!, second = structuredClone(first);
      second.id = '00000000-0000-4000-8000-000000000943'; second.ordinal = 2; second.owner_message_ids = ['00000000-0000-4000-8000-000000000944'];
      session.rounds[second.id] = second; item.current_round_id = second.id;
      const input = structuredClone(session.inputs['00000000-0000-4000-8000-000000000071']!);
      input.id = '00000000-0000-4000-8000-000000000945'; input.kind = 'answer'; input.state = 'queued'; input.attempts = [];
      input.message_id = second.owner_message_ids[0]!; input.answer_id = '00000000-0000-4000-8000-000000000946';
      // The choice is one of the options the owner saw, so its bubble reads "You chose …".
      input.payload.selected_option_id = session.answers[0]!.selected_option_id;
      input.payload.target_snapshot.options = structuredClone(session.answers[0]!.options_snapshot);
      session.inputs[input.id] = input;
      const message = structuredClone(session.messages.find(entry => entry.id === first.owner_message_ids[0])!);
      message.id = second.owner_message_ids[0]!; message.number = 40; message.input_id = input.id; message.round_id = second.id;
      session.messages.push(message);
      const answer = structuredClone(session.answers[0]!);
      answer.id = input.answer_id; answer.item_id = item.id; answer.input_id = input.id; answer.message_id = message.id; answer.seq = 99; answer.supersedes_answer_id = null;
      answer.question_revision = item.question_revision;
      session.answers.push(answer);
    }), session = value.transport.session;
    render(panel(value, '2'));
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const round = () => chat.querySelector<HTMLElement>('[data-round="2"]')!;
    const bubble = () => chat.querySelector<HTMLElement>('[data-pending="00000000-0000-4000-8000-000000000945"]');
    // On its way, the answer counts: it ends the conversation as a pending bubble and the round no longer waits on the owner.
    expect(bubble()!.textContent).toContain('Not sent yet');
    expect(bubble()!.textContent).toContain('You chose');
    expect(round().textContent).not.toContain('You chose');
    expect(within(round()).queryByText('Waiting on you')).toBeNull();
    const input = session.inputs['00000000-0000-4000-8000-000000000945']!;
    input.state = 'cancelled'; input.cancel_cause = 'topic_archived'; session.revision++;
    await act(() => value.store.refresh());
    // Cancelled by archive, it never reached the agent: not "You chose", and Waiting on you again.
    await waitFor(() => expect(within(round()).getByText('Waiting on you')).toBeTruthy());
    expect(chat.textContent).not.toContain('You chose');
    expect(bubble()).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getByText('Not sent: cancelled when you archived this topic')).toBeTruthy();
    // Restore the topic: the cancelled answer stays cancelled, so it is still the owner's turn and the line stays.
    const topic = session.topics[session.items['2']!.topic_id]!;
    topic.archived_at = '2026-10-04T12:00:00.000Z'; session.revision++; await act(() => value.store.refresh());
    topic.archived_at = null; session.revision++; await act(() => value.store.refresh());
    await waitFor(() => expect(within(round()).getByText('Waiting on you')).toBeTruthy());
    expect(chat.textContent).not.toContain('You chose');
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getByText('Not sent: cancelled when you archived this topic')).toBeTruthy();
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
        <MessageRail {...value} onHighlight={(items, messages) => {
          ++calls;
          if (generation === 2) cleanupCalls.push(messages);
          setSelection({ items: new Set(items), messages: new Set(messages) });
        }} /></>;
    }
    const rendered = render(<Parent />);
    const log = screen.getByRole('log');
    await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(value.transport.session)));
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
    fireEvent.click(card);
    fireEvent.mouseLeave(card);
    expect(card.classList.contains('pw-excerpt-active')).toBe(true);
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Parent highlights').textContent).toBe(`2:1:${message.id}`);
    const beforeUnmount = calls;
    rendered.unmount();
    expect(calls).toBe(beforeUnmount + 1);
    expect(cleanupCalls.at(-1)).toEqual(new Set());
  });
  it('cross-highlights the items a message touched on hover and pin, and the messages of the selected or hovered item', async () => {
    const value = await ready(), highlight = vi.fn();
    const rendered = render(<MessageRail {...value} selectedItemId="2" onHighlight={highlight} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(value.transport.session)));
    const message = value.transport.session.messages.find(message => message.item_id === '1')!;
    const card = log.querySelector(`[data-message-id="${message.id}"]`)!;
    fireEvent.mouseEnter(card);
    expect(highlight).toHaveBeenLastCalledWith(new Set(['1']), new Set([message.id]));
    fireEvent.click(card); fireEvent.mouseLeave(card);
    expect(card.classList.contains('pw-excerpt-active')).toBe(true);
    expect(highlight).toHaveBeenLastCalledWith(new Set(['1']), new Set([message.id]));
    const selected = value.transport.session.messages.find(message => message.item_id === '2')!;
    expect(log.querySelector(`[data-message-id="${selected.id}"]`)!.classList.contains('pw-excerpt-highlight')).toBe(true);
    // A hovered item takes over from the selected one (Ariadne.dc.html:2082).
    rendered.rerender(<MessageRail {...value} selectedItemId="2" hoveredItemId="1" onHighlight={highlight} />);
    expect(log.querySelector(`[data-message-id="${selected.id}"]`)!.classList.contains('pw-excerpt-highlight')).toBe(false);
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(highlight).toHaveBeenLastCalledWith(new Set(), new Set());
    rendered.unmount(); expect(highlight).toHaveBeenLastCalledWith(new Set(), new Set());
  });
  it('shows the handoff header, follow state and excerpt meta', async () => {
    const value = await ready(), close = vi.fn();
    render(<MessageRail {...value} onHighlight={vi.fn()} onClose={close} />);
    const rail = screen.getByRole('complementary', { name: 'Messages' });
    await waitFor(() => expect(rail.querySelectorAll('[data-message-id]')).toHaveLength(shown(value.transport.session)));
    expect(within(rail).getByText(String(shown(value.transport.session)), { selector: '.pw-rail-count' })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: 'Following latest' })).toBeTruthy();
    const first = value.transport.session.messages[0]!;
    const card = rail.querySelector(`[data-message-id="${first.id}"]`)!;
    expect(card.querySelector('.pw-excerpt-number')!.textContent).toBe(`#${first.number}`);
    expect(card.querySelector('.pw-excerpt-who')!.textContent).toBe(first.author === 'owner' ? 'You' : first.author === 'agent' ? 'Agent' : 'System');
    fireEvent.click(within(rail).getByRole('button', { name: 'Hide messages' }));
    expect(close).toHaveBeenCalledOnce();
  });
  it('leaves out a message deleted before it was sent, and drops one the moment it is deleted', async () => {
    const value = await ready(), session = value.transport.session;
    render(<MessageRail {...value} onHighlight={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(session)));
    const gone = session.messages.filter(message => withdrawn(immutable(session), immutable(message)));
    expect(gone.length).toBeGreaterThan(0);
    for (const message of gone) expect(log.querySelector(`[data-message-id="${message.id}"]`)).toBeNull();
    const queued = Object.values(session.inputs).find(input => input?.state === 'queued' && input.attempts.length === 0 && input.kind !== 'continue')!;
    expect(log.querySelector(`[data-message-id="${queued.message_id}"]`)).not.toBeNull();
    queued.state = 'cancelled'; session.revision++;
    await act(() => value.store.refresh());
    await waitFor(() => expect(log.querySelector(`[data-message-id="${queued.message_id}"]`)).toBeNull());
  });
  it('keeps a message that archive or close cancelled, marked as not sent', async () => {
    const value = await ready(), session = value.transport.session;
    render(<MessageRail {...value} onHighlight={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(session)));
    const queued = Object.values(session.inputs).find(input => input?.state === 'queued' && input.attempts.length === 0 && input.kind !== 'continue')!;
    queued.state = 'cancelled'; queued.cancel_cause = 'topic_archived'; session.revision++;
    await act(() => value.store.refresh());
    const card = await waitFor(() => { const found = log.querySelector(`[data-message-id="${queued.message_id}"]`); expect(found).not.toBeNull(); return found!; });
    // The Not sent line sits beside the message button, in the same group.
    expect(card.parentElement!.textContent).toContain('Not sent: cancelled when you archived this topic');
  });
  it('offers Put back on a topic reply that archive cancelled, in the rail too', async () => {
    const value = await ready(), session = value.transport.session, drafts = new OwnerDraftStore(value.service);
    render(<MessageRail {...value} drafts={drafts} onHighlight={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(session)));
    const queued = Object.values(session.inputs).find(input => input?.state === 'queued' && input.attempts.length === 0 && input.kind !== 'continue')!;
    const topicId = queued.target.topic_id;
    queued.kind = 'topic_reply'; queued.target = { topic_id: topicId, item_id: null };
    queued.state = 'cancelled'; queued.cancel_cause = 'topic_archived'; session.revision++;
    await act(() => value.store.refresh());
    const card = await waitFor(() => { const found = log.querySelector(`[data-message-id="${queued.message_id}"]`); expect(found).not.toBeNull(); return found!; });
    // The button shows wherever the Not sent line shows.
    expect(card.parentElement!.textContent).toContain('Not sent: cancelled when you archived this topic');
    expect(within(card.parentElement!).getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
  });
  it('an update landing before the scroll event is delivered does not yank a reader scrolled up', async () => {
    const value = await ready();
    render(<MessageRail {...value} onHighlight={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(value.transport.session)));
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    log.scrollTop = 800; fireEvent.scroll(log);
    log.scrollTop = 250; // programmatic scroll whose scroll event has not been dispatched yet
    value.transport.session.messages.push(extraMessage(value.transport.session, 16));
    value.transport.session.revision = 22;
    await act(() => value.store.refresh());
    await screen.findByRole('button', { name: '1 new message · Jump to latest' });
    expect(log.scrollTop).toBe(250);
  });
  it('upward scrolling pauses follow; new messages count without changing focus/scroll until an explicit jump', async () => {
    const value = await ready();
    render(<><input aria-label="Unsent draft" defaultValue="exact draft  " /><MessageRail {...value} onHighlight={vi.fn()} /></>);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(value.transport.session)));
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
    render(<MessageRail {...value} onHighlight={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(value.transport.session)));
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, writable: true, value: 200 } });
    log.scrollTop = 800; fireEvent.scroll(log); log.scrollTop = 250; fireEvent.scroll(log);
    value.transport.session.messages.push(extraMessage(value.transport.session, 16));
    value.transport.session.revision = 22;
    await act(() => value.store.refresh());
    fireEvent.click(await screen.findByRole('button', { name: '1 new message · Jump to latest' }));
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
