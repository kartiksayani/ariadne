import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MutationEnvelope } from '../../../src/generated/core';
import { createDesktopService, CoreFailure } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { HistoryActions } from '../../../src/components/history-actions/HistoryActions';
import { ContinueDialog } from '../../../src/components/history-actions/ContinueDialog';
import { CopiedProvenance } from '../../../src/components/history-actions/CopiedProvenance';
import { dispatchQuiesced, lifecycleBlockers } from '../../../src/components/history-actions/selectors';
import { route, secondId } from '../app/transport';
import { HistoryTransport } from './fixture';

const op = '00000000-0000-4000-8000-000000000099';
const targetRoute = { ...route, session_id: secondId };
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); });
function failure(code: CoreFailure['error']['code']): MutationEnvelope {
  return { api_version: 1, ok: false, error: { code, message: `Rejected ${code}`, hint: 'Review current data.', retryable: false, field_errors: [] } };
}
async function setup(terminal = false) {
  const transport = new HistoryTransport();
  if (terminal) {
    Object.values(transport.source.items).forEach(item => { if (item) { item.status = 'done'; item.waiting_since = null; } });
    transport.source.inputs = {};
  }
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route), targetStore = sessions.open(targetRoute); await store.refresh(); await targetStore.refresh();
  const controllers = new SessionActionControllers(service, () => op), actions = controllers.forSession(store), targetActions = controllers.forSession(targetStore);
  const topic = Object.values(transport.source.topics)[0]!;
  const reveal: unknown[] = [];
  const props = { actions, targets: [{ route: targetRoute, label: 'Target session' }], actionsForTarget: () => targetActions,
    revealItem: (value: unknown) => { reveal.push(value); }, openSession: (value: unknown) => { reveal.push(value); } };
  return { transport, service, sessions, store, actions, targetActions, topic, reveal, props };
}
const dialog = () => within(screen.getByRole('dialog'));

describe('guarded history controls', () => {
  it('shows navigable active-item and pending-input blockers without archiving', async () => {
    const { props, topic, reveal, transport } = await setup(); render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` }));
    expect((dialog().getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(true);
    const blocker = dialog().getAllByRole('button').find(button => button.textContent?.startsWith('Item '))!;
    fireEvent.click(blocker); expect(reveal).toHaveLength(1); expect(transport.mutations).toHaveLength(0);
  });
  it('routes a generic-input blocker to its session and combines authoritative IDs', async () => {
    const { transport, topic } = await setup(true), input = structuredClone(new HistoryTransport().source.inputs);
    transport.source.inputs = input;
    const row = Object.values(input)[0]!; row.target.item_id = null; row.target.topic_id = topic.id; row.state = 'queued';
    const error = { ...new CoreFailure({ code: 'topic_not_archivable', message: '', hint: '', retryable: false, field_errors: [], details: {
      reason: null, binding_id: null, input_id: null, attempt_id: null, blocking_item_ids: ['999'], blocking_input_ids: [], dispatch_must_pause: false,
    } }).error };
    const blockers = lifecycleBlockers(transport.source, topic.id, error);
    expect(blockers.find(value => value.key === `input:${row.id}`)?.item).toBeNull();
    expect(blockers.find(value => value.key === 'item:999')?.item?.item_id).toBe('999');
  });
  it('confirms Pause first, persists it, then requires a separate Close confirmation', async () => {
    const { props, transport } = await setup(true); render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Pause dispatch' }));
    expect(transport.mutations).toHaveLength(0);
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm Pause dispatch' })); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['binding_pause']);
    expect(transport.source.state).toBe('active');
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm session close' })); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['binding_pause', 'session_close']);
    expect(transport.source.state).toBe('closed');
  });
  it('offers Confirm Close directly when the active binding is disconnected', async () => {
    const { props, transport } = await setup(true);
    const binding = transport.source.bindings[transport.source.active_binding_id!]!;
    binding.dispatch_state = 'disconnected'; binding.connection_state = 'disconnected'; binding.owner_paused = true;
    ++transport.source.revision;
    await props.actions.session.refresh(); render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(dialog().queryByRole('button', { name: 'Pause dispatch' })).toBeNull();
    expect(dialog().getByText('Dispatch is already stopped (binding not connected). Confirm Close.')).toBeTruthy();
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm session close' })); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['session_close']);
    expect(transport.source.state).toBe('closed');
  });
  it('pins the dispatch-quiesced truth table shared with Binding::dispatch_quiesced', () => {
    const make = (dispatch_state: string, connection_state: string) => ({ dispatch_state, connection_state }) as never;
    expect(dispatchQuiesced(null)).toBe(true);
    expect(dispatchQuiesced(make('paused', 'connected'))).toBe(true);
    expect(dispatchQuiesced(make('disconnected', 'disconnected'))).toBe(true);
    expect(dispatchQuiesced(make('recovery_required', 'unknown'))).toBe(true);
    expect(dispatchQuiesced(make('enabled', 'reconnecting'))).toBe(true);
    expect(dispatchQuiesced(make('enabled', 'connected'))).toBe(false);
    expect(dispatchQuiesced(make('recovery_required', 'connected'))).toBe(false);
  });
  it('archives/restores and closes/reopens with retained IDs, history and paused binding', async () => {
    const { props, topic, transport } = await setup(true), items = structuredClone(transport.source.items), messages = structuredClone(transport.source.messages);
    const binding = transport.source.bindings[transport.source.active_binding_id!]!; binding.dispatch_state = 'paused'; binding.owner_paused = true;
    await props.actions.session.refresh(); render(<HistoryActions {...props} />);
    for (const [button, confirm] of [[`Archive ${topic.name}`, 'topic archive'], [`Restore ${topic.name}`, 'topic restore'], ['Close session', 'session close'], ['Reopen session', 'session reopen']]) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await act(async () => { fireEvent.click(dialog().getByRole('button', { name: `Confirm ${confirm}` })); });
    }
    expect(transport.source.items).toEqual(items); expect(transport.source.messages).toEqual(messages);
    expect(binding.dispatch_state).toBe('paused'); expect(transport.source.state).toBe('active');
  });
  it('requires revised review after a session change and keeps uncertain requests after unmount', async () => {
    const { props, topic, transport, store, actions } = await setup(true); const view = render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` }));
    ++transport.source.revision; await act(async () => { await store.refresh(); });
    expect((dialog().getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog().getByRole('button', { name: 'Review current state' })); transport.replies.push(new Error('Lost acknowledgement'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm topic archive' })); });
    const request = structuredClone(transport.mutations[0]); view.unmount(); render(<HistoryActions {...props} />);
    expect(actions.getSnapshot().pending).toEqual(request); expect(transport.mutations).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request]);
  });
  it('recomputes blockers after deliberately reviewing resolved canonical state', async () => {
    const { props, topic, transport, store, actions } = await setup(true); render(<HistoryActions {...props} />);
    const item = Object.values(transport.source.items).find(item => item?.topic_id === topic.id)!;
    const rejected = failure('topic_not_archivable');
    if (rejected.ok) throw new Error('test rejection');
    rejected.error.details = { reason: null, binding_id: null, input_id: null, attempt_id: null,
      blocking_item_ids: [item.id], blocking_input_ids: [], dispatch_must_pause: false };
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` }));
    item.status = 'open'; ++transport.source.revision;
    transport.replies.push(rejected);
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm topic archive' })); });
    expect(dialog().getByRole('button', { name: `Item ${item.id} · ${item.question}` })).toBeDefined();
    expect((dialog().getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(true);
    expect(actions.getSnapshot().pending).toBeNull();
    const previousError = actions.getSnapshot().error;
    item.status = 'done'; ++transport.source.revision; await act(async () => { await store.refresh(); });
    fireEvent.click(dialog().getByRole('button', { name: 'Review current state' }));
    expect(dialog().queryByRole('button', { name: `Item ${item.id} · ${item.question}` })).toBeNull();
    expect(dialog().queryByText('Rejected topic_not_archivable')).toBeNull();
    expect(actions.getSnapshot().error).toBe(previousError);
    expect((dialog().getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm topic archive' })); });
    expect(topic.archived_at).not.toBeNull(); expect(transport.mutations).toHaveLength(2);
  });
  it.each(['same topic', 'different topic'])('does not reuse a rejected review when opening %s', async selection => {
    const { props, topic, transport, actions } = await setup(true);
    const other = { ...structuredClone(topic), id: op, name: 'Another terminal topic', order: topic.order + 1 };
    transport.source.topics[other.id] = other; ++transport.source.revision; await props.actions.session.refresh();
    render(<HistoryActions {...props} />);
    const rejected = failure('topic_not_archivable');
    if (rejected.ok) throw new Error('test rejection');
    rejected.error.details = { reason: null, binding_id: null, input_id: null, attempt_id: null,
      blocking_item_ids: ['999'], blocking_input_ids: [], dispatch_must_pause: false };
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` })); transport.replies.push(rejected);
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm topic archive' })); });
    expect(dialog().getByRole('button', { name: 'Item 999 · Active item' })).toBeDefined();
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    const chosen = selection === 'same topic' ? topic : other;
    fireEvent.click(screen.getByRole('button', { name: `Archive ${chosen.name}` }));
    expect(actions.getSnapshot().error).toBeInstanceOf(CoreFailure); expect(actions.getSnapshot().pending).toBeNull();
    expect(dialog().queryByRole('button', { name: 'Item 999 · Active item' })).toBeNull();
    expect(dialog().queryByText('Rejected topic_not_archivable')).toBeNull();
    expect((dialog().getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm topic archive' })); });
    expect(transport.mutations[1].command).toMatchObject({ command: 'topic_archive', params: { topic_id: chosen.id } });
  });
});

describe('explicit Continue preview and request identity', () => {
  async function previewSetup() {
    const data = await setup(); render(<ContinueDialog {...data.props} topicId={data.topic.id} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target session' }));
    await waitFor(() => expect(screen.getByText('Approved handoff summary')).toBeDefined());
    return data;
  }
  it('shows qualified source/target, grouped items, provenance and queued host-unavailable readiness before Send', async () => {
    const { transport, topic } = await previewSetup();
    expect(screen.getByText(/Host unavailable. Handoff will be saved as queued/)).toBeDefined();
    expect(screen.getByRole('region', { name: 'Waiting items' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Open items' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Terminal items' })).toBeDefined();
    expect(transport.mutations).toHaveLength(0);
    expect(transport.queries.filter(query => query.request.command === 'topic_continue_preview')).toMatchObject([{ session: null }]);
    const source = structuredClone(transport.source);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Target session' })); });
    expect(transport.mutations).toHaveLength(1);
    expect(transport.mutations[0]).toMatchObject({ session: targetRoute, command: { command: 'topic_continue', params: {
      source: route, source_topic_id: topic.id, source_revision: source.revision, source_sha256: 'a'.repeat(64), target: targetRoute,
      summary: 'Approved full snapshot. Keep copied source provenance.',
    } } });
    expect(transport.source).toEqual(source);
  });
  it('blocks changed preview, refreshes deliberately and freezes uncertain Send across source change', async () => {
    const { transport, store, targetActions } = await previewSetup(); ++transport.source.revision;
    await act(async () => { await store.refresh(); });
    expect((screen.getByRole('button', { name: 'Send to Target session' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare new preview' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send to Target session' }) as HTMLButtonElement).disabled).toBe(false));
    transport.replies.push(new Error('Lost acknowledgement'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Target session' })); });
    const request = structuredClone(transport.mutations[0]); ++transport.source.revision;
    await act(async () => { await store.refresh(); });
    expect(screen.queryByRole('button', { name: 'Prepare new preview' })).toBeNull();
    expect(targetActions.getSnapshot().pending).toEqual(request);
    transport.replies.push(failure('preview_stale'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request]); expect(targetActions.getSnapshot().pending).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare new preview' })).toBeDefined();
  });
  it('disables Send for an unknown target binding', async () => {
    const data = await setup(); data.transport.blocked = true;
    render(<ContinueDialog {...data.props} topicId={data.topic.id} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target session' }));
    await waitFor(() => expect(screen.getByText(/Target unavailable: binding unknown/)).toBeDefined());
    expect((screen.getByRole('button', { name: 'Send to Target session' }) as HTMLButtonElement).disabled).toBe(true);
    expect(data.transport.mutations).toHaveLength(0);
  });
  it.each(['preview_stale', 'queue_full', 'invalid_transition', 'incompatible_adapter', 'binding_mismatch', 'not_found', 'invalid_argument', 'capacity_exceeded', 'io_error', 'commit_uncertain'] as const)('clears only replay-first Continue guard %s', async code => {
    const { transport, targetActions } = await previewSetup(); transport.replies.push(failure(code));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Target session' })); });
    expect(targetActions.getSnapshot().pending === null).toBe(['preview_stale', 'queue_full', 'invalid_transition', 'incompatible_adapter'].includes(code));
  });
});

describe('saved receipts and copied provenance', () => {
  it.each(['revision_conflict', 'invalid_transition', 'topic_not_archivable', 'session_not_closable', 'not_found', 'invalid_argument', 'io_error', 'commit_uncertain'] as const)('retains uncertainty except replay-first lifecycle guard %s', async code => {
    const { transport, actions, topic } = await setup(true); transport.replies.push(failure(code));
    await actions.execute({ command: 'topic_archive', api_version: 1, op_id: '', params: { topic_id: topic.id, expected_revision: topic.revision } }, transport.source.revision);
    expect(actions.getSnapshot().pending === null).toBe(['revision_conflict', 'invalid_transition', 'topic_not_archivable', 'session_not_closable'].includes(code));
  });
  it.each(['topic', 'revision', 'archive_time'] as const)('rejects mismatched archive receipt %s without discarding frozen action', async field => {
    const { transport, actions, topic } = await setup(true);
    const data = { kind: 'topic_lifecycle' as const, topic_id: topic.id, topic_revision: topic.revision + 1, archived_at: transport.source.updated_at };
    if (field === 'topic') data.topic_id = op;
    if (field === 'revision') ++data.topic_revision;
    if (field === 'archive_time') data.archived_at = 'invalid-time';
    transport.replies.push({ api_version: 1, ok: true, data: { operation_id: op, session_id: transport.source.id, revision: transport.source.revision + 1, data } });
    expect(await actions.execute({ command: 'topic_archive', api_version: 1, op_id: '', params: { topic_id: topic.id, expected_revision: topic.revision } }, transport.source.revision)).toBe(false);
    expect(actions.getSnapshot().pending).not.toBeNull();
  });
  it.each(['source', 'summary', 'map_missing', 'map_duplicate', 'target_collision'] as const)('rejects malformed continuation receipt %s and preserves exact retry', async field => {
    const { transport, targetActions, topic } = await setup();
    const command = { command: 'topic_continue' as const, api_version: 1 as const, op_id: op, params: {
      source: route, source_topic_id: topic.id, source_revision: transport.source.revision, source_sha256: 'a'.repeat(64),
      target: targetRoute, target_binding_id: transport.target.active_binding_id!, summary: 'Reviewed summary.',
    } };
    const envelope = await transport.invoke<MutationEnvelope>('topic_continue', { request: { session: targetRoute, command } });
    transport.mutations.splice(0); await targetActions.session.refresh();
    if (!envelope.ok || !('data' in envelope.data) || envelope.data.data.kind !== 'continuation') throw new Error('test receipt');
    const saved = envelope.data.data.continuation;
    if (field === 'source') saved.source_session_id = op;
    if (field === 'summary') saved.summary = 'Unapproved summary';
    if (field === 'map_missing') Reflect.deleteProperty(saved, 'message_id_map');
    if (field === 'map_duplicate') saved.message_id_map = { [crypto.randomUUID()]: op, [crypto.randomUUID()]: op };
    if (field === 'target_collision') saved.target_input_id = saved.target_topic_id;
    transport.replies.push(envelope);
    expect(await targetActions.execute(command, transport.target.revision)).toBe(false);
    expect(targetActions.getSnapshot().pending?.command).toEqual(command);
  });
  it('keeps copied local history navigable when original project cannot be opened', async () => {
    const { transport, store, topic } = await setup();
    const item = Object.values(transport.source.items)[0]!;
    item.origin = { project_id: op, session_id: op, topic_id: topic.id, entity_id: '77', source_revision: 1 };
    ++transport.source.revision; await store.refresh();
    const revealed: unknown[] = [];
    render(<CopiedProvenance store={store} itemId={item.id} revealItem={async value => {
      revealed.push(value); if (value.project_id === op) throw new Error('Original unavailable');
    }} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Source item 77' })); });
    expect(screen.getByText(/Full copied history remains here/)).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Open copied item ${item.id}` })); });
    expect(revealed).toEqual([{ project_id: op, session_id: op, item_id: '77' }, { ...route, item_id: item.id }]);
    expect(transport.mutations).toHaveLength(0);
  });
});
