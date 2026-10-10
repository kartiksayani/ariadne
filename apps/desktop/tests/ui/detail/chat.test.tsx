import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { detailModel } from '../../../src/ui/detail/model';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { setup } from '../history/fixtures';

const model = (session: Session, itemId = '1') => detailModel({ session: immutable(session), itemId, now: Date.parse(session.updated_at), mode: null, later: false, saving: null })!;
const opened: ReturnType<typeof setup>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });

describe('the single item chat', () => {
  it('keeps a long title compact with a tooltip and expands it without changing the answer', async () => {
    const value = setup(); opened.push(value);
    const item = value.transport.session.items['2']!;
    item.question = 'Choose how to handle the complete delivery conversation and preserve all earlier decisions. '.repeat(8);
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const title = screen.getByRole('heading', { name: item.question.trim() });
    expect(title.title).toBe(item.question);
    const toggle = screen.getByRole('button', { name: 'Expand title' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse title' }).getAttribute('aria-expanded')).toBe('true');
    expect(title.closest('.detail-head-expanded')).not.toBeNull();
    fireEvent.click(toggle);
    expect(title.closest('.detail-head-expanded')).toBeNull();
    expect(value.transport.calls.some(request => 'command' in request)).toBe(false);
    const css = readFileSync(resolve(__dirname, '../../../src/ui/detail/detail.css'), 'utf8');
    expect(css).toMatch(/\.detail-head\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.detail-question\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    expect(css).toMatch(/\.detail-dock\s*\{[^}]*max-height:\s*40%;[^}]*overflow-y:\s*auto/s);
  });

  it('opens at the latest unanswered ask after a long earlier conversation and keeps the sticky title clear', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, item = session.items['2']!;
    const first = session.rounds[item.current_round_id!]!;
    const previous = session.messages.find(message => message.body === item.ask)!;
    previous.body = 'Earlier delivery context. '.repeat(1000);
    const second = { ...structuredClone(first), id: 'new-round', ordinal: 2, opened_message_id: 'new-opening',
      owner_message_ids: [], agent_message_ids: ['new-opening'], result_input_ids: [], fork_item_ids: [] };
    session.rounds[second.id] = second; item.current_round_id = second.id;
    session.messages.push({ ...structuredClone(previous), id: second.opened_message_id, number: 30, round_id: second.id, body: 'Current delivery context.' });
    session.messages.push({ ...structuredClone(previous), id: 'later-context', number: 31, round_id: second.id, body: 'A later update after the question.' });
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1800);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { top: this.closest('[data-message-id="new-opening"]') ? 800 : 100,
        height: this.classList.contains('detail-head') ? 36 : 0 } as DOMRect;
    });
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="2" later={false} onOpenItem={vi.fn()} />);
    await screen.findByRole('region', { name: 'Conversation' });
    await waitFor(() => expect(document.querySelector<HTMLElement>('.detail-body')!.scrollTop).toBe(664));
    const current = document.querySelector<HTMLElement>('[data-message-id="new-opening"]')!;
    expect(within(current).getByText('Waiting on you')).toBeTruthy();
    expect(current.querySelectorAll('.detail-bubble-agent')).toHaveLength(2);
    expect(within(current).getByText(item.ask!)).toBeTruthy();
  });

  it('shows the reason unavailable actions wait while the agent reconnects', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, binding = session.bindings[session.active_binding_id!]!;
    binding.connection_state = 'reconnecting';
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1.1" later={false} onOpenItem={vi.fn()} />);
    const dock = document.querySelector<HTMLElement>('.detail-dock')!;
    expect(within(dock).getByText(/Reconnecting to .+These come back with the connection/).closest('[hidden], details')).toBeNull();
    expect(within(dock).getByRole<HTMLButtonElement>('button', { name: 'Bring it up' }).disabled).toBe(true);
    expect(within(dock).getByRole<HTMLButtonElement>('button', { name: 'Reply' }).disabled).toBe(true);
    expect(within(dock).getByRole<HTMLButtonElement>('button', { name: 'Later' }).disabled).toBe(false);
  });

  it('keeps the full reply once and shows both the choice and exact note in each owner bubble', async () => {
    const value = setup(); opened.push(value); await value.store.refresh();
    const session = value.transport.session, answer = session.answers[0]!;
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} highlightedMessageIds={new Set([answer.message_id])} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const bubble = chat.querySelector(`[data-message-id="${answer.message_id}"]`)!;
    expect(bubble.classList.contains('excerpt-highlighted')).toBe(true);
    expect(bubble.textContent).toContain('You chose “Keep complete history”');
    expect(bubble.textContent).toContain('Retain the full history, including earlier outcomes.');
    expect(chat.querySelectorAll(`[data-message-id="${answer.message_id}"]`)).toHaveLength(1);
    expect(chat.textContent!.split('The full history is retained.')).toHaveLength(2);
    expect(chat.querySelector('.detail-msg-result')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull();
  });

  it.each([
    { kind: 'answer' as const, note: '', choice: true, text: 'You chose “Keep complete history”' },
    { kind: 'answer' as const, note: 'Keep this exact note, too.', choice: true, text: 'You chose “Keep complete history”' },
    { kind: 'bring' as const, note: '', choice: false, text: 'Bring it up' },
    { kind: 'drop' as const, note: '', choice: false, text: 'Drop it' },
  ])('keeps the cancelled $kind and note "$note" when its message body is empty', async ({ kind, note, choice, text }) => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, answer = session.answers[0]!, input = session.inputs[answer.input_id]!;
    input.state = 'cancelled'; input.cancel_cause = 'owner'; input.kind = kind; input.attempts = [];
    input.payload.text = note;
    input.payload.selected_option_id = choice ? answer.selected_option_id : null;
    input.payload.target_snapshot.options = structuredClone(answer.options_snapshot);
    session.messages.find(message => message.id === input.message_id)!.body = '';
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const turn = chat.querySelector<HTMLElement>(`[data-message-id="${input.message_id}"]`)!;
    expect(model(session).chat.find(entry => entry.id === input.message_id)!.you).toEqual({ how: choice ? 'chose' : 'action', text: choice ? 'Keep complete history' : text, note });
    expect(turn.classList.contains('detail-turn-cancelled')).toBe(true);
    expect(turn.hasAttribute('data-owner-said')).toBe(false);
    expect(within(turn).getByText(text)).toBeTruthy();
    if (note) expect(within(turn).getByText(note)).toBeTruthy();
    expect(within(turn).getByText('Cancelled before it reached the agent')).toBeTruthy();
  });

  it('puts the short result under the owner only when no full agent message follows before the next owner', () => {
    const session = structuredClone(demo) as Session, answer = session.answers[0]!;
    const round = session.rounds[session.items['1']!.current_round_id!]!;
    const reply = session.messages.find(message => message.id === round.agent_message_ids[0])!;
    session.inputs[session.answers[1]!.input_id]!.state = 'handled';
    const result = session.inputs[answer.input_id]!.attempts.find(attempt => attempt.domain_result)!.domain_result!;
    expect(model(session).chat.find(entry => entry.id === answer.message_id)!.result).toBe('');
    // The reply now belongs after the next owner message. It cannot replace this earlier message's result.
    reply.number = 20;
    expect(model(session).chat.find(entry => entry.id === answer.message_id)!.result).toBe(result.explanation);
    // A reply on another item does not suppress the result.
    reply.number = 3; reply.item_id = '3'; reply.items_touched = ['3'];
    round.agent_message_ids = []; session.items['1']!.updated_message_ids = [];
    expect(model(session).chat.find(entry => entry.id === answer.message_id)!.result).toBe(result.explanation);
    // An older result never answers the owner's later correction.
    const correction = session.answers[1]!;
    expect(model(session).chat.find(entry => entry.id === correction.message_id)!.result).toBe('');
  });

  it('deduplicates the ask against its full message and keeps parent and fork markers inline', () => {
    const session = structuredClone(demo) as Session;
    const chat = model(session, '2').chat;
    const ask = session.items['2']!.ask!;
    expect(chat.filter(entry => entry.message.body.includes(ask))).toHaveLength(1);
    expect(chat.flatMap(entry => entry.asks).some(value => value.text === ask)).toBe(false);
    expect(model(session, '1.1').chat.some(entry => entry.marker.includes('Parent raised here'))).toBe(true);
    expect(model(session).chat.flatMap(entry => entry.forks).map(fork => fork.id)).toEqual(['1.1']);
  });

  it('keeps pending messages in their number order even when an agent message follows them', () => {
    const session = structuredClone(demo) as Session;
    const input = Object.values(session.inputs).find(value => value?.target.item_id === '2')!;
    input.state = 'queued';
    const chat = model(session, '2').chat, position = chat.findIndex(entry => entry.pending?.input.id === input.id);
    expect(position).toBeGreaterThan(-1);
    expect(chat.slice(position + 1).some(entry => entry.message.author === 'agent')).toBe(true);
    expect(chat.filter(entry => entry.id === input.message_id)).toHaveLength(1);
  });

  it('keeps a repeated ask attached to its own round when the new opening only gives context', () => {
    const session = structuredClone(demo) as Session, item = session.items['2']!;
    const first = session.rounds[item.current_round_id!]!, ask = item.ask!;
    const previous = session.messages.find(message => message.body === ask)!;
    const second = { ...structuredClone(first), id: 'new-round', ordinal: 2, opened_message_id: 'new-opening',
      owner_message_ids: [], agent_message_ids: ['new-opening'], result_input_ids: [], fork_item_ids: [] };
    session.rounds[second.id] = second; item.current_round_id = second.id;
    session.messages.push({ ...structuredClone(previous), id: second.opened_message_id, number: 30, round_id: second.id, body: 'Updated context for the same choice.' });
    const chat = model(session, '2').chat;
    expect(chat.find(entry => entry.id === previous.id)!.asks.every(value => value.ordinal === 1)).toBe(true);
    expect(chat.find(entry => entry.id === second.opened_message_id)!.asks).toEqual([{ text: ask, now: true, ordinal: 2 }]);
  });

  it('keeps the current ask and Waiting on you visible when an owner message opened its round', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, item = session.items['2']!;
    const round = session.rounds[item.current_round_id!]!, input = Object.values(session.inputs).find(input => input?.target.item_id === '2')!;
    round.opened_message_id = input.message_id; round.agent_message_ids = []; round.result_input_ids = [];
    input.state = 'cancelled'; input.cancel_cause = 'session_closed'; input.attempts = [];
    item.ask = round.ask_snapshot = 'A newly raised choice';
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="2" later={false} onOpenItem={vi.fn()} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const opening = chat.querySelector<HTMLElement>(`[data-message-id="${input.message_id}"]`)!;
    expect(within(opening).getByText('A newly raised choice')).toBeTruthy();
    expect(within(opening).getByText('Waiting on you')).toBeTruthy();
    expect(within(opening).getByText(/Not sent: cancelled/)).toBeTruthy();
  });
});

describe('child items scroll inside the detail', () => {
  it('caps the list, fades only while more rows remain and scrolls keyboard focus inside the box', async () => {
    const value = setup(); opened.push(value); const session = value.transport.session;
    const first = session.items['1.1']!;
    for (let index = 2; index <= 9; index++) session.items[`1.${index}`] = { ...structuredClone(first), id: `1.${index}`, ordinal: index, question: `Child ${index}` };
    const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(330);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(110);
    await value.store.refresh();
    const open = vi.fn();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={open} />);
    const kids = await screen.findByRole('region', { name: 'Child items' });
    expect(kids.textContent).toContain('Branched into 9 items');
    const box = kids.querySelector<HTMLElement>('.detail-kids-scroll')!, wrapper = box.parentElement!;
    expect(within(box).getAllByRole('button')).toHaveLength(9);
    expect(wrapper.classList.contains('detail-kids-more')).toBe(true);
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 110 } as DOMRect);
    const last = within(box).getByRole('button', { name: /Child 9$/ });
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue({ top: 297, bottom: 330 } as DOMRect);
    fireEvent.focus(last);
    expect(box.scrollTop).toBe(220);
    expect(wrapper.classList.contains('detail-kids-more')).toBe(false);
    fireEvent.click(last); expect(open).toHaveBeenCalledWith('1.9');
    box.scrollTop = 0; fireEvent.scroll(box);
    expect(wrapper.classList.contains('detail-kids-more')).toBe(true);
    height.mockReturnValue(100); fireEvent.scroll(box);
    expect(wrapper.classList.contains('detail-kids-more')).toBe(false);
    const css = readFileSync(resolve(__dirname, '../../../src/ui/detail/detail.css'), 'utf8');
    expect(css).toMatch(/\.detail-kids-scroll\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.detail-kids-more::after\s*\{[^}]*pointer-events:\s*none/s);
  });
});
