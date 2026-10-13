import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { SessionActions } from '../../../src/components/bindings/actions';
import type { MutationReceipt, OwnerMutationRequest, OwnerQueryRequest, SessionSeen } from '../../../src/generated/core';
import { AckAll } from '../../../src/ui/navigation/AckAll';
import { ackAllFor, ackAllItems, ACK_ALL_HOLD_MS } from '../../../src/ui/navigation/ackAllController';
import { RecentDialog, RecentTrail, recentEntries, recordRecent } from '../../../src/ui/navigation/Recent';
import { navigationVisits } from '../../../src/ui/navigation/visits';
import { NavigationStore } from '../../../src/state/navigation/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';

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

it('Recent filters use the shared meaningful-change selectors and links reveal the item', async () => {
  const { session } = await ready(), item = session.items['1']!;
  const baseline = '2026-10-01T00:00:00.000Z';
  const seen: SessionSeen = { session: route, since: baseline, items: [{ item_id: item.id, revision: item.revision }], topics: [] };
  item.created_at = baseline;
  item.changes = [{ revision: item.revision + 1, at: '2026-10-13T00:00:00.000Z', wording_only: true,
    cause_message_id: crypto.randomUUID(), before: { question: 'Earlier result' } }];
  const entries = recordRecent([], '1', 'viewed');
  expect(recentEntries(session, entries, true, seen)).toHaveLength(0);
  item.changes[0]!.wording_only = false;
  expect(recentEntries(session, entries, true, seen)).toHaveLength(1);
  const reveal = vi.fn(), close = vi.fn();
  render(<RecentDialog session={session} entries={entries} seen={seen} onReveal={reveal} onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Changed only' }));
  fireEvent.click(screen.getByRole('button', { name: /Result 1 · viewed/ }));
  expect(reveal).toHaveBeenCalledWith('1'); expect(close).toHaveBeenCalledOnce();
});

it('Recent trail shows three names/actions and Next reveals the supplied waiting item', async () => {
  const { session } = await ready();
  let entries = recordRecent([], '1', 'viewed');
  for (const id of ['1.1', '2', '3']) entries = recordRecent(entries, id, 'peeked');
  const reveal = vi.fn(); render(<RecentTrail session={session} entries={entries} nextWaiting={session.items['2']!} onReveal={reveal} />);
  expect(screen.getByRole('navigation', { name: 'Your recent trail' }).querySelectorAll('.recent-trail-items button')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: /^Next:/ })); expect(reveal).toHaveBeenCalledWith('2');
});

it('Ack all includes only eligible findings/explanations from the selected live topic', async () => {
  const { session, topicId } = await ready();
  for (const [id, type] of [['2', 'question'], ['3', 'decision']] as const) Object.assign(session.items[id]!, { type, status: 'open', ack_to: 'done', ask: null });
  expect(ackAllItems(session, topicId).map(item => item.id)).toEqual(['1', '1.1']);
  session.items['1.1']!.ask = 'Unanswered question'; expect(ackAllItems(session, topicId).map(item => item.id)).toEqual(['1']);
  session.topics[topicId]!.archived_at = session.updated_at; expect(ackAllItems(session, topicId)).toEqual([]);
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
  const mounted = render(<AckAll actions={actions} topicId={topicId} topicName="Results" />);
  fireEvent.click(screen.getByRole('button', { name: 'Ack all (2)' }));
  expect(screen.getByRole('dialog', { name: 'Acknowledge results in Results' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ack all' }));
  mounted.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(ACK_ALL_HOLD_MS); });
  expect(controller.getSnapshot()).toMatchObject({ phase: 'done', completed: 2, remaining: 0 });
  expect(acks(transport).map(value => value.command.command === 'ack' && value.command.params.item_id)).toEqual(['1', '1.1']);
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

it('failed Recent writes retain visits behind a visible exact-save retry', async () => {
  const { transport, service } = await ready();
  const navigation = new NavigationStore(service);
  await navigation.refresh();
  const release = navigationVisits.bind(navigation);
  transport.failNext = 'preferences_patch';
  navigationVisits.record(route, '1.1', 'answered');
  await vi.waitFor(() => expect(notices.getSnapshot().find(notice => notice.id === 'recent-save')).toBeTruthy());
  expect(navigation.getSnapshot().pendingOperationId).not.toBeNull();
  notices.getSnapshot().find(notice => notice.id === 'recent-save')!.actions![0]!.run();
  await vi.waitFor(() => expect(transport.preferences.sessions[0]!.recent_items?.[0]).toMatchObject({ item_id: '1.1', action: 'answered' }));
  expect(notices.getSnapshot().find(notice => notice.id === 'recent-save')).toBeUndefined();
  release(); navigation.stop();
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
  expect(saved.expanded_item_ids).toEqual([]); expect(saved.rail).toBe('waiting');
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
