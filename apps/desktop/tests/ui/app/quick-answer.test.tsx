import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from './transport';
import { goToSession } from './open';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { PresenceObservation } from '../../../src/generated/domain/models';
import { answerWords } from '../answer/words';
import { closeDetails } from '../shell/closeDetails';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
const row = () => document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
const detail = () => screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
// ⌥1–9 choose and send option N of the selected waiting question (alpha.24, as in alpha.18); ⌥0 stays unbound. macOS types ¡™£ for them.
const alt = (target: Element, digit: number, repeat = false) => fireEvent.keyDown(target, {
  key: digit === 1 ? '¡' : digit === 0 ? 'º' : '™', code: `Digit${digit}`, altKey: true, repeat,
});
/** The fast keyboard send now: Enter on option card `digit` (1-based) in Details sends that card. */
const press = (digit: number, repeat = false) => {
  const card = detail().querySelector<HTMLElement>(`[data-answer-option="${digit - 1}"]`)!;
  card.focus(); fireEvent.keyDown(card, { key: 'Enter', repeat });
};
/** Details' answer cards take input: "Write my own answer" is enabled (a send or save in progress disables it). */
const answerReady = () => {
  const own = detail().querySelector<HTMLButtonElement>('[data-answer-own]');
  expect(own && !own.disabled).toBe(true);
};
/** Details' words box: the picked card's note, else "Write my own answer". */
const words = () => answerWords(detail());

function setup(options = 9, connection: 'connected' | 'disconnected' | 'reconnecting' = 'connected') {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const item = session.items['2']!;
  item.options = Array.from({ length: options }, (_, index) => ({
    id: `choice-${index + 1}`, label: `Window ${index + 1}`, consequence: `Use window ${index + 1}.`, recommended: index === 0,
  }));
  session.rounds[item.current_round_id!]!.options_snapshot = structuredClone(item.options);
  session.bindings[session.active_binding_id!]!.connection_state = connection;
  render(<DesktopApp service={createDesktopService(transport)} />);
  return transport;
}

async function openQuestion() {
  await goToSession(route);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
  fireEvent.click(row());
  await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
  await waitFor(answerReady);
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
}

describe('quick owner answers from the desktop', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('Enter on option card %i in Details sends that option', async digit => {
    const transport = setup(); await openQuestion();
    press(digit);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: {
      kind: 'answer', target: { item_id: '2' }, selected_option_id: `choice-${digit}`,
    } } });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('⌥%i sends that option from the Map row, using its physical digit code', async digit => {
    const transport = setup(); await openQuestion();
    row().focus(); alt(row(), digit);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: {
      kind: 'answer', target: { item_id: '2' }, selected_option_id: `choice-${digit}`,
    } } });
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(1);
  });

  it.each(['Details', 'the body'] as const)('⌥2 sends option 2 with focus in %s', async place => {
    const transport = setup(); await openQuestion();
    if (place === 'Details') { const card = detail().querySelector<HTMLElement>('[data-answer-option="0"]')!; card.focus(); alt(card, 2); }
    else { (document.activeElement as HTMLElement | null)?.blur(); alt(document.body, 2); }
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ command: { params: { selected_option_id: 'choice-2' } } });
  });

  it('keeps the typed note when ⌥ sends from the Map', async () => {
    const transport = setup(); await openQuestion();
    const note = 'Keep these exact words: café\nsecond line';
    fireEvent.change(words(), { target: { value: note } });
    row().focus(); alt(row(), 2);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
  });

  it('ignores a held ⌥ digit key-repeat before any real press, and sends once for a press with repeats after it', async () => {
    const transport = setup(); await openQuestion();
    row().focus(); alt(row(), 1, true);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    alt(row(), 1); alt(row(), 1, true); alt(row(), 1, true);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(1);
  });

  it('ignores ⌥ bursts and another ⌥ digit while this item is sending', async () => {
    const transport = setup(); await openQuestion();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, requested = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { ++requested; await gate; }
      return invoke(name, args);
    });
    row().focus();
    await act(async () => { alt(row(), 1); alt(row(), 1); });
    await waitFor(() => expect(requested).toBe(1));
    alt(row(), 2); alt(detail(), 3);
    await act(async () => { await Promise.resolve(); });
    expect(requested).toBe(1);
    await act(async () => { release(); });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-1' } });
  });

  it('does nothing for ⌥5 with 3 options, ⌥0, or a ⌥ digit on an item that is not waiting', async () => {
    const transport = setup(3); await openQuestion();
    row().focus(); alt(row(), 5); alt(row(), 0);
    fireEvent.click(document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!);
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="4"]' });
    const other = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
    other.focus(); alt(other, 1); alt(other, 2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(sends(transport)).toHaveLength(0);
  });

  it('does not send a ⌥ digit while Details is refreshing, never replays that press after, and sends on a new one', async () => {
    const transport = setup(); await openQuestion();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') await gate;
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    row().focus(); alt(row(), 1);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(answerReady);
    expect(sends(transport)).toHaveLength(0);
    alt(row(), 1);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
  });

  it('leaves ⌥ digits to the answer dock when focus is in it, so the dock never sends the Map’s selected question', async () => {
    const transport = setup(); await openQuestion();
    closeDetails();
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    fireEvent.click(await within(dock).findByRole('button', { name: /^1 waiting$/ }));
    const card = await waitFor(() => { const found = dock.querySelector<HTMLElement>('[data-answer-option="1"]'); expect(found).not.toBeNull(); return found!; });
    card.focus(); alt(card, 2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(sends(transport)).toHaveLength(0);
  });

  it('offers the not-running dialog for a disconnected ⌥ send, as a click does', async () => {
    const transport = setup(2, 'disconnected'); await openQuestion();
    row().focus(); alt(row(), 2);
    const dialog = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    expect(sends(transport)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: /^Queue it/ }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2' } });
  });

  it('refuses ⌥N while a hover peek shows another item than the Map’s selection, and sends again once it is gone', async () => {
    const transport = setup(); await openQuestion();
    const other = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="4"]')!;
    fireEvent.mouseEnter(other);
    const peek = await screen.findByRole('dialog', { name: /^Peek: / }, { timeout: 3000 });
    expect(peek.getAttribute('data-peek-target')).toContain('"4"');
    row().focus();
    // Refused and consumed: nothing is sent, the key does not fall through.
    expect(alt(row(), 2)).toBe(false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(sends(transport)).toHaveLength(0);
    // Plain digits are unchanged: they still pick the option (and send nothing).
    expect(fireEvent.keyDown(row(), { key: '2' })).toBe(false);
    expect(sends(transport)).toHaveLength(0);
    // Without the card the same key sends.
    fireEvent.mouseLeave(other);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Peek: / })).toBeNull());
    row().focus(); alt(row(), 2);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ command: { params: { target: { item_id: '2' }, selected_option_id: 'choice-2' } } });
  });

  it('refuses ⌥N in topic mode, where Details shows the topic’s conversation, and does not switch Details to the Map’s item', async () => {
    const transport = setup(); await openQuestion();
    const band = document.querySelector<HTMLElement>('.tree-topic')!;
    fireEvent.click(within(band).getByRole('button', { name: /^More actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reply to topic/ }));
    await waitFor(() => expect(document.querySelector('[data-composer="topic"]')).not.toBeNull());
    expect(document.querySelector('[data-detail-item-id]')).toBeNull();
    row().focus();
    expect(alt(row(), 2)).toBe(false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(sends(transport)).toHaveLength(0);
    expect(document.querySelector('[data-detail-item-id]')).toBeNull();
    expect(document.querySelector('[data-composer="topic"]')).not.toBeNull();
  });

  // The tree row has no inline answer any more (SPEC, Removed): only Details sends from the keyboard on the Map.
  it('keeps the typed note when sending from Details', async () => {
    const transport = setup(); await openQuestion();
    const note = 'Keep these exact words: café\nsecond line';
    fireEvent.change(words(), { target: { value: note } });
    press(2);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
    // Queued behind another message: the Not sent yet caption and StuckNote's Edit and Delete, as before.
    await screen.findByText('Not sent yet');
    const session = transport.sessions.get(route.session_id)!;
    const input = Object.values(session.inputs).find(value => value?.kind === 'answer' && value.target.item_id === '2')!;
    input.state = 'in_flight'; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    await waitFor(() => expect(within(detail()).queryByRole('button', { name: 'Undo' })).toBeNull());
    expect(within(detail()).getByText(/^✓ Sent at \d\d:\d\d · waiting for the agent$/u)).toBeTruthy();
    expect(within(detail()).getByRole('button', { name: 'Cancel message' })).toBeTruthy();
  });

  it.each(['Send', 'Enter on an option'] as const)('keeps a Details note when the dock sends the question with %s after Details closes', async action => {
    const transport = setup(2); await openQuestion();
    const note = ' Keep my exact note: café\nsecond line ';
    fireEvent.change(words(), { target: { value: note } });
    // Details holds the question, so the dock leaves it out; closing Details hands it to the dock with the same draft.
    closeDetails();
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    fireEvent.click(await within(dock).findByRole('button', { name: /^1 waiting$/ }));
    await waitFor(() => expect(answerWords(dock).value).toBe(note));
    const choice = dock.querySelector<HTMLElement>('[data-answer-option="1"]')!;
    if (action === 'Send') {
      fireEvent.click(choice);
      fireEvent.click(within(dock).getByRole('button', { name: 'Send' }));
    } else {
      choice.focus(); fireEvent.keyDown(choice, { key: 'Enter' });
    }
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
    const session = transport.sessions.get(route.session_id)!;
    const input = Object.values(session.inputs).find(value => value?.kind === 'answer' && value.target.item_id === '2')!;
    expect(input.payload.text).toBe(note);
  });

  // The old ⌥digit key ignored repeats; Enter on a card must too, so a key held down onto a card sends nothing.
  it('ignores a held Enter that repeats onto an option card before any real press', async () => {
    const transport = setup(); await openQuestion();
    press(1, true);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
  });

  it('ignores bursts, repeats and another card while this item is sending', async () => {
    const transport = setup(); await openQuestion();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, requested = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { ++requested; await gate; }
      return invoke(name, args);
    });
    await act(async () => { press(1); press(1); });
    await waitFor(() => expect(requested).toBe(1));
    press(2); press(3); press(1, true);
    await act(async () => { await Promise.resolve(); });
    expect(requested).toBe(1);
    await act(async () => { release(); });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-1' } });
  });

  it('leaves Option characters to text fields and does nothing for a missing option or an Enter on none', async () => {
    const transport = setup(2); await openQuestion();
    const box = words();
    box.focus(); fireEvent.change(box, { target: { value: 'Already typed' } });
    alt(box, 1); alt(box, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Search the Map' }));
    const search = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Search the Map' });
    search.focus(); alt(search, 1); alt(search, 0);
    row().focus(); alt(row(), 9);
    // Only two options exist: there is no third card to press.
    expect(detail().querySelector('[data-answer-option="2"]')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    expect(box.value).toBe('Already typed');
  });

  it('offers the same not-running dialog for a disconnected key send as a click, and Cancel keeps the note', async () => {
    const transport = setup(2, 'disconnected'); await openQuestion();
    const note = 'Keep this while I decide.';
    fireEvent.change(words(), { target: { value: note } });
    press(2);
    const dialog = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    expect(within(dialog).getByRole('button', { name: /^Queue it/ })).toBeTruthy();
    expect(sends(transport)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(words().value).toBe(note);
    press(2);
    const queued = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    fireEvent.click(within(queued).getByRole('button', { name: /^Queue it/ }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
  });

  it('does not send while the agent is reconnecting', async () => {
    const connection = 'reconnecting' as const;
    const transport = setup(2, connection); await openQuestion();
    const session = transport.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!;
    const observation = { ...structuredClone(sessionsFixture.items[0].active_binding.presence), connection_state: connection,
      last_seen_at: '2026-10-03T12:01:00.000Z' } as PresenceObservation;
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation }); });
    press(1);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not send while Details is refreshing, never replays that press after, and sends on a new one', async () => {
    const transport = setup(); await openQuestion();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get') await gate;
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    press(1);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(answerReady);
    expect(sends(transport)).toHaveLength(0);
    press(1);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
  });

  it('shows feedback for a question changed before the press, then sends once after review', async () => {
    const transport = setup(2); await openQuestion();
    const note = 'Keep my note while I review the changed question.';
    fireEvent.change(words(), { target: { value: note } });
    const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    ++item.revision; ++item.question_revision; ++session.revision;
    session.rounds[item.current_round_id!]!.question_revision = item.question_revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    await within(detail()).findByText('This item changed. Review the current question and options; your text is retained.');
    press(1);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    expect(words().value).toBe(note);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Review this question' }));
    await waitFor(() => expect(within(detail()).queryByText('This item changed. Review the current question and options; your text is retained.')).toBeNull());
    press(1);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-1', text: note } });
  });

  // The press acts on the card the owner sees, not on a number resolved later: after the options reorder under the
  // owner, the first card is the new first one, and its choice and the typed note are what is sent.
  it('sends the option shown on the pressed card after the options reorder, with the note', async () => {
    const transport = setup(2); await openQuestion();
    const note = 'Keep my note even if the options move.';
    fireEvent.change(words(), { target: { value: note } });
    const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    item.options.reverse(); ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    await waitFor(() => expect(detail().querySelector('[data-answer-option="0"]')?.textContent).toContain('Window 2'));
    await waitFor(answerReady);
    expect(sends(transport)).toHaveLength(0);
    expect(words().value).toBe(note);
    press(1);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
  });

  it('answers another session’s question from the dock’s list instead of the selected tree item', async () => {
    const transport = setup(), first = transport.sessions.get(route.session_id)!;
    const other = structuredClone(first); other.id = secondId; other.title = 'Other questions';
    transport.sessions.set(secondId, other);
    await openQuestion();
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    fireEvent.click(await within(dock).findByRole('button', { name: /in other sessions$/ }));
    const list = within(dock).getByRole('dialog', { name: 'Questions in other sessions' });
    fireEvent.click(list.querySelector<HTMLElement>('.dock-other-head')!);
    fireEvent.click(await within(list).findByRole('button', { name: /^Window 2/ }));
    fireEvent.click(within(list).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: { ...route, session_id: secondId }, command: { params: { selected_option_id: 'choice-2' } } });
    // The Map keeps its selection in this session.
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
  });
});
