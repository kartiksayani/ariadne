import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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
import { useSubmit, type PendingSubmission } from '../../../src/ui/answer/useSubmit';
import { WaitingColumn } from '../../../src/ui/waiting/WaitingColumn';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { sentAs } from '../../../src/ui/detail/model';
import { WaitingStore } from '../../../src/selectors/waiting/store';
import { HistoryTransport } from '../history/fixtures';
import { useWindowKeys } from '../../../src/ui/shell/windowKeys';

const route = { project_id: demo.project_id, session_id: demo.id };
const opened: OpenSessions[] = [];
const waitingStores: WaitingStore[] = [];
afterEach(() => { cleanup(); waitingStores.splice(0).forEach(value => value.stop()); opened.splice(0).forEach(value => value.closeAll()); });
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
function preferences(): PreferencesSnapshot {
  return { schema_version: 1, revision: 1, global: { theme: 'system', selected_navigation: { kind: 'projects' }, window: null, pinned: false, notification_watermark: null }, sessions: [], later: [], drafts: [] };
}
async function setup(saved: OwnerDraft[] = [], change: (session: Session) => void = () => {}) {
  const session = structuredClone(demo) as Session, prefs = preferences(); prefs.drafts = structuredClone(saved);
  session.items['2']!.options = [{ id: 'yes', label: 'Keep the design', consequence: 'Retain the current contract.', recommended: true },
    { id: 'no', label: 'Change the design', consequence: 'Review a new contract.', recommended: false }];
  change(session);
  const calls: OwnerMutationRequest[] = [], writes: OwnerMutationRequest[] = [];
  let outcome: 'ok' | 'uncertain' | 'malformed' | 'error' | 'question_changed' | 'operation_reused' = 'ok', preferenceOutcome: 'ok' | 'uncertain' = 'ok', readError = false, deleteConflicts = 0;
  let submitGate: Promise<void> | null = null, cancelGate: Promise<void> | null = null, prefGate: Promise<void> | null = null;
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
        if (prefGate) await prefGate;
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
    /** Holds every draft save (preferences write) until the returned function is called. */
    gatePrefs: () => { let resolve!: () => void; prefGate = new Promise<void>(done => { resolve = () => { prefGate = null; done(); }; }); return resolve; },
    render: (itemId = '2', props: Partial<AnswerSlotProps> = {}) => render(<AnswerSlot drafts={drafts} store={store} itemId={itemId} onEscape={() => {}} {...props} />),
    restart: async () => { const restored = new OwnerDraftStore(service, () => uuid(++counter)); await restored.load(); return restored; } };
}
const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement;
/** The app root with its window-level key routing and a tree row that records every key replayed at it as a shortcut. */
function KeyedRoot({ children, shortcuts }: { readonly children: ReactNode; readonly shortcuts: string[] }) {
  const root = useRef<HTMLDivElement>(null);
  useWindowKeys(root);
  return <div ref={root}><section className="tree-column"><div data-row="1" tabIndex={0} onKeyDown={event => { shortcuts.push(event.key); }} /></section>{children}</div>;
}
const staleView = (store: object) => act(() => { (store as unknown as { publish: (update: object) => void }).publish({ status: 'stale' }); });

describe('owner input component and durable draft controller', () => {
  it.each([
    { note: undefined, expected: 'Latest draft before React renders' },
    { note: 'Explicit answer-box note', expected: 'Explicit answer-box note' },
    { note: '', expected: '' },
  ])('uses an explicit option note or the fresh draft when omitted: $note', async ({ note, expected }) => {
    const value = await setup(), session = value.store.getSnapshot().snapshot!.session;
    const id = value.drafts.begin(session, '2', 'answer')!;
    const { result } = renderHook(() => useSubmit({ drafts: value.drafts, session, current: true, itemId: '2', intent: 'answer' }));
    // The shortcut may run before the store notification gives React its next render.
    await act(async () => {
      value.drafts.edit(id, { text: 'Latest draft before React renders' });
      result.current.sendOption('no', note);
    });
    await waitFor(() => expect(value.calls).toHaveLength(1));
    expect(value.calls[0]!.command).toMatchObject({ command: 'input_submit', params: { selected_option_id: 'no', text: expected } });
  });
  // The tree's z-persists-Later versus editor-typing check lives in App.test.tsx now that rows hand z to the workspace keys.
  // A finished item (1) opens its follow-up box on press; an open item (1.1) always shows its reply box.
  it.each([['1', 'Follow up', 'Follow-up message', false], ['1.1', 'Reply', 'Reply message', true]])('focuses the box only after explicit %s %s; Esc leaves it and keeps the draft', async (itemId, action, label, always) => {
    const value = await setup(), user = userEvent.setup();
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId={itemId} later={false} onOpenItem={() => {}} />);
    const button = await screen.findByRole('button', { name: action });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    if (always) expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: label }));
    else expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const textarea = await screen.findByRole('textbox', { name: label });
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    await user.keyboard('Retain this draft');
    await user.click(button);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    await user.keyboard('{Escape}');
    // Words the owner typed stay on screen in either box (a status change could otherwise hide them); Esc only leaves the box.
    expect(document.activeElement).not.toBe(textarea); expect((screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement).value).toBe('Retain this draft');
    await user.click(button);
    expect((screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement).value).toBe('Retain this draft'); expect(value.calls).toHaveLength(0);
  });
  describe('the reply box is always docked on an open or in-progress item', () => {
    const show = (value: Awaited<ReturnType<typeof setup>>, itemId: string) =>
      render(<ItemDetail drafts={value.drafts} store={value.store} itemId={itemId} later={false} onOpenItem={() => {}} />);
    it.each([['8', 'open', 'Reply message'], ['3', 'in_progress', 'Note message']])('keeps the composer visible outside the scrolling detail for %s (%s), without waiting on the owner', async (itemId, status, label) => {
      const value = await setup();
      expect(value.session.items[itemId]!.status).toBe(status);
      show(value, itemId);
      const composer = await screen.findByRole('textbox', { name: label });
      expect(composer.closest('.detail-dock')).not.toBeNull();
      expect(composer.closest('.detail-body')).toBeNull();
      expect(composer.closest('[hidden], [aria-hidden="true"]')).toBeNull();
      expect(document.activeElement).not.toBe(composer);
    });
    it('shows the reply box on an open item and the note box on an in-progress one, with no button pressed first', async () => {
      const value = await setup();
      show(value, '8');
      expect(await screen.findByRole('textbox', { name: 'Reply message' })).toBeTruthy();
      expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Reply message' }));
      cleanup(); show(value, '3');
      expect(await screen.findByRole('textbox', { name: 'Note message' })).toBeTruthy();
    });
    it('shows no box on a finished item until Follow up is pressed', async () => {
      const value = await setup();
      for (const itemId of ['1', '5', '6']) {
        cleanup(); show(value, itemId);
        await screen.findByRole('button', { name: 'Follow up' });
        expect(screen.queryByRole('textbox')).toBeNull();
      }
      // A replaced item has a stopped delivery on it: still no box.
      cleanup(); show(value, '7');
      await screen.findByRole('article', { name: 'Detail of #7' });
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    it('keeps the box, and hides Bring it up and Drop, while a message to the item is on its way; a second one queues behind it', async () => {
      const value = await setup(), user = userEvent.setup();
      // Item 3 is in progress with a reply in flight; item 4 is open with a drop queued.
      show(value, '4');
      expect(await screen.findByRole('textbox', { name: 'Reply message' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Bring it up/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Drop/ })).toBeNull();
      cleanup(); show(value, '3');
      expect(await screen.findByRole('textbox', { name: 'Note message' })).toBeTruthy();
      expect(document.querySelector('[data-pending]')).toBeTruthy();
      await user.type(screen.getByRole('textbox', { name: 'Note message' }), 'Also cover the 429 case');
      await waitFor(() => expect((screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement).disabled).toBe(false));
      await user.click(screen.getByRole('button', { name: 'Send note' }));
      await waitFor(() => expect(value.calls.map(call => call.command)).toMatchObject([{ command: 'input_submit', params: { kind: 'note', text: 'Also cover the 429 case' } }]));
    });
    it('keeps what was typed when the owner switches to another item and back', async () => {
      const value = await setup(), user = userEvent.setup();
      show(value, '8');
      await user.type(await screen.findByRole('textbox', { name: 'Reply message' }), 'Draft for eight');
      await waitFor(() => expect(value.prefs.drafts.some(draft => draft.text === 'Draft for eight')).toBe(true));
      cleanup(); show(value, '1.1');
      expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('');
      cleanup(); show(value, '8');
      expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Draft for eight');
      expect(value.calls).toHaveLength(0);
    });
    /** The agent moves the item to another status while the owner is writing. */
    const moveTo = async (value: Awaited<ReturnType<typeof setup>>, itemId: string, status: 'open' | 'in_progress' | 'done' | 'waiting_on_me') => {
      const item = value.session.items[itemId]!; item.status = status; item.revision++; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
    };
    const savedIn = (value: Awaited<ReturnType<typeof setup>>, words: string) => value.prefs.drafts.filter(draft => draft.text.includes(words)).map(draft => draft.intent);
    const settle = () => act(async () => { await new Promise(done => setTimeout(done, 80)); });
    const sendable = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled === false;
    it('keeps typed words in place when the item goes from open to in progress to done: nothing is copied, the box names what it will send', async () => {
      const value = await setup(), user = userEvent.setup(), words = 'Also check the retry path';
      show(value, '8');
      await user.type(await screen.findByRole('textbox', { name: 'Reply message' }), words);
      await waitFor(() => expect(savedIn(value, words)).toEqual(['reply']));
      // The agent takes it: the dock edits the same draft; its label says it goes out as a note now.
      await moveTo(value, '8', 'in_progress');
      await waitFor(() => expect((screen.getByRole('textbox', { name: 'Note message' }) as HTMLTextAreaElement).value).toBe(words));
      expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
      expect(screen.getByText('This will be sent as a note, which fits the item now. You wrote it as a reply.')).toBeTruthy();
      await settle();
      expect(savedIn(value, words)).toEqual(['reply']);
      expect(value.prefs.drafts).toHaveLength(1);
      // The item changed since the words were written: the warning shows and Send waits for the review.
      expect(screen.getByText(changedText)).toBeTruthy();
      expect(sendable('Send note')).toBe(false);
      // It finishes: still the same words in the same draft, now to be sent as a follow-up.
      await moveTo(value, '8', 'done');
      await waitFor(() => expect((screen.getByRole('textbox', { name: 'Follow-up message' }) as HTMLTextAreaElement).value).toBe(words));
      expect(screen.queryByRole('textbox', { name: 'Note message' })).toBeNull();
      await settle();
      expect(savedIn(value, words)).toEqual(['reply']);
      expect(screen.getByText(changedText)).toBeTruthy();
      expect(value.calls).toHaveLength(0);
      // Reviewed, they go out once, as a follow-up, and the draft they came from is emptied.
      await user.click(screen.getByRole('button', { name: 'Review current target' }));
      await waitFor(() => expect(screen.queryByText(changedText)).toBeNull());
      await waitFor(() => expect(sendable('Send follow-up')).toBe(true));
      await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
      await waitFor(() => expect(value.calls.map(call => call.command)).toMatchObject([{ command: 'input_submit', params: { kind: 'followup', text: words } }]));
      await waitFor(() => expect(value.prefs.drafts).toEqual([]));
      expect(value.calls).toHaveLength(1);
    });
    it('keeps a follow-up written on a finished item when the agent reopens it, and again when it finishes', async () => {
      const value = await setup(), user = userEvent.setup();
      show(value, '1');
      await user.click(await screen.findByRole('button', { name: 'Follow up' }));
      await user.type(await screen.findByRole('textbox', { name: 'Follow-up message' }), 'Could we test the empty case');
      await waitFor(() => expect(savedIn(value, 'empty case')).toEqual(['followup']));
      await moveTo(value, '1', 'open');
      await waitFor(() => expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Could we test the empty case'));
      expect(screen.queryByRole('textbox', { name: 'Follow-up message' })).toBeNull();
      await settle();
      expect(savedIn(value, 'empty case')).toEqual(['followup']);
      await moveTo(value, '1', 'done');
      await waitFor(() => expect((screen.getByRole('textbox', { name: 'Follow-up message' }) as HTMLTextAreaElement).value).toBe('Could we test the empty case'));
      await moveTo(value, '1', 'open');
      await waitFor(() => expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Could we test the empty case'));
      expect(value.prefs.drafts).toHaveLength(1);
    });
    it('keeps the words when the status flips back and forth while a save is still pending', async () => {
      const value = await setup(), words = 'Words saved while the status flips';
      show(value, '8');
      const box = await screen.findByRole('textbox', { name: 'Reply message' });
      const release = value.gatePrefs();
      fireEvent.change(box, { target: { value: words } });
      // Open -> in progress -> open again, all before the draft save lands.
      await moveTo(value, '8', 'in_progress');
      await moveTo(value, '8', 'open');
      expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(words);
      await act(async () => { release(); });
      await settle();
      expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(words);
      // One draft holds the words, saved; there is no second copy and no empty twin.
      expect(value.prefs.drafts.map(draft => [draft.intent, draft.text])).toEqual([['reply', words]]);
      expect(Object.values(value.drafts.getSnapshot().entries).filter(entry => entry.draft.text.includes(words))).toHaveLength(1);
      expect(value.calls).toHaveLength(0);
    });
    it('does not bring sent words back when clearing the sent draft fails', async () => {
      const value = await setup(), user = userEvent.setup(), words = 'Sent exactly once';
      show(value, '8');
      await user.type(await screen.findByRole('textbox', { name: 'Reply message' }), words);
      await waitFor(() => expect(savedIn(value, words)).toEqual(['reply']));
      await moveTo(value, '8', 'in_progress');
      await screen.findByRole('textbox', { name: 'Note message' });
      await user.click(screen.getByRole('button', { name: 'Review current target' }));
      await waitFor(() => expect(sendable('Send note')).toBe(true));
      value.conflictDeletes(3);
      await user.click(screen.getByRole('button', { name: 'Send note' }));
      await waitFor(() => expect(value.calls).toHaveLength(1));
      await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
      // The agent moves the item on and back: the sent words stay gone from every box.
      await moveTo(value, '8', 'done'); await moveTo(value, '8', 'open'); await settle();
      expect(screen.queryAllByDisplayValue(words)).toHaveLength(0);
      expect(value.calls).toHaveLength(1);
    });
    it('shows both drafts when two boxes hold words, each labelled with what it sends as; sending one leaves the other', async () => {
      const item = (demo as unknown as Session).items['8']!, base = { session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: '8' },
        selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null };
      const value = await setup([{ ...base, op_id: uuid(81), intent: 'reply', text: 'First words' }, { ...base, op_id: uuid(82), intent: 'note', text: 'Second words' }]), user = userEvent.setup();
      show(value, '8');
      const first = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
      expect(first.value).toBe('First words');
      const second = screen.getByRole('textbox', { name: 'Reply message, another draft' }) as HTMLTextAreaElement;
      expect(second.value).toBe('Second words');
      expect(screen.getAllByText('This will be sent as a reply, which fits the item now. You wrote it as a note.')).toHaveLength(1);
      expect(document.querySelectorAll('[data-owner-input]')).toHaveLength(1);
      await waitFor(() => expect(sendable('Send reply') && sendable('Send reply, another draft')).toBe(true));
      await user.click(screen.getByRole('button', { name: 'Send reply, another draft' }));
      await waitFor(() => expect(value.calls.map(call => call.command)).toMatchObject([{ command: 'input_submit', params: { kind: 'reply', text: 'Second words' } }]));
      await waitFor(() => expect(value.prefs.drafts.map(draft => draft.text)).toEqual(['First words']));
      expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('First words');
      expect(screen.queryByRole('textbox', { name: 'Reply message, another draft' })).toBeNull();
    });
    const twoDrafts = () => {
      const item = (demo as unknown as Session).items['8']!, base = { session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: '8' },
        selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null };
      return [{ ...base, op_id: uuid(81), intent: 'note', text: 'First words' }, { ...base, op_id: uuid(82), intent: 'reply', text: 'Second words' }] as OwnerDraft[];
    };
    it('gives each Send button a name that tells the drafts apart, and links the kind note to its box', async () => {
      const value = await setup(twoDrafts());
      show(value, '8');
      const first = await screen.findByRole('textbox', { name: 'Reply message' }), second = screen.getByRole('textbox', { name: 'Reply message, another draft' });
      expect(screen.getAllByRole('button', { name: /^Send reply/ }).map(button => button.getAttribute('aria-label'))).toEqual(['Send reply', 'Send reply, another draft']);
      // Only the first draft was written as a note: its note describes it, and the other box has no description.
      const note = screen.getByText('This will be sent as a reply, which fits the item now. You wrote it as a note.');
      expect(note.id).not.toBe('');
      expect(first.getAttribute('aria-describedby')).toBe(note.id);
      expect(second.getAttribute('aria-describedby')).toBeNull();
    });
    it('shows no "will be sent as" note on a draft that was already attempted: a retry sends the saved kind', async () => {
      const item = (demo as unknown as Session).items['3']!;
      const value = await setup([{ session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: '3' }, op_id: uuid(85),
        intent: 'reply', text: 'Tried once', selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null,
        submission_attempted: true }]);
      show(value, '3');
      // The item is in progress, so a fresh draft would go out as a note, but this attempt is frozen as the reply it was: the
      // box and its Send button are named for the reply that the retry sends, not for the note the status would suggest.
      const box = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
      expect(box.value).toBe('Tried once'); expect(box.disabled).toBe(true);
      expect(screen.queryByRole('textbox', { name: 'Note message' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Send reply' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Send note' })).toBeNull();
      expect(box.placeholder).toBe('Reply in your own words…');
      expect(screen.queryByText(/It will be sent as a/)).toBeNull();
      expect(box.getAttribute('aria-describedby')).toBeNull();
    });
    it('keeps typing in the same box when the other draft is emptied', async () => {
      const value = await setup(twoDrafts()), user = userEvent.setup();
      show(value, '8');
      const first = await screen.findByRole('textbox', { name: 'Reply message' }), second = screen.getByRole('textbox', { name: 'Reply message, another draft' }) as HTMLTextAreaElement;
      act(() => { second.focus(); second.setSelectionRange(second.value.length, second.value.length); });
      fireEvent.change(first, { target: { value: '' } });
      // The emptied draft leaves; the owner's box is still the one in hand, holding its own words.
      await waitFor(() => expect(screen.queryByDisplayValue('First words')).toBeNull());
      expect(second.isConnected).toBe(true); expect(document.activeElement).toBe(second);
      await user.keyboard('!');
      expect(second.value).toBe('Second words!');
      await waitFor(() => expect(value.prefs.drafts.map(draft => draft.text).filter(Boolean)).toEqual(['Second words!']));
    });
    it('keeps focus in the blank box when the first keystroke makes it a draft', async () => {
      const value = await setup(), user = userEvent.setup();
      show(value, '8');
      const box = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
      await user.click(box);
      await user.keyboard('Hello');
      await waitFor(() => expect(savedIn(value, 'Hello')).toEqual(['reply']));
      expect(box.isConnected).toBe(true); expect(document.activeElement).toBe(box); expect(box.value).toBe('Hello');
    });
    it('keeps the same box, with its focus, when a saved draft is emptied', async () => {
      const item = (demo as unknown as Session).items['8']!;
      const value = await setup([{ session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: '8' }, op_id: uuid(86),
        intent: 'reply', text: 'Some saved words', selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null }]);
      show(value, '8');
      const box = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
      expect(box.value).toBe('Some saved words');
      act(() => { box.focus(); });
      fireEvent.change(box, { target: { value: '' } });
      await waitFor(() => expect(value.prefs.drafts.map(draft => draft.text).filter(Boolean)).toEqual([]));
      const after = screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
      expect(after).toBe(box); expect(box.isConnected).toBe(true); expect(document.activeElement).toBe(box); expect(box.value).toBe('');
      fireEvent.change(box, { target: { value: 'New words' } });
      expect(screen.getByRole('textbox', { name: 'Reply message' })).toBe(box);
    });
    it('focuses the draft typed in last when r is pressed, else the newest', async () => {
      const value = await setup(twoDrafts());
      const render8 = (token?: number) => <ItemDetail drafts={value.drafts} store={value.store} itemId="8" later={false} onOpenItem={() => {}}
        focusRequest={token ? { intent: 'reply', token } : undefined} />;
      const view = render(render8());
      const first = await screen.findByRole('textbox', { name: 'Reply message' }), second = screen.getByRole('textbox', { name: 'Reply message, another draft' });
      // Nothing typed yet: the newest draft.
      view.rerender(render8(1));
      await waitFor(() => expect(document.activeElement).toBe(second));
      // The oldest is typed in: r goes back to it, whichever has focus.
      fireEvent.change(first, { target: { value: 'First words!' } });
      act(() => { second.focus(); });
      view.rerender(render8(2));
      await waitFor(() => expect(document.activeElement).toBe(first));
      fireEvent.change(second, { target: { value: 'Second words!' } });
      act(() => { first.focus(); });
      view.rerender(render8(3));
      await waitFor(() => expect(document.activeElement).toBe(second));
    });
    it('names a waiting item’s reply a reply, never a follow-up, on the button, the box and the note', async () => {
      const item = (demo as unknown as Session).items['2']!;
      const value = await setup([{ session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: '2' }, op_id: uuid(87),
        intent: 'followup', text: 'Written as a follow-up', selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null }]);
      show(value, '2');
      expect(await screen.findByRole('button', { name: 'Add a reply' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /follow-up/i })).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeTruthy();
      expect(screen.getByText('This will be sent as a reply, which fits the item now. You wrote it as a follow-up.')).toBeTruthy();
      expect(screen.getByText('Your reply is kept. Send it, or answer below.')).toBeTruthy();
    });
    // What each box's draft goes out as follows the item's status (core accepts all three kinds at any status).
    it('names the kind that fits every status', () => {
      expect(Object.fromEntries((['open', 'waiting', 'agent', 'progress', 'decided', 'done', 'dropped', 'replaced'] as const).map(status => [status, sentAs(status)])))
        .toEqual({ open: 'reply', waiting: 'reply', agent: 'followup', progress: 'note', decided: 'followup', done: 'followup', dropped: 'followup', replaced: 'followup' });
    });
    it.each([
      ['reply', '8', 'open', 'reply'], ['note', '8', 'open', 'reply'], ['followup', '8', 'open', 'reply'],
      ['reply', '3', 'in progress', 'note'], ['note', '3', 'in progress', 'note'], ['followup', '3', 'in progress', 'note'],
      ['reply', '1', 'done', 'followup'], ['note', '1', 'done', 'followup'], ['followup', '1', 'done', 'followup'],
      ['reply', '2', 'waiting', 'reply'], ['note', '2', 'waiting', 'reply'], ['followup', '2', 'waiting', 'reply'],
    ] as const)('sends a %s draft on item %s (%s) as a %s', async (kind, itemId, _status, sentKind) => {
      const item = (demo as unknown as Session).items[itemId]!;
      const value = await setup([{ session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: itemId }, op_id: uuid(83),
        intent: kind, text: 'Words to map', selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null }]);
      show(value, itemId);
      const label = { reply: 'Reply message', note: 'Note message', followup: 'Follow-up message' }[sentKind], button = { reply: 'Send reply', note: 'Send note', followup: 'Send follow-up' }[sentKind];
      expect((await screen.findByRole('textbox', { name: label }) as HTMLTextAreaElement).value).toBe('Words to map');
      // A waiting item also has its answer box with a Send reply button: the owner's words box is the one in "Your message".
      const mine = () => within(screen.getByRole('region', { name: 'Your message' })).getByRole('button', { name: button }) as HTMLButtonElement;
      await waitFor(() => expect(mine().disabled).toBe(false));
      await userEvent.setup().click(mine());
      await waitFor(() => expect(value.calls.map(call => call.command)).toMatchObject([{ command: 'input_submit', params: { kind: sentKind, text: 'Words to map' } }]));
      await waitFor(() => expect(value.prefs.drafts).toEqual([]));
    });
    it('saves the kind a draft goes out as together with the attempt, so an unconfirmed send is retried as the same message', async () => {
      const item = (demo as unknown as Session).items['8']!;
      const value = await setup([{ session: route, binding_id: (demo as unknown as Session).active_binding_id!, target: { topic_id: item.topic_id, item_id: '8' }, op_id: uuid(84),
        intent: 'note', text: 'Written as a note', selected_option_id: null, target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null }]);
      value.outcome('uncertain'); show(value, '8');
      await screen.findByRole('textbox', { name: 'Reply message' });
      await waitFor(() => expect(sendable('Send reply')).toBe(true));
      await userEvent.setup().click(screen.getByRole('button', { name: 'Send reply' }));
      await waitFor(() => expect(value.prefs.drafts).toMatchObject([{ op_id: uuid(84), intent: 'reply', text: 'Written as a note', submission_attempted: true }]));
      expect(value.calls).toMatchObject([{ command: { command: 'input_submit', op_id: uuid(84), params: { kind: 'reply' } } }]);
      // After a restart the saved attempt is rebuilt as the same reply, never as the note it was typed in.
      const restored = await value.restart();
      expect(restored.find(route, '8', 'reply')?.draft.text).toBe('Written as a note');
      expect(restored.find(route, '8', 'note')).toBeUndefined();
    });
    it('keeps the typing in the same box, with focus, when an in-progress item starts waiting on the owner', async () => {
      const value = await setup(), user = userEvent.setup();
      show(value, '3');
      const box = await screen.findByRole('textbox', { name: 'Note message' }) as HTMLTextAreaElement;
      await user.click(box); await user.keyboard('First part');
      expect(document.activeElement).toBe(box);
      // The agent asks a question: the box moves from "While the agent works" to the follow-up, but is the same box.
      await moveTo(value, '3', 'waiting_on_me');
      await screen.findByRole('button', { name: 'Add a reply' });
      const after = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
      expect(after).toBe(box);
      expect(document.activeElement).toBe(box);
      await user.keyboard(' and the rest');
      expect(box.value).toBe('First part and the rest');
      await waitFor(() => expect(savedIn(value, 'First part and the rest')).toEqual(['note']));
    });
    it('does not send with Cmd+Enter while the Send button is held back by a lost connection', async () => {
      // The host's last observation (the session list carries it) says the agent is reconnecting.
      const observation = (summariesFixture.items[0] as SessionSummary).active_binding!.presence!, connected = observation.connection_state;
      observation.connection_state = 'reconnecting';
      try {
        const value = await setup(), user = userEvent.setup();
        show(value, '8');
        const box = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
        await user.type(box, 'Waiting for the connection');
        await waitFor(() => expect(savedIn(value, 'Waiting for the connection')).toEqual(['reply']));
        await waitFor(() => expect((screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(true));
        await user.keyboard('{Meta>}{Enter}{/Meta}');
        await act(async () => { await new Promise(done => setTimeout(done, 40)); });
        expect(value.calls).toHaveLength(0);
        expect(box.value).toBe('Waiting for the connection');
      } finally { observation.connection_state = connected; }
      // Connected, the same keys send it.
      cleanup();
      const online = await setup(), typer = userEvent.setup();
      show(online, '8');
      await typer.type(await screen.findByRole('textbox', { name: 'Reply message' }), 'Go now');
      await waitFor(() => expect((screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(false));
      await typer.keyboard('{Meta>}{Enter}{/Meta}');
      await waitFor(() => expect(online.calls.map(call => call.command)).toMatchObject([{ command: 'input_submit', params: { kind: 'reply', text: 'Go now' } }]));
    });
    it('closes a Drop box left open when a message to the item becomes pending, and says another can be written', async () => {
      const value = await setup(), user = userEvent.setup(), item = value.session.items['8']!;
      show(value, '8');
      await user.click(await screen.findByRole('button', { name: /^Drop/ }));
      await user.type(await screen.findByRole('textbox', { name: 'Drop reason' }), 'the metric covers it');
      // The owner presses Bring it up elsewhere (or a message was queued): a message to this item is now on its way.
      const queued = structuredClone(value.session.inputs['00000000-0000-4000-8000-000000000076']!);
      queued.id = uuid(90); queued.seq = 50; queued.kind = 'bring'; queued.state = 'queued'; queued.message_id = uuid(91);
      queued.target = { ...queued.target, topic_id: item.topic_id, item_id: '8' }; queued.payload.target_snapshot.question_revision = item.question_revision;
      value.session.inputs[queued.id] = queued; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      await waitFor(() => expect(document.querySelector('[data-pending]')).toBeTruthy());
      expect(screen.queryByRole('textbox', { name: 'Drop reason' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Drop/ })).toBeNull();
      expect(screen.getByText('Your message is on its way. You can write another; it goes out after.')).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeTruthy();
      expect(value.calls).toHaveLength(0);
    });
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
    expect(screen.getByRole('button', { name: 'Send as a reply only' }).hasAttribute('disabled')).toBe(true);
    const [first, second] = screen.getAllByRole('button').filter(button => button.hasAttribute('data-answer-option'));
    expect(first!.getAttribute('aria-pressed')).toBe('true'); expect(screen.getByRole('button', { name: 'Send “Keep the design”' })).toBeTruthy();
    second!.focus(); fireEvent.keyDown(second!, { key: '2' });
    await waitFor(() => expect(second!.getAttribute('aria-pressed')).toBe('true'));
    expect(value.calls).toHaveLength(0);
    fireEvent.change(editor(), { target: { value: ' Exact owner bytes \n' } });
    const finish = value.gate(); editor().focus(); fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    const send = screen.getByRole('button', { name: 'Send as a reply only' }); fireEvent.click(send); fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(value.calls).toHaveLength(1));
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true);
    expect(value.calls[0]?.command.command === 'input_submit' && value.calls[0].command.params).toMatchObject({ text: ' Exact owner bytes \n', selected_option_id: null });
    await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4'); expect(value.calls).toHaveLength(1); expect(value.prefs.drafts).toEqual([]);
    expect(value.session.items['2']!.status).toBe('waiting_on_me');
  });
  it('sends a selected option with the exact note once, after saving both in the durable draft', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: /2Change the design/ }));
    fireEvent.change(editor(), { target: { value: ' Keep these exact note bytes \n' } });
    const send = screen.getByRole('button', { name: 'Send “Change the design” with your note' }), finish = value.gate();
    fireEvent.click(send); fireEvent.click(send);
    fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(value.calls).toHaveLength(1));
    expect(value.prefs.drafts[0]).toMatchObject({ selected_option_id: 'no', text: ' Keep these exact note bytes \n', submission_attempted: true });
    expect(value.calls[0]?.command).toMatchObject({ command: 'input_submit', params: { selected_option_id: 'no', text: ' Keep these exact note bytes \n' } });
    await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4'); expect(value.calls).toHaveLength(1);
  });
  it('retains editable unsent option and note over detail changes, unrelated preferences, refresh and restart without auto-send', async () => {
    const value = await setup(), view = value.render(); await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: /2Change the design/ }));
    fireEvent.change(editor(), { target: { value: 'Keep this draft' } });
    await waitFor(() => expect(value.prefs.drafts[0]).toMatchObject({ selected_option_id: 'no', text: 'Keep this draft' }));
    view.rerender(<AnswerSlot drafts={value.drafts} store={value.store} itemId="4" onEscape={() => {}} />); expect(screen.queryByRole('textbox')).toBeNull();
    value.prefs.global.theme = 'dark'; value.prefs.revision++;
    view.rerender(<AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={() => {}} />); expect(editor().value).toBe('Keep this draft');
    await act(async () => { await value.store.refresh(); }); expect(editor().value).toBe('Keep this draft');
    const restored = await value.restart(); view.rerender(<AnswerSlot drafts={restored} store={value.store} itemId="2" onEscape={() => {}} />);
    expect(editor().value).toBe('Keep this draft'); expect(editor().disabled).toBe(false); expect(value.calls).toHaveLength(0);
    expect(screen.getByRole('button', { name: /2Change the design/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Send “Change the design” with your note' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' })); await screen.findByRole('button', { name: 'Try sending again' });
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
    fireEvent.change(editor(), { target: { value: 'Exact untrimmed bytes  ' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
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
    const reply = screen.getByRole('button', { name: 'Send as a reply only' });
    await waitFor(() => expect(reply.hasAttribute('disabled')).toBe(false));
    fireEvent.click(reply);
    expect(held).toHaveLength(1); expect(held[0]!.change).toEqual({ selected_option_id: null, text: 'Keep my words' });
    // Cancel: the dialog never queues, so the draft is unchanged.
    expect([saved().text, saved().selected_option_id]).toEqual(['Keep my words', 'no']);
    fireEvent.click(screen.getByRole('button', { name: 'Send “Change the design” with your note' }));
    expect(held).toHaveLength(2); expect(held[1]!.change).toEqual({ selected_option_id: 'no', text: 'Keep my words' });
    expect([saved().text, saved().selected_option_id]).toEqual(['Keep my words', 'no']);
    expect(editor().value).toBe('Keep my words'); expect(value.calls).toHaveLength(0);
    await act(async () => { await held[1]!.queue(); });
    const sent = value.calls[0]!.command;
    expect(sent.command === 'input_submit' && [sent.params.text, sent.params.selected_option_id]).toEqual(['Keep my words', 'no']);
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
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' })); expect(value.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' })); expect(editor().value).toBe('Retain explanation');
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' })); await screen.findByText('Saved · Queue position #4');
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
    expect(editor().value).toBe('Survives failure'); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' })); expect(value.calls).toHaveLength(0);
  });
  it('prepares a separate reviewed draft only after definitive question rejection, retaining the old frozen record', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); value.outcome('question_changed');
    fireEvent.change(editor(), { target: { value: 'Owner explanation remains exact' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    await screen.findByRole('button', { name: 'Edit and send again' }); const original = structuredClone(value.prefs.drafts[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit and send again' }));
    await screen.findByRole('button', { name: 'Review current target' }); expect(value.calls).toHaveLength(1); expect(editor().value).toBe('Owner explanation remains exact');
    await waitFor(() => expect(value.prefs.drafts).toHaveLength(2)); expect(value.prefs.drafts[0]).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Review current target' })); value.outcome('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' })); await screen.findByText('Saved · Queue position #4');
    expect(value.calls[1]?.command.op_id).not.toBe(value.calls[0]?.command.op_id); expect(value.prefs.drafts).toEqual([original]);
  });
  it('never permits changed-payload recovery for operation reuse or restored unknown attempts', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); value.outcome('operation_reused');
    fireEvent.change(editor(), { target: { value: 'Keep operation identity' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
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
    // A stale view only marks the option aria-disabled (it keeps focus); a send or save in progress disables it outright.
    const option = screen.getByRole('button', { name: /2Change the design/ });
    expect(option.hasAttribute('disabled')).toBe(guard !== 'stale');
    expect(option.getAttribute('aria-disabled')).toBe(guard === 'stale' ? 'true' : null);
    fireEvent.click(option);
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
  it('uses a labelled pencil icon to take a queued Sent message back into its durable reply draft', async () => {
    const text = 'Complete queued message\nKeep the final spaces  ';
    const value = await setup([], session => {
      const queued = session.inputs['00000000-0000-4000-8000-000000000076']!;
      queued.kind = 'reply'; queued.payload.text = text;
      session.messages.find(message => message.id === queued.message_id)!.body = text;
    }), input = value.session.inputs['00000000-0000-4000-8000-000000000076']!;
    const queue = new WaitingStore(value.service, value.sessions); waitingStores.push(queue); await queue.start();
    const reveal = vi.fn();
    render(<WaitingColumn drafts={value.drafts} store={queue} revealItem={reveal} openSession={() => {}} />);
    const edit = await screen.findByRole('button', { name: 'Edit message' });
    expect(edit.getAttribute('title')).toBe('Edit message');
    expect(edit.querySelector('i.ph-pencil-simple')).not.toBeNull();
    expect(edit.textContent).toBe('');
    await waitFor(() => expect(edit.hasAttribute('disabled')).toBe(false));
    fireEvent.click(edit);
    await waitFor(() => expect(value.calls.map(call => call.command)).toMatchObject([{ command: 'input_cancel', params: { input_id: input.id, purpose: 'edit' } }]));
    await waitFor(() => expect(value.prefs.drafts).toMatchObject([{ text, intent: 'reply', target: { item_id: '4' } }]));
    expect(value.drafts.find(route, '4', 'reply')?.draft.text).toBe(text);
    expect(reveal).toHaveBeenCalledWith({ ...route, item_id: '4' });
    expect(value.events.indexOf(`draft:${text}`)).toBeGreaterThan(value.events.indexOf('cancelled'));
    expect(value.calls.some(call => call.command.command === 'input_submit')).toBe(false);
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
    fireEvent.change(editor(), { target: { value: 'Already durably submitted' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.preferenceOutcome('uncertain'); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4'); await screen.findByRole('button', { name: 'Try saving your draft again' });
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true); expect(value.calls).toHaveLength(1);
    value.preferenceOutcome('ok'); fireEvent.click(screen.getByRole('button', { name: 'Try saving your draft again' }));
    await waitFor(() => expect(value.prefs.drafts).toEqual([])); expect(value.calls).toHaveLength(1);
  });
  it('retries draft cleanup after a saved input when an interleaved navigation patch bumped the revision', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Saved then conflicted' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.conflictDeletes(1); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4');
    await waitFor(() => expect(value.prefs.drafts).toEqual([]));
    expect(value.calls).toHaveLength(1); expect(value.drafts.getSnapshot().preferenceUncertain).toBe(false); expect(value.drafts.getSnapshot().error).toBeNull();
    expect(value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'delete_draft'))).toHaveLength(2);
    expect(Object.values((await value.restart()).getSnapshot().entries)).toEqual([]);
  });
  it('surfaces draft cleanup failure after three revision conflicts without further retries', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Conflicted thrice' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    await waitFor(() => expect(value.calls).toHaveLength(1)); value.conflictDeletes(5); await act(async () => { finish(); });
    await screen.findByText('Saved · Queue position #4');
    await waitFor(() => expect(value.drafts.getSnapshot().error).not.toBeNull());
    expect(value.writes.filter(write => write.command.command === 'preferences_patch' && write.command.params.entries.some(entry => entry.kind === 'delete_draft'))).toHaveLength(3);
    expect(value.prefs.drafts[0]?.submission_attempted).toBe(true); expect(value.calls).toHaveLength(1);
  });
  it('never retries cleanup on commit_uncertain and keeps the draft recoverable as uncertain', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox'); const finish = value.gate();
    fireEvent.change(editor(), { target: { value: 'Uncertain cleanup' } }); fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
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
    const followUp = await screen.findByRole('button', { name: 'Add a reply' });
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
    expect(screen.getByRole('button', { name: 'Add a reply' })).toBeTruthy();
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
    const followUp = await screen.findByRole('button', { name: 'Add a reply' });
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
    const followUp = await screen.findByRole('button', { name: 'Add a reply' });
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false)); await user.click(followUp);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Reply message' }), { target: { value: 'One more thing' } });
    await waitFor(() => expect(value.prefs.drafts.some(draft => draft.text === 'One more thing')).toBe(true));
    value.session.inputs[uuid(90)]!.state = 'cancelled'; value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('One more thing');
    expect(screen.getByText('Your reply is kept. Send it, or answer below.')).toBeTruthy();
  });
  it('keeps words typed while the session view is refreshing, and sends them once it is fresh', async () => {
    const value = await setup(), user = userEvent.setup(), item = value.session.items['2']!;
    const queued = structuredClone(value.session.inputs['00000000-0000-4000-8000-000000000076']!);
    value.session.inputs[uuid(90)] = { ...queued, id: uuid(90), kind: 'answer', target: { topic_id: item.topic_id, item_id: '2' } };
    value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="2" later={false} onOpenItem={() => {}} />);
    const followUp = await screen.findByRole('button', { name: 'Add a reply' });
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false)); await user.click(followUp);
    const box = await screen.findByRole('textbox', { name: 'Reply message' });
    // A live change hint marks the view stale until its refresh lands; the owner types in that window.
    act(() => { (value.store as unknown as { publish: (update: object) => void }).publish({ status: 'stale' }); });
    fireEvent.change(box, { target: { value: 'Typed while refreshing' } });
    await waitFor(() => expect(value.prefs.drafts.some(draft => draft.text === 'Typed while refreshing')).toBe(true));
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Typed while refreshing');
    // Nothing goes out against a view that may be behind.
    expect(screen.getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(true);
    value.session.revision++;
    await act(async () => { await value.store.refresh(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(false));
    expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('Typed while refreshing');
  });
  it('keeps the words and the focus when the answer box is typed in while the session view refreshes, with no shortcut firing', async () => {
    const value = await setup(), user = userEvent.setup(), shortcuts: string[] = [];
    render(<KeyedRoot shortcuts={shortcuts}><AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={() => {}} /></KeyedRoot>);
    await waitFor(() => expect(editor().disabled).toBe(false));
    await user.click(editor());
    staleView(value.store);
    // d, e and 1 are drop, archive and choose when they reach the tree; here they are the owner's words.
    await user.keyboard('de1');
    await waitFor(() => expect(editor().value).toBe('de1'));
    expect(document.activeElement).toBe(editor());
    expect(shortcuts).toEqual([]);
    // Nothing goes out against a view that may be behind: neither the reply nor the option.
    expect(screen.getByRole('button', { name: 'Send as a reply only' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Send “Keep the design” with your note' }).getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    expect(value.calls).toHaveLength(0);
    await act(async () => { await value.store.refresh(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send as a reply only' }).hasAttribute('aria-disabled')).toBe(false));
    expect(editor().value).toBe('de1');
  });
  it('keeps a focused option focusable while the view refreshes: aria-disabled, so a click, Enter or digit changes and sends nothing', async () => {
    const value = await setup(), user = userEvent.setup(), shortcuts: string[] = [];
    render(<KeyedRoot shortcuts={shortcuts}><AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={() => {}} /></KeyedRoot>);
    await waitFor(() => expect(editor().disabled).toBe(false));
    const other = screen.getByRole('button', { name: /2Change the design/ }), recommended = screen.getByRole('button', { name: /1Keep the design/ });
    act(() => { other.focus(); });
    staleView(value.store);
    // A disabled button drops the focus it holds to <body>, where the next digit is a tree shortcut; an aria-disabled one keeps it.
    await waitFor(() => expect(other.getAttribute('aria-disabled')).toBe('true'));
    expect(other.hasAttribute('disabled')).toBe(false); expect(recommended.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Send “Keep the design”' }).getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(other);
    await user.click(other); await user.keyboard('2'); await user.keyboard('{Enter}'); await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(other.getAttribute('aria-pressed')).toBe('false'); expect(recommended.getAttribute('aria-pressed')).toBe('true');
    expect(shortcuts).toEqual([]); expect(value.calls).toHaveLength(0);
    // Fresh again: the same button works.
    await act(async () => { await value.store.refresh(); });
    await waitFor(() => expect(other.hasAttribute('aria-disabled')).toBe(false));
    await user.click(other);
    expect(other.getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps words typed while the view refreshes when the item changes underneath, then asks for a review and holds Send', async () => {
    const value = await setup(), user = userEvent.setup(), shortcuts: string[] = [];
    render(<KeyedRoot shortcuts={shortcuts}><AnswerSlot drafts={value.drafts} store={value.store} itemId="2" onEscape={() => {}} /></KeyedRoot>);
    await waitFor(() => expect(editor().disabled).toBe(false));
    await user.click(editor());
    staleView(value.store);
    value.session.items['2']!.revision++; value.session.revision++;
    await user.keyboard('Keep it');
    await waitFor(() => expect(editor().value).toBe('Keep it'));
    expect(shortcuts).toEqual([]);
    await act(async () => { await value.store.refresh(); });
    await screen.findByRole('button', { name: 'Review current target' });
    expect(screen.getByText(changedText)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send as a reply only' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Send “Keep the design” with your note' }).hasAttribute('disabled')).toBe(true);
    expect(editor().value).toBe('Keep it');
    expect(value.calls).toHaveLength(0);
    // The box locks for the review, which drops focus to <body>: further keys stay the owner's, never tree shortcuts. A browser
    // moves the focus of a field disabled under the owner to <body>; jsdom keeps it there (and user.keyboard would type into the
    // disabled field, which does nothing), so the keys are sent to <body> directly.
    expect(editor().disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: 'd' }); fireEvent.keyDown(document.body, { key: 'e' });
    expect(shortcuts).toEqual([]);
    expect(editor().value).toBe('Keep it');
    // The same keys do reach the tree once the owner moves on deliberately, so the check above is not vacuous.
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document.body, { key: 'd' });
    expect(shortcuts).toEqual(['d']);
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
    const followUp = await screen.findByRole('button', { name: 'Add a reply' });
    await waitFor(() => expect(followUp.hasAttribute('disabled')).toBe(false)); await user.click(followUp);
    await screen.findByRole('textbox', { name: 'Reply message' });
    const section = screen.getByRole('region', { name: 'Reply' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
    await waitFor(() => expect(value.calls).toHaveLength(1));
  });
  it('does not move a saving or uncertain entry to the new binding', async () => {
    const value = await setup(); value.render(); await screen.findByRole('textbox');
    fireEvent.change(editor(), { target: { value: 'In flight' } });
    await waitFor(() => expect(value.prefs.drafts[0]?.text).toBe('In flight'));
    const release = value.gate(); value.outcome('uncertain');
    fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
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
  const cancelledTurn = () => detail().querySelector<HTMLElement>('[data-message-id="00000000-0000-4000-8000-000000000109"]');
  const getPutBack = () => within(cancelledTurn()!).getByRole('button', { name: 'Put back in reply box' });
  const queryPutBack = () => cancelledTurn() ? within(cancelledTurn()!).queryByRole('button', { name: 'Put back in reply box' }) : null;
  const findPutBack = () => waitFor(getPutBack);
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
  it('explains a queued message in the tracker; Delete keeps its cancelled text in the timeline', async () => {
    const { value, remove, revision } = await queuedOnItem4();
    expect(detail().textContent).toContain('Drop request for item 4.');
    fireEvent.click(remove);
    await waitFor(() => expect(cancels(value.calls)).toEqual([{ input_id: demoInput('76'), expected_revision: revision }]));
    expect(value.prefs.drafts).toEqual([]);
    // Core cancelled it before any delivery: it leaves the tracker but keeps readable text in the chat.
    await waitFor(() => expect(screen.queryByText('Queued behind your message on “Implement receipt lookup”')).toBeNull());
    expect(detail().textContent).toContain('Drop request for item 4.');
    expect(within(document.querySelector<HTMLElement>('[data-message-id="00000000-0000-4000-8000-000000000109"]')!).getByText('Cancelled before it reached the agent')).toBeTruthy();
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
    expect(await screen.findByText('Taken back to edit. Cancelled before it reached the agent')).toBeTruthy();
    expect(getPutBack()).toBeTruthy();
    expect(value.calls.some(call => call.command.command === 'input_submit')).toBe(false);
  });
  it('Edit on a queued note while the item is open shows its words in the docked reply box, labelled as a reply, with no extra step', async () => {
    const { value, edit } = await queuedOnItem4('note');
    fireEvent.click(edit!);
    // The words land in the one box the owner can see, which says what it will send as. No second draft is made.
    const box = await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement;
    expect(box.value).toBe(queuedText);
    expect(screen.getByText('This will be sent as a reply, which fits the item now. You wrote it as a note.')).toBeTruthy();
    expect(value.prefs.drafts).toMatchObject([{ intent: 'note', text: queuedText, target: { item_id: '4' } }]);
    await act(async () => { await new Promise(done => setTimeout(done, 80)); });
    expect(value.prefs.drafts).toHaveLength(1);
    expect(value.calls.some(call => call.command.command === 'input_submit')).toBe(false);
    // It goes out once, as a reply.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(value.calls.filter(call => call.command.command === 'input_submit').map(call => call.command)).toMatchObject([{ params: { kind: 'reply', text: queuedText } }]));
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
      // The reply box is always there on an open item; nothing was put in it.
      expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('');
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
      // The reply box is always there on an open item; nothing was put in it.
      expect((screen.getByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe('');
      // The cancel may still land: it is kept, and Check again sends the same operation.
      value.cancelOutcome('ok');
      fireEvent.click(within(detail() as HTMLElement).getByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Taken back to edit. Cancelled before it reached the agent')).toBeTruthy();
      const [first, second] = value.calls.filter(call => call.command.command === 'input_cancel');
      expect(second?.command.op_id).toBe(first?.command.op_id);
      expect(cancels(value.calls).every(params => 'purpose' in params && params.purpose === 'edit')).toBe(true);
      untouched(value);
      fireEvent.click(getPutBack());
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
      fireEvent.click(getPutBack());
      expect((await screen.findByRole('textbox', { name: 'Reply message' }) as HTMLTextAreaElement).value).toBe(queuedText);
      expect(value.prefs.drafts).toMatchObject([{ intent: 'reply', text: queuedText, target: { item_id: '4' } }]);
      // Nothing is cancelled or sent by putting it back.
      expect(value.writes.map(write => write.command.command).filter(name => name !== 'preferences_patch')).toEqual([]);
    });
    it('says the session was closed when close cancelled it; Put back waits for Reopen', async () => {
      await cancelledBy('session_closed', session => { session.state = 'closed'; session.closed_at = '2026-10-04T12:00:00.000Z'; });
      expect(await screen.findByText(/Not sent: cancelled when you closed this session\. Reopen the session/)).toBeTruthy();
      expect(queryPutBack()).toBeNull();
    });
    it('says the session was closed when close cancelled it and it is open again', async () => {
      await cancelledBy('session_closed');
      expect(await screen.findByText('Not sent: cancelled when you closed this session')).toBeTruthy();
      expect(getPutBack()).toBeTruthy();
    });
    it('after a restart, a message taken back to edit still reads Taken back to edit, and Put back loads it', async () => {
      // A fresh draft store and session read stand for the app started again with the cancel saved in core.
      const value = await cancelledBy('owner_edit'), restored = await value.restart();
      cleanup();
      render(<ItemDetail drafts={restored} store={value.store} itemId="4" later={false} onOpenItem={() => {}} />);
      expect(await screen.findByText('Taken back to edit. Cancelled before it reached the agent')).toBeTruthy();
      expect(detail().textContent).toContain('Drop request for item 4.');
      fireEvent.click(getPutBack());
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
      expect(queryPutBack()).toBeNull();
    });
    it('never overwrites a reply the owner already started: the old text shows to copy', async () => {
      const value = await cancelledBy('topic_archived');
      const id = value.drafts.begin(value.store.getSnapshot().snapshot!.session, '4', 'reply')!;
      value.drafts.edit(id, { text: 'My own reply' });
      await waitFor(() => expect(value.prefs.drafts.some(draft => draft.op_id === id && draft.text === 'My own reply')).toBe(true));
      fireEvent.click(await findPutBack());
      expect((await screen.findByRole('textbox', { name: 'Your earlier message' }) as HTMLTextAreaElement).value).toBe(queuedText);
      expect(value.drafts.find(route, '4', 'reply')!.draft.text).toBe('My own reply');
    });
    it.each([['owner'], [undefined]] as const)('keeps an owner-deleted message and its reason when cause is %s', async cause => {
      await cancelledBy(cause);
      const turn = document.querySelector<HTMLElement>('[data-message-id="00000000-0000-4000-8000-000000000109"]')!;
      expect(await within(turn).findByText('Cancelled before it reached the agent')).toBeTruthy();
      expect(turn.textContent).toContain('Drop request for item 4.');
      expect(turn.classList.contains('detail-turn-cancelled')).toBe(true);
      expect(within(turn).getByRole('button', { name: 'Copy message' })).toBeTruthy();
      expect(turn.closest('[hidden], [aria-hidden="true"]')).toBeNull();
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
      expect(queryPutBack()).toBeNull();
    });
    it('offers no Put back after it was put back and sent', async () => {
      const value = await cancelledBy('topic_archived');
      fireEvent.click(await findPutBack());
      await screen.findByRole('textbox', { name: 'Reply message' });
      // The owner sends it: a new queued reply with the same words, to the same item.
      const later = structuredClone(value.session.inputs[demoInput('76')]!);
      later.id = demoInput('97'); later.seq += 100; later.state = 'queued'; later.cancel_cause = undefined; value.session.inputs[later.id] = later; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      await waitFor(() => expect(queryPutBack()).toBeNull());
      expect(screen.getByText(/You sent it again\./)).toBeTruthy();
    });
    it('offers no Put back while the put-back words are sending, nor after they are sent, before the session view catches up', async () => {
      const value = await cancelledBy('owner_edit');
      fireEvent.click(await findPutBack());
      await screen.findByRole('textbox', { name: 'Reply message' });
      const finish = value.gate();
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
      await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries).some(entry => entry.saving)).toBe(true));
      // Sending: the session still shows only the cancelled message.
      expect(await screen.findByText(/Taken back to edit\. Cancelled before it reached the agent\. You sent it again\./)).toBeTruthy();
      expect(queryPutBack()).toBeNull();
      await act(async () => { finish(); });
      await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries).some(entry => entry.receipt)).toBe(true));
      // Sent, session view not refreshed: still no button, and loading the words again is refused.
      expect(queryPutBack()).toBeNull();
      const session = value.store.getSnapshot().snapshot!.session;
      expect(await putBackCancelled(value.drafts, session, session.inputs[demoInput('76')]!)).toEqual({ kind: 'already_sent' });
    });
    it('offers Put back again when the sent words were refused', async () => {
      const value = await cancelledBy('owner_edit');
      fireEvent.click(await findPutBack());
      await screen.findByRole('textbox', { name: 'Reply message' });
      value.outcome('error');
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
      await waitFor(() => expect(value.calls.some(call => call.command.command === 'input_submit')).toBe(true));
      await waitFor(() => expect(Object.values(value.drafts.getSnapshot().entries).every(entry => !entry.saving)).toBe(true));
      expect(await findPutBack()).toBeTruthy();
    });
    it('offers no Put back while the topic is archived: it says to restore it first', async () => {
      await cancelledBy('topic_archived', session => { session.topics[session.items['4']!.topic_id]!.archived_at = '2026-10-04T12:00:00.000Z'; });
      expect(await screen.findByText(/Not sent: cancelled when you archived this topic\. Restore the topic/)).toBeTruthy();
      expect(queryPutBack()).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Add a reply' })).toBeNull();
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

describe('the item detail reads like a chat', () => {
  const view = async (itemId: string, change?: (session: Session) => void) => {
    const value = await setup();
    if (change) { change(value.session); value.session.revision++; await value.store.refresh(); }
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId={itemId} later={false} onOpenItem={() => {}} />);
    await screen.findByRole('article');
    const pane = document.querySelector<HTMLElement>('.item-detail')!;
    return { value, pane, body: pane.querySelector<HTMLElement>('.detail-body')!, dock: pane.querySelector<HTMLElement>('.detail-dock'),
      chat: () => screen.queryByRole('region', { name: 'Conversation' }) };
  };
  const turns = (chat: HTMLElement) => [...chat.querySelectorAll('li.detail-turn')] as HTMLElement[];
  /** Item 1's round, cloned as later rounds with an owner message each; inserted newest first so only the ordinal puts them in order. */
  const rounds = (session: Session) => {
    const base = Object.values(session.rounds).find(round => round!.item_id === '1')!;
    const message = session.messages.find(value => value.id === base.owner_message_ids[0])!;
    for (const [ordinal, ask, said] of [[3, 'Third ask', 'Third reply'], [2, 'Second ask', 'Second reply']] as const) {
      const id = uuid(ordinal * 10), messageId = uuid(ordinal * 10 + 1);
      session.rounds[id] = { ...structuredClone(base), id, ordinal, ask_snapshot: ask, owner_message_ids: [messageId], agent_message_ids: [], result_input_ids: [], fork_item_ids: [], closed_at: null };
      session.messages.push({ ...structuredClone(message), id: messageId, number: 90 + ordinal, body: said, input_id: null, round_id: id });
    }
  };
  const demoId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
  const order = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('puts the reference on top, the conversation after it and the composer docked below the scrolling body', async () => {
    const { pane, body, dock } = await view('2');
    expect([...pane.children].map(element => element.className)).toEqual(['detail-body', 'detail-dock']);
    const labels = [...body.children].map(element => element.getAttribute('aria-label') ?? element.className);
    expect(labels[0]).toBe('detail-head');
    expect(labels.at(-1)).toBe('Conversation');
    expect(labels).not.toContain('Timeline');
    expect(body.querySelector('.detail-head .detail-reference')).toBeTruthy();
    expect(body.querySelector('.detail-reference code')).toBeNull();
    expect(dock!.querySelector('textarea')).toBeTruthy();
    expect(body.contains(dock)).toBe(false);
    // The pane does not scroll; the body does, and the dock keeps its own height.
    expect(pane.contains(screen.getByRole('textbox', { name: 'Reply in your own words' }))).toBe(true);
  });
  it('docks the composer by CSS: a scrolling body above a dock that never shrinks', async () => {
    const css = readFileSync(resolve(__dirname, '../../../src/ui/detail/detail.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => css.split('}').map(block => block.trim()).filter(block => block.split('{')[0]!.split(',').some(part => part.trim() === selector)).join('\n');
    expect(rule('.detail-body')).toMatch(/overflow(-y)?:\s*(hidden auto|auto)/);
    expect(rule('.detail-body')).toMatch(/flex:\s*1/);
    expect(rule('.detail-dock')).toMatch(/flex:\s*none/);
  });
  it('lists every saved message once in number order, with inline forks and no round headers', async () => {
    const { chat, value } = await view('1', rounds);
    const list = turns(chat()!), ids = list.map(turn => turn.dataset.messageId);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = ids.map(id => value.session.messages.find(message => message.id === id)!.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(chat()!.textContent).toContain('You chose “Keep complete history”');
    expect(chat()!.textContent).toContain('Second reply');
    expect(chat()!.textContent).toContain('Third reply');
    expect(chat()!.textContent).toContain('The full history is retained.');
    expect(chat()!.textContent).toContain('Agent raised this');
    expect(chat()!.querySelector('.detail-msg-result')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Round \d|Back and forth|\d+ rounds?/);
    expect(within(chat()!).getByRole('button', { name: /Branched into Add the receipt lookup test/ })).toBeTruthy();
  });
  it('shows a first, unanswered ask as the open one, marked Waiting on you', async () => {
    const { chat } = await view('2', session => {
      const round = Object.values(session.rounds).find(value => value!.item_id === '2')!;
      round.owner_message_ids = []; round.result_input_ids = [];
      for (const input of Object.values(session.inputs)) if (input!.target.item_id === '2') input!.state = 'cancelled';
    });
    const turn = turns(chat()!).find(turn => turn.classList.contains('detail-turn-now'))!;
    expect(turn!.className).toContain('detail-turn-now');
    expect(turn!.querySelector('.detail-bubble-agent')!.textContent).toContain('Choose the next delivery window.');
    expect(within(turn!).getByText('Waiting on you')).toBeTruthy();
    expect(turn!.querySelector('.detail-bubble-you')).toBeNull();
  });
  it('shows an ask that is only the head question once, with the open marker', async () => {
    const { chat, body } = await view('2', session => {
      const round = Object.values(session.rounds).find(value => value!.item_id === '2')!;
      round.ask_snapshot = round.question_snapshot; round.owner_message_ids = []; round.result_input_ids = [];
      for (const input of Object.values(session.inputs)) if (input!.target.item_id === '2') input!.state = 'cancelled';
    });
    const turn = turns(chat()!).find(turn => turn.classList.contains('detail-turn-now'))!;
    expect(within(turn!).getByText('Waiting on you')).toBeTruthy();
    expect(body.querySelector('.detail-question')!.textContent).toBe('Which delivery window?');
    expect(chat()!.textContent!.split('Choose the next delivery window.')).toHaveLength(2);
  });
  it('does not mark an ask the owner already answered as waiting on them', async () => {
    const { chat } = await view('2');
    // Item 2's round already carries the owner’s message, so nothing is open in the conversation.
    expect(within(chat()!).queryByText('Waiting on you')).toBeNull();
  });
  it('puts the quick replies directly above the composer, inside the dock', async () => {
    const { dock } = await view('2');
    const options = [...dock!.querySelectorAll<HTMLElement>('[data-answer-option]')], box = within(dock!).getByRole('textbox', { name: 'Reply in your own words' });
    expect(options.map(option => option.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Keep the design'), expect.stringContaining('Change the design')]));
    for (const option of options) expect(order(option, box)).toBe(true);
    // Quick replies and composer are one group, the replies first.
    const group = dock!.querySelector('.answer')!;
    expect([...group.children].map(child => child.className.split(' ')[0])).toEqual(['answer-options', 'answer-send-row', 'answer-reply']);
    expect(group.lastElementChild!.contains(box)).toBe(true);
  });
  it('shows no composer on a closed item, only its revisit actions, docked in the same place', async () => {
    const { dock, body } = await view('1');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.answer')).toBeNull();
    expect(within(dock!).getByRole('region', { name: 'Revisit' })).toBeTruthy();
    expect(within(dock!).getAllByRole('button').length).toBeGreaterThan(0);
    expect(body.contains(dock)).toBe(false);
  });
  it('ends the conversation with a queued message as a pending bubble, once', async () => {
    const { chat } = await view('4');
    const pending = [...chat()!.querySelectorAll<HTMLElement>('li[data-pending]')], last = turns(chat()!).at(-1)!;
    expect(pending).toHaveLength(1);
    expect(last).toBe(pending[0]);
    expect(last.querySelector('.detail-bubble-you')!.textContent).toContain('Drop it');
    expect(last.textContent).toContain('Not sent yet');
    // A drop request carries no words to change, so it can be deleted but not edited.
    expect(within(last).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(last).getByRole('button', { name: 'Delete' })).toBeTruthy();
    // Its Delete sits with the message, not above the conversation.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });
  it('keeps a pending answer out of its round and ends the conversation with it', async () => {
    const { chat } = await view('2', session => {
      const input = session.inputs[demoId('71')]!;
      input.state = 'queued'; input.kind = 'answer'; input.payload.text = 'Keep the design';
    });
    const list = turns(chat()!).filter(turn => turn.dataset.pending);
    expect(list.at(-1)!.dataset.pending).toBe(demoId('71'));
    // The owner's own words can be taken back to edit, or deleted, right on the bubble.
    expect(within(list.at(-1)!).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(list.at(-1)!).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(chat()!.querySelectorAll('[data-pending]')).toHaveLength(1);
    expect(within(chat()!).queryByText('Waiting on you')).toBeNull();
  });
  describe('the newest ask keeps Waiting on you while an older or unrelated message is pending', () => {
    /**
     * Item 2 asked, and its latest ask has no reply. Core files every owner input of the item in its open round, a Bring
     * request or a note too, so the round keeps the message of whatever is queued, as core writes it.
     */
    const asked = (session: Session) => {
      const round = Object.values(session.rounds).find(value => value!.item_id === '2')!;
      round.result_input_ids = [];
      for (const input of Object.values(session.inputs)) if (input!.target.item_id === '2') input!.state = 'cancelled';
      return round;
    };
    it('keeps it with a queued Bring request filed under the asking round, as core files it: it is not an answer to the ask', async () => {
      const { chat } = await view('2', session => {
        const round = asked(session), bring = session.inputs[demoId('71')]!;
        bring.state = 'queued'; round.owner_message_ids = [bring.message_id];
      });
      expect(document.querySelector('[data-pending]')).toBeTruthy();
      expect(within(chat()!).getByText('Waiting on you')).toBeTruthy();
    });
    it('keeps it with a queued note filed under the asking round', async () => {
      const { chat } = await view('2', session => {
        const round = asked(session), note = session.inputs[demoId('71')]!;
        note.state = 'queued'; note.kind = 'note'; note.payload.text = 'Also mind the retry path'; round.owner_message_ids = [note.message_id];
      });
      expect(document.querySelector('[data-pending]')).toBeTruthy();
      expect(within(chat()!).getByText('Waiting on you')).toBeTruthy();
    });
    it('drops it once an answer to the current ask is on its way, and also for a reply to it', async () => {
      for (const kind of ['answer', 'reply'] as const) {
        cleanup();
        const { chat } = await view('2', session => {
          const round = asked(session), input = session.inputs[demoId('71')]!;
          input.state = 'queued'; input.kind = kind; input.payload.text = 'Keep the design'; round.owner_message_ids = [input.message_id];
        });
        expect(document.querySelector('[data-pending]')).toBeTruthy();
        expect(within(chat()!).queryByText('Waiting on you')).toBeNull();
      }
    });
    it('keeps it with a message held for an older ask, even one filed under the newest round', async () => {
      const { chat } = await view('2', session => {
        const round = Object.values(session.rounds).find(value => value!.item_id === '2')!, input = session.inputs[demoId('71')]!;
        for (const other of Object.values(session.inputs)) if (other!.target.item_id === '2') other!.state = 'cancelled';
        // The answer was written for an earlier version of the question: it is held, and the newer ask is still the owner's to answer.
        round.owner_message_ids = [input.message_id]; round.result_input_ids = [];
        input.state = 'queued'; input.kind = 'answer'; input.payload.target_snapshot.question_revision = 1; session.items['2']!.question_revision = 2;
      });
      expect(document.querySelector('[data-pending]')).toBeTruthy();
      expect(within(turns(chat()!).filter(turn => turn.dataset.round).at(-1)!).getByText('Waiting on you')).toBeTruthy();
    });
  });
  it('lets an item opened at its head stay there when its first message arrives; only a reader at the end follows', async () => {
    const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    const client = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
    try {
      // Nothing said yet: the item opens at its head, with more below it.
      const { value, body } = await view('2', session => {
        const round = Object.values(session.rounds).find(entry => entry!.item_id === '2')!;
        round.owner_message_ids = []; round.agent_message_ids = []; round.result_input_ids = [];
        for (const input of Object.values(session.inputs)) if (input!.target.item_id === '2') input!.state = 'cancelled';
      });
      expect(body.scrollTop).toBe(0);
      // The owner's first message appears while they read the head: the view stays.
      const input = value.session.inputs[demoId('71')]!;
      input.state = 'queued'; input.kind = 'answer'; input.payload.text = 'Keep the design'; value.session.revision++;
      await act(async () => { await value.store.refresh(); });
      await waitFor(() => expect(document.querySelector('.detail-chat .detail-bubble-you')).toBeTruthy());
      expect(body.scrollTop).toBe(0);
    } finally { height.mockRestore(); client.mockRestore(); }
  });
  it('shows where a copied item came from with the item’s references, not under the composer', async () => {
    const value = await setup(), item = value.session.items['8']!;
    item.origin = { project_id: demo.project_id, session_id: demo.id, topic_id: item.topic_id, entity_id: '77', source_revision: 1 };
    value.session.revision++; await value.store.refresh();
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="8" later={false} onOpenItem={() => {}}
      provenance={<span className="copied-provenance"><button type="button">Source item 77</button></span>} />);
    const button = await screen.findByRole('button', { name: 'Source item 77' });
    const body = document.querySelector<HTMLElement>('.detail-body')!, dock = document.querySelector<HTMLElement>('.detail-dock')!;
    expect(body.contains(button)).toBe(true);
    expect(dock.contains(button)).toBe(false);
    // Among the references at the top, ahead of the timeline and the conversation.
    const labels = [...body.children].map(element => element.getAttribute('aria-label') ?? element.className);
    expect(labels.indexOf('Original item')).toBeGreaterThan(0);
    expect(labels.indexOf('Original item')).toBeLessThan(labels.indexOf('Conversation'));
    // An item that was not copied has no such section.
    cleanup();
    render(<ItemDetail drafts={value.drafts} store={value.store} itemId="1.1" later={false} onOpenItem={() => {}} provenance={<span>Never shown</span>} />);
    await screen.findByRole('article', { name: 'Detail of #1.1' });
    expect(screen.queryByText('Never shown')).toBeNull();
  });
  it('scrolls to the latest message on opening, and on sending even when read further up', async () => {
    const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    try {
      const { value, body } = await view('2');
      await waitFor(() => expect(body.scrollTop).toBe(900));
      // Scrolled up to read: arrivals leave the view alone, a send does not.
      body.scrollTop = 100; fireEvent.scroll(body);
      fireEvent.change(screen.getByRole('textbox', { name: 'Reply in your own words' }), { target: { value: 'Next week' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send as a reply only' }));
      await waitFor(() => expect(value.calls).toHaveLength(1));
      await waitFor(() => expect(body.scrollTop).toBe(900));
    } finally { height.mockRestore(); }
  });
  it('grows the composer with its text up to a third of the pane, then scrolls inside it', async () => {
    const client = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('item-detail') ? 600 : 0; });
    let lines = 3;
    const height = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return this instanceof HTMLTextAreaElement ? lines * 20 : 0; });
    try {
      await view('2');
      const box = screen.getByRole('textbox', { name: 'Reply in your own words' }) as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: 'a\nb\nc' } });
      expect(box.style.height).toBe('60px'); expect(box.style.overflowY).toBe('hidden');
      lines = 30; fireEvent.change(box, { target: { value: 'x\n'.repeat(30) } });
      expect(box.style.height).toBe('200px'); expect(box.style.overflowY).toBe('auto');
    } finally { height.mockRestore(); client.mockRestore(); }
  });
});
