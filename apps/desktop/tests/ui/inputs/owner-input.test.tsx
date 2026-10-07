import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session, SessionSummary, ProjectSummary } from '../../../src/generated/domain/models';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import summariesFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { OwnerDraft, OwnerMutationRequest, PreferencesSnapshot, SessionPreferences } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { Composer } from '../../../src/ui/answer/Composer';
import { WaitingColumn } from '../../../src/ui/waiting/WaitingColumn';
import { OwnerItemDetail } from '../../../src/components/inputs/OwnerItemDetail';
import { SentenceTree } from '../../../src/components/tree/SentenceTree';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { RegisteredRoutes, type RevealedItem } from '../../../src/data/routes';
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
  let submitGate: Promise<void> | null = null;
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
  return { session, prefs, calls, writes, drafts, store, service, sessions, outcome: (value: typeof outcome) => { outcome = value; },
    preferenceOutcome: (value: typeof preferenceOutcome) => { preferenceOutcome = value; }, unavailable: () => { readError = true; }, conflictDeletes: (count: number) => { deleteConflicts = count; },
    gate: () => { let resolve!: () => void; submitGate = new Promise<void>(done => { resolve = done; }); return resolve; },
    render: (itemId = '2', props: Partial<Parameters<typeof Composer>[0]> = {}) => render(<Composer drafts={drafts} session={store} itemId={itemId} {...props} />),
    restart: async () => { const restored = new OwnerDraftStore(service, () => uuid(++counter)); await restored.load(); return restored; } };
}
const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('owner input component and durable draft controller', () => {
  it('retains row focus across selected detail remount so z persists Later, while editor typing stays a draft', async () => {
    const value = await setup(), routes = new RegisteredRoutes(value.service, value.sessions), user = userEvent.setup();
    value.drafts.begin(value.store.getSnapshot().snapshot!.session, '1.1', 'reply');
    let operation = 90;
    function Composition() {
      const [view, setView] = useState<SessionPreferences>({ session: route, tab_open: true, selected_item_id: '1', tab_order: 0,
        expanded_item_ids: ['1'], filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'waiting', scroll: null });
      const [reveal, setReveal] = useState<RevealedItem | null>(null), [later, setLater] = useState(new Set<string>());
      const selected = reveal?.kind === 'item' ? reveal.route.item_id : view.selected_item_id!;
      return <>
        <SentenceTree store={value.store} routes={routes} view={view} later={later} reveal={reveal}
          saveView={async next => { setView(next); return true; }} onReveal={setReveal}
          saveLater={async (id, enabled) => {
            await value.service.executeOwner({ session: null, command: { api_version: 1, command: 'preferences_patch', op_id: uuid(++operation),
              params: { expected_preferences_revision: value.prefs.revision, entries: [{ kind: 'set_later', item: { ...route, item_id: id }, later: enabled }] } } });
            setLater(new Set(value.prefs.later.map(item => item.item_id))); return true;
          }} />
        <OwnerItemDetail key={selected} drafts={value.drafts} service={value.service} store={value.store} itemId={selected} routes={routes} onReveal={setReveal} />
      </>;
    }
    render(<Composition />); await screen.findByRole('textbox');
    const row = screen.getAllByRole('treeitem').find(item => item.dataset.itemId === '1.1')!;
    await user.click(row);
    await waitFor(() => expect(row.getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect((screen.getByRole('searchbox') as HTMLInputElement).disabled).toBe(false));
    expect(document.activeElement).toBe(row);
    await user.keyboard('z');
    await waitFor(() => expect(value.prefs.later).toEqual([{ ...route, item_id: '1.1' }]));
    const laterWrites = () => value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'set_later'));
    expect(laterWrites()).toHaveLength(1); expect(editor().value).toBe('');
    await user.click(editor()); await user.keyboard('z');
    await waitFor(() => expect(value.prefs.drafts.find(draft => draft.target.item_id === '1.1')?.text).toBe('z'));
    await act(async () => { await value.store.refresh(); });
    expect(document.activeElement).toBe(editor()); expect(editor().value).toBe('z');
    expect(laterWrites()).toHaveLength(1); expect(value.calls).toHaveLength(0);
  });
  it.each([['Follow up', 'Follow up message'], ['Request reopen', 'Reopen message']])('focuses the editor only after explicit %s, including repeated intent with retained text', async (action, label) => {
    const value = await setup(), routes = new RegisteredRoutes(value.service, value.sessions), user = userEvent.setup();
    render(<OwnerItemDetail drafts={value.drafts} service={value.service} store={value.store} itemId="1" routes={routes} onReveal={() => {}} />);
    const button = await within(screen.getByRole('complementary', { name: 'Item detail' })).findByRole('button', { name: action });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await user.click(button);
    const textarea = await screen.findByLabelText(label);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    await user.keyboard('Retain this draft');
    await user.click(button);
    expect(document.activeElement).toBe(textarea);
    expect((textarea as HTMLTextAreaElement).value).toBe('Retain this draft'); expect(value.calls).toHaveLength(0);
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
    view.rerender(<Composer drafts={value.drafts} session={value.store} itemId="4" />); await screen.findByRole('textbox');
    value.prefs.global.theme = 'dark'; value.prefs.revision++;
    view.rerender(<Composer drafts={value.drafts} session={value.store} itemId="2" />); expect(editor().value).toBe('Keep this draft');
    await act(async () => { await value.store.refresh(); }); expect(editor().value).toBe('Keep this draft');
    const restored = await value.restart(); view.rerender(<Composer drafts={restored} session={value.store} itemId="2" />);
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
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); await screen.findByRole('button', { name: 'Retry saved input' });
    const original = structuredClone(value.calls[0]), restored = await value.restart();
    value.session.items['2']!.status = status; value.session.items['2']!.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    view.rerender(<Composer drafts={restored} session={value.store} itemId="2" />);
    expect(screen.getByRole('button', { name: 'Retry saved input' }).hasAttribute('disabled')).toBe(false);
    expect(editor().value).toBe('Frozen original answer'); expect(editor().disabled).toBe(true); expect(value.calls).toHaveLength(1);
    value.outcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Retry saved input' }));
    await waitFor(() => expect(value.prefs.drafts).toEqual([])); expect(value.calls[1]).toEqual(original);
  });
  it('lets a different preferred form reveal a retained attempted answer without submitting either intent', async () => {
    const value = await setup(), view = value.render(); await screen.findByRole('textbox'); value.outcome('uncertain');
    fireEvent.change(editor(), { target: { value: 'Retained answer while viewing reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); await screen.findByRole('button', { name: 'Retry saved input' });
    const restored = await value.restart(); value.session.items['2']!.status = 'in_progress'; value.session.items['2']!.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    view.rerender(<Composer key="reply-form" drafts={restored} session={value.store} itemId="2" initialIntent="reply" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review saved answer input' }));
    expect(screen.getByRole('button', { name: 'Retry saved input' })).toBeTruthy();
    expect(editor().value).toBe('Retained answer while viewing reply'); expect(editor().disabled).toBe(true); expect(value.calls).toHaveLength(1);
  });
  it.each(['uncertain', 'malformed'] as const)('freezes exact op/body after %s receipt and explicitly replays it across restart and a changed target', async outcome => {
    const value = await setup(), view = value.render(); await screen.findByRole('textbox'); value.outcome(outcome);
    fireEvent.change(editor(), { target: { value: 'Exact untrimmed bytes  ' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByRole('button', { name: 'Retry saved input' }); expect(value.prefs.drafts[0]?.submission_attempted).toBe(true);
    const original = structuredClone(value.calls[0]); expect(editor().disabled).toBe(true);
    const restored = await value.restart(); value.session.items['2']!.question_revision++; value.session.items['2']!.revision++; value.session.revision++;
    await act(async () => { await value.store.refresh(); }); view.rerender(<Composer drafts={restored} session={value.store} itemId="2" />);
    expect(value.calls).toHaveLength(1); value.outcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Retry saved input' }));
    await screen.findByText('Saved · Queue position #4'); expect(value.calls[1]).toEqual(original); expect(value.prefs.drafts).toEqual([]);
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
    await screen.findByRole('button', { name: 'Retry saving draft preferences' }); expect(value.calls).toHaveLength(0); const request = structuredClone(value.writes.at(-1));
    value.preferenceOutcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Retry saving draft preferences' }));
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
    await screen.findByRole('button', { name: 'Prepare revised input' }); const original = structuredClone(value.prefs.drafts[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare revised input' }));
    await screen.findByRole('button', { name: 'Review current target' }); expect(value.calls).toHaveLength(1); expect(editor().value).toBe('Owner explanation remains exact');
    await waitFor(() => expect(value.prefs.drafts).toHaveLength(2)); expect(value.prefs.drafts[0]).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' })); value.outcome('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' })); await screen.findByText('Saved · Queue position #4');
    expect(value.calls[1]?.command.op_id).not.toBe(value.calls[0]?.command.op_id); expect(value.prefs.drafts).toEqual([original]);
  });
  it('never permits changed-payload recovery for operation reuse or restored unknown attempts', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); value.outcome('operation_reused');
    fireEvent.change(editor(), { target: { value: 'Keep operation identity' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await screen.findByRole('button', { name: 'Retry saved input' }); expect(screen.queryByRole('button', { name: 'Prepare revised input' })).toBeNull();
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
    fireEvent.keyDown(screen.getByRole('button', { name: 'Answer' }), { key: '2' });
    expect(value.drafts.getSnapshot().entries[id]!.draft).toEqual(before);
    if (guard === 'saving') { await act(async () => { finish!(); await submission; }); expect(value.calls[0]?.command).toMatchObject({ params: { selected_option_id: 'yes', text: before.text } }); }
    if (guard === 'preferences') { value.preferenceOutcome('ok'); await act(async () => { await value.drafts.retryPreferences(); }); expect(value.drafts.getSnapshot().entries[id]!.draft).toEqual(before); }
    view.rerender(<Composer drafts={value.drafts} session={value.store} itemId="2" focusRequest={{ intent: 'answer', token: 1, optionIndex: 1 }} onFocusRequestConsumed={consumed} />);
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
    cleanup(); value.render(); value.outcome('ok'); fireEvent.click(await screen.findByRole('button', { name: 'Retry saved input' }));
    await waitFor(() => expect(value.prefs.drafts).toEqual([])); expect(value.calls[1]).toEqual(original);
  });
  it('reconciles uncertain cleanup after a validated input receipt without re-submitting or losing durable draft recovery', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Already durably submitted' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.preferenceOutcome('uncertain'); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4'); await screen.findByRole('button', { name: 'Retry saving draft preferences' });
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true); expect(value.calls).toHaveLength(1);
    value.preferenceOutcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Retry saving draft preferences' }));
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
    await screen.findByRole('button', { name: 'Retry saving draft preferences' });
    expect(value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'delete_draft'))).toHaveLength(1);
    expect(value.drafts.getSnapshot().preferenceUncertain).toBe(true); expect((await value.restart()).find(route, '2', 'answer')?.uncertain).toBe(true);
  });
  it('connects actual terminal history actions to the owner editor without replacing the retained outcome', async () => {
    const value = await setup(), routes = new RegisteredRoutes(value.service, value.sessions);
    render(<OwnerItemDetail drafts={value.drafts} service={value.service} store={value.store} itemId="1" routes={routes} onReveal={() => {}} />);
    const request = await screen.findByRole('button', { name: 'Request reopen' });
    await waitFor(() => expect(request.hasAttribute('disabled')).toBe(false)); fireEvent.click(request);
    await screen.findByLabelText('Reopen message'); expect(screen.getByRole('region', { name: 'Current outcome' }).textContent).toContain(value.session.items['1']!.outcome);
    fireEvent.change(editor(), { target: { value: 'Request another round' } }); fireEvent.click(screen.getByRole('button', { name: 'Send reopen' }));
    await screen.findByText('Saved · Queue position #4'); expect(value.calls[0]?.command.command === 'input_submit' && value.calls[0].command.params.kind).toBe('reopen');
  });
  it.each(['bring', 'reply', 'note', 'followup', 'drop', 'reopen'] as const)('queues explicit %s intent for an eligible terminal item', async intent => {
    const value = await setup(); value.render('1', { initialIntent: intent }); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: `Please ${intent}` } }); fireEvent.click(screen.getByRole('button', { name: `Send ${intent === 'bring' ? 'bring up' : intent === 'followup' ? 'follow up' : intent}` }));
    await screen.findByText('Saved · Queue position #4');
    expect(value.calls[0]?.command.command === 'input_submit' && value.calls[0].command.params.kind).toBe(intent);
  });
  it('offers Replaced Follow up without in-place Reopen and keeps Later in view preferences', async () => {
    const value = await setup(); let later: boolean | undefined;
    value.render('7', { onLater: async next => { later = next; return true; } }); await screen.findByRole('textbox');
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull(); expect(screen.getByRole('button', { name: 'Follow up' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Later' })); await waitFor(() => expect(later).toBe(true)); expect(value.calls).toHaveLength(0);
  });
});
