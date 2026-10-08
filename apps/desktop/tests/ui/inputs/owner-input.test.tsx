import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { InputKind, Session, SessionSummary, ProjectSummary } from '../../../src/generated/domain/models';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import summariesFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { OwnerDraft, OwnerMutationRequest, PreferencesSnapshot } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { ALREADY_WAITING, blockedDraft, emptyDraft, OwnerDraftStore, TOPIC_REPLY } from '../../../src/state/drafts/store';
import { immutable, plainFailure } from '../../../src/data';
import { deliveryLine } from '../../../src/ui/answer/delivery';
import { editQueued, NOT_TAKEN_BACK, putBackCancelled } from '../../../src/ui/answer/held';
import { StuckNote } from '../../../src/ui/answer/StuckNote';
import { sessionActionsFor, type SessionActions } from '../../../src/components/bindings/actions';
import { AnswerSlot, changedText, type AnswerSlotProps } from '../../../src/ui/detail/AnswerSlot';
import type { PendingSubmission } from '../../../src/ui/answer/useSubmit';
import { WaitingColumn } from '../../../src/ui/waiting/WaitingColumn';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { HistoryTransport } from '../history/fixtures';

const route = { project_id: demo.project_id, session_id: demo.id };
const opened: OpenSessions[] = [];
const waitingStores: WaitingStore[] = [];
afterEach(() => { cleanup(); waitingStores.splice(0).forEach(value => value.stop()); opened.splice(0).forEach(value => value.closeAll()); });
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
function preferences(): PreferencesSnapshot {
  return { schema_version: 1, revision: 1, global: { theme: 'system', selected_navigation: { kind: 'projects' }, window: null, pinned: false, notification_watermark: null }, sessions: [], later: [], drafts: [] };
}
async function setup(saved: OwnerDraft[] = []) {
  const session = structuredClone(demo) as Session, prefs = preferences(); prefs.drafts = structuredClone(saved);
  session.items['2']!.options = [{ id: 'yes', label: 'Keep the design', consequence: 'Retain the current contract.', recommended: true },
    { id: 'no', label: 'Change the design', consequence: 'Review a new contract.', recommended: false }];
  const calls: OwnerMutationRequest[] = [], writes: OwnerMutationRequest[] = [];
  let outcome: 'ok' | 'uncertain' | 'malformed' | 'error' | 'question_changed' | 'operation_reused' = 'ok', preferenceOutcome: 'ok' | 'uncertain' = 'ok', readError = false, deleteConflicts = 0;
  let submitGate: Promise<void> | null = null, cancelGate: Promise<void> | null = null;
  let cancelOutcome: 'ok' | 'refused' | 'uncertain' = 'ok';
  // What happened, in order: a confirmed cancel, and each draft text saved.
  const events: string[] = [];
  const transport: DesktopTransport = {
    async invoke<T>(command: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
      const envelope = (data: unknown) => ({ api_version: 1, ok: true, data }) as T;
      const error = (code: string) => ({ api_version: 1, ok: false, error: { code, message: 'Save could not be confirmed.', hint: 'Retry the original operation.', retryable: true, field_errors: [] } }) as T;
      if (command === 'preferences_get') return envelope({ kind: command, data: structuredClone(prefs) });
      if (command === 'project_list') {
        const project = structuredClone(projectsFixture.items[0]) as ProjectSummary;
        const summary = structuredClone(summariesFixture.items[0]) as SessionSummary;
        return envelope({ kind: command, data: { counts: summary.counts, projects: { items: [project], next_cursor: null, snapshot_revision: 21 } } });
      }
      if (command === 'session_list') {
        const summary = structuredClone(summariesFixture.items[0]) as SessionSummary;
        return envelope({ kind: command, data: { counts: summary.counts, active_total: 1, closed_total: 0,
          sessions: { items: [summary], next_cursor: null, snapshot_revision: 21 } } });
      }
      if (command === 'session_get') {
        if (readError) throw new Error('unavailable');
        return envelope({ kind: command, data: { session: structuredClone(session), freshness: 'fresh' } });
      }
      if (command === 'reveal_item' && 'request' in args.request && args.request.request.command === 'reveal_item') {
        return envelope({ kind: command, data: { ...route, item_id: args.request.request.params.item_id } });
      }
      if (command === 'item_messages' || command === 'item_rounds' || command === 'session_read') {
        const history = new HistoryTransport(); history.session = session; return envelope(history.response(args.request));
      }
      if (!('command' in args.request)) throw new Error('Unexpected query');
      const request = structuredClone(args.request); writes.push(request);
      if (request.command.command === 'preferences_patch') {
        if (preferenceOutcome === 'uncertain') return error('commit_uncertain');
        if (deleteConflicts > 0 && request.command.params.entries.some(entry => entry.kind === 'delete_draft')) { deleteConflicts--; prefs.revision++; return error('revision_conflict'); }
        for (const entry of request.command.params.entries) {
          if (entry.kind === 'upsert_draft') events.push(`draft:${entry.draft.text}`);
          if (entry.kind === 'upsert_draft') prefs.drafts = [...prefs.drafts.filter(draft => draft.op_id !== entry.draft.op_id), structuredClone(entry.draft)];
          if (entry.kind === 'delete_draft') prefs.drafts = prefs.drafts.filter(draft => draft.op_id !== entry.operation_id);
          if (entry.kind === 'set_later') {
            prefs.later = prefs.later.filter(item => item.project_id !== entry.item.project_id || item.session_id !== entry.item.session_id || item.item_id !== entry.item.item_id);
            if (entry.later) prefs.later.push(structuredClone(entry.item));
          }
        }
        prefs.revision++;
        return envelope({ operation_id: request.command.op_id, preferences_revision: prefs.revision });
      }
      calls.push(request);
      if (request.command.command === 'input_cancel') {
        // The session read afterwards sees the input cancelled, as core would have it.
        const cancelling = request.command.params.input_id;
        if (cancelGate) await cancelGate;
        if (cancelOutcome === 'refused') return error('invalid_transition');
        if (cancelOutcome === 'uncertain') return error('commit_uncertain');
        session.inputs[cancelling]!.state = 'cancelled'; session.revision++;
        session.inputs[cancelling]!.cancel_cause = request.command.params.purpose === 'edit' ? 'owner_edit' : 'owner';
        events.push('cancelled');
        return envelope({ operation_id: request.command.op_id, session_id: session.id, revision: session.revision,
          data: { kind: 'input_cancel', input_id: cancelling, state: 'cancelled' } });
      }
      if (submitGate) await submitGate;
      if (outcome === 'uncertain') return error('commit_uncertain');
      if (outcome === 'error') return error('queue_full');
      if (outcome === 'question_changed' || outcome === 'operation_reused') return error(outcome);
      return envelope({ operation_id: request.command.op_id, session_id: session.id, revision: session.revision + 1,
        data: { kind: outcome === 'malformed' ? 'input_cancel' : 'input_submit', input_id: uuid(70), message_id: uuid(71), message_number: 40, answer_id: null, input_seq: 4 } });
    },
    async listen() { return () => {}; },
  };
  let counter = 0;
  const service = createDesktopService(transport), drafts = new OwnerDraftStore(service, () => uuid(++counter)), sessions = new OpenSessions(service);
  opened.push(sessions); const store = sessions.open(route); await Promise.all([store.refresh(), drafts.load()]);
  return { session, prefs, calls, writes, events, drafts, store, service, sessions, outcome: (value: typeof outcome) => { outcome = value; },
    gateCancel: () => { let resolve!: () => void; cancelGate = new Promise<void>(done => { resolve = () => { cancelGate = null; done(); }; }); return resolve; },
    preferenceOutcome: (value: typeof preferenceOutcome) => { preferenceOutcome = value; }, cancelOutcome: (value: typeof cancelOutcome) => { cancelOutcome = value; }, unavailable: () => { readError = true; }, available: () => { readError = false; }, conflictDeletes: (count: number) => { deleteConflicts = count; },
    gate: () => { let resolve!: () => void; submitGate = new Promise<void>(done => { resolve = done; }); return resolve; },
    render: (itemId = '2', props: Partial<AnswerSlotProps> = {}) => render(<AnswerSlot drafts={drafts} store={store} itemId={itemId} onEscape={() => {}} {...props} />),
    restart: async () => { const restored = new OwnerDraftStore(service, () => uuid(++counter)); await restored.load(); return restored; } };
}
const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('owner input component and durable draft controller', () => {
  // The tree's z-persists-Later versus editor-typing check lives in App.test.tsx now that rows hand z to the workspace keys.
  it.each([['1', 'Follow up', 'Follow-up message'], ['1.1', 'Reply', 'Reply message']])('focuses the box only after explicit %s %s; Esc closes it and keeps the draft', async (itemId, action, label) => {
    const value = await setup(), user = userEvent.setup();
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId={itemId} later={false} onOpenItem={() => {}} />);
    const button = await screen.findByRole('button', { name: action });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const textarea = await screen.findByRole('textbox', { name: label });
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    await user.keyboard('Retain this draft');
    await user.click(button);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(button);
    expect((screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement).value).toBe('Retain this draft'); expect(value.calls).toHaveLength(0);
  });
  it('drops with the optional reason on Enter', async () => {
    const value = await setup(), user = userEvent.setup(), item = value.session.items['1.1']!;
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="1.1" later={false} onOpenItem={() => {}} />);
    const drop = await screen.findByRole('button', { name: 'Drop' });
    await waitFor(() => expect(drop.hasAttribute('disabled')).toBe(false));
    await user.click(drop);
    expect(screen.getByText('Tells the agent to drop it. It stays in the tree, marked Dropped.')).toBeTruthy();
    await user.type(await screen.findByRole('textbox', { name: 'Drop reason' }), 'covered elsewhere{Enter}');
    await waitFor(() => expect(value.calls).toHaveLength(1));
    const sent = value.calls[0]!.command;
    expect(sent.command === 'input_submit' && [sent.params.kind, sent.params.text]).toEqual(['drop', `Let’s drop this (covered elsewhere): ${item.question}`]);
  });
  it('pre-selects the recommendation; numbers select only; focused Cmd+Enter and duplicate clicks send the reply once after durable draft save', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    expect(screen.getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(true);
    const [first, second] = screen.getAllByRole('button').filter(button => button.hasAttribute('data-answer-option'));
    expect(first!.getAttribute('aria-pressed')).toBe('true'); expect(screen.getByRole('button', { name: 'Send “Keep the design”' })).toBeTruthy();
    second!.focus(); fireEvent.keyDown(second!, { key: '2' });
    await waitFor(() => expect(second!.getAttribute('aria-pressed')).toBe('true'));
    expect(value.calls).toHaveLength(0);
    fireEvent.change(editor(), { target: { value: ' Exact owner bytes \n' } });
    const finish = value.gate(); editor().focus(); fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    const send = screen.getByRole('button', { name: 'Send reply' }); fireEvent.click(send); fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(value.calls).toHaveLength(1));
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true);
    expect(value.calls[0]?.command.command === 'input_submit' && value.calls[0].command.params).toMatchObject({ text: ' Exact owner bytes \n', selected_option_id: null });
    await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4'); expect(value.calls).toHaveLength(1); expect(value.prefs.drafts).toEqual([]);
    expect(value.session.items['2']!.status).toBe('waiting_on_me');
  });
  it('retains editable unsent text over detail changes, unrelated preferences, refresh and restart without auto-send', async () => {
    const value = await setup(), view = value.render(); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: 'Keep this draft' } });
    await waitFor(() => expect(value.prefs.drafts[0]?.text).toBe('Keep this draft'));
    view.rerender(<AnswerSlot drafts={value.drafts} store={value.store} itemId="4" onEscape={() => {}} />); expect(screen.queryByRole('textbox')).toBeNull();
    value.prefs.global.theme = 'dark'; value.prefs.revision++;
    view.rerender(<AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={() => {}} />); expect(editor().value).toBe('Keep this draft');
    await act(async () => { await value.store.refresh(); }); expect(editor().value).toBe('Keep this draft');
    const restored = await value.restart(); view.rerender(<AnswerSlot drafts={restored} store={value.store} itemId="2" onEscape={() => {}} />);
    expect(editor().value).toBe('Keep this draft'); expect(editor().disabled).toBe(false); expect(value.calls).toHaveLength(0);
  });
  it('persists the latest logical edits queued behind an uncertain preference operation after explicit reconciliation', async () => {
    const value = await setup(), id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '2', 'answer')!;
    value.preferenceOutcome('uncertain');
    value.drafts.edit(id, { text: 'First keystroke' });
    value.drafts.edit(id, { text: 'Latest complete explanation' });
    await waitFor(() => expect(value.drafts.getSnapshot().preferenceUncertain).toBe(true));
    expect(value.drafts.getSnapshot().entries[id]?.draft.text).toBe('Latest complete explanation');
    const original = structuredClone(value.writes[0]); value.preferenceOutcome('ok');
    expect(await value.drafts.retryPreferences()).toBe(true);
    const restored = await value.restart();
    expect(restored.getSnapshot().entries[id]?.draft.text).toBe('Latest complete explanation');
    expect(value.writes[1]).toEqual(original);
    expect(value.writes[2]?.command.op_id).not.toBe(original?.command.op_id);
    expect(value.writes[2]?.command.command === 'preferences_patch' && value.writes[2].command.params.expected_preferences_revision).toBe(2);
    expect(value.calls).toHaveLength(0);
  });
  it.each(['in_progress', 'replaced'] as const)('keeps a restored attempted answer reachable and exactly retryable after the item becomes %s', async status => {
    const value = await setup(), view = value.render(); await screen.findByRole('textbox'); value.outcome('uncertain');
    fireEvent.change(editor(), { target: { value: 'Frozen original answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); await screen.findByRole('button', { name: 'Try sending again' });
    const original = structuredClone(value.calls[0]), restored = await value.restart();
    value.session.items['2']!.status = status; value.session.items['2']!.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    view.rerender(<AnswerSlot drafts={restored} store={value.store} itemId="2" onEscape={() => {}} />);
    expect(screen.getByRole('button', { name: 'Try sending again' }).hasAttribute('disabled')).toBe(false);
    expect(editor().value).toBe('Frozen original answer'); expect(editor().disabled).toBe(true); expect(value.calls).toHaveLength(1);
    value.outcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Try sending again' }));
    await waitFor(() => expect(value.prefs.drafts).toEqual([])); expect(value.calls[1]).toEqual(original);
  });
  it.each(['uncertain', 'malformed'] as const)('freezes exact op/body after %s receipt and explicitly replays it across restart and a changed target', async outcome => {
    const value = await setup(), view = value.render(); await screen.findByRole('textbox'); value.outcome(outcome);
    fireEvent.change(editor(), { target: { value: 'Exact untrimmed bytes  ' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByRole('button', { name: 'Try sending again' }); expect(value.prefs.drafts[0]?.submission_attempted).toBe(true);
    const original = structuredClone(value.calls[0]); expect(editor().disabled).toBe(true);
    const restored = await value.restart(); value.session.items['2']!.question_revision++; value.session.items['2']!.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); }); view.rerender(<AnswerSlot drafts={restored} store={value.store} itemId="2" onEscape={() => {}} />);
    expect(value.calls).toHaveLength(1); value.outcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Try sending again' }));
    await screen.findByText('Saved · Queue position #4'); expect(value.calls[1]).toEqual(original); expect(value.prefs.drafts).toEqual([]);
  });
  it('keeps the typed text and chosen option when the agent-not-running dialog is cancelled; Queue saves the send', async () => {
    const value = await setup(), held: PendingSubmission[] = [];
    value.session.bindings[value.session.active_binding_id!]!.connection_state = 'disconnected'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    value.render('2', { onAgentNotRunning: submission => { held.push(submission); } }); await screen.findByRole('textbox');
    const [, second] = screen.getAllByRole('button').filter(button => button.hasAttribute('data-answer-option'));
    second!.focus(); fireEvent.keyDown(second!, { key: '2' });
    await waitFor(() => expect(second!.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.change(editor(), { target: { value: 'Keep my words' } });
    const saved = () => Object.values(value.drafts.getSnapshot().entries).find(entry => entry.draft.target.item_id === '2')!.draft;
    await waitFor(() => expect(saved().text).toBe('Keep my words'));
    const reply = screen.getByRole('button', { name: 'Send reply' });
    await waitFor(() => expect(reply.hasAttribute('disabled')).toBe(false));
    fireEvent.click(reply);
    expect(held).toHaveLength(1); expect(held[0]!.change).toEqual({ selected_option_id: null, text: 'Keep my words' });
    // Cancel: the dialog never queues, so the draft is unchanged.
    expect([saved().text, saved().selected_option_id]).toEqual(['Keep my words', 'no']);
    fireEvent.click(screen.getByRole('button', { name: 'Send “Change the design”' }));
    expect(held).toHaveLength(2); expect(held[1]!.change).toEqual({ selected_option_id: 'no', text: '' });
    expect([saved().text, saved().selected_option_id]).toEqual(['Keep my words', 'no']);
    expect(editor().value).toBe('Keep my words'); expect(value.calls).toHaveLength(0);
    await act(async () => { await held[1]!.queue(); });
    const sent = value.calls[0]!.command;
    expect(sent.command === 'input_submit' && [sent.params.text, sent.params.selected_option_id]).toEqual(['', 'no']);
  });
  it('asks to review a saved detail reply after the item changed, then sends it re-based on the current revision', async () => {
    const value = await setup(), user = userEvent.setup();
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="1.1" later={false} onOpenItem={() => {}} />);
    const reply = await screen.findByRole('button', { name: 'Reply' });
    await waitFor(() => expect(reply.hasAttribute('disabled')).toBe(false));
    await user.click(reply);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Reply message' }), { target: { value: 'Keep this reply' } });
    await waitFor(() => expect(value.prefs.drafts[0]?.text).toBe('Keep this reply'));
    value.session.items['1.1']!.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    expect(screen.getByText('This item changed. Review the current question and options; your text is retained.')).toBeTruthy();
    const send = screen.getByRole('button', { name: /Send reply/ });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' }));
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Keep this reply');
    expect(screen.queryByText('This item changed. Review the current question and options; your text is retained.')).toBeNull();
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(value.calls).toHaveLength(1));
    const sent = value.calls[0]!.command;
    expect(sent.command === 'input_submit' && [sent.params.kind, sent.params.text]).toEqual(['reply', 'Keep this reply']);
  });
  it('requires deliberate target review after a revision change and reselects options without discarding text', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: 'Retain explanation' } });
    value.session.items['2']!.revision++; value.session.items['2']!.question_revision++; value.session.revision++;
    value.session.rounds[value.session.items['2']!.current_round_id!]!.question_revision++;
    await act(async () => { await value.store.refresh(); });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); expect(value.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' })); expect(editor().value).toBe('Retain explanation');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); await screen.findByText('Saved · Queue position #4');
    expect(value.calls[0]?.command.command === 'input_submit' && value.calls[0].command.params.expected_question_revision).toBe(value.session.items['2']!.question_revision);
  });
  it('never sends before an uncertain preference save is explicitly reconciled', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); value.preferenceOutcome('uncertain');
    fireEvent.change(editor(), { target: { value: 'Do not dispatch before persistence' } });
    await screen.findByRole('button', { name: 'Try saving your draft again' }); expect(value.calls).toHaveLength(0); const request = structuredClone(value.writes.at(-1));
    value.preferenceOutcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Try saving your draft again' }));
    await waitFor(() => expect(value.drafts.getSnapshot().preferenceUncertain).toBe(false)); expect(value.writes.at(-1)).toEqual(request); expect(value.calls).toHaveLength(0);
  });
  it('preserves content and disables mutation after session read failure', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); fireEvent.change(editor(), { target: { value: 'Survives failure' } });
    value.unavailable(); await act(async () => { await value.store.refresh(); });
    expect(editor().value).toBe('Survives failure'); fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); expect(value.calls).toHaveLength(0);
  });
  it('prepares a separate reviewed draft only after definitive question rejection, retaining the old frozen record', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); value.outcome('question_changed');
    fireEvent.change(editor(), { target: { value: 'Owner explanation remains exact' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByRole('button', { name: 'Edit and send again' }); const original = structuredClone(value.prefs.drafts[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit and send again' }));
    await screen.findByRole('button', { name: 'Review current target' }); expect(value.calls).toHaveLength(1); expect(editor().value).toBe('Owner explanation remains exact');
    await waitFor(() => expect(value.prefs.drafts).toHaveLength(2)); expect(value.prefs.drafts[0]).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' })); value.outcome('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); await screen.findByText('Saved · Queue position #4');
    expect(value.calls[1]?.command.op_id).not.toBe(value.calls[0]?.command.op_id); expect(value.prefs.drafts).toEqual([original]);
  });
  it('never permits changed-payload recovery for operation reuse or restored unknown attempts', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); value.outcome('operation_reused');
    fireEvent.change(editor(), { target: { value: 'Keep operation identity' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByRole('button', { name: 'Try sending again' }); expect(screen.queryByRole('button', { name: 'Edit and send again' })).toBeNull();
    expect(editor().disabled).toBe(true); const restored = await value.restart();
    expect(Object.values(restored.getSnapshot().entries)[0]?.rejected).toBe(false); expect(value.calls).toHaveLength(1);
  });
  it.each(['closed', 'archived', 'binding', 'question', 'option'] as const)('checks the actual current %s guard before dispatch and keeps draft bytes', async guard => {
    const value = await setup(), id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '2', 'answer')!;
    value.drafts.edit(id, { text: 'Retained guard input' });
    if (guard === 'closed') value.session.state = 'closed';
    if (guard === 'archived') value.session.topics[value.session.items['2']!.topic_id]!.archived_at = value.session.updated_at;
    if (guard === 'binding') value.session.active_binding_id = null;
    if (guard === 'question') value.session.items['2']!.question_revision++;
    if (guard === 'option') value.drafts.edit(id, { selected_option_id: 'missing-current-option' });
    expect(await value.drafts.submit(id)).toBe(false); expect(value.calls).toHaveLength(0);
    expect(value.drafts.getSnapshot().entries[id]?.draft.text).toBe('Retained guard input');
  });
  it.each(['saving', 'uncertain', 'preferences', 'stale'] as const)('consumes a disabled numeric request during %s without altering frozen choice/body or replaying it later', async guard => {
    const value = await setup(), id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '2', 'answer')!;
    value.drafts.edit(id, { text: 'Exact retained bytes  ', selected_option_id: 'yes' });
    await waitFor(() => expect(value.prefs.drafts[0]?.selected_option_id).toBe('yes'));
    let finish: (() => void) | undefined, submission: Promise<boolean> | undefined;
    if (guard === 'saving') { finish = value.gate(); act(() => { submission = value.drafts.submit(id); }); await waitFor(() => expect(value.drafts.getSnapshot().entries[id]?.saving).toBe(true)); }
    if (guard === 'uncertain') { value.outcome('uncertain'); await act(async () => { await value.drafts.submit(id); }); }
    if (guard === 'preferences') { value.preferenceOutcome('uncertain'); act(() => { value.drafts.edit(id, { text: 'Exact retained bytes  ' }); }); await waitFor(() => expect(value.drafts.getSnapshot().preferenceUncertain).toBe(true)); }
    if (guard === 'stale') { value.unavailable(); await act(async () => { await value.store.refresh(); }); }
    const before = structuredClone(value.drafts.getSnapshot().entries[id]!.draft), consumed = vi.fn();
    const view = value.render('2', { focusRequest: { intent: 'answer', token: 1, optionIndex: 1 }, onFocusRequestConsumed: consumed });
    await waitFor(() => expect(consumed).toHaveBeenCalledWith(1));
    expect(screen.getByRole('button', { name: /2Change the design/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Answer' }), { key: '2' });
    expect(value.drafts.getSnapshot().entries[id]!.draft).toEqual(before);
    if (guard === 'saving') { await act(async () => { finish!(); await submission; }); expect(value.calls[0]?.command).toMatchObject({ params: { selected_option_id: 'yes', text: before.text } }); }
    if (guard === 'preferences') { value.preferenceOutcome('ok'); await act(async () => { await value.drafts.retryPreferences(); }); expect(value.drafts.getSnapshot().entries[id]!.draft).toEqual(before); }
    view.rerender(<AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={() => {}} focusRequest={{ intent: 'answer', token: 1, optionIndex: 1 }} onFocusRequestConsumed={consumed} />);
    expect(consumed).toHaveBeenCalledTimes(1);
    if (guard !== 'saving') expect(value.drafts.getSnapshot().entries[id]!.draft).toEqual(before);
  });
  it('connects the Waiting card to the same durable draft store and registered reveal callback', async () => {
    const value = await setup(), queue = new WaitingStore(value.service, value.sessions); waitingStores.push(queue);
    await queue.start(); let revealed: string | undefined;
    render(<WaitingColumn drafts={value.drafts} store={queue} revealItem={target => { revealed = target.item_id; }} openSession={() => {}} />);
    const send = await screen.findByRole('button', { name: 'Send answer' });
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' })); expect(revealed).toBe('2'); revealed = undefined;
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(value.calls).toHaveLength(1));
    expect(value.calls[0]?.command.command === 'input_submit' && value.calls[0].command.params).toMatchObject({ selected_option_id: 'yes', text: '' });
    fireEvent.click(await screen.findByText('Sending “Keep the design”…')); expect(revealed).toBe('2');
    expect(screen.getByText('Nothing waiting on you')).toBeTruthy();
  });
  it('moves an unknown Waiting answer to Sent as Checking and retries the exact operation from detail', async () => {
    const value = await setup(), queue = new WaitingStore(value.service, value.sessions); waitingStores.push(queue); await queue.start(); value.outcome('uncertain');
    let revealed: string | undefined;
    render(<WaitingColumn drafts={value.drafts} store={queue} revealItem={target => { revealed = target.item_id; }} openSession={() => {}} />);
    const send = await screen.findByRole('button', { name: 'Send answer' });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(send); fireEvent.click(await screen.findByText('Checking whether “Keep the design” was delivered…')); expect(revealed).toBe('2');
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull(); const original = structuredClone(value.calls[0]);
    cleanup(); value.render(); value.outcome('ok'); fireEvent.click(await screen.findByRole('button', { name: 'Try sending again' }));
    await waitFor(() => expect(value.prefs.drafts).toEqual([])); expect(value.calls[1]).toEqual(original);
  });
  it('reconciles uncertain cleanup after a validated input receipt without re-submitting or losing durable draft recovery', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Already durably submitted' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.preferenceOutcome('uncertain'); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4'); await screen.findByRole('button', { name: 'Try saving your draft again' });
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true); expect(value.calls).toHaveLength(1);
    value.preferenceOutcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Try saving your draft again' }));
    await waitFor(() => expect(value.prefs.drafts).toEqual([])); expect(value.calls).toHaveLength(1);
  });
  it('retries draft cleanup after a saved input when an interleaved navigation patch bumped the revision', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Saved then conflicted' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.conflictDeletes(1); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4');
    await waitFor(() => expect(value.prefs.drafts).toEqual([]));
    expect(value.calls).toHaveLength(1); expect(value.drafts.getSnapshot().preferenceUncertain).toBe(false); expect(value.drafts.getSnapshot().error).toBeNull();
    expect(value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'delete_draft'))).toHaveLength(2);
    expect(Object.values((await value.restart()).getSnapshot().entries)).toEqual([]);
  });
  it('surfaces draft cleanup failure after three revision conflicts without further retries', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Conflicted thrice' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.conflictDeletes(5); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4');
    await waitFor(() => expect(value.drafts.getSnapshot().error).not.toBeNull());
    expect(value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'delete_draft'))).toHaveLength(3);
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true); expect(value.calls).toHaveLength(1);
  });
  it('never retries cleanup on commit_uncertain and keeps the draft recoverable as uncertain', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Uncertain cleanup' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.preferenceOutcome('uncertain'); await act(async () => { finish(); });
    await screen.findByRole('button', { name: 'Try saving your draft again' });
    expect(value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'delete_draft'))).toHaveLength(1);
    expect(value.drafts.getSnapshot().preferenceUncertain).toBe(true); expect((await value.restart()).find(route, '2', 'answer')?.uncertain).toBe(true);
  });
  it('queues a follow-up reply behind a waiting item’s pending answer instead of hiding every owner input', async () => {
    const value = await setup(), user = userEvent.setup(), item = value.session.items['2']!;
    // The demo's queued drop, retargeted: an answer to item 2 that the agent has not taken yet.
    const queued = structuredClone(Object.values(value.session.inputs).find(input => input?.state === 'queued' && input.kind === 'drop')!);
    value.session.inputs[uuid(90)] = { ...queued, id: uuid(90), kind: 'answer', target: { topic_id: item.topic_id, item_id: '2' } };
    value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const followUp = await screen.findByRole('button', { name: 'Add a follow-up' });
    expect(screen.getByText('Queued behind the answer in flight')).toBeTruthy();
    expect(document.querySelector('.detail-answer-slot')).toBeNull();
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(followUp);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Reply message' }), { target: { value: 'One more thing' } });
    const send = screen.getByRole('button', { name: 'Send reply' });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(value.calls).toHaveLength(1));
    const sent = value.calls[0]!.command;
    expect(sent.command === 'input_submit' && [sent.params.kind, sent.params.text]).toEqual(['reply', 'One more thing']);
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.getByRole('button', { name: 'Add a follow-up' })).toBeTruthy();
  });
  it('keeps one owner input while the follow-up box is open beside a retained answer', async () => {
    const value = await setup(), user = userEvent.setup(); value.outcome('uncertain');
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const send = await screen.findByRole('button', { name: 'Send “Keep the design”' });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false)); fireEvent.click(send);
    await screen.findByRole('button', { name: 'Try sending again' });
    // Another answer to item 2 is queued: the follow-up box appears beside the retained (unconfirmed) answer.
    const item = value.session.items['2']!, queued = structuredClone(value.session.inputs['00000000-0000-4000-8000-000000000076']!);
    value.session.inputs[uuid(90)] = { ...queued, id: uuid(90), kind: 'answer', target: { topic_id: item.topic_id, item_id: '2' } };
    value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    const followUp = await screen.findByRole('button', { name: 'Add a follow-up' });
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false));
    expect(document.querySelector('.detail-answer-slot')).toBeTruthy();
    await user.click(followUp);
    await screen.findByRole('textbox', { name: 'Reply message' });
    const marked = document.querySelectorAll('[data-owner-input]');
    expect(marked).toHaveLength(1); expect(marked[0]!.classList.contains('detail-owner-input')).toBe(true);
  });
  it('keeps the follow-up being written when the answer it queued behind settles', async () => {
    const value = await setup(), user = userEvent.setup(), item = value.session.items['2']!;
    const queued = structuredClone(value.session.inputs['00000000-0000-4000-8000-000000000076']!);
    value.session.inputs[uuid(90)] = { ...queued, id: uuid(90), kind: 'answer', target: { topic_id: item.topic_id, item_id: '2' } };
    value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const followUp = await screen.findByRole('button', { name: 'Add a follow-up' });
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false)); await user.click(followUp);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Reply message' }), { target: { value: 'One more thing' } });
    await waitFor(() => expect(value.prefs.drafts.some(draft => draft.text === 'One more thing')).toBe(true));
    value.session.inputs[uuid(90)]!.state = 'cancelled'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('One more thing');
    expect(screen.getByText('Your follow-up is kept. Send it, or answer below.')).toBeTruthy();
  });
  it('shows only the reply warning in Follow-up, never a stale reopen one', async () => {
    const demoItem = (demo as unknown as Session).items['2']!;
    const reopen: OwnerDraft = { op_id: uuid(80), session: route, binding_id: (demo as unknown as Session).active_binding_id!,
      target: { topic_id: demoItem.topic_id, item_id: '2' }, intent: 'reopen', text: 'Reopen this', selected_option_id: null,
      target_revision: demoItem.revision, question_revision: demoItem.question_revision, supersedes_answer_id: null };
    const value = await setup([reopen]), user = userEvent.setup(), item = value.session.items['2']!;
    const queued = structuredClone(value.session.inputs['00000000-0000-4000-8000-000000000076']!);
    value.session.inputs[uuid(90)] = { ...queued, id: uuid(90), kind: 'answer', target: { topic_id: item.topic_id, item_id: '2' } };
    item.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const followUp = await screen.findByRole('button', { name: 'Add a follow-up' });
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false)); await user.click(followUp);
    await screen.findByRole('textbox', { name: 'Reply message' });
    const section = screen.getByRole('region', { name: 'Follow-up' });
    expect(section.textContent).not.toContain(changedText);
    expect(screen.queryByRole('button', { name: 'Review current target' })).toBeNull();
  });
  it('lets an untouched answer draft follow a rebind without asking for a review', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    const before = Object.values(value.drafts.getSnapshot().entries)[0]!.draft;
    const active = value.session.bindings[value.session.active_binding_id!]!;
    value.session.bindings[uuid(95)] = { ...structuredClone(active), id: uuid(95) };
    value.session.active_binding_id = uuid(95); value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries)[0]!.draft.binding_id).toBe(uuid(95)));
    expect(before.binding_id).toBe(active.id);
    expect(screen.queryByText(changedText)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review current target' })).toBeNull();
  });
  const rebindTo = async (value: Awaited<ReturnType<typeof setup>>) => {
    const active = value.session.bindings[value.session.active_binding_id!]!;
    value.session.bindings[uuid(95)] = { ...structuredClone(active), id: uuid(95) };
    value.session.active_binding_id = uuid(95); value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    return active.id;
  };
  it('lets a draft with text follow a rebind and stays sendable', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: 'Typed before clear' } });
    await waitFor(() => expect(value.prefs.drafts[0]?.text).toBe('Typed before clear'));
    // The agent re-registers the same question on the new binding after /clear.
    value.session.items['2']!.recipient_binding_id = uuid(95);
    await rebindTo(value);
    await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries)[0]!.draft.binding_id).toBe(uuid(95)));
    expect(Object.values(value.drafts.getSnapshot().entries)[0]!.draft.text).toBe('Typed before clear');
    expect(screen.queryByText(changedText)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review current target' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls).toHaveLength(1));
  });
  it('does not move a saving or uncertain entry to the new binding', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: 'In flight' } });
    await waitFor(() => expect(value.prefs.drafts[0]?.text).toBe('In flight'));
    const release = value.gate(); value.outcome('uncertain');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries)[0]!.saving).toBe(true));
    const original = await rebindTo(value);
    expect(Object.values(value.drafts.getSnapshot().entries)[0]!.draft.binding_id).toBe(original);
    await act(async () => { release(); });
    await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries)[0]!.uncertain).toBe(true));
    await act(async () => { await value.store.refresh(); });
    expect(Object.values(value.drafts.getSnapshot().entries)[0]!.draft.binding_id).toBe(original);
  });
  it('still asks for a review when the question revision changes together with a rebind', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: 'Keep me' } });
    await waitFor(() => expect(value.prefs.drafts[0]?.text).toBe('Keep me'));
    const item = value.session.items['2']!; item.revision++; item.question_revision++;
    value.session.rounds[item.current_round_id!]!.question_revision++;
    const original = await rebindTo(value);
    expect(screen.getByRole('button', { name: 'Review current target' })).toBeTruthy();
    expect(Object.values(value.drafts.getSnapshot().entries)[0]!.draft.binding_id).toBe(original);
  });
  it('Back to Open asks the agent to reopen at once and keeps the current outcome', async () => {
    const value = await setup(), item = value.session.items['1']!;
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="1" later={false} onOpenItem={() => {}} />);
    const request = await screen.findByRole('button', { name: 'Back to Open' });
    await waitFor(() => expect(request.hasAttribute('disabled')).toBe(false)); fireEvent.click(request);
    await waitFor(() => expect(value.calls).toHaveLength(1));
    const sent = value.calls[0]!.command;
    expect(sent.command === 'input_submit' && [sent.params.kind, sent.params.text]).toEqual(['reopen', `Let’s reopen this: ${item.question}`]);
    expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toContain(item.outcome);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the detail explains messages that have not reached the agent', () => {
  const demoInput = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
  const cancels = (calls: OwnerMutationRequest[]) => calls.filter(call => call.command.command === 'input_cancel').map(call => call.command.params);

  it('reads Waiting on agent in the header once the owner replied', async () => {
    const value = await setup(), reply = value.session.inputs[demoInput('76')]!;
    reply.target = { ...reply.target, item_id: '2' }; reply.kind = 'reply'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    await waitFor(() => expect(document.querySelector('.detail-badge')?.textContent).toContain('Waiting on agent'));
  });
  // Input 76 is item 4's queued "drop" request; item 4 is open.
  const queuedText = 'Drop request for item 4.\nPreserve this complete owner text.';
  const detail = () => document.querySelector('.item-detail')!;
  // Input 76 is made a queued reply (it has words to edit) unless the test asks for another kind.
  const queuedOnItem4 = async (kind: InputKind = 'reply') => {
    const value = await setup();
    value.session.inputs[demoInput('76')]!.kind = kind; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="4" later={false} onOpenItem={() => {}} />);
    expect(await screen.findByText('Queued behind your message on “Implement receipt lookup”')).toBeTruthy();
    // Not sent yet: Edit (when it has words) and Delete, never Cancel message.
    expect(screen.queryByRole('button', { name: 'Cancel message' })).toBeNull();
    const edit = screen.queryByRole('button', { name: 'Edit' }), remove = screen.getByRole('button', { name: 'Delete' });
    await waitFor(() => expect(remove.hasAttribute('disabled')).toBe(false));
    return { value, edit, remove, revision: value.session.revision };
  };
  it('explains a queued message in the tracker; Delete cancels it and it leaves the timeline', async () => {
    const { value, remove, revision } = await queuedOnItem4();
    expect(detail().textContent).toContain('Drop request for item 4.');
    fireEvent.click(remove);
    await waitFor(() => expect(cancels(value.calls)).toEqual([{ input_id: demoInput('76'), expected_revision: revision }]));
    expect(value.prefs.drafts).toEqual([]);
    // Core cancelled it before any delivery: the tracker and the timeline no longer show it.
    await waitFor(() => expect(screen.queryByText('Queued behind your message on “Implement receipt lookup”')).toBeNull());
    expect(detail().textContent).not.toContain('Drop request for item 4.');
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
  it.each(['drop', 'bring', 'reopen'] as const)('offers only Delete for a queued %s request: it has no text to edit', async kind => {
    const { edit, remove } = await queuedOnItem4(kind);
    expect(edit).toBeNull();
    expect(remove).toBeTruthy();
  });
  // The words are saved in the editor only after core confirmed the cancel: the draft never holds them while they can be sent.
  const loadedAfterCancel = (events: readonly string[]) => {
    const cancelled = events.indexOf('cancelled'), loaded = events.indexOf(`draft:${queuedText}`);
    expect(cancelled).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(cancelled);
  };
  it('Edit takes a queued message back first, then puts it in the reply box; the message reads Taken back to edit', async () => {
    const { value, edit, revision } = await queuedOnItem4();
    fireEvent.click(edit!);
    await waitFor(() => expect(cancels(value.calls)).toEqual([{ input_id: demoInput('76'), expected_revision: revision, purpose: 'edit' }]));
    // Its words go to the reply box, which opens with them once core confirmed the cancel.
    expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(queuedText);
    expect(value.prefs.drafts).toMatchObject([{ intent: 'reply', text: queuedText, target: { item_id: '4' } }]);
    loadedAfterCancel(value.events);
    expect(value.session.inputs[demoInput('76')]).toMatchObject({ state: 'cancelled', cancel_cause: 'owner_edit' });
    expect(await screen.findByText('Taken back to edit')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
    expect(value.calls.some(call => call.command.command === 'input_submit')).toBe(false);
  });
  it('Edit writes nothing to the editor while the cancel is still open', async () => {
    const value = await setup();
    value.session.inputs[demoInput('76')]!.kind = 'reply'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    const live = value.store.getSnapshot().snapshot!.session, release = value.gateCancel();
    const editing = editQueued(value.drafts, live, live.inputs[demoInput('76')]!, sessionActionsFor(value.service, value.store));
    await waitFor(() => expect(cancels(value.calls)).toHaveLength(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    // Core has not answered: the message can still be sent, so no editor holds its words.
    expect(value.drafts.find(route, '4', 'reply')).toBeUndefined();
    expect(value.events.some(event => event === `draft:${queuedText}`)).toBe(false);
    release();
    expect(await editing).toEqual({ kind: 'moved', intent: 'reply' });
    expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe(queuedText);
    loadedAfterCancel(value.events);
  });
  it('Edit never overwrites a reply the owner already started: the queued one stays and shows to copy', async () => {
    const { value, edit } = await queuedOnItem4();
    const id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '4', 'reply')!;
    value.drafts.edit(id, { text: 'My own reply' });
    await waitFor(() => expect(value.prefs.drafts.some(draft => draft.op_id === id && draft.text === 'My own reply')).toBe(true));
    fireEvent.click(edit!);
    expect((await screen.findByRole('textbox', { name: 'Your earlier message' }) as HTMLTextAreaElement).value).toBe(queuedText);
    expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe('My own reply');
    expect(cancels(value.calls)).toEqual([]);
  });
  describe('Edit changes nothing unless core confirmed the cancel', () => {
    const untouched = (value: Awaited<ReturnType<typeof setup>>) => {
      expect(value.drafts.find(route, '4', 'reply')).toBeUndefined();
      expect(value.events.some(event => event.startsWith('draft:'))).toBe(false);
    };
    it('says it couldn’t take the message back when core refuses the cancel, and leaves the editor alone', async () => {
      const { value, edit, revision } = await queuedOnItem4();
      value.cancelOutcome('refused');
      fireEvent.click(edit!);
      expect(await screen.findByText(NOT_TAKEN_BACK)).toBeTruthy();
      expect(NOT_TAKEN_BACK).toBe('Couldn’t take this message back. Try again.');
      expect(cancels(value.calls)).toEqual([{ input_id: demoInput('76'), expected_revision: revision, purpose: 'edit' }]);
      untouched(value);
      expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
      expect(value.session.inputs[demoInput('76')]!.state).toBe('queued');
    });
    it('changes nothing when the store is stale and the cancel is never sent', async () => {
      const value = await setup(), session = value.store.getSnapshot().snapshot!.session, input = session.inputs[demoInput('76')]!;
      const refusing = { session: value.store, execute: vi.fn(async () => false), getSnapshot: () => ({ pending: null, receipt: null }) } as unknown as SessionActions;
      const outcome = await editQueued(value.drafts, { ...session, inputs: { ...session.inputs, [input.id]: { ...input, kind: 'reply' } } }, { ...input, kind: 'reply' }, refusing);
      expect(outcome).toEqual({ kind: 'not_taken_back' });
      expect(refusing.execute).toHaveBeenCalledOnce();
      untouched(value);
    });
    it('says the message was already sent when it left the queue, without asking core to cancel it', async () => {
      const value = await setup(), session = value.store.getSnapshot().snapshot!.session, input = { ...session.inputs[demoInput('76')]!, kind: 'reply' as const };
      const asked = vi.fn(async () => true);
      const left = { ...session, inputs: { ...session.inputs, [input.id]: { ...input, state: 'in_flight' as const } } };
      const actions = { session: { getSnapshot: () => ({ snapshot: { session: left } }) }, execute: asked, getSnapshot: () => ({ pending: null, receipt: null }) } as unknown as SessionActions;
      expect(await editQueued(value.drafts, { ...session, inputs: { ...session.inputs, [input.id]: input } }, input, actions)).toEqual({ kind: 'already_sent' });
      expect(asked).not.toHaveBeenCalled();
      untouched(value);
    });
    it('says already sent when the agent took it just before the cancel, and changes nothing', async () => {
      const value = await setup(), session = value.store.getSnapshot().snapshot!.session, input = { ...session.inputs[demoInput('76')]!, kind: 'reply' as const };
      // The store still shows it queued; core refuses the cancel and the refreshed session shows it on its way.
      value.cancelOutcome('refused'); value.session.inputs[input.id]!.state = 'in_flight'; value.session.revision++;
      const actions = sessionActionsFor(value.service, value.store);
      expect(await editQueued(value.drafts, { ...session, inputs: { ...session.inputs, [input.id]: input } }, input, actions)).toEqual({ kind: 'already_sent' });
      untouched(value);
    });
    it('leaves the editor alone when the cancel is unconfirmed; once Check again lands, the message reads Taken back to edit and Put back loads it', async () => {
      const { value, edit } = await queuedOnItem4();
      value.cancelOutcome('uncertain');
      fireEvent.click(edit!);
      expect(await screen.findByText(NOT_TAKEN_BACK)).toBeTruthy();
      untouched(value);
      expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
      // The cancel may still land: it is kept, and Check again sends the same operation.
      value.cancelOutcome('ok');
      fireEvent.click(within(detail() as HTMLElement).getByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Taken back to edit')).toBeTruthy();
      const [first, second] = value.calls.filter(call => call.command.command === 'input_cancel');
      expect(second?.command.op_id).toBe(first?.command.op_id);
      expect(cancels(value.calls).every(params => 'purpose' in params && params.purpose === 'edit')).toBe(true);
      untouched(value);
      fireEvent.click(screen.getByRole('button', { name: 'Put back in reply box' }));
      expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(queuedText);
      loadedAfterCancel(value.events);
    });
    it('keeps a reply the owner started while the cancel was open; Put back keeps it too, and loads once it is cleared', async () => {
      const value = await setup();
      value.session.inputs[demoInput('76')]!.kind = 'reply'; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      const live = value.store.getSnapshot().snapshot!.session, input = live.inputs[demoInput('76')]!, release = value.gateCancel();
      const editing = editQueued(value.drafts, live, input, sessionActionsFor(value.service, value.store));
      await waitFor(() => expect(cancels(value.calls)).toHaveLength(1));
      const id = value.drafts.begin(live, '4', 'reply')!;
      expect(await value.drafts.editSaved(id, { text: 'My own reply', selected_option_id: null })).toBe(true);
      release();
      expect(await editing).toEqual({ kind: 'kept', intent: 'reply', text: queuedText });
      expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe('My own reply');
      expect(value.session.inputs[input.id]).toMatchObject({ state: 'cancelled', cancel_cause: 'owner_edit' });
      const now = () => value.store.getSnapshot().snapshot!.session;
      await waitFor(() => expect(now().inputs[input.id]?.state).toBe('cancelled'));
      expect(await putBackCancelled(value.drafts, now(), now().inputs[input.id]!)).toEqual({ kind: 'kept', intent: 'reply', text: queuedText });
      expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe('My own reply');
      expect(await value.drafts.editSaved(id, { text: '', selected_option_id: null })).toBe(true);
      expect(await putBackCancelled(value.drafts, now(), now().inputs[input.id]!)).toEqual({ kind: 'moved', intent: 'reply' });
      expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe(queuedText);
    });
    it('takes the message back even when the editor can’t save its words: the outcome says to use Put back', async () => {
      const value = await setup();
      value.session.inputs[demoInput('76')]!.kind = 'reply'; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      const live = value.store.getSnapshot().snapshot!.session;
      value.preferenceOutcome('uncertain');
      expect(await editQueued(value.drafts, live, live.inputs[demoInput('76')]!, sessionActionsFor(value.service, value.store))).toEqual({ kind: 'taken_back' });
      expect(value.session.inputs[demoInput('76')]).toMatchObject({ state: 'cancelled', cancel_cause: 'owner_edit' });
      expect(value.prefs.drafts.some(draft => draft.text === queuedText)).toBe(false);
    });
    it('shows the already-sent words on the note when Edit finds the message gone', async () => {
      const value = await setup(), input = { ...value.store.getSnapshot().snapshot!.session.inputs[demoInput('76')]!, kind: 'reply' as const };
      render(<StuckNote actions={sessionActionsFor(value.service, value.store)} input={input}
        stuck={{ kind: 'behind', text: 'Queued', resume: false, retry: false, settle: null }} onEdit={async () => ({ kind: 'already_sent' })} />);
      await waitFor(() => expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(await screen.findByText('This message was already sent, so it can’t be edited.')).toBeTruthy();
      expect(screen.queryByText(/already started a new message/)).toBeNull();
    });
    describe('the same words already waiting are never sent twice, even after a restart', () => {
      // A saved reply on item 4 whose words match the queued input 76; a fresh store stands for the app restarted.
      const savedMatching = async () => {
        const value = await setup();
        value.session.inputs[demoInput('76')]!.kind = 'reply'; value.session.revision++;
        await act(async () => { await value.store.refresh(); });
        const session = value.store.getSnapshot().snapshot!.session;
        const first = value.drafts.begin(session, '4', 'reply')!;
        expect(await value.drafts.editSaved(first, { text: queuedText, selected_option_id: null })).toBe(true);
        const restored = await value.restart(), id = restored.find(route, '4', 'reply')!.draft.op_id;
        const sends = () => value.calls.filter(call => call.command.command === 'input_submit').length;
        return { value, restored, id, sends, draft: () => restored.getSnapshot().entries[id]!.draft };
      };
      it('blocks Send for a saved draft that matches a queued message, then allows it once that message is cancelled', async () => {
        const { value, restored, id, sends, draft } = await savedMatching();
        const session = () => value.store.getSnapshot().snapshot!.session;
        expect(blockedDraft(draft(), session())).toBe(ALREADY_WAITING);
        expect(ALREADY_WAITING).toBe('This same message is already waiting to be sent. Delete it first if you want to change it.');
        expect(await restored.submit(id)).toBe(false);
        expect(sends()).toBe(0);
        expect(plainFailure(restored.getSnapshot().entries[id]!.error)).toBe(ALREADY_WAITING);
        // It is blocked while the message is on its way as well.
        value.session.inputs[demoInput('76')]!.state = 'in_flight'; value.session.revision++;
        await act(async () => { await value.store.refresh(); });
        expect(blockedDraft(draft(), session())).toBe(ALREADY_WAITING);
        // Delete (cancel) the waiting message: the same words can now go.
        value.session.inputs[demoInput('76')]!.state = 'cancelled'; value.session.revision++;
        await act(async () => { await value.store.refresh(); });
        expect(blockedDraft(draft(), session())).toBeNull();
        expect(await restored.submit(id)).toBe(true);
        expect(sends()).toBe(1);
      });
      it('does not block different words, another option, or a draft for another target', async () => {
        const { value, draft } = await savedMatching();
        const session = value.store.getSnapshot().snapshot!.session;
        expect(blockedDraft({ ...draft(), text: `${queuedText} (changed)` }, session)).toBeNull();
        expect(blockedDraft({ ...draft(), selected_option_id: 'yes' }, session)).toBeNull();
        // The kind is not compared (Edit can move a queued note into the reply box): a note with the same words is the same message.
        expect(blockedDraft({ ...draft(), intent: 'note' }, session)).toBe(ALREADY_WAITING);
        expect(blockedDraft({ ...draft(), target: { ...draft().target, item_id: '2' } }, session)).not.toBe(ALREADY_WAITING);
        // An attempted draft is that message's own exact retry, never a duplicate of it.
        expect(blockedDraft({ ...draft(), submission_attempted: true }, session)).toBeNull();
      });
      it('blocks the topic reply box the same way', async () => {
        const value = await setup(), topicId = value.session.items['4']!.topic_id, input = value.session.inputs[demoInput('76')]!;
        input.kind = 'topic_reply'; input.target = { topic_id: topicId, item_id: null }; value.session.revision++;
        await act(async () => { await value.store.refresh(); });
        const session = value.store.getSnapshot().snapshot!.session;
        const first = value.drafts.beginTopic(session, topicId)!;
        expect(await value.drafts.editSaved(first, { text: queuedText, selected_option_id: null })).toBe(true);
        const restored = await value.restart(), saved = restored.findTopic(route, topicId)!.draft;
        expect(blockedDraft(saved, session)).toBe(ALREADY_WAITING);
        expect(blockedDraft({ ...saved, text: 'Something else' }, session)).toBeNull();
      });
    });
  });
  describe('a message taken back to edit, or cancelled by archive or close, stays and can be put back', () => {
    // Input 76 (item 4) as a reply that Edit took back, the topic's archive or the session's close cancelled before any attempt.
    const cancelledBy = async (cause: 'owner_edit' | 'topic_archived' | 'session_closed' | 'owner' | undefined, change: (session: Session) => void = () => {}) => {
      const value = await setup(), input = value.session.inputs[demoInput('76')]!;
      input.kind = 'reply'; input.state = 'cancelled'; input.attempts = []; input.cancel_cause = cause; change(value.session); value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      render(<ItemDetail drafts={value.drafts} store={value.store} itemId="4" later={false} onOpenItem={() => {}} />);
      return value;
    };
    it('keeps the text in the timeline with why it was not sent, and Put back loads it into the reply box', async () => {
      const value = await cancelledBy('topic_archived');
      expect(await screen.findByText('Not sent: cancelled when you archived this topic')).toBeTruthy();
      expect(detail().textContent).toContain('Drop request for item 4.');
      fireEvent.click(screen.getByRole('button', { name: 'Put back in reply box' }));
      expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(queuedText);
      expect(value.prefs.drafts).toMatchObject([{ intent: 'reply', text: queuedText, target: { item_id: '4' } }]);
      // Nothing is cancelled or sent by putting it back.
      expect(value.writes.map(write => write.command.command).filter(name => name !== 'preferences_patch')).toEqual([]);
    });
    it('says the session was closed when close cancelled it; Put back waits for Reopen', async () => {
      await cancelledBy('session_closed', session => { session.state = 'closed'; session.closed_at = '2026-10-04T12:00:00.000Z'; });
      expect(await screen.findByText(/Not sent: cancelled when you closed this session\. Reopen the session/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
    });
    it('says the session was closed when close cancelled it and it is open again', async () => {
      await cancelledBy('session_closed');
      expect(await screen.findByText('Not sent: cancelled when you closed this session')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Put back in reply box' })).toBeTruthy();
    });
    it('after a restart, a message taken back to edit still reads Taken back to edit, and Put back loads it', async () => {
      // A fresh draft store and session read stand for the app started again with the cancel saved in core.
      const value = await cancelledBy('owner_edit'), restored = await value.restart();
      cleanup();
      render(<ItemDetail drafts={restored} store={value.store} itemId="4" later={false} onOpenItem={() => {}} />);
      expect(await screen.findByText('Taken back to edit')).toBeTruthy();
      expect(detail().textContent).toContain('Drop request for item 4.');
      fireEvent.click(screen.getByRole('button', { name: 'Put back in reply box' }));
      expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(queuedText);
      expect(restored.find(route, '4', 'reply')!.draft.text).toBe(queuedText);
      expect(value.writes.map(write => write.command.command).filter(name => name !== 'preferences_patch')).toEqual([]);
    });
    it('hides a message taken back to edit once the same words were sent again', async () => {
      await cancelledBy('owner_edit', session => {
        const later = structuredClone(session.inputs[demoInput('76')]!);
        later.id = demoInput('98'); later.seq += 100; later.state = 'handled'; later.cancel_cause = undefined;
        session.inputs[later.id] = later;
      });
      await waitFor(() => expect(detail().textContent).not.toContain('Drop request for item 4.'));
      expect(screen.queryByText(/Taken back to edit/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
    });
    it('never overwrites a reply the owner already started: the old text shows to copy', async () => {
      const value = await cancelledBy('topic_archived');
      const id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '4', 'reply')!;
      value.drafts.edit(id, { text: 'My own reply' });
      await waitFor(() => expect(value.prefs.drafts.some(draft => draft.op_id === id && draft.text === 'My own reply')).toBe(true));
      fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
      expect((await screen.findByRole('textbox', { name: 'Your earlier message' }) as HTMLTextAreaElement).value).toBe(queuedText);
      expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe('My own reply');
    });
    it('hides a message the owner deleted, and one from a store with no recorded cause', async () => {
      await cancelledBy('owner');
      await waitFor(() => expect(detail().textContent).not.toContain('Drop request for item 4.'));
      cleanup();
      await cancelledBy(undefined);
      await waitFor(() => expect(detail().textContent).not.toContain('Drop request for item 4.'));
      expect(screen.queryByText(/Not sent:/)).toBeNull();
    });
    it('puts a topic reply that archive cancelled into that topic’s reply draft, never over one the owner started', async () => {
      const value = await setup(), input = value.session.inputs[demoInput('76')]!, topicId = input.target.topic_id;
      input.kind = 'topic_reply'; input.target = { topic_id: topicId, item_id: null }; input.state = 'cancelled'; input.attempts = []; input.cancel_cause = 'topic_archived';
      value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      const session = value.store.getSnapshot().snapshot!.session;
      expect(await putBackCancelled(value.drafts, session, session.inputs[input.id]!)).toEqual({ kind: 'moved', intent: 'topic_reply' });
      expect(value.drafts.findTopic(route, topicId)?.draft.text).toBe(queuedText);
      expect(value.writes.map(write => write.command.command).filter(name => name !== 'preferences_patch')).toEqual([]);
      // A second put-back finds the same words already there; one the owner typed over them is kept.
      value.drafts.edit(value.drafts.findTopic(route, topicId)!.draft.op_id, { text: 'My own topic reply' });
      await waitFor(() => expect(value.prefs.drafts.some(draft => draft.text === 'My own topic reply')).toBe(true));
      expect(await putBackCancelled(value.drafts, session, session.inputs[input.id]!)).toEqual({ kind: 'kept', intent: 'topic_reply', text: queuedText });
      expect(value.drafts.findTopic(route, topicId)!.draft.text).toBe('My own topic reply');
    });
    it('offers no Put back once the same words were sent again: the line says so', async () => {
      await cancelledBy('topic_archived', session => {
        const later = structuredClone(session.inputs[demoInput('76')]!);
        later.id = demoInput('98'); later.seq += 100; later.state = 'queued'; later.cancel_cause = undefined;
        session.inputs[later.id] = later;
      });
      expect(await screen.findByText('Not sent: cancelled when you archived this topic. You sent it again.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
    });
    it('offers no Put back after it was put back and sent', async () => {
      const value = await cancelledBy('topic_archived');
      fireEvent.click(await screen.findByRole('button', { name: 'Put back in reply box' }));
      await screen.findByRole('textbox', { name: 'Reply message' });
      // The owner sends it: a new queued reply with the same words, to the same item.
      const later = structuredClone(value.session.inputs[demoInput('76')]!);
      later.id = demoInput('97'); later.seq += 100; later.state = 'queued'; later.cancel_cause = undefined; value.session.inputs[later.id] = later; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull());
      expect(screen.getByText(/You sent it again\./)).toBeTruthy();
    });
    it('offers no Put back while the topic is archived: it says to restore it first', async () => {
      await cancelledBy('topic_archived', session => { session.topics[session.items['4']!.topic_id]!.archived_at = '2026-10-04T12:00:00.000Z'; });
      expect(await screen.findByText(/Not sent: cancelled when you archived this topic\. Restore the topic/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Put back in reply box' })).toBeNull();
    });
  });
  it('lets the newer question win over a held answer; Review and send again prefills the box and cancels the held one', async () => {
    const value = await setup(), item = value.session.items['2']!, held = value.session.inputs[demoInput('76')]!;
    held.target = { ...held.target, item_id: '2' }; held.kind = 'answer'; held.payload.text = 'My earlier answer'; held.payload.selected_option_id = 'no';
    item.question_revision = 2; item.question = 'The revised question'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    expect(await screen.findByText('The question changed — review and send again')).toBeTruthy();
    // Not stuck behind its own held message: the answer box is there for the newer question.
    expect(document.querySelector('.detail-answer-slot')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a follow-up' })).toBeNull();
    const review = screen.getByRole('button', { name: 'Review and send again' }), revision = value.session.revision;
    await waitFor(() => expect(review.hasAttribute('disabled')).toBe(false)); fireEvent.click(review);
    await waitFor(() => expect(cancels(value.calls)).toEqual([{ input_id: held.id, expected_revision: revision, purpose: 'edit' }]));
    await waitFor(() => expect(value.drafts.find(route, '2', 'answer')?.draft.text).toBe('My earlier answer'));
    const draft = value.drafts.find(route, '2', 'answer')!.draft;
    expect([draft.text, draft.selected_option_id, draft.question_revision]).toEqual(['My earlier answer', 'no', 2]);
    // Taken back first, then loaded.
    expect(value.events.indexOf('draft:My earlier answer')).toBeGreaterThan(value.events.indexOf('cancelled'));
    expect(value.events.indexOf('cancelled')).toBeGreaterThanOrEqual(0);
    expect(value.calls.some(call => call.command.command === 'input_submit')).toBe(false);
  });
  const heldAnswer = async () => {
    const value = await setup(), item = value.session.items['2']!, held = value.session.inputs[demoInput('76')]!;
    held.target = { ...held.target, item_id: '2' }; held.kind = 'answer'; held.payload.text = 'My earlier answer'; held.payload.selected_option_id = 'no';
    item.question_revision = 2; item.question = 'The revised question'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const review = await screen.findByRole('button', { name: 'Review and send again' });
    await waitFor(() => expect(review.hasAttribute('disabled')).toBe(false));
    return { value, held, review };
  };
  it('never overwrites an answer the owner already started; the held one stays and shows to copy', async () => {
    const { value, held, review } = await heldAnswer();
    const id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '2', 'answer')!;
    value.drafts.edit(id, { text: 'My new answer' });
    await waitFor(() => expect(value.prefs.drafts.some(draft => draft.op_id === id && draft.text === 'My new answer')).toBe(true));
    fireEvent.click(review);
    expect((await screen.findByRole('textbox', { name: 'Your earlier message' }) as HTMLTextAreaElement).value).toBe(held.payload.text);
    expect(value.drafts.find(route, '2', 'answer')!.draft.text).toBe('My new answer');
    expect(cancels(value.calls)).toEqual([]);
  });
  it('never cancels the held message while the editor has an unconfirmed save', async () => {
    const { value, review } = await heldAnswer();
    // An earlier save is unconfirmed: the editor can't take the words, so nothing is taken back.
    value.preferenceOutcome('uncertain');
    const id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '2', 'reply')!;
    expect(await value.drafts.editSaved(id, { text: 'Unconfirmed', selected_option_id: null })).toBe(false);
    await waitFor(() => expect(value.drafts.getSnapshot().preferenceUncertain).toBe(true));
    fireEvent.click(review);
    expect(await screen.findByText('Your editor is busy saving. Try again in a moment.')).toBeTruthy();
    expect(cancels(value.calls)).toEqual([]);
  });
  it('warns in the answer and reply boxes while sending is paused, with Resume', async () => {
    const value = await setup(), user = userEvent.setup();
    value.session.bindings[value.session.active_binding_id!]!.owner_paused = true; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    const { unmount } = render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const answer = await screen.findByRole('region', { name: 'Your answer' });
    await waitFor(() => expect(answer.querySelector('[data-dispatch-note="paused"]')?.textContent).toContain('Sending is paused'));
    unmount();
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="1.1" later={false} onOpenItem={() => {}} />);
    const reply = await screen.findByRole('button', { name: 'Reply' });
    await waitFor(() => expect(reply.hasAttribute('disabled')).toBe(false)); await user.click(reply);
    const box = (await screen.findByRole('textbox', { name: 'Reply message' })).closest('[data-owner-input]')!;
    const note = box.querySelector('[data-dispatch-note="paused"]') as HTMLElement;
    expect(note.textContent).toContain('Sending is paused — your message waits here until you resume.');
    fireEvent.click(within(note).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(value.calls.some(call => call.command.command === 'binding_resume')).toBe(true));
  });
});

describe('topic reply drafts', () => {
  const topicOf = (session: Session) => session.items['2']!.topic_id;
  it('starts a durable draft on the topic with no item or question, and reloads it', async () => {
    const value = await setup(), session = value.store.getSnapshot().snapshot!.session, topicId = topicOf(value.session);
    const id = value.drafts.beginTopic(session, topicId)!;
    expect(value.drafts.beginTopic(session, topicId)).toBe(id);
    expect(value.drafts.getSnapshot().entries[id]!.draft).toMatchObject({ intent: 'topic_reply', target: { topic_id: topicId, item_id: null },
      binding_id: session.active_binding_id, target_revision: session.topics[topicId]!.revision, question_revision: null, supersedes_answer_id: null, selected_option_id: null });
    expect(blockedDraft(value.drafts.getSnapshot().entries[id]!.draft, session)).toBe(emptyDraft);
    value.drafts.edit(id, { text: 'Across the topic: keep retries at three.' });
    await waitFor(() => expect(value.prefs.drafts.some(draft => draft.op_id === id && draft.text === 'Across the topic: keep retries at three.')).toBe(true));
    const restored = await value.restart();
    expect(restored.findTopic(route, topicId)?.draft.text).toBe('Across the topic: keep retries at three.');
  });
  it('blocks a topic reply in a closed session, on an archived topic, or after a rebind until reviewed', async () => {
    const value = await setup(), topicId = topicOf(value.session);
    const id = value.drafts.beginTopic(value.store.getSnapshot().snapshot!.session, topicId)!;
    value.drafts.edit(id, { text: 'Hello' });
    const draft = () => value.drafts.getSnapshot().entries[id]!.draft, variant = (change: (session: Session) => void) => {
      const session = structuredClone(value.session); change(session); return immutable(session);
    };
    expect(blockedDraft(draft(), variant(() => {}))).toBeNull();
    expect(blockedDraft(draft(), variant(session => { session.state = 'closed'; }))).toBe('This session is closed. Reopen it to send this reply.');
    expect(blockedDraft(draft(), variant(session => { session.topics[topicId]!.archived_at = session.updated_at; }))).toBe('This topic is archived. Restore it to send this reply.');
    const rebound = variant(session => { session.bindings[uuid(95)] = { ...structuredClone(session.bindings[session.active_binding_id!]!), id: uuid(95) }; session.active_binding_id = uuid(95); });
    expect(blockedDraft(draft(), rebound)).toBe('The selected binding changed. Review the current target before sending.');
    value.drafts.review(id, rebound);
    expect(draft()).toMatchObject({ binding_id: uuid(95), text: 'Hello' });
    expect(blockedDraft(draft(), rebound)).toBeNull();
  });
  it('labels a topic reply on its way and once received', () => {
    expect(deliveryLine('sending', TOPIC_REPLY, 'Hello', 'Codex').text).toBe('Sending your reply on this topic…');
    expect(deliveryLine('received', TOPIC_REPLY, 'Hello', 'Codex').text).toBe('Your reply on this topic was received · waiting for the agent');
  });
});
