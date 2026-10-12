import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { LinkOpener } from '../../../src/ui/shared/MarkdownText';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { setup } from './fixtures';
import { Notices, notices } from '../../../src/ui/pages/notices';

const copy = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: (text: string) => copy(text) }));
const opened: ReturnType<typeof setup>[] = [];
afterEach(() => { cleanup(); notices.clear(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.clearAllMocks(); });

describe('conversation message copying', () => {
  it('copies each chat message raw body, preserving markdown and whitespace', async () => {
    const value = setup(); opened.push(value);
    const session = value.transport.session;
    session.messages.forEach(message => { message.body = `  **Message ${message.id}**\r\n\r\n- source with spaces  `; });
    await value.store.refresh();
    render(<><ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={vi.fn()} /><Notices /></>);
    const timeline = await screen.findByRole('region', { name: 'Conversation' });
    const entries = timeline.querySelectorAll<HTMLElement>('li[data-message-id] > .detail-msg:first-of-type');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const message = session.messages.find(message => message.id === entry.parentElement!.dataset.messageId)!;
      expect(message).toBeDefined();
      await act(async () => { fireEvent.click(within(entry).getByRole('button', { name: 'Copy message' })); });
      expect(copy).toHaveBeenLastCalledWith(message.body);
      expect(within(entry).getByRole('button', { name: 'Copy message' }).querySelector('.ph-copy')).not.toBeNull();
    }
    await waitFor(() => { expect(screen.getAllByText('Message copied.').length).toBeGreaterThan(0); });
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
    const first = session.messages.find(message => message.id === item.created_message_id)!;
    fireEvent.click(within(messages[0] as HTMLElement).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(first.body);
    const askMessage = [...chat.querySelectorAll<HTMLElement>('.detail-msg')].find(message => message.textContent?.includes('Original ask'))!;
    fireEvent.click(within(askMessage).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(round.ask_snapshot);
    fireEvent.click(within(chat.querySelector('.detail-msg-you') as HTMLElement).getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(owner.body);
    expect(chat.querySelector('.detail-msg-result')).toBeNull(); // The full agent reply replaces its short result.
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
    expect(chat.textContent).toContain('owner label');
    expect(within(screen.getByRole('region', { name: 'Conversation' })).queryByRole('link', { name: 'owner label' })).toBeNull();
    expect(external).not.toHaveBeenCalled();
  });
});
