import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import type { Input } from '../../../src/generated/domain/models';
import * as held from '../../../src/ui/answer/held';
import { copyText } from '../../../src/ui/shared/clipboard';
import { UnsentMessageNotices } from '../../../src/ui/answer/UnsentMessageNotices';
import { inItemConversation } from '../../../src/selectors/history';
import { Notices, notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';

const openedStores: OpenSessions[] = [];
const navigations: NavigationStore[] = [];
vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); navigations.splice(0).forEach(store => store.stop()); openedStores.splice(0).forEach(opened => opened.closeAll()); notices.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(cause: Input['cancel_cause'], item = false, loadPreferences = true) {
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
  else if (cause === 'session_closed') session.state = 'closed';
  const service = createDesktopService(transport), opened = new OpenSessions(service), store = opened.open(route);
  openedStores.push(opened);
  await store.refresh();
  const drafts = new OwnerDraftStore(service); await drafts.load();
  const navigation = new NavigationStore(service); navigations.push(navigation);
  if (loadPreferences) await navigation.refresh();
  const waiting = new WaitingStore(service, opened);
  const view = render(<><Notices /><UnsentMessageNotices waiting={waiting} drafts={drafts} opened={opened} selectedStore={store} navigation={navigation} /></>);
  return { ...view, transport, session, topic, input, message, drafts, store, waiting, opened, navigation };
}

async function reload(value: Awaited<ReturnType<typeof setup>>) {
  value.unmount(); value.navigation.stop();
  const service = createDesktopService(value.transport), navigation = new NavigationStore(service);
  navigations.push(navigation); await navigation.refresh();
  const opened = new OpenSessions(service); openedStores.push(opened);
  const store = opened.open(route); await store.refresh();
  const drafts = new OwnerDraftStore(service); await drafts.load();
  const waiting = new WaitingStore(service, opened);
  render(<><Notices /><UnsentMessageNotices waiting={waiting} drafts={drafts} opened={opened} selectedStore={store} navigation={navigation} /></>);
  return { navigation, drafts };
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
  expect(await screen.findByText('Put back. Open “Reply to topic” on its topic to send it.')).toBeTruthy();
  expect(value.transport.preferences.resolved_unsent_input_ids).toContain(value.input.id);
  const reopened = await reload(value);
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
  expect(reopened.drafts.findTopic(route, value.topic.id)?.draft.text).toBe(value.input.payload.text);
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
  expect(screen.getByText(/Your reply box already has text/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Put back in reply box' }));
  await waitFor(() => expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe(value.input.payload.text));
});

it('respects dismissal across refresh and keeps recovery through selection changes', async () => {
  const value = await setup('session_closed');
  const button = await screen.findByRole('button', { name: 'Put back in reply box' });
  value.rerender(<><Notices /><UnsentMessageNotices waiting={value.waiting}
    drafts={value.drafts} opened={value.opened} selectedStore={null} navigation={value.navigation} /></>);
  expect(button.isConnected).toBe(true);
  fireEvent.click(within(button.closest('[data-notice-id]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
  ++value.session.revision; await act(() => value.store.refresh());
  value.rerender(<><Notices /><UnsentMessageNotices waiting={value.waiting} drafts={value.drafts} opened={value.opened} selectedStore={value.store} navigation={value.navigation} /></>);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull());
  expect(value.transport.preferences.resolved_unsent_input_ids).toContain(value.input.id);
  await reload(value);
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
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

it.each(['owner', 'owner_edit', undefined] as const)('does not publish a notice for owner cancellation cause %s', async cause => {
  await setup(cause);
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
});

it('waits for saved recovery preferences before publishing notices', async () => {
  const value = await setup('session_closed', false, false);
  value.transport.preferences.resolved_unsent_input_ids = [value.input.id];
  expect(notices.getSnapshot()).toHaveLength(0);
  await act(() => value.navigation.refresh());
  expect(notices.getSnapshot()).toHaveLength(0);
});

it('quotes a short plain first line and copies every saved word even when the reply box has other text', async () => {
  const value = await setup('agent_removed');
  value.input.payload.text = `**${'Long saved message '.repeat(8)}**\nSecond line with trailing spaces  `;
  value.message.body = value.input.payload.text; ++value.session.revision;
  await act(() => value.store.refresh());
  const op = value.drafts.beginTopic(value.session, value.topic.id)!;
  await act(() => value.drafts.editSaved(op, { text: 'My own reply' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
  await screen.findByText(/Your reply box already has text/);
  const notice = notices.getSnapshot().find(value => value.id.startsWith('unsent:'))!;
  expect(notice.text).toContain('“**Long saved message');
  expect(notice.text).toContain('…”');
  expect(notice.text).not.toContain('Second line');
  expect(document.querySelector('.pw-note-text strong')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByText(/Copied\./);
  expect(copyText).toHaveBeenLastCalledWith(value.input.payload.text);
  expect(screen.getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
  expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe('My own reply');
  vi.mocked(copyText).mockRejectedValueOnce(new Error('No clipboard'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await screen.findByText(/Couldn’t copy your message/);
  expect(screen.getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
});

it('keeps Copy feedback after the current recovery prerequisite as the session changes', async () => {
  const value = await setup('session_closed');
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Put back in reply box' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(await screen.findByText(/Reopen the session to put it back in the reply box\. Copied\./)).toBeTruthy();
  expect(button.disabled).toBe(true);
  expect(copyText).toHaveBeenLastCalledWith(value.input.payload.text);

  value.session.state = 'active'; value.topic.archived_at = value.session.updated_at; ++value.session.revision;
  await act(() => value.store.refresh());
  expect(await screen.findByText(/Restore the topic to put it back in the reply box\. Copied\./)).toBeTruthy();
  expect(screen.queryByText(/Reopen the session to put it back/)).toBeNull();
  expect(button.disabled).toBe(true);

  value.topic.archived_at = null; ++value.session.revision;
  await act(() => value.store.refresh());
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(screen.getByText(/Copied\./)).toBeTruthy();
  expect(screen.queryByText(/Restore the topic to put it back/)).toBeNull();
});

it('recomputes a click-time block as prerequisites change without retaining the old reason', async () => {
  const value = await setup('agent_removed');
  const action = notices.getSnapshot().find(notice => notice.id.startsWith('unsent:'))!.actions![0];
  value.session.state = 'closed'; ++value.session.revision;
  await act(() => value.store.refresh());
  // An action admitted before the refresh must recheck the current session.
  act(() => action.run());
  expect(await screen.findByText(/Reopen the session to put it back/)).toBeTruthy();

  value.session.state = 'active'; value.topic.archived_at = value.session.updated_at; ++value.session.revision;
  await act(() => value.store.refresh());
  expect(screen.getByText(/Restore the topic to put it back/)).toBeTruthy();
  expect(screen.queryByText(/Reopen the session to put it back/)).toBeNull();

  value.topic.archived_at = null; ++value.session.revision;
  await act(() => value.store.refresh());
  expect((screen.getByRole('button', { name: 'Put back in reply box' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/Restore the topic to put it back/)).toBeNull();
  expect(screen.queryByText(/Reopen the session to put it back/)).toBeNull();
});

it('keeps the newest observed recovery prerequisite when the opened cache is older', async () => {
  const value = await setup('session_closed');
  const older = value.store.getSnapshot();
  value.session.state = 'active'; value.topic.archived_at = value.session.updated_at; ++value.session.revision;
  await act(() => value.store.refresh());
  expect(await screen.findByText(/Restore the topic to put it back/)).toBeTruthy();
  vi.spyOn(value.store, 'getSnapshot').mockReturnValue(older);
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  expect(await screen.findByText(/Restore the topic to put it back in the reply box\. Copied\./)).toBeTruthy();
  expect(screen.queryByText(/Reopen the session to put it back/)).toBeNull();
});

it.each([
  ['already_sent', held.ALREADY_SENT], ['not_taken_back', held.NOT_TAKEN_BACK],
  ['taken_back', held.TAKEN_BACK_NOT_LOADED], ['unavailable', 'Your reply box is busy. Try again when it is ready.'],
] as const)('explains %s without removing recovery access', async (kind, text) => {
  vi.spyOn(held, 'putBackCancelled').mockResolvedValue({ kind });
  await setup('agent_removed');
  fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
  await screen.findByText(content => content.includes(text));
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
});

it('keeps the dismissal pending and retries a failed save without losing the words', async () => {
  const value = await setup('agent_removed');
  let complete!: (saved: boolean) => void;
  const resolve = vi.spyOn(value.navigation, 'resolveUnsentInput').mockImplementationOnce(() => new Promise(done => { complete = done; }));
  const button = await screen.findByRole('button', { name: 'Put back in reply box' });
  fireEvent.click(within(button.closest('[data-notice-id]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
  expect(screen.getByText(/Saving dismissal/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(1);
  await act(async () => { complete(false); });
  await screen.findByText(/Couldn’t save the dismissal/);
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(value.input.payload.text).toBe('  Keep these exact words\nAnd the trailing spaces  ');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(value.transport.preferences.resolved_unsent_input_ids).toContain(value.input.id));
  await reload(value);
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
});

function failRecoveryMarkers(value: Awaited<ReturnType<typeof setup>>, code: 'permission_denied' | 'io_error') {
  const invoke = value.transport.invoke.bind(value.transport);
  return vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
    const request = args.request;
    if ('command' in request && request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'resolve_unsent_input')) {
      return { api_version: 1, ok: false, error: { code, message: 'Recovery marker unavailable', hint: '', retryable: false, field_errors: [] } };
    }
    return invoke(name, args);
  });
}

it('hides dismissal until restart when recovery storage is unavailable without claiming it was saved', async () => {
  const value = await setup('agent_removed');
  failRecoveryMarkers(value, 'permission_denied');
  const button = await screen.findByRole('button', { name: 'Put back in reply box' });
  fireEvent.click(within(button.closest('[data-notice-id]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
  await screen.findByText('Hidden until Ariadne restarts.');
  expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
  expect(value.transport.preferences.resolved_unsent_input_ids ?? []).not.toContain(value.input.id);
  ++value.session.revision; await act(() => value.store.refresh());
  await act(() => value.navigation.refresh());
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
  await reload(value);
  expect(await screen.findByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
});

it('keeps a transient I/O dismissal failure retryable', async () => {
  const value = await setup('agent_removed');
  const failure = failRecoveryMarkers(value, 'io_error');
  const button = await screen.findByRole('button', { name: 'Put back in reply box' });
  fireEvent.click(within(button.closest('[data-notice-id]') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
  await screen.findByText(/Couldn’t save the dismissal/);
  expect(screen.queryByText('Hidden until Ariadne restarts.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  failure.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(value.transport.preferences.resolved_unsent_input_ids).toContain(value.input.id));
});

it('keeps restored words and offers run-only dismissal when their recovery marker cannot be saved', async () => {
  const value = await setup('agent_removed');
  const failure = failRecoveryMarkers(value, 'permission_denied');
  fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
  await screen.findByText(/Your message is in the reply box, but recovery can’t be saved/);
  expect(screen.queryByText(/again to save it/)).toBeNull();
  expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe(value.input.payload.text);
  expect(value.transport.preferences.resolved_unsent_input_ids ?? []).not.toContain(value.input.id);
  const calls = failure.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await screen.findByText('Hidden until Ariadne restarts.');
  expect(failure.mock.calls).toHaveLength(calls);
  expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
  const reopened = await reload(value);
  expect(await screen.findByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
  expect(reopened.drafts.findTopic(route, value.topic.id)?.draft.text).toBe(value.input.payload.text);
});

it('saves the draft before its marker and retries a rejected marker without overwriting newer words', async () => {
  const value = await setup('agent_removed');
  const original = value.navigation.resolveUnsentInput.bind(value.navigation);
  vi.spyOn(value.navigation, 'resolveUnsentInput').mockImplementationOnce(async () => {
    expect(value.transport.preferences.drafts.find(draft => draft.target.topic_id === value.topic.id)?.text).toBe(value.input.payload.text);
    throw new Error('Lost marker response');
  }).mockImplementation(original);
  fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
  await screen.findByText(/recovery couldn’t be saved/);
  expect(screen.queryByText('Put back. Open “Reply to topic” on its topic to send it.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  const op = value.drafts.findTopic(route, value.topic.id)!.draft.op_id;
  await act(() => value.drafts.editSaved(op, { text: 'Edited after putting it back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Put back in reply box' }));
  await screen.findByText('Put back. Open “Reply to topic” on its topic to send it.');
  expect(value.drafts.findTopic(route, value.topic.id)?.draft.text).toBe('Edited after putting it back');
  await reload(value);
  expect(notices.getSnapshot().some(notice => notice.id.startsWith('unsent:'))).toBe(false);
});

it('retains recovery after a failed draft save', async () => {
  vi.spyOn(held, 'putBackCancelled').mockRejectedValue(new Error('Draft save failed'));
  const value = await setup('agent_removed');
  fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
  await screen.findByText(/Couldn’t put it back/);
  expect(value.transport.preferences.resolved_unsent_input_ids ?? []).not.toContain(value.input.id);
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});
