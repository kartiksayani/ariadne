import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopService, validHealth, type SupervisorHealth } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionActionControllers, sessionActionsFor } from '../../../src/components/bindings/actions';
import { dispatchStatus, healthReason, pausedNote } from '../../../src/components/bindings/dispatch';
import { DispatchChip, PausedNote } from '../../../src/components/bindings/DispatchChip';
import { SupervisorHealthStore } from '../../../src/components/bindings/health';
import { AppTransport, route } from '../app/transport';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); });

const generation = '00000000-0000-4000-8000-000000000022', bindingId = '00000000-0000-4000-8000-000000000020';
const binding = (update: Partial<Parameters<typeof dispatchStatus>[0]['binding'] & object> = {}) => ({ generation, dispatch_state: 'enabled' as const,
  owner_paused: false, pause_reason: null, connection_state: 'connected' as const, presence: null, ...update });
const health = (update: Partial<SupervisorHealth> = {}): SupervisorHealth => ({ binding_id: bindingId, generation, state: 'running', reason: null,
  retry_in_seconds: null, updated_at: '2026-10-07T10:00:00.000Z', ...update });

describe('dispatch status in the owner’s words', () => {
  it('reads Sending, Paused (by you), Not sending: <reason> and Disconnected, never internal state names', () => {
    expect(dispatchStatus({ binding: binding(), closed: false })).toMatchObject({ kind: 'sending', label: 'Sending', action: 'pause', live: true });
    expect(dispatchStatus({ binding: binding({ owner_paused: true, dispatch_state: 'paused' }), closed: false }))
      .toMatchObject({ kind: 'paused', label: 'Paused (by you)', action: 'resume', live: false });
    expect(dispatchStatus({ binding: binding({ pause_reason: 'result_missing', dispatch_state: 'recovery_required' }), closed: false }))
      .toMatchObject({ kind: 'blocked', label: 'Not sending: the agent hasn’t saved its answer yet', action: null, live: false });
    expect(dispatchStatus({ binding: binding(), closed: false, needsDecision: true }).label).toBe('Not sending: a message needs your decision');
    expect(dispatchStatus({ binding: binding({ connection_state: 'disconnected' }), closed: false, agent: 'codex' }))
      .toMatchObject({ kind: 'disconnected', label: 'Disconnected', reason: 'codex is disconnected' });
    expect(dispatchStatus({ binding: binding(), closed: true }).label).toBe('Session closed');
    expect(dispatchStatus({ binding: null, closed: false }).label).toBe('No agent connected');
    // Nothing left to decide after a recovery: the owner's Resume restarts sending.
    expect(dispatchStatus({ binding: binding({ dispatch_state: 'recovery_required' }), closed: false })).toMatchObject({ kind: 'paused', action: 'resume' });
  });
  it('a recovery blocker outranks the owner’s pause: Resume cannot clear it', () => {
    expect(dispatchStatus({ binding: binding({ owner_paused: true, pause_reason: 'uncertain' }), closed: false }))
      .toMatchObject({ kind: 'blocked', label: 'Not sending: Ariadne isn’t sure your last message arrived', action: null });
  });
  it('shows a neutral wait for an answer when the agent already has the message', () => {
    const waiting = dispatchStatus({ binding: binding({ pause_reason: 'result_missing', dispatch_state: 'recovery_required' }),
      closed: false, needsDecision: true, waitingAnswer: 'What is the state today?', agent: 'claude-code' });
    expect(waiting).toMatchObject({ kind: 'waiting', label: 'Waiting for claude-code to answer “What is the state today?”', action: null, live: false });
    expect(waiting.color).not.toBe('var(--a-warn)');
    expect(pausedNote(waiting, 'claude-code')).toContain('Your next message waits here until this is answered or you stop waiting.');
  });
  it('takes the supervisor’s health only when it is unhealthy, with the retry countdown', () => {
    expect(dispatchStatus({ binding: binding(), closed: false, health: health() }).label).toBe('Sending');
    const backingOff = health({ state: 'backing_off', reason: 'codex exited', retry_in_seconds: 2.1 }), at = Date.parse(backingOff.updated_at);
    expect(dispatchStatus({ binding: binding(), closed: false, health: backingOff, now: at }))
      .toMatchObject({ kind: 'blocked', label: 'Not sending: codex exited · retrying in 3s', action: 'pause' });
    // The countdown runs from the supervisor's update time, not from when the entry arrived.
    expect(healthReason(backingOff, at + 1_500)).toBe('codex exited · retrying in 1s');
    expect(healthReason(backingOff, at + 3_000)).toBe('codex exited · retrying now');
    expect(healthReason(health({ state: 'stopped', reason: null }))).toBe('Ariadne’s sender stopped');
    // No entry (Claude Code bindings) is never "Not sending".
    expect(dispatchStatus({ binding: binding(), closed: false, health: null }).label).toBe('Sending');
  });
  it('keeps disconnection, other pause reasons and unhealthy supervision visible while an answer is missing', () => {
    const facts = { closed: false, waitingAnswer: 'What is the state today?', agent: 'claude-code', needsDecision: true };
    expect(dispatchStatus({ ...facts, binding: binding({ connection_state: 'disconnected', pause_reason: 'result_missing' }) }))
      .toMatchObject({ kind: 'disconnected', label: 'Disconnected' });
    for (const reason of ['store_error', 'host_failure', 'incompatible', 'uncertain'] as const) {
      expect(dispatchStatus({ ...facts, binding: binding({ pause_reason: reason }) }).kind).toBe('blocked');
    }
    expect(dispatchStatus({ ...facts, binding: binding({ pause_reason: 'store_error' }) }).label).toBe('Not sending: Ariadne couldn’t save to disk');
    for (const state of ['stopped', 'backing_off'] as const) {
      expect(dispatchStatus({ ...facts, binding: binding({ pause_reason: 'result_missing' }), health: health({ state, reason: 'The sender stopped' }) }))
        .toMatchObject({ kind: 'blocked', label: 'Not sending: The sender stopped' });
    }
  });
  it('words the editors’ paused warning', () => {
    expect(pausedNote(dispatchStatus({ binding: binding({ owner_paused: true }), closed: false }), 'codex')).toMatch(/^Sending is paused/);
    expect(pausedNote(dispatchStatus({ binding: binding(), closed: false, needsDecision: true }), 'codex'))
      .toBe('Not sending to codex: a message needs your decision. Your message waits until that’s sorted.');
    expect(pausedNote(dispatchStatus({ binding: binding(), closed: false }), 'codex')).toBeNull();
  });
});

describe('supervisor health', () => {
  it('validates entries and keys them by binding generation; older updates never overwrite newer ones', async () => {
    expect(validHealth(health())).toBe(true);
    expect(validHealth({ ...health(), state: 'paused' })).toBe(false);
    expect(validHealth({ ...health(), retry_in_seconds: -1 })).toBe(false);
    expect(validHealth({ ...health(), updated_at: 'yesterday' })).toBe(false);
    const transport = new AppTransport(); transport.health = [health({ state: 'backing_off', reason: 'first' })];
    const store = new SupervisorHealthStore(createDesktopService(transport));
    const release = store.retain(); await store.start();
    expect(store.of(bindingId, generation)?.reason).toBe('first');
    expect(store.of(bindingId, 'another-generation')).toBeNull();
    expect(store.of('missing', generation)).toBeNull();
    transport.emit('ariadne://supervisor_health', health({ state: 'running', updated_at: '2026-10-07T10:00:05.000Z' }));
    transport.emit('ariadne://supervisor_health', health({ state: 'stopped', reason: 'late', updated_at: '2026-10-07T09:59:00.000Z' }));
    expect(store.of(bindingId, generation)?.state).toBe('running');
    // The last reader stops listening.
    expect(transport.listeners.get('ariadne://supervisor_health')?.size).toBe(1);
    release(); expect(transport.listeners.get('ariadne://supervisor_health')?.size).toBe(0);
  });
  it('a running event (the runtime forgetting the entry) clears a backing-off entry; a forget for another generation does not', async () => {
    const transport = new AppTransport(); transport.health = [health({ state: 'backing_off', reason: 'codex exited', retry_in_seconds: 4 })];
    const store = new SupervisorHealthStore(createDesktopService(transport));
    const release = store.retain(); await store.start();
    expect(healthReason(store.of(bindingId, generation))).toMatch(/^codex exited/);
    transport.emit('ariadne://supervisor_health', health({ generation: 'older-generation', updated_at: '2026-10-07T10:00:09.000Z' }));
    expect(store.of(bindingId, generation)?.state).toBe('backing_off');
    transport.emit('ariadne://supervisor_health', health({ updated_at: '2026-10-07T10:00:10.000Z' }));
    expect(store.of(bindingId, generation)).toMatchObject({ state: 'running', reason: null, retry_in_seconds: null });
    expect(dispatchStatus({ binding: binding(), closed: false, health: store.of(bindingId, generation) }).label).toBe('Sending');
    // A late backing-off update from before the forget does not bring the warning back.
    transport.emit('ariadne://supervisor_health', health({ state: 'backing_off', reason: 'late', retry_in_seconds: 4, updated_at: '2026-10-07T10:00:08.000Z' }));
    expect(store.of(bindingId, generation)?.state).toBe('running');
    release();
  });
});

async function mount() {
  const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const actions = new SessionActionControllers(service).forSession(store);
  return { transport, service, store, actions };
}
const chip = () => within(screen.getByRole('group', { name: 'Sending to the agent' }));

describe('dispatch chip', () => {
  it('pauses in one click, then offers Resume in one click', async () => {
    const { transport, actions } = await mount();
    render(<><DispatchChip actions={actions} /><PausedNote actions={actions} /></>);
    expect(chip().getByText('Sending')).toBeTruthy(); expect(document.querySelector('[data-dispatch-note]')).toBeNull();
    // An icon button, so the session bar stays one text line high: named, with a tooltip.
    const pause = chip().getByRole('button', { name: 'Pause' });
    expect(pause.textContent).toBe(''); expect(pause.getAttribute('title')).toMatch(/^Pause: stop sending to /);
    await act(async () => { fireEvent.click(pause); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['binding_pause']);
    await waitFor(() => expect(chip().getByText('Paused (by you)')).toBeTruthy());
    expect(chip().getByRole('button', { name: 'Resume' }).getAttribute('title')).toMatch(/^Resume: send to /);
    // The editors' warning offers the same Resume.
    const note = document.querySelector('[data-dispatch-note]') as HTMLElement;
    expect(note.textContent).toContain('Sending is paused');
    await act(async () => { fireEvent.click(within(note).getByRole('button', { name: 'Resume' })); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['binding_pause', 'binding_resume']);
    await waitFor(() => expect(chip().getByText('Sending')).toBeTruthy());
  });
  it('shows the supervisor’s reason while it backs off, and nothing for a binding without an entry', async () => {
    const { transport, actions } = await mount();
    transport.health = [health({ state: 'backing_off', reason: 'codex app-server exited', retry_in_seconds: 4, updated_at: new Date().toISOString() })];
    render(<DispatchChip actions={actions} />);
    await waitFor(() => expect(chip().getByText('Not sending: codex app-server exited · retrying in 4s')).toBeTruthy());
    // It counts down by itself.
    await waitFor(() => expect(chip().getByText('Not sending: codex app-server exited · retrying in 3s')).toBeTruthy(), { timeout: 3_000 });
    act(() => { transport.emit('ariadne://supervisor_health', health({ updated_at: new Date(Date.now() + 1_000).toISOString() })); });
    expect(chip().getByText('Sending')).toBeTruthy();
  });
  it('says an unconfirmed pause was not confirmed and replays it exactly on Try again', async () => {
    const { transport, actions } = await mount(); transport.failNext = 'binding_pause';
    render(<DispatchChip actions={actions} />);
    await act(async () => { fireEvent.click(chip().getByRole('button', { name: 'Pause' })); });
    expect(chip().getByRole('alert').textContent).toBe('Your last change wasn’t confirmed.');
    await act(async () => { fireEvent.click(chip().getByRole('button', { name: 'Try again' })); });
    const pauses = transport.mutations.filter(value => value.command.command === 'binding_pause');
    expect(pauses).toHaveLength(2); expect(pauses[1]).toEqual(pauses[0]);
    expect(chip().queryByRole('alert')).toBeNull();
  });
  it('reaches the application’s controller for a session from anywhere in the view', async () => {
    const { service, store, actions } = await mount();
    expect(sessionActionsFor(service, store)).toBe(actions);
  });
});
