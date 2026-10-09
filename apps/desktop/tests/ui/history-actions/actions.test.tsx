import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MutationEnvelope } from '../../../src/generated/core';
import { createDesktopService, CoreFailure } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { useSession } from '../../../src/data';
import type { SessionRef } from '../../../src/generated/core';
import { SessionActionControllers, type SessionActions } from '../../../src/components/bindings/actions';
import { useLifecycle } from '../../../src/ui/tree/Lifecycle';
import { ContinuePicker, ContinueTopicHost, continueTargets, openContinueTopic } from '../../../src/ui/dialogs/ContinueTopicDialog';
import { NavigationStore } from '../../../src/state/navigation/store';
import type { SessionSummary } from '../../../src/generated/domain/models';
import { CopiedProvenance } from '../../../src/components/history-actions/CopiedProvenance';
import { archiveImpact, archiveWarning, closeWarning } from '../../../src/components/history-actions/selectors';
import { notices } from '../../../src/ui/pages/notices';
import { route, secondId } from '../app/transport';
import { HistoryTransport } from './fixture';

const op = '00000000-0000-4000-8000-000000000099';
const targetRoute = { ...route, session_id: secondId };
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); vi.useRealTimers(); });
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
  const props = { actions };
  return { transport, service, sessions, store, actions, targetActions, topic, props };
}
const dialog = () => within(screen.getByRole('dialog'));
// The tree's session bar, topic actions and banners reduced to plain buttons over the same useLifecycle.
function HistoryActions({ actions }: { actions: SessionActions }) {
  const lifecycle = useLifecycle(actions), session = useSession(actions.session).snapshot?.session;
  if (!session) return null;
  return <section aria-label="History actions">
    <button type="button" disabled={lifecycle.busy} onClick={lifecycle.session}>{session.state === 'closed' ? 'Reopen session' : 'Close session'}</button>
    {Object.values(session.topics).map(topic => topic && !topic.archived_at && <button key={`prompt-${topic.id}`} type="button"
      onClick={() => lifecycle.archive(topic.id)}>Archive topic prompt {topic.name}</button>)}
    {Object.values(session.topics).map(topic => topic && <button key={topic.id} type="button" disabled={lifecycle.busy}
      onClick={() => { if (topic.archived_at) lifecycle.restore(topic.id); else lifecycle.archive(topic.id); }}>{topic.archived_at ? 'Restore' : 'Archive'} {topic.name}</button>)}
    {lifecycle.archived && <p role="status">Archived {lifecycle.archived.name} · {lifecycle.archived.cancelled} cancelled<button type="button" onClick={lifecycle.undo}>Undo</button>
      <button type="button" onClick={lifecycle.dismiss}>Dismiss</button></p>}
    {lifecycle.pending && <button type="button" onClick={lifecycle.reconcile}>Reconcile saved action</button>}
    {lifecycle.error && <p role="alert">{lifecycle.error}</p>}
    {lifecycle.dialog}
  </section>;
}

describe('guarded history controls', () => {
  async function staleRefresh(value: Awaited<ReturnType<typeof setup>>) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = value.transport.invoke.bind(value.transport);
    const spy = vi.spyOn(value.transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'session_get') await gate;
      return invoke(name, args);
    });
    ++value.transport.source.revision; ++value.topic.revision;
    act(() => { value.transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: value.transport.source.revision }); });
    expect(value.store.getSnapshot().status).toBe('stale');
    return { release, spy };
  }
  it('waits for a stale capture and archives once against the latest revisions even after repeated prompt clicks', async () => {
    const value = await setup(true); render(<HistoryActions {...value.props} />);
    const { release } = await staleRefresh(value);
    const prompt = screen.getByRole('button', { name: `Archive topic prompt ${value.topic.name}` });
    fireEvent.click(prompt); fireEvent.click(prompt);
    expect(value.transport.mutations).toHaveLength(0);
    const revision = value.topic.revision;
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(value.transport.mutations).toHaveLength(1));
    expect(value.transport.mutations[0]!.command).toMatchObject({ command: 'topic_archive', params: { expected_revision: revision } });
    expect(value.topic.archived_at).not.toBeNull();
  });
  it.each(['stale', 'failed'] as const)('reports a plain error when the archive refresh remains %s', async result => {
    const value = await setup(true); render(<HistoryActions {...value.props} />);
    const { release, spy } = await staleRefresh(value);
    fireEvent.click(screen.getByRole('button', { name: `Archive topic prompt ${value.topic.name}` }));
    if (result === 'stale') --value.transport.source.revision;
    else spy.mockRejectedValue(new Error('Read failed'));
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Ariadne is still loading this session's latest changes. Try again."));
    expect(value.transport.mutations).toHaveLength(0);
  });
  it('rechecks archive impact after refreshing and asks before archiving newly open items', async () => {
    const value = await setup(true); render(<HistoryActions {...value.props} />);
    const { release } = await staleRefresh(value);
    fireEvent.click(screen.getByRole('button', { name: `Archive topic prompt ${value.topic.name}` }));
    Object.values(value.transport.source.items).find(item => item?.topic_id === value.topic.id)!.status = 'open';
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(value.transport.mutations).toHaveLength(0);
    expect(dialog().getByText(/1 open item stays as it is/)).toBeTruthy();
  });
  it.each(['Archive topic', 'Close session'] as const)('lets Cancel abandon a stale %s confirmation without a late write', async kind => {
    const value = await setup(); render(<HistoryActions {...value.props} />);
    fireEvent.click(screen.getByRole('button', { name: kind === 'Archive topic' ? `Archive ${value.topic.name}` : kind }));
    const { release } = await staleRefresh(value);
    fireEvent.click(dialog().getByRole('button', { name: kind }));
    expect((dialog().getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(value.transport.mutations).toHaveLength(0);
    await act(async () => {});
    expect((screen.getAllByRole('button', { name: 'Close session' })[0] as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.transport.mutations).toHaveLength(0);
    expect(value.topic.archived_at).toBeNull();
    expect(value.transport.source.state).toBe('active');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['Archive prompt', 'Archive topic', 'Close session'] as const)('bounds a stuck %s refresh at five seconds and ignores its late completion', async kind => {
    const value = await setup(kind === 'Archive prompt'); render(<HistoryActions {...value.props} />);
    if (kind !== 'Archive prompt') fireEvent.click(screen.getByRole('button', { name: kind === 'Archive topic' ? `Archive ${value.topic.name}` : kind }));
    const { release } = await staleRefresh(value);
    vi.useFakeTimers();
    fireEvent.click(kind === 'Archive prompt' ? screen.getByRole('button', { name: `Archive topic prompt ${value.topic.name}` })
      : dialog().getByRole('button', { name: kind }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const area = kind === 'Archive prompt' ? screen : dialog();
    expect(area.getByRole('alert').textContent).toContain("Ariadne is still loading this session's latest changes. Try again.");
    expect(value.transport.mutations).toHaveLength(0);
    expect((screen.getAllByRole('button', { name: 'Close session' })[0] as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.transport.mutations).toHaveLength(0);
    vi.useRealTimers();
  });
  it.each(['open items', 'unsent messages'] as const)('requires confirmation of updated %s warning after refreshing', async changed => {
    const value = await setup(); render(<HistoryActions {...value.props} />);
    fireEvent.click(screen.getByRole('button', { name: `Archive ${value.topic.name}` }));
    const warning = dialog().getByText(/You can restore it any time/).textContent;
    const { release } = await staleRefresh(value);
    fireEvent.click(dialog().getByRole('button', { name: 'Archive topic' }));
    if (changed === 'open items') {
      Object.values(value.transport.source.items).find(item => item?.topic_id === value.topic.id && !['done', 'decided', 'dropped', 'replaced'].includes(item.status))!.status = 'done';
    } else {
      Object.values(value.transport.source.inputs).filter(input => input?.target.topic_id === value.topic.id).forEach(input => { input!.state = 'cancelled'; });
    }
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.transport.mutations).toHaveLength(0);
    expect(dialog().getByText(/You can restore it any time/).textContent).not.toBe(warning);
    expect(dialog().queryByRole('alert')).toBeNull();
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Archive topic' })); });
    expect(value.transport.mutations).toHaveLength(1);
    expect(value.topic.archived_at).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['Archive topic', 'Close session'] as const)('keeps %s refresh failure readable inside its confirmation', async kind => {
    const value = await setup(); render(<HistoryActions {...value.props} />);
    fireEvent.click(screen.getByRole('button', { name: kind === 'Archive topic' ? `Archive ${value.topic.name}` : kind }));
    const { release, spy } = await staleRefresh(value);
    fireEvent.click(dialog().getByRole('button', { name: kind }));
    spy.mockRejectedValue(new Error('Read failed'));
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(dialog().getByRole('alert').textContent).toContain("Ariadne is still loading this session's latest changes. Try again."));
    expect(value.transport.mutations).toHaveLength(0);
  });
  it('keeps the shared write guard when another owner action starts during the refresh', async () => {
    const value = await setup(true); render(<HistoryActions {...value.props} />);
    const { release } = await staleRefresh(value);
    // Publish the fresh capture before the refresh promise settles, as SessionStore does.
    let finish!: () => void;
    const competing = new Promise<MutationEnvelope>(resolve => { finish = () => resolve(failure('revision_conflict')); });
    const unsubscribe = value.store.subscribe(() => {
      const current = value.store.getSnapshot();
      if (current.status !== 'ready') return;
      unsubscribe();
      value.transport.replies.push(competing);
      void value.actions.execute({ command: 'session_close', api_version: 1, op_id: '', params: { expected_revision: current.snapshot!.session.revision } }, current.snapshot!.session.revision);
    });
    fireEvent.click(screen.getByRole('button', { name: `Archive topic prompt ${value.topic.name}` }));
    await act(async () => { release(); await value.store.refresh(); });
    expect(value.transport.mutations.map(value => value.command.command)).toEqual(['session_close']);
    expect(value.topic.archived_at).toBeNull();
    await act(async () => { finish(); });
  });
  it.each(['Restore', 'Undo', 'Close session', 'Reopen session'] as const)('waits for a stale refresh before %s without duplicate writes', async kind => {
    const value = await setup(true); render(<HistoryActions {...value.props} />);
    if (kind === 'Restore' || kind === 'Undo') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Archive ${value.topic.name}` })); });
    } else if (kind === 'Reopen session') {
      fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
      await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Close session' })); });
    }
    if (kind === 'Close session' || kind === 'Reopen session') fireEvent.click(screen.getByRole('button', { name: kind }));
    const before = value.transport.mutations.length;
    const { release } = await staleRefresh(value);
    const control = kind === 'Close session' || kind === 'Reopen session' ? dialog().getByRole('button', { name: kind })
      : screen.getByRole('button', { name: kind === 'Restore' ? `Restore ${value.topic.name}` : kind });
    fireEvent.click(control); fireEvent.click(control);
    expect(value.transport.mutations).toHaveLength(before);
    await act(async () => { release(); await value.store.refresh(); });
    await waitFor(() => expect(value.transport.mutations).toHaveLength(before + 1));
    expect(value.transport.mutations.at(-1)!.command.command).toBe(kind === 'Restore' || kind === 'Undo' ? 'topic_restore'
      : kind === 'Close session' ? 'session_close' : 'session_reopen');
  });
  it('archives a topic with open items and unsent messages after one plain confirmation, cancelling only the messages', async () => {
    const { props, topic, transport } = await setup(); render(<HistoryActions {...props} />);
    const open = Object.values(transport.source.items).filter(item => item?.topic_id === topic.id
      && !['decided', 'done', 'dropped', 'replaced'].includes(item.status)).length;
    const unsettled = Object.values(transport.source.inputs).filter(input => input?.target.topic_id === topic.id
      && ['queued', 'in_flight', 'needs_attention'].includes(input.state)).map(input => input!.id);
    expect(open).toBeGreaterThan(0); expect(unsettled.length).toBeGreaterThan(0);
    const statuses = Object.fromEntries(Object.values(transport.source.items).map(item => [item!.id, item!.status]));
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` }));
    const confirm = screen.getByRole('dialog', { name: `Archive “${topic.name}”?` });
    // The words say what stays and what is cancelled, never an internal id, and the confirm button is live.
    const words = archiveWarning(archiveImpact(transport.source, topic.id), 'demo.local')!;
    expect(words).toMatch(new RegExp(`^${open} open items? stays? as (it is|they are)\\. .+; archiving cancels (it|them)\\. You can restore it any time\\.$`));
    expect(within(confirm).getByText(words)).toBeDefined();
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(confirm.textContent ?? '')).toBe(false);
    expect(transport.mutations).toHaveLength(0);
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Archive topic' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(transport.mutations.map(value => value.command.command)).toEqual(['topic_archive']);
    expect(screen.getByRole('status').textContent).toContain(`Archived ${topic.name} · ${unsettled.length} cancelled`);
    expect(unsettled.every(id => transport.source.inputs[id]!.state === 'cancelled')).toBe(true);
    // Items keep their status; Undo brings the topic back and the cancelled messages stay cancelled.
    expect(Object.fromEntries(Object.values(transport.source.items).map(item => [item!.id, item!.status]))).toEqual(statuses);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(transport.source.topics[topic.id]!.archived_at).toBeNull();
    expect(unsettled.every(id => transport.source.inputs[id]!.state === 'cancelled')).toBe(true);
  });
  it('leaves the topic as it is when the archive confirmation is cancelled', async () => {
    const { props, topic, transport } = await setup(); render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` }));
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(transport.mutations).toHaveLength(0);
    expect(transport.source.topics[topic.id]!.archived_at).toBeNull();
  });
  it('words what archiving leaves as it is and what it cancels', () => {
    expect(archiveWarning({ open: 3, unsent: 2, delivering: 0 }, 'codex'))
      .toBe('3 open items stay as they are. 2 of your messages haven’t reached codex yet; archiving cancels them. You can restore it any time.');
    expect(archiveWarning({ open: 1, unsent: 0, delivering: 0 }, 'codex')).toBe('1 open item stays as it is. You can restore it any time.');
    expect(archiveWarning({ open: 0, unsent: 1, delivering: 0 }, 'codex')).toBe('1 of your messages hasn’t reached codex yet; archiving cancels it. You can restore it any time.');
    expect(archiveWarning({ open: 0, unsent: 0, delivering: 1 }, 'codex')).toBe('1 of your messages is being delivered to codex; archiving cancels it. You can restore it any time.');
    expect(archiveWarning({ open: 2, unsent: 1, delivering: 2 }, 'codex'))
      .toBe('2 open items stay as they are. 1 of your messages hasn’t reached codex yet and 2 are being delivered; archiving cancels them. You can restore it any time.');
    // Nothing stays open and nothing is cancelled: no confirmation at all.
    expect(archiveWarning({ open: 0, unsent: 0, delivering: 0 }, 'codex')).toBeNull();
  });
  it('closes a sending session with open questions and unsent messages in one confirmation', async () => {
    const { props, transport } = await setup();
    const binding = transport.source.bindings[transport.source.active_binding_id!]!;
    binding.dispatch_state = 'enabled'; binding.connection_state = 'connected'; binding.owner_paused = false;
    await props.actions.session.refresh(); render(<HistoryActions {...props} />);
    const questions = Object.values(transport.source.items).filter(item => item?.status === 'waiting_on_me').length;
    const inputs = Object.values(transport.source.inputs);
    const queued = inputs.filter(input => input && ['queued', 'needs_attention'].includes(input.state)).length;
    const delivering = inputs.filter(input => input?.state === 'in_flight').length, unsent = queued + delivering;
    expect(questions).toBeGreaterThan(0); expect(queued).toBeGreaterThan(0); expect(delivering).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(dialog().queryByRole('button', { name: /Pause/ })).toBeNull();
    expect(dialog().getByText(new RegExp(`^${questions} questions? (is|are) still open, ${queued} of your messages ha(s|ve)n’t reached demo\\.local `
      + 'and 1 is being delivered — closing cancels those messages\\.$'))).toBeTruthy();
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Close session' })); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['session_close']);
    expect(transport.source.state).toBe('closed'); expect(screen.queryByRole('dialog')).toBeNull();
    expect(notices.getSnapshot().some(notice => notice.text.includes(`${unsent} unsent message`))).toBe(true);
  });
  it('words what closing leaves open and what it cancels', () => {
    expect(closeWarning({ questions: 1, unsent: 2, delivering: 0 }, 'codex')).toBe('1 question is still open and 2 of your messages haven’t reached codex — closing cancels those messages.');
    expect(closeWarning({ questions: 0, unsent: 1, delivering: 0 }, 'codex')).toBe('1 of your messages hasn’t reached codex — closing cancels it.');
    expect(closeWarning({ questions: 2, unsent: 0, delivering: 0 }, 'codex')).toBe('2 questions are still open — they stay in the closed session.');
    expect(closeWarning({ questions: 0, unsent: 0, delivering: 0 }, 'codex')).toBeNull();
    // A message in flight is being delivered, not "hasn't reached".
    expect(closeWarning({ questions: 0, unsent: 0, delivering: 1 }, 'codex')).toBe('1 of your messages is being delivered to codex — closing cancels it.');
    expect(closeWarning({ questions: 0, unsent: 2, delivering: 1 }, 'codex')).toBe('2 of your messages haven’t reached codex and 1 is being delivered — closing cancels them.');
    expect(closeWarning({ questions: 1, unsent: 1, delivering: 2 }, 'codex'))
      .toBe('1 question is still open, 1 of your messages hasn’t reached codex and 2 are being delivered — closing cancels those messages.');
    expect(closeWarning({ questions: 1, unsent: 0, delivering: 1 }, 'codex')).toBe('1 question is still open and 1 of your messages is being delivered to codex — closing cancels that message.');
  });
  it('archives/restores and closes/reopens with retained IDs, history and paused binding', async () => {
    const { props, topic, transport } = await setup(true), items = structuredClone(transport.source.items), messages = structuredClone(transport.source.messages);
    const binding = transport.source.bindings[transport.source.active_binding_id!]!; binding.dispatch_state = 'paused'; binding.owner_paused = true;
    await props.actions.session.refresh(); render(<HistoryActions {...props} />);
    // Nothing blocks a terminal topic, so Archive runs at once and Undo restores it.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` })); });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('status').textContent).toContain(`Archived ${topic.name}`);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(screen.queryByRole('status')).toBeNull(); expect(topic.archived_at).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` })); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Restore ${topic.name}` })); });
    for (const [button, confirm] of [['Close session', 'Close session'], ['Reopen session', 'Reopen session']]) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await act(async () => { fireEvent.click(dialog().getByRole('button', { name: confirm })); });
    }
    expect(transport.mutations.map(value => value.command.command)).toEqual(['topic_archive', 'topic_restore', 'topic_archive', 'topic_restore', 'session_close', 'session_reopen']);
    expect(transport.source.items).toEqual(items); expect(transport.source.messages).toEqual(messages);
    expect(binding.dispatch_state).toBe('paused'); expect(transport.source.state).toBe('active');
  });
  it('closes against the current revision after an agent write and keeps uncertain requests after unmount', async () => {
    const { props, topic, transport, store, actions } = await setup(true);
    const view = render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    // An agent write while the confirmation is open never holds Close: it closes the session as it is now.
    ++transport.source.revision; await act(async () => { await store.refresh(); });
    expect((dialog().getByRole('button', { name: 'Close session' }) as HTMLButtonElement).disabled).toBe(false);
    expect(dialog().queryByRole('button', { name: 'Review current state' })).toBeNull();
    transport.replies.push(new Error('Lost acknowledgement'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Close session' })); });
    expect((transport.mutations[0]!.command.params as { expected_revision: number }).expected_revision).toBe(transport.source.revision);
    const request = structuredClone(transport.mutations[0]); view.unmount(); render(<HistoryActions {...props} />);
    expect(actions.getSnapshot().pending).toEqual(request); expect(transport.mutations).toHaveLength(1);
    // The column offers the reconcile while an uncertain action holds every other change.
    expect((screen.getByRole('button', { name: `Archive ${topic.name}` }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request]);
    expect(screen.queryByRole('button', { name: 'Reconcile saved action' })).toBeNull();
  });
  it('keeps an uncertain direct archive for an exact reconcile and reports a failed one', async () => {
    const { props, topic, transport } = await setup(true); render(<HistoryActions {...props} />);
    transport.replies.push(new Error('Lost acknowledgement'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` })); });
    expect(screen.getByRole('alert').textContent).not.toBe(''); expect(screen.queryByRole('dialog')).toBeNull();
    const request = structuredClone(transport.mutations[0]); transport.replies.push(new Error('Still lost'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request]); expect(screen.getByRole('alert').textContent).not.toBe('');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile saved action' })); });
    expect(transport.mutations).toEqual([request, request, request]); expect(screen.queryByRole('alert')).toBeNull();
    expect(transport.source.topics[topic.id]!.archived_at).not.toBeNull();
  });
  it('keeps the archive confirmation open with the reason when the save is refused, then archives the topic as it is now', async () => {
    const { props, topic, transport, store } = await setup(); render(<HistoryActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: `Archive ${topic.name}` }));
    // An agent write moved the topic on: core refuses the stale revision and the dialog says so.
    transport.replies.push(failure('revision_conflict'));
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Archive topic' })); });
    expect(dialog().getByRole('alert').textContent).toContain('This changed while you were working.');
    expect(dialog().getByRole('alert').textContent).not.toContain('revision_conflict');
    expect(transport.source.topics[topic.id]!.archived_at).toBeNull();
    ++transport.source.revision; ++transport.source.topics[topic.id]!.revision; await act(async () => { await store.refresh(); });
    await act(async () => { fireEvent.click(dialog().getByRole('button', { name: 'Archive topic' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(transport.mutations[1]!.command).toMatchObject({ command: 'topic_archive', params: { topic_id: topic.id, expected_revision: transport.source.topics[topic.id]!.revision - 1 } });
    expect(transport.source.topics[topic.id]!.archived_at).not.toBeNull();
  });
});

describe('explicit Continue preview and request identity', () => {
  const navigations: NavigationStore[] = [];
  afterEach(() => { navigations.splice(0).forEach(navigation => navigation.stop()); });
  // The app's Continue dialog (ui/dialogs/ContinueTopicDialog) over the history fixture, opened for its first topic.
  async function previewSetup(blocked = false) {
    const transport = new HistoryTransport(); transport.blocked = blocked;
    const service = createDesktopService(transport), navigation = new NavigationStore(service); navigations.push(navigation);
    await navigation.start();
    const store = navigation.opened.open(route), targetStore = navigation.opened.open(targetRoute);
    await store.refresh(); await targetStore.refresh();
    const controllers = new SessionActionControllers(service, () => op), targetActions = controllers.forSession(targetStore);
    const topic = Object.values(transport.source.topics)[0]!, sent: SessionRef[] = [];
    render(<ContinueTopicHost navigation={navigation} actions={controllers} onSent={target => { sent.push(target); }} />);
    act(() => { openContinueTopic({ source: route, topicId: topic.id, target: targetRoute }); });
    await waitFor(() => expect(screen.queryByText('Preparing the summary…')).toBeNull());
    return { transport, store, targetActions, topic, sent };
  }
  const send = () => screen.getByRole('button', { name: /^Send to / }) as HTMLButtonElement;
  it('shows the grouped summary and queued readiness before Send, then sends the reviewed revisions', async () => {
    const { transport, topic, sent } = await previewSetup();
    expect(screen.getByText(/isn’t running, so the summary waits until it runs again/)).toBeDefined();
    const summary = screen.getByLabelText('Summary');
    expect(summary.getAttribute('data-summary')).toBe('Approved full snapshot. Keep copied source provenance.');
    expect(within(summary).getByText(/^Waiting on you · \d+$/)).toBeDefined();
    expect(transport.mutations).toHaveLength(0);
    expect(transport.queries.filter(query => query.request.command === 'topic_continue_preview')).toMatchObject([{ session: null }]);
    const source = structuredClone(transport.source);
    await act(async () => { fireEvent.click(send()); });
    expect(transport.mutations).toHaveLength(1);
    expect(transport.mutations[0]).toMatchObject({ session: targetRoute, command: { command: 'topic_continue', params: {
      source: route, source_topic_id: topic.id, source_revision: source.revision, source_sha256: 'a'.repeat(64), target: targetRoute,
      summary: 'Approved full snapshot. Keep copied source provenance.',
    } } });
    expect(transport.source).toEqual(source);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(sent).toEqual([targetRoute]);
  });
  it('blocks a changed preview, prepares again deliberately and freezes an uncertain Send across source change', async () => {
    const { transport, store, targetActions } = await previewSetup(); ++transport.source.revision;
    await act(async () => { await store.refresh(); });
    expect(send().disabled).toBe(true);
    expect(screen.getByText('The topic or this session changed. Prepare the summary again before sending.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare again' }));
    await waitFor(() => expect(send().disabled).toBe(false));
    transport.replies.push(new Error('Lost acknowledgement'));
    await act(async () => { fireEvent.click(send()); });
    const request = structuredClone(transport.mutations[0]); ++transport.source.revision;
    await act(async () => { await store.refresh(); });
    expect(screen.queryByRole('button', { name: 'Prepare again' })).toBeNull();
    expect(targetActions.getSnapshot().pending).toEqual(request);
    const alert = screen.getByText(/isn’t sure the summary was sent/);
    expect(alert.getAttribute('data-operation-id')).toBe(request.command.op_id);
    transport.replies.push(failure('preview_stale'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(transport.mutations).toEqual([request, request]); expect(targetActions.getSnapshot().pending).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare again' })).toBeDefined();
  });
  it('disables Send for an unknown target binding', async () => {
    const { transport } = await previewSetup(true);
    expect(screen.getByRole('alert').textContent).toMatch(/can’t take this topic now: Ariadne can’t tell which agent is connected\./);
    expect(send().disabled).toBe(true);
    expect(transport.mutations).toHaveLength(0);
  });
  it.each(['preview_stale', 'queue_full', 'invalid_transition', 'incompatible_adapter', 'binding_mismatch', 'not_found', 'invalid_argument', 'capacity_exceeded', 'io_error', 'commit_uncertain'] as const)('clears only replay-first Continue guard %s', async code => {
    const { transport, targetActions } = await previewSetup(); transport.replies.push(failure(code));
    await act(async () => { fireEvent.click(send()); });
    // Wire validation (invalid_argument) rejects before any store opens: never saved, so never held.
    expect(targetActions.getSnapshot().pending === null).toBe(['preview_stale', 'queue_full', 'invalid_transition', 'incompatible_adapter', 'invalid_argument'].includes(code));
  });
});

describe('Continue target picker', () => {
  const summary = (session_id: string, extra: Partial<SessionSummary> = {}) => ({
    project_id: route.project_id, session_id, title: `Session ${session_id.slice(-1)}`, state: 'active',
    active_binding: { adapter_id: 'codex', connection_state: 'connected' }, ...extra,
  }) as unknown as SessionSummary;
  it('lists the other active sessions, those of the topic’s own project first', () => {
    const elsewhere = summary('00000000-0000-4000-8000-000000000005', { project_id: '00000000-0000-4000-8000-0000000000aa' });
    const targets = continueTargets(route, [elsewhere, summary(route.session_id), summary('00000000-0000-4000-8000-000000000006', { state: 'closed' }),
      summary(secondId, { active_binding: null })]);
    expect(targets.map(target => target.route.session_id)).toEqual([secondId, elsewhere.session_id]);
    expect(targets.map(target => target.detail)).toEqual(['No agent connected', 'codex · running · another project']);
  });
  it('picks a session or cancels, and says when no session can take the topic', () => {
    const picked: SessionRef[] = []; let cancelled = 0;
    const { rerender } = render(<ContinuePicker topicName="Delivery decisions" targets={continueTargets(route, [summary(secondId)])}
      onPick={target => { picked.push(target); }} onCancel={() => { cancelled++; }} />);
    const dialog = screen.getByRole('dialog', { name: 'Continue “Delivery decisions” in another session' });
    const option = within(dialog).getByRole('button', { name: 'Session 3' });
    expect(option.getAttribute('aria-describedby') && document.getElementById(option.getAttribute('aria-describedby')!)?.textContent).toBe('codex · running');
    fireEvent.click(option); expect(picked).toEqual([targetRoute]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(cancelled).toBe(1);
    rerender(<ContinuePicker topicName="Delivery decisions" targets={[]} onPick={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('No other open session can take this topic.')).toBeDefined();
  });
});

describe('saved receipts and copied provenance', () => {
  it.each(['revision_conflict', 'invalid_transition', 'topic_not_archivable', 'session_not_closable', 'not_found', 'invalid_argument', 'io_error', 'commit_uncertain'] as const)('retains uncertainty except replay-first lifecycle guard %s', async code => {
    const { transport, actions, topic } = await setup(true); transport.replies.push(failure(code));
    await actions.execute({ command: 'topic_archive', api_version: 1, op_id: '', params: { topic_id: topic.id, expected_revision: topic.revision } }, transport.source.revision);
    expect(actions.getSnapshot().pending === null).toBe(['revision_conflict', 'invalid_transition', 'topic_not_archivable', 'session_not_closable', 'invalid_argument'].includes(code));
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
  it('names the missing original project folder and says to restore it; other failures keep the general words', async () => {
    const { transport, store, topic } = await setup();
    const item = Object.values(transport.source.items)[0]!;
    item.origin = { project_id: op, session_id: op, topic_id: topic.id, entity_id: '77', source_revision: 1 };
    ++transport.source.revision; await store.refresh();
    let code: CoreFailure['error']['code'] = 'io_error';
    render(<CopiedProvenance store={store} itemId={item.id} projectPath={id => id === op ? '/work/sync-api' : null} revealItem={async () => {
      throw new CoreFailure({ code, message: 'No such file or directory (os error 2)', hint: 'Check the path.', retryable: false, field_errors: [] });
    }} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Source item 77' })); });
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toContain('The original project folder (/work/sync-api) is missing or can’t be read. Restore it or move it back, then try again.');
    expect(status).toContain('Full copied history remains here.');
    expect(status).not.toMatch(/Try again\.|couldn’t read or save|os error/);
    // Another kind of failure is not blamed on the folder.
    code = 'corrupt_session';
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Source item 77' })); });
    expect(screen.getByRole('status').textContent).toContain('Original project is unavailable. Ariadne can’t read this session’s saved data.');
    expect(screen.getByRole('status').textContent).not.toContain('folder');
    // The original session was removed or its project is no longer registered (core's not_found): the folder is fine.
    code = 'not_found';
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Source item 77' })); });
    const gone = screen.getByRole('status').textContent ?? '';
    expect(gone).toContain('The original item is no longer in Ariadne. Full copied history remains here.');
    expect(gone).not.toMatch(/folder|Restore it|Original project is unavailable/);
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
