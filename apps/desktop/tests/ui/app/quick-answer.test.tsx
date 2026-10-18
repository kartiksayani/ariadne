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
// ⌥1–9 and ⌥0 are unbound (SPEC 6.1): `alt` is kept only to prove they do nothing now.
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
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('Enter on option card %i in Details sends that option, and the same ⌥ digit sends nothing', async digit => {
    const transport = setup(); await openQuestion();
    row().focus(); alt(row(), digit); alt(detail(), digit);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    press(digit);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: {
      kind: 'answer', target: { item_id: '2' }, selected_option_id: `choice-${digit}`,
    } } });
  });

  // The tree row has no inline answer any more (SPEC, Removed): only Details sends from the keyboard on the Map.
  it('keeps the typed note when sending from Details', async () => {
    const transport = setup(); await openQuestion();
    const note = 'Keep these exact words: café\nsecond line';
    fireEvent.change(words(), { target: { value: note } });
    press(2);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
    await screen.findByText('Not sent yet');
    const session = transport.sessions.get(route.session_id)!;
    const input = Object.values(session.inputs).find(value => value?.kind === 'answer' && value.target.item_id === '2')!;
    input.state = 'in_flight'; ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    await screen.findByText('On its way');
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
