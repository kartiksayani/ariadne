import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionSeen } from '../../../src/generated/core';
import type { Message, OperationReceipt } from '../../../src/generated/domain/models';
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
const revisionFixture = () => {
  const value = fixture(), { session, itemId } = value, item = session.items[itemId]!;
  const opening = { ...value.messages[0], number: 1, created_at: item.created_at, items_touched: [itemId] };
  const replies: Message[] = [2, 3].map(number => ({ ...opening, id: `reply-${number}`, number,
    kind: 'reply', item_id: itemId, round_id: null, created_at: `2026-10-03T12:00:0${number}.000Z` }));
  const messages = [opening, ...replies];
  session.messages = messages; session.rounds = {}; session.answers = []; session.inputs = {};
  item.revision = 3; item.created_message_id = opening.id; item.updated_message_ids = messages.map(message => message.id);
  item.current_round_id = null; item.status_history = []; item.changes = [];
  const receipt = (message: Message, revision: number): OperationReceipt => ({
    operation_id: `apply-${message.id}`, actor_scope: { kind: 'agent', binding_id: message.binding_id! }, command_digest: 'a'.repeat(64),
    result: { operation_id: `apply-${message.id}`, session_id: session.id, revision: revision + 1,
      data: { kind: 'apply', allocated_refs: {}, messages: [{ id: message.id, number: message.number }],
        item_revisions: { [itemId]: revision }, topic_revisions: {}, input_result_state: null, queue_join_state: null } },
  });
  session.operation_receipts = Object.fromEntries(messages.map((message, index) => [message.id, [receipt(message, index + 1)]]));
  value.seen.items = [{ item_id: itemId, revision: 1 }];
  return { ...value, messages, receipt };
};

describe('the conversation reading boundary', () => {
  it('places the divider before the first message after the stored initial baseline', () => {
    const { session, itemId, messages, seen } = fixture();
    expect(messages.length).toBeGreaterThan(1);
    expect(conversationDivider(session, itemId, seen)).toBe(messages[2].id);
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

  it('uses explicit topic catch-up instead of the older session baseline without an item read entry', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    seen.items = [];
    seen.since = '2000-01-01T00:00:00Z';
    seen.topics = [{ topic_id: session.items[itemId]!.topic_id, at: messages[1].created_at }];
    expect(conversationDivider(session, itemId, seen)).toBe(messages[2].id);
    seen.topics[0].at = messages[2].created_at;
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits an unmappable later seen revision rather than using the initial baseline as last-read time', () => {
    const { session, itemId, messages, seen } = fixture();
    seen.items.push({ item_id: itemId, revision: session.items[itemId]!.revision - 1 });
    session.operation_receipts = Object.fromEntries(Object.entries(session.operation_receipts).filter(([, receipts]) =>
      !receipts?.some(receipt => receipt.result.data.kind === 'apply' && receipt.result.data.messages.some(message => message.id === messages[2].id))));
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('places the divider before the first of two agent replies after the explicitly seen revision', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
    seen.items[0].revision = 2;
    expect(conversationDivider(session, itemId, seen)).toBe(messages[2].id);
  });

  it('omits the divider when the explicit seen revision is the current revision', () => {
    const { session, itemId, seen } = revisionFixture();
    seen.items[0].revision = session.items[itemId]!.revision;
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits the divider when trimmed apply receipts leave an agent reply unclassified', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    delete session.operation_receipts[messages[1].id];
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits the divider for an owner-only reply after the explicit seen revision', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    messages.splice(2, 1); messages[1].author = 'owner'; messages[1].kind = 'owner_input';
    session.items[itemId]!.revision = 2;
    session.operation_receipts = {};
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    seen.items = [];
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('anchors on an agent reply after an owner message and keeps owner messages between new replies', () => {
    const { session, itemId, messages, seen, receipt } = revisionFixture();
    const owner: Message = { ...messages[1], id: 'owner', number: 2, author: 'owner', kind: 'owner_input' };
    messages[1].number = 3; messages[2].number = 5;
    const secondOwner = { ...owner, id: 'owner-between', number: 4 };
    session.messages = [messages[0], owner, messages[1], secondOwner, messages[2]];
    session.operation_receipts[messages[1].id] = [receipt(messages[1], 2)];
    session.operation_receipts[messages[2].id] = [receipt(messages[2], 3)];
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
  });

  it('uses exact receipt revisions when messages share a timestamp', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    messages.forEach(message => { message.created_at = messages[0].created_at; });
    seen.items[0].revision = 2;
    expect(conversationDivider(session, itemId, seen)).toBe(messages[2].id);
  });

  it('keeps an earlier parent opening seen when only the child has apply receipts', () => {
    const { session, itemId, messages, seen, receipt } = revisionFixture();
    const item = session.items[itemId]!;
    const context: Message = { ...messages[0], id: 'parent-opening', number: 1, items_touched: ['2'],
      created_at: '2026-10-03T11:59:59.000Z' };
    session.items['2'] = { ...item, id: '2', ordinal: 2, created_message_id: context.id, updated_message_ids: [context.id] };
    item.parent = '2';
    messages.forEach(message => { message.number += 1; });
    session.messages = [context, ...messages];
    session.operation_receipts = Object.fromEntries(messages.map((message, index) => [message.id, [receipt(message, index + 1)]]));
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
  });

  it('requires matching creation time before using revision-one fallback evidence', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    delete session.operation_receipts[messages[0].id];
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
    messages[0].created_at = '2026-10-03T11:59:59.000Z';
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('uses the final atomic batch revision and suppresses conflicting receipt evidence', () => {
    const { session, itemId, messages, seen, receipt } = revisionFixture();
    messages[2].created_at = messages[1].created_at;
    const batch = receipt(messages[1], 3);
    if (batch.result.data.kind !== 'apply') throw new Error('Expected apply receipt');
    batch.result.data.messages.push({ id: messages[2].id, number: messages[2].number });
    session.operation_receipts = { batch: [batch] };
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
    session.operation_receipts.conflict = [receipt(messages[1], 2)];
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('does not replace missing atomic batch evidence with a change cause or timestamp', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    session.items[itemId]!.changes = [{ revision: 2, at: messages[1].created_at, cause_message_id: messages[1].id, before: { note: null } }];
    expect(conversationDivider(session, itemId, seen)).toBe(messages[1].id);
    delete session.operation_receipts[messages[1].id];
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('suppresses receipt evidence with inconsistent timestamps, identities, or revision order', () => {
    const { session, itemId, messages, seen, receipt } = revisionFixture();
    const batch = receipt(messages[1], 3);
    if (batch.result.data.kind !== 'apply') throw new Error('Expected apply receipt');
    batch.result.data.messages.push({ id: messages[2].id, number: messages[2].number });
    session.operation_receipts = { batch: [batch] };
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    session.operation_receipts = { second: [receipt(messages[1], 3)], third: [receipt(messages[2], 2)] };
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    session.operation_receipts = { second: [receipt({ ...messages[1], number: 99 }, 2)], third: [receipt(messages[2], 3)] };
    expect(conversationDivider(session, itemId, seen)).toBeNull();
  });

  it('omits invalid times and a boundary contradicted by later message timestamps', () => {
    const { session, itemId, messages, seen } = revisionFixture();
    seen.items = [];
    seen.since = 'invalid';
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    seen.since = messages[0].created_at;
    messages[2].created_at = 'invalid';
    expect(conversationDivider(session, itemId, seen)).toBeNull();
    messages[2].created_at = seen.since;
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
