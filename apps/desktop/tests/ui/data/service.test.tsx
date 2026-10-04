import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import demo from '../../../../../fixtures/domain/demo/session.json';
import presenceFixture from '../../../../../fixtures/domain/demo/presence.json';
import summaries from '../../../../../fixtures/domain/projections/sessions.json';
import cases from '../../../../../fixtures/contracts/core/cases.json';
import inventory from '../../../../../fixtures/contracts/core/inventory.json';
import type { Session, SessionSummary } from '../../../src/generated/domain/models';
import type {
  CoreError, ItemRoute, MutationEnvelope, OwnerMutationRequest, QueryEnvelope,
  SessionListResult, SessionRef, SessionSnapshot,
} from '../../../src/generated/core';
import {
  CoreFailure, createDesktopService, immutable, indexSession, OpenSessions,
  RegisteredRoutes, revealAncestors, ServiceFailure, summaryCounts, useSession,
  type DesktopTransport, type HintPayloads, type SessionStore,
} from '../../../src/data';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(revision = 21): SessionSnapshot {
  const session = structuredClone(demo) as Session;
  session.revision = revision;
  return { session, freshness: 'fresh' };
}
const route: SessionRef = { project_id: demo.project_id, session_id: demo.id };
const itemRoute: ItemRoute = { ...route, item_id: '1.1' };
function success(data: Extract<QueryEnvelope, { ok: true }>['data']): QueryEnvelope {
  return { api_version: 1, ok: true, data };
}
const loaded = (revision = 21) => success({ kind: 'session_get', data: snapshot(revision) });
const presenceList = () => ({ sessions: structuredClone(summaries) as SessionListResult['sessions'], active_total: 1, closed_total: 0,
  counts: structuredClone(summaries.items[0].counts) as SessionListResult['counts'] });
const coreError: CoreError = { code: 'io_error', message: 'Registered directory is inaccessible.', hint: 'Check local access.', retryable: false, field_errors: [] };
const ownerStep = cases.cases[0].steps[0] as unknown as { request: OwnerMutationRequest['command']; response: Extract<MutationEnvelope, { ok: true }> };

// A bounded transport script, using the canonical envelopes and fixtures. It
// provides no domain transitions, persistence, provider simulation or fallback.
class Transport implements DesktopTransport {
  readonly calls: { name: string; request: unknown }[] = [];
  readonly listeners = new Map<keyof HintPayloads, (hint: never) => void>();
  readonly unsubscribed: string[] = [];
  readonly script: (QueryEnvelope | MutationEnvelope | Error | Promise<QueryEnvelope>)[] = [];
  readonly presenceScript: (QueryEnvelope | Error | Promise<QueryEnvelope>)[] = [];
  listenFailure = false;
  onInvoke: (() => void) | undefined;
  async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    this.calls.push({ name, request: structuredClone(args.request) });
    this.onInvoke?.();
    const next = name === 'session_list' ? this.presenceScript.shift() ?? success({ kind: 'session_list', data: {
      ...presenceList(), sessions: { ...presenceList().sessions, items: [] }, active_total: 0,
    } }) : this.script.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Transport script exhausted');
    return await next as T;
  }
  async listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void) {
    if (this.listenFailure && event === 'ariadne://presence_changed') throw new Error('Test listener unavailable');
    this.listeners.set(event, receive as (hint: never) => void);
    return () => { this.listeners.delete(event); this.unsubscribed.push(event); };
  }
  emit<E extends keyof HintPayloads>(event: E, hint: HintPayloads[E]) { this.listeners.get(event)?.(hint as never); }
}
const opened: OpenSessions[] = [];
function setup() {
  const transport = new Transport();
  const service = createDesktopService(transport);
  const sessions = new OpenSessions(service);
  opened.push(sessions);
  return { transport, service, sessions };
}
afterEach(() => { opened.splice(0).forEach((sessions) => sessions.closeAll()); cleanup(); vi.useRealTimers(); });

describe('canonical desktop transport', () => {
  it('installs the actual route listener before acknowledging native readiness', async () => {
    const listener = deferred<() => void>();
    const unsubscribe = vi.fn();
    vi.mocked(listen).mockReset().mockReturnValue(listener.promise);
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
    const service = createDesktopService();
    const pending = service.subscribe('ariadne://route', vi.fn());
    expect(listen).toHaveBeenCalledWith('ariadne://route', expect.any(Function));
    expect(invoke).not.toHaveBeenCalled();
    listener.resolve(unsubscribe);
    const stop = await pending;
    expect(invoke).toHaveBeenCalledExactlyOnceWith('route_ready');
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockClear();
    vi.mocked(listen).mockResolvedValue(unsubscribe);
    const other = await service.subscribe('ariadne://session_changed', vi.fn());
    expect(invoke).not.toHaveBeenCalled();
    other();
  });
  it('removes the actual native listener when readiness acknowledgement fails', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(listen).mockReset().mockResolvedValue(unsubscribe);
    vi.mocked(invoke).mockReset().mockRejectedValue(new Error('private native failure'));
    await expect(createDesktopService().subscribe('ariadne://route', vi.fn()))
      .rejects.toEqual(new ServiceFailure('transport'));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('uses the exact command and one canonical argument envelope', async () => {
    const { transport, service } = setup();
    transport.script.push(loaded());
    const request = { session: route, request: { command: 'session_get', params: {} } } as const;
    expect((await service.query(request)).session.revision).toBe(21);
    expect(transport.calls).toEqual([{ name: 'session_get', request }]);
    const step = ownerStep;
    const mutation = { session: route, command: step.request } as OwnerMutationRequest;
    transport.script.push(step.response as MutationEnvelope);
    expect(await service.executeOwner(mutation)).toEqual(step.response.data);
    expect(transport.calls[1]).toEqual({ name: 'input_submit', request: mutation });
  });
  it('retains canonical failures and hides raw transport diagnostics', async () => {
    const { transport, service } = setup();
    transport.script.push({ api_version: 1, ok: false, error: coreError }, new Error('private stderr'),
      { api_version: 1, ok: false, error: { ...coreError, code: 'delivery_uncertain', retryable: true } });
    const request = { session: route, request: { command: 'session_get', params: {} } } as const;
    await expect(service.query(request)).rejects.toMatchObject({ error: coreError });
    await expect(service.query(request)).rejects.toEqual(new ServiceFailure('transport'));
    await expect(service.query(request)).rejects.toEqual(new ServiceFailure('invalid_response'));
  });
  it('accepts a canonical Registry bootstrap receipt with a nullable wrapper route', async () => {
    const { transport, service } = setup();
    const command = inventory.owner_commands.find((command) => command.command === 'binding_connect') as OwnerMutationRequest['command'];
    const binding = snapshot().session.bindings[Object.keys(demo.bindings)[0]]!;
    const receipt: Extract<MutationEnvelope, { ok: true }>['data'] = {
      operation_id: command.op_id, session_id: demo.id, revision: 1,
      data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation,
        capabilities: binding.capabilities, setup_instruction: 'Install the registered instruction.' },
    };
    transport.script.push({ api_version: 1, ok: true, data: receipt });
    expect(await service.executeOwner({ session: null, command })).toEqual(receipt);
  });
  it('rejects result kind, route and operation mismatches', async () => {
    const { transport, service } = setup();
    transport.script.push(success({ kind: 'reveal_item', data: itemRoute }));
    await expect(service.query({ session: route, request: { command: 'session_get', params: {} } })).rejects.toBeInstanceOf(ServiceFailure);
    const wrong = snapshot(); wrong.session.project_id = 'another-project';
    transport.script.push(success({ kind: 'session_get', data: wrong }));
    await expect(service.query({ session: route, request: { command: 'session_get', params: {} } })).rejects.toBeInstanceOf(ServiceFailure);
    transport.script.push(success({ kind: 'reveal_item', data: { ...itemRoute, item_id: '2' } }));
    await expect(service.query({ session: route, request: { command: 'reveal_item', params: { item_id: '1.1' } } })).rejects.toBeInstanceOf(ServiceFailure);
    const step = ownerStep;
    const invalid = structuredClone(step.response) as Extract<MutationEnvelope, { ok: true }>;
    invalid.data.operation_id = 'another-operation';
    transport.script.push(invalid);
    await expect(service.executeOwner({ session: route, command: step.request } as OwnerMutationRequest)).rejects.toBeInstanceOf(ServiceFailure);
  });
});

describe('opened session synchronization', () => {
  it('seeds late readers from the existing selected binding list without changing original observation age', async () => {
    const { transport, sessions } = setup(); transport.script.push(loaded());
    transport.presenceScript.push(success({ kind: 'session_list', data: presenceList() }));
    const store = sessions.open(route); await store.refresh();
    const expected = summaries.items[0].active_binding.presence;
    expect(store.getSnapshot().presence[summaries.items[0].active_binding.id]).toEqual(expected);
    expect(transport.calls.map(call => call.name)).toEqual(['session_get', 'session_list']);
    expect(transport.calls[1].request).toMatchObject({ session: null, request: { params: { project_id: route.project_id, cursor: null, limit: 100 } } });
  });
  it('does not let a delayed seed or older duplicate overwrite a newer live instance or invalidation', async () => {
    const { transport, sessions } = setup(); transport.script.push(loaded());
    const seed = deferred<QueryEnvelope>(); transport.presenceScript.push(seed.promise);
    const started = deferred<void>(); transport.onInvoke = () => { if (transport.calls.at(-1)?.name === 'session_list') started.resolve(); };
    const store = sessions.open(route); const loading = store.refresh(); await started.promise;
    const binding = demo.bindings[demo.active_binding_id as keyof typeof demo.bindings];
    const fresh = { ...presenceFixture, instance_id: '00000000-0000-4000-8000-000000000099', generation: binding.generation,
      last_seen_at: '2026-10-04T16:00:00.000Z' } as HintPayloads['ariadne://presence_changed']['observation'];
    const hint = { binding_id: binding.id, generation: binding.generation, observation: fresh };
    transport.emit('ariadne://presence_changed', hint);
    seed.resolve(success({ kind: 'session_list', data: presenceList() }));
    await loading;
    expect(store.getSnapshot().presence[binding.id]).toEqual(fresh);
    transport.emit('ariadne://presence_changed', { ...hint, observation: { ...fresh, last_seen_at: '2026-10-04T15:59:59.000Z' } });
    expect(store.getSnapshot().presence[binding.id]).toEqual(fresh);
    const stale = { ...fresh, freshness: 'stale', execution_state: 'unknown', connection_state: 'unknown' } as const;
    transport.emit('ariadne://presence_changed', { ...hint, observation: stale });
    transport.emit('ariadne://presence_changed', hint);
    expect(store.getSnapshot().presence[binding.id]).toEqual(stale);
    expect(store.getSnapshot().snapshot?.freshness).toBe('fresh');
  });
  it('abandons a late presence seed when the selected generation changes or the store closes', async () => {
    const { transport, sessions } = setup(); transport.script.push(loaded());
    const seed = deferred<QueryEnvelope>(); transport.presenceScript.push(seed.promise);
    const started = deferred<void>(); transport.onInvoke = () => { if (transport.calls.at(-1)?.name === 'session_list') started.resolve(); };
    const store = sessions.open(route); const pending = store.refresh(); await started.promise;
    sessions.close(route);
    seed.resolve(success({ kind: 'session_list', data: presenceList() }));
    await pending;
    expect(store.getSnapshot().presence).toEqual({});
    expect(store.getSnapshot().status).toBe('closed');
  });
  it('subscribes before loading, shares one store and exposes immutable state', async () => {
    const { transport, sessions } = setup();
    const response = deferred<QueryEnvelope>(); transport.script.push(response.promise);
    const started = deferred<void>(); transport.onInvoke = () => started.resolve();
    const store = sessions.open(route);
    expect(sessions.open({ ...route })).toBe(store);
    await started.promise;
    expect(transport.listeners.size).toBe(2);
    expect(transport.calls.length).toBe(1);
    response.resolve(loaded()); await store.refresh();
    expect(store.getSnapshot().status).toBe('ready');
    expect(Object.isFrozen(store.getSnapshot().snapshot?.session.items['1'])).toBe(true);
    expect(() => { Object.assign(store.getSnapshot().snapshot!.session, { title: 'Changed' }); }).toThrow();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const unchanged = store.getSnapshot().snapshot!.session;
    transport.script.push(loaded()); await store.refresh();
    expect(store.getSnapshot().snapshot!.session).toBe(unchanged);
  });
  it('coalesces newer hints, ignores stale hints and preserves the last valid snapshot on failure', async () => {
    const { transport, sessions } = setup(); transport.script.push(loaded());
    const store = sessions.open(route); await store.refresh();
    const pending = deferred<QueryEnvelope>(); transport.script.push(pending.promise, loaded(24));
    const started = deferred<void>(); transport.onInvoke = () => started.resolve();
    transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: 22 });
    await started.promise;
    transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: 23 });
    transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: 24 });
    transport.emit('ariadne://session_changed', { session_id: 'other-session', revision: 99 });
    pending.resolve(loaded(22)); await store.refresh();
    expect(store.getSnapshot().snapshot?.session.revision).toBe(24);
    const calls = transport.calls.length;
    transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: 24 });
    expect(transport.calls.length).toBe(calls);
    transport.script.push({ api_version: 1, ok: false, error: coreError });
    await store.refresh();
    expect(store.getSnapshot().status).toBe('inaccessible');
    expect(store.getSnapshot().snapshot?.session.revision).toBe(24);
    expect(store.getSnapshot().error).toBeInstanceOf(CoreFailure);
    transport.script.push(loaded(23)); await store.refresh();
    expect(store.getSnapshot().error).toBeInstanceOf(ServiceFailure);
    expect(store.getSnapshot().snapshot?.session.revision).toBe(24);
  });
  it('reconciles on focus, wake and every two seconds with cleanup', async () => {
    vi.useFakeTimers(); const { transport, sessions } = setup(); transport.script.push(loaded());
    const store = sessions.open(route); await store.refresh();
    transport.script.push(loaded(22)); window.dispatchEvent(new Event('focus')); await store.refresh();
    transport.script.push(loaded(23)); window.dispatchEvent(new Event('pageshow')); await store.refresh();
    transport.script.push(loaded(24)); await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSnapshot().snapshot?.session.revision).toBe(24);
    sessions.close(route); const count = transport.calls.length;
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(4000);
    expect(transport.calls.length).toBe(count);
    expect(transport.unsubscribed).toHaveLength(2);
    expect(store.getSnapshot().status).toBe('closed');
  });
  it('ignores closed responses and retries listener setup without querying early', async () => {
    const { transport, sessions } = setup(); transport.listenFailure = true;
    const store = sessions.open(route); await store.refresh();
    expect(transport.calls).toHaveLength(0);
    expect(transport.unsubscribed).toContain('ariadne://session_changed');
    transport.listenFailure = false;
    const response = deferred<QueryEnvelope>(); transport.script.push(response.promise);
    const started = deferred<void>(); transport.onInvoke = () => started.resolve();
    const pending = store.refresh();
    await started.promise;
    sessions.close(route); response.resolve(loaded()); await pending;
    expect(store.getSnapshot().snapshot).toBeNull();
    expect(store.getSnapshot().status).toBe('closed');
    transport.script.push(loaded(30)); const reopened = sessions.open(route); await reopened.refresh();
    expect(reopened).not.toBe(store);
    expect(reopened.getSnapshot().snapshot?.session.revision).toBe(30);
  });
  it('accepts presence only for the current binding generation', async () => {
    const { transport, sessions } = setup(); transport.script.push(loaded());
    const store = sessions.open(route); await store.refresh();
    const binding = demo.bindings[demo.active_binding_id as keyof typeof demo.bindings];
    const hint = { binding_id: binding.id, generation: binding.generation,
      observation: { ...presenceFixture, generation: binding.generation } } as HintPayloads['ariadne://presence_changed'];
    transport.emit('ariadne://presence_changed', { ...hint, generation: 'old-generation' });
    expect(Object.keys(store.getSnapshot().presence)).toHaveLength(0);
    transport.emit('ariadne://presence_changed', hint);
    expect(store.getSnapshot().presence[binding.id].generation).toBe(binding.generation);
    const next = snapshot(22); next.session.bindings[binding.id]!.generation = 'next-generation';
    transport.script.push(success({ kind: 'session_get', data: next })); await store.refresh();
    expect(Object.keys(store.getSnapshot().presence)).toHaveLength(0);
  });
  it('publishes through useSyncExternalStore without changing a separate draft or focus', async () => {
    const { transport, sessions } = setup(); transport.script.push(loaded());
    const store = sessions.open(route); await store.refresh();
    function Workspace({ store }: { store: SessionStore }) {
      const state = useSession(store); const [draft, setDraft] = useState('');
      return <><output>{state.snapshot?.session.revision}</output><input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} /></>;
    }
    render(<Workspace store={store} />);
    const input = screen.getByLabelText('Draft'); input.focus(); fireEvent.change(input, { target: { value: 'Unsent exact draft  ' } });
    transport.script.push(loaded(22)); await act(() => store.refresh());
    expect(screen.getByRole('status').textContent).toBe('22');
    expect((input as HTMLInputElement).value).toBe('Unsent exact draft  ');
    expect(document.activeElement).toBe(input);
  });
});

describe('selectors and registered reveal', () => {
  it('keeps shared activity and other-operation backlinks out of item conversations', () => {
    const session = snapshot().session;
    const opening = session.messages.find((message) => message.kind === 'activity')!;
    const reply = session.messages.find((message) => message.kind === 'reply' && message.item_id === '1')!;
    const owner = session.messages.find((message) => message.kind === 'owner_input' && message.item_id === '1')!;
    opening.items_touched = ['1', '2'];
    reply.items_touched = ['1', '2'];
    session.messages = [reply, opening, owner];
    const indexes = indexSession(immutable(session));
    expect(indexes.messagesByItem.get('1')?.map((message) => message.id)).toEqual([owner.id, reply.id]);
    expect(indexes.messagesByItem.get('2') ?? []).toEqual([]);
    expect(indexes.messagesByItem.get('1')?.map((message) => message.body)).toEqual([owner.body, reply.body]);
    expect(indexes.roundsByItem.get('1')?.[0]?.opened_message_id).toBe(opening.id);
  });
  it('uses explicit parent indexes, deduplicates message relations and retains backend count completeness', () => {
    const session = immutable(snapshot().session); const indexes = indexSession(session);
    expect(indexSession(session)).toBe(indexes);
    expect(indexes.childrenByParent.get('1')?.map((item) => item.id)).toContain('1.1');
    expect(revealAncestors(session, itemRoute)).toEqual(['1']);
    const messages = indexes.messagesByItem.get('1') ?? [];
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    expect(indexes.activeDescendants.get('1')).toBeGreaterThanOrEqual(0);
    const summary = summaries.items[0] as SessionSummary;
    expect(summaryCounts(immutable(summary))).toEqual(summary.counts);
    const invalid = snapshot().session; invalid.items['1']!.parent = '1.1';
    expect(() => indexSession(immutable(invalid))).toThrow('cycle');
    expect(() => revealAncestors(immutable(invalid), itemRoute)).toThrow('ancestry');
    expect(() => revealAncestors(session, { ...itemRoute, item_id: '99' })).toThrow('unavailable');
  });
  it('validates registered reveal before opening and returns temporary ancestry without changing filters', async () => {
    const { transport, service, sessions } = setup();
    transport.script.push(success({ kind: 'reveal_item', data: itemRoute }), loaded());
    const routes = new RegisteredRoutes(service, sessions); const revealed = await routes.revealItem(itemRoute);
    expect(revealed?.kind === 'item' && revealed.temporaryExpandedItemIds).toEqual(['1']);
    expect(transport.calls[0].request).toEqual({ session: route, request: { command: 'reveal_item', params: { item_id: '1.1' } } });
    const bad = new CoreFailure({ ...coreError, code: 'not_found' });
    transport.script.push({ api_version: 1, ok: false, error: bad.error }, loaded());
    const missing = await routes.revealItem({ ...itemRoute, item_id: '99' });
    expect(missing).toMatchObject({ kind: 'missing_item', session: route, requestedItemId: '99', banner: bad.message });
    expect(missing).not.toHaveProperty('route'); expect(missing).not.toHaveProperty('temporaryExpandedItemIds');
  });
  it('suppresses superseded reveals and unsubscribed native routes', async () => {
    const { transport, service, sessions } = setup(); const routes = new RegisteredRoutes(service, sessions);
    const old = deferred<QueryEnvelope>(); transport.script.push(old.promise, success({ kind: 'reveal_item', data: { ...itemRoute, item_id: '2' } }), loaded());
    const first = routes.revealItem(itemRoute); const second = routes.revealItem({ ...itemRoute, item_id: '2' });
    const latest = await second;
    expect(latest?.kind === 'item' && latest.route.item_id).toBe('2'); old.resolve(success({ kind: 'reveal_item', data: itemRoute }));
    expect(await first).toBeNull();
    const received = vi.fn(); const failed = vi.fn(); const stop = await routes.subscribe(received, failed);
    transport.script.push(loaded()); transport.emit('ariadne://route', { ...route, item_id: null });
    expect(received).toHaveBeenCalledWith({ ...route, item_id: null }, null);
    stop(); transport.emit('ariadne://route', { ...route, item_id: null });
    expect(received).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled();
  });
  it('preserves inaccessible session failures and handles a missing item after a successful route read', async () => {
    const { transport, service, sessions } = setup(); const routes = new RegisteredRoutes(service, sessions);
    transport.script.push({ api_version: 1, ok: false, error: { ...coreError, code: 'not_found' } },
      { api_version: 1, ok: false, error: { ...coreError, code: 'permission_denied' } });
    await expect(routes.revealItem(itemRoute)).rejects.toMatchObject({ error: { code: 'permission_denied' } });
    transport.script.push(success({ kind: 'reveal_item', data: { ...itemRoute, item_id: '99' } }), loaded());
    const missing = await routes.revealItem({ ...itemRoute, item_id: '99' });
    expect(missing).toMatchObject({ kind: 'missing_item', session: route, requestedItemId: '99' });
    expect(missing).not.toHaveProperty('route');
  });
  it('native item-route subscription uses the same registered reveal and reports failures', async () => {
    const { transport, service, sessions } = setup(); const routes = new RegisteredRoutes(service, sessions);
    const received = deferred<void>(); const failed = deferred<void>();
    const onReceive = vi.fn(() => received.resolve()); const onFailed = vi.fn(() => failed.resolve());
    const stop = await routes.subscribe(onReceive, onFailed);
    transport.script.push(success({ kind: 'reveal_item', data: itemRoute }), loaded());
    transport.emit('ariadne://route', itemRoute); await received.promise;
    expect(onReceive.mock.calls[0]).toHaveLength(2);
    transport.script.push({ api_version: 1, ok: false, error: { ...coreError, code: 'unsupported' } });
    transport.emit('ariadne://route', itemRoute); await failed.promise;
    expect(onFailed).toHaveBeenCalledTimes(1); stop();
  });
});
