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
import { AnswerDock, OtherSessionQuestions } from '../../../src/ui/dock/AnswerDock';
import { StuckNote } from '../../../src/ui/answer/StuckNote';
import { stuckInput } from '../../../src/selectors/waiting/stuck';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { AppTransport, secondId } from '../app/transport';

const route = { project_id: demo.project_id, session_id: demo.id };
function fixture(): { session: Session; project: ProjectSummary; summary: SessionSummary } {
  return { session: structuredClone(demo) as Session, project: structuredClone(projectsFixture.items[0]) as ProjectSummary,
    summary: structuredClone(summariesFixture.items[0]) as SessionSummary };
}
const mutableSession = () => structuredClone(demo) as Session;
const inputId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
/** A button that does nothing: disabled, or only aria-disabled when the view is stale (so it keeps the focus it holds). */
const held = (button: HTMLElement) => button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';
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
  return envelope({ kind: 'session_list', data: { counts: structuredClone(counts), active_total: 1, closed_total: 0, archived_total: 0,
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
  // Shared answer drafts: one preferences read with no saved drafts.
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
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); stores.splice(0).forEach(store => store.stop()); sessions.splice(0).forEach(opened => opened.closeAll()); vi.useRealTimers(); });

describe('current Waiting and immutable Sent selection', () => {
  it.each(['closed', 'archived'] as const)('excludes %s sessions from waiting without changing their questions', state => {
    const seed = fixture();
    seed.session.state = 'closed';
    if (state === 'archived') seed.session.archived_at = seed.session.updated_at;
    const before = structuredClone(seed.session);
    expect(waitingRows([seed])).toEqual([]);
    expect(seed.session).toEqual(before);
  });
  it('excludes closed-session question inputs from Sent while retaining generic recovery messages', () => {
    const seed = fixture(), questionInput = seed.session.inputs[inputId('74')]!;
    questionInput.target.item_id = '2';
    expect(sentRows([seed]).some(row => row.input.id === questionInput.id)).toBe(true);
    seed.session.state = 'closed';
    const rows = sentRows([seed]);
    expect(rows.some(row => row.input.id === questionInput.id)).toBe(false);
    expect(rows.some(row => row.route === null)).toBe(true);
    expect(questionInput.state).toBe('needs_attention');
  });
  it('keeps a closed session question out of Waiting and its count while preserving its saved draft and history', async () => {
    const { store, transport, drafts: loadDrafts } = setup(), seed = withOptions();
    seed.state = 'closed';
    transport.capture(seed); await store.start();
    const drafts = loadDrafts(); await drafts.load();
    const entry = drafts.begin(seed, '2', 'answer')!;
    drafts.edit(entry, { text: 'Keep this draft', selected_option_id: 'yes' });
    expect(store.getSnapshot().waiting).toEqual([]);
    expect(store.getSnapshot().waiting).toHaveLength(0);
    expect(store.getSnapshot().sessions[0].session.items['2']!.status).toBe('waiting_on_me');
    expect(store.getSnapshot().sessions[0].session.items['2']!.question).toBe(seed.items['2']!.question);
    expect(drafts.find(route, '2', 'answer')?.draft.text).toBe('Keep this draft');
  });
  it.each(['closed', 'archived'] as const)('keeps an answered %s question out of Waiting', async state => {
    const { store, transport, drafts: loadDrafts } = setup(), seed = withOptions();
    const answer = structuredClone(seed.answers[seed.answers.length - 1]!);
    answer.id = crypto.randomUUID(); answer.item_id = '2'; answer.question_revision = seed.items['2']!.question_revision;
    answer.input_id = inputId('71'); seed.answers.push(answer);
    seed.state = 'closed';
    if (state === 'archived') seed.archived_at = seed.updated_at;
    transport.capture(seed); await store.start();
    const drafts = loadDrafts(); await drafts.load();
    expect(store.getSnapshot().waiting).toEqual([]);
  });
  it.each(['bring', 'reopen'] as const)('a handled %s requests an ask without answering it', kind => {
    const seed = fixture(), old = seed.session.inputs[inputId('71')]!;
    old.kind = kind; old.payload.intent = kind;
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
  });
  it.each(['answer', 'reply', 'note', 'followup', 'drop'] as const)('a handled %s leaves the waiting question answerable', kind => {
    const seed = fixture(), session = seed.session, old = session.inputs[inputId('71')]!;
    old.kind = kind; old.payload.intent = kind;
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
    ++session.items['2']!.question_revision;
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
    old.payload.target_snapshot.question_revision = session.items['2']!.question_revision;
    expect(waitingRows([seed]).map(row => row.item.id)).toEqual(['2']);
  });
  it('keeps the question answerable after the agent explains an owner follow-up', async () => {
    const { store, transport } = setup(), seed = withOptions(), reply = seed.inputs[inputId('71')]!;
    reply.kind = 'reply'; reply.payload.intent = 'reply'; reply.payload.text = 'What does B mean?';
    const agentReply = structuredClone(seed.messages.find(message => message.author === 'agent')!);
    agentReply.id = inputId('99'); agentReply.item_id = '2'; agentReply.kind = 'reply'; agentReply.body = 'B means changing the design.';
    seed.messages.push(agentReply);
    transport.capture(seed); await store.start();
    expect(store.getSnapshot().waiting.map(row => row.item.id)).toEqual(['2']);
    expect(store.getSnapshot().waiting[0].item.options).toEqual(seed.items['2']!.options);
  });
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
    ['stopped', { turn_state: 'interrupted' }],
    ['failed', { turn_state: 'interrupted', acceptance: 'prepared', host_turn_id: null }],
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

describe('waiting episode selection', () => {
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
});


async function dockUI(configure: (transport: AppTransport) => void = () => {}) {
  const transport = new AppTransport();
  withOptions(transport.sessions.get(route.session_id)!);
  configure(transport);
  const service = createDesktopService(transport), opened = new OpenSessions(service), waiting = new WaitingStore(service, opened);
  stores.push(waiting); sessions.push(opened);
  await waiting.start();
  const drafts = new OwnerDraftStore(service); await drafts.load();
  const current = opened.open(route), onHeight = vi.fn();
  const view = render(<AnswerDock store={current} waiting={waiting} drafts={drafts} onHeight={onHeight} />);
  return { transport, opened, waiting, drafts, current, onHeight, view };
}
const dock = () => screen.getByRole('region', { name: 'Answer dock' });
const openDock = () => fireEvent.click(within(dock()).getByRole('button', { name: /waiting on you/ }));
const option = (index: number) => dock().querySelector<HTMLButtonElement>(`[data-answer-option="${index}"]`)!;
const send = () => dock().querySelector<HTMLButtonElement>('[data-answer-send]')!;
function answerInput(session: Session, suffix: string) {
  const value = session.inputs[inputId(suffix)]!;
  value.kind = 'answer'; value.payload.intent = 'answer';
  return value;
}
function otherSession(transport: AppTransport) {
  const second = structuredClone(transport.sessions.get(route.session_id)!);
  second.id = secondId; second.title = 'Separate session'; second.items['2']!.question = 'Other session decision';
  transport.sessions.set(secondId, second);
  return second;
}

describe('source-backed answer dock', () => {
  it('starts as a folded current-session count and stays folded when a new question arrives', async () => {
    const { transport, current, drafts } = await dockUI();
    expect(within(dock()).getByRole('button', { name: '1 waiting on you' })).toBeTruthy();
    expect(dock().hasAttribute('data-open')).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(Object.keys(drafts.getSnapshot().entries)).toHaveLength(0);
    const seed = transport.sessions.get(route.session_id)!;
    seed.items['10'] = { ...structuredClone(seed.items['2']!), id: '10', ordinal: 10, question: 'A newly arrived decision' };
    seed.revision++;
    await act(async () => { await current.refresh(); });
    expect(within(dock()).getByRole('button', { name: '2 waiting on you' })).toBeTruthy();
    expect(dock().hasAttribute('data-open')).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('opens the oldest question explicitly with no recommended option selected and pages locally', async () => {
    const { transport } = await dockUI(transport => {
      const seed = transport.sessions.get(route.session_id)!;
      seed.items['10'] = { ...structuredClone(seed.items['2']!), id: '10', ordinal: 10, question: 'Later question', waiting_since: '2026-10-10T00:00:00Z' };
    });
    openDock();
    await waitFor(() => expect(option(0)).toBeTruthy());
    expect(option(0).getAttribute('aria-pressed')).toBe('false');
    expect(option(1).getAttribute('aria-pressed')).toBe('false');
    expect(send().disabled).toBe(true);
    expect((within(dock()).getByLabelText('Question pager') as HTMLSelectElement).value).toBe('2:1');
    fireEvent.click(within(dock()).getByRole('button', { name: 'Next question' }));
    expect((within(dock()).getByLabelText('Question pager') as HTMLSelectElement).value).toBe('10:1');
    expect(transport.queries.some(query => query.request.command === 'reveal_item')).toBe(false);
    fireEvent.click(within(dock()).getByRole('button', { name: 'Fold the dock' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('groups other sessions behind an explicit control without selecting or navigating the Map', async () => {
    const { transport } = await dockUI(otherSession);
    expect(within(dock()).getByRole('button', { name: '1 waiting on you' })).toBeTruthy();
    fireEvent.click(within(dock()).getByRole('button', { name: '1 in other sessions' }));
    const others = document.querySelector<HTMLElement>('[aria-label="Questions in other sessions"]')!;
    expect(within(others).getByRole('heading', { name: /Separate session/ })).toBeTruthy();
    expect(within(others).getByText('Other session decision')).toBeTruthy();
    expect(within(others).queryByText(transport.sessions.get(route.session_id)!.items['2']!.question)).toBeNull();
    expect(within(dock()).queryByRole('combobox', { name: 'Question pager' })).toBeNull();
    expect(transport.queries.some(query => query.request.command === 'reveal_item')).toBe(false);
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'all_sessions' });
  });

  it('sends an other-session answer to its original session and item without navigation', async () => {
    const { transport } = await dockUI(otherSession);
    fireEvent.click(within(dock()).getByRole('button', { name: '1 in other sessions' }));
    await waitFor(() => expect(option(0)?.disabled).toBe(false));
    fireEvent.click(option(0));
    await waitFor(() => expect(send()?.disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(true));
    expect(transport.mutations.find(request => request.command.command === 'input_submit')).toMatchObject({
      session: { ...route, session_id: secondId }, command: { params: { target: { item_id: '2' }, selected_option_id: 'yes' } },
    });
    expect(transport.queries.some(query => query.request.command === 'reveal_item')).toBe(false);
  });

  it('keeps option identity and focus through qualified presence heartbeats without recapturing the queue', async () => {
    const { transport, waiting, current } = await dockUI(); openDock();
    await waitFor(() => expect(option(1)?.disabled).toBe(false));
    const button = option(1); button.focus();
    const before = waiting.getSnapshot(), reads = transport.queries.length;
    const active = current.getSnapshot().snapshot!.session.bindings[demo.active_binding_id!]!;
    for (const [index, execution] of ['running', 'idle', 'running'].entries()) {
      await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: active.id, generation: active.generation,
        observation: { ...structuredClone(binding.presence!), generation: active.generation, freshness: 'fresh', connection_state: 'connected',
          execution_state: execution as 'running' | 'idle', last_seen_at: `2026-10-05T02:05:0${index}.000Z` } }); });
      expect(option(1)).toBe(button); expect(document.activeElement).toBe(button);
      expect(waiting.getSnapshot().waiting).toBe(before.waiting);
      expect(waiting.getSnapshot().sent).toBe(before.sent); expect(waiting.getSnapshot().counts).toBe(before.counts);
      expect(current.getSnapshot().presence[active.id].execution_state).toBe(execution);
      expect(transport.queries).toHaveLength(reads);
    }
  });

  it('fences an old question after a durable hint until its complete replacement is read', async () => {
    const { transport, current, drafts } = await dockUI(); openDock();
    await waitFor(() => expect(option(0)?.disabled).toBe(false));
    const seed = transport.sessions.get(route.session_id)!;
    const gate = deferred<void>(), invoke = transport.invoke.bind(transport);
    const spy = vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') await gate.promise;
      return invoke(name, args);
    });
    seed.revision++; seed.items['2']!.question_revision++; seed.items['2']!.revision++;
    seed.items['2']!.question = 'The revised current question';
    seed.rounds[seed.items['2']!.current_round_id!]!.question_revision = seed.items['2']!.question_revision;
    try {
      await act(async () => { transport.emit('ariadne://session_changed', { session_id: seed.id, revision: seed.revision }); });
      expect(current.getSnapshot().status).toBe('stale'); expect(held(option(0))).toBe(true);
      fireEvent.click(option(0)); fireEvent.click(send());
      expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
      await act(async () => { gate.resolve(); await current.refresh(); });
      await waitFor(() => expect(current.getSnapshot().status).toBe('ready'));
      expect(dock().querySelector('.answer-dock-content > p')?.textContent).toContain('The revised current question');
      expect(held(option(0))).toBe(false);
      expect(screen.queryByText(/This item changed/)).toBeNull();
      expect(Object.values(drafts.getSnapshot().entries).every(entry => entry.draft.question_revision === 2)).toBe(true);
    } finally { gate.resolve(); spy.mockRestore(); }
  });

  it('keeps the last question and typed words while a session read fails, and blocks sending', async () => {
    const { transport, current } = await dockUI(); openDock();
    await waitFor(() => expect(option(0)?.disabled).toBe(false));
    const text = within(dock()).getByRole('textbox');
    fireEvent.change(text, { target: { value: 'Keep these words' } });
    await waitFor(() => expect(send().disabled).toBe(false));
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') throw new Error('Unavailable');
      return invoke(name, args);
    });
    await act(async () => { await current.refresh(); });
    expect(held(send())).toBe(true);
    expect((text as HTMLTextAreaElement).value).toBe('Keep these words');
    expect(within(dock()).getByText('The session is unavailable or stale. Refresh before sending.')).toBeTruthy();
    fireEvent.click(send());
    expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
  });

  it('locks sending and offers reconciliation when a draft preference write is uncertain', async () => {
    const { transport } = await dockUI(); openDock();
    await waitFor(() => expect(option(0)?.disabled).toBe(false));
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => name === 'preferences_patch'
      ? { api_version: 1, ok: false, error: { ...error, code: 'commit_uncertain' } }
      : invoke(name, args));
    fireEvent.click(option(0));
    expect(await screen.findByRole('button', { name: 'Try saving your draft again' })).toBeTruthy();
    expect(send().disabled).toBe(true);
    expect(transport.mutations.some(request => request.command.command === 'input_submit')).toBe(false);
  });

  it('explains an incomplete other-session refresh while retaining the last questions', async () => {
    const { store, transport, drafts } = setup(); transport.capture(withOptions()); await store.start();
    render(<OtherSessionQuestions waiting={store} drafts={drafts()} currentSession="another-session" onClose={vi.fn()} />);
    transport.push('project_list', { api_version: 1, ok: false, error });
    await act(async () => { await store.refresh(); });
    expect(screen.getByText('Some sessions could not be read. Showing the last questions.')).toBeTruthy();
    expect(screen.getByText(demo.items['2'].question)).toBeTruthy();
    expect(screen.queryByText(error.hint)).toBeNull();
  });

  it('keeps persisted original answer words and delivery in the Sent summary without a saved draft receipt', async () => {
    const { transport } = await dockUI(transport => {
      const seed = transport.sessions.get(route.session_id)!, value = answerInput(seed, '76');
      value.payload.text = '  exact original words  '; value.payload.selected_option_id = 'old';
      value.payload.target_snapshot.options = [{ id: 'old', label: 'Original choice', consequence: 'Old consequence', recommended: false }];
      seed.items['4']!.options = [{ id: 'new', label: 'Current choice', consequence: '', recommended: false }];
    });
    fireEvent.click(within(dock()).getByRole('button', { name: /sent$/ }));
    const sent = document.querySelector<HTMLElement>('[aria-label="Sent answers"]')!;
    const delivery = [...sent.querySelectorAll<HTMLElement>('.question-delivery')].find(element => element.textContent?.includes('exact original words'))!;
    expect(delivery.querySelector('.question-sent-words')!.textContent).toBe('Original choice\n\n  exact original words  ');
    expect(within(delivery).getByRole('button', { name: 'Copy answer' })).toBeTruthy();
    expect(within(delivery).getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(transport.preferences.drafts).toEqual([]);
  });

  it('checks an uncertain persisted delivery without retrying or submitting another answer', async () => {
    const { transport, current } = await dockUI(transport => { answerInput(transport.sessions.get(route.session_id)!, '74'); });
    fireEvent.click(within(dock()).getByRole('button', { name: /sent$/ }));
    const sent = document.querySelector<HTMLElement>('[aria-label="Sent answers"]')!;
    const delivery = [...sent.querySelectorAll<HTMLElement>('.question-delivery')].find(element => element.textContent?.includes('Followup request'))!;
    expect(within(delivery).getByText('Checking delivery. Your answer is kept.')).toBeTruthy();
    expect(within(delivery).queryByRole('button', { name: 'Retry' })).toBeNull();
    const reads = transport.queries.length;
    fireEvent.click(within(delivery).getByRole('button', { name: 'Check delivery' }));
    await waitFor(() => expect(current.getSnapshot().status).toBe('ready'));
    expect(transport.queries.length).toBeGreaterThan(reads);
    expect(transport.mutations.filter(request => ['input_submit', 'input_resolve'].includes(request.command.command))).toEqual([]);
  });
});

// The dock changes where answers live; generic recovery still uses these shared
// controls and preserves the original input/session rather than the visible question.
describe('shared original-input recovery', () => {
  async function recovery(seed = mutableSession(), suffix = '74') {
    const { store, transport, opened } = setup(); transport.capture(seed); await store.start();
    const service = createDesktopService(transport), actions = new SessionActionControllers(service).forSession(opened.open(route));
    const session = opened.open(route).getSnapshot().snapshot!.session, value = session.inputs[inputId(suffix)]!;
    render(<StuckNote actions={actions} input={value} stuck={stuckInput(session, value)!} />);
    return { store, transport, value };
  }
  it('retains original item and topic-only Sent targets as canonical routes', () => {
    const sent = sentRows([fixture()]);
    expect(sent.find(row => row.input.id === inputId('72'))!.route).toEqual({ ...route, item_id: '3' });
    expect(sent.find(row => row.input.id === inputId('77'))).toMatchObject({ route: null, session: route });
    expect(sent.find(row => row.input.id === inputId('74'))!.input.payload.target_snapshot.item_question).toBe('Replace the old retry question');
  });
  it('deletes an unclaimed queued original input with its original revision and no item rerouting', async () => {
    const { transport } = await recovery(mutableSession(), '76');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel message' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const request = transport.calls.find(call => call.name === 'input_cancel')!.request;
    expect(request).toMatchObject({ session: route, command: { params: { input_id: inputId('76'), expected_revision: demo.revision } } });
  });
  it('cancels a prepared input before receipt using its original route', async () => {
    const seed = mutableSession(), attempt = seed.inputs[inputId('72')]!.attempts[0]!;
    attempt.acceptance = 'prepared'; attempt.host_turn_id = null; attempt.turn_state = 'unknown';
    const { transport } = await recovery(seed, '72');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel message' }));
    expect(transport.calls.find(call => call.name === 'input_cancel')!.request).toMatchObject({ session: route,
      command: { params: { input_id: inputId('72'), expected_revision: demo.revision } } });
  });
  it('offers no cancellation after the agent receives the input', async () => {
    await recovery(mutableSession(), '72');
    expect(screen.queryByRole('button', { name: 'Cancel message' })).toBeNull();
  });
  it('retries a definitely rejected delivery with owner-idle evidence on its original input', async () => {
    const seed = mutableSession(), failed = seed.inputs[inputId('74')]!;
    failed.attempts.find(value => value.id === failed.active_attempt_id)!.acceptance = 'rejected';
    const { transport } = await recovery(seed);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(transport.calls.find(call => call.name === 'input_resolve')!.request).toMatchObject({ session: route, command: { params: {
      input_id: inputId('74'), attempt_id: inputId('63'), decision: 'resend', reason: '',
      evidence: { source: 'owner_attestation', owner_attested_idle: true },
    } } });
  });
  it('resumes a paused original binding through the shared recovery control', async () => {
    const seed = mutableSession(); seed.bindings[seed.active_binding_id!]!.owner_paused = true;
    const { transport } = await recovery(seed, '76');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(transport.calls.find(call => call.name === 'binding_resume')!.request).toMatchObject({ session: route,
      command: { params: { binding_id: seed.active_binding_id } } });
  });
  it('marks an uncertain original input done with explicit owner-idle evidence', async () => {
    const { transport } = await recovery();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as done' }));
    expect(transport.calls.find(call => call.name === 'input_resolve')!.request).toMatchObject({ session: route, command: { params: {
      input_id: inputId('74'), attempt_id: inputId('63'), decision: 'skip', reason: '',
      evidence: { source: 'owner_attestation', owner_attested_idle: true },
    } } });
    expect(screen.getByRole('button', { name: 'Cancel message' })).toBeTruthy();
  });
});
