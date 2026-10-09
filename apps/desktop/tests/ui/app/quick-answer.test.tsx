import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from './transport';
import { sessionButton } from './open';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { PresenceObservation } from '../../../src/generated/domain/models';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const sends = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'input_submit');
const row = () => document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
const detail = () => screen.getByLabelText('Detail of #2');
const alt = (target: Element, digit: number, repeat = false) => fireEvent.keyDown(target, {
  key: digit === 1 ? '¡' : digit === 0 ? 'º' : '™', code: `Digit${digit}`, altKey: true, repeat,
});

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
  fireEvent.click(await sessionButton(route));
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close session' }).disabled).toBe(false));
  fireEvent.click(row());
  await screen.findByLabelText('Detail of #2');
  await waitFor(() => expect(within(detail()).getByLabelText<HTMLTextAreaElement>('Reply in your own words').disabled).toBe(false));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close session' }).disabled).toBe(false));
}

describe('quick owner answers from the desktop', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('sends option %i using its physical digit code, including macOS Option characters', async digit => {
    const transport = setup(); await openQuestion();
    row().focus(); alt(row(), digit);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: route, command: { params: {
      kind: 'answer', target: { item_id: '2' }, selected_option_id: `choice-${digit}`,
    } } });
  });

  it.each(['tree', 'waiting', 'detail'] as const)('keeps the typed note when sending from the %s', async entry => {
    const transport = setup(); await openQuestion();
    const note = 'Keep these exact words: café\nsecond line';
    fireEvent.change(within(detail()).getByLabelText('Reply in your own words'), { target: { value: note } });
    const target = entry === 'tree' ? row() : entry === 'waiting'
      ? document.querySelector<HTMLElement>('[data-waiting-item="2"]')! : detail();
    target.focus(); alt(target, 2);
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

  it.each(['Send answer', 'Enter on an option'] as const)('keeps a detail note when sending from the Waiting card with %s', async action => {
    const transport = setup(2); await openQuestion();
    const note = ' Keep my exact note: café\nsecond line ';
    fireEvent.change(within(detail()).getByLabelText('Reply in your own words'), { target: { value: note } });
    const card = document.querySelector<HTMLElement>('[data-waiting-item="2"]')!;
    const choice = within(card).getByTitle('Press 2 to select, ⌥2 to send with your note');
    if (action === 'Send answer') {
      fireEvent.click(choice);
      fireEvent.click(within(card).getByRole('button', { name: 'Send answer' }));
    } else {
      choice.focus(); fireEvent.keyDown(choice, { key: 'Enter' });
    }
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-2', text: note } });
    const session = transport.sessions.get(route.session_id)!;
    const input = Object.values(session.inputs).find(value => value?.kind === 'answer' && value.target.item_id === '2')!;
    expect(input.payload.text).toBe(note);
  });

  it('ignores repeat, bursts and another shortcut while this item is sending', async () => {
    const transport = setup(); await openQuestion();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, requested = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'input_submit') { ++requested; await gate; }
      return invoke(name, args);
    });
    row().focus(); alt(row(), 1, true);
    await act(async () => { await Promise.resolve(); });
    expect(requested).toBe(0);
    await act(async () => { alt(row(), 1); alt(row(), 1); });
    await waitFor(() => expect(requested).toBe(1));
    alt(row(), 2); alt(detail(), 3); alt(row(), 1, true);
    await act(async () => { await Promise.resolve(); });
    expect(requested).toBe(1);
    await act(async () => { release(); });
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-1' } });
  });

  it('leaves Option characters to text fields and does nothing for a missing option', async () => {
    const transport = setup(2); await openQuestion();
    const words = within(detail()).getByLabelText<HTMLTextAreaElement>('Reply in your own words');
    words.focus(); fireEvent.change(words, { target: { value: 'Already typed' } });
    alt(words, 1); alt(words, 0);
    const search = document.querySelector<HTMLInputElement>('[data-shell-search]')!;
    search.focus(); alt(search, 1); alt(search, 0);
    row().focus(); alt(row(), 9);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    expect(words.value).toBe('Already typed');
  });

  it('offers the same not-running dialog for a disconnected shortcut as a click, and Cancel keeps the note', async () => {
    const transport = setup(2, 'disconnected'); await openQuestion();
    const note = 'Keep this while I decide.';
    fireEvent.change(within(detail()).getByLabelText('Reply in your own words'), { target: { value: note } });
    row().focus(); alt(row(), 2);
    const dialog = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    expect(within(dialog).getByRole('button', { name: /Queue it for/ })).toBeTruthy();
    expect(sends(transport)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(detail()).getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe(note);
    row().focus(); alt(row(), 2);
    const queued = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
    fireEvent.click(within(queued).getByRole('button', { name: /Queue it for/ }));
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
    row().focus(); alt(row(), 1);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not send or replay a shortcut pressed while the session view is refreshing', async () => {
    const transport = setup(); await openQuestion();
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get' && args.request.session?.session_id === route.session_id) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    const session = transport.sessions.get(route.session_id)!;
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    await waitFor(() => expect(entered).toBe(true));
    row().focus(); alt(row(), 1);
    await act(async () => { await Promise.resolve(); });
    expect(sends(transport)).toHaveLength(0);
    await act(async () => { release(); });
    await waitFor(() => expect(within(detail()).getByLabelText<HTMLTextAreaElement>('Reply in your own words').disabled).toBe(false));
    expect(sends(transport)).toHaveLength(0);
  });

  it('shows feedback for a question changed before the shortcut, then sends once after review', async () => {
    const transport = setup(2); await openQuestion();
    const note = 'Keep my note while I review the changed question.';
    fireEvent.change(within(detail()).getByLabelText('Reply in your own words'), { target: { value: note } });
    const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    ++item.revision; ++item.question_revision; ++session.revision;
    session.rounds[item.current_round_id!]!.question_revision = item.question_revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    await within(detail()).findByText('This item changed. Review the current question and options; your text is retained.');
    row().focus(); alt(row(), 1);
    await within(detail()).findByText('This item changed. Review it before sending. Your note is kept.');
    expect(sends(transport)).toHaveLength(0);
    expect(within(detail()).getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe(note);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Review current target' }));
    await waitFor(() => expect(within(detail()).queryByText('This item changed. Review it before sending. Your note is kept.')).toBeNull());
    row().focus(); alt(row(), 1);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: 'choice-1', text: note } });
  });

  it.each(['options reorder', 'question revision'] as const)('keeps the note and refuses a send after %s changes during reveal', async change => {
    const transport = setup(2); await openQuestion();
    const note = 'Keep my note even if the question changes.';
    fireEvent.change(within(detail()).getByLabelText('Reply in your own words'), { target: { value: note } });
    const invoke = transport.invoke.bind(transport);
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'reveal_item') { entered = true; await gate; }
      return invoke(name, args);
    });
    row().focus(); alt(row(), 1);
    await waitFor(() => expect(entered).toBe(true));
    const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
    if (change === 'options reorder') item.options.reverse();
    else { ++item.revision; ++item.question_revision; session.rounds[item.current_round_id!]!.question_revision = item.question_revision; }
    ++session.revision;
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
    if (change === 'options reorder') await waitFor(() => expect(detail().querySelector('[data-answer-option="0"]')?.textContent).toContain('Window 2'));
    else await waitFor(() => expect(within(detail()).getByText('This item changed. Review the current question and options; your text is retained.')).toBeTruthy());
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Close session' }).disabled).toBe(false));
    expect(await within(detail()).findByRole('status')).toHaveProperty('textContent', 'This item changed. Review it before sending. Your note is kept.');
    expect(sends(transport)).toHaveLength(0);
    expect(within(detail()).getByLabelText<HTMLTextAreaElement>('Reply in your own words').value).toBe(note);
    if (change === 'question revision') {
      fireEvent.click(within(detail()).getByRole('button', { name: 'Review current target' }));
      await waitFor(() => expect(within(detail()).queryByText('This item changed. Review it before sending. Your note is kept.')).toBeNull());
    }
    row().focus(); alt(row(), 1);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0].command).toMatchObject({ params: { selected_option_id: change === 'options reorder' ? 'choice-2' : 'choice-1', text: note } });
  });

  it.each(['tree', 'waiting', 'detail'] as const)('Option 0 opens the answer and focuses own words from the %s', async entry => {
    const transport = setup(); await openQuestion();
    if (entry === 'tree') fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    const target = entry === 'tree' ? row() : entry === 'waiting'
      ? document.querySelector<HTMLElement>('[data-waiting-item="2"]')! : detail();
    target.focus(); alt(target, 0);
    await screen.findByLabelText('Detail of #2');
    await waitFor(() => expect(document.activeElement).toBe(within(detail()).getByLabelText('Reply in your own words')));
    expect(sends(transport)).toHaveLength(0);
  });

  it('answers a focused Waiting card from another session instead of the selected tree item', async () => {
    const transport = setup(), first = transport.sessions.get(route.session_id)!;
    const other = structuredClone(first); other.id = secondId; other.title = 'Other questions';
    transport.sessions.set(secondId, other);
    await openQuestion();
    const cards = [...document.querySelectorAll<HTMLElement>('[data-waiting-item="2"]')];
    expect(cards).toHaveLength(2);
    const target = cards.find(card => card.getAttribute('aria-current') !== 'true')!;
    alt(target, 2);
    await waitFor(() => expect(sends(transport)).toHaveLength(1));
    expect(sends(transport)[0]).toMatchObject({ session: { ...route, session_id: secondId }, command: { params: { selected_option_id: 'choice-2' } } });
  });
});
