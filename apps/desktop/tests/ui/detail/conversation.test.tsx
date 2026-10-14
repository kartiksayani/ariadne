import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionSeen } from '../../../src/generated/core';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { conversationDivider } from '../../../src/ui/detail/conversationSeen';
import { ConversationView } from '../../../src/ui/detail/ConversationView';
import { detailModel } from '../../../src/ui/detail/model';
import { setup, sessionFixture } from '../history/fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const fixture = () => {
  const session = sessionFixture(), itemId = '1';
  const chat = detailModel({ session, itemId, mode: null, saving: null, later: false, now: Date.now() })!.chat;
  const messages = chat.map(entry => session.messages.find(message => message.id === entry.id)!);
  const seen: SessionSeen = { session: { project_id: session.project_id, session_id: session.id },
    since: messages[0].created_at, items: [], topics: [] };
  return { session, itemId, messages, seen };
};

describe('the conversation reading boundary', () => {
  it('places the divider before the first message after the stored initial baseline', () => {
    const { session, itemId, messages, seen } = fixture();
    expect(messages.length).toBeGreaterThan(1);
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
  });

  it('omits the divider when nothing is new or the item has never been seen', () => {
    const { session, itemId, messages, seen } = fixture();
    expect(conversationDivider(session, itemId, null)).toBeNull();
    seen.since = messages.at(-1)!.created_at;
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    seen.items.push({ item_id: itemId, revision: session.items[itemId]!.revision });
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits the divider when all messages are new', () => {
    const { session, itemId, seen } = fixture();
    seen.since = '2000-01-01T00:00:00Z';
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits an unmappable later seen revision rather than using the initial baseline as last-read time', () => {
    const { session, itemId, seen } = fixture();
    seen.items.push({ item_id: itemId, revision: session.items[itemId]!.revision - 1 });
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits invalid times and a boundary contradicted by later message timestamps', () => {
    const { session, itemId, messages, seen } = fixture();
    seen.since = 'invalid';
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    seen.since = messages[0].created_at;
    messages.at(-1)!.created_at = 'invalid';
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    messages.at(-1)!.created_at = seen.since;
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('retains the captured divider when the seen revision advances, and moves focus oldest first', async () => {
    const value = setup();
    try {
      await value.store.refresh();
      const { seen, itemId } = fixture();
      const session = value.store.getSnapshot().snapshot!.session;
      const dividerId = conversationDivider(session, itemId, seen);
      expect(dividerId).not.toBeNull();
      const props = { drafts: new OwnerDraftStore(value.service), store: value.store, itemId, later: false,
        dividerId, seen, onOpenItem: vi.fn(), onClose: vi.fn() };
      const view = render(<ConversationView {...props} />);
      const divider = screen.getByText('New since you last looked');
      expect(divider.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(dividerId);
      view.rerender(<ConversationView {...props} seen={{ ...seen, items: [{ item_id: itemId, revision: session.items[itemId]!.revision }] }} />);
      expect(screen.getByText('New since you last looked')).toBe(divider);
      const anchor = screen.getByRole('region', { name: 'Item conversation' });
      const messages = [...anchor.querySelectorAll<HTMLElement>('[data-message-id]')];
      fireEvent.keyDown(anchor, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(messages[0]);
      fireEvent.keyDown(messages[0], { key: 'ArrowDown' });
      expect(document.activeElement).toBe(messages[1]);
      fireEvent.keyDown(messages[1], { key: 'ArrowUp' });
      expect(document.activeElement).toBe(messages[0]);
    } finally { value.sessions.closeAll(); }
  });
});
