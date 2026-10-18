import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions, useSession } from '../../../src/data/session-store';
import type { Input, Session } from '../../../src/generated/domain/models';
import { SessionActions } from '../../../src/components/bindings/actions';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { notices } from '../../../src/ui/pages/notices';
import { toasts } from '../../../src/ui/shell/toast';
import { STUCK_CHECK_MS, useStuckNotices } from '../../../src/ui/answer/useStuckNotices';
import { AppTransport, route } from '../app/transport';

const opened: OpenSessions[] = [];
const old = () => new Date(Date.now() - 3 * 60_000).toISOString();
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); notices.clear(); vi.useRealTimers(); });

type Patch = (input: Input, session: Session) => void;
/** One owner input alone in the session (so nothing is "behind" another), made `state`/`kind` and `patch`ed. */
async function setup(state: Input['state'], patch: Patch = () => {}, kind: Input['kind'] = 'reply', itemId: string | null = '3') {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const input = Object.values(session.inputs).find(value => value?.kind === 'reply')!;
  input.state = state; input.kind = kind; input.created_at = old(); input.binding_id = session.active_binding_id!;
  input.target = { topic_id: input.target.topic_id, item_id: itemId };
  input.resolution_history = [];
  if (state === 'needs_attention') {
    input.attempts[0]!.acceptance = 'uncertain'; input.attempts[0]!.host_turn_id = null; input.attempts[0]!.turn_state = 'unknown'; input.attempts[0]!.sealed_at = null;
    input.active_attempt_id = input.attempts[0]!.id;
  }
  session.inputs = { [input.id]: input };
  patch(input, session);
  const service = createDesktopService(transport), sessions = new OpenSessions(service);
  opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const drafts = new OwnerDraftStore(service); await drafts.load();
  const actions = new SessionActions(service, store);
  const openItem = vi.fn(), openTopic = vi.fn();
  function Harness() {
    const current = useSession(store);
    useStuckNotices({ session: current.snapshot?.session ?? null, actions, drafts, openItem, openTopic });
    return null;
  }
  const view = render(<Harness />);
  return { transport, session, input, store, drafts, actions, openItem, openTopic, view };
}
const shown = () => notices.getSnapshot().filter(notice => notice.id.startsWith('stuck:'));

describe('stuck notices (alpha.21 E17)', () => {
  it('says a queued reply has not reached the agent after 2 minutes, with Edit', async () => {
    const { input } = await setup('queued', (value, session) => { value.payload.target_snapshot.item_question = 'which cache keys'; session.bindings[session.active_binding_id!]!.adapter_id = 'claude_code_mod'; });
    await waitFor(() => expect(shown()).toHaveLength(1));
    const notice = shown()[0]!;
    expect(notice.id).toBe(`stuck:${route.session_id}:${input.id}`);
    expect(notice.tone).toBe('warn');
    expect(notice.text).toBe('Your reply about “which cache keys” hasn’t reached Claude Code after 2 minutes. It’s kept.');
    expect(notice.actions?.map(action => action.label)).toEqual(['Edit']);
  });

  it('says an in-flight reply has not been picked up, with Show it', async () => {
    const { openItem } = await setup('in_flight');
    await waitFor(() => expect(shown()).toHaveLength(1));
    const notice = shown()[0]!;
    expect(notice.tone).toBe('warn');
    expect(notice.text).toContain('hasn’t been picked up after 2 minutes. It’s kept.');
    expect(notice.actions?.map(action => action.label)).toEqual(['Show it']);
    act(() => notice.actions![0]!.run());
    expect(openItem).toHaveBeenCalledWith('3');
  });

  it('opens a topic reply in topic mode', async () => {
    const { openItem, openTopic, input } = await setup('in_flight', undefined, 'topic_reply', null);
    await waitFor(() => expect(shown()).toHaveLength(1));
    act(() => shown()[0]!.actions![0]!.run());
    expect(openItem).not.toHaveBeenCalled();
    expect(openTopic).toHaveBeenCalledWith(input.target.topic_id);
  });

  it('makes a problem of a stopped delivery, keeping StuckNote’s explanation and offering Retry only for a plain resend', async () => {
    const { transport, input, session } = await setup('needs_attention');
    await waitFor(() => expect(shown()).toHaveLength(1));
    // While the agent is still working, Retry waits (StuckNote does the same).
    expect(shown()[0]!.actions![0]!.disabled).toBe(true);
    const binding = session.bindings[session.active_binding_id!]!;
    act(() => transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation: { instance_id: 'i', generation: binding.generation,
      connection_state: 'connected', execution_state: 'idle', source: 'host_poll', last_seen_at: new Date().toISOString(), process_identity: null, freshness: 'fresh' } }));
    await waitFor(() => expect(shown()[0]!.actions![0]!.disabled).toBe(false));
    const notice = shown()[0]!;
    expect(notice.tone).toBe('problem');
    expect(notice.text).toContain('Ariadne isn’t sure it reached');
    expect(notice.text).toContain('Retry sends that same message once.');
    expect(notice.actions?.map(action => action.label)).toEqual(['Retry', 'Show it']);
    await act(async () => { notice.actions![0]!.run(); });
    await waitFor(() => expect(transport.mutations.some(request => 'command' in request && request.command.command === 'input_resolve'
      && request.command.params.decision === 'resend' && request.command.params.input_id === input.id)).toBe(true));
    await waitFor(() => expect(toasts.current()?.text).toMatch(/^Sent your reply about “.+” once, at \d\d:\d\d\.$/u));
  });

  it('offers no Retry when the agent already has the message (that one asks first)', async () => {
    await setup('needs_attention', value => { value.attempts[0]!.acceptance = 'accepted'; value.attempts[0]!.host_turn_id = 'turn-1'; value.attempts[0]!.turn_state = 'completed'; value.attempts[0]!.result_state = 'missing'; });
    await waitFor(() => expect(shown()).toHaveLength(1));
    expect(shown()[0]!.actions?.map(action => action.label)).toEqual(['Show it']);
    expect(shown()[0]!.text).not.toContain('Retry sends');
  });

  it('Edit takes a queued message back and opens its editor with the exact words and the taken-back mark', async () => {
    const { input, drafts, openItem } = await setup('queued', value => { value.payload.text = '  exact words\nsecond line  '; });
    await waitFor(() => expect(shown()).toHaveLength(1));
    await act(async () => { shown()[0]!.actions![0]!.run(); });
    await waitFor(() => expect(openItem).toHaveBeenCalledWith('3'));
    const entry = drafts.find(route, '3', 'reply')!;
    expect(entry.draft.text).toBe('  exact words\nsecond line  ');
    expect(entry.origin).toBe('taken_back');
    expect(input.id).toBeTruthy();
    expect(shown()).toHaveLength(0);
  });

  it('keeps the message and says why when Edit cannot take it back', async () => {
    const { drafts, openItem, transport } = await setup('queued');
    await waitFor(() => expect(shown()).toHaveLength(1));
    const text = 'the owner already typed this';
    const id = drafts.begin(transport.sessions.get(route.session_id) as never, '3', 'reply')!;
    await act(async () => { await drafts.editSaved(id, { text }); });
    await act(async () => { shown()[0]!.actions![0]!.run(); });
    await waitFor(() => expect(openItem).toHaveBeenCalled());
    // The owner's own words stay in the editor.
    expect(drafts.find(route, '3', 'reply')!.draft.text).toBe(text);
  });

  it.each([
    ['younger than 2 minutes', 'queued', (value: Input) => { value.created_at = new Date().toISOString(); }],
    ['held (the question changed)', 'queued', (value: Input, session: Session) => { value.payload.target_snapshot.question_revision = 0; session.items['3']!.question_revision = 5; }],
    ['paused', 'queued', (_value: Input, session: Session) => { const binding = session.bindings[session.active_binding_id!]!; binding.owner_paused = true; binding.dispatch_state = 'paused'; }],
    ['not connected', 'queued', (_value: Input, session: Session) => { session.bindings[session.active_binding_id!]!.connection_state = 'disconnected'; }],
    ['behind another message', 'queued', (value: Input, session: Session) => {
      const first = structuredClone(value); first.id = '00000000-0000-4000-8000-0000000000aa'; first.seq = value.seq - 1; first.state = 'in_flight'; first.created_at = new Date().toISOString();
      session.inputs[first.id] = first;
    }],
    ['settled', 'handled', () => {}],
    ['cancelled', 'cancelled', () => {}],
  ] as const)('has no notice for a message %s', async (_name, state, patch) => {
    await setup(state, patch as Patch);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(shown()).toHaveLength(0);
  });

  it('shows one notice per message and case: closing it keeps it closed at the next check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await setup('queued');
    expect(shown()).toHaveLength(1);
    const notice = shown()[0]!;
    act(() => { notice.onDismiss?.(); notices.dismiss(notice.id); });
    await act(async () => { vi.advanceTimersByTime(STUCK_CHECK_MS * 2); });
    expect(shown()).toHaveLength(0);
  });

  it('checks the age every 15 seconds and removes the notice once the message settles', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { transport, store } = await setup('queued', value => { value.created_at = new Date(Date.now() - 100_000).toISOString(); });
    expect(shown()).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(STUCK_CHECK_MS * 2); });
    expect(shown()).toHaveLength(1);
    const session = transport.sessions.get(route.session_id)!;
    Object.values(session.inputs)[0]!.state = 'handled'; ++session.revision;
    await act(async () => { await store.refresh(); });
    expect(shown()).toHaveLength(0);
  });

  it('removes its notices when it unmounts', async () => {
    const { view } = await setup('in_flight');
    await waitFor(() => expect(shown()).toHaveLength(1));
    view.unmount();
    expect(shown()).toHaveLength(0);
  });
});
