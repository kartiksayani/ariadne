// Owner-set session names (ADR-0091): where the name shows, the unnamed fallback, and the Rename flow.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { archivedTopics } from '../../../src/ui/pages/model';
import { notices } from '../../../src/ui/pages/notices';
import { SessionRowAction } from '../../../src/ui/pages/SessionRowAction';
import { pageSession } from '../../../src/components/navigation/pageData';
import { continuedLabel } from '../../../src/ui/shared/continued';
import { earlierAgent } from '../../../src/ui/shared/excerpt';
import { saveSessionLabel } from '../../../src/ui/shared/SessionRename';
import { SESSION_DESCRIPTION_MAX, SESSION_NAME_MAX, ownerDescription, ownerName, sessionLabel, sessionPhrase } from '../../../src/ui/shell/model';
import { sessionBar } from '../../../src/ui/tree/model';
import { AppTransport, route, secondId } from '../app/transport';
import { goToSession } from '../app/open';
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
  it('page rows and cards: the name, else the session’s own title', () => {
    expect(pageSession(named, now, null).name).toBe('Sync fixes');
    expect(pageSession(summary(), now, null).name).toBe(sessionsFixture.items[0]!.title);
  });
  it('the session bar: name as title with the agent line and description; unnamed stays as before', () => {
    expect(sessionBar(null, named)).toMatchObject({ title: 'Sync fixes', secondary: 'demo.local · iTerm window 1', description: 'Search webhook retries', named: true });
    expect(sessionBar(null, summary())).toMatchObject({ title: 'demo.local · iTerm window 1', secondary: null, description: null, named: false });
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
  it('the Close review names the session', async () => {
    const transport = new HistoryTransport(); transport.source.name = 'Sync fixes';
    const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActionControllers(service, () => '00000000-0000-4000-8000-000000000098').forSession(store);
    render(<SessionRowAction actions={actions} act="close" onDone={() => undefined} />);
    expect(await screen.findByRole('dialog', { name: 'Close the “Sync fixes” session?' })).toBeTruthy();
  });
});

function demoSession(naming: Immutable<SessionSummary>): Session {
  // The archived-topics model reads topics, items and the session id only.
  const transport = new AppTransport();
  return { ...structuredClone(transport.sessions.get(route.session_id)!), id: naming.session_id } as Session;
}

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

describe('renaming from All sessions', () => {
  function setup() {
    const transport = new AppTransport();
    render(<DesktopApp service={createDesktopService(transport)} />);
    return transport;
  }
  const list = () => screen.findByRole('region', { name: 'All sessions' });
  const names = (transport: AppTransport) => transport.mutations.filter(request => request.command.command === 'session_label_set');
  const dialog = () => screen.findByRole('dialog', { name: 'Name this session' });
  const rowNames = () => [...screen.getByRole('region', { name: 'All sessions' }).querySelectorAll('.sl-name')].map(button => button.textContent);
  it('names a session in the Name dialog, and the row, the switcher and the top bar say it', { timeout: 15_000 }, async () => {
    const transport = setup();
    fireEvent.click(await within(await list()).findByRole('button', { name: 'Rename Notes review' }));
    const name = within(await dialog()).getByRole('textbox', { name: 'Name' });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: ' Sync fixes ' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Description (optional)' }), { target: { value: 'Search webhook retries' } });
    await act(async () => { fireEvent.keyDown(name, { key: 'Enter' }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull());
    expect(names(transport).map(request => ({ session: request.session, params: request.command.params }))).toEqual([
      { session: route, params: { name: 'Sync fixes', description: 'Search webhook retries' } }]);
    await waitFor(() => expect(rowNames()).toContain('Sync fixes'));
    await goToSession(route); await screen.findByRole('region', { name: 'Session tree' });
    expect(screen.getByRole('button', { name: /^Switch session or project/ }).textContent).toContain('Sync fixes');
  });
  it.each(['', ' '])('saving with nothing changed (typed %j around the same words) closes the dialog without writing', async padding => {
    const transport = new AppTransport(); transport.sessions.get(route.session_id)!.name = 'Sync fixes';
    render(<DesktopApp service={createDesktopService(transport)} />);
    fireEvent.click(await within(await list()).findByRole('button', { name: 'Rename Sync fixes' }));
    const name = within(await dialog()).getByRole('textbox', { name: 'Name' });
    expect((name as HTMLInputElement).value).toBe('Sync fixes');
    fireEvent.change(name, { target: { value: `${padding}Sync fixes${padding}` } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Save name/ })); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull());
    expect(names(transport)).toHaveLength(0);
    expect(rowNames()).toContain('Sync fixes');
  });
  it.each(['Cancel', 'Escape'])('leaves the saved name untouched after %s', async key => {
    const transport = setup();
    fireEvent.click(await within(await list()).findByRole('button', { name: 'Rename Notes review' }));
    const name = within(await dialog()).getByRole('textbox', { name: 'Name' }); fireEvent.change(name, { target: { value: 'Never saved' } });
    if (key === 'Escape') fireEvent.keyDown(name, { key }); else fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull());
    expect(rowNames()).toContain('Notes review');
    expect(names(transport)).toHaveLength(0);
  });
});
