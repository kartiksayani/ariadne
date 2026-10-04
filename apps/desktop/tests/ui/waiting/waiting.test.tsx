import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import summariesFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { Attempt, Input, ProjectSummary, QueryCursor, Session, SessionSummary } from '../../../src/generated/domain/models';
import type { CoreError, QueryEnvelope } from '../../../src/generated/core';
import { createDesktopService, immutable, OpenSessions, ServiceFailure, type DesktopTransport, type HintPayloads } from '../../../src/data';
import { deliveryEvidence } from '../../../src/selectors/waiting/delivery';
import { sentRows, waitingRows } from '../../../src/selectors/waiting/rows';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { WaitingPanel } from '../../../src/components/waiting/WaitingPanel';

const route = { project_id: demo.project_id, session_id: demo.id };
function fixture(): { session: Session; project: ProjectSummary; summary: SessionSummary } {
  return { session: structuredClone(demo) as Session, project: structuredClone(projectsFixture.items[0]) as ProjectSummary,
    summary: structuredClone(summariesFixture.items[0]) as SessionSummary };
}
const mutableSession = () => structuredClone(demo) as Session;
const inputId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
function input(): Input { return structuredClone((demo as unknown as Session).inputs[inputId('72')]!); }
function attempt(): Attempt { return input().attempts[0]; }
const binding = fixture().summary.active_binding!;
const counts = fixture().summary.counts;
const error: CoreError = { code: 'io_error', message: 'Registered data is inaccessible.', hint: 'Restore local access.', retryable: false, field_errors: [] };
function envelope(data: Extract<QueryEnvelope, { ok: true }>['data']): QueryEnvelope { return { api_version: 1, ok: true, data }; }
function projectPage(items = [fixture().project], cursor: QueryCursor | null = null, revision = 21): QueryEnvelope {
  return envelope({ kind: 'project_list', data: { counts: structuredClone(counts),
    projects: { items, next_cursor: cursor, snapshot_revision: revision } } });
}
function sessionPage(items = [fixture().summary], cursor: QueryCursor | null = null, revision = 21): QueryEnvelope {
  return envelope({ kind: 'session_list', data: { counts: structuredClone(counts), active_total: 1, closed_total: 0,
    sessions: { items, next_cursor: cursor, snapshot_revision: revision } } });
}
function loaded(session = mutableSession()): QueryEnvelope { return envelope({ kind: 'session_get', data: { session, freshness: 'fresh' } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Transport implements DesktopTransport {
  readonly calls: { name: string; request: unknown }[] = [];
  readonly script = new Map<string, (QueryEnvelope | Error | Promise<QueryEnvelope>)[]>();
  readonly listeners = new Map<keyof HintPayloads, Set<(value: never) => void>>();
  failListener = false;
  onCall: (() => void) | undefined;
  push(name: string, ...responses: (QueryEnvelope | Error | Promise<QueryEnvelope>)[]) {
    this.script.set(name, [...this.script.get(name) ?? [], ...responses]);
  }
  async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    this.calls.push({ name, request: structuredClone(args.request) }); this.onCall?.();
    const next = this.script.get(name)?.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Transport script exhausted');
    return await next as T;
  }
  async listen<E extends keyof HintPayloads>(name: E, receive: (hint: HintPayloads[E]) => void) {
    if (this.failListener && name === 'ariadne://presence_changed') throw new Error('Listener unavailable');
    const group = this.listeners.get(name) ?? new Set();
    group.add(receive as (value: never) => void); this.listeners.set(name, group);
    return () => { group.delete(receive as (value: never) => void); };
  }
  emit<E extends keyof HintPayloads>(name: E, hint: HintPayloads[E]) { this.listeners.get(name)?.forEach(receive => receive(hint as never)); }
  capture(session = mutableSession()) { this.push('project_list', projectPage()); this.push('session_list', sessionPage()); this.push('session_get', loaded(session)); }
}
const stores: WaitingStore[] = [], sessions: OpenSessions[] = [];
function setup() {
  const transport = new Transport(), service = createDesktopService(transport), opened = new OpenSessions(service);
  const store = new WaitingStore(service, opened); stores.push(store); sessions.push(opened);
  return { transport, store, opened };
}
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); sessions.splice(0).forEach(opened => opened.closeAll()); vi.useRealTimers(); });

describe('current Waiting and immutable Sent selection', () => {
  it('keeps a new ask beside the old sent answer and its complete original payload', () => {
    const seed = fixture(), session = seed.session as Session;
    const old = session.inputs[inputId('71')]!; old.state = 'queued'; old.active_attempt_id = null;
    old.payload.text = '  exact\nowner bytes  '; old.payload.selected_option_id = 'old';
    old.payload.target_snapshot.options = [{ id: 'old', label: 'Original choice', consequence: 'Original consequence', recommended: false }];
    session.answers.push({ ...session.answers[0], id: inputId('89'), item_id: '2', input_id: old.id, question_revision: 1, supersedes_answer_id: null });
    session.items['2']!.question_revision = 2;
    const frozen = immutable(seed);
    expect(waitingRows([frozen]).map(row => row.item.id)).toEqual(['2']);
    const row = sentRows([frozen]).find(row => row.input.id === old.id)!;
    expect(row.changedQuestion).toBe(true); expect(row.input.payload.text).toBe('  exact\nowner bytes  ');
    expect(row.input.payload.target_snapshot.options[0].label).toBe('Original choice');
    expect(Object.isFrozen(row.input.payload)).toBe(true);
  });
  it.each(['queued', 'in_flight', 'handled', 'needs_attention'] as const)('a %s answer suppresses the same waiting episode', state => {
    const seed = fixture(), session = seed.session as Session, old = session.inputs[inputId('71')]!;
    old.state = state;
    session.answers.push({ ...session.answers[0], id: inputId('89'), item_id: '2', input_id: old.id, question_revision: 1, supersedes_answer_id: null });
    expect(waitingRows([seed])).toHaveLength(0);
  });
  it.each(['cancelled', 'skipped'] as const)('a %s answer leaves the current episode waiting', state => {
    const seed = fixture(), session = seed.session as Session, old = session.inputs[inputId('71')]!;
    old.state = state;
    session.answers.push({ ...session.answers[0], id: inputId('89'), item_id: '2', input_id: old.id, question_revision: 1, supersedes_answer_id: null });
    expect(waitingRows([seed])).toHaveLength(1);
  });
  it('shows one Sent row per qualifying input including replaced items and topic continuations', () => {
    const rows = sentRows([fixture()]);
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.input.id === inputId('74'))!.currentItem?.status).toBe('replaced');
    expect(rows.find(row => row.input.id === inputId('77'))!.route).toBeNull();
    expect(new Set(rows.map(row => row.id)).size).toBe(4);
  });
  it('orders episodes by waiting time then stable project/session and numeric item reference', () => {
    const later = fixture(), earlier = fixture();
    (later.session as Session).items['2']!.waiting_since = '2026-10-03T12:10:00.000Z';
    (earlier.session as Session).id = inputId('99');
    expect(waitingRows([later, earlier]).map(row => row.route.session_id)).toEqual([inputId('99'), demo.id]);
    const seed = fixture(), s = seed.session as Session;
    s.items['10'] = { ...s.items['2']!, id: '10', ordinal: 10 };
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2', '10']);
  });
  it('rejects missing waiting episode provenance rather than inventing a timestamp/message', () => {
    const seed = fixture(); (seed.session as Session).items['2']!.waiting_since = null;
    expect(() => waitingRows([seed])).toThrow('provenance');
  });
  it('does not let a superseded handled answer suppress a newly cancelled correction', () => {
    const seed = fixture(), session = seed.session;
    session.answers.push({ ...session.answers[0], id: inputId('88'), item_id: '2', input_id: inputId('71'), question_revision: 1, supersedes_answer_id: null });
    session.answers.push({ ...session.answers[0], id: inputId('89'), item_id: '2', input_id: inputId('78'), question_revision: 1, supersedes_answer_id: inputId('88') });
    expect(waitingRows([seed])).toHaveLength(1);
  });
});

describe('delivery evidence', () => {
  it.each(['cancelled', 'skipped', 'handled'] as const)('terminal %s wins over historical uncertainty', state => {
    const value = input(); value.state = state; value.attempts[0].acceptance = 'uncertain';
    expect(deliveryEvidence(value, binding).kind).toBe(state);
  });
  it('uses only the current attempt after resolving historical uncertainty', () => {
    const value = input(); value.state = 'queued'; value.active_attempt_id = null;
    value.attempts[0].acceptance = 'uncertain'; value.attempts[0].sealed_at = '2026-10-03T12:00:50.000Z';
    const available = structuredClone(binding); available.presence = null;
    expect(deliveryEvidence(value, available).kind).toBe('saved');
    const newer = attempt(); newer.id = inputId('99'); newer.acceptance = 'accepted'; newer.turn_state = 'unknown';
    value.state = 'in_flight'; value.active_attempt_id = newer.id; value.attempts.push(newer);
    expect(deliveryEvidence(value, available).kind).toBe('sent');
  });
  it.each([
    ['uncertain', { acceptance: 'uncertain' }],
    ['rejected', { acceptance: 'rejected', turn_state: 'unknown' }],
    ['failed', { turn_state: 'interrupted' }],
    ['missing', { turn_state: 'completed', result_state: 'missing' }],
    ['waiting_result', { turn_state: 'completed', result_state: 'pending' }],
    ['published', { turn_state: 'running', result_state: 'committed' }],
    ['received', { turn_state: 'running', result_state: 'pending' }],
    ['sent', { turn_state: 'unknown', acceptance: 'accepted' }],
    ['sending', { turn_state: 'unknown', acceptance: 'prepared' }],
  ] as const)('renders %s from persisted facts without timing inference', (kind, changes) => {
    const value = input(); Object.assign(value.attempts[0], { sealed_at: null, result_state: 'pending' }, changes);
    expect(deliveryEvidence(value, binding).kind).toBe(kind);
  });
  it('does not fabricate handled/progress from missing or inconsistent active evidence', () => {
    const value = input(); value.active_attempt_id = inputId('99');
    expect(deliveryEvidence(value, binding).kind).toBe('unavailable');
    value.active_attempt_id = null; expect(deliveryEvidence(value, binding).kind).toBe('unavailable');
    value.active_attempt_id = value.attempts[0].id;
    Object.assign(value.attempts[0], { turn_state: 'completed', result_state: 'committed', sealed_at: null });
    expect(deliveryEvidence(value, binding).kind).toBe('unavailable');
  });
  it('keeps a persisted protocol contradiction ahead of completion or missing progress', () => {
    const value = input(); Object.assign(value.attempts[0], { turn_state: 'completed', result_state: 'missing', sealed_at: null,
      error: { code: 'protocol_conflict', reason: 'Retained contradictory facts.', retryable: false, observed_at: demo.updated_at } });
    expect(deliveryEvidence(value, binding).kind).toBe('uncertain');
    value.state = 'handled'; expect(deliveryEvidence(value, binding).kind).toBe('handled');
  });
  it('uses a matching persisted adapter conflict ahead of retained missing-result facts', () => {
    const value = input();
    Object.assign(value.attempts[0], { turn_state: 'completed', result_state: 'missing', sealed_at: null,
      error: { code: 'result_missing', reason: 'Missing explicit result.', retryable: false, observed_at: demo.updated_at } });
    const receipts: Session['operation_receipts'] = { [inputId('99')]: [{ operation_id: inputId('99'),
      actor_scope: { kind: 'adapter', binding_id: value.binding_id }, command_digest: 'a'.repeat(64),
      result: { operation_id: inputId('99'), session_id: demo.id, revision: demo.revision,
        data: { kind: 'event_conflict', event_id: 'conflicting-event', input_id: value.id, attempt_id: value.active_attempt_id } } }] };
    expect(deliveryEvidence(value, binding, receipts).kind).toBe('uncertain');
    expect(value.attempts[0].error?.code).toBe('result_missing');
    for (const changed of [
      { actor_scope: { kind: 'agent' as const, binding_id: value.binding_id } },
      { actor_scope: { kind: 'adapter' as const, binding_id: inputId('98') } },
      { result: { ...receipts[inputId('99')]![0].result, data: { kind: 'event_conflict' as const,
        event_id: 'conflicting-event', input_id: inputId('98'), attempt_id: value.active_attempt_id } } },
      { result: { ...receipts[inputId('99')]![0].result, data: { kind: 'event_conflict' as const,
        event_id: 'conflicting-event', input_id: value.id, attempt_id: inputId('98') } } },
    ]) expect(deliveryEvidence(value, binding, { [inputId('99')]: [{ ...receipts[inputId('99')]![0], ...changed }] }).kind).toBe('missing');
    value.state = 'queued'; value.active_attempt_id = null;
    expect(deliveryEvidence(value, { ...binding, presence: null }, receipts).kind).toBe('saved');
    const newer = attempt(); newer.id = inputId('98'); newer.acceptance = 'accepted'; newer.turn_state = 'unknown';
    value.state = 'in_flight'; value.active_attempt_id = newer.id; value.attempts.push(newer);
    expect(deliveryEvidence(value, binding, receipts).kind).toBe('sent');
    value.state = 'handled'; expect(deliveryEvidence(value, binding, receipts).kind).toBe('handled');
  });
  it('does not use a different active binding to claim that queued work is available', () => {
    const value = input(); value.state = 'queued'; value.active_attempt_id = null;
    expect(deliveryEvidence(value, { ...binding, id: inputId('99') }).kind).toBe('unavailable');
  });
  it('qualifies busy host evidence and never derives idle from stale or foreign generations', () => {
    const value = input(); value.state = 'queued'; value.active_attempt_id = null;
    expect(deliveryEvidence(value, binding).kind).toBe('queued');
    const observed = structuredClone(binding); observed.presence!.generation = inputId('99');
    expect(deliveryEvidence(value, observed).kind).toBe('saved');
    observed.presence!.generation = binding.generation; observed.presence!.freshness = 'stale';
    expect(deliveryEvidence(value, observed).kind).toBe('saved');
    observed.owner_paused = true; expect(deliveryEvidence(value, observed).kind).toBe('queued');
  });
});

describe('registered global capture', () => {
  it('subscribes before loading and shares immutable registered snapshots with other screens', async () => {
    const { store, transport, opened } = setup(); transport.capture();
    transport.onCall = () => expect(transport.listeners.get('ariadne://session_changed')!.size).toBeGreaterThan(0);
    await store.start();
    expect(store.getSnapshot().status).toBe('ready'); expect(store.getSnapshot().waiting).toHaveLength(1);
    expect(store.getSnapshot().sessions[0].session).toBe(opened.open(route).getSnapshot().snapshot?.session);
    expect(Object.isFrozen(store.getSnapshot().sessions[0].session)).toBe(true);
    expect(store.getSnapshot().counts).toEqual(counts);
    store.stop(); expect(opened.open(route).getSnapshot().status).toBe('ready');
  });
  it('retains last complete capture after failed reads and mismatching session revisions', async () => {
    const { store, transport } = setup(); transport.capture(); await store.start(); const previous = store.getSnapshot();
    transport.push('project_list', { api_version: 1, ok: false, error }); await store.refresh();
    expect(store.getSnapshot().status).toBe('stale'); expect(store.getSnapshot().waiting).toBe(previous.waiting);
    transport.capture(); const changed = mutableSession(); changed.revision = 22; transport.script.set('session_get', [loaded(changed)]);
    await store.refresh(); expect(store.getSnapshot().error).toBeInstanceOf(ServiceFailure);
    expect(store.getSnapshot().counts).toBe(previous.counts);
  });
  it('preserves the last capture when global project/session counts straddle a mutation', async () => {
    const { store, transport } = setup(); transport.capture(); await store.start(); const before = store.getSnapshot();
    const changed = sessionPage(); if (changed.ok && changed.data.kind === 'session_list') changed.data.data.counts.waiting_unanswered++;
    transport.push('project_list', projectPage()); transport.push('session_list', changed); await store.refresh();
    expect(store.getSnapshot().status).toBe('stale'); expect(store.getSnapshot().waiting).toBe(before.waiting);
    expect(transport.calls.filter(call => call.name === 'session_get')).toHaveLength(1);
  });
  it('never presents an initial inaccessible root as an empty healthy queue', async () => {
    const { store, transport } = setup(); transport.push('project_list', { api_version: 1, ok: false, error });
    await store.start(); expect(store.getSnapshot().status).toBe('unavailable'); expect(store.getSnapshot().counts).toBeNull();
  });
  it('rejects cross-project catalogue membership before opening a session', async () => {
    const { store, transport } = setup(), wrong = fixture().summary; wrong.project_id = inputId('99');
    transport.push('project_list', projectPage()); transport.push('session_list', sessionPage([wrong])); await store.start();
    expect(transport.calls.map(call => call.name)).toEqual(['project_list', 'session_list']);
    expect(store.getSnapshot().error).toBeInstanceOf(ServiceFailure);
  });
  it('coalesces hints during a pending capture and rereads before showing current data', async () => {
    const { store, transport } = setup(); transport.capture(); await store.start();
    const pending = deferred<QueryEnvelope>(); transport.push('project_list', pending.promise, projectPage());
    transport.push('session_list', sessionPage(), sessionPage()); transport.push('session_get', loaded(), loaded());
    const started = deferred<void>(); transport.onCall = () => started.resolve();
    const capture = store.refresh(); await started.promise;
    transport.emit('ariadne://session_changed', { session_id: demo.id, revision: 22 });
    transport.emit('ariadne://session_changed', { session_id: demo.id, revision: 23 });
    expect(store.getSnapshot().status).toBe('stale'); pending.resolve(projectPage()); await capture;
    expect(transport.calls.filter(call => call.name === 'project_list')).toHaveLength(3);
    expect(store.getSnapshot().waiting).toHaveLength(1);
  });
  it('consumes every page with stable cursor/filter metadata', async () => {
    const { store, transport } = setup(), second = fixture().project; second.project_id = inputId('98'); second.project = null; second.availability = 'unavailable';
    const cursor: QueryCursor = { schema: 1, view: 'projects', revision: 21, filter_digest: 'a'.repeat(64), after: { kind: 'project', canonical_root: '/first', id: demo.project_id } };
    transport.push('project_list', projectPage([fixture().project], cursor), projectPage([second]));
    transport.push('session_list', sessionPage()); transport.push('session_get', loaded()); await store.start();
    expect(store.getSnapshot().unavailableProjects.map(project => project.project_id)).toEqual([second.project_id]);
    expect((transport.calls[1].request as { request: { params: { cursor: QueryCursor } } }).request.params.cursor).toEqual(cursor);
  });
  it.each(['revision', 'duplicate', 'view', 'metadata', 'empty'] as const)('rejects %s pagination corruption without publishing a partial capture', async kind => {
    const { store, transport } = setup(); transport.capture(); await store.start(); const before = store.getSnapshot();
    const cursor: QueryCursor = { schema: 1, view: kind === 'view' ? 'sessions' : 'projects', revision: 21,
      filter_digest: 'a'.repeat(64), after: { kind: 'project', canonical_root: '/first', id: demo.project_id } };
    const second = structuredClone(projectPage(kind === 'duplicate' ? [fixture().project] : [], null, kind === 'revision' ? 22 : 21));
    if (kind === 'metadata' && second.ok && second.data.kind === 'project_list') second.data.data.counts.waiting_unanswered++;
    transport.push('project_list', projectPage(kind === 'empty' ? [] : [fixture().project], cursor), second);
    await store.refresh(); expect(store.getSnapshot().status).toBe('stale'); expect(store.getSnapshot().waiting).toBe(before.waiting);
    expect(store.getSnapshot().error).toBeInstanceOf(ServiceFailure);
  });
  it('rolls back partial listener setup, retries and suppresses late capture after stop', async () => {
    const { store, transport } = setup(); transport.failListener = true; await store.start();
    expect(transport.listeners.get('ariadne://session_changed')!.size).toBe(0);
    transport.failListener = false; const pending = deferred<QueryEnvelope>(); transport.push('project_list', pending.promise);
    const capture = store.refresh(); await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
    store.stop(); pending.resolve(projectPage()); await capture;
    expect(transport.calls).toHaveLength(1); expect(store.getSnapshot().counts).toBeNull();
  });
  it('reconciles focus/wake/poll and stops its readers without closing shared stores', async () => {
    vi.useFakeTimers(); const { store, transport } = setup(); transport.capture(); await store.start();
    transport.capture(); window.dispatchEvent(new Event('focus')); await store.refresh();
    transport.capture(); window.dispatchEvent(new Event('pageshow')); await store.refresh();
    transport.capture(); await vi.advanceTimersByTimeAsync(2000);
    expect(transport.calls.filter(call => call.name === 'project_list')).toHaveLength(4);
    store.stop(); const before = transport.calls.filter(call => call.name === 'project_list').length;
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(2000);
    expect(transport.calls.filter(call => call.name === 'project_list')).toHaveLength(before);
  });
});

describe('source-backed Waiting and Sent panel', () => {
  it('routes waiting/current and original Sent targets, including a topic-only input', async () => {
    const { store, transport } = setup(); transport.capture(); await store.start();
    const reveal = vi.fn(), open = vi.fn();
    render(<WaitingPanel store={store} revealItem={reveal} openSession={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' })); expect(reveal).toHaveBeenCalledWith({ ...route, item_id: '2' });
    const sent = screen.getAllByRole('button').find(button => button.textContent?.includes('Continue'));
    // The topic-only input opens the registered session, never an invented item.
    const topic = sent ?? screen.getAllByRole('button').find(button => button.textContent?.includes('continue'))!;
    fireEvent.keyDown(topic, { key: 'Enter' }); expect(open).toHaveBeenCalledWith(route);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('shows incomplete data and immutable saved choice/body instead of a false all-clear state', async () => {
    const { store, transport } = setup(), seed = mutableSession();
    seed.inputs[inputId('76')]!.payload.text = '  exact\nowner bytes  ';
    seed.inputs[inputId('76')]!.payload.selected_option_id = 'frozen';
    seed.inputs[inputId('76')]!.payload.target_snapshot.options = [{ id: 'frozen', label: 'Old choice', consequence: 'Old consequence', recommended: false }];
    const sessions = sessionPage(); if (sessions.ok && sessions.data.kind === 'session_list') {
      sessions.data.data.counts.completeness = 'partial'; sessions.data.data.counts.unavailable_session_ids = [inputId('99')];
    }
    const projects = projectPage(); if (projects.ok && projects.data.kind === 'project_list' && sessions.ok && sessions.data.kind === 'session_list') projects.data.data.counts = structuredClone(sessions.data.data.counts);
    transport.push('project_list', projects); transport.push('session_list', sessions); transport.push('session_get', loaded(seed)); await store.start();
    render(<WaitingPanel store={store} revealItem={vi.fn()} openSession={vi.fn()} />);
    expect(screen.getByText('1 · incomplete')).toBeTruthy(); expect(screen.getByText(/Queue counts are incomplete/)).toBeTruthy();
    expect(screen.getByText(`Unavailable session ${inputId('99')}`)).toBeTruthy();
    expect(screen.getByText('Saved choice: Old choice · Old consequence')).toBeTruthy();
    expect(screen.getByText(/exact owner bytes/).textContent).toBe('  exact\nowner bytes  ');
  });
  it('keeps stale rows but removes answer actions after a read failure', async () => {
    const { store, transport } = setup(); transport.capture(); await store.start();
    const submit = vi.fn(); render(<WaitingPanel store={store} revealItem={vi.fn()} openSession={vi.fn()}
      answerControl={() => ({ options: [], selected: null, draft: 'retained', onSelect: vi.fn(), onDraft: vi.fn(), onSubmit: submit })} />);
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'retained');
    transport.push('project_list', { api_version: 1, ok: false, error });
    await act(async () => { await store.refresh(); });
    expect(screen.queryByRole('textbox')).toBeNull(); expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText(error.hint)).toBeTruthy(); expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
  });
});
