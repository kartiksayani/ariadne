// Owner-set session names (ADR-0091): where the name shows, the unnamed fallback, and the Rename flow.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import { DesktopApp } from '../../../src/App';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { CoreFailure, createDesktopService } from '../../../src/data/service';
import { OpenSessions, type Immutable } from '../../../src/data/session-store';
import type { MutationEnvelope } from '../../../src/generated/core';
import type { Session, SessionSummary } from '../../../src/generated/domain/models';
import { continueTargets } from '../../../src/ui/dialogs/ContinueTopicDialog';
import { removeCopy } from '../../../src/ui/dialogs/remove';
import { removeLabel } from '../../../src/ui/remove/model';
import { archivedTopics, sessionCardText } from '../../../src/ui/pages/model';
import { notices } from '../../../src/ui/pages/notices';
import { CloseSessionDialog } from '../../../src/ui/pages/SessionDialogs';
import { continuedLabel } from '../../../src/ui/shared/continued';
import { earlierAgent } from '../../../src/ui/shared/excerpt';
import { saveSessionLabel, SessionRename } from '../../../src/ui/shared/SessionRename';
import { SESSION_DESCRIPTION_MAX, SESSION_NAME_MAX, ownerDescription, ownerName, sessionLabel, sessionPhrase, tabModels } from '../../../src/ui/shell/model';
import { SessionBar as SessionBarView } from '../../../src/ui/tree/SessionBar';
import { sessionBar } from '../../../src/ui/tree/model';
import { AppTransport, route, secondId } from '../app/transport';
import { sessionButton } from '../app/open';
import { HistoryTransport } from '../history-actions/fixture';

const now = Date.parse('2026-10-03T15:00:00.000Z');
const summary = (extra: Record<string, unknown> = {}) => ({ ...structuredClone(sessionsFixture.items[0]), ...extra }) as unknown as Immutable<SessionSummary>;
const named = summary({ name: 'Sync fixes', description: 'Search webhook retries' });
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); opened.splice(0).forEach(sessions => sessions.closeAll()); });

describe('the owner’s name for a session, in the shared helpers', () => {
  it('trims the name and description and treats blank as none', () => {
    expect(ownerName({ name: '  Sync fixes ' })).toBe('Sync fixes');
    expect(ownerName({ name: '   ' })).toBeNull();
    expect(ownerName({ name: null })).toBeNull();
    expect(ownerName(undefined)).toBeNull();
    expect(ownerDescription({ description: ' Retries ' })).toBe('Retries');
    expect(ownerDescription({})).toBeNull();
  });
  it('leads with the name and keeps the agent line as the quieter secondary line', () => {
    expect(sessionLabel({ name: 'Sync fixes', description: 'Retries' }, 'claude-code · iTerm window 1'))
      .toEqual({ named: true, title: 'Sync fixes', secondary: 'claude-code · iTerm window 1', description: 'Retries' });
  });
  it('keeps the agent line as the title while unnamed', () => {
    expect(sessionLabel({}, 'claude-code · iTerm window 1'))
      .toEqual({ named: false, title: 'claude-code · iTerm window 1', secondary: null, description: null });
  });
  it('words a session in confirmations by its name, else by agent and day', () => {
    expect(sessionPhrase({ name: 'Sync fixes' }, 'codex', 'Yesterday')).toBe('the “Sync fixes” session');
    expect(sessionPhrase({ name: null }, 'codex', 'Yesterday')).toBe('the codex session from yesterday');
  });
  it('states the limits core enforces', () => {
    expect([SESSION_NAME_MAX, SESSION_DESCRIPTION_MAX]).toEqual([60, 200]);
  });
});

describe('every place that names a session shows the name', () => {
  it('project-page cards: name as title, description beneath, agent line quieter; unnamed stays as before', () => {
    const text = sessionCardText(named, null, now, 'iTerm window 1');
    expect(text).toMatchObject({ title: 'Sync fixes', description: 'Search webhook retries', secondary: 'demo.local · iTerm window 1', named: true });
    expect(sessionCardText(summary(), null, now, 'iTerm window 1'))
      .toMatchObject({ title: 'demo.local · iTerm window 1', description: null, secondary: null, named: false });
    expect(sessionCardText(summary(), null, now).title).toBe('demo.local');
  });
  it('the session bar: name as title with the agent line and description; unnamed stays as before', () => {
    expect(sessionBar(null, named)).toMatchObject({ title: 'Sync fixes', secondary: 'demo.local · iTerm window 1', description: 'Search webhook retries', named: true });
    expect(sessionBar(null, summary())).toMatchObject({ title: 'demo.local · iTerm window 1', secondary: null, description: null, named: false });
  });
  it('tabs: the name is the label and the tooltip keeps the agent and description', () => {
    const facts = (naming: { name?: string; description?: string } | null) => tabModels({ selection: 'session', projectCount: 1, sessions: [
      { id: 's', project: 'Notes', agent: 'codex', where: 'iTerm window 1', naming, createdAt: now, endedAt: null, running: true, on: true }] }, now)[2]!;
    expect(facts({ name: 'Sync fixes', description: 'Retries' }).label).toBe('Sync fixes');
    const tip = facts({ name: 'Sync fixes', description: 'Retries' }).title.split(' · ');
    expect(tip).toEqual(expect.arrayContaining(['Notes', 'Sync fixes', 'codex', 'iTerm window 1', 'Retries']));
    expect(tip.indexOf('Sync fixes')).toBeLessThan(tip.indexOf('codex'));
    expect(facts(null).label).toBe('codex');
    expect(facts(null).title.split(' · ')).not.toContain('Sync fixes');
  });
  it('the Continue picker lists a named session by its name and shows its description', () => {
    const other = summary({ session_id: secondId, name: 'Sync fixes', description: 'Retries' });
    const [target] = continueTargets({ project_id: route.project_id, session_id: '00000000-0000-4000-8000-0000000000aa' }, [other]);
    expect(target!.label).toBe('Sync fixes');
    expect(target!.detail).toBe('demo.local · running · Retries');
    const [plain] = continueTargets({ project_id: route.project_id, session_id: '00000000-0000-4000-8000-0000000000aa' }, [summary({ session_id: secondId })]);
    expect(plain!.label).toBe(sessionsFixture.items[0]!.title);
  });
  it('a continued topic names the session it came from', () => {
    const origin = { project_id: named.project_id, session_id: named.session_id, topic_id: '00000000-0000-4000-8000-0000000000bb' } as never;
    expect(continuedLabel(origin, [named], now)).toMatch(/^Continued from Sync fixes/);
    expect(continuedLabel(origin, [summary()], now)).toMatch(/^Continued from demo\.local/);
  });
  it('messages of an earlier session carry its name', () => {
    const first = summary({ name: 'Sync fixes', active_binding: { ...summary().active_binding!, connection_state: 'disconnected' } });
    const live = summary({ session_id: secondId });
    expect(earlierAgent({ project_id: first.project_id, session_id: first.session_id }, [first, live])).toBe('Sync fixes');
  });
  it('the Remove dialog names the session by its name', () => {
    const subject = { kind: 'session', agent: 'codex', when: 'Yesterday', name: 'Sync fixes', topics: 1, items: 2, shared: 0, waiting: 0 } as const;
    expect(removeCopy(subject).title).toBe('Remove the “Sync fixes” session?');
    expect(removeLabel(subject)).toBe('the “Sync fixes” session');
    expect(removeCopy({ ...subject, name: null }).title).toBe('Remove the codex session from yesterday?');
  });
  it('the Archive page says which session a topic came from', () => {
    const session = structuredClone(demoSession(named));
    const topic = Object.values(session.topics)[0]!; topic.archived_at = '2026-10-03T13:00:00.000Z';
    const key = JSON.stringify([named.project_id, named.session_id]);
    const [row] = archivedTopics([named], new Map([[key, session as Immutable<Session>]]), '', now);
    expect(row!.meta).toMatch(/^From “Sync fixes” · /);
    const [plain] = archivedTopics([summary()], new Map([[key, session as Immutable<Session>]]), '', now);
    expect(plain!.meta).toMatch(/^From demo\.local · /);
  });
  it('the Close dialog names the session', async () => {
    const transport = new HistoryTransport();
    const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActionControllers(service, () => '00000000-0000-4000-8000-000000000098').forSession(store);
    render(<CloseSessionDialog store={store} actions={actions} agent="codex" when="Yesterday" name="Sync fixes" onClose={() => undefined} />);
    expect(within(screen.getByRole('dialog')).getByText('Close the “Sync fixes” session?')).toBeTruthy();
  });
});

function demoSession(naming: Immutable<SessionSummary>): Session {
  // The archived-topics model reads topics, items and the session id only.
  const transport = new AppTransport();
  return { ...structuredClone(transport.sessions.get(route.session_id)!), id: naming.session_id } as Session;
}

describe('the rename fields', () => {
  const setup = (naming: { name?: string | null; description?: string | null } = {}, onSave: (name: string, description: string) => Promise<string | null> = async () => null) => {
    const cancel = vi.fn(), save = vi.fn(onSave);
    render(<SessionRename layout="card" naming={naming} onSave={save} onCancel={cancel} />);
    return { cancel, save, name: screen.getByPlaceholderText('Name this session') as HTMLInputElement,
      description: screen.getByPlaceholderText('What is this session for? (optional)') as HTMLInputElement };
  };
  it('open with the current text, the name focused, and the limits on the inputs', () => {
    const { name, description } = setup({ name: 'Sync fixes', description: 'Retries' });
    expect([name.value, description.value]).toEqual(['Sync fixes', 'Retries']);
    expect(document.activeElement).toBe(name);
    expect([name.maxLength, description.maxLength]).toEqual([60, 200]);
  });
  it('save on Enter with the typed text', async () => {
    const { name, description, save } = setup();
    fireEvent.change(name, { target: { value: ' Sync fixes ' } }); fireEvent.change(description, { target: { value: 'Retries' } });
    await act(async () => { fireEvent.keyDown(description, { key: 'Enter' }); });
    expect(save).toHaveBeenCalledWith(' Sync fixes ', 'Retries');
  });
  it('save on the Save button', async () => {
    const { name, save } = setup();
    fireEvent.change(name, { target: { value: 'Sync fixes' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(save).toHaveBeenCalledWith('Sync fixes', '');
  });
  it('cancel on Esc and on the Cancel button without saving anything', () => {
    const first = setup();
    fireEvent.change(first.name, { target: { value: 'Typed but not saved' } });
    fireEvent.keyDown(first.name, { key: 'Escape' });
    expect(first.cancel).toHaveBeenCalledTimes(1); expect(first.save).not.toHaveBeenCalled();
    cleanup();
    const second = setup();
    fireEvent.change(second.name, { target: { value: 'Typed but not saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(second.cancel).toHaveBeenCalledTimes(1); expect(second.save).not.toHaveBeenCalled();
  });
  it('Enter on the Cancel button cancels instead of saving; Enter on Save saves', async () => {
    const user = userEvent.setup();
    const first = setup();
    await user.type(first.name, ' changed');
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.keyboard('{Enter}');
    expect(first.cancel).toHaveBeenCalledTimes(1); expect(first.save).not.toHaveBeenCalled();
    cleanup();
    const second = setup();
    await user.type(second.name, 'Sync fixes');
    screen.getByRole('button', { name: 'Save' }).focus();
    await user.keyboard('{Enter}');
    expect(second.save).toHaveBeenCalledTimes(1); expect(second.cancel).not.toHaveBeenCalled();
  });
  it('keep typed keys and Esc from reaching the window shortcuts', () => {
    const seen = vi.fn(); window.addEventListener('keydown', seen);
    const { name } = setup();
    fireEvent.keyDown(name, { key: 'g' }); fireEvent.keyDown(name, { key: 'Escape' });
    window.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
  });
  it('close without a command when nothing changed', async () => {
    const { save, cancel, name } = setup({ name: 'Sync fixes' });
    await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); });
    expect(save).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('stay open and say why in plain words when the save fails, then save again', async () => {
    let fail: string | null = 'The name can be at most 60 characters.';
    const { name, save } = setup({}, async () => fail);
    fireEvent.change(name, { target: { value: 'Sync fixes' } });
    await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); });
    expect(screen.getByRole('alert').textContent).toBe('The name can be at most 60 characters.');
    fail = null;
    await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); });
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('the session bar', () => {
  const bar = sessionBar(null, named)!;
  it('shows the name, the agent line and the description, and no Rename without a way to save', () => {
    render(<SessionBarView bar={bar} busy={false} onClose={() => undefined} />);
    expect(screen.getByText('Sync fixes').className).toContain('tree-session-title');
    expect(screen.getByText('demo.local · iTerm window 1').className).toContain('tree-session-secondary');
    expect(screen.getByText('Search webhook retries').getAttribute('title')).toBe('Search webhook retries');
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
  });
  it('opens the fields from Rename, saves with the fields filled in, and closes', async () => {
    const onRename = vi.fn(async () => null);
    render(<SessionBarView bar={bar} busy={false} onClose={() => undefined} onRename={onRename} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const name = screen.getByLabelText('Session name') as HTMLInputElement;
    expect([name.value, (screen.getByLabelText('Session description') as HTMLInputElement).value]).toEqual(['Sync fixes', 'Search webhook retries']);
    fireEvent.change(name, { target: { value: 'Sync' } });
    await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); });
    expect(onRename).toHaveBeenCalledWith('Sync', 'Search webhook retries');
    expect(screen.queryByLabelText('Session name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Session actions' })).toBeTruthy();
  });
  it('leaves the name alone on Esc and gives focus back to Session actions', () => {
    const onRename = vi.fn(async () => null);
    render(<SessionBarView bar={bar} busy={false} onClose={() => undefined} onRename={onRename} />);
    const trigger = screen.getByRole('button', { name: 'Session actions' });
    trigger.focus(); fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Session name'), { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Sync fixes')).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });
  it('offers Rename on a closed session and disables it while busy', () => {
    render(<SessionBarView bar={{ ...bar, closed: true }} busy onClose={() => undefined} onRename={async () => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    expect((screen.getByRole('menuitem', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Reopen session' })).toBeTruthy();
  });
});

describe('saving a name through the session’s write barrier', () => {
  async function setup() {
    const transport = new HistoryTransport();
    const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActionControllers(service, () => '00000000-0000-4000-8000-000000000097').forSession(store);
    return { transport, store, actions };
  }
  it('sends session_label_set with the trimmed text, blank as null, and the session on the route', async () => {
    const { transport, store, actions } = await setup();
    expect(await saveSessionLabel(actions, store.getSnapshot().snapshot!.session.revision, '  Sync fixes ', '   ')).toBeNull();
    expect(transport.mutations.map(value => ({ session: value.session, command: value.command.command, params: value.command.params }))).toEqual([
      { session: route, command: 'session_label_set', params: { name: 'Sync fixes', description: null } }]);
    expect(store.getSnapshot().snapshot!.session).toMatchObject({ name: 'Sync fixes' });
  });
  it('clears the name when saved blank', async () => {
    const { transport, store, actions } = await setup();
    await saveSessionLabel(actions, store.getSnapshot().snapshot!.session.revision, 'Sync fixes', 'Retries');
    expect(await saveSessionLabel(actions, store.getSnapshot().snapshot!.session.revision, '', '')).toBeNull();
    expect(transport.source.name).toBeUndefined();
    expect(transport.mutations.at(-1)!.command.params).toEqual({ name: null, description: null });
  });
  it('says a refusal in plain words, never in core’s own text', async () => {
    const { transport, store, actions } = await setup();
    const refusal: MutationEnvelope = { api_version: 1, ok: false, error: { code: 'invalid_argument', message: 'The name can be at most 60 characters.',
      hint: 'Shorten it.', retryable: false, field_errors: [] } };
    transport.replies.push(refusal);
    expect(await saveSessionLabel(actions, store.getSnapshot().snapshot!.session.revision, 'x'.repeat(61), '')).toBe('Something in that isn’t valid. Check it and try again.');
    expect(actions.getSnapshot().pending).toBeNull();
  });
  it('treats a removed session as a definite refusal, so nothing stays pending', async () => {
    const { transport, store, actions } = await setup();
    transport.replies.push({ api_version: 1, ok: false, error: { code: 'not_found', message: 'This session was removed, so it can’t be renamed.',
      hint: 'Open another session.', retryable: false, field_errors: [] } });
    expect(await saveSessionLabel(actions, store.getSnapshot().snapshot!.session.revision, 'Sync fixes', '')).toBe('Ariadne can’t find that any more. It may have been removed.');
    expect(actions.getSnapshot().pending).toBeNull();
    expect(actions.getSnapshot().error).toBeInstanceOf(CoreFailure);
  });
  it('rejects a receipt that echoes a different name than was sent', async () => {
    const { transport, store, actions } = await setup();
    const revision = store.getSnapshot().snapshot!.session.revision;
    transport.replies.push({ api_version: 1, ok: true, data: { operation_id: '00000000-0000-4000-8000-000000000097', session_id: route.session_id,
      revision: revision + 1, data: { kind: 'session_label', name: 'Somebody else', description: null } } } as MutationEnvelope);
    expect(await saveSessionLabel(actions, revision, 'Sync fixes', '')).toBe('The name could not be saved. Try again.');
  });
});

describe('renaming from the project page and the session bar', () => {
  function setup() {
    const transport = new AppTransport();
    render(<DesktopApp service={createDesktopService(transport)} />);
    return transport;
  }
  const card = () => document.querySelector<HTMLElement>(`[data-session-card="${route.session_id}"]`)!;
  const names = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'session_label_set');

  it('names a session from its card; the card, session bar and tab then show the name', async () => {
    const transport = setup();
    await sessionButton(route);
    expect(card().querySelector('.pw-session-title')!.textContent).toBe('demo.local · iTerm window 1');
    expect(card().querySelector('.pw-session-secondary')).toBeNull();

    fireEvent.click(within(card()).getByRole('button', { name: 'Rename' }));
    const field = within(card()).getByPlaceholderText('Name this session');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: ' Sync fixes ' } });
    fireEvent.change(within(card()).getByPlaceholderText('What is this session for? (optional)'), { target: { value: 'Search webhook retries' } });
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });

    await waitFor(() => expect(card().querySelector('.pw-session-title')!.textContent).toBe('Sync fixes'));
    expect(names(transport).map(request => ({ session: request.session, params: request.command.params }))).toEqual([
      { session: route, params: { name: 'Sync fixes', description: 'Search webhook retries' } }]);
    expect(card().querySelector('.pw-session-description')!.textContent).toBe('Search webhook retries');
    expect(card().querySelector('.pw-session-secondary')!.textContent).toBe('demo.local · iTerm window 1');
    expect(within(card()).queryByPlaceholderText('Name this session')).toBeNull();

    fireEvent.click(await sessionButton(route));
    await screen.findByRole('region', { name: 'Session tree' });
    await waitFor(() => expect(document.querySelector('.tree-session-title')!.textContent).toBe('Sync fixes'));
    // The loaded session's binding reports no host location, so the agent line is the agent alone.
    expect(document.querySelector('.tree-session-secondary')!.textContent).toBe('demo.local');
    expect(document.querySelector('[data-session-tab]')!.textContent).toContain('Sync fixes');
  });

  it('leaves the card untouched when Esc cancels', async () => {
    const transport = setup();
    await sessionButton(route);
    fireEvent.click(within(card()).getByRole('button', { name: 'Rename' }));
    const field = within(card()).getByPlaceholderText('Name this session');
    fireEvent.change(field, { target: { value: 'Never saved' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(within(card()).queryByPlaceholderText('Name this session')).toBeNull();
    expect(card().querySelector('.pw-session-title')!.textContent).toBe('demo.local · iTerm window 1');
    expect(names(transport)).toHaveLength(0);
  });

  it('renames from the session bar and clears the name by saving it blank', async () => {
    const transport = setup();
    fireEvent.click(await sessionButton(route));
    await screen.findByRole('region', { name: 'Session tree' });
    await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
        expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
      });
    expect(document.querySelector('.tree-session-title')!.textContent).toBe('demo.local');

    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByLabelText('Session name');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'Sync fixes' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await waitFor(() => expect(document.querySelector('.tree-session-title')!.textContent).toBe('Sync fixes'));
    expect(names(transport)).toHaveLength(1);

    await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
        expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
      });
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: '' } });
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('Session name'), { key: 'Enter' }); });
    await waitFor(() => expect(document.querySelector('.tree-session-title')!.textContent).toBe('demo.local'));
    expect(names(transport).at(-1)!.command.params).toEqual({ name: null, description: null });
  });
});
