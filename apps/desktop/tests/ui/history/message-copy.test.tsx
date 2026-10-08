import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { LinkOpener } from '../../../src/ui/shared/MarkdownText';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { setup } from './fixtures';

const copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: (text: string) => copy(text) }));
const opened: ReturnType<typeof setup>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.clearAllMocks(); });

describe('conversation message copying', () => {
  it('copies each Timeline entry raw body, preserving markdown and whitespace', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.messages.forEach(message => { message.body = `  **Message ${message.id}**\r\n\r\n- source with spaces  `; });
    await value.store.refresh();
    render(<ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    const entries = timeline.querySelectorAll<HTMLElement>('.excerpt-timeline');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const message = session.messages.find(message => message.id === entry.dataset.messageId)!;
      expect(message).toBeDefined();
      fireEvent.click(within(entry).getByRole('button', { name: 'Copy message' }));
      expect(copy).toHaveBeenLastCalledWith(message.body);
    }
  });

  it('copies the original ask, owner message, result and pending message without display changes', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session, item = session.items['1']!;
    const round = Object.values(session.rounds).find(value => value?.item_id === item.id)!;
    round.ask_snapshot = '  **Original ask**\n\nKeep [markdown](https://example.com)  ';
    const owner = session.messages.find(message => message.id === round.owner_message_ids[0])!;
    owner.body = '  **Owner source**\r\n\r\nKeep trailing spaces  ';
    const pending = Object.values(session.inputs).find(input => input?.state === 'queued' && input.target.item_id && session.items[input.target.item_id])!;
    const pendingMessage = session.messages.find(message => message.id === pending.message_id)!;
    pendingMessage.body = '  **Pending source**\n\nOriginal whitespace  ';
    await value.store.refresh();
    const drafts = new OwnerDraftStore(value.service);
    const rendered = render(<ItemDetail drafts={drafts} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} />);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    const messages = chat.querySelectorAll('.detail-msg');
    expect(messages.length).toBeGreaterThanOrEqual(3);
    messages.forEach(message => expect(within(message as HTMLElement).getAllByRole('button', { name: 'Copy message' })).toHaveLength(1));
    fireEvent.click(within(messages[0] as HTMLElement).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(round.ask_snapshot);
    fireEvent.click(within(chat.querySelector('.detail-msg-you') as HTMLElement).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(owner.body);
    const result = chat.querySelector('.detail-msg-result') as HTMLElement;
    fireEvent.click(within(result).getByRole('button', { name: 'Copy message' }));
    const explanation = round.result_input_ids.flatMap(id => session.inputs[id]?.attempts ?? []).find(attempt => attempt.domain_result)?.domain_result?.explanation;
    expect(copy).toHaveBeenLastCalledWith(explanation);
    rendered.rerender(<ItemDetail key={pending.target.item_id} drafts={drafts} store={value.store} itemId={pending.target.item_id!} later={false} onOpenItem={vi.fn()} />);
    const bubble = document.querySelector(`[data-pending="${pending.id}"]`) as HTMLElement;
    fireEvent.click(within(bubble).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(pendingMessage.body);
  });

  it('enables item references in agent messages while owner markdown keeps a plain label', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    const round = Object.values(session.rounds).find(value => value?.item_id === '1')!;
    round.ask_snapshot = 'Agent asks about [receipt follow-up](item:1.1).';
    const answer = session.answers.find(answer => answer.item_id === '1')!;
    answer.selected_option_id = null; answer.text = 'Owner mentions [owner label](item:1.1).';
    const owner = session.messages.find(message => message.id === answer.message_id)!;
    owner.body = answer.text;
    await value.store.refresh();
    const open = vi.fn(), external = vi.fn();
    render(<LinkOpener.Provider value={external}><ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={open} /></LinkOpener.Provider>);
    const chat = await screen.findByRole('region', { name: 'Conversation' });
    fireEvent.click(within(chat).getByRole('link', { name: 'receipt follow-up' }));
    fireEvent.keyDown(within(chat).getByRole('link', { name: 'receipt follow-up' }), { key: 'Enter' });
    expect(open.mock.calls).toEqual([['1.1'], ['1.1']]);
    expect(within(chat).queryByRole('link', { name: 'owner label' })).toBeNull();
    expect(chat.querySelector('.detail-bubble-you')?.textContent).toContain('owner label');
    expect(within(screen.getByRole('region', { name: 'Timeline' })).queryByRole('link', { name: 'owner label' })).toBeNull();
    expect(external).not.toHaveBeenCalled();
  });
});
