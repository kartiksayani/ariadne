import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { immutable, SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { SessionActions } from '../../../src/components/bindings/actions';
import type { MutationReceipt, OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import { AckAll } from '../../../src/ui/navigation/AckAll';
import { ackAllFor, ackAllItems, attachAckAll, stopAckAll, ACK_ALL_HOLD_MS } from '../../../src/ui/navigation/ackAllController';
import { RecentPopover, recentEntries, recordRecent } from '../../../src/ui/navigation/Recent';
import { navigationVisits } from '../../../src/ui/navigation/visits';
import { NavigationStore } from '../../../src/state/navigation/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';
import * as ack from '../../../src/selectors/ack';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.forEach(store => store.close()); stores.length = 0; notices.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

class BulkTransport extends AppTransport {
  readonly receipts = new Map<string, MutationReceipt>();
  loseResponse = false;
  gate: Promise<void> | null = null;
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const request = args.request;
    if (!('command' in request) || request.command.command !== 'ack') return super.invoke(name, args);
    this.mutations.push(structuredClone(request));
    await this.gate;
    const command = request.command, existing = this.receipts.get(command.op_id);
    if (existing) return { api_version: 1, ok: true, data: existing } as T;
    const session = this.sessions.get(request.session!.session_id)!, item = session.items[command.params.item_id]!;
    const status = item.ack_to!;
    item.status = status; item.ack_to = null; item.revision++; session.revision++;
    if (['decided', 'done', 'dropped'].includes(status)) {
      item.outcome ??= 'Acknowledged by the owner.';
      item.why ??= 'The owner read this item.';
    }
    const receipt: MutationReceipt = { operation_id: command.op_id, session_id: session.id, revision: session.revision,
      data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status, message_id: crypto.randomUUID() } };
    this.receipts.set(command.op_id, receipt);
    if (this.loseResponse) { this.loseResponse = false; throw new Error('Lost response after save'); }
    return { api_version: 1, ok: true, data: receipt } as T;
  }
}
async function ready() {
  const transport = new BulkTransport(), session = transport.sessions.get(route.session_id)!;
  Object.values(session.items).forEach(item => { if (item) item.ack_to = null; });
  for (const [id, type] of [['1', 'finding'], ['1.1', 'explanation']] as const) {
    Object.assign(session.items[id]!, { type, status: 'open', ack_to: 'done', ask: null, question: `Result ${id}` });
  }
  const service = createDesktopService(transport), store = new SessionStore(service, route);
  stores.push(store); await store.refresh();
  const actions = new SessionActions(service, store), topicId = session.items['1']!.topic_id;
  return { transport, service, session, store, actions, topicId, controller: ackAllFor(actions) };
}
const acks = (transport: AppTransport) => transport.mutations.filter(value => value.command.command === 'ack');

it('deduplicates Recent by item, retains newest action and limits distinct visits to 15', () => {
  let entries = Array.from({ length: 20 }, (_, index) => ({ item_id: String(index + 1), action: 'viewed' as const, visited_at: '2026-10-13T00:00:00.000Z' }));
  entries = recordRecent(entries, '5', 'answered', '2026-10-13T01:00:00.000Z') as typeof entries;
  expect(entries).toHaveLength(15); expect(entries[0]).toEqual({ item_id: '5', action: 'answered', visited_at: '2026-10-13T01:00:00.000Z' });
  expect(new Set(entries.map(entry => entry.item_id)).size).toBe(15);
  expect(recordRecent([...entries, entries[0]!], '99', 'peeked')[0]!.action).toBe('peeked');
});

it('Recent lists what changed lately with its label and what was viewed, and a click reveals the item and closes', async () => {
  const { session } = await ready(), item = session.items['1']!;
  item.changes = [{ revision: item.revision + 1, at: '2026-10-13T00:00:00.000Z', cause_message_id: crypto.randomUUID(), before: { status: 'open' } }];
  item.status = 'decided';
  const entries = recordRecent(recordRecent([], '1.1', 'peeked', '2026-10-13T00:10:00.000Z'), '1', 'viewed', '2026-10-13T00:20:00.000Z');
  expect(recentEntries(session, entries).map(visit => visit.item.id)).toEqual(['1', '1.1']);
  const reveal = vi.fn(), close = vi.fn();
  render(<RecentPopover session={session} entries={entries} onReveal={reveal} onClose={close} />);
  const lately = screen.getByRole('region', { name: 'Changed lately' }), viewed = screen.getByRole('region', { name: 'Viewed' });
  expect(within(lately).getByRole('button', { name: /Result 1.*Open → Decided/ })).toBeTruthy();
  expect(within(viewed).getAllByRole('button').map(button => button.textContent)).toEqual([expect.stringMatching(/Result 1.*viewed/), expect.stringMatching(/Result 1\.1.*peeked/)]);
  fireEvent.click(within(viewed).getByRole('button', { name: /Result 1\.1.*peeked/ }));
  expect(reveal).toHaveBeenCalledWith('1.1'); expect(close).toHaveBeenCalledOnce();
});

it('Recent says so when nothing has been viewed, and closes on Escape', async () => {
  const { session } = await ready();
  const close = vi.fn();
  render(<RecentPopover session={session} entries={[]} onReveal={vi.fn()} onClose={close} />);
  expect(screen.getByText('Open or peek at an item to start your recent trail.')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledWith(true);
});

it('Ack all includes only eligible findings/explanations from the selected live topic', async () => {
  const { session, topicId } = await ready();
  for (const [id, type] of [['2', 'question'], ['3', 'decision']] as const) Object.assign(session.items[id]!, { type, status: 'open', ack_to: 'done', ask: null });
  expect(ackAllItems(immutable(session), topicId).map(item => item.id)).toEqual(['1', '1.1']);
  session.items['1.1']!.ask = 'Unanswered question'; expect(ackAllItems(immutable(session), topicId).map(item => item.id)).toEqual(['1']);
  session.topics[topicId]!.archived_at = session.updated_at; expect(ackAllItems(immutable(session), topicId)).toEqual([]);
});

it('shares one eligibility pass across topics and rerenders for a 2000-item snapshot', async () => {
  const { session, topicId, actions } = await ready(), base = session.items['1']!, topic = session.topics[topicId]!;
  session.items = {};
  const topics = Array.from({ length: 20 }, (_, index) => `topic-${index}`);
  topics.forEach(id => { session.topics[id] = { ...topic, id }; });
  for (let index = 0; index < 2000; index++) {
    const id = `result-${index}`;
    session.items[id] = { ...base, id, ordinal: 2000 - index, parent: null, topic_id: topics[index % topics.length]! };
  }
  const first = immutable(session), eligibility = vi.spyOn(ack, 'ackTarget');
  const items = topics.map(id => ackAllItems(first, id));
  const controls = () => topics.map(id => <AckAll key={id} actions={actions} topicId={id} topicName={id} items={ackAllItems(first, id)} />);
  const mounted = render(<>{controls()}</>);
  expect(screen.getAllByRole('button', { name: 'Ack all (100)' })).toHaveLength(20);
  mounted.rerender(<>{controls()}</>);
  topics.forEach((id, index) => {
    expect(ackAllItems(first, id)).toBe(items[index]);
    expect(items[index]![0]!.ordinal).toBeLessThan(items[index]!.at(-1)!.ordinal);
  });
  expect(eligibility).toHaveBeenCalledTimes(2000);
  session.items['result-0']!.ack_to = null;
  const next = immutable(session);
  expect(ackAllItems(next, topics[0]!)).toHaveLength(99);
  expect(ackAllItems(next, topics[1]!)).toHaveLength(100);
  expect(eligibility).toHaveBeenCalledTimes(4000);
  expect(ackAllItems(first, topics[0]!)).toHaveLength(100);
});

it('Undo cancels the complete hold with no domain mutation and double confirm admits once', async () => {
  const { store, controller, transport, topicId } = await ready(); vi.useFakeTimers();
  const items = ackAllItems(store.getSnapshot().snapshot!.session, topicId);
  expect(controller.confirm(topicId, 'Results', items)).toBe(true);
  expect(controller.confirm(topicId, 'Results', items)).toBe(false);
  expect(acks(transport)).toHaveLength(0); expect(controller.undo()).toBe(true);
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS + 1);
  expect(acks(transport)).toHaveLength(0); expect(controller.getSnapshot().phase).toBe('cancelled');
});

it('Ack all remains queued after unmount and sends each result once sequentially', async () => {
  const { actions, controller, transport, topicId } = await ready(); vi.useFakeTimers();
  const mounted = render(<AckAll actions={actions} topicId={topicId} topicName="Results" items={ackAllItems(actions.session.getSnapshot().snapshot!.session, topicId)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ack all (2)' }));
  expect(screen.getByRole('dialog', { name: 'Acknowledge results in Results' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ack all' }));
  mounted.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS); });
  expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2, remaining: 0 });
  expect(acks(transport).map(value => value.command.command === 'ack' && value.command.params.item_id)).toEqual(['1', '1.1']);
});

it('application stop flushes the confirmed hold before closing readers and clears its timer', async () => {
  const { actions, controller, transport, service, store, topicId } = await ready(); vi.useFakeTimers();
  controller.confirm(topicId, 'Results', ackAllItems(store.getSnapshot().snapshot!.session, topicId));
  await stopAckAll(service); store.close();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2, remaining: 0 });
  expect(actions.getSnapshot().pending).toBeNull();
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(acks(transport).map(value => value.command.command === 'ack' && value.command.params.item_id)).toEqual(['1', '1.1']);
});

it('repeated unload and stop join one sequential batch and never duplicate an acknowledgment', async () => {
  const { controller, transport, service, store, topicId } = await ready(); vi.useFakeTimers();
  let release!: () => void;
  transport.gate = new Promise<void>(resolve => { release = resolve; });
  const detach = attachAckAll(service);
  controller.confirm(topicId, 'Results', ackAllItems(store.getSnapshot().snapshot!.session, topicId));
  window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('beforeunload'));
  const stopped = stopAckAll(service);
  const completedSecondStop = vi.fn(), stoppedAgain = stopAckAll(service).then(completedSecondStop);
  expect(acks(transport)).toHaveLength(1);
  expect(controller.getSnapshot().phase).toBe('saving');
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(acks(transport)).toHaveLength(1);
  expect(completedSecondStop).not.toHaveBeenCalled();
  release(); await Promise.all([stopped, stoppedAgain]); detach();
  expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2 });
  expect(new Set(acks(transport).map(value => value.command.op_id)).size).toBe(2);
  expect(transport.receipts.size).toBe(2);
});

it('Undo before unload leaves no acknowledged work for lifecycle flush', async () => {
  const { controller, transport, service, store, topicId } = await ready(); vi.useFakeTimers();
  const detach = attachAckAll(service);
  controller.confirm(topicId, 'Results', ackAllItems(store.getSnapshot().snapshot!.session, topicId));
  controller.undo(); window.dispatchEvent(new Event('pagehide')); await stopAckAll(service); detach();
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(acks(transport)).toHaveLength(0);
});

it.each(['open', 'done'] as const)('skips a manual Ack to %s during the hold and saves the other reviewed result', async target => {
  const { actions, controller, transport, store, topicId } = await ready();
  const item = transport.sessions.get(route.session_id)!.items['1']!;
  item.ack_to = target; item.outcome = null; item.why = null;
  item.revision++; transport.sessions.get(route.session_id)!.revision++;
  await store.refresh(true); vi.useFakeTimers();
  const session = store.getSnapshot().snapshot!.session;
  controller.confirm(topicId, 'Results', ackAllItems(session, topicId));
  expect(await actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: item.id, expected_revision: item.revision } }, session.revision)).toBe(true);
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2, remaining: 0 });
  expect(acks(transport).map(value => value.command.command === 'ack' && value.command.params.item_id)).toEqual(['1', '1.1']);
});

it.each(['edited after Ack', 'question', 'decision'] as const)('does not skip a manually acknowledged result that becomes %s', async change => {
  const { actions, controller, transport, store, topicId } = await ready(); vi.useFakeTimers();
  const session = store.getSnapshot().snapshot!.session;
  controller.confirm(topicId, 'Results', ackAllItems(session, topicId));
  await actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: '1', expected_revision: session.items['1']!.revision } }, session.revision);
  const current = transport.sessions.get(route.session_id)!;
  if (change === 'edited after Ack') current.items['1']!.question = 'Updated result';
  else current.items['1']!.type = change;
  current.items['1']!.revision++; current.revision++;
  await store.refresh(true); await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(acks(transport)).toHaveLength(1);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', completed: 0, remaining: 2 });
  expect(controller.getSnapshot().error).toContain('result changed');
});

it('changed proposals during Undo hold retain all unsaved work and require renewed review', async () => {
  const { actions, controller, transport, topicId } = await ready(); vi.useFakeTimers();
  controller.confirm(topicId, 'Results', ackAllItems(actions.session.getSnapshot().snapshot!.session, topicId));
  transport.sessions.get(route.session_id)!.items['1']!.question = 'A changed proposal';
  transport.sessions.get(route.session_id)!.items['1']!.revision++;
  transport.sessions.get(route.session_id)!.revision++;
  await actions.session.refresh(true);
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(acks(transport)).toHaveLength(0);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', completed: 0, remaining: 2 });
  expect(controller.getSnapshot().error).toContain('result changed');
  expect(controller.cancelRemaining()).toBe(true);
});

it('uncertain first saves keep remaining work and retry only the exact operation before proceeding', async () => {
  const { actions, controller, transport, topicId } = await ready(); vi.useFakeTimers(); transport.loseResponse = true;
  controller.confirm(topicId, 'Results', ackAllItems(actions.session.getSnapshot().snapshot!.session, topicId));
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', remaining: 2 });
  expect(controller.cancelRemaining()).toBe(false);
  const firstId = acks(transport)[0]!.command.op_id;
  await Promise.all([controller.retry(), controller.retry()]);
  expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2 });
  expect(acks(transport)[1]!.command.op_id).toBe(firstId);
  expect(transport.receipts.size).toBe(2);
});

it('does not adopt another pending same-item acknowledgement during the hold', async () => {
  const { actions, controller, transport, topicId } = await ready(); vi.useFakeTimers(); transport.loseResponse = true;
  const session = actions.session.getSnapshot().snapshot!.session;
  controller.confirm(topicId, 'Results', ackAllItems(session, topicId));
  await actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: '1', expected_revision: session.items['1']!.revision } }, session.revision);
  await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS);
  expect(controller.getSnapshot().phase).toBe('failed'); expect(acks(transport)).toHaveLength(1);
});

it('the refcounted visit writer saves other-session visits and preserves unrelated view fields', async () => {
  const { transport, service } = await ready();
  const otherRoute = { ...route, session_id: '00000000-0000-4000-8000-000000000003' };
  transport.preferences.sessions.push({ ...transport.view(otherRoute.session_id), tab_open: false, focused_item_id: '3' });
  const navigation = new NavigationStore(service);
  const releaseA = navigationVisits.bind(navigation), releaseB = navigationVisits.bind(navigation);
  navigationVisits.record(otherRoute, '3', 'peeked');
  await navigation.refresh();
  await vi.waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === otherRoute.session_id)?.recent_items?.[0]?.action).toBe('peeked'));
  const restored = transport.preferences.sessions.find(view => view.session.session_id === otherRoute.session_id)!;
  expect(restored.focused_item_id).toBe('3'); expect(restored.tab_open).toBe(false);
  releaseA(); navigationVisits.record(otherRoute, '3', 'answered');
  await vi.waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === otherRoute.session_id)?.recent_items?.[0]?.action).toBe('answered'));
  releaseB(); navigation.stop();
});

it('a failed Recent write is retried once, quietly, with the exact operation before any notice', async () => {
  const { transport, service } = await ready();
  const navigation = new NavigationStore(service);
  await navigation.refresh();
  const release = navigationVisits.bind(navigation);
  transport.failNext = 'preferences_patch';
  navigationVisits.record(route, '1.1', 'answered');
  await vi.waitFor(() => expect(transport.preferences.sessions[0]!.recent_items?.[0]).toMatchObject({ item_id: '1.1', action: 'answered' }));
  expect(notices.getSnapshot().find(notice => notice.id === 'recent-save')).toBeUndefined();
  const patches = transport.mutations.filter(request => request.command.command === 'preferences_patch');
  expect(patches).toHaveLength(2);
  expect(patches[1]!.command.op_id).toBe(patches[0]!.command.op_id);
  expect(navigation.getSnapshot().pendingOperationId).toBeNull();
  release(); navigation.stop();
});

it('a Recent write that fails twice shows one notice, and its retry saves', async () => {
  const { transport, service } = await ready();
  const navigation = new NavigationStore(service);
  await navigation.refresh();
  const release = navigationVisits.bind(navigation);
  const invoke = transport.invoke.bind(transport);
  let failures = 2;
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if (name === 'preferences_patch' && failures > 0) { failures--; transport.mutations.push(structuredClone(args.request) as OwnerMutationRequest); throw new Error('Lost response'); }
    return invoke(name, args);
  });
  navigationVisits.record(route, '1.1', 'answered');
  await vi.waitFor(() => expect(notices.getSnapshot().filter(notice => notice.id === 'recent-save')).toHaveLength(1));
  expect(navigation.getSnapshot().pendingOperationId).not.toBeNull();
  notices.getSnapshot().find(notice => notice.id === 'recent-save')!.actions![0]!.run();
  await vi.waitFor(() => expect(transport.preferences.sessions[0]!.recent_items?.[0]).toMatchObject({ item_id: '1.1', action: 'answered' }));
  expect(notices.getSnapshot().find(notice => notice.id === 'recent-save')).toBeUndefined();
  release(); navigation.stop();
});

it('another writer holding the store is not reported as a failed Recent save', async () => {
  const { transport, service } = await ready();
  const navigation = new NavigationStore(service);
  await navigation.refresh();
  const release = navigationVisits.bind(navigation);
  const invoke = transport.invoke.bind(transport);
  let lose = true;
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    const request = args.request as OwnerMutationRequest;
    const entries = 'command' in request && request.command.command === 'preferences_patch' ? request.command.params.entries : [];
    if (lose && entries.some(entry => entry.kind === 'set_global')) { lose = false; throw new Error('Lost response'); }
    return invoke(name, args);
  });
  await navigation.saveTheme('dark', navigation.getSnapshot().preferences!.revision);
  expect(navigation.getSnapshot().pendingOperationId).not.toBeNull();
  navigationVisits.record(route, '1.1', 'answered');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(notices.getSnapshot().find(notice => notice.id === 'recent-save')).toBeUndefined();
  release(); navigation.stop();
});

it('a miss behind another writer resets the count, so a later own miss is still retried quietly', async () => {
  const other = { ...route, session_id: '00000000-0000-4000-8000-0000000000aa' };
  const state = { writing: false, pendingOperationId: null as string | null, error: null as { code: string } | null, preferences: { revision: 1, sessions: [] as unknown[] } };
  const listeners = new Set<() => void>();
  const outcomes: ('own miss' | 'behind another writer' | 'saved')[] = ['own miss', 'behind another writer', 'own miss', 'saved'];
  const calls: string[] = [];
  const stub = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isRecentPending: () => false,
    retryMutation: async () => false,
    // Visits other tests left queued share the module's queue; this writer saves them so only `other` is scripted.
    saveRecentItems: async (session: { session_id: string }) => {
      if (session.session_id !== other.session_id) return true;
      const outcome = outcomes.shift()!;
      calls.push(outcome);
      state.writing = outcome === 'behind another writer';
      state.error = outcome === 'own miss' ? { code: 'invalid_response' } : null;
      return outcome === 'saved';
    },
  };
  const release = navigationVisits.bind(stub as unknown as NavigationStore);
  navigationVisits.record(other, '1', 'viewed');
  await vi.waitFor(() => expect(calls).toEqual(['own miss', 'behind another writer']));
  state.writing = false; listeners.forEach(listener => { listener(); });
  await vi.waitFor(() => expect(calls).toEqual(['own miss', 'behind another writer', 'own miss', 'saved']));
  expect(notices.getSnapshot().find(notice => notice.id === 'recent-save')).toBeUndefined();
  release();
});

it('Waiting visits persist a never-opened session without opening its tab or changing navigation', async () => {
  const { transport, service } = await ready();
  const otherRoute = { ...route, session_id: '00000000-0000-4000-8000-000000000003' };
  const navigation = new NavigationStore(service);
  await navigation.refresh();
  expect(navigation.getSnapshot().preferences!.sessions.some(view => view.session.session_id === otherRoute.session_id)).toBe(false);
  const selection = structuredClone(transport.preferences.global.selected_navigation);
  const release = navigationVisits.bind(navigation);
  navigationVisits.record(otherRoute, '1', 'peeked');
  await vi.waitFor(() => expect(transport.preferences.sessions.find(view => view.session.session_id === otherRoute.session_id)?.recent_items?.[0])
    .toMatchObject({ item_id: '1', action: 'peeked' }));
  const saved = transport.preferences.sessions.find(view => view.session.session_id === otherRoute.session_id)!;
  expect(saved.tab_open).toBe(false); expect(saved.tab_order).toBe(1); expect(saved.selected_item_id).toBeNull();
  expect(saved.expanded_item_ids).toEqual([]);
  expect(transport.preferences.global.selected_navigation).toEqual(selection);
  const reopened = new NavigationStore(service);
  await reopened.refresh();
  expect(reopened.getSnapshot().preferences!.sessions.find(view => view.session.session_id === otherRoute.session_id)?.recent_items?.[0]?.action).toBe('peeked');
  release(); navigation.stop(); reopened.stop();
});

it('an unopened Recent save preserves a concurrently opened view when its patch rebases', async () => {
  const { transport, service } = await ready();
  const otherRoute = { ...route, session_id: '00000000-0000-4000-8000-000000000003' };
  const navigation = new NavigationStore(service);
  await navigation.refresh();
  const invoke = transport.invoke.bind(transport);
  let conflicted = false;
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if (!conflicted && 'command' in args.request && args.request.command.command === 'preferences_patch') {
      conflicted = true;
      transport.preferences.sessions.push({ ...transport.view(otherRoute.session_id), tab_open: true, focused_item_id: '3',
        filters: { ...transport.view().filters, search: 'owner filter' } });
      transport.preferences.revision++;
      return { api_version: 1, ok: false, error: { code: 'revision_conflict', message: 'Preferences changed', hint: '',
        retryable: false, field_errors: [], current_revision: transport.preferences.revision } };
    }
    return invoke(name, args);
  });
  expect(await navigation.saveRecentItems(otherRoute, recordRecent([], '1', 'peeked'), navigation.getSnapshot().preferences!.revision)).toBe(true);
  const saved = transport.preferences.sessions.find(view => view.session.session_id === otherRoute.session_id)!;
  expect(saved.tab_open).toBe(true); expect(saved.focused_item_id).toBe('3'); expect(saved.filters.search).toBe('owner filter');
  expect(saved.recent_items?.[0]?.action).toBe('peeked');
  navigation.stop();
});
