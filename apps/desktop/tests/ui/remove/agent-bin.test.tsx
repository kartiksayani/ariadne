import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import summariesFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { AgentRemoval, Input, ProjectSummary, Session, SessionSummary } from '../../../src/generated/domain/models';
import type { OwnerMutationRequest } from '../../../src/generated/core';
import { DesktopApp } from '../../../src/App';
import { createDesktopService, useSession } from '../../../src/data';
import { NavigationStore } from '../../../src/state/navigation/store';
import { indexSession, revealAncestors } from '../../../src/data/selectors';
import { OpenSessions, type Immutable } from '../../../src/data/session-store';
import { SessionActionControllers, type SessionActions } from '../../../src/components/bindings/actions';
import { activeItems, activeTopics, heldInputs, itemRemoved, removedRoots, removedSubtree } from '../../../src/selectors/removed';
import { ackTarget } from '../../../src/selectors/ack';
import { sentenceRows } from '../tree/scope';
import { chipCounts } from '../../../src/selectors/tree/filter';
import { relatedItems } from '../../../src/selectors/related';
import { sentRows, waitingRows } from '../../../src/selectors/waiting/rows';
import { sessionGraph } from '../../../src/ui/graph/model';
import { shimTree } from '../tree/shimTree';
import { projectRemoval, sessionRemoval } from '../../../src/ui/pages/model';
import { Notices, notices } from '../../../src/ui/pages/notices';
import { AgentBin, binView, removalNotice, restoreRemoved } from '../../../src/ui/remove/AgentBin';
import type { RemoveTarget } from '../../../src/ui/dialogs/remove';
import { AppTransport, route } from '../app/transport';
import { goToSession } from '../app/open';
import { graphSession, preferences, topicA, topicB } from '../graph/fixture';

const opened: OpenSessions[] = [];
afterEach(() => {
  cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); notices.clear(); vi.restoreAllMocks();
  binView.reveal({ ...route, session_id: 'another-session' }, null);
});

function removedSession(): Session {
  const session = graphSession();
  session.items['1']!.short = 'Old delivery plans';
  session.items['1']!.removed_at = session.updated_at;
  // A nested marker remains part of the same recoverable subtree.
  session.items['1.1']!.removed_at = session.updated_at;
  session.topics[topicB]!.removed_at = session.updated_at;
  return session;
}
function cancelledInput(session: Session, itemId = '1.1.1'): Input {
  const input = structuredClone(Object.values(session.inputs).find(value => value)!);
  input.state = 'cancelled'; input.cancel_cause = 'agent_removed'; input.answer_id = null;
  input.target = { topic_id: session.items[itemId]!.topic_id, item_id: itemId };
  input.payload.text = 'Please keep my original delivery notes.';
  return input;
}
let queuedSequence = 0;
function queuedInput(session: Session, id: string, itemId: string | null, topicId = topicA): Input {
  const input = cancelledInput(session, itemId ?? '1');
  input.id = `00000000-0000-4000-8000-${String(++queuedSequence).padStart(12, '0')}`; input.state = 'queued'; delete input.cancel_cause;
  input.kind = 'note'; input.resolution_history = []; input.active_attempt_id = null;
  input.target = { topic_id: topicId, item_id: itemId }; input.payload.text = `Retained words for ${id}.`;
  return input;
}
const ids = (items: readonly { readonly id: string }[]) => items.map(item => item.id);
const notice = (overrides: Partial<AgentRemoval> = {}): AgentRemoval => ({ topic_id: topicA, item_id: '1',
  message_id: '00000000-0000-4000-8000-000000000090', item_ids: ['1', '1.1', '1.1.1', '1.2'],
  waiting_questions: 2, cancelled_input_ids: ['00000000-0000-4000-8000-000000000091'], ...overrides });

function receiptSession(removal = notice()): Session {
  const session = removedSession(), operationId = '00000000-0000-4000-8000-000000000095';
  const source = removal.item_id ? session.items[removal.item_id]! : session.topics[removal.topic_id]!;
  source.removed_at = session.updated_at;
  source.removed_by = { binding_id: session.active_binding_id!, message_id: removal.message_id };
  session.operation_receipts = { [operationId]: [{ operation_id: operationId,
    actor_scope: { kind: 'agent', binding_id: session.active_binding_id! }, command_digest: 'a'.repeat(64),
    result: { operation_id: operationId, session_id: session.id, revision: session.revision,
      data: { kind: 'apply', agent_removals: [removal], allocated_refs: {}, messages: [], item_revisions: {}, topic_revisions: {},
        input_result_state: null, queue_join_state: null } } }] };
  return session;
}
async function openApp(transport: BinTransport) {
  render(<DesktopApp service={createDesktopService(transport)} />);
  await goToSession(route);
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
}
/** The top bar's search box shows while it holds words; an empty search is the closed "Search the Map" button. */
const searchValue = () => document.querySelector<HTMLInputElement>('.tb-search-input')?.value ?? '';
async function refreshApp(transport: BinTransport) {
  const queries = transport.queries.filter(request => request.request.command === 'session_get').length;
  ++transport.source.revision;
  await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: transport.source.revision }); });
  await waitFor(() => expect(transport.queries.filter(request => request.request.command === 'session_get').length).toBeGreaterThan(queries));
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
}

/** Extend the ordinary app fake with the two Core restore receipts. */
class BinTransport extends AppTransport {
  readonly source: Session;
  constructor(session = removedSession()) {
    super(); this.source = session; this.sessions.set(session.id, session);
  }
  async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if (!('command' in request) || !['item_restore', 'topic_removed_restore'].includes(request.command.command)) return super.invoke(name, args);
    this.mutations.push(structuredClone(request));
    const command = request.command;
    let topicId: string, itemId: string | null;
    if (command.command === 'item_restore') {
      const item = this.source.items[command.params.item_id]!;
      if (command.params.expected_revision !== item.revision) throw new Error('Restore used a stale item revision');
      topicId = item.topic_id; itemId = item.id;
      // Core clears only this marker; independently removed descendants stay in the bin.
      delete item.removed_at; delete item.removed_by; ++item.revision;
    } else if (command.command === 'topic_removed_restore') {
      const topic = this.source.topics[command.params.topic_id]!;
      if (command.params.expected_revision !== topic.revision) throw new Error('Restore used a stale topic revision');
      topicId = topic.id; itemId = null; delete topic.removed_at; delete topic.removed_by; ++topic.revision;
    } else throw new Error('Unexpected restore');
    ++this.source.revision;
    return { api_version: 1, ok: true, data: { operation_id: command.op_id, session_id: this.source.id, revision: this.source.revision,
      data: { kind: 'bin_restore', topic_id: topicId, item_id: itemId } } } as T;
  }
}
async function setup(session = removedSession()) {
  const transport = new BinTransport(session), service = createDesktopService(transport), sessions = new OpenSessions(service);
  opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  let operation = 0;
  const actions = new SessionActionControllers(service, () => `00000000-0000-4000-8000-0000000009${String(++operation).padStart(2, '0')}`).forSession(store);
  return { transport, service, store, actions };
}
function LiveBin({ actions, topicId = topicA, onRemove = () => {} }: {
  readonly actions: SessionActions; readonly topicId?: string | null; readonly onRemove?: (target: RemoveTarget) => void;
}) {
  const session = useSession(actions.session).snapshot?.session;
  return session ? <AgentBin session={session} actions={actions} topicId={topicId} onRemove={onRemove} /> : null;
}
async function staleRefresh(value: Awaited<ReturnType<typeof setup>>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), invoke = value.transport.invoke.bind(value.transport);
  vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
    if (name === 'session_get') await gate;
    return invoke(name, args);
  });
  ++value.transport.source.revision;
  act(() => { value.transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: value.transport.source.revision }); });
  expect(value.store.getSnapshot().status).toBe('stale');
  return release;
}

describe('removed work projections', () => {
  it.each(['open', 'in_progress', 'done', 'decided', 'dropped'] as const)('preserves Ack to %s across direct, ancestor and topic removal and restoration', async choice => {
    for (const removal of ['item', 'ancestor', 'topic'] as const) {
      const session = graphSession(), view = preferences(), item = session.items['1.1']!; session.inputs = {};
      for (const candidate of Object.values(session.items)) if (candidate) candidate.ack_to = null;
      item.ack_to = choice; item.ask = null; item.options = [];
      session.items['2']!.ack_to = 'done'; session.items['2']!.ask = null;
      const counts = (snapshot: Immutable<Session>) => {
        const tree = shimTree({ session: snapshot, view, search: '', later: new Set(), collapsedTopics: new Set(), selectedId: null,
          revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(snapshot.updated_at) });
        // The Graph carries no counts (SPEC 1.3: a topic title only).
        return { tree: tree.rows.flatMap(row => row.kind === 'topic' ? row.counts.map(count => count.text) : []) };
      };
      expect(ackTarget(session, item)).toBe(choice);
      expect(counts(session).tree).toContain('2 to ack');
      const itemId = removal === 'item' ? item.id : removal === 'ancestor' ? item.parent! : null;
      if (itemId) session.items[itemId]!.removed_at = session.updated_at;
      else session.topics[topicA]!.removed_at = session.updated_at;
      const value = await setup(session), binned = value.store.getSnapshot().snapshot!.session;
      expect(binned.items[item.id]!.ack_to).toBe(choice);
      expect(ackTarget(binned, binned.items[item.id]!)).toBeNull();
      const removedCounts = counts(binned);
      expect(removedCounts.tree).not.toContain('2 to ack');
      if (removal === 'topic') expect(removedCounts.tree.some(count => count.includes('to ack'))).toBe(false);
      else expect(removedCounts.tree).toContain('1 to ack');
      expect(await restoreRemoved(value.actions, topicA, itemId)).toBeNull();
      const restored = value.store.getSnapshot().snapshot!.session;
      expect(restored.items[item.id]!.ack_to).toBe(choice);
      expect(ackTarget(restored, restored.items[item.id]!)).toBe(choice);
      const restoredCounts = counts(restored);
      expect(restoredCounts.tree).toContain('2 to ack');
    }
  });

  it('inherits ancestor and topic removal and exposes each disjoint bin root once', () => {
    const session = removedSession();
    expect(['1', '1.1', '1.1.1', '1.2', '8'].every(id => itemRemoved(session, id))).toBe(true);
    expect(itemRemoved(session, '2')).toBe(false);
    expect(ids(activeItems(session))).toEqual(['2', '3']);
    expect(ids(activeTopics(session))).toEqual([topicA]);
    expect(ids(removedRoots(session, topicA))).toEqual(['1']);
    expect(ids(removedSubtree(session, '1'))).toEqual(['1', '1.1', '1.1.1', '1.2']);
    expect(removedRoots(session, topicB)).toEqual([]);
    expect(session.items['1.1.1']!.status).toBe('waiting_on_me');
    expect(session.items['1.1.1']!.removed_at).toBeUndefined();
  });

  it('excludes removed work from tree, search, forced reveals and active descendant counts', () => {
    const session = removedSession(), view = preferences();
    expect(ids(sentenceRows(session, view, new Set()).rows.map(row => row.item))).toEqual(['2', '3']);
    // A search narrows no rows (SPEC §4), and it finds nothing in removed work: no row matches, none counts as out of view.
    const search = { ...view, filters: { ...view.filters, search: 'morning or evening' } };
    expect(ids(sentenceRows(session, search, new Set(), ['1', '1.1'], '1.1.1').rows.map(row => row.item))).toEqual(['2', '3']);
    const searched = shimTree({ session, view, search: 'morning or evening', later: new Set(), collapsedTopics: new Set(), selectedId: null,
      revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) });
    expect(searched.rows.filter(row => row.kind === 'item' && row.matches.length > 0)).toEqual([]);
    expect(searched.search).toMatchObject({ hidden: 0, collapsed: 0 });
    expect(indexSession(session).activeDescendants.get('1')).toBe(0);
    expect(revealAncestors.bind(null, session, { ...route, item_id: '1.1.1' })).toThrow('unavailable');
    const model = shimTree({ session, view, search: '', later: new Set(), collapsedTopics: new Set(), selectedId: '1.1.1',
      revealId: '1.1.1', temporaryExpanded: ['1', '1.1'], presence: null, summaries: [], now: Date.parse(session.updated_at) });
    expect(model.itemCount).toBe(2); expect(chipCounts({ session, view, later: new Set(), local: [] }).waiting).toBe(0);
    expect(model.rows.filter(row => row.kind === 'topic').map(row => row.topic.id)).toEqual([topicA]);
    expect(model.rows.filter(row => row.kind === 'item').map(row => row.item.id)).toEqual(['2', '3']);
  });

  it('excludes removed nodes, links, topics and waiting counts from the graph and related navigation', () => {
    const session = removedSession();
    session.items['2']!.related = ['1.1.1', '8']; session.items['1']!.related = ['2'];
    const graph = sessionGraph({ session, view: preferences(), later: new Set(), selectedId: '2' });
    expect(graph.order).toEqual(['2', '3']);
    expect(graph.topics.map(topic => topic.topic.id)).toEqual([topicA]);
    expect(graph.topics[0].edges.map(edge => edge.id)).toEqual([`trunk:${topicA}`, 'topic:2', 'topic:3']);
    expect(relatedItems(session, '2')).toEqual([]); expect(relatedItems(session, '1')).toEqual([]);
  });

  it('hides a removed replacement reference and restores it when that work becomes active again', () => {
    const session = removedSession(); session.items['3']!.replaced_by = '1';
    const view = preferences(), tree = (snapshot: Session) => shimTree({ session: snapshot, view, search: '', later: new Set(),
      collapsedTopics: new Set(), selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(snapshot.updated_at) });
    const removed = tree(session).rows.find(row => row.kind === 'item' && row.item.id === '3');
    expect(removed?.kind === 'item' && removed.replacedBy).toBeNull();
    expect(sentenceRows(session, view, new Set()).rows.find(row => row.item.id === '3')!.replacement).toBeNull();
    const restored = structuredClone(session); delete restored.items['1']!.removed_at;
    const active = tree(restored).rows.find(row => row.kind === 'item' && row.item.id === '3');
    expect(active?.kind === 'item' && active.replacedBy?.id).toBe('1');
    expect(sentenceRows(restored, view, new Set()).rows.find(row => row.item.id === '3')!.replacement?.id).toBe('1');
  });

  it('removes inherited questions and unsettled inputs from Waiting and Sent even before cancellation', () => {
    const session = removedSession(); session.answers = []; session.rounds = {}; session.inputs = {};
    for (const id of ['1.1.1', '2', '8']) {
      const item = session.items[id]!; item.status = 'waiting_on_me'; item.current_round_id = null;
      item.waiting_since = session.updated_at; item.created_message_id = session.messages[0].id;
    }
    const template = cancelledInput(graphSession());
    for (const [index, itemId] of ['1.1.1', '2', '8'].entries()) {
      const input = structuredClone(template); input.id = `00000000-0000-4000-8000-00000000008${index}`;
      input.state = 'needs_attention'; input.target = { topic_id: session.items[itemId]!.topic_id, item_id: itemId };
      session.inputs[input.id] = input;
    }
    const topicInput = structuredClone(template); topicInput.id = '00000000-0000-4000-8000-000000000084';
    topicInput.state = 'queued'; topicInput.target = { topic_id: topicB, item_id: null }; session.inputs[topicInput.id] = topicInput;
    const sources = [{ session, project: projectsFixture.items[0] as ProjectSummary, summary: summariesFixture.items[0] as SessionSummary }];
    expect(waitingRows(sources).map(row => row.item.id)).toEqual(['2']);
    expect(sentRows(sources).map(row => row.route?.item_id)).toEqual(['2']);
  });

  it('permanent session/project removal counts its full destructive scope, removed work included', () => {
    const session = removedSession(); session.inputs = {};
    expect(sessionRemoval(session, new Set())).toMatchObject({ topics: 2, items: 7, shared: 0, waiting: 0 });
    expect(projectRemoval([session])).toMatchObject({ topics: 2, items: 7, waiting: 0 });
  });

  it('retains a binned shared topic outside permanent session deletion while project deletion includes it', () => {
    const session = removedSession(); session.inputs = {};
    expect(sessionRemoval(session, new Set([`${session.id}:${topicB}`])))
      .toMatchObject({ topics: 1, items: 6, shared: 1, waiting: 0 });
    expect(projectRemoval([session])).toMatchObject({ topics: 2, items: 7, waiting: 0 });
  });
});

describe('agent removal notices', () => {
  it('names a single removed item without counting it as additional work', () => {
    expect(removalNotice(removedSession(), notice({ item_ids: ['1'], waiting_questions: 0, cancelled_input_ids: [] })))
      .toBe('The agent removed “Old delivery plans”.');
  });
  it('names removed work and explains the waiting questions and preserved cancelled words', () => {
    expect(removalNotice(removedSession(), notice())).toBe('The agent removed “Old delivery plans” and its work (4 items). 2 waiting questions left your panel. 1 unsent message was cancelled. Your words are kept in the bin.');
  });
  it('uses singular question/item wording and plural cancelled messages for a topic', () => {
    const session = removedSession();
    expect(removalNotice(session, notice({ item_id: null, topic_id: topicB, item_ids: ['8'], waiting_questions: 1, cancelled_input_ids: ['one', 'two'] })))
      .toBe(`The agent removed “${session.topics[topicB]!.name}” and its work (1 item). 1 waiting question left your panel. 2 unsent messages were cancelled. Your words are kept in the bin.`);
  });
});

describe('agent removal bin', () => {
  it('matches result-repair queue eligibility from the latest attempt resolution', () => {
    const session = removedSession(), input = queuedInput(session, 'repair-retry', '1'), attempt = input.attempts.at(-1)!;
    attempt.purpose = 'result_repair'; session.inputs = { [input.id]: input };
    // Without a queue resolution even a result-repair attempt is held, as in Core.
    expect(heldInputs(session).map(value => value.id)).toEqual([input.id]);
    input.resolution_history = [{ op_id: '00000000-0000-4000-8000-000000000092', attempt_id: attempt.id,
      kind: 'retry_unexecuted', reason: '', at: session.updated_at, evidence: null }];
    expect(heldInputs(session)).toEqual([]);
    attempt.purpose = 'work';
    expect(heldInputs(session).map(value => value.id)).toEqual([input.id]);
    input.resolution_history[0].attempt_id = '00000000-0000-4000-8000-000000000093';
    input.resolution_history[0].kind = 'request_result_repair';
    expect(heldInputs(session).map(value => value.id)).toEqual([input.id]);
  });

  it('cancels a pending confirmation when the session actions change', async () => {
    const session = removedSession(), input = queuedInput(session, 'held-before-navigation', '1'); session.inputs = { [input.id]: input };
    const previous = await setup(session), next = await setup();
    const view = render(<LiveBin actions={previous.actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByRole('dialog', { name: 'Restore work' });
    view.rerender(<LiveBin actions={next.actions} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(previous.transport.mutations).toEqual([]); expect(session.items['1']!.removed_at).toBeTruthy();
  });

  it('shows held queued messages and counts only the messages released by restoring the selected marker', async () => {
    const session = removedSession();
    const inputs = [queuedInput(session, 'root-message', '1'), queuedInput(session, 'visible-child-message', '1.2'),
      queuedInput(session, 'nested-message', '1.1.1')];
    session.inputs = Object.fromEntries(inputs.map(input => [input.id, input]));
    const value = await setup(session); render(<LiveBin actions={value.actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    for (const input of inputs) expect(screen.getByText(`Held — sends if you restore: ${input.payload.text}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Restore work' }));
    expect(confirm.getByText('Restoring this work makes 2 held messages visible again. They will send when sending can resume.')).toBeTruthy();
    expect(value.transport.mutations).toEqual([]);
    fireEvent.click(confirm.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(value.transport.mutations).toHaveLength(1));
    await screen.findByRole('button', { name: 'Removed by agent · 2' });
    expect(screen.queryByText(`Held — sends if you restore: ${inputs[0].payload.text}`)).toBeNull();
    expect(screen.getByText(`Held — sends if you restore: ${inputs[2].payload.text}`)).toBeTruthy();
    expect(inputs.every(input => session.inputs[input.id]!.state === 'queued')).toBe(true);
  });

  it('counts a topic message and visible item message while excluding nested markers, notices and result repairs', async () => {
    const session = removedSession(); session.items['8']!.removed_at = session.updated_at;
    const topic = queuedInput(session, 'topic-message', null, topicB), nested = queuedInput(session, 'nested-message', '8', topicB);
    const notification = queuedInput(session, 'notice-message', null, topicB); notification.kind = 'removed';
    const repair = queuedInput(session, 'repair-message', null, topicB), attempt = repair.attempts.at(-1)!;
    repair.resolution_history = [{ op_id: '00000000-0000-4000-8000-000000000092', attempt_id: attempt.id, kind: 'request_result_repair', reason: '', at: session.updated_at, evidence: null }];
    session.inputs = Object.fromEntries([topic, nested, notification, repair].map(input => [input.id, input]));
    const value = await setup(session); render(<LiveBin actions={value.actions} topicId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 1' }));
    expect(screen.getByText(`Held — sends if you restore: ${topic.payload.text}`)).toBeTruthy();
    expect(screen.getByText(`Held — sends if you restore: ${nested.payload.text}`)).toBeTruthy();
    expect(screen.queryByText(`Held — sends if you restore: ${repair.payload.text}`)).toBeNull();
    expect(screen.queryByText(`Held — sends if you restore: ${notification.payload.text}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Restore work' }));
    expect(confirm.getByText('Restoring this work makes 1 held message visible again. It will send when sending can resume.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(value.transport.mutations).toHaveLength(1));
    expect(itemRemoved(value.store.getSnapshot().snapshot!.session, '8')).toBe(true);
  });

  it('rechecks held counts after the session changes while Restore confirmation is open', async () => {
    const session = removedSession(), input = queuedInput(session, 'first-message', '1'); session.inputs = { [input.id]: input };
    const value = await setup(session); render(<LiveBin actions={value.actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByRole('dialog', { name: 'Restore work' });
    const second = queuedInput(session, 'second-message', '1.2'); session.inputs[second.id] = second;
    ++session.revision; await act(async () => { await value.store.refresh(); });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restoring this work makes 2 held messages visible again. They will send when sending can resume.')).toBeTruthy();
    expect(value.transport.mutations).toEqual([]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(session.items['1']!.removed_at).toBeTruthy(); expect(value.transport.mutations).toEqual([]);
  });

  it('does not restore held messages without the UI confirmation callback', async () => {
    const session = removedSession(), input = queuedInput(session, 'held-message', '1'); session.inputs = { [input.id]: input };
    const value = await setup(session);
    expect(await restoreRemoved(value.actions, topicA, '1')).toBe('Restoring this work makes 1 held message visible again. View the bin to confirm Restore.');
    expect(value.transport.mutations).toEqual([]);
  });

  it('only labels owner messages cancelled by agent removal as cancelled bin messages', async () => {
    const session = removedSession(), removed = cancelledInput(session), other = structuredClone(removed), notification = structuredClone(removed);
    other.id = '00000000-0000-4000-8000-000000000097'; other.cancel_cause = 'owner';
    other.payload.text = 'I cancelled this message myself.';
    notification.id = '00000000-0000-4000-8000-000000000096'; notification.kind = 'removed';
    notification.payload.text = 'Automatic removal notice.';
    session.inputs = { [removed.id]: removed, [other.id]: other, [notification.id]: notification };
    const { actions } = await setup(session); render(<LiveBin actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    expect(screen.getByText(`Cancelled unsent message: ${removed.payload.text}`)).toBeTruthy();
    expect(screen.queryByText(`Cancelled unsent message: ${other.payload.text}`)).toBeNull();
    expect(screen.queryByText(`Cancelled unsent message: ${notification.payload.text}`)).toBeNull();
  });
  it('keeps earlier agent replies and handled owner words in the expanded read-only conversation', async () => {
    const session = removedSession(), handled = cancelledInput(session), cancelled = structuredClone(handled);
    handled.id = '00000000-0000-4000-8000-000000000096'; handled.state = 'handled';
    handled.payload.text = 'My earlier answer reached the agent.';
    cancelled.id = '00000000-0000-4000-8000-000000000097'; cancelled.state = 'cancelled';
    session.inputs = { [handled.id]: handled, [cancelled.id]: cancelled };
    const template = session.messages[0], number = Math.max(...session.messages.map(message => message.number));
    const owner = { ...structuredClone(template), id: '00000000-0000-4000-8000-000000000098', number: number + 1,
      author: 'owner' as const, kind: 'owner_input' as const, body: handled.payload.text, item_id: '1.1.1', topic_id: topicA,
      input_id: handled.id, round_id: null, items_touched: [] };
    handled.message_id = owner.id;
    const reply = { ...structuredClone(template), id: '00000000-0000-4000-8000-000000000099', number: number + 2,
      author: 'agent' as const, kind: 'reply' as const, body: 'I retained your answer and completed the earlier investigation.',
      item_id: '1.1.1', topic_id: topicA, input_id: handled.id, round_id: null, items_touched: [] };
    session.messages.push(owner, reply);
    const before = structuredClone(session), value = await setup(session); render(<LiveBin actions={value.actions} />);
    expect(screen.queryByText(reply.body)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    const bin = within(document.querySelector<HTMLElement>('[data-agent-bin]')!);
    expect(bin.getByRole('heading', { name: 'Conversation' })).toBeTruthy();
    expect(bin.getByText(owner.body)).toBeTruthy(); expect(bin.getByText(reply.body)).toBeTruthy();
    expect(bin.getAllByText('You').length).toBeGreaterThan(0); expect(bin.getAllByText('The agent').length).toBeGreaterThan(0);
    expect(bin.getByText(`Cancelled unsent message: ${cancelled.payload.text}`)).toBeTruthy();
    expect(bin.queryByRole('textbox')).toBeNull(); expect(bin.queryByRole('button', { name: /Send|Reply|Answer/ })).toBeNull();
    expect(session.messages).toEqual(before.messages); expect(session.inputs).toEqual(before.inputs);
  });

  it('starts folded, counts descendants once, preserves cancelled text and dispatches Delete forever to the existing removal path', async () => {
    const session = removedSession(), input = cancelledInput(session); session.inputs = { [input.id]: input };
    const { actions } = await setup(session), onRemove = vi.fn(); render(<LiveBin actions={actions} onRemove={onRemove} />);
    const fold = screen.getByRole('button', { name: 'Removed by agent · 4' });
    expect(fold.getAttribute('aria-expanded')).toBe('false'); expect(screen.queryByText(/Cancelled unsent message:/)).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByText('Old delivery plans · 4 items').className).toBe('agent-bin-name');
    expect(screen.getByText(`Cancelled unsent message: ${input.payload.text}`)).toBeTruthy();
    expect(screen.getByText('Which delivery window: morning or evening?')).toBeTruthy();
    expect(screen.getByText('Waiting on me')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith({ kind: 'item', item: { ...route, item_id: '1' } }));
  });

  it('counts removed topics at session level and keeps them out of a topic item bin', async () => {
    const value = await setup(), onRemove = vi.fn(); render(<LiveBin actions={value.actions} topicId={null} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 1' }));
    expect(screen.getByText(value.transport.source.topics[topicB]!.name)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith({ kind: 'topic', session: route, topic_id: topicB }));
    cleanup(); render(<LiveBin actions={value.actions} topicId={topicB} />);
    expect(screen.queryByRole('button', { name: /Removed by agent/ })).toBeNull();
  });

  it('opens the requested bin when View navigates before the bin mounts', async () => {
    const value = await setup(); act(() => { binView.reveal(route, topicA); });
    render(<LiveBin actions={value.actions} />);
    expect(screen.getByRole('button', { name: 'Removed by agent · 4' }).getAttribute('aria-expanded')).toBe('true');
    act(() => { binView.reveal({ ...route, session_id: 'another-session' }, topicB); });
  });

  it('scrolls the bin into view when it is asked for, folded or already open, and only then', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const value = await setup(); render(<LiveBin actions={value.actions} />);
    expect(scroll).not.toHaveBeenCalled();                       // mounting the bin does not move the Map
    act(() => { binView.reveal(route, topicA); });
    expect(screen.getByRole('button', { name: 'Removed by agent · 4' }).getAttribute('aria-expanded')).toBe('true');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole('button', { name: 'Removed by agent · 4' }).parentElement);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });  // nothing moves when it is already in view
    act(() => { binView.reveal(route, topicA); });
    expect(scroll).toHaveBeenCalledTimes(2);                     // asked again while open: scrolls again, stays open
    expect(screen.getByRole('button', { name: 'Removed by agent · 4' }).getAttribute('aria-expanded')).toBe('true');
    act(() => { binView.reveal(route, topicB); });
    expect(scroll).toHaveBeenCalledTimes(2);                     // another topic's bin is not this one
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('waits for a stale item refresh, then restores once against the fresh item revision', async () => {
    const value = await setup(); render(<LiveBin actions={value.actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    ++value.transport.source.items['1']!.revision; const revision = value.transport.source.items['1']!.revision;
    const release = await staleRefresh(value), restore = screen.getByRole('button', { name: 'Restore' });
    fireEvent.click(restore); fireEvent.click(restore);
    expect(value.transport.mutations).toEqual([]);
    await act(async () => { release(); });
    await waitFor(() => expect(value.transport.mutations).toHaveLength(1));
    expect(value.transport.mutations[0]!.command).toMatchObject({ command: 'item_restore', params: { item_id: '1', expected_revision: revision } });
    await screen.findByRole('button', { name: 'Removed by agent · 2' });
    const restored = value.store.getSnapshot().snapshot!.session;
    expect(itemRemoved(restored, '1')).toBe(false); expect(itemRemoved(restored, '1.2')).toBe(false);
    expect(restored.items['1.1']!.removed_at).toBeTruthy(); expect(itemRemoved(restored, '1.1.1')).toBe(true);
  });
  it('publishes immediate restore failure as a toast while keeping the bin available', async () => {
    const value = await setup(), invoke = value.transport.invoke.bind(value.transport);
    vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'item_restore') return { api_version: 1, ok: false,
        error: { code: 'invalid_argument', message: 'Restore was refused.', hint: '', retryable: false, field_errors: [] } };
      return invoke(name, args);
    });
    const view = render(<LiveBin actions={value.actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toEqual(['Something in that isn’t valid. Check it and try again.']));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toHaveProperty('disabled', false));
    act(() => notices.dismiss(notices.getSnapshot()[0]!.id));
    view.rerender(<LiveBin actions={value.actions} onRemove={vi.fn()} />);
    expect(notices.getSnapshot()).toEqual([]);
    render(<Notices />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Something in that isn’t valid. Check it and try again.')).toBeTruthy();
    view.unmount();
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByText('Something in that isn’t valid. Check it and try again.')).toBeNull();
  });
  it('keeps an unresolved restore error in the bin and locks further changes', async () => {
    const value = await setup(), invoke = value.transport.invoke.bind(value.transport);
    vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'item_restore') return { api_version: 1, ok: false,
        error: { code: 'not_found', message: 'Removed work disappeared.', hint: '', retryable: false, field_errors: [] } };
      return invoke(name, args);
    });
    render(<LiveBin actions={value.actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Ariadne can’t find that any more. It may have been removed.');
    expect(value.actions.getSnapshot().pending).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Restore' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Delete forever' })).toHaveProperty('disabled', true);
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('restores a topic using its fresh revision while leaving cancelled owner messages cancelled', async () => {
    const session = removedSession(), input = cancelledInput(session, '8'); session.inputs = { [input.id]: input };
    const value = await setup(session); render(<LiveBin actions={value.actions} topicId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 1' }));
    ++session.topics[topicB]!.revision; const revision = session.topics[topicB]!.revision, release = await staleRefresh(value);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' })); expect(value.transport.mutations).toEqual([]);
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Removed by agent/ })).toBeNull());
    expect(value.transport.mutations[0]!.command).toMatchObject({ command: 'topic_removed_restore', params: { topic_id: topicB, expected_revision: revision } });
    expect(session.inputs[input.id]!.state).toBe('cancelled'); expect(session.inputs[input.id]!.payload.text).toBe(input.payload.text);
  });

  it('waits through the shared session write barrier before capturing restore revisions', async () => {
    const value = await setup(), invoke = value.transport.invoke.bind(value.transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_label_set') await gate;
      return invoke(name, args);
    });
    const save = value.actions.execute({ command: 'session_label_set', api_version: 1, op_id: '', params: { name: 'Current name', description: null } }, value.transport.source.revision);
    expect(value.actions.getSnapshot().writing).toBe(true);
    const restore = restoreRemoved(value.actions, topicA, '1');
    expect(value.transport.mutations.filter(request => request.command.command === 'item_restore')).toEqual([]);
    ++value.transport.source.items['1']!.revision; const revision = value.transport.source.items['1']!.revision;
    release(); expect(await save).toBe(true); expect(await restore).toBeNull();
    expect(value.transport.mutations.find(request => request.command.command === 'item_restore')!.command)
      .toMatchObject({ params: { item_id: '1', expected_revision: revision } });
  });

  it.each(['ancestor', 'topic', 'restored'] as const)('refuses an item restore after its %s state has changed', async state => {
    const session = removedSession();
    if (state === 'topic') session.topics[topicA]!.removed_at = session.updated_at;
    if (state === 'restored') delete session.items['1']!.removed_at;
    const value = await setup(session), itemId = state === 'ancestor' ? '1.1' : '1';
    expect(await restoreRemoved(value.actions, topicA, itemId)).toBe('This work has already changed. View the bin and try again.');
    expect(value.transport.mutations).toEqual([]);
  });

  it('keeps Delete forever behind the ordinary app confirmation and preserves Undo before permanent removal', async () => {
    const session = removedSession(), input = cancelledInput(session); session.inputs = { [input.id]: input };
    const transport = new BinTransport(session); render(<DesktopApp service={createDesktopService(transport)} />);
    await goToSession(route); await screen.findByRole('tree', { name: 'Session items' });
    await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
        expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
      });
    fireEvent.click(screen.getByRole('button', { name: 'Removed by agent · 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByRole('button', { name: 'Remove 4 items' })).toBeTruthy();
    expect(confirm.getByText('1 question waiting on you goes with it. Your 1 cancelled message is deleted forever.')).toBeTruthy();
    expect(transport.mutations.filter(request => request.command.command === 'item_remove')).toEqual([]);
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove 4 items' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'item_remove')).toHaveLength(1));
    expect(transport.mutations.find(request => request.command.command === 'item_remove') as OwnerMutationRequest)
      .toMatchObject({ session: route, command: { command: 'item_remove', params: { item_id: '1' } } });
    expect(transport.source.items['1']).toBeUndefined(); expect(transport.source.items['1.1.1']).toBeUndefined();
  });

  it('warns about binned waiting questions and cancelled owner words before permanently deleting a topic', async () => {
    const session = removedSession(), input = cancelledInput(session, '8'); session.inputs = { [input.id]: input };
    session.items['8']!.status = 'waiting_on_me';
    const transport = new BinTransport(session); await openApp(transport);
    const bin = within(document.querySelector<HTMLElement>('[data-agent-bin="topics"]')!);
    fireEvent.click(bin.getByRole('button', { name: 'Removed by agent · 1' }));
    fireEvent.click(bin.getByRole('button', { name: 'Delete forever' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('1 question waiting on you goes with it. Your 1 cancelled message is deleted forever.')).toBeTruthy();
    expect(confirm.getByRole('button', { name: 'Remove topic' })).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(transport.mutations.filter(request => request.command.command === 'topic_remove')).toEqual([]);
  });

  it('keeps work restored from the bin while Delete forever is waiting for Undo', async () => {
    const session = receiptSession(), transport = new BinTransport(session); await openApp(transport);
    const removal = within((await screen.findByText(removalNotice(session, notice()))).closest<HTMLElement>('.pw-note')!);
    const bin = within(document.querySelector<HTMLElement>(`[data-agent-bin="${topicA}"]`)!);
    fireEvent.click(bin.getByRole('button', { name: 'Removed by agent · 4' }));
    fireEvent.click(bin.getByRole('button', { name: 'Delete forever' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove 4 items' }));
    await screen.findByRole('button', { name: 'Undo' });
    const restore = removal.getByRole('button', { name: 'Restore' });
    await waitFor(() => expect(restore.hasAttribute('disabled')).toBe(false));
    fireEvent.click(restore);
    await waitFor(() => expect(transport.source.items['1']!.removed_at).toBeUndefined());
    await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
        expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
      });
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
    await screen.findByRole('button', { name: 'Removed by agent · 2' });
    expect(transport.mutations.filter(request => request.command.command === 'item_remove')).toEqual([]);
    expect(transport.source.items['1']).toBeDefined(); expect(transport.source.items['1']!.removed_at).toBeUndefined();
    expect(transport.source.items['1.1']!.removed_at).toBeTruthy();
  });
});

describe('agent removal receipts in the composed app', () => {
  it('confirms held messages from notice Restore and preserves the notice when confirmation is cancelled', async () => {
    const session = receiptSession(), input = queuedInput(session, 'notice-held-message', '1'); session.inputs = { [input.id]: input };
    const transport = new BinTransport(session), text = removalNotice(session, notice()); await openApp(transport);
    const removal = within((await screen.findByText(text)).closest<HTMLElement>('.pw-note')!);
    fireEvent.click(removal.getByRole('button', { name: 'Restore' }));
    const confirm = within(await screen.findByRole('dialog', { name: 'Restore work' }));
    expect(confirm.getByText('Restoring this work makes 1 held message visible again. It will send when sending can resume.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(text)).toBeTruthy(); expect(transport.mutations.filter(request => request.command.command === 'item_restore')).toEqual([]);
    fireEvent.click(removal.getByRole('button', { name: 'Restore' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Restore work' })).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(transport.mutations.filter(request => request.command.command === 'item_restore')).toHaveLength(1);
  });

  it('keeps the live empty-topic connection frame and reveals an empty removed topic in the session bin', async () => {
    const session = graphSession(); session.items = {}; session.inputs = {}; session.rounds = {}; session.answers = []; session.messages = [];
    session.topics = { [topicA]: session.topics[topicA]! }; session.topics[topicA]!.origin = null;
    const transport = new BinTransport(session); await openApp(transport);
    expect(await screen.findByText('No items yet')).toBeTruthy();
    expect(screen.getByText(/waiting for the agent’s first message|items appear when it writes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Removed by agent/ })).toBeNull();
    session.topics[topicA]!.removed_at = session.updated_at; ++session.topics[topicA]!.revision;
    await refreshApp(transport);
    const fold = await screen.findByRole('button', { name: 'Removed by agent · 1' });
    expect(screen.queryByText('No items yet')).toBeNull();
    expect(fold.getAttribute('aria-expanded')).toBe('false'); fireEvent.click(fold);
    const bin = within(fold.closest<HTMLElement>('[data-agent-bin]')!);
    expect(bin.getByText(session.topics[topicA]!.name)).toBeTruthy();
    expect(bin.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(bin.getByRole('button', { name: 'Delete forever' })).toBeTruthy();
  });

  it('resumes the filtered tree rows and preserved search after an outside reveal', async () => {
    const session = graphSession(); session.items['1.1']!.question = 'Matching child'; session.items['1.2']!.question = 'Other child';
    // The status filter leaves the in-progress 1.2 out; the search only marks "Matching child" (it filters nothing).
    const transport = new BinTransport(session), filters = transport.preferences.sessions[0]!.filters;
    filters.search = 'Matching'; filters.statuses = ['open'];
    await openApp(transport);
    const tree = () => screen.getByRole('tree', { name: 'Session items' });
    const rows = () => [...tree().querySelectorAll<HTMLElement>('[role="treeitem"][data-item-id]')].map(row => row.dataset.itemId);
    await waitFor(() => expect(rows()).toEqual(['1', '1.1', '2', '8']));
    expect(tree().querySelector('[data-item-id="1.1"] .tree-hit')?.textContent).toBe('Matching');
    await waitFor(() => expect(transport.listeners.get('ariadne://route')?.size).toBe(1));
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '1.2' }); });
    const detail = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.2"]' });
    expect(within(detail).getByRole('heading', { name: 'Other child' })).toBeTruthy();
    await waitFor(() => expect(rows()).toEqual(['1', '1.1', '1.2', '2', '8']));
    fireEvent.click(screen.getByRole('button', { name: 'Resume filtered view' }));
    await waitFor(() => expect(rows()).toEqual(['1', '1.1', '2', '8']));
    expect(screen.queryByRole('button', { name: 'Resume filtered view' })).toBeNull();
    expect(searchValue()).toBe('Matching');
  });

  it('shows the current marked receipt once, deduplicates refreshes and respects owner dismissal', async () => {
    const session = receiptSession(), text = removalNotice(session, notice()), transport = new BinTransport(session);
    const push = vi.spyOn(notices, 'push'); await openApp(transport);
    expect(await screen.findByText(text)).toBeTruthy();
    await refreshApp(transport); await refreshApp(transport);
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(push.mock.calls.filter(([entry]) => entry.id === `${session.id}:${notice().message_id}`)).toHaveLength(1);
    fireEvent.click(within(screen.getByText(text).closest<HTMLElement>('.pw-note')!).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(text)).toBeNull(); await refreshApp(transport);
    expect(screen.queryByText(text)).toBeNull();
  });

  it('dismisses the current receipt when an external restore removes its marker while historical receipts remain', async () => {
    const session = receiptSession(), text = removalNotice(session, notice()), transport = new BinTransport(session);
    await openApp(transport); await screen.findByText(text);
    delete session.items['1']!.removed_at; delete session.items['1']!.removed_by;
    await refreshApp(transport);
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(Object.values(session.operation_receipts)[0]![0].result.data.kind).toBe('apply');
  });

  it.each(['restored', 'deleted', 'different removal'] as const)('does not replay a historical notice after work is %s', async state => {
    const session = receiptSession(), text = removalNotice(session, notice());
    if (state === 'restored') { delete session.items['1']!.removed_at; delete session.items['1']!.removed_by; }
    if (state === 'deleted') for (const item of removedSubtree(session, '1')) delete session.items[item.id];
    if (state === 'different removal') session.items['1']!.removed_by!.message_id = '00000000-0000-4000-8000-000000000094';
    const transport = new BinTransport(session), push = vi.spyOn(notices, 'push'); await openApp(transport);
    expect(screen.queryByText(text)).toBeNull();
    expect(push.mock.calls.filter(([entry]) => entry.id === `${session.id}:${notice().message_id}`)).toEqual([]);
  });

  it('opens View from a searched and filtered graph as a visible expanded tree bin', async () => {
    const session = receiptSession(), transport = new BinTransport(session);
    transport.preferences.sessions[0]!.filters = { ...transport.preferences.sessions[0]!.filters,
      search: 'a question that does not match', statuses: ['open'], owners: [{ kind: 'me' }], topic_id: topicB, hide_later: true };
    await openApp(transport);
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'Graph' }));
    await waitFor(() => expect(document.querySelector('.graph-view')).not.toBeNull());
    const text = removalNotice(session, notice()), receipt = within((await screen.findByText(text)).closest<HTMLElement>('.pw-note')!);
    fireEvent.click(receipt.getByRole('button', { name: 'View' }));
    const fold = await screen.findByRole('button', { name: 'Removed by agent · 4' });
    await waitFor(() => expect(fold.getAttribute('aria-expanded')).toBe('true'));
    expect(document.querySelector('.graph-view')).toBeNull();
    expect(searchValue()).toBe('');
    expect(transport.preferences.sessions.find(view => view.session.session_id === session.id)!.filters)
      .toEqual({ search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false });
    expect(screen.getByText('Old delivery plans · 4 items')).toBeTruthy();
  });

  it.each([false, true])('retains a delayed View continuation unless superseded (superseded: %s)', async superseded => {
    const session = receiptSession(), transport = new BinTransport(session);
    transport.preferences.sessions[0]!.filters.search = 'a question that does not match';
    await openApp(transport);
    const receipt = within((await screen.findByText(removalNotice(session, notice()))).closest<HTMLElement>('.pw-note')!);
    const theme = within(document.querySelector<HTMLElement>('.tb')!).getByRole<HTMLButtonElement>('button', { name: 'Switch to light' });
    await waitFor(() => expect(theme.disabled).toBe(false));
    let release!: () => void, writing = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
        writing = true; await held;
      }
      return invoke(name, args);
    });
    try {
      fireEvent.click(theme);
      await waitFor(() => expect(writing).toBe(true));
      vi.useFakeTimers();
      fireEvent.click(receipt.getByRole('button', { name: 'View' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(screen.getByText('Opening the session…')).toBeTruthy();
      expect(transport.preferences.sessions[0].filters.search).toBe('a question that does not match');
      if (superseded) {
        // Projects is a page link in the switcher: it shows at once and cancels the queued handoff (pages are not saved).
        fireEvent.click(document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]')!);
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch session or project' })).getByRole('button', { name: 'Projects' }));
      }
      vi.useRealTimers();
      await act(async () => { release(); });
      if (superseded) {
        await screen.findByRole('heading', { name: 'Projects', level: 1 });
        await waitFor(() => expect(screen.queryByText('Opening the session…')).toBeNull());
        expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
        expect(transport.preferences.sessions[0].filters.search).toBe('a question that does not match');
        expect(screen.queryByText('Old delivery plans · 4 items')).toBeNull();
      } else {
        const fold = await screen.findByRole('button', { name: 'Removed by agent · 4' });
        await waitFor(() => expect(fold.getAttribute('aria-expanded')).toBe('true'));
        expect(transport.preferences.sessions[0].filters.search).toBe('');
        expect(screen.getByText('Old delivery plans · 4 items')).toBeTruthy();
      }
    } finally { vi.useRealTimers(); await act(async () => { release(); }); }
  });

  it('reports the specific project-folder failure when removal View cannot open its session', async () => {
    const session = receiptSession(), transport = new BinTransport(session);
    await openApp(transport);
    const receipt = within((await screen.findByText(removalNotice(session, notice()))).closest<HTMLElement>('.pw-note')!);
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') return { api_version: 1, ok: false,
        error: { code: 'io_error', message: 'Folder missing', hint: '', retryable: false, field_errors: [] } };
      return invoke(name, args);
    });
    fireEvent.click(receipt.getByRole('button', { name: 'View' }));
    const message = 'This session could not be opened. Check that its project folder is available, then try again.';
    await screen.findByText(message);
    expect(screen.queryByText(/Opening the session/)).toBeNull();
    expect(screen.queryByText(/couldn’t read or save/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
  });

  it('opens the removal bin without an error notice after a failed queued navigation retries and confirms', async () => {
    const session = receiptSession(), transport = new BinTransport(session);
    transport.preferences.sessions[0]!.filters.search = 'a question that does not match';
    await openApp(transport);
    const receipt = within((await screen.findByText(removalNotice(session, notice()))).closest<HTMLElement>('.pw-note')!);
    const navigations = vi.spyOn(NavigationStore.prototype, 'navigate');
    let releaseCapture!: () => void, releaseSave!: () => void, capturing = false, writing = false, captures = 0;
    const heldCapture = new Promise<void>(resolve => { releaseCapture = resolve; });
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if (name === 'session_get' && ++captures === 1) {
        capturing = true; await heldCapture;
        return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Folder temporarily unavailable', hint: '', retryable: true, field_errors: [] } };
      }
      if ('command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
        writing = true; await heldSave;
      }
      return invoke(name, args);
    });
    let save!: Promise<boolean>;
    try {
      fireEvent.click(receipt.getByRole('button', { name: 'View' }));
      await waitFor(() => expect(capturing).toBe(true));
      const navigation = navigations.mock.contexts.at(-1) as NavigationStore;
      expect(navigation).toBeInstanceOf(NavigationStore);
      const request = navigation.getNavigationRequest();
      await act(async () => { save = navigation.saveTheme('light', navigation.getSnapshot().preferences!.revision); });
      await waitFor(() => expect(writing).toBe(true));
      await act(async () => { releaseCapture(); });
      expect(navigation.getSnapshot().pendingNavigation).not.toBeNull();
      expect(screen.queryByText(/The bin could not be opened|This session could not be opened/)).toBeNull();
      expect(transport.preferences.sessions[0]!.filters.search).toBe('a question that does not match');
      await act(async () => { releaseSave(); await save; });
      const fold = await screen.findByRole('button', { name: 'Removed by agent · 4' });
      await waitFor(() => expect(fold.getAttribute('aria-expanded')).toBe('true'));
      expect(captures).toBeGreaterThan(1);
      expect(navigation.getNavigationRequest()).toBe(request);
      expect(transport.preferences.sessions[0]!.filters.search).toBe('');
      expect(screen.getByText('Old delivery plans · 4 items')).toBeTruthy();
      expect(screen.queryByText(/The bin could not be opened|This session could not be opened/)).toBeNull();
    } finally { await act(async () => { releaseCapture(); releaseSave(); }); }
  });

  it('uses the live archived topic state when View opens a notice created before that topic was archived', async () => {
    const session = receiptSession(), transport = new BinTransport(session); await openApp(transport);
    const text = removalNotice(session, notice()); await screen.findByText(text);
    session.topics[topicA]!.archived_at = session.updated_at; ++session.topics[topicA]!.revision;
    await refreshApp(transport);
    fireEvent.click(within(screen.getByText(text).closest<HTMLElement>('.pw-note')!).getByRole('button', { name: 'View' }));
    const fold = await screen.findByRole('button', { name: 'Removed by agent · 4' });
    await waitFor(() => expect(fold.getAttribute('aria-expanded')).toBe('true'));
    expect(transport.preferences.sessions.find(view => view.session.session_id === session.id)!.filters.archived).toBe(true);
    expect(screen.getByText('Old delivery plans · 4 items')).toBeTruthy();
    // Removing the archived topic for good is asked from its row on the Archive page (SPEC §5.14: one Archive page for sessions and topics), not from the Map.
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]')!);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Switch session or project' })).getByRole('button', { name: 'Archive' }));
    const archivedRow = (await screen.findAllByText(session.topics[topicA]!.name)).map(name => name.closest<HTMLElement>('.ar-row')).find(Boolean)!;
    fireEvent.click(within(archivedRow).getByRole('button', { name: /^More for / }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from Ariadne/ }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText(/The topic and its 6 items are removed from Ariadne/)).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
  });

  it('opens the session topic bin from an older item notice after the whole topic is later removed', async () => {
    const session = receiptSession(), transport = new BinTransport(session), text = removalNotice(session, notice());
    await openApp(transport); await screen.findByText(text);
    const topicRemoval = notice({ item_id: null, message_id: '00000000-0000-4000-8000-000000000093',
      item_ids: ['1', '1.1', '1.1.1', '1.2', '2', '3'], waiting_questions: 1, cancelled_input_ids: [] });
    session.topics[topicA]!.removed_at = session.updated_at;
    session.topics[topicA]!.removed_by = { binding_id: session.active_binding_id!, message_id: topicRemoval.message_id };
    const operationId = '00000000-0000-4000-8000-000000000092';
    const receipt = structuredClone(Object.values(session.operation_receipts)[0]![0]);
    receipt.operation_id = operationId; receipt.result.operation_id = operationId;
    if (receipt.result.data.kind !== 'apply') throw new Error('Expected removal apply receipt');
    receipt.result.data.agent_removals = [topicRemoval]; session.operation_receipts[operationId] = [receipt];
    await refreshApp(transport); await screen.findByText(removalNotice(session, topicRemoval));
    fireEvent.click(within(screen.getByText(text).closest<HTMLElement>('.pw-note')!).getByRole('button', { name: 'View' }));
    const fold = await screen.findByRole('button', { name: 'Removed by agent · 2' });
    await waitFor(() => expect(fold.getAttribute('aria-expanded')).toBe('true'));
    expect(fold.closest<HTMLElement>('[data-agent-bin]')!.dataset.agentBin).toBe('topics');
    expect(screen.getByText(`${session.topics[topicA]!.name} · 6 items`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Removed by agent · 4' })).toBeNull();
  });

  it('reports a refused View filter save and preserves the current filters without opening an invisible bin', async () => {
    const session = receiptSession(), transport = new BinTransport(session);
    transport.preferences.sessions[0]!.filters.search = 'keep the current search';
    await openApp(transport);
    const invoke = transport.invoke.bind(transport), text = removalNotice(session, notice());
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.filters.search === '')) {
        return { api_version: 1, ok: false, error: { code: 'invalid_argument', message: 'The filter save was refused.', hint: '', retryable: false, field_errors: [] } };
      }
      return invoke(name, args);
    });
    fireEvent.click(within((await screen.findByText(text)).closest<HTMLElement>('.pw-note')!).getByRole('button', { name: 'View' }));
    expect(await screen.findByText('The bin could not be opened. Try View again.')).toBeTruthy();
    expect(transport.preferences.sessions.find(view => view.session.session_id === session.id)!.filters.search).toBe('keep the current search');
    // A search hides no row, so the bin's fold stays in the Map (SPEC §4); the refused View leaves it folded.
    expect(screen.getByRole('button', { name: 'Removed by agent · 4' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('permanent removal scope with only binned work', () => {
  async function onlyBinApp() {
    const session = removedSession(); session.inputs = {};
    for (const topic of Object.values(session.topics)) if (topic) { topic.removed_at = session.updated_at; topic.origin = null; }
    const transport = new BinTransport(session);
    for (const id of transport.sessions.keys()) if (id !== session.id) transport.sessions.delete(id);
    await openApp(transport);
    expect(activeItems(session)).toEqual([]); expect(activeTopics(session)).toEqual([]);
    return { transport, session };
  }
  /** A page from the switcher's footer (pages are views the owner opens from the top bar). */
  async function page(name: 'Projects' | 'All sessions' | 'Archive') {
    const trigger = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]');
      expect(button).not.toBeNull(); expect(button!.disabled).toBe(false); return button!;
    });
    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Switch session or project' })).getByRole('button', { name }));
    await screen.findByRole('heading', { name, level: 1 });
  }

  it('warns that permanent session removal includes all binned topics and items', async () => {
    const { transport } = await onlyBinApp();
    // A session is removed for good from the Archive page, so archive it first from All sessions.
    await page('All sessions');
    const archive = await waitFor(() => {
      const button = screen.getByRole<HTMLButtonElement>('button', { name: /^Archive / });
      expect(button.disabled).toBe(false); return button;
    });
    await act(async () => { fireEvent.click(archive); });
    const archiving = screen.queryByRole('dialog');
    if (archiving) await act(async () => { fireEvent.click(within(archiving).getByRole('button', { name: 'Archive session' })); });
    await waitFor(() => expect(transport.sessions.get(route.session_id)!.archived_at).toBeTruthy());
    await page('Archive');
    const archived = await waitFor(() => { const row = document.querySelector<HTMLElement>('.ar-row'); expect(row).not.toBeNull(); return row!; });
    fireEvent.click(within(archived).getByRole('button', { name: /^More for / }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from Ariadne/ }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText(/and the 2 topics only it has \(7 items\)/)).toBeTruthy();
    expect(confirm.getByRole('button', { name: 'Remove session' })).toBeTruthy();
    expect(transport.mutations.some(request => request.command.command === 'session_remove')).toBe(false);
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(transport.source.items['1']).toBeTruthy();
  });

  it('warns that permanent project removal includes its sessions and their Maps, even with only binned work', async () => {
    const { transport } = await onlyBinApp();
    await page('Projects');
    fireEvent.click(await screen.findByRole('button', { name: /^More for .*: remove project$/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove project/ }));
    const confirm = within(await screen.findByRole('dialog', { name: /^Remove “.*” from Ariadne\?$/ }));
    // The dialog names the sessions it forgets and their Maps (SPEC 14.x); it no longer counts topics and items.
    expect(confirm.getByText(/forgets its 1 session and their Maps/)).toBeTruthy();
    expect(confirm.getByRole('button', { name: 'Remove project' })).toBeTruthy();
    expect(transport.mutations.some(request => request.command.command === 'project_remove')).toBe(false);
    fireEvent.click(confirm.getByRole('button', { name: /^Cancel/ }));
    expect(transport.source.topics[topicA]).toBeTruthy(); expect(transport.source.items['8']).toBeTruthy();
  });
});
