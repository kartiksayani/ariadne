// The window's owner rules over every trigger that broke them in alpha.19's review: never lose typed text, never send
// twice, never miss a question, never dead-end the owner. Each table runs one trigger matrix through the whole app.
//
// | Finding | Trigger matrix                                                        | Must hold                                                    |
// |---------|-----------------------------------------------------------------------|--------------------------------------------------------------|
// | 1       | (Cancel message, Mark as done) × (Details, dock) on a failed answer   | answerable again, in the dock, words and choice kept, 1 send |
// | 2       | Details (folded, open) × (answering it, not) × dock (open, folded)    | the waiting question is in view; folded never "in Details"   |
// | 3       | a revision of the dock's question × (typing in the dock, idle)        | same item; text, field and focus kept; review asked if typed |
// | 4       | ⌘↵ twice after a Details keyboard send, dock ready on another question| exactly one send, the Details one                            |
// | 5       | (Stop waiting received, Mark as done never received / received before | words and choice kept; a copy the agent may have had goes    |
// |         | a retry / uncertain with and without a host turn) × (Details, dock);  | again only after "Send again?" (not a double-click's second  |
// |         | then a double-click, a held ↵, Esc; changed words or choice           | click, not a held ↵); never received or changed: at once     |
// | 6       | an idle 1–9 in the open dock, then (⌘↵, ↵, focus to <body> + ⌘↵,      | the picked option sends once from the dock's focus; never    |
// |         | focus on a Map row + ⌘↵)                                              | with the focus outside the dock                              |
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { changedText } from '../../../src/ui/detail/AnswerSlot';
import type { Item, PresenceObservation, Session } from '../../../src/generated/domain/models';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import { AppTransport, route } from './transport';
import { answerWords } from '../answer/words';

afterEach(() => { cleanup(); notices.clear(); localStorage.clear(); });

const question = 'Which delivery window?';
const failedId = '00000000-0000-4000-8000-000000000074';
const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
const dock = () => screen.getByRole('region', { name: 'Answer dock' });
const current = () => dock().querySelector<HTMLElement>('.answer-dock-current');
const detailSlot = (id: string) => document.querySelector<HTMLElement>(`[data-detail-item-id="${id}"] .detail-answer-slot`);
const treeRow = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`)!;
const option = (scope: HTMLElement, index: number) => scope.querySelector<HTMLButtonElement>(`[data-answer-option="${index}"]`);
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
const changed = (transport: AppTransport, session: Session) => {
  session.revision++;
  act(() => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
};
const choices = (prefix: string): Item['options'] => [
  { id: `${prefix}-1`, label: `${prefix} first`, consequence: 'The first way.', recommended: true },
  { id: `${prefix}-2`, label: `${prefix} second`, consequence: 'The second way.', recommended: false },
];

/** The demo session with item 2 waiting (two options); `second` also makes item 8 wait, asked a second earlier. */
async function mount(second = false) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const item = session.items['2']!;
  item.options = choices('window');
  session.rounds[item.current_round_id!]!.options_snapshot = structuredClone(item.options);
  if (second) {
    const other = session.items['8']!;
    Object.assign(other, { status: 'waiting_on_me', waiting_since: '2026-10-03T12:00:00.000Z', options: choices('route'), recipient_binding_id: session.active_binding_id });
    Object.assign(session.rounds[other.current_round_id!]!, { closed_at: null, options_snapshot: structuredClone(other.options) });
  }
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0]!, { tab_open: true });
  render(<DesktopApp service={createDesktopService(transport)} />);
  const tree = await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => expect(tree.getAttribute('aria-busy')).toBe('false'));
  await within(dock()).findByRole('button', { name: second ? /^2 waiting$/ : /^1 waiting$/ });
  return { transport, session };
}
async function openDock() {
  if (!current()) fireEvent.click(await within(dock()).findByRole('button', { name: /waiting$/ }));
  await waitFor(() => expect(current()).not.toBeNull());
}
const ready = (scope: () => HTMLElement | null) => waitFor(() => {
  const own = scope()?.querySelector<HTMLButtonElement>('[data-answer-own]');
  expect(own && !own.disabled).toBe(true);
});

describe('finding 1: a cancelled or skipped answer reopens its question', () => {
  const buttons = [['Cancel message', 'cancelled'], ['Mark as done', 'skipped']] as const;
  const places = ['Details', 'dock'] as const;
  it.each(places.flatMap(place => buttons.map(([button, state]) => [button, place, state] as const)))(
    '%s in %s: answerable again, back in the dock, the words and choice kept, and sent once more only', async (button, place, state) => {
      const { transport, session } = await mount();
      const note = 'Keep these words: café\nsecond line';
      let scope: () => HTMLElement | null;
      if (place === 'Details') {
        fireEvent.click(treeRow('2'));
        scope = () => detailSlot('2');
      } else {
        await openDock();
        scope = current;
      }
      await ready(scope);
      fireEvent.click(option(scope()!, 1)!);
      fireEvent.change(answerWords(scope()!), { target: { value: note } });
      await waitFor(() => expect(within(scope()!).getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(within(scope()!).getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sends(transport)).toHaveLength(1));
      // The delivery stops before the agent had it.
      const input = Object.values(session.inputs).find(value => value?.kind === 'answer' && value.target.item_id === '2' && value.payload.text === note)!;
      const template = session.inputs[failedId]!, attempt = structuredClone(template.attempts.find(value => value.id === template.active_attempt_id)!);
      Object.assign(attempt, { acceptance: 'rejected', error: null });
      Object.assign(input, { state: 'needs_attention', attempts: [attempt], active_attempt_id: attempt.id });
      changed(transport, session);
      // The agent is idle, so stopping the delivery needs no extra proof.
      const binding = session.bindings[session.active_binding_id!]!;
      const observation = { ...structuredClone(sessionsFixture.items[0].active_binding.presence), execution_state: 'idle',
        generation: binding.generation, last_seen_at: '2026-10-03T12:01:00.000Z' } as PresenceObservation;
      await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation }); });
      if (place === 'dock') await openDock();
      const stuck = await waitFor(() => { const found = scope()?.querySelector<HTMLElement>('.stuck-note'); expect(found).toBeTruthy(); return found!; });
      await waitFor(() => expect(within(stuck).getByRole('button', { name: button }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(within(stuck).getByRole('button', { name: button }));
      await waitFor(() => expect(session.inputs[input.id]?.state).toBe(state));
      // Answerable again: open cards with the owner's words and choice, nothing sealed as sent.
      await waitFor(() => expect(scope()?.querySelector('[data-answer-send]')).toBeTruthy());
      expect(scope()!.textContent).not.toMatch(/Picked up|Sent at|Already sent/);
      await waitFor(() => expect(option(scope()!, 1)?.getAttribute('aria-pressed')).toBe('true'));
      expect(answerWords(scope()!).value).toBe(note);
      // In the dock and its count once Details lets it go.
      if (place === 'Details') fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
      await openDock();
      expect(dock().querySelector('.dock-question-title')?.textContent).toBe(question);
      await waitFor(() => expect(answerWords(current()!).value).toBe(note));
      await waitFor(() => expect(within(current()!).getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(within(current()!).getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sends(transport)).toHaveLength(2));
      await flush();
      expect(sends(transport)).toHaveLength(2);
      expect(sends(transport)[1]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: 'window-2', text: note } });
    });
});

describe('finding 2: a folded Details never claims the question', () => {
  const cases = ([true, false] as const).flatMap(folded => ([true, false] as const).flatMap(answering =>
    (['open', 'folded'] as const).map(dockState => [folded ? 'folded' : 'open', answering ? 'answering it' : 'on another item', dockState] as const)));
  it.each(cases)('Details %s, %s, dock %s: the waiting question is in view', async (details, answering, dockState) => {
    await mount();
    fireEvent.click(treeRow('4'));
    await waitFor(() => expect(document.querySelector('[data-detail-item-id="4"]')).not.toBeNull());
    if (dockState === 'open') await openDock();
    if (answering === 'answering it') {
      fireEvent.click(treeRow('2'));
      await waitFor(() => expect(document.querySelector('[data-detail-item-id="2"]')).not.toBeNull());
    }
    if (details === 'folded') fireEvent.click(screen.getByRole('button', { name: 'Fold Details' }));
    await flush();
    const inDetails = details === 'open' && answering === 'answering it' && !!detailSlot('2');
    const pill = dock().querySelector('.dock-pill')?.textContent ?? '', line = dock().querySelector('.dock-line-text')?.textContent;
    const inDock = /waiting$/.test(pill) && line === question || dock().querySelector('.dock-question-title')?.textContent === question;
    expect(inDetails || inDock).toBe(true);
    if (details === 'folded') expect(dock().textContent).not.toMatch(/in Details/);
  });
});

describe('finding 3: a revision of the open question keeps the dock on it', () => {
  it.each(['typing in the dock', 'idle'] as const)('%s: same item, text and field kept, review asked only for words that predate it', async mode => {
    const { transport, session } = await mount(true);
    await openDock();
    fireEvent.click(within(dock()).getByRole('button', { name: 'Next question' }));
    await waitFor(() => expect(dock().querySelector('.dock-question-title')?.textContent).toBe(question));
    await ready(current);
    const words = 'Halfway through my answer';
    let box: HTMLTextAreaElement | null = null;
    if (mode === 'typing in the dock') {
      box = answerWords(current()!);
      box.focus();
      fireEvent.change(box, { target: { value: words } });
      await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.text === words)).toBe(true));
    } else treeRow('4').focus();
    const focused = document.activeElement;
    const item = session.items['2']!, revised = 'Which delivery window, given the new rota?';
    item.question = revised; item.question_revision++; item.revision++;
    session.rounds[item.current_round_id!]!.question_revision = item.question_revision;
    session.rounds[item.current_round_id!]!.question_snapshot = revised;
    changed(transport, session);
    await waitFor(() => expect(dock().querySelector('.dock-question-title')?.textContent).toBe(revised));
    await flush();
    expect(dock().querySelector('.dock-question-title')?.textContent).toBe(revised);
    expect(sends(transport)).toHaveLength(0);
    if (mode === 'typing in the dock') {
      // The same field, still in the page and focused, with the words; Send waits for the review.
      expect(box!.isConnected).toBe(true);
      expect(answerWords(current()!)).toBe(box);
      expect(box!.value).toBe(words);
      expect(document.activeElement).toBe(box);
      expect(within(dock()).getByText(changedText)).toBeTruthy();
      // The field locks for the review, and a browser drops its focus to <body> (jsdom keeps it, so the key is sent to
      // <body> directly): the next key is the owner's, never a Map key. A Map key would move the focus to the tree.
      expect(box!.disabled).toBe(true);
      fireEvent.keyDown(document.body, { key: 'j' });
      expect(document.activeElement).toBe(box);
      expect(box!.value).toBe(words);
    } else {
      expect(within(dock()).queryByText(changedText)).toBeNull();
      expect(document.activeElement).toBe(focused);
      await ready(current);
    }
  });
});

describe('finding 4: ⌘↵ after a Details send never sends the dock’s question', () => {
  it('⌘↵ twice after a Details keyboard send with a ready dock choice on another question: one send, the Details one', async () => {
    const { transport } = await mount(true);
    fireEvent.click(treeRow('2'));
    await ready(() => detailSlot('2'));
    await openDock();
    await waitFor(() => expect(dock().querySelector('.dock-question-title')?.textContent).not.toBe(question));
    await ready(current);
    fireEvent.click(option(current()!, 0)!);
    await waitFor(() => expect(current()!.querySelector<HTMLButtonElement>('[data-answer-send]')?.disabled).toBe(false));
    const box = answerWords(detailSlot('2')!), words = 'Send this from Details';
    box.focus();
    fireEvent.change(box, { target: { value: words } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    // The send locks the Details field; a browser drops its focus to <body>, where the second ⌘↵ lands.
    act(() => { box.blur(); });
    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    await flush();
    expect(sends(transport)).toHaveLength(1);
    expect(sends(transport)[0]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, text: words } });
    // ⌘↵ with the focus in the dock still sends the dock's choice, so the check above is not vacuous.
    const grip = within(dock()).getByRole('separator', { name: 'Resize answer dock' });
    grip.focus();
    fireEvent.keyDown(grip, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    expect(sends(transport)[1]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '8' }, selected_option_id: 'route-1' } });
  });
});

describe('finding 5: a refill of an answer the agent already had never goes twice without asking', () => {
  const delivered = { acceptance: 'accepted', host_turn_id: 'turn-1', turn_state: 'completed', result_state: 'missing',
    error: { code: 'result_missing', reason: 'No answer saved.', retryable: false, observed_at: '2026-10-03T12:01:00.000Z' } } as const;
  const refused = { acceptance: 'rejected', error: null } as const;
  // Uncertain: "Checking whether it was delivered" with a host turn, "Couldn't deliver" without one. Either may have reached it.
  const checking = { acceptance: 'uncertain', host_turn_id: 'turn-1' } as const;
  const unsure = { acceptance: 'uncertain', host_turn_id: null } as const;
  type Attempts = readonly (typeof delivered | typeof refused | typeof checking | typeof unsure)[];
  const note = 'Keep these words: café';
  const dialog = () => screen.queryByRole('dialog', { name: 'Send again?' });
  const send = (scope: () => HTMLElement | null) => within(scope()!).getByRole('button', { name: 'Send' });

  /** Sends option 2 with `note` from `place`, stops its delivery with `attempts`, then presses `button` on its stuck note. */
  async function settled(place: 'Details' | 'dock', button: string, attempts: Attempts) {
    const { transport, session } = await mount();
    let scope: () => HTMLElement | null;
    if (place === 'Details') {
      fireEvent.click(treeRow('2'));
      scope = () => detailSlot('2');
    } else {
      await openDock();
      scope = current;
    }
    await ready(scope);
    fireEvent.click(option(scope()!, 1)!);
    fireEvent.change(answerWords(scope()!), { target: { value: note } });
    await waitFor(() => expect(send(scope).hasAttribute('disabled')).toBe(false));
    fireEvent.click(send(scope));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    const input = Object.values(session.inputs).find(value => value?.kind === 'answer' && value.target.item_id === '2' && value.payload.text === note)!;
    const template = session.inputs[failedId]!, base = template.attempts.find(value => value.id === template.active_attempt_id)!;
    const made = attempts.map((change, at) => Object.assign(structuredClone(base), change,
      { id: `00000000-0000-4000-8000-0000000009${at}0`, sealed_at: at < attempts.length - 1 ? '2026-10-03T12:00:50.000Z' : null }));
    Object.assign(input, { state: 'needs_attention', attempts: made, active_attempt_id: made.at(-1)!.id });
    changed(transport, session);
    const binding = session.bindings[session.active_binding_id!]!;
    const observation = { ...structuredClone(sessionsFixture.items[0].active_binding.presence), execution_state: 'idle',
      generation: binding.generation, last_seen_at: '2026-10-03T12:01:00.000Z' } as PresenceObservation;
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation }); });
    // A stopped answer is settled where its message shows: Details' conversation, or its row on the Map.
    const where = place === 'Details' ? '[data-detail-item-id="2"]' : '[role="tree"]';
    const stuck = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`${where} [data-stuck-input="${input.id}"]`); expect(found).toBeTruthy(); return found!;
    });
    await waitFor(() => expect(within(stuck).getByRole('button', { name: button }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(stuck).getByRole('button', { name: button }));
    await waitFor(() => expect(session.inputs[input.id]?.state).toBe('skipped'));
    if (place === 'dock') await openDock();
    // The words and the choice stay recoverable in the reopened cards, in every case.
    await waitFor(() => expect(option(scope()!, 1)?.getAttribute('aria-pressed')).toBe('true'));
    expect(answerWords(scope()!).value).toBe(note);
    await waitFor(() => expect(send(scope).hasAttribute('disabled')).toBe(false));
    return { transport, scope };
  }

  const cases = [
    ['Stop waiting', 'received', [delivered]],
    ['Mark as done', 'never received', [refused]],
    ['Mark as done', 'received before a retry', [delivered, refused]],
    ['Mark as done', 'uncertain, with a host turn', [checking]],
    ['Mark as done', 'uncertain, no host turn', [unsure]],
  ] as const;
  const places = ['Details', 'dock'] as const;
  it.each(places.flatMap(place => cases.map(([button, label, attempts]) => [button, label, place, attempts] as const)))(
    '%s (%s) in %s: words and choice kept; a copy the agent may have had asks "Send again?" first', async (button, label, place, attempts) => {
      const { transport, scope } = await settled(place, button, attempts);
      // A double-click on Send: its second click lands on the overlay of the dialog the first one opened.
      fireEvent.click(send(scope), { detail: 1 });
      if (label !== 'never received') {
        await waitFor(() => expect(dialog()).not.toBeNull());
        fireEvent.click(document.querySelector('.pw-overlay')!, { detail: 2 });
        await flush();
        expect(dialog()).not.toBeNull();
        expect(sends(transport)).toHaveLength(1);
        // Cancel keeps everything as it was.
        fireEvent.click(within(dialog()!).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(dialog()).toBeNull());
        await flush();
        expect(sends(transport)).toHaveLength(1);
        expect(answerWords(scope()!).value).toBe(note);
        expect(option(scope()!, 1)?.getAttribute('aria-pressed')).toBe('true');
        // ⌘↵ asks the same way. A held ↵ repeating onto the dialog confirms nothing; Esc cancels.
        fireEvent.keyDown(option(scope()!, 1)!, { key: 'Enter', metaKey: true });
        await waitFor(() => expect(dialog()).not.toBeNull());
        fireEvent.keyDown(dialog()!, { key: 'Enter', repeat: true });
        fireEvent.keyDown(dialog()!, { key: 'Enter', repeat: true });
        await flush();
        expect(sends(transport)).toHaveLength(1);
        expect(dialog()).not.toBeNull();
        fireEvent.keyDown(dialog()!, { key: 'Escape' });
        await waitFor(() => expect(dialog()).toBeNull());
        expect(sends(transport)).toHaveLength(1);
        // Only the dialog's own confirmation sends: a fresh ↵ on it, or its "Send again" button.
        fireEvent.keyDown(option(scope()!, 1)!, { key: 'Enter', metaKey: true });
        await waitFor(() => expect(dialog()).not.toBeNull());
        if (place === 'Details') fireEvent.keyDown(dialog()!, { key: 'Enter' });
        else fireEvent.click(within(dialog()!).getByRole('button', { name: 'Send again' }));
      } else expect(dialog()).toBeNull();
      await waitFor(() => expect(sends(transport)).toHaveLength(2));
      await flush();
      expect(sends(transport)).toHaveLength(2);
      expect(dialog()).toBeNull();
      expect(sends(transport)[1]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: 'window-2', text: note } });
    });

  it.each(['the words', 'the choice'] as const)('received, then %s changed: a different answer sends at once, once', async change => {
    const { transport, scope } = await settled('dock', 'Stop waiting', [delivered]);
    const words = change === 'the words' ? `${note}, and one more thing` : note;
    if (change === 'the words') fireEvent.change(answerWords(scope()!), { target: { value: words } });
    else fireEvent.click(option(scope()!, 0)!);
    await waitFor(() => expect(change === 'the words' ? answerWords(scope()!).value : option(scope()!, 0)?.getAttribute('aria-pressed')).toBe(change === 'the words' ? words : 'true'));
    await waitFor(() => expect(send(scope).hasAttribute('disabled')).toBe(false));
    fireEvent.click(send(scope));
    await waitFor(() => expect(sends(transport)).toHaveLength(2));
    await flush();
    expect(dialog()).toBeNull();
    expect(sends(transport)).toHaveLength(2);
    expect(sends(transport)[1]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' },
      selected_option_id: change === 'the choice' ? 'window-1' : 'window-2', text: words } });
  });
});

describe('finding 6: an idle 1–9 in the dock leaves the focus on the picked option', () => {
  const cases = [['⌘↵', 1], ['↵', 1], ['focus to <body>, then ⌘↵', 0], ['focus on a Map row, then ⌘↵', 0]] as const;
  it.each(cases)('a digit, then %s: %i send(s) of the picked option', async (then, count) => {
    const { transport } = await mount();
    await openDock();
    await ready(current);
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(option(current()!, 1)?.getAttribute('aria-pressed')).toBe('true'));
    expect(document.activeElement).toBe(option(current()!, 1));
    if (then === '⌘↵') fireEvent.keyDown(document.activeElement!, { key: 'Enter', metaKey: true });
    else if (then === '↵') fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    else {
      if (then === 'focus to <body>, then ⌘↵') act(() => { (document.activeElement as HTMLElement).blur(); });
      else act(() => { treeRow('4').focus(); });
      fireEvent.keyDown(document.activeElement!, { key: 'Enter', metaKey: true });
    }
    if (count) await waitFor(() => expect(sends(transport)).toHaveLength(count));
    await flush();
    expect(sends(transport)).toHaveLength(count);
    if (count) expect(sends(transport)[0]!.command).toMatchObject({ params: { kind: 'answer', target: { item_id: '2' }, selected_option_id: 'window-2' } });
  });
});
