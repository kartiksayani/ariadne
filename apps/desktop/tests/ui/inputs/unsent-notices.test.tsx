import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { UnsentMessageNotices } from '../../../src/ui/answer/UnsentMessageNotices';
import { inItemConversation } from '../../../src/selectors/history';
import { Notices, notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';

const openedStores: OpenSessions[] = [];
afterEach(() => { cleanup(); openedStores.splice(0).forEach(opened => opened.closeAll()); notices.clear(); vi.useRealTimers(); });
async function setup(cause: 'topic_archived' | 'session_closed', item = false) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const input = Object.values(session.inputs).find(value => value?.state === 'queued' && value.kind !== 'continue')!;
  input.state = 'cancelled'; input.cancel_cause = cause;
  const message = session.messages.find(value => value.id === input.message_id)!;
  input.payload.text = '  Keep these exact words\nAnd the trailing spaces  '; message.body = input.payload.text;
  if (!item) {
    input.kind = 'topic_reply'; input.target.item_id = null;
    message.item_id = null; message.items_touched = []; message.round_id = null;
    for (const round of Object.values(session.rounds)) if (round) round.owner_message_ids = round.owner_message_ids.filter(id => id !== message.id);
    for (const value of Object.values(session.items)) if (value) value.updated_message_ids = value.updated_message_ids.filter(id => id !== message.id);
  }
  const topic = session.topics[input.target.topic_id]!;
  if (cause === 'topic_archived') topic.archived_at = session.updated_at;
  else session.state = 'closed';
  const service = createDesktopService(transport), opened = new OpenSessions(service), store = opened.open(route);
  openedStores.push(opened);
  await store.refresh();
  const drafts = new OwnerDraftStore(service); await drafts.load();
  const waiting = new WaitingStore(service, opened);
  const view = render(<><Notices /><UnsentMessageNotices waiting={waiting} drafts={drafts} opened={opened} selectedStore={store} /></>);
  return { ...view, transport, session, topic, input, message, drafts, store, waiting, opened };
}

it.each(['topic_archived', 'session_closed'] as const)('keeps %s topic reply recovery until restore and successful use, without expiring', async cause => {
  const value = await setup(cause);
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Put back in reply box' });
  expect(button.disabled).toBe(true);
  expect(screen.getByText(new RegExp(`Your unsent message to ${value.topic.name} was kept`))).toBeTruthy();
  vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(button.isConnected).toBe(true); vi.useRealTimers();
  value.topic.archived_at = null; value.session.state = 'active'; ++value.session.revision;
  await act(() => value.store.refresh()); await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull());
  expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe(value.input.payload.text);
  expect(value.transport.preferences.drafts.find(draft => draft.target.topic_id === value.topic.id)?.text).toBe(value.input.payload.text);
  expect(value.input.state).toBe('cancelled');
});

it('never overwrites typed text and lets the kept topic message be recovered later', async () => {
  const value = await setup('topic_archived');
  value.topic.archived_at = null; ++value.session.revision; await act(() => value.store.refresh());
  const op = value.drafts.beginTopic(value.session, value.topic.id)!;
  await act(async () => { await value.drafts.editSaved(op, { text: 'My newer draft' }); });
  const button = await screen.findByRole('button', { name: 'Put back in reply box' }); fireEvent.click(button);
  await screen.findByText(/Your reply box already has text/);
  expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe('My newer draft');
  expect(screen.getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
  await act(async () => { await value.drafts.editSaved(op, { text: '' }); });
  fireEvent.click(screen.getByRole('button', { name: 'Put back in reply box' }));
  await waitFor(() => expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe(value.input.payload.text));
});

it('respects dismissal across refresh and keeps recovery through selection changes', async () => {
  const value = await setup('session_closed');
  const button = await screen.findByRole('button', { name: 'Put back in reply box' });
  value.rerender(<><Notices /><UnsentMessageNotices waiting={value.waiting}
    drafts={value.drafts} opened={value.opened} selectedStore={null} /></>);
  expect(button.isConnected).toBe(true);
  fireEvent.click(within(button.closest('[data-notice-id]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
  ++value.session.revision; await act(() => value.store.refresh());
  value.rerender(<><Notices /><UnsentMessageNotices waiting={value.waiting} drafts={value.drafts} opened={value.opened} selectedStore={value.store} /></>);
  expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
});

it('leaves item cancellation recovery in its conversation rather than adding a duplicate notice', async () => {
  const value = await setup('topic_archived', true);
  expect(inItemConversation(value.session, value.message)).toBe(true);
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
});

it('keeps topic reply text stored without adding a message history surface', async () => {
  const value = await setup('topic_archived');
  expect(inItemConversation(value.session, value.message)).toBe(false);
  expect(value.store.getSnapshot().snapshot!.session.messages.find(message => message.id === value.message.id)?.body).toBe(value.message.body);
  expect(document.querySelector(`[data-message-id="${value.message.id}"]`)).toBeNull();
  expect(screen.queryByText('Session activity', { exact: false })).toBeNull();
});

it('keeps removal lifecycle messages stored without claiming they have an item conversation', async () => {
  const value = await setup('topic_archived');
  const item = value.session.items['1']!;
  item.removed_at = value.session.updated_at;
  const lifecycle = { ...value.message, id: '00000000-0000-4000-8000-000000007777', kind: 'lifecycle' as const,
    author: 'system' as const, body: 'Work moved to the bin.', item_id: item.id, items_touched: [item.id], input_id: null };
  value.session.messages.push(lifecycle);
  ++value.session.revision; await act(() => value.store.refresh());
  expect(inItemConversation(value.session, lifecycle)).toBe(false);
  expect(value.store.getSnapshot().snapshot!.session.messages.find(message => message.id === lifecycle.id)?.body).toBe(lifecycle.body);
  expect(screen.queryByText(lifecycle.body)).toBeNull();
});

it('removes topic take-back recovery after the same words are sent from another editor', async () => {
  const value = await setup('topic_archived');
  value.input.cancel_cause = 'owner_edit'; value.topic.archived_at = null; ++value.session.revision;
  await act(() => value.store.refresh());
  await screen.findByRole('button', { name: 'Put back in reply box' });
  const resent = structuredClone(value.input);
  resent.id = '00000000-0000-4000-8000-000000008888'; resent.seq += 100;
  resent.state = 'queued'; resent.cancel_cause = undefined;
  value.session.inputs[resent.id] = resent; ++value.session.revision;
  await act(() => value.store.refresh());
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull());
  expect(notices.getSnapshot().some(notice => notice.id === `unsent:${value.session.id}:${value.input.id}`)).toBe(false);
});
