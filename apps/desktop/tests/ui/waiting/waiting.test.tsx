import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import summariesFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { Attempt, Input, ProjectSummary, QueryCursor, Session, SessionSummary } from '../../../src/generated/domain/models';
import type { CoreError, QueryEnvelope } from '../../../src/generated/core';
import { createDesktopService, immutable, OpenSessions, ServiceFailure, type DesktopTransport, type HintPayloads } from '../../../src/data';
import { deliveryEvidence } from '../../../src/selectors/waiting/delivery';
import { sentRows, waitingRows } from '../../../src/selectors/waiting/rows';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { WaitingColumn } from '../../../src/ui/waiting/WaitingColumn';

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
    if (this.failListener && name === 'ariadne://session_changed') throw new Error('Listener unavailable');
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
  // The column's answer drafts: one preferences read with no saved drafts.
  const drafts = () => {
    transport.push('preferences_get', { api_version: 1, ok: true, data: { kind: 'preferences_get', data: { schema_version: 1, revision: 1,
      global: { theme: 'system', selected_navigation: { kind: 'projects' }, window: null, pinned: false, notification_watermark: null }, sessions: [], later: [], drafts: [] } } } as unknown as QueryEnvelope);
    let id = 0; return new OwnerDraftStore(service, () => inputId(String(50 + ++id)));
  };
  return { transport, store, opened, drafts };
}
/** A session whose waiting item 2 offers two options. */
function withOptions(session = mutableSession()): Session {
  session.items['2']!.options = [{ id: 'yes', label: 'Keep the design', consequence: 'Retain the current contract.', recommended: true },
    { id: 'no', label: 'Change the design', consequence: 'Review a new contract.', recommended: false }];
  return session;
}
const sentRow = (text: string) => screen.getAllByRole('button').find(element => element.classList.contains('waiting-sent') && element.textContent?.includes(text))!;
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
  it.each(['queued', 'in_flight', 'handled'] as const)('a %s answer suppresses the same waiting episode', state => {
    const seed = fixture(), session = seed.session as Session, old = session.inputs[inputId('71')]!;
    old.state = state;
    session.answers.push({ ...session.answers[0], id: inputId('89'), item_id: '2', input_id: old.id, question_revision: 1, supersedes_answer_id: null });
    expect(waitingRows([seed])).toHaveLength(0);
  });
  // A failed delivery needs the owner's decision, so it stays Waiting on me.
  it.each(['cancelled', 'skipped', 'needs_attention'] as const)('a %s answer leaves the current episode waiting', state => {
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
    expect(deliveryEvidence(value, binding, receipts, { ...binding.presence!, execution_state: 'running', freshness: 'fresh' }).kind).toBe('uncertain');
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
  it('live busy presence cannot override persisted terminal and active-conflict facts', () => {
    const value = input(); const running = { ...binding.presence!, freshness: 'fresh' as const,
      generation: binding.generation, connection_state: 'connected' as const, execution_state: 'running' as const };
    value.state = 'handled'; expect(deliveryEvidence(value, binding, {}, running).kind).toBe('handled');
    value.state = 'needs_attention'; value.attempts[0].acceptance = 'uncertain';
    expect(deliveryEvidence(value, binding, {}, running).kind).toBe('uncertain');
    value.state = 'queued'; value.active_attempt_id = null;
    const available = { ...binding, presence: null };
    expect(deliveryEvidence(value, available, {}, { ...running, generation: inputId('99') }).kind).toBe('saved');
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
  it('retries failed listener setup and suppresses late capture after stop', async () => {
    const { store, transport } = setup(); transport.failListener = true; await store.start();
    expect(transport.listeners.get('ariadne://session_changed')?.size ?? 0).toBe(0);
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
  it('keeps the card control and its focus through qualified presence heartbeats without recapturing the queue', async () => {
    const { store, transport, drafts } = setup(), seed = withOptions(), summary = fixture().summary;
    summary.active_binding!.presence = null;
    const queued = seed.inputs[inputId('76')]!; queued.state = 'queued'; queued.active_attempt_id = null;
    // Nothing ahead of it on the binding: its note follows the agent's presence.
    seed.inputs[inputId('72')]!.state = 'handled';
    transport.push('project_list', projectPage()); transport.push('session_list', sessionPage([summary])); transport.push('session_get', loaded(seed));
    await store.start(); const answers = drafts();
    render(<WaitingColumn store={store} drafts={answers} revealItem={vi.fn()} openSession={vi.fn()} />);
    await act(async () => { await answers.load(); });
    const option = screen.getByTitle('Press 2 to select'); option.focus();
    const before = store.getSnapshot(), reads = transport.calls.length;
    const row = sentRow(queued.payload.target_snapshot.item_question!);
    expect(row.textContent).toContain('demo.local hasn’t picked it up yet');
    const active = summary.active_binding!, observation = { ...structuredClone(binding.presence!), freshness: 'fresh' as const,
      generation: active.generation, connection_state: 'connected' as const, execution_state: 'running' as const };
    for (const [index, execution] of ['running', 'idle', 'running'].entries()) {
      await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: active.generation,
        observation: { ...observation, execution_state: execution as 'running' | 'idle', last_seen_at: `2026-10-05T02:05:0${index}.000Z` } }); });
      expect(screen.getByTitle('Press 2 to select')).toBe(option); expect(document.activeElement).toBe(option);
      expect(store.getSnapshot().status).toBe('ready'); expect(store.getSnapshot().waiting).toBe(before.waiting);
      expect(store.getSnapshot().sent).toBe(before.sent); expect(store.getSnapshot().counts).toBe(before.counts);
      expect(row.textContent).toContain(execution === 'running' ? 'Waiting for demo.local to finish what it’s doing' : 'demo.local hasn’t picked it up yet');
      expect(transport.calls).toHaveLength(reads);
    }
    fireEvent.keyDown(option, { key: '2' });
    expect(option.getAttribute('aria-pressed')).toBe('true'); expect(screen.getByRole('button', { name: 'Send answer' })).toBeTruthy();
  });
  it('fences an old question immediately after a durable revision hint until the complete new question is captured', async () => {
    const { store, transport, drafts } = setup(); transport.capture(withOptions()); await store.start(); const answers = drafts();
    render(<WaitingColumn store={store} drafts={answers} revealItem={vi.fn()} openSession={vi.fn()} />);
    await act(async () => { await answers.load(); });
    const send = () => screen.getByRole('button', { name: 'Send answer' });
    expect(send().hasAttribute('disabled')).toBe(false);
    const changed = withOptions(), summary = fixture().summary;
    changed.revision++; summary.revision = changed.revision;
    changed.items['2']!.question_revision++; changed.items['2']!.question = 'The revised current question';
    const pending = deferred<QueryEnvelope>();
    transport.push('project_list', pending.promise); transport.push('session_list', sessionPage([summary]), sessionPage([summary]), sessionPage([summary]));
    transport.push('session_get', loaded(changed), loaded(changed));
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: demo.id, revision: changed.revision }); });
    expect(store.getSnapshot().status).toBe('stale'); expect(send().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Refresh is pending/)).toBeTruthy();
    const active = summary.active_binding!;
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: active.generation,
      observation: { ...structuredClone(binding.presence!), generation: active.generation, last_seen_at: '2026-10-05T02:05:00.000Z' } }); });
    expect(store.getSnapshot().status).toBe('stale'); expect(send().hasAttribute('disabled')).toBe(true);
    await act(async () => { pending.resolve(projectPage()); await store.refresh(); });
    expect(store.getSnapshot().status).toBe('ready'); expect(screen.getByText(changed.items['2']!.question)).toBeTruthy();
    // The untouched draft follows the new question; no review is asked for.
    expect(screen.queryByText(/This item changed/)).toBeNull();
    expect(Object.values(answers.getSnapshot().entries).map(entry => entry.draft.question_revision)).toEqual([2]);
  });
  it('renders live scoped session presence when catalogue summaries have no observation', async () => {
    const { store, transport, opened, drafts } = setup(), seed = mutableSession();
    const summary = fixture().summary; summary.active_binding!.presence = null;
    const queued = seed.inputs[inputId('76')]!;
    queued.state = 'queued'; queued.active_attempt_id = null; seed.inputs[inputId('72')]!.state = 'handled';
    transport.push('project_list', projectPage()); transport.push('session_list', sessionPage([summary])); transport.push('session_get', loaded(seed));
    await store.start(); render(<WaitingColumn store={store} drafts={drafts()} revealItem={vi.fn()} openSession={vi.fn()} />);
    const row = sentRow(queued.payload.target_snapshot.item_question!), saved = 'demo.local hasn’t picked it up yet';
    expect(row.textContent).toContain(saved);
    const active = summary.active_binding!, running = { ...structuredClone(binding.presence!), freshness: 'fresh' as const,
      generation: active.generation, connection_state: 'connected' as const, execution_state: 'running' as const };
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: active.generation, observation: running }); });
    expect(row.textContent).toContain('Waiting for demo.local to finish what it’s doing');
    expect(opened.open(route).getSnapshot().presence[active.id].execution_state).toBe('running');
    expect(store.getSnapshot().sessions[0].summary.active_binding!.presence).toBeNull();
    for (const observation of [
      { ...running, freshness: 'stale' as const }, { ...running, freshness: 'unknown' as const },
      { ...running, execution_state: 'unknown' as const },
    ]) {
      await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: active.generation, observation }); });
      expect(row.textContent).toContain(saved);
      expect(row.textContent).not.toContain('Idle');
    }
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: inputId('99'),
      observation: { ...running, generation: inputId('99') } }); });
    expect(row.textContent).toContain(saved);
    const captured = store.getSnapshot(); store.stop();
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: active.generation, observation: running }); });
    expect(store.getSnapshot()).toBe(captured);
  });
  it('routes waiting/current and original Sent targets, including a topic-only input', async () => {
    const { store, transport, drafts } = setup(); transport.capture(); await store.start();
    const reveal = vi.fn(), open = vi.fn();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={reveal} openSession={open} />);
    expect(screen.getByText('Waiting on me')).toBeTruthy(); expect(screen.getByText('Oldest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' })); expect(reveal).toHaveBeenCalledWith({ ...route, item_id: '2' });
    expect(screen.getByText(/^Waiting .* · asked in #\d+$/)).toBeTruthy();
    // The topic-only input opens the registered session, never an invented item.
    fireEvent.keyDown(sentRow('Continued context'), { key: 'Enter' }); expect(open).toHaveBeenCalledWith(route);
    fireEvent.click(sentRow('Implement receipt lookup')); expect(reveal).toHaveBeenLastCalledWith({ ...route, item_id: '3' });
    expect(document.querySelector('.waiting-sent-label')?.textContent).toBe('Sent· waiting for the agent to pick up');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('shows incomplete data and the frozen Sent label instead of a false all-clear state', async () => {
    const { store, transport, drafts } = setup(), seed = mutableSession();
    const followup = seed.inputs[inputId('74')]!; followup.kind = 'answer'; followup.payload.selected_option_id = 'frozen';
    followup.payload.target_snapshot.options = [{ id: 'frozen', label: 'Old choice', consequence: 'Old consequence', recommended: false }];
    const sessions = sessionPage(); if (sessions.ok && sessions.data.kind === 'session_list') {
      sessions.data.data.counts.completeness = 'partial'; sessions.data.data.counts.unavailable_session_ids = [inputId('99')];
    }
    const projects = projectPage(); if (projects.ok && projects.data.kind === 'project_list' && sessions.ok && sessions.data.kind === 'session_list') projects.data.data.counts = structuredClone(sessions.data.data.counts);
    transport.push('project_list', projects); transport.push('session_list', sessions); transport.push('session_get', loaded(seed)); await store.start();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={vi.fn()} openSession={vi.fn()} />);
    expect(screen.getByText(/Queue counts are incomplete/)).toBeTruthy();
    expect(screen.getByText(`Unavailable session ${inputId('99')}`)).toBeTruthy();
    expect(screen.queryByText('Nothing waiting on you')).toBeNull();
    const stopped = sentRow('Replace the old retry question');
    expect(stopped.textContent).toMatch(/You sent “Old choice”/);
    expect(stopped.textContent).toMatch(/Couldn’t deliver “Old choice”\. /);
  });
  it('deletes a queued Sent message from its row without opening it; a drop request has no words, so no Edit', async () => {
    const { store, transport, drafts } = setup(); transport.capture(); await store.start();
    const open = vi.fn(), reveal = vi.fn();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={reveal} openSession={open} />);
    const row = sentRow('Record retry limits');
    expect(row.textContent).toContain('Queued behind your message on “Implement receipt lookup”');
    // Not sent yet: Delete (input 76 is a drop request, which has no text to edit), never Cancel message.
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Cancel message' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const cancel = transport.calls.find(call => call.name === 'input_cancel')!.request as { command: { params: unknown } };
    expect(cancel.command.params).toEqual({ input_id: inputId('76'), expected_revision: demo.revision });
    expect(reveal).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('says why a queued Sent message is not sending while the supervisor backs off, and clears once it runs again', async () => {
    const { store, transport, drafts } = setup(); transport.capture(); await store.start();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={vi.fn()} openSession={vi.fn()} />);
    const row = () => sentRow('Record retry limits'), binding = (demo as unknown as Session).bindings[(demo as unknown as Session).active_binding_id!]!;
    await waitFor(() => expect(transport.listeners.get('ariadne://supervisor_health')?.size).toBe(1));
    const health = { binding_id: binding.id, generation: binding.generation, state: 'backing_off' as const, reason: 'codex exited', retry_in_seconds: 30,
      updated_at: new Date().toISOString() };
    act(() => { transport.emit('ariadne://supervisor_health', health); });
    await waitFor(() => expect(row().textContent).toMatch(/Not sending: codex exited · retrying in \d+s/));
    act(() => { transport.emit('ariadne://supervisor_health', { ...health, state: 'running', reason: null, retry_in_seconds: null, updated_at: new Date(Date.now() + 1_000).toISOString() }); });
    await waitFor(() => expect(row().textContent).toContain('Queued behind your message on “Implement receipt lookup”'));
  });
  it('cancels an in-flight Sent message too, keeping its delivery line', async () => {
    const { store, transport, drafts } = setup(); transport.capture(); await store.start();
    const open = vi.fn(), reveal = vi.fn();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={reveal} openSession={open} />);
    const row = sentRow('Implement receipt lookup');
    expect(row.querySelector('.waiting-sent-line')).toBeTruthy();
    expect(row.querySelector('[data-stuck="sent"]')).toBeTruthy();
    // On its way: it can be called back, not edited or deleted.
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull(); expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel message' }));
    const cancel = transport.calls.find(call => call.name === 'input_cancel')!.request as { command: { params: unknown } };
    expect(cancel.command.params).toEqual({ input_id: inputId('72'), expected_revision: demo.revision });
    expect(reveal).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('retries a stopped Sent message in one click, as the owner’s word that the agent is idle', async () => {
    const { store, transport, drafts } = setup(); transport.capture(); await store.start();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={vi.fn()} openSession={vi.fn()} />);
    const row = sentRow('Replace the old retry question');
    expect(row.textContent).toContain('Couldn’t deliver “Followup request for item 7. Preserve…”. Ariadne isn’t sure it reached demo.local.');
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    const resolve = transport.calls.find(call => call.name === 'input_resolve')!.request as { command: { params: Record<string, unknown> } };
    expect(resolve.command.params).toMatchObject({ input_id: inputId('74'), attempt_id: inputId('63'), decision: 'resend', reason: '',
      evidence: { source: 'owner_attestation', owner_attested_idle: true } });
  });
  it('marks a stopped Sent message done in one click, and cancels it too', async () => {
    const { store, transport, drafts } = setup(); transport.capture(); await store.start();
    const reveal = vi.fn();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={reveal} openSession={vi.fn()} />);
    const row = sentRow('Replace the old retry question');
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as done' }));
    const skip = transport.calls.find(call => call.name === 'input_resolve')!.request as { command: { params: Record<string, unknown> } };
    expect(skip.command.params).toMatchObject({ input_id: inputId('74'), attempt_id: inputId('63'), decision: 'skip', reason: '',
      evidence: { source: 'owner_attestation', owner_attested_idle: true } });
    expect(reveal).not.toHaveBeenCalled();
    // Core (rule B) cancels any message that hasn't settled, a stopped one included.
    expect(within(row).getByRole('button', { name: 'Cancel message' })).toBeTruthy();
  });
  it('leaves the questions of an archived topic out of Waiting on me, and brings them back on restore', () => {
    const seed = fixture(), session = seed.session as Session, topic = session.topics[session.items['2']!.topic_id]!;
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
    topic.archived_at = session.updated_at;
    // Archive leaves the item's status as it is; only the panel stops counting it.
    expect(session.items['2']!.status).toBe('waiting_on_me'); expect(waitingRows([seed])).toHaveLength(0);
    topic.archived_at = null;
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
  });
  it('leaves a question the owner replied to out of Waiting on me', () => {
    const seed = fixture(), session = seed.session as Session, reply = session.inputs[inputId('76')]!;
    reply.target = { ...reply.target, item_id: '2' }; reply.kind = 'reply';
    expect(waitingRows([seed])).toHaveLength(0);
    reply.state = 'cancelled';
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
  });
  it('keeps a failed answer to the still-open question on its Waiting card, with the owner’s fix', async () => {
    const { store, transport, drafts } = setup(), seed = withOptions(), failed = seed.inputs[inputId('74')]!;
    failed.kind = 'answer'; failed.target = { ...failed.target, item_id: '2' }; failed.payload.selected_option_id = 'yes';
    failed.payload.target_snapshot = { ...failed.payload.target_snapshot, question_revision: seed.items['2']!.question_revision, options: seed.items['2']!.options };
    // The agent turned it down: a failed delivery, not an uncertain one.
    const tried = failed.attempts.find(value => value.id === failed.active_attempt_id)!; tried.acceptance = 'rejected'; tried.error = null;
    transport.capture(seed); await store.start();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={vi.fn()} openSession={vi.fn()} />);
    // The failed answer leaves it Waiting on me: one card, carrying the failed delivery, and no Sent row.
    const cards = [...document.querySelectorAll('.waiting-card')].filter(card => card.textContent?.includes('Keep the design'));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('Couldn’t deliver “Keep the design”');
    expect(screen.getAllByRole('button').some(element => element.classList.contains('waiting-sent') && element.textContent?.includes('Keep the design'))).toBe(false);
  });
  it('warns on the card that sending is paused, with Resume', async () => {
    const { store, transport, drafts } = setup(), seed = mutableSession();
    seed.bindings[seed.active_binding_id!]!.owner_paused = true;
    transport.capture(seed); await store.start();
    render(<WaitingColumn store={store} drafts={drafts()} revealItem={vi.fn()} openSession={vi.fn()} />);
    const note = document.querySelector('.waiting-card [data-dispatch-note="paused"]')!;
    expect(note.textContent).toContain('Sending is paused — your message waits here until you resume.');
    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: 'Resume' }));
    expect(transport.calls.some(call => call.name === 'binding_resume')).toBe(true);
  });
  it('keeps stale rows but blocks sending after a read failure', async () => {
    const { store, transport, drafts } = setup(); transport.capture(withOptions()); await store.start(); const answers = drafts();
    render(<WaitingColumn store={store} drafts={answers} revealItem={vi.fn()} openSession={vi.fn()} />);
    await act(async () => { await answers.load(); });
    expect(screen.getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(false);
    transport.push('project_list', { api_version: 1, ok: false, error });
    await act(async () => { await store.refresh(); });
    expect(screen.getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Ariadne couldn’t read or save its data. Try again.')).toBeTruthy(); expect(screen.queryByText(error.hint)).toBeNull();
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh queue' })).toBeTruthy();
  });
  it('shows the empty state, the loading skeleton and the selected ring', async () => {
    const { store, transport, drafts } = setup(), seed = mutableSession(); seed.items['2']!.status = 'in_progress';
    const answers = drafts();
    const view = render(<WaitingColumn store={store} drafts={answers} revealItem={vi.fn()} openSession={vi.fn()} />);
    expect(screen.getAllByLabelText('Loading waiting questions')).toHaveLength(2); expect(screen.getByText('–')).toBeTruthy();
    transport.capture(seed); await act(async () => { await store.start(); });
    expect(screen.getByText('Nothing waiting on you')).toBeTruthy(); expect(screen.getByText('New questions from the agent will appear here.')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    view.unmount();
  });
  it('rings the selected card and offers preference reconciliation', async () => {
    const { store, transport, drafts } = setup(); transport.capture(withOptions()); await store.start(); const answers = drafts();
    const view = render(<WaitingColumn store={store} drafts={answers} revealItem={vi.fn()} openSession={vi.fn()} />);
    await act(async () => { await answers.load(); });
    expect(document.querySelector('[data-waiting-item="2"]')?.getAttribute('aria-current')).toBeNull();
    view.rerender(<WaitingColumn store={store} drafts={answers} revealItem={vi.fn()} openSession={vi.fn()} selected={{ ...route, item_id: '2' }} />);
    expect(document.querySelector('[data-waiting-item="2"]')?.getAttribute('aria-current')).toBe('true');
    // A preference write that cannot be confirmed locks the drafts until it is retried.
    drafts(); transport.push('preferences_patch', { api_version: 1, ok: false, error: { ...error, code: 'commit_uncertain' } });
    fireEvent.click(screen.getByTitle('Press 2 to select'));
    expect(await screen.findByRole('button', { name: 'Try saving your draft again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(true);
  });
});
