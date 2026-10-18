import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DetailPath, ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { withdrawn } from '../../../src/selectors/waiting/stuck';
import { immutable } from '../../../src/data';
import { setup } from './fixtures';
import { notices } from '../../../src/ui/pages/notices';

const copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: (text: string) => copy(text) }));
const opened: ReturnType<typeof setup>[] = [];
async function ready(change?: (session: ReturnType<typeof setup>['transport']['session']) => void) {
  const value = setup(); opened.push(value); change?.(value.transport.session); await value.store.refresh(); return value;
}
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); notices.clear(); vi.restoreAllMocks(); copy.mockClear(); });
describe('cancelled owner text in the item conversation', () => {
  it.each([
    { cause: 'owner' as const, attempted: false }, { cause: 'owner' as const, attempted: true },
    { cause: undefined, attempted: false }, { cause: undefined, attempted: true },
    { cause: 'owner_edit' as const, attempted: false }, { cause: 'owner_edit' as const, attempted: true },
    { cause: 'topic_archived' as const, attempted: false }, { cause: 'topic_archived' as const, attempted: true },
    { cause: 'session_closed' as const, attempted: false }, { cause: 'session_closed' as const, attempted: true },
  ])('keeps and labels the complete text for cause $cause, after an attempt: $attempted', async ({ cause, attempted }) => {
    const body = '  Cancelled owner words\nKeep every line and trailing spaces  ';
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
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="4" later={false} onOpenItem={vi.fn()} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const turn = chat.querySelector<HTMLElement>(`[data-message-id="${input.message_id}"]`)!;
    expect(turn).not.toBeNull(); expect(turn.classList.contains('detail-turn-cancelled')).toBe(true);
    expect(turn.textContent).toContain('Cancelled owner words'); expect(turn.textContent).toContain('Keep every line and trailing spaces');
    expect(turn.textContent).toContain(line); expect(turn.hasAttribute('data-owner-said')).toBe(false);
    expect(turn.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    fireEvent.click(within(turn).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(body);
  });
});

describe('item detail panel', () => {
  const panel = (value: Awaited<ReturnType<typeof ready>>, itemId = '1', open = vi.fn()) =>
    <ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId={itemId} later={false} onOpenItem={open} />;

  it('names the agent in an earlier session’s message numbers', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1']!;
    const created = session.messages.find(message => message.id === item.created_message_id)!;
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} earlierAgent="codex" />);
    await screen.findByRole('heading', { name: item.question });
    expect(screen.getByText(`Decision · next action: you · raised in codex #${created.number}`)).toBeTruthy();
    // The conversation names things, not numbers: no message numbers in the chat.
    expect(within(screen.getByRole('region', { name: 'Conversation' })).queryByText(`codex #${created.number}`)).toBeNull();
  });

  it('reads every section from the session snapshot in the handoff order', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1']!, open = vi.fn();
    render(panel(value, '1', open));
    await screen.findByRole('heading', { name: item.question });
    const created = session.messages.find(message => message.id === item.created_message_id)!;
    expect(screen.getByText(`Decision · next action: you · raised in #${created.number}`)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Conversation' })).queryByText(`#${created.number}`)).toBeNull();
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
    fireEvent.click(within(chat).getByRole('button', { name: /Branched into Add the receipt lookup/ }));
    expect(open).toHaveBeenCalledWith('1.1');
    fireEvent.click(within(screen.getByRole('region', { name: 'Child items' })).getByRole('button', { name: /Add the receipt lookup test/ }));
    expect(open).toHaveBeenCalledTimes(2);
    // Without a desktop to open files, a link to a file is its label as plain text (see item-links.test.tsx).
    expect([...screen.getByRole('region', { name: 'Item links' }).querySelectorAll('.detail-link')].map(link => link.textContent)).toEqual(item.links.map(link => link.label));
    const expected = session.messages.filter(message => !withdrawn(immutable(session), immutable(message)) &&
      (message.id === item.created_message_id || item.updated_message_ids.includes(message.id) || message.item_id === item.id || message.items_touched.includes(item.id)))
      .sort((a, b) => a.number - b.number);
    expect([...chat.querySelectorAll<HTMLElement>('li[data-message-id]')].map(entry => entry.dataset.messageId)).toEqual(expected.map(message => message.id));
    expect(chat.querySelector('[data-testid="chat-label"]')!.firstElementChild!.textContent).toBe('Agent raised this');
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
    expect(bubble()!.textContent).toMatch(/Sent at \d\d:\d\d · waiting for the agent/u);
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
    expect(timeline.querySelector('[data-testid="chat-label"]')!.firstElementChild!.textContent).toBe('Agent raised this');
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

  it('keeps parent provenance on the single transcript', async () => {
    const value = await ready(), session = value.transport.session, item = session.items['1.1']!, open = vi.fn();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId={item.id} later={false} onOpenItem={open} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    // The parent's message is context, labelled like any agent message: no "Parent raised here" label (alpha.21 E12).
    expect(within(chat).queryByText('Parent raised here')).toBeNull();
    expect(within(chat).getByText('Agent raised this')).toBeTruthy();
    const parent = session.items[item.parent!]!;
    const parentMessage = session.messages.find(message => message.id === parent.created_message_id)!;
    expect(chat.querySelector(`[data-message-id="${parent.created_message_id}"]`)!.textContent).toContain(parentMessage.body);
    const raised = chat.querySelector(`[data-message-id="${item.created_message_id}"]`)!;
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

describe('item reply cancellation updates', () => {
  it.each([
    { cause: 'owner' as const, line: 'Cancelled before it reached the agent' },
    { cause: 'topic_archived' as const, line: 'Not sent: cancelled when you archived this topic' },
    { cause: 'session_closed' as const, line: 'Not sent: cancelled when you closed this session' },
  ])('keeps the exact queued reply when $cause cancels it and updates its label', async ({ cause, line }) => {
    const body = '  **Queued owner words**\nKeep every line and trailing spaces  ';
    const value = await ready(session => {
      const input = session.inputs['00000000-0000-4000-8000-000000000076']!;
      input.kind = 'reply'; input.state = 'queued'; input.attempts = []; delete input.cancel_cause;
      input.payload.text = body;
      session.messages.find(message => message.id === input.message_id)!.body = body;
    });
    const session = value.transport.session, input = session.inputs['00000000-0000-4000-8000-000000000076']!;
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="4" later={false} onOpenItem={vi.fn()} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    expect(chat.querySelector(`[data-pending="${input.id}"]`)!.textContent).toContain('Not sent yet');
    input.state = 'cancelled'; input.cancel_cause = cause; session.revision++;
    await act(() => value.store.refresh());
    const turn = await waitFor(() => {
      const found = chat.querySelector<HTMLElement>(`li[data-message-id="${input.message_id}"]`);
      expect(found?.textContent).toContain(line); return found!;
    });
    expect(turn.classList.contains('detail-turn-cancelled')).toBe(true);
    expect(turn.textContent).toContain('Queued owner words');
    expect(turn.textContent).toContain('Keep every line and trailing spaces');
    expect(chat.querySelector(`[data-pending="${input.id}"]`)).toBeNull();
    fireEvent.click(within(turn).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(body);
  });
});
