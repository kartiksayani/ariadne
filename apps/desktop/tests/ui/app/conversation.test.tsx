import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from './transport';
import { answerWords } from '../answer/words';

afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); });

const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
const conversation = () => screen.getByRole('region', { name: 'Item conversation' });
const detail = (id: string) => screen.getByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${id}"]` });
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const dock = () => screen.getByRole('region', { name: 'Answer dock' });
/** The dock's "N waiting" / "N more waiting" pill, while it is folded. */
const pill = () => within(dock()).queryByRole('button', { name: /^\d+ (more )?waiting$/ });
const selected = (transport: AppTransport) => transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id;
const key = (target: Element, value: string, extra = {}) => fireEvent.keyDown(target, { key: value, ...extra });
const alt = (target: Element, digit: number) => key(target, digit === 0 ? 'º' : '¡', { code: `Digit${digit}`, altKey: true });

async function setup({ otherSession = false, baseline = false, dropReady = false, coveredWaiting = false, cancelledReplies = false } = {}) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const question = session.items['2']!;
  question.options = Array.from({ length: 9 }, (_, index) => ({
    id: `choice-${index + 1}`, label: `Window ${index + 1}`, consequence: `Use window ${index + 1}.`, recommended: index === 0,
  }));
  session.rounds[question.current_round_id!]!.options_snapshot = structuredClone(question.options);
  if (coveredWaiting) {
    const covered = session.items['4']!;
    Object.assign(covered, { status: 'waiting_on_me', waiting_since: question.waiting_since,
      recipient_binding_id: question.recipient_binding_id, options: structuredClone(question.options),
      current_round_id: 'covered-question', question_revision: question.question_revision });
    session.rounds['covered-question'] = { ...structuredClone(session.rounds[question.current_round_id!]!),
      id: 'covered-question', item_id: covered.id };
    Object.values(session.inputs).forEach(input => { if (input?.target.item_id === covered.id) input.state = 'handled'; });
  }
  if (cancelledReplies) {
    for (const [index, itemId] of ['2', '4'].entries()) {
      const input = structuredClone(Object.values(session.inputs).find(input => input?.kind === 'reply')!);
      const message = structuredClone(session.messages.find(message => message.kind === 'owner_input')!);
      input.id = `cancelled-${itemId}`; input.message_id = `cancelled-message-${itemId}`;
      input.seq += 100 + index; input.kind = 'reply'; input.state = 'cancelled'; input.cancel_cause = 'owner'; input.attempts = [];
      input.target = { ...input.target, topic_id: session.items[itemId]!.topic_id, item_id: itemId };
      input.payload.text = `Kept words for ${itemId}`; input.payload.intent = 'reply'; input.payload.selected_option_id = null;
      input.payload.context.round_id = null;
      input.payload.target_snapshot = { ...input.payload.target_snapshot, item_question: session.items[itemId]!.question,
        question_revision: session.items[itemId]!.question_revision, options: structuredClone(session.items[itemId]!.options) };
      Object.assign(message, { id: input.message_id, input_id: input.id, item_id: itemId, topic_id: input.target.topic_id,
        number: 20 + index, body: input.payload.text });
      session.inputs[input.id] = input; session.messages.push(message); session.items[itemId]!.updated_message_ids.push(message.id);
    }
  }
  const another = session.items['8']!;
  another.status = 'waiting_on_me';
  another.waiting_since = question.waiting_since;
  another.recipient_binding_id = question.recipient_binding_id;
  const referenceMessage = structuredClone(session.messages.find(message => message.kind === 'reply')!);
  referenceMessage.id = '00000000-0000-4000-8000-000000000120'; referenceMessage.number = 16;
  referenceMessage.item_id = '4'; referenceMessage.body = 'Review [the delivery question](item:2).';
  session.messages.push(referenceMessage); session.items['4']!.updated_message_ids.push(referenceMessage.id);
  if (coveredWaiting) {
    const coveredReference = { ...referenceMessage, id: 'covered-reference', number: 17, item_id: '2', body: 'Review [the covered question](item:4).' };
    session.messages.push(coveredReference); question.updated_message_ids.push(coveredReference.id);
  }
  if (dropReady) Object.values(session.inputs).forEach(input => {
    if (input?.target.item_id === '4' && input.state === 'queued') input.state = 'handled';
  });
  session.rounds[another.current_round_id!]!.closed_at = null;
  session.rounds[another.current_round_id!]!.question_revision = another.question_revision;
  if (otherSession) {
    const other = structuredClone(session); other.id = secondId; other.title = 'Other questions';
    transport.sessions.set(secondId, other);
  }
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0], { tab_open: true, selected_item_id: '4' });
  if (baseline) transport.preferences.seen = [{ session: route, since: '2026-10-03T12:00:30.000Z', items: [], topics: [] }];
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    if (coveredWaiting) expect(detail('4').querySelector<HTMLButtonElement>('[data-answer-own]')?.disabled).toBe(false);
    else expect(within(detail('4')).getByLabelText<HTMLTextAreaElement>('Reply message').disabled).toBe(false);
    // Questions 2 and 8 wait in the dock (4, when waiting, is the one Details answers).
    expect(pill()?.textContent).toMatch(coveredWaiting ? /^2 more waiting$/ : /^2 waiting$/);
  });
  return transport;
}

async function expand() {
  const button = screen.getByRole('button', { name: 'Read in a bigger view' });
  button.focus(); fireEvent.click(button);
  await screen.findByRole('region', { name: 'Item conversation' });
  return button;
}

/** The dock at question `id`: opened from its pill, then paged. */
async function dockAt(id: string) {
  if (!dock().hasAttribute('data-open')) fireEvent.click(pill()!);
  const at = () => dock().querySelector(`.answer-dock-current [data-owner-input="${id}"]`);
  await waitFor(() => expect(dock().querySelector('.answer-dock-current')).not.toBeNull());
  const previous = () => within(dock()).getByRole<HTMLButtonElement>('button', { name: 'Previous question' });
  const next = () => within(dock()).getByRole<HTMLButtonElement>('button', { name: 'Next question' });
  while (!at() && !previous().disabled) fireEvent.click(previous());
  while (!at() && !next().disabled) fireEvent.click(next());
  await waitFor(() => expect(at()).not.toBeNull());
}

/** Shows waiting question `id` in the conversation from the dock's question title, as the Waiting card did: the Map selection stays. */
async function switchQuestion(id = '2') {
  await dockAt(id);
  fireEvent.click(dock().querySelector<HTMLButtonElement>('.dock-question-open')!);
  await waitFor(() => expect(conversation().querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id')).toBe(id));
}

describe('desktop item conversation', () => {
  it('opens the selected item and returns focus to expand without remounting or scrolling the Map', async () => {
    const transport = await setup();
    const tree = screen.getByRole('region', { name: 'Session tree' }), selectedRow = row('4');
    const scroller = tree.querySelector<HTMLElement>('.tree-scroll')!;
    scroller.scrollTop = 173;
    const expandButton = await expand();
    expect(within(conversation()).getByLabelText('Detail of Record retry limits')).toBeTruthy();
    expect(document.activeElement).toBe(conversation());
    expect(document.querySelectorAll('[data-detail-item-id]')).toHaveLength(1);
    expect(document.querySelector('[data-covered-detail]')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Session tree', hidden: true })).toBe(tree);
    expect(row('4')).toBe(selectedRow); expect(scroller.scrollTop).toBe(173); expect(selected(transport)).toBe('4');
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull());
    expect(screen.getByRole('region', { name: 'Session tree' })).toBe(tree);
    expect(row('4')).toBe(selectedRow); expect(scroller.scrollTop).toBe(173); expect(selected(transport)).toBe('4');
    // The Read toggle lives in the column's head, which the bigger view never unmounts: focus returns to the same button.
    expect(document.activeElement).toBe(expandButton);
    expect(expandButton.isConnected).toBe(true);
  });

  it('closes a peek before the conversation, including Escape in a typed editor, and keeps the draft', async () => {
    await setup(); await expand();
    const words = within(conversation()).getByLabelText('Reply message');
    fireEvent.change(words, { target: { value: 'Keep this draft when I leave.' } });
    const reference = conversation().querySelector<HTMLButtonElement>('.name-chip');
    expect(reference).toBeTruthy(); fireEvent.click(reference!);
    const peek = await screen.findByRole('dialog', { name: /^Peek:/ });
    key(within(peek).getByRole('button', { name: 'Close peek' }), 'Escape');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Peek:/ })).toBeNull());
    expect(conversation()).toBeTruthy();
    words.focus(); key(words, 'Escape');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull());
    expect(within(detail('4')).getByLabelText<HTMLTextAreaElement>('Reply message').value).toBe('Keep this draft when I leave.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Read in a bigger view' }));
  });

  // Rename is a modal dialog now, opened only from a row on a page (SPEC 5.14), so it can never be open under the
  // conversation; the Text size menu is the one popover left to own Escape first.
  it('lets text size own Escape before the peek and conversation', async () => {
    await setup();
    await expand();
    fireEvent.click(conversation().querySelector<HTMLButtonElement>('.name-chip')!);
    await screen.findByRole('dialog', { name: /^Peek:/ });
    const size = screen.getByRole('button', { name: 'Text size' });
    fireEvent.click(size);
    expect(screen.getByRole('menu', { name: 'Text size' })).toBeTruthy();
    const peekClose = screen.getByRole('button', { name: 'Close peek' });
    key(peekClose, 'Escape');
    expect(screen.queryByRole('menu', { name: 'Text size' })).toBeNull();
    expect(screen.getByRole('dialog', { name: /^Peek:/ })).toBeTruthy();
    expect(conversation()).toBeTruthy();
    key(conversation(), 'Escape');
    expect(screen.queryByRole('dialog', { name: /^Peek:/ })).toBeNull();
    expect(conversation()).toBeTruthy();
    key(conversation(), 'Escape');
    expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull();
  });

  it('lets a focused notice own Escape before a clicked peek and the conversation', async () => {
    await setup(); await expand();
    fireEvent.click(conversation().querySelector<HTMLButtonElement>('.name-chip')!);
    await screen.findByRole('dialog', { name: /^Peek:/ });
    act(() => { notices.push({ id: 'focused-conversation-notice', icon: 'ph ph-check', text: 'Reference copied.' }); });
    const notice = (await screen.findByText('Reference copied.')).closest<HTMLElement>('.pw-note')!;
    key(screen.getByRole('button', { name: 'Close peek' }), 'F6');
    expect(document.activeElement).toBe(notice);
    key(notice, 'Escape');
    expect(screen.queryByText('Reference copied.')).toBeNull();
    expect(screen.getByRole('dialog', { name: /^Peek:/ })).toBeTruthy();
    expect(conversation()).toBeTruthy();
    key(screen.getByRole('button', { name: 'Close peek' }), 'Escape');
    expect(screen.queryByRole('dialog', { name: /^Peek:/ })).toBeNull();
    expect(conversation()).toBeTruthy();
  });

  it('keeps notices announced, visible and actionable above the covered Map', async () => {
    await setup(); await expand();
    const putBack = vi.fn();
    act(() => { notices.push({ id: 'conversation-notice', icon: 'ph ph-chat-text', text: 'Another reply was kept.',
      actions: [{ label: 'Put back in reply box', run: putBack }] }); });
    const notice = await screen.findByText('Another reply was kept.');
    expect(notice.closest('[inert],[aria-hidden="true"]')).toBeNull();
    expect(notice.closest('[role="status"],[role="alert"]')).not.toBeNull();
    fireEvent.click(within(screen.getByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Put back in reply box' }));
    expect(putBack).toHaveBeenCalledOnce();
    expect(conversation()).toBeTruthy();
  });

  it('switches the conversation between dock questions without selecting them; from the Map the path selects and opens Details', async () => {
    const transport = await setup(); await expand();
    const tree = screen.getByRole('region', { name: 'Session tree', hidden: true }), mapRow = row('4');
    const reveals = transport.queries.filter(query => query.request.command === 'reveal_item').length;
    await switchQuestion(); await switchQuestion('8');
    expect(selected(transport)).toBe('4'); expect(row('4')).toBe(mapRow);
    expect(screen.getByRole('region', { name: 'Session tree', hidden: true })).toBe(tree);
    expect(transport.queries.filter(query => query.request.command === 'reveal_item')).toHaveLength(reveals);
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull());
    await dockAt('2');
    const title = dock().querySelector<HTMLButtonElement>('.dock-question-open')!;
    expect(title.title).toBe('Go to “Which delivery window?”');
    fireEvent.click(title);
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await waitFor(() => expect(selected(transport)).toBe('2'));
  });

  it.each(['click', 'Enter'] as const)('opens the dock question in Details from its title, by %s', async how => {
    const transport = await setup(); await dockAt('2');
    const title = within(dock().querySelector<HTMLElement>('.dock-question-title')!).getByRole<HTMLButtonElement>('button', { name: 'Open Which delivery window?' });
    expect(title.matches('.dock-question-open')).toBe(true);
    expect(within(dock().querySelector<HTMLElement>('.dock-path')!).queryByText('Which delivery window?')).toBeNull();
    if (how === 'click') fireEvent.click(title);
    else { title.focus(); expect(document.activeElement).toBe(title); await userEvent.keyboard('{Enter}'); }
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await waitFor(() => expect(selected(transport)).toBe('2'));
  });

  it('answers another session’s question from the dock while the conversation stays open and nothing navigates', async () => {
    const transport = await setup({ otherSession: true }); await expand();
    fireEvent.click(await within(dock()).findByRole('button', { name: /in other sessions$/ }));
    const list = within(dock()).getByRole('dialog', { name: 'Questions in other sessions' });
    fireEvent.click(list.querySelector<HTMLElement>('.dock-other-head')!);
    fireEvent.click(await within(list).findByRole('button', { name: /^Window 2/ }));
    fireEvent.click(within(list).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: { ...route, session_id: secondId }, command: { params: { kind: 'answer', selected_option_id: 'choice-2' } } });
    expect(conversation()).toBeTruthy();
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(selected(transport)).toBe('4');
  });

  it('keeps separate item drafts through Waiting switches and returning to the Map', async () => {
    const transport = await setup();
    fireEvent.change(within(detail('4')).getByLabelText('Reply message'), { target: { value: 'Map item draft' } });
    await expand(); await switchQuestion();
    fireEvent.change(answerWords(conversation()), { target: { value: 'First answer draft' } });
    await switchQuestion('8');
    fireEvent.change(answerWords(conversation()), { target: { value: 'Second answer draft' } });
    await switchQuestion();
    expect(answerWords(conversation()).value).toBe('First answer draft');
    await switchQuestion('8');
    expect(answerWords(conversation()).value).toBe('Second answer draft');
    key(conversation(), 'Escape');
    expect(within(detail('4')).getByLabelText<HTMLTextAreaElement>('Reply message').value).toBe('Map item draft');
    expect(selected(transport)).toBe('4'); expect(sends(transport)).toHaveLength(0);
  });

  it('focuses only the overlay answer with r while the Map selects a different item', async () => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    key(conversation(), 'r');
    await waitFor(() => expect(document.activeElement).toBe(conversation().querySelector('[data-answer-option="0"]')));
    expect(document.querySelectorAll('[data-detail-item-id]')).toHaveLength(1);
    expect(selected(transport)).toBe('4'); expect(sends(transport)).toHaveLength(0);
  });

  // `a` is Ack only now (SPEC 6.1; it was the answer fallback): it never focuses, picks or sends an answer.
  it('does not turn a into an answer shortcut: it neither focuses the overlay answer nor sends, and the Map stays', async () => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    const before = document.activeElement;
    const pressed = () => [...conversation().querySelectorAll('[data-answer-option][aria-pressed="true"]')].map(button => button.getAttribute('data-answer-option'));
    const picked = pressed();
    key(conversation(), 'a');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(document.activeElement).toBe(before);
    expect(pressed()).toEqual(picked);
    expect(document.querySelectorAll('[data-detail-item-id]')).toHaveLength(1);
    expect(selected(transport)).toBe('4'); expect(sends(transport)).toHaveLength(0);
    expect(transport.mutations.some(request => request.command.command === 'ack')).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('selects and sends overlay option %i instead of targeting the covered Map item', async digit => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    key(conversation(), String(digit), { code: `Digit${digit}` });
    await waitFor(() => expect(conversation().querySelector(`[data-answer-option="${digit - 1}"]`)?.getAttribute('aria-pressed')).toBe('true'));
    const words = answerWords(conversation());
    fireEvent.change(words, { target: { value: `Note for option ${digit}` } });
    // ⌘↵ in the words box sends the picked option.
    key(words, 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: `choice-${digit}`, text: `Note for option ${digit}` } } });
    expect(selected(transport)).toBe('4');
  });

  // ⌥digit is back (alpha.24): it picks that option of the conversation's question and sends it at once, with the typed note.
  it.each([1, 2, 5, 9])('⌥%i sends that overlay option with the typed note, once, instead of targeting the covered Map item', async digit => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    fireEvent.change(answerWords(conversation()), { target: { value: `Note for option ${digit}` } });
    conversation().focus(); alt(conversation(), digit);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: `choice-${digit}`, text: `Note for option ${digit}` } } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(sends(transport)).toHaveLength(1);
    expect(selected(transport)).toBe('4');
  });

  it('Write my own answer focuses own words and Command Enter answers the pinned question then restores the ordinary composer', async () => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    expect(conversation().querySelector('.conversation-pin')?.textContent).toContain('Your turn');
    expect(within(conversation()).queryByLabelText('Reply message')).toBeNull();
    // ⌥0 no longer focuses own words (SPEC 6.1); the "Write my own answer" card does.
    alt(conversation(), 0);
    expect(conversation().querySelector('.answer textarea')).toBeNull();
    fireEvent.click(conversation().querySelector<HTMLButtonElement>('.answer [data-answer-own]')!);
    const words = answerWords(conversation());
    await waitFor(() => expect(document.activeElement).toBe(words));
    fireEvent.change(words, { target: { value: 'Answer from the larger view' } });
    key(words, 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, text: 'Answer from the larger view' } });
    await waitFor(() => expect(conversation().querySelector('.conversation-pin')).toBeNull());
    expect(within(conversation()).getByLabelText('Reply message')).toBeTruthy();
    expect(selected(transport)).toBe('4');
  });

  it('keeps the status, the dock and the pin aligned before and after an owner reply', async () => {
    const transport = await setup(); await expand(); await switchQuestion();
    fireEvent.click(within(dock()).getByRole('button', { name: 'Fold the dock' }));
    // The bigger view's head has no status badge now (it is in the body); the Map's row says it.
    expect(row('2').querySelector('.status-badge')?.textContent).toBe('Waiting on me');
    // The conversation answers 2, so the dock holds only 8.
    expect(pill()?.textContent).toBe('1 more waiting'); expect(conversation().querySelector('.conversation-pin')).toBeTruthy();
    // The footer keys strip is gone (SPEC, Removed): the conversation advertises no key legend of its own.
    expect(document.querySelector('.shell-footer')).toBeNull();
    const words = answerWords(conversation());
    fireEvent.change(words, { target: { value: 'This is my answer.' } });
    key(words, 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    await waitFor(() => {
      // Saved and not attempted yet: Queued, as core counts it, and "1 sent" in the dock until the agent picks it up.
      expect(within(dock()).getByRole('button', { name: '1 sent, waiting for the agent' })).toBeTruthy();
      expect(conversation().querySelector('.conversation-pin')).toBeNull();
    });
    expect(row('2').querySelector('.status-badge')?.textContent).toBe('Queued');
    expect(within(conversation()).getByLabelText('Reply message')).toBeTruthy();
  });

  it('keeps the view reply box docked and empty after each confirmed reply behind a held answer', async () => {
    const transport = await setup(); await expand(); await switchQuestion();
    fireEvent.change(answerWords(conversation()), { target: { value: 'Held answer' } });
    key(answerWords(conversation()), 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    const box = () => within(conversation()).getByLabelText<HTMLTextAreaElement>('Reply message');
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(conversation().querySelector('[data-detail-item-id="2"]')?.getAttribute('data-status')).toBe('waiting');
    for (const [index, text] of ['First held reply', 'Second held reply'].entries()) {
      const host = conversation().querySelector('[data-owner-input="2"]')!;
      fireEvent.change(box(), { target: { value: text } });
      expect(box().value).toBe(text);
      fireEvent.click(within(host as HTMLElement).getByRole('button', { name: 'Send reply' }));
      await waitFor(() => expect(sends(transport)).toHaveLength(index + 2));
      expect(sends(transport)[index + 1].command).toMatchObject({ params: { kind: 'reply', target: { item_id: '2' }, text } });
      // A confirmed save leaves the box docked, enabled and empty: it never holds the sent text, so it cannot go out twice.
      await waitFor(() => expect(box().value).toBe(''));
      expect(box().disabled).toBe(false);
      expect(conversation().querySelector('[data-owner-input="2"] .detail-box')).not.toBeNull();
    }
    expect(sends(transport)).toHaveLength(3);
  });

  it('shows the queued reply its stuck note in the view and in the pane after closing the view', async () => {
    const transport = await setup(); await expand(); await switchQuestion();
    fireEvent.change(answerWords(conversation()), { target: { value: 'Held answer' } });
    key(answerWords(conversation()), 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    const box = () => within(conversation()).getByLabelText<HTMLTextAreaElement>('Reply message');
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: 'Queued reply' } });
    fireEvent.click(within(conversation().querySelector('[data-owner-input="2"]') as HTMLElement).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    const session = transport.sessions.get(route.session_id)!;
    const saved = Object.values(session.inputs).find(input => input?.payload.text === 'Queued reply')!;
    expect(saved.state).toBe('queued');
    const note = (root: Element) => root.querySelector<HTMLElement>(`.stuck-note[data-stuck-input="${saved.id}"]`);
    await waitFor(() => expect(note(conversation())).not.toBeNull());
    const inView = note(conversation())!, text = (inView.textContent ?? '').trim();
    expect(inView.getAttribute('data-stuck')).toBe('behind');
    expect(text.startsWith('Queued behind your message on')).toBe(true);
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull());
    const pane = () => document.querySelector<HTMLElement>('.item-detail:not(.item-conversation)')!;
    // Switching the view's item does not move the Map selection, so select the reply's item in the pane.
    fireEvent.click(row('2'));
    await waitFor(() => expect(pane().getAttribute('data-detail-item-id')).toBe('2'));
    await waitFor(() => expect(note(pane())).not.toBeNull());
    expect(note(pane())!.getAttribute('data-stuck')).toBe('behind');
    expect((note(pane())!.textContent ?? '').trim()).toBe(text);
  });

  it('keeps the view reply text when its save is not confirmed', async () => {
    const transport = await setup(); await expand(); await switchQuestion();
    fireEvent.change(answerWords(conversation()), { target: { value: 'Held answer' } });
    key(answerWords(conversation()), 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    const box = () => within(conversation()).getByLabelText<HTMLTextAreaElement>('Reply message');
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: 'Unconfirmed reply' } });
    transport.failNext = 'input_submit';
    key(box(), 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    // An unconfirmed save locks the box with its words (an exact retry may follow); it is neither emptied nor sent again.
    await waitFor(() => expect(box().disabled).toBe(true));
    expect(box().value).toBe('Unconfirmed reply');
    expect(sends(transport)).toHaveLength(2);
  });

  it('Command Enter sends the ordinary overlay composer to its own item', async () => {
    const transport = await setup(); await expand(); await switchQuestion();
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'open'; session.rounds[session.items['2']!.current_round_id!]!.closed_at = session.updated_at; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    const words = await within(conversation()).findByLabelText('Reply message');
    fireEvent.change(words, { target: { value: 'Reply to the overlay item' } });
    key(conversation(), 'r'); await waitFor(() => expect(document.activeElement).toBe(words));
    key(words, 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'reply', target: { item_id: '2' }, text: 'Reply to the overlay item' } });
    expect(selected(transport)).toBe('4');
  });

  it('retries an uncertain answer with the identical operation and message', async () => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    const words = answerWords(conversation());
    fireEvent.change(words, { target: { value: 'Keep exact retry words: café\nsecond line' } });
    transport.failNext = 'input_submit'; key(words, 'Enter', { metaKey: true });
    // An unknown result: Check delivery reads the session and sends nothing; not found, Try sending again repeats the exact operation.
    fireEvent.click(await within(conversation()).findByRole('button', { name: 'Check delivery' }));
    const retry = await within(conversation()).findByRole('button', { name: 'Try sending again' });
    expect(sends(transport)).toHaveLength(1);
    const attempted = structuredClone(sends(transport)[0]);
    fireEvent.click(retry);
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    expect(sends(transport)[1]).toEqual(attempted);
    expect(sends(transport).every(request => request.command.command === 'input_submit' && request.command.params.target.item_id === '2')).toBe(true);
    await waitFor(() => expect(within(conversation()).queryByRole('button', { name: 'Try sending again' })).toBeNull());
    expect(selected(transport)).toBe('4');
  });

  it('keeps the opening divider anchored after the conversation dwell marks its item seen', async () => {
    const transport = await setup({ baseline: true }); await expand(); await switchQuestion();
    const divider = within(conversation()).getByTestId('new-divider');
    expect(divider.textContent).toMatch(/^New since you last looked at \d{1,2}:\d{2}/);
    const message = divider.closest('[data-message-id]')!;
    expect(message.getAttribute('data-message-id')).toBe('00000000-0000-4000-8000-000000000114');
    expect(transport.preferences.seen![0].items.some(item => item.item_id === '2')).toBe(false);
    await waitFor(() => expect(transport.preferences.seen![0].items).toContainEqual({
      item_id: '2', revision: transport.sessions.get(route.session_id)!.items['2']!.revision,
    }), { timeout: 3000 });
    expect(within(conversation()).getByTestId('new-divider')).toBe(divider);
    expect(divider.closest('[data-message-id]')).toBe(message);
    expect(selected(transport)).toBe('4');
  });

  it('draws the divider in the Details pane too, and keeps it through the dwell and a round trip to the bigger view (E13)', async () => {
    const transport = await setup({ baseline: true });
    fireEvent.click(row('2'));
    const pane = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    const divider = within(pane).getByTestId('new-divider');
    expect(divider.closest('[data-message-id]')!.getAttribute('data-message-id')).toBe('00000000-0000-4000-8000-000000000114');
    await waitFor(() => expect(transport.preferences.seen![0].items).toContainEqual({
      item_id: '2', revision: transport.sessions.get(route.session_id)!.items['2']!.revision,
    }), { timeout: 3000 });
    expect(within(pane).getByTestId('new-divider')).toBe(divider);
    await expand();
    const there = within(conversation()).getByTestId('new-divider');
    expect(there.closest('[data-message-id]')!.getAttribute('data-message-id')).toBe('00000000-0000-4000-8000-000000000114');
    expect(there.textContent).toBe(divider.textContent);
  });

  it('works out a new divider when an item is selected again after new messages came, not the one it had', async () => {
    const transport = await setup({ baseline: true });
    fireEvent.click(row('2'));
    let pane = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    expect(within(pane).getByTestId('new-divider').closest('[data-message-id]')!.getAttribute('data-message-id')).toBe('00000000-0000-4000-8000-000000000114');
    const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    await waitFor(() => expect(transport.preferences.seen![0].items).toContainEqual({ item_id: '2', revision: item.revision }), { timeout: 3000 });
    // Look at another item, and let the agent say something new about item 2 meanwhile.
    fireEvent.click(row('4'));
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
    const fresh = structuredClone(session.messages.find(message => message.id.endsWith('0115'))!);
    Object.assign(fresh, { id: '00000000-0000-4000-8000-000000000130', number: 30, body: 'A new thought.', created_at: '2026-10-03T12:05:00.000Z' });
    session.messages.push(fresh); item.updated_message_ids.push(fresh.id);
    item.revision += 1; item.updated_at = fresh.created_at; ++session.revision;
    // The apply receipts that date each agent message to an item revision (the divider needs them to tell what was read).
    const base = structuredClone(Object.values(session.operation_receipts).flat().find(value => value?.result.data.kind === 'apply' && value.result.data.item_revisions['2'] === 2)!);
    [['00000000-0000-4000-8000-000000000231', '00000000-0000-4000-8000-000000000114', 14, 2], ['00000000-0000-4000-8000-000000000230', fresh.id, fresh.number, item.revision]].forEach(([operation, id, number, revision]) => {
      const receipt = structuredClone(base);
      receipt.operation_id = receipt.result.operation_id = operation as string;
      if (receipt.result.data.kind === 'apply') {
        receipt.result.data.messages = [{ id: id as string, number: number as number }]; receipt.result.data.item_revisions = { '2': revision as number };
        receipt.result.data.allocated_refs = { reply: { kind: 'message', id: id as string } };
      }
      session.operation_receipts[receipt.operation_id] = [receipt];
    });
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    fireEvent.click(row('2'));
    pane = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
    await waitFor(() => expect(within(pane).getByTestId('new-divider').closest('[data-message-id]')!.getAttribute('data-message-id')).toBe(fresh.id));
  });

  // ⌥digit quick-send is gone (SPEC 6.1); the other fast send is Enter on a focused option card.
  it.each(['Command Enter', 'Enter on an option'])('sends only once during a held %s burst', async shortcut => {
    const transport = await setup(); await expand(); await switchQuestion();
    const words = answerWords(conversation());
    fireEvent.change(words, { target: { value: 'Exactly one answer' } });
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, requested = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { ++requested; await gate; }
      return invoke(name, args);
    });
    try {
      await act(async () => {
        if (shortcut === 'Command Enter') {
          key(words, 'Enter', { metaKey: true }); key(words, 'Enter', { metaKey: true }); key(words, 'Enter', { metaKey: true, repeat: true });
        } else {
          const card = conversation().querySelector<HTMLButtonElement>('[data-answer-option="0"]')!;
          card.focus();
          key(card, 'Enter'); key(card, 'Enter'); key(card, 'Enter', { repeat: true });
        }
      });
      await waitFor(() => expect(requested).toBe(1));
      await act(async () => { release(); });
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, text: 'Exactly one answer' } });
    } finally { await act(async () => { release(); }); }
  });

  it('keeps graph, history and archive keys away from the covered Map', async () => {
    const transport = await setup();
    fireEvent.click(row('3')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="3"]' });
    fireEvent.click(row('4')); await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
    await waitFor(() => expect(selected(transport)).toBe('4'));
    await expand(); await switchQuestion();
    const mutations = transport.mutations.length, reveals = transport.queries.filter(query => query.request.command === 'reveal_item').length;
    const tree = screen.getByRole('region', { name: 'Session tree', hidden: true });
    const scroller = tree.querySelector<HTMLElement>('.tree-scroll')!; scroller.scrollTop = 147;
    conversation().focus(); key(conversation(), 'g'); key(conversation(), 'e');
    key(conversation(), 'j', { metaKey: true });
    key(conversation(), 'x');
    key(conversation(), '[', { metaKey: true }); key(document.body, ']', { metaKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    // ⌘E is the one Map key that still works over the conversation (it opens the Recent list, SPEC 6.11): the list
    // opens, closes with Escape, and leaves the conversation and the Map selection alone.
    key(conversation(), 'e', { metaKey: true });
    const recent = await screen.findByRole('dialog', { name: 'Recent items' });
    key(recent, 'Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(conversation()).toBeTruthy();
    // ⌫ and Delete stay with the Map's selected row: over the conversation they ask nothing about the covered item.
    key(conversation(), 'Backspace'); key(conversation(), 'Delete');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selected(transport)).toBe('4');
    expect(scroller.scrollTop).toBe(147);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(transport.mutations.slice(mutations).some(request => request.command.command === 'item_remove'
      || request.command.command === 'preferences_patch' && request.command.params.entries.some(entry => entry.kind === 'set_session_view' || entry.kind === 'set_later'))).toBe(false);
    expect(conversation().querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id')).toBe('2');
    expect(transport.queries.filter(query => query.request.command === 'reveal_item')).toHaveLength(reveals);
    expect(transport.mutations.slice(mutations).some(request => request.command.command === 'topic_archive')).toBe(false);
    key(conversation(), 'Escape');
    expect(screen.getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: 'Session tree' })).toBeTruthy();
  });

  it('keeps the covered detail column mounted at its width after the Map selection is removed', async () => {
    const transport = await setup(); await expand(); await switchQuestion();
    const map = document.querySelector('.shell-center')!, aside = document.querySelector('.shell-detail')!;
    const grid = document.querySelector<HTMLElement>('.shell-body')!.style.gridTemplateColumns;
    const placeholder = aside.querySelector('[data-covered-detail]')!;
    const session = transport.sessions.get(route.session_id)!;
    delete session.items['4']; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await waitFor(() => expect(row('4')).toBeNull());
    expect(document.querySelector('.shell-center')).toBe(map);
    expect(document.querySelector('.shell-detail')).toBe(aside);
    expect(aside.querySelector('[data-covered-detail]')).toBe(placeholder);
    expect(document.querySelector<HTMLElement>('.shell-body')!.style.gridTemplateColumns).toBe(grid);
    expect(conversation()).toBeTruthy();
  });

  it.each(['b', 'd', 'o'])('keeps %s item actions on the conversation target without moving the Map', async shortcut => {
    const transport = await setup(); await expand(); await switchQuestion('8');
    const session = transport.sessions.get(route.session_id)!, item = session.items['8']!;
    item.status = shortcut === 'o' ? 'done' : 'open';
    session.rounds[item.current_round_id!]!.closed_at = session.updated_at; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await within(conversation()).findByRole('group', { name: 'Item actions' });
    // The bigger view carries the same actions as the pane (SPEC 5.3): Later is one of the six.
    expect(within(conversation()).queryByRole('button', { name: /^(Later|Unpark)/ })).not.toBeNull();
    const map = document.querySelector<HTMLElement>('.tree-scroll')!; map.scrollTop = 143;
    const mapRow = row('4'), reveals = transport.queries.filter(query => query.request.command === 'reveal_item').length;
    key(conversation(), shortcut);
    if (shortcut === 'b') {
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'bring', target: { item_id: '8' } } });
    } else if (shortcut === 'd') await within(conversation()).findByLabelText('Drop reason');
    else await waitFor(() => expect(sends(transport)).toHaveLength(1));
    if (shortcut === 'o') expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'reopen', target: { item_id: '8' } } });
    expect(map.scrollTop).toBe(143); expect(row('4')).toBe(mapRow); expect(selected(transport)).toBe('4');
    expect(transport.queries.filter(query => query.request.command === 'reveal_item')).toHaveLength(reveals);
  });

  it('sends quick replies only to the view while the covered waiting question gets no send', async () => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    fireEvent.click(conversation().querySelector('[data-answer-option="1"]')!);
    fireEvent.click(within(conversation().querySelector<HTMLElement>('.answer')!).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: 'choice-2' } });
    expect(selected(transport)).toBe('4');
  });

  it('keeps a covered waiting question preview free of answer actions until Go to closes the view', async () => {
    const transport = await setup({ coveredWaiting: true }); await expand(); await switchQuestion();
    fireEvent.click(within(conversation()).getByRole('button', { name: /^Record retry limits ·/ }));
    const peek = await screen.findByRole('dialog', { name: 'Peek: Record retry limits' });
    expect(within(peek).queryByRole('region', { name: 'Answer question' })).toBeNull();
    expect(within(peek).queryByLabelText('One-line answer')).toBeNull();
    expect(sends(transport)).toHaveLength(0);
    fireEvent.click(within(peek).getByRole('button', { name: 'Go to' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull());
    await within(detail('4')).findByRole('group', { name: 'Answer' });
    expect(sends(transport)).toHaveLength(0);
  });

  it('puts back only the view text while the covered waiting question gets no draft or send', async () => {
    const transport = await setup({ coveredWaiting: true, cancelledReplies: true });
    expect(within(detail('4')).getByRole('group', { name: 'Answer' })).toBeTruthy();
    await expand(); await switchQuestion();
    expect(document.querySelector('.shell-detail [data-owner-input]')).toBeNull();
    // The dock lists the covered question 4 but no one opened it there.
    fireEvent.click(within(dock()).getByRole('button', { name: 'Fold the dock' }));
    expect(dock().querySelector('[data-owner-input="4"]')).toBeNull();
    const cancelled = conversation().querySelector('[data-message-id="cancelled-message-2"]')!;
    fireEvent.click(within(cancelled as HTMLElement).getByRole('button', { name: 'Put back in reply box' }));
    await waitFor(() => expect(transport.preferences.drafts).toContainEqual(expect.objectContaining({ text: 'Kept words for 2', target: expect.objectContaining({ item_id: '2' }) })));
    const session = transport.sessions.get(route.session_id)!;
    session.items['2']!.status = 'open'; session.rounds[session.items['2']!.current_round_id!]!.closed_at = session.updated_at; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    const words = await within(conversation()).findByLabelText<HTMLTextAreaElement>('Reply message');
    await waitFor(() => expect(words.value).toBe('Kept words for 2'));
    expect(sends(transport)).toHaveLength(0);
    key(words, 'Enter', { metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { target: { item_id: '2' }, text: 'Kept words for 2' } });
    expect(transport.preferences.drafts.filter(draft => draft.target.item_id === '4')).toHaveLength(0);
    expect(selected(transport)).toBe('4');
  });

  it('keeps a typed Drop reason through expansion, a Waiting switch and Back to Map', async () => {
    const transport = await setup({ dropReady: true });
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    const reason = ' Keep the exact reason: café · remove the old window ';
    fireEvent.change(within(detail('4')).getByLabelText('Drop reason'), { target: { value: reason } });
    const kept = within(detail('4')).getByLabelText<HTMLInputElement>('Drop reason').value;
    expect(kept).toBe(reason);
    await expand();
    expect(within(conversation()).queryByLabelText('Drop reason')).toBeNull();
    fireEvent.click(within(conversation()).getByRole('button', { name: /^Drop/ }));
    expect(within(conversation()).getByLabelText<HTMLInputElement>('Drop reason').value).toBe(kept);
    await switchQuestion();
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    expect(within(detail('4')).queryByLabelText('Drop reason')).toBeNull();
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    expect(within(detail('4')).getByLabelText<HTMLInputElement>('Drop reason').value).toBe(kept);
    expect(sends(transport)).toHaveLength(0); expect(selected(transport)).toBe('4');
    const session = transport.sessions.get(route.session_id)!;
    const pending = Object.values(session.inputs).find(input => input?.target.item_id === '4' && input.kind === 'drop')!;
    pending.state = 'queued'; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await waitFor(() => expect(within(detail('4')).queryByLabelText('Drop reason')).toBeNull());
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.intent === 'drop'
      && draft.text === `Let’s drop this (${reason}): Record retry limits`)).toBe(true));
    pending.state = 'handled'; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    expect(within(detail('4')).queryByLabelText('Drop reason')).toBeNull();
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    expect((await within(detail('4')).findByLabelText<HTMLInputElement>('Drop reason')).value).toBe(reason);
    expect(sends(transport)).toHaveLength(0);
  });

  it('keeps an editable saved Drop message when the question changes and requires review before sending', async () => {
    const transport = await setup({ dropReady: true });
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    fireEvent.change(within(detail('4')).getByLabelText('Drop reason'), { target: { value: 'Original raw reason' } });
    const session = transport.sessions.get(route.session_id)!, item = session.items['4']!;
    item.question = 'Record revised retry limits'; ++item.revision; ++item.question_revision; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await within(detail('4')).findByText('This item changed. Review the current question and options; your text is retained.');
    expect(within(detail('4')).getByRole<HTMLButtonElement>('button', { name: 'Drop item' }).disabled).toBe(true);
    const message = 'Please drop the revised retry limits. Keep these exact words: café\nsecond line';
    const saved = within(detail('4')).getByLabelText<HTMLTextAreaElement>('Saved drop message');
    expect(saved.value).toBe('Let’s drop this (Original raw reason): Record retry limits');
    expect(saved.readOnly).toBe(false);
    fireEvent.change(saved, { target: { value: message } });
    fireEvent.click(within(detail('4')).getByRole('button', { name: 'Drop item' }));
    expect(sends(transport)).toHaveLength(0);
    await expand();
    fireEvent.click(within(conversation()).getByRole('button', { name: /^Drop/ }));
    expect(within(conversation()).getByLabelText<HTMLTextAreaElement>('Saved drop message').value).toBe(message);
    expect(within(conversation()).getByLabelText<HTMLTextAreaElement>('Saved drop message').readOnly).toBe(false);
    expect(within(conversation()).getByRole<HTMLButtonElement>('button', { name: 'Drop item' }).disabled).toBe(true);
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.intent === 'drop' && draft.text === message)).toBe(true));
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Review this question' }));
    await waitFor(() => expect(within(conversation()).getByRole<HTMLButtonElement>('button', { name: 'Drop item' }).disabled).toBe(false));
    expect(within(conversation()).queryByText('This item changed. Review the current question and options; your text is retained.')).toBeNull();
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Drop item' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { kind: 'drop', target: { item_id: '4' },
      text: message } });
    await waitFor(() => expect(within(conversation()).queryByLabelText('Drop reason')).toBeNull());
    expect(within(conversation()).queryByLabelText('Saved drop message')).toBeNull();
  });

  it('keeps an uncertain Drop submission read-only across surfaces and retries the original operation exactly', async () => {
    const transport = await setup({ dropReady: true });
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    fireEvent.change(within(detail('4')).getByLabelText('Drop reason'), { target: { value: ' Keep retry words: café ' } });
    await expand(); fireEvent.click(within(conversation()).getByRole('button', { name: /^Drop/ })); transport.failNext = 'input_submit';
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Drop item' }));
    const saved = await within(conversation()).findByLabelText<HTMLTextAreaElement>('Saved drop message');
    const expected = 'Let’s drop this (Keep retry words: café): Record retry limits';
    expect(saved.value).toBe(expected); expect(saved.readOnly).toBe(true);
    expect(within(conversation()).queryByLabelText('Drop reason')).toBeNull();
    expect(sends(transport)).toHaveLength(1);
    const attempted = structuredClone(sends(transport)[0]);
    expect(attempted.command).toMatchObject({ params: { kind: 'drop', target: { item_id: '4' }, text: expected } });
    await switchQuestion();
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    const kept = within(detail('4')).getByLabelText<HTMLTextAreaElement>('Saved drop message');
    expect(kept.value).toBe(expected); expect(kept.readOnly).toBe(true);
    await expand();
    expect(within(conversation()).getByLabelText<HTMLTextAreaElement>('Saved drop message').value).toBe(expected);
    expect(sends(transport)).toHaveLength(1);
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Try sending again' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    expect(sends(transport)[1]).toEqual(attempted);
    expect(new Set(sends(transport).map(request => request.command.op_id)).size).toBe(1);
    await waitFor(() => expect(within(conversation()).queryByRole('button', { name: 'Try sending again' })).toBeNull());
    expect(within(conversation()).queryByLabelText('Saved drop message')).toBeNull();
    expect(within(conversation()).queryByLabelText('Drop reason')).toBeNull();
    expect(selected(transport)).toBe('4');
  });

  it('sends the stored Drop message once after a pre-submit session read failure without nesting the envelope', async () => {
    const transport = await setup({ dropReady: true });
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    const reason = ' Keep this whitespace and café ';
    const expected = 'Let’s drop this ( Keep this whitespace and café ): Record retry limits';
    fireEvent.change(within(detail('4')).getByLabelText('Drop reason'), { target: { value: reason } });
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.intent === 'drop' && draft.text === expected)).toBe(true));
    const operation = transport.preferences.drafts.find(draft => draft.intent === 'drop')!.op_id;
    await expand();
    fireEvent.click(within(conversation()).getByRole('button', { name: /^Drop/ }));
    const invoke = transport.invoke.bind(transport);
    let failRead = true;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (failRead && 'request' in args.request && args.request.request.command === 'session_get'
        && args.request.session?.session_id === route.session_id) {
        failRead = false;
        return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Session read temporarily failed.', hint: '', retryable: true, field_errors: [] } };
      }
      return invoke(name, args);
    });
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Drop item' }));
    await within(conversation()).findAllByText('Ariadne couldn’t read or save its data. Try again.');
    expect(sends(transport)).toHaveLength(0);
    expect(within(conversation()).getByLabelText<HTMLInputElement>('Drop reason').value).toBe(reason.trim());
    expect(within(conversation()).queryByLabelText('Saved drop message')).toBeNull();
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Back to Map' }));
    expect(within(detail('4')).queryByLabelText('Drop reason')).toBeNull();
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    expect(within(detail('4')).getByLabelText<HTMLInputElement>('Drop reason').value).toBe(reason.trim());
    await expand();
    fireEvent.click(within(conversation()).getByRole('button', { name: /^Drop/ }));
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Drop item' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ op_id: operation, params: { kind: 'drop', target: { item_id: '4' }, text: 'Let’s drop this (Keep this whitespace and café): Record retry limits' } });
    await waitFor(() => expect(within(conversation()).queryByLabelText('Drop reason')).toBeNull());
  });

  it('recovers a definitively rejected Drop through an editable revised operation and a fresh review', async () => {
    const transport = await setup({ dropReady: true });
    fireEvent.click(within(detail('4')).getByRole('button', { name: /^Drop/ }));
    fireEvent.change(within(detail('4')).getByLabelText('Drop reason'), { target: { value: ' Original rejected words ' } });
    await expand();
    fireEvent.click(within(conversation()).getByRole('button', { name: /^Drop/ }));
    const invoke = transport.invoke.bind(transport);
    let reject = true;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if (reject && 'command' in request && request.command.command === 'input_submit') {
        reject = false; transport.mutations.push(structuredClone(request));
        return { api_version: 1, ok: false, error: { code: 'queue_full', message: 'Queue full.', hint: '', retryable: true, field_errors: [] } };
      }
      return invoke(name, args);
    });
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Drop item' }));
    const revise = await within(conversation()).findByRole('button', { name: 'Edit and send again' });
    expect(sends(transport)).toHaveLength(1);
    const original = structuredClone(sends(transport)[0]);
    expect(within(conversation()).getByLabelText<HTMLTextAreaElement>('Saved drop message').value)
      .toBe('Let’s drop this (Original rejected words): Record retry limits');
    expect(within(conversation()).getByLabelText<HTMLTextAreaElement>('Saved drop message').readOnly).toBe(true);
    fireEvent.click(revise);
    const reason = await within(conversation()).findByLabelText<HTMLInputElement>('Drop reason');
    await waitFor(() => expect(reason.disabled).toBe(false));
    expect(reason.value).toBe('Original rejected words');
    expect(within(conversation()).getByRole<HTMLButtonElement>('button', { name: 'Drop item' }).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: ' Revised words: café ' } });
    expect(sends(transport)).toHaveLength(1);
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Review this question' }));
    await waitFor(() => expect(within(conversation()).getByRole<HTMLButtonElement>('button', { name: 'Drop item' }).disabled).toBe(false));
    fireEvent.click(within(conversation()).getByRole('button', { name: 'Drop item' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    expect(sends(transport)[1].command.op_id).not.toBe(original.command.op_id);
    expect(sends(transport)[1].command).toMatchObject({ params: { kind: 'drop', target: { item_id: '4' },
      text: 'Let’s drop this (Revised words: café): Record retry limits' } });
    expect(original.command).toMatchObject({ params: { text: 'Let’s drop this (Original rejected words): Record retry limits' } });
    await waitFor(() => expect(within(conversation()).queryByLabelText('Drop reason')).toBeNull());
    expect(within(conversation()).queryByRole('button', { name: 'Try sending again' })).toBeNull();
    expect(selected(transport)).toBe('4');
  });
});
