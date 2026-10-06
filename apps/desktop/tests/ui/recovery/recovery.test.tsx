import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { CoreError, MutationEnvelope, OwnerMutationRequest } from '../../../src/generated/core';
import type { Binding, Input, PresenceObservation, SavedReceipt, Session } from '../../../src/generated/domain/models';
import { createDesktopService, CoreFailure, OpenSessions, type DesktopTransport, type HintPayloads } from '../../../src/data';
import { SessionActions, SessionActionControllers } from '../../../src/components/bindings/actions';
import { BindingControls } from '../../../src/components/bindings/BindingControls';
import { qualifiedPresence } from '../../../src/components/bindings/presence';
import { RecoveryPanel, recoveryTargets } from '../../../src/components/recovery/RecoveryPanel';
import { EdgeState, SessionNotice, type EdgeKind } from '../../../src/components/edge-states/EdgeState';

const opId = '00000000-0000-4000-8000-000000000099';
const route = { project_id: demo.project_id, session_id: demo.id };
function fixture() {
  const session = structuredClone(demo) as Session;
  const input = Object.values(session.inputs).find(input => input?.state === 'needs_attention')!;
  input.binding_id = session.active_binding_id!;
  session.inputs = { [input.id]: input }; session.operation_receipts = {};
  session.bindings[session.active_binding_id!]!.active_input_id = input.id;
  session.bindings[session.active_binding_id!]!.pause_reason = 'uncertain';
  session.bindings[session.active_binding_id!]!.dispatch_state = 'recovery_required';
  return session;
}
const currentInput = (session: Session): Input => Object.values(session.inputs)[0]!;
const currentBinding = (session: Session): Binding => session.bindings[session.active_binding_id!]!;
const failure = (code: CoreError['code']): MutationEnvelope => ({ api_version: 1, ok: false,
  error: { code, message: 'Action rejected.', hint: 'Review current session.', field_errors: [], retryable: false } });
class Transport implements DesktopTransport {
  session = fixture();
  readError: CoreError | null = null;
  readonly mutations: OwnerMutationRequest[] = [];
  replies: (MutationEnvelope | Error | Promise<MutationEnvelope>)[] = [];
  listeners = new Map<keyof HintPayloads, (hint: never) => void>();
  async invoke<T>(name: string, { request }: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    if (name === 'session_get') return (this.readError ? { api_version: 1, ok: false, error: this.readError }
      : { api_version: 1, ok: true, data: { kind: 'session_get', data: { session: structuredClone(this.session), freshness: 'fresh' } } }) as T;
    if (name === 'session_list') {
      const binding = currentBinding(this.session), summary = structuredClone(sessionsFixture.items[0]);
      return { api_version: 1, ok: true, data: { kind: 'session_list', data: {
        sessions: { items: [{ ...summary, session_id: this.session.id, project_id: this.session.project_id, revision: this.session.revision,
          active_binding: { ...summary.active_binding, id: binding.id, generation: binding.generation, presence: null } }],
        next_cursor: null, snapshot_revision: this.session.revision }, active_total: 1, closed_total: 0, counts: summary.counts,
      } } } as T;
    }
    this.mutations.push(structuredClone(request) as OwnerMutationRequest);
    const next = this.replies.shift();
    if (next instanceof Error || !next) throw new Error('Unavailable');
    return await next as T;
  }
  async listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void) {
    this.listeners.set(event, receive as (hint: never) => void); return () => { this.listeners.delete(event); };
  }
  receipt(kind: 'input_resolve' | 'binding_state' | 'binding_connect', decision = 'resend'): MutationEnvelope {
    const binding = currentBinding(this.session), input = currentInput(this.session);
    const data: SavedReceipt['data'] = kind === 'input_resolve'
      ? { kind, input_id: input.id, attempt_id: input.active_attempt_id!, resolution_kind: decision as 'resend', state: 'queued' }
      : kind === 'binding_connect' ? { kind, binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities, setup_instruction: 'Use installed commands.' }
        : { kind, binding_id: binding.id, generation: binding.generation, dispatch_state: 'paused', owner_paused: true, pause_reason: null, connection_state: binding.connection_state };
    return { api_version: 1, ok: true, data: { operation_id: opId, session_id: this.session.id, revision: this.session.revision + 1, data } };
  }
  presence(update: Partial<PresenceObservation> = {}) {
    const binding = currentBinding(this.session);
    const observation: PresenceObservation = { instance_id: opId, generation: binding.generation, connection_state: 'connected', execution_state: 'idle',
      source: 'host_poll', last_seen_at: '2026-10-04T12:00:00.000Z', process_identity: null, freshness: 'fresh', ...update };
    this.listeners.get('ariadne://presence_changed')?.({ binding_id: binding.id, generation: observation.generation, observation } as never);
  }
}
const opened: OpenSessions[] = [];
async function setup() {
  const transport = new Transport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
  opened.push(sessions); const store = sessions.open(route); await store.refresh();
  const actions = new SessionActions(service, store, () => opId);
  return { transport, sessions, store, actions };
}
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); vi.useRealTimers(); });
function dialog() { return within(screen.getByRole('dialog')); }
function chooseRecovery(choice: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }));
  fireEvent.change(dialog().getByLabelText('Recovery choice'), { target: { value: choice } });
  fireEvent.change(dialog().getByLabelText('Reason'), { target: { value: 'Reviewed terminal and prior effects.' } });
}

describe('explicit binding lifecycle', () => {
  it('confirms persisted pause without sending, and keeps a refreshed owner pause visible', async () => {
    const { actions, transport, store } = await setup();
    render(<BindingControls actions={actions} />); fireEvent.click(screen.getByRole('button', { name: 'Pause dispatch' }));
    expect(transport.mutations).toHaveLength(0);
    transport.replies.push(transport.receipt('binding_state')); currentBinding(transport.session).owner_paused = true;
    currentBinding(transport.session).dispatch_state = 'paused'; transport.session.revision += 1;
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm pause' })); });
    expect(transport.mutations).toEqual([{ session: route, command: { command: 'binding_pause', api_version: 1, op_id: opId,
      params: { binding_id: currentBinding(transport.session).id, expected_generation: currentBinding(transport.session).generation } } }]);
    expect(screen.getByText(/paused by you/)).toBeDefined(); await act(async () => { await store.refresh(); });
    expect(transport.mutations).toHaveLength(1); expect(screen.queryByRole('button', { name: /stop agent|approve|retarget/i })).toBeNull();
  });
  it('same-host Connect preserves endpoint/config and requires a deliberate generation review', async () => {
    const { actions, transport } = await setup(); render(<BindingControls actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' })); const binding = currentBinding(transport.session);
    transport.replies.push(transport.receipt('binding_connect'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm connect' })); });
    expect(transport.mutations[0].command).toEqual({ command: 'binding_connect', api_version: 1, op_id: opId, params: {
      project_id: route.project_id, existing_session_id: route.session_id, adapter_id: binding.adapter_id,
      external_session_id: binding.external_session_id, endpoint: binding.endpoint, configuration: binding.adapter_config } });
    expect(transport.mutations).toHaveLength(1);
  });
  it('does not apply an old confirmation to a changed session', async () => {
    const { actions, transport, store } = await setup(); render(<BindingControls actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); transport.session.revision += 1;
    await act(async () => { await store.refresh(); });
    expect((dialog().getByRole('button', { name: 'Confirm disconnect' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog().getByRole('button', { name: 'Confirm disconnect' })); expect(transport.mutations).toHaveLength(0);
  });
});

describe('audited recovery', () => {
  it('requires duplicate-risk review and current idle attestation, records the exact input without implicit Resume', async () => {
    const { actions, transport } = await setup(); render(<RecoveryPanel actions={actions} />); chooseRecovery('resend');
    const save = dialog().getByRole('button', { name: 'Save recovery decision' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); expect(dialog().getByText(/may repeat work/)).toBeDefined();
    fireEvent.click(dialog().getByLabelText('I reviewed the duplicate-work risk.')); expect(save.disabled).toBe(true);
    fireEvent.click(dialog().getByLabelText(/I confirm the terminal/)); transport.replies.push(transport.receipt('input_resolve'));
    await act(async () => { fireEvent.click(save); });
    const request = transport.mutations[0]; expect(request.command.command).toBe('input_resolve');
    if (request.command.command !== 'input_resolve') throw new Error('Expected recovery');
    expect(request.command.params).toMatchObject({ input_id: currentInput(transport.session).id, attempt_id: currentInput(transport.session).active_attempt_id,
      decision: 'resend', expected_revision: demo.revision, reason: 'Reviewed terminal and prior effects.', evidence: { source: 'owner_attestation', owner_attested_idle: true, turn_state: 'unknown' } });
    expect(request.command.params.evidence?.at).toMatch(/^\d{4}-.*\.\d{3}Z$/); expect(transport.mutations).toHaveLength(1);
    expect(screen.getByText(/Resume dispatch is a separate/)).toBeDefined();
  });
  it('uses machine-qualified idle without falsely recording owner attestation', async () => {
    const { actions, transport } = await setup(); transport.presence(); render(<RecoveryPanel actions={actions} />); chooseRecovery('skip');
    expect(dialog().queryByLabelText(/I confirm the terminal/)).toBeNull(); transport.replies.push(transport.receipt('input_resolve', 'skip'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save recovery decision' })); });
    expect(transport.mutations[0].command).toMatchObject({ params: { decision: 'skip', evidence: null } });
  });
  it.each(['running', 'waiting_for_approval'] as const)('blocks all recovery when qualified host is %s', async execution_state => {
    const { actions, transport } = await setup(); transport.presence({ execution_state }); render(<RecoveryPanel actions={actions} />); chooseRecovery('confirm_evidence');
    expect((dialog().getByRole('button', { name: 'Save recovery decision' }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog().getByText(/Interrupt it in the terminal/)).toBeDefined(); expect(transport.mutations).toHaveLength(0);
  });
  it.each([{ freshness: 'stale' }, { source: 'process_hint' }, { last_seen_at: null }] as Partial<PresenceObservation>[])('requires owner attestation for unqualified observation %j', async update => {
    const { actions, transport } = await setup(); transport.presence(update); render(<RecoveryPanel actions={actions} />); chooseRecovery('skip');
    expect(dialog().getByLabelText(/I confirm the terminal/)).toBeDefined();
    expect((dialog().getByRole('button', { name: 'Save recovery decision' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows result-only repair for completed work and preserves choice and reason on read failure', async () => {
    const { actions, transport, store } = await setup(); const attempt = currentInput(transport.session).attempts[0];
    attempt.acceptance = 'accepted'; attempt.turn_state = 'completed'; attempt.result_state = 'missing'; transport.session.revision += 1; await store.refresh();
    render(<RecoveryPanel actions={actions} />); chooseRecovery('request_result_repair');
    expect(dialog().getByText(/result-only model turn/)).toBeDefined();
    transport.readError = { code: 'io_error', message: 'Unavailable data.', hint: 'Restore access.', field_errors: [], retryable: false };
    await act(async () => { await store.refresh(); });
    expect((dialog().getByLabelText('Reason') as HTMLInputElement).value).toBe('Reviewed terminal and prior effects.');
    expect((dialog().getByLabelText('Recovery choice') as HTMLSelectElement).value).toBe('request_result_repair');
    expect((dialog().getByRole('button', { name: 'Save recovery decision' }) as HTMLButtonElement).disabled).toBe(true);
    expect(store.getSnapshot().snapshot?.session.revision).toBe(transport.session.revision);
  });
  it('never offers pre-execution retry on an uncertain or executed attempt', async () => {
    const { actions } = await setup(); render(<RecoveryPanel actions={actions} />); chooseRecovery('resend');
    expect(dialog().queryByRole('option', { name: 'Prepare retry' })).toBeNull();
  });
  it('records Confirm evidence as owner attribution without fabricating an agent result', async () => {
    const { actions, transport } = await setup(); render(<RecoveryPanel actions={actions} />); chooseRecovery('confirm_evidence');
    fireEvent.change(dialog().getByLabelText('Observed outcome'), { target: { value: 'completed' } });
    fireEvent.change(dialog().getByLabelText('Known host turn (optional)'), { target: { value: 'known-turn' } });
    fireEvent.click(dialog().getByLabelText(/I confirm the terminal/)); transport.replies.push(transport.receipt('input_resolve', 'confirm_evidence'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save recovery decision' })); });
    expect(transport.mutations[0].command).toMatchObject({ params: { decision: 'confirm_evidence', evidence: {
      source: 'owner_attestation', owner_attested_idle: true, host_turn_id: 'known-turn', turn_state: 'completed' } } });
    expect(currentInput(transport.session).attempts[0].domain_result).toBeNull(); expect(currentInput(transport.session).state).toBe('needs_attention');
  });
});

describe('receipt uncertainty across navigation', () => {
  it('reopens a closed tab with its exact pending operation and a fresh session reader', async () => {
    const { actions, transport, store, sessions } = await setup();
    const controllers = new SessionActionControllers(actions.service, () => opId);
    const retained = controllers.forSession(store), binding = currentBinding(transport.session);
    transport.replies.push(new Error('Lost acknowledgement'));
    await retained.execute({ api_version: 1, op_id: '', command: 'binding_pause',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, transport.session.revision);
    const request = structuredClone(transport.mutations[0]);
    sessions.close(route);
    expect(store.getSnapshot().status).toBe('closed');
    transport.session.revision += 1;
    const reopened = sessions.open(route); await reopened.refresh();
    expect(reopened).not.toBe(store);
    expect(controllers.forSession(reopened)).toBe(retained);
    expect(retained.session).toBe(reopened);
    expect(retained.getSnapshot().pending).toEqual(request);
    expect(transport.mutations).toHaveLength(1);
    transport.replies.push(transport.receipt('binding_state'));
    expect(await retained.retry()).toBe(true);
    expect(transport.mutations).toEqual([request, request]);
    expect(retained.getSnapshot().pending).toBeNull();
    expect(reopened.getSnapshot().status).toBe('ready');
  });
  it('isolates controllers by project and session and rejects cross-route attachment', async () => {
    const { actions, store, sessions } = await setup();
    const controllers = new SessionActionControllers(actions.service, () => opId);
    const retained = controllers.forSession(store);
    const other = sessions.open({ ...route, session_id: opId }); await other.refresh();
    expect(controllers.forSession(other)).not.toBe(retained);
    expect(() => retained.attachSession(other)).toThrow(/cannot change its registered route/);
    const otherProject = sessions.open({ ...route, project_id: opId }); await otherProject.refresh();
    expect(controllers.forSession(otherProject)).not.toBe(retained);
    expect(() => retained.attachSession(otherProject)).toThrow(/cannot change its registered route/);
    expect(retained.session).toBe(store);
    expect(controllers.forSession(store)).toBe(retained);
  });
  it('serializes repeated clicks and retains the request after a malformed success', async () => {
    const { actions, transport, store } = await setup(); const binding = currentBinding(transport.session);
    let resolve!: (value: MutationEnvelope) => void;
    transport.replies.push(new Promise<MutationEnvelope>(yes => { resolve = yes; }));
    const command = { api_version: 1 as const, op_id: '', command: 'binding_pause' as const, params: { binding_id: binding.id, expected_generation: binding.generation } };
    const saving = actions.execute(command, store.getSnapshot().snapshot!.session.revision);
    expect(await actions.execute(command, store.getSnapshot().snapshot!.session.revision)).toBe(false);
    expect(await actions.retry()).toBe(false); expect(transport.mutations).toHaveLength(1);
    const receipt = transport.receipt('input_resolve'); resolve(receipt); expect(await saving).toBe(false);
    expect(actions.getSnapshot().pending?.command.command).toBe('binding_pause');
    expect(actions.getSnapshot().error?.message).toBe('Desktop service returned an invalid response.');
  });
  it('retains every request byte across unmount/refresh/new generation and retries only deliberately', async () => {
    const { actions, transport, store } = await setup(); let view = render(<RecoveryPanel actions={actions} />); chooseRecovery('resend');
    fireEvent.click(dialog().getByLabelText('I reviewed the duplicate-work risk.')); fireEvent.click(dialog().getByLabelText(/I confirm the terminal/));
    transport.replies.push(new Error('Lost acknowledgement'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Save recovery decision' })); });
    const request = structuredClone(transport.mutations[0]); view.unmount(); transport.session.revision += 1;
    currentBinding(transport.session).generation = opId; await store.refresh(); view = render(<BindingControls actions={actions} />);
    expect(transport.mutations).toHaveLength(1); expect(actions.getSnapshot().pending).toEqual(request);
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
    transport.replies.push(transport.receipt('input_resolve'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request]); expect(actions.getSnapshot().pending).toBeNull(); view.unmount();
  });
  it.each(['commit_uncertain', 'revision_conflict', 'stale_generation', 'delivery_uncertain', 'host_unreachable', 'not_found', 'invalid_argument', 'invalid_ref', 'store_busy', 'io_error', 'operation_reused'] as const)('keeps uncertain lifecycle requests after Core %s', async code => {
    const { actions, transport, store } = await setup(); transport.replies.push(failure(code));
    const binding = currentBinding(transport.session);
    expect(await actions.execute({ api_version: 1, op_id: '', command: 'binding_pause', params: { binding_id: binding.id, expected_generation: binding.generation } }, store.getSnapshot().snapshot!.session.revision)).toBe(false);
    expect(actions.getSnapshot().pending !== null).toBe(!['revision_conflict', 'stale_generation'].includes(code));
  });
  it('retains a saved-possibly Resume after a bridge error before Core replay', async () => {
    const { actions, transport, store } = await setup(), binding = currentBinding(transport.session);
    transport.replies.push(new Error('Lost acknowledgement'), failure('host_unreachable'));
    expect(await actions.execute({ command: 'binding_resume', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, transport.session.revision)).toBe(false);
    const request = structuredClone(transport.mutations[0]);
    expect(await actions.retry()).toBe(false);
    expect(actions.getSnapshot().pending).toEqual(request);
    expect(transport.mutations).toEqual([request, request]);
    expect(await actions.execute({ command: 'binding_pause', api_version: 1, op_id: '',
      params: { binding_id: binding.id, expected_generation: binding.generation } }, store.getSnapshot().snapshot!.session.revision)).toBe(false);
    expect(transport.mutations).toHaveLength(2);
  });
  it('allows a corrected deliberate recovery action after a precommit liveness rejection', async () => {
    const { actions, transport, store } = await setup();
    let id = 0;
    const corrected = new SessionActions(actions.service, store, () => `${opId.slice(0, -1)}${++id}`);
    const input = currentInput(transport.session);
    const command = { command: 'input_resolve' as const, api_version: 1 as const, op_id: '', params: {
      input_id: input.id, attempt_id: input.active_attempt_id!, expected_revision: transport.session.revision,
      decision: 'skip' as const, reason: 'Reviewed current work.', evidence: null,
    } };
    transport.replies.push(failure('delivery_uncertain'));
    expect(await corrected.execute(command, transport.session.revision)).toBe(false);
    expect(corrected.getSnapshot().pending).toBeNull();
    expect(await corrected.retry()).toBe(false);
    expect(transport.mutations).toHaveLength(1);
    transport.replies.push(new Error('Lost acknowledgement'));
    expect(await corrected.execute({ ...command, params: { ...command.params, evidence: {
      source: 'owner_attestation', owner_attested_idle: true, turn_state: 'unknown', host_turn_id: null, at: demo.updated_at,
    } } }, transport.session.revision)).toBe(false);
    expect(transport.mutations[1].command.op_id).not.toBe(transport.mutations[0].command.op_id);
    expect(corrected.getSnapshot().pending).toEqual(transport.mutations[1]);
    expect(transport.mutations[1].command).toMatchObject({ params: { evidence: { owner_attested_idle: true } } });
  });
  it('new app controller reloads persisted pause and uncertain attempt without automatic retry/resume', async () => {
    const { actions, transport, store } = await setup(); currentBinding(transport.session).owner_paused = true; transport.session.revision += 1; await store.refresh();
    const restarted = new SessionActions(actions.service, store, () => opId);
    render(<><BindingControls actions={restarted} /><RecoveryPanel actions={restarted} /></>);
    expect(screen.getByText(/paused by you/)).toBeDefined(); expect(screen.getByRole('button', { name: 'Review recovery' })).toBeDefined();
    expect(restarted.getSnapshot().pending).toBeNull(); expect(transport.mutations).toHaveLength(0);
  });
});

describe('edge states preserve mounted content', () => {
  it('distinguishes all ordinary states while retaining unsent text', () => {
    const view = render(<EdgeState kind="loading"><input aria-label="Unsent draft" defaultValue="Retained owner text" /></EdgeState>);
    const kinds: EdgeKind[] = ['loading', 'empty', 'all_clear', 'no_results', 'stale', 'unavailable', 'malformed', 'write_failure', 'reconnecting'];
    const headings = new Set<string>();
    kinds.forEach(kind => {
      view.rerender(<EdgeState kind={kind}><input aria-label="Unsent draft" defaultValue="" /></EdgeState>);
      headings.add(view.container.querySelector('strong')!.textContent!);
      expect((screen.getByLabelText('Unsent draft') as HTMLInputElement).value).toBe('Retained owner text');
      expect(view.container.querySelector('[data-edge-state]')?.getAttribute('data-edge-state')).toBe(kind);
    }); expect(headings.size).toBe(9);
  });
  it.each(['corrupt_session', 'future_schema'] as const)('shows malformed separately from inaccessible for %s', async code => {
    const { store } = await setup(); const state = store.getSnapshot();
    const error = new CoreFailure({ code, message: 'Unreadable store.', hint: 'Preserve stored data.', field_errors: [], retryable: false });
    render(<SessionNotice state={{ ...state, status: 'stale', error }} refresh={() => {}} />);
    expect(screen.getByText('Session cannot be read')).toBeDefined();
  });
  it('does not qualify a wrong-generation observation as idle', () => {
    const binding = currentBinding(fixture());
    expect(qualifiedPresence(binding, { instance_id: opId, generation: opId, connection_state: 'connected', execution_state: 'idle',
      freshness: 'fresh', source: 'host_poll', last_seen_at: '2026-10-04T12:00:00.000Z', process_identity: null }).idle).toBe(false);
  });
  it('includes sealed historical attributable conflicts, but hides acknowledged conflicts', () => {
    const session = fixture(), input = currentInput(session), attempt = input.attempts[0];
    input.state = 'handled'; input.active_attempt_id = null; attempt.sealed_at = demo.updated_at;
    const receipt: SavedReceipt = { operation_id: opId, session_id: session.id, revision: 10, data: { kind: 'event_conflict', input_id: input.id, attempt_id: attempt.id, event_id: 'late-contradiction' } };
    session.operation_receipts[opId] = [{ operation_id: opId, actor_scope: { kind: 'adapter', binding_id: input.binding_id },
      command_digest: '0'.repeat(64), result: receipt }];
    expect(recoveryTargets(session)).toHaveLength(1);
    input.resolution_history.push({ op_id: '00000000-0000-4000-8000-000000000098', kind: 'confirm_evidence', reason: 'Known prior work.', at: demo.updated_at, attempt_id: attempt.id, evidence: null });
    const audit = input.resolution_history[0]; session.operation_receipts[audit.op_id] = [{ operation_id: audit.op_id, actor_scope: { kind: 'owner' }, command_digest: '0'.repeat(64),
      result: { ...receipt, operation_id: audit.op_id, revision: 11, data: { kind: 'input_resolve', input_id: input.id, attempt_id: attempt.id, resolution_kind: 'confirm_evidence', state: 'handled' } } }];
    expect(recoveryTargets(session)).toHaveLength(0);
  });
});

describe('binding lifecycle surface (P4.7 acceptance gaps)', () => {
  it('Resume is blocked by a recovery pause reason, then sends a generation-fenced binding_resume once cleared', async () => {
    const { actions, transport, store } = await setup(); render(<BindingControls actions={actions} />);
    const resume = () => screen.getByRole('button', { name: 'Resume dispatch' }) as HTMLButtonElement;
    expect(resume().disabled).toBe(true);
    currentBinding(transport.session).pause_reason = null; currentBinding(transport.session).owner_paused = true;
    currentInput(transport.session).state = 'queued'; transport.session.revision += 1;
    await act(async () => { await store.refresh(); });
    expect(resume().disabled).toBe(false);
    fireEvent.click(resume()); expect(transport.mutations).toHaveLength(0);
    transport.replies.push(transport.receipt('binding_state'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm resume' })); });
    const binding = currentBinding(transport.session);
    expect(transport.mutations).toEqual([{ session: route, command: { command: 'binding_resume', api_version: 1, op_id: opId,
      params: { binding_id: binding.id, expected_generation: binding.generation } } }]);
  });
  it('Disconnect sends a generation-fenced binding_disconnect only after confirmation', async () => {
    const { actions, transport } = await setup(); render(<BindingControls actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); expect(transport.mutations).toHaveLength(0);
    transport.replies.push(transport.receipt('binding_state'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm disconnect' })); });
    const binding = currentBinding(transport.session);
    expect(transport.mutations).toEqual([{ session: route, command: { command: 'binding_disconnect', api_version: 1, op_id: opId,
      params: { binding_id: binding.id, expected_generation: binding.generation } } }]);
  });
  it('shows the binding generation and qualified host freshness, and downgrades unqualified observations', async () => {
    const { actions, transport } = await setup(); const binding = currentBinding(transport.session);
    const view = render(<BindingControls actions={actions} />);
    expect(view.container.querySelector('.lifecycle-muted code')?.textContent).toBe(binding.generation);
    expect(screen.getByText('Host state unknown')).toBeDefined();
    act(() => { transport.presence(); });
    expect(screen.getByText('Host idle · fresh host poll')).toBeDefined();
    act(() => { transport.presence({ freshness: 'stale' }); });
    expect(screen.getByText('Host state stale · unqualified')).toBeDefined();
    act(() => { transport.presence({ generation: opId }); });
    expect(screen.queryByText('Host idle · fresh host poll')).toBeNull();
  });
  it('shows a distinct Reconnecting state only while a Connect write is in flight', async () => {
    const { actions, transport } = await setup(); render(<BindingControls actions={actions} />);
    expect(document.querySelector('[data-edge-state="reconnecting"]')).toBeNull();
    let release!: (value: MutationEnvelope) => void;
    transport.replies.push(new Promise<MutationEnvelope>(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Confirm connect' })); });
    expect(document.querySelector('[data-edge-state="reconnecting"]')).not.toBeNull();
    expect(screen.getByText('Reconnecting')).toBeDefined();
    await act(async () => { release(transport.receipt('binding_connect')); });
    expect(document.querySelector('[data-edge-state="reconnecting"]')).toBeNull();
  });
  it('maps each non-ready session status to its own edge state and renders nothing when ready', async () => {
    const { store } = await setup(); const base = store.getSnapshot();
    const kind = (status: typeof base.status) => {
      const view = render(<SessionNotice state={{ ...base, status, error: null }} refresh={() => {}} />);
      const found = view.container.querySelector('[data-edge-state]')?.getAttribute('data-edge-state') ?? null; view.unmount(); return found;
    };
    expect(kind('loading')).toBe('loading'); expect(kind('stale')).toBe('stale');
    expect(kind('inaccessible')).toBe('unavailable'); expect(kind('closed')).toBe('unavailable'); expect(kind('ready')).toBeNull();
  });
});
