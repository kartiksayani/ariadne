import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { DetailPath, ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { MessageRail } from '../../../src/ui/rail/MessageRail';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { withdrawn } from '../../../src/selectors/waiting/stuck';
import { immutable } from '../../../src/data';
import { extraMessage, setup } from './fixtures';

const copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: (text: string) => copy(text) }));
const opened: ReturnType<typeof setup>[] = [];
async function ready(change?: (session: ReturnType<typeof setup>['transport']['session']) => void) {
  const value = setup(); opened.push(value); change?.(value.transport.session); await value.store.refresh(); return value;
}
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); copy.mockClear(); });
type FixtureSession = ReturnType<typeof setup>['transport']['session'];
/** The rail keeps cancellations; only an edited message sent again leaves the history. */
const shown = (session: FixtureSession) => session.messages.filter(message => !withdrawn(immutable(session), immutable(message))).length;

describe('cancelled owner text in the chat and Messages', () => {
  it.each([
    { cause: 'owner' as const, attempted: false }, { cause: 'owner' as const, attempted: true },
    { cause: undefined, attempted: false }, { cause: undefined, attempted: true },
    { cause: 'owner_edit' as const, attempted: false }, { cause: 'owner_edit' as const, attempted: true },
    { cause: 'topic_archived' as const, attempted: false }, { cause: 'topic_archived' as const, attempted: true },
    { cause: 'session_closed' as const, attempted: false }, { cause: 'session_closed' as const, attempted: true },
  ])('keeps and labels the complete text for cause $cause, after an attempt: $attempted', async ({ cause, attempted }) => {
    const body = '  Cancelled owner words\nKeep every line and trailing spaces  ', highlight = vi.fn();
    const value = await ready(session => {
      const input = session.inputs['00000000-0000-4000-8000-000000000076']!;
      input.kind = 'reply'; input.state = 'cancelled'; input.cancel_cause = cause;
      input.attempts = attempted ? structuredClone(session.inputs['00000000-0000-4000-8000-000000000072']!.attempts) : [];
      input.payload.text = body;
      session.messages.find(message => message.id === input.message_id)!.body = body;
    }), session = value.transport.session, input = session.inputs['00000000-0000-4000-8000-000000000076']!;
    const warning = attempted ? 'Cancelled — the agent may already have seen it' : 'Cancelled before it reached the agent';
    const line = cause === 'owner_edit' ? `Taken back to edit. ${warning}`
      : !attempted && cause === 'topic_archived' ? 'Not sent: cancelled when you archived this topic'
      : !attempted && cause === 'session_closed' ? 'Not sent: cancelled when you closed this session' : warning;
    render(<><ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="4" later={false} onOpenItem={vi.fn()} />
      <MessageRail {...value} onHighlight={highlight} /></>);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const turn = chat.querySelector<HTMLElement>(`[data-message-id="${input.message_id}"]`)!;
    expect(turn).not.toBeNull(); expect(turn.classList.contains('detail-turn-cancelled')).toBe(true);
    expect(turn.textContent).toContain('Cancelled owner words'); expect(turn.textContent).toContain('Keep every line and trailing spaces');
    expect(turn.textContent).toContain(line); expect(turn.hasAttribute('data-owner-said')).toBe(false);
    expect(turn.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    fireEvent.click(within(turn).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(body);
    const log = screen.getByRole('log');
    const card = await waitFor(() => { const found = log.querySelector<HTMLElement>(`[data-message-id="${input.message_id}"]`); expect(found).not.toBeNull(); return found!; });
    expect(card.querySelector('.pw-excerpt-text')!.textContent).toBe(body);
    expect(card.parentElement!.classList.contains('pw-excerpt-cancelled')).toBe(true);
    expect(card.parentElement!.textContent).toContain(line);
    expect(card.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    if (cause === 'owner' || cause === undefined) {
      fireEvent.click(within(card.parentElement!).getByRole('button', { name: 'Copy message' }));
      expect(copy).toHaveBeenLastCalledWith(body);
    }
    fireEvent.click(card);
    expect(highlight).toHaveBeenLastCalledWith(new Set([input.target.item_id]), new Set([input.message_id]));
  });
});

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
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getAllByText(`codex #${created.number}`).length).toBeGreaterThan(0);
    const log = await screen.findByRole('log');
    await waitFor(() => expect(log.querySelector(`[data-message-id="${created.id}"] .pw-excerpt-number`)?.textContent).toBe(`codex #${created.number}`));
  });

  it('reads every section from the session snapshot in the handoff order', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1']!, open = vi.fn();
    render(panel(value, '1', open));
    await screen.findByRole('heading', { name: item.question });
    const created = session.messages.find(message => message.id === item.created_message_id)!;
    expect(screen.getByText(`Decision · next action: you · raised in #${created.number}`)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getAllByText(`#${created.number}`).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toBe(`Done${item.outcome}`);
    expect(screen.getByText(item.why!)).toBeTruthy();
    // One transcript follows the item context; revisit actions sit in the dock.
    const detail = document.querySelector('.item-detail')!;
    expect([...detail.children].map(element => element.className)).toEqual(['detail-body', 'detail-dock']);
    const order = [...document.querySelectorAll('.detail-body > section, .detail-body > div')].map(element => element.getAttribute('aria-label') ?? element.className);
    const body = ['detail-head', 'Your answer', 'Current outcome', 'Child items', 'Item links', 'Conversation'];
    expect(order.filter(name => body.includes(name))).toEqual(body);
    expect([...detail.querySelectorAll('.detail-dock .detail-quick-actions > section')].map(element => element.getAttribute('aria-label'))).toEqual(['Revisit']);
    // The handled answer is the request the stepper follows.
    expect(within(screen.getByRole('region', { name: 'Your answer' })).getByText('Resolved')).toBeTruthy();
    expect(screen.queryByText('Back and forth')).toBeNull();
    expect(screen.queryByLabelText(/^Round \d/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Round \d/);
    const chat = screen.getByRole('region', { name: 'Conversation' });
    expect(chat.textContent).toContain('You chose “Keep complete history”');
    expect(chat.textContent).toContain('Retain the full history, including earlier outcomes.');
    expect(chat.textContent).toContain('The full history is retained.');
    expect(chat.textContent).not.toContain('Recorded the original reply and receipt-test follow-up.');
    fireEvent.click(within(chat).getByRole('button', { name: /Branched into Add the receipt lookup test/ }));
    expect(open).toHaveBeenCalledWith('1.1');
    fireEvent.click(within(screen.getByRole('region', { name: 'Child items' })).getByRole('button', { name: /Add the receipt lookup test/ }));
    expect(open).toHaveBeenCalledTimes(2);
    // Without a desktop to open files, a link to a file is its label as plain text (see item-links.test.tsx).
    expect([...screen.getByRole('region', { name: 'Item links' }).querySelectorAll('.detail-link')].map(link => link.textContent)).toEqual(item.links.map(link => link.label));
    const expected = session.messages.filter(message => !withdrawn(immutable(session), immutable(message)) &&
      (message.id === item.created_message_id || item.updated_message_ids.includes(message.id) || message.item_id === item.id || message.items_touched.includes(item.id)))
      .sort((a, b) => a.number - b.number);
    expect([...chat.querySelectorAll<HTMLElement>('li[data-message-id]')].map(entry => entry.dataset.messageId)).toEqual(expected.map(message => message.id));
    expect(chat.querySelector('.detail-chat-marker')!.textContent).toBe('Agent raised this');
    expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull();
    expect(document.querySelector('.detail-head .detail-reference')!.contains(screen.getByText('Copy reference'))).toBe(true);
    expect(screen.getByText('Copy reference').parentElement!.querySelector('code')).toBeNull();
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
    const waiting = () => within(chat).queryByText('Waiting on you');
    const bubble = () => chat.querySelector<HTMLElement>('[data-pending="00000000-0000-4000-8000-000000000945"]');
    // On its way, the answer counts: it ends the conversation as a pending bubble and the round no longer waits on the owner.
    expect(bubble()!.textContent).toContain('Not sent yet');
    expect(bubble()!.textContent).toContain('You chose');
    expect(chat.querySelectorAll('.detail-msg-you')).toHaveLength(2);
    expect(waiting()).toBeNull();
    const input = session.inputs['00000000-0000-4000-8000-000000000945']!;
    input.state = 'cancelled'; input.cancel_cause = 'topic_archived'; session.revision++;
    await act(() => value.store.refresh());
    // Cancelled by archive: keep the choice visible, labelled, and Waiting on you again.
    await waitFor(() => expect(waiting()).toBeTruthy());
    expect(chat.querySelector('.detail-turn-cancelled')!.textContent).toContain('You chose');
    expect(bubble()).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByText('Not sent: cancelled when you archived this topic')).toBeTruthy();
    // Restore the topic: the cancelled answer stays cancelled, so it is still the owner's turn and the line stays.
    const topic = session.topics[session.items['2']!.topic_id]!;
    topic.archived_at = '2026-10-04T12:00:00.000Z'; session.revision++; await act(() => value.store.refresh());
    topic.archived_at = null; session.revision++; await act(() => value.store.refresh());
    await waitFor(() => expect(waiting()).toBeTruthy());
    expect(chat.querySelector('.detail-turn-cancelled')!.textContent).toContain('You chose');
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByText('Not sent: cancelled when you archived this topic')).toBeTruthy();
  });
  it('deduplicates messages shared by creation, updates, and rounds into one chat entry', async () => {
    const value = await ready(session => {
      const item = session.items['1']!;
      item.updated_message_ids = [item.created_message_id, ...item.updated_message_ids, item.updated_message_ids[0]];
    }), item = value.transport.session.items['1']!;
    render(panel(value));
    const timeline = await screen.findByRole('region', { name: 'Conversation' });
    const replies = value.transport.session.messages.filter(message => message.author === 'owner' && message.item_id === item.id && !withdrawn(immutable(value.transport.session), immutable(message))).map(message => message.id);
    const ids = new Set([...item.updated_message_ids.filter(id => value.transport.session.messages.some(message => message.id === id && !withdrawn(immutable(value.transport.session), immutable(message)))), ...replies]);
    const entries = [...timeline.querySelectorAll<HTMLElement>('li[data-message-id]')];
    expect(entries.map(entry => entry.dataset.messageId)).toEqual([...ids].sort((a, b) => value.transport.session.messages.find(message => message.id === a)!.number - value.transport.session.messages.find(message => message.id === b)!.number));
    expect(timeline.querySelector('.detail-chat-marker')!.textContent).toBe('Agent raised this');
  });
  it('shows a short result only beneath the owner message with no full agent reply before the next owner message', async () => {
    const value = await ready(session => {
      const item = session.items['1']!, round = Object.values(session.rounds).find(value => value?.item_id === item.id)!;
      const full = session.messages.find(message => message.id === round.agent_message_ids[0])!;
      const later = session.messages.find(message => message.id === round.owner_message_ids[1])!;
      // The original result remains valid, but its full response belongs after the next owner turn.
      full.number = 12;
      const input = session.inputs[later.input_id!]!;
      input.state = 'handled'; delete input.cancel_cause;
      later.body = 'Second owner message';
      input.payload.text = later.body;
      input.payload.selected_option_id = null;
      session.answers = session.answers.filter(answer => answer.message_id !== later.id);
    });
    render(panel(value));
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const first = chat.querySelector<HTMLElement>('[data-message-id="00000000-0000-4000-8000-000000000102"]')!;
    const second = chat.querySelector<HTMLElement>('[data-message-id="00000000-0000-4000-8000-000000000111"]')!;
    expect(first.querySelector('.detail-msg-result')!.textContent).toContain('Recorded the original reply and receipt-test follow-up.');
    expect(second.querySelector('.detail-msg-result')).toBeNull();
    expect(chat.querySelectorAll('.detail-msg-result')).toHaveLength(1);
    const full = value.transport.session.messages.find(message => message.id === '00000000-0000-4000-8000-000000000103')!;
    full.number = 3; value.transport.session.revision++;
    await act(() => value.store.refresh());
    await waitFor(() => expect(chat.querySelector('.detail-msg-result')).toBeNull());
    expect(chat.textContent).toContain('The full history is retained.');
  });

  it('keeps rail highlights and parent provenance on the single transcript', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1.1']!, open = vi.fn();
    const highlights = new Set([item.created_message_id]);
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId={item.id} later={false} onOpenItem={open} highlightedMessageIds={highlights} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    expect(within(chat).getByText('Parent raised here')).toBeTruthy();
    expect(within(chat).getByText('Agent raised this')).toBeTruthy();
    const parent = session.items[item.parent!]!;
    expect(chat.querySelector(`[data-message-id="${parent.created_message_id}"]`)!.textContent).toContain(parent.question);
    const raised = chat.querySelector(`[data-message-id="${item.created_message_id}"]`)!;
    expect(raised.classList.contains('excerpt-highlighted')).toBe(true);
    expect(chat.querySelectorAll('li[data-message-id]')).toHaveLength(2);
    expect(within(raised as HTMLElement).getByRole('button', { name: 'Copy message' })).toBeTruthy();
  });

  it('deduplicates the current ask against its full agent message and keeps one Waiting on you tag', async () => {
    const value = await ready(session => {
      const item = session.items['2']!, round = session.rounds[item.current_round_id!]!;
      const message = session.messages.find(message => message.id === round.agent_message_ids[0])!;
      message.body = 'Full explanation.';
      // An earlier handled reply does not answer this newly raised ask.
      round.owner_message_ids = [];
      round.result_input_ids = [];
    });
    render(panel(value, '2'));
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    expect(chat.textContent!.split(value.transport.session.items['2']!.ask!).length - 1).toBe(1);
    expect(within(chat).getAllByText('Waiting on you')).toHaveLength(1);
    expect(within(chat).getByText('Full explanation.')).toBeTruthy();
    expect(document.querySelectorAll('.detail-ask')).toHaveLength(0);
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
  it('keeps a queued message visible when the owner deletes it, and changes its label immediately', async () => {
    const value = await ready(), session = value.transport.session;
    render(<MessageRail {...value} onHighlight={vi.fn()} />);
    const log = screen.getByRole('log'); await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(session)));
    const queued = Object.values(session.inputs).find(input => input?.state === 'queued' && input.attempts.length === 0 && input.kind !== 'continue')!;
    const message = session.messages.find(message => message.id === queued.message_id)!;
    expect(log.querySelector(`[data-message-id="${queued.message_id}"]`)).not.toBeNull();
    queued.state = 'cancelled'; queued.cancel_cause = 'owner'; session.revision++;
    await act(() => value.store.refresh());
    await waitFor(() => expect(log.querySelector(`[data-message-id="${queued.message_id}"]`)!.parentElement!.textContent).toContain('Cancelled before it reached the agent'));
    expect(log.querySelector(`[data-message-id="${queued.message_id}"]`)!.textContent).toContain(message.body);
    expect(log.querySelectorAll('[data-message-id]')).toHaveLength(shown(session));
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
