// A waiting item whose answer the agent already handled, and has not asked again: the sent answer stays sealed, and the
// owner can still say more. "Add a reply" (or r) opens the reply box below the sealed cards, in Details and in the bigger
// view. Its words are a durable draft (navigation and a restart keep them), Send goes out once as a reply to the same
// item, and the sealed answer never changes. An answer still on its way keeps today's behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '../../../src/generated/domain/models';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { AnswerSlot } from '../../../src/ui/detail/AnswerSlot';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from './transport';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); notices.clear(); opened.splice(0).forEach(value => value.closeAll()); vi.restoreAllMocks(); });

const ANSWER_INPUT = '00000000-0000-4000-8000-000000000270', ANSWER_MESSAGE = '00000000-0000-4000-8000-000000000271';
const ANSWER_RECORD = '00000000-0000-4000-8000-000000000272', DEMO_ANSWER = '00000000-0000-4000-8000-000000000070';
const ANSWER_TEXT = 'Ship it this week.';

type AnswerState = 'handled' | 'queued' | 'in_flight';

/** Item 2 asks with two options, and the owner's answer to that same ask ("Keep the design" + a note) is `state`. */
function answered(session: Session, state: AnswerState) {
  const item = session.items['2']!, round = session.rounds[item.current_round_id!]!;
  item.options = [{ id: 'keep', label: 'Keep the design', consequence: 'Retain the current contract.', recommended: true },
    { id: 'change', label: 'Change the design', consequence: 'Review a new contract.', recommended: false }];
  round.options_snapshot = structuredClone(item.options); round.closed_at = null; round.question_revision = item.question_revision;
  const input = structuredClone(session.inputs[DEMO_ANSWER]!), message = structuredClone(session.messages.find(value => value.id === input.message_id)!);
  const answer = structuredClone(session.answers.find(value => value.input_id === DEMO_ANSWER)!);
  Object.assign(input, { id: ANSWER_INPUT, message_id: ANSWER_MESSAGE, answer_id: ANSWER_RECORD, state, binding_id: item.recipient_binding_id,
    seq: Math.max(...Object.values(session.inputs).map(value => value?.seq ?? 0)) + 1, target: { topic_id: item.topic_id, item_id: '2' },
    expected_question_revision: item.question_revision });
  input.payload = { ...input.payload, text: ANSWER_TEXT, intent: 'answer', selected_option_id: 'keep',
    target_snapshot: { ...input.payload.target_snapshot, item_question: item.question, question_revision: item.question_revision, ask: item.ask, options: structuredClone(item.options) },
    context: { ...input.payload.context, item_ids: ['2'], round_id: round.id } };
  // Still queued: the agent has not claimed it, so it has no attempts yet.
  if (state === 'queued') { input.attempts = []; input.active_attempt_id = null; }
  Object.assign(message, { id: ANSWER_MESSAGE, input_id: ANSWER_INPUT, item_id: '2', topic_id: item.topic_id, items_touched: ['2'], round_id: round.id,
    body: ANSWER_TEXT, number: Math.max(...session.messages.map(value => value.number)) + 1 });
  Object.assign(answer, { id: ANSWER_RECORD, item_id: '2', input_id: ANSWER_INPUT, message_id: ANSWER_MESSAGE, question_revision: item.question_revision,
    question_snapshot: item.question, ask_snapshot: item.ask, options_snapshot: structuredClone(item.options), selected_option_id: 'keep', text: ANSWER_TEXT });
  session.inputs[ANSWER_INPUT] = input; session.messages.push(message); session.answers.push(answer);
  round.owner_message_ids = [...round.owner_message_ids, ANSWER_MESSAGE];
}

const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
const detail = (id = '2') => screen.getByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${id}"]` });
const conversation = () => screen.getByRole('region', { name: 'Item conversation' });
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const reply = (scope: HTMLElement) => within(scope).queryByLabelText<HTMLTextAreaElement>('Reply message');

/** What the sealed answer shows: its picked option, the note sent with it, the bar, and that nothing in it is editable. */
function sealed(scope: HTMLElement) {
  const slot = scope.querySelector<HTMLElement>('.detail-answer-slot');
  if (!slot) return null;
  return { picked: [...slot.querySelectorAll('[data-answer-option][aria-pressed="true"]')].map(value => value.textContent),
    note: slot.querySelector('.answer-sent-note')?.textContent ?? null,
    bar: slot.querySelector('.answer-bar-text')?.textContent ?? null,
    editable: slot.querySelectorAll('textarea:not(:disabled)').length };
}

async function mount(transport: AppTransport) {
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false'));
  await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
}

async function setup(state: AnswerState) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  answered(session, state);
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0], { tab_open: true, selected_item_id: '2' });
  await mount(transport);
  return { transport, session };
}

async function expand() {
  fireEvent.click(screen.getByRole('button', { name: 'Read in a bigger view' }));
  await screen.findByRole('region', { name: 'Item conversation' });
}

type Surface = 'Details' | 'bigger view';
const scopeOf = (surface: Surface) => surface === 'Details' ? detail() : conversation();
async function open(surface: Surface) {
  if (surface === 'bigger view') await expand();
  return scopeOf(surface);
}
/** Back on the item: Details via the Map selection, the bigger view by closing it and opening it again. */
async function leaveAndReturn(surface: Surface) {
  if (surface === 'Details') {
    fireEvent.click(row('4')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
    fireEvent.click(row('2')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
  } else {
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull());
    await expand();
  }
  return scopeOf(surface);
}
type Trigger = 'click Add a reply' | 'r';
function trigger(how: Trigger, surface: Surface, scope: HTMLElement) {
  if (how === 'click Add a reply') { fireEvent.click(within(scope).getByRole('button', { name: 'Add a reply' })); return; }
  // r acts on the selected item: from the Map row in Details, from the view itself when it is open.
  const target = surface === 'Details' ? row('2') : conversation();
  target.focus(); fireEvent.keyDown(target, { key: 'r', code: 'KeyR' });
}

const cases = (['Details', 'bigger view'] as const).flatMap(surface => (['click Add a reply', 'r'] as const).map(how => [surface, how] as const));

describe('reply after a handled answer', () => {
  it.each(cases)('%s, %s: opens the reply box below the sealed answer, keeps its words and sends them once as a reply', async (surface, how) => {
    const { transport } = await setup('handled');
    let scope = await open(surface);
    const before = sealed(scope);
    // The answer the agent already handled: sealed, picked up, no Undo, nothing to type in.
    expect(before).toMatchObject({ picked: [expect.stringContaining('Keep the design')], note: ANSWER_TEXT, bar: expect.stringMatching(/^Picked up/), editable: 0 });
    expect(within(scope).queryByRole('button', { name: 'Undo' })).toBeNull();
    // Never a dead end: the way to say more is there, and its box is not open yet.
    const button = await within(scope).findByRole<HTMLButtonElement>('button', { name: 'Add a reply' });
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(reply(scope)).toBeNull();
    // It is in the actions row at the top of the body (SPEC 5.3 item 5), above the sealed cards in the pinned region.
    expect(button.closest('.detail-actions-row')).not.toBeNull();

    trigger(how, surface, scope);
    const box = await waitFor(() => { const value = reply(scopeOf(surface)); expect(value).not.toBeNull(); return value!; });
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(scope.querySelector('.detail-answer-slot')!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(box, { target: { value: 'One more thing: keep the old path too.' } });
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.text === 'One more thing: keep the old path too.' && draft.intent === 'reply')).toBe(true));
    expect(sealed(scopeOf(surface))).toEqual(before);

    // Navigation away and back keeps the words.
    scope = await leaveAndReturn(surface);
    expect(reply(scope)?.value).toBe('One more thing: keep the old path too.');
    // So does a restart: the draft is durable.
    cleanup(); await mount(transport); scope = await open(surface);
    await waitFor(() => expect(reply(scope)?.value).toBe('One more thing: keep the old path too.'));
    expect(sealed(scope)).toEqual(before);
    expect(sends(transport)).toHaveLength(0);

    // Send once: a double click and a repeated Command-Enter.
    const send = within(scope).getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send); fireEvent.click(send);
    fireEvent.keyDown(reply(scope)!, { key: 'Enter', metaKey: true }); fireEvent.keyDown(reply(scope)!, { key: 'Enter', metaKey: true, repeat: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(sends(transport)).toHaveLength(1);
    expect(sends(transport)[0]!.command).toMatchObject({ command: 'input_submit', params: { kind: 'reply', text: 'One more thing: keep the old path too.',
      target: { item_id: '2' }, selected_option_id: null, supersedes_answer_id: null } });
    // The box empties (it never holds sent words), the way to say more stays, and the sealed answer is as it was.
    await waitFor(() => expect(reply(scopeOf(surface))?.value ?? '').toBe(''));
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.text === 'One more thing: keep the old path too.')).toBe(false));
    expect(within(scopeOf(surface)).getByRole('button', { name: 'Add a reply' })).toBeTruthy();
    expect(sealed(scopeOf(surface))).toEqual(before);
  });

  it('sends the reply after a handled answer down the same route as the reply queued behind a pending answer', async () => {
    const shape = async (state: AnswerState) => {
      const { transport } = await setup(state);
      fireEvent.click(await within(detail()).findByRole('button', { name: 'Add a reply' }));
      const box = await waitFor(() => { const value = reply(detail()); expect(value).not.toBeNull(); return value!; });
      fireEvent.change(box, { target: { value: 'Same words' } });
      const send = within(detail()).getByRole<HTMLButtonElement>('button', { name: 'Send reply' });
      await waitFor(() => expect(send.disabled).toBe(false)); fireEvent.click(send);
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      const { op_id: _op, ...command } = sends(transport)[0]!.command; void _op;
      cleanup();
      return { session: sends(transport)[0]!.session, command };
    };
    const pending = await shape('queued'), handled = await shape('handled');
    expect(handled).toEqual(pending);
    expect(handled.command).toMatchObject({ params: { kind: 'reply', target: { item_id: '2' } } });
  });

  it('keeps today’s Details for an answer still on its way: no sealed slot, "Add a reply" queues behind it', async () => {
    await setup('queued');
    const scope = detail();
    expect(await within(scope).findByRole('button', { name: 'Add a reply' })).toBeTruthy();
    expect(within(scope).getByText('Queued behind the answer in flight')).toBeTruthy();
    expect(scope.querySelector('.detail-answer-slot')).toBeNull();
    expect(reply(scope)).toBeNull();
  });
});

describe('the sealed answer card set', () => {
  async function slot(state: AnswerState, replyAfter: boolean) {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    answered(session, state);
    if (replyAfter) {
      // A reply the owner sent after the answer, still queued: it never takes the answer's place in the cards.
      const later = structuredClone(session.inputs[ANSWER_INPUT]!);
      Object.assign(later, { id: '00000000-0000-4000-8000-000000000280', kind: 'reply', answer_id: null, state: 'queued', attempts: [], active_attempt_id: null,
        seq: later.seq + 1, message_id: '00000000-0000-4000-8000-000000000281' });
      later.payload = { ...later.payload, intent: 'reply', text: 'A later reply', selected_option_id: null };
      session.inputs[later.id] = later;
    }
    const service = createDesktopService(transport), drafts = new OwnerDraftStore(service), sessions = new OpenSessions(service);
    opened.push(sessions); const store = sessions.open(route); await Promise.all([store.refresh(), drafts.load()]);
    render(<AnswerSlot drafts={drafts} store={store} itemId="2" onEscape={() => {}} />);
    await waitFor(() => expect(document.querySelector('.answer-bar-text')?.textContent).toBeTruthy());
    return document.body;
  }
  const table: readonly (readonly [AnswerState, boolean, boolean])[] = [
    ['queued', false, true], ['in_flight', false, false], ['handled', false, false],
    ['queued', true, true], ['handled', true, false],
  ];
  it.each(table)('answer %s, a later reply queued: %s → Undo shown: %s; the cards show the answer', async (state, replyAfter, undo) => {
    const body = await slot(state, replyAfter);
    expect(sealed(body)).toMatchObject({ picked: [expect.stringContaining('Keep the design')], note: ANSWER_TEXT, editable: 0 });
    expect(!!within(body).queryByRole('button', { name: 'Undo' })).toBe(undo);
  });
});
