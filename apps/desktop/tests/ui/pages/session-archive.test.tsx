import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { blockedDraft } from '../../../src/state/drafts/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from '../app/transport';
import { sessionKey } from '../../../src/ui/pages/model';
import { projectCardData } from '../../../src/components/navigation/pageData';
import { SessionRowAction } from '../../../src/ui/pages/SessionRowAction';
import { ArchivePage } from '../../../src/ui/pages/ArchivePage';
import { continueTargets } from '../../../src/ui/dialogs/ContinueTopicDialog';
import { BindSession } from '../../../src/components/navigation/Registration';
import { NavigationStore } from '../../../src/state/navigation/store';
import { waitingRows, sentRows } from '../../../src/selectors/waiting/rows';
import { agentName, sessionWhen } from '../../../src/ui/shell/model';
import demo from '../../../../../fixtures/domain/demo/session.json';
import { DiscoveryController } from '../../../src/data/discovery';
import { archivedCandidate, CandidateList } from '../../../src/components/navigation/Discovery';
import projects from '../../../../../fixtures/domain/projections/projects.json';
import sessions from '../../../../../fixtures/domain/projections/sessions.json';
import type { DesktopDiscoveryCandidate, OwnerDraft, OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import { closeImpact } from '../../../src/components/history-actions/selectors';
import type { ProjectSummary, Session, SessionSummary } from '../../../src/generated/domain/models';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { SessionLists } from '../../../src/ui/pages/SessionLists';
import { ArchiveSessionDialog } from '../../../src/ui/pages/SessionDialogs';
import { loadingError, pendingError, savingError } from '../../../src/ui/shared/lifecycleReady';

const barrierNavigations: NavigationStore[] = [];
let activeTransport: AppTransport;
afterEach(() => { cleanup(); notices.clear(); barrierNavigations.splice(0).forEach(navigation => navigation.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
/** The "Review notes" row of All sessions, a project's page or Archive; null when none lists it. */
const card = () => ([...document.querySelectorAll<HTMLElement>('.sl-row, .ar-row')].find(row => row.textContent?.includes('Review notes')) ?? null) as HTMLElement;
/** A row shows its standing by its Close: enabled on an active session, greyed ("Already closed") on a closed one (SPEC 14.2). */
const rowClosed = () => cardButton('Close').disabled;
/** A row's action by its verb: "Archive Review notes", "Restore Review notes", "Close Review notes". */
const cardButton = (verb: string) => within(card()).getByRole<HTMLButtonElement>('button', { name: new RegExp(`^${verb} `) });
const queryCardButton = (verb: string) => within(card()).queryByRole('button', { name: new RegExp(`^${verb} `) });
/** Archive rows remove behind their "…". */
function openRemove() {
  fireEvent.click(within(card()).getByRole('button', { name: /^More for / }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from Ariadne/ }));
}
/** Reopen lives on the connection card of the opened session (SPEC 14.2): open it from its row, then ask through the lifecycle review. */
async function reopen() {
  fireEvent.click(within(card()).getByRole('button', { name: 'Review notes' }));
  const dot = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]');
    expect(found).not.toBeNull(); expect(found!.disabled).toBe(false); return found!;
  });
  fireEvent.click(dot);
  const connection = await waitFor(() => { const found = document.querySelector<HTMLElement>('.cc'); expect(found).not.toBeNull(); return found!; });
  fireEvent.click(within(connection).getByRole('button', { name: 'Reopen session' }));
  const review = await screen.findByRole('dialog', { name: 'Reopen this session?' });
  await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Reopen session' })); });
}
const showTab = (name: RegExp) => fireEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name }));
const commands = (transport: AppTransport) => transport.mutations.filter(request => request.command.command !== 'preferences_patch').map(request => request.command.command);
async function setup(pending = false, all = false, transport = new AppTransport()) {
  activeTransport = transport;
  const session = transport.sessions.get(route.session_id)!;
  if (!pending) session.inputs = {};
  session.name = 'Review notes';

  if (pending) {
    const sample = Object.values(session.inputs).find(input => input)!;
    session.inputs = Object.fromEntries([0, 1].map(index => { const input = structuredClone(sample); input.id = `00000000-0000-4000-8000-00000000008${index}`; input.state = index ? 'in_flight' : 'queued'; return [input.id, input]; }));
  }
  transport.preferences.global.selected_navigation = { kind: 'project', project_id: route.project_id };
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('button', { name: /^Archive Review notes/ });
  if (all) await page('All sessions');
  if (all && session.state === 'closed') showTab(/^Closed/);
  await screen.findAllByText('Review notes');
  await waitFor(() => expect(cardButton('Archive').disabled).toBe(false));
  return transport;
}
async function archive(confirm = true) {
  await act(async () => { fireEvent.click(cardButton('Archive')); });
  const dialog = screen.queryByRole('dialog'), button = dialog && within(dialog).queryByRole('button', { name: 'Archive session' });
  if (confirm && button) await act(async () => { fireEvent.click(button); });
}
async function page(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /^Switch session or project/ }));
  const switcher = await screen.findByRole('dialog', { name: 'Switch session or project' });
  fireEvent.click(within(switcher).getByRole('button', { name }));
  await screen.findByRole('heading', { name });
}
async function waitArchived() {
  await waitFor(() => expect(activeTransport.sessions.get(route.session_id)!.archived_at).toBeTruthy());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}
async function unfold() { await page('Archive'); await screen.findAllByText('Review notes'); }

async function barrierSetup(archived = false, confirmation = false) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  session.name = 'Review notes';
  if (archived) { session.state = 'closed'; session.closed_at = session.updated_at; session.archived_at = session.updated_at; }
  transport.preferences.global.session_archive_expanded_project_ids = [route.project_id];
  const service = createDesktopService(transport), navigation = new NavigationStore(service);
  barrierNavigations.push(navigation);
  await navigation.start();
  const store = navigation.opened.open(route); await store.refresh();
  const controllers = new SessionActionControllers(service), actions = controllers.forSession(store);
  const onSaved = vi.fn(), onClose = vi.fn();
  const view = confirmation
    ? render(<ArchiveSessionDialog store={store} actions={actions} agent="codex" onClose={onClose} onSaved={onSaved} />)
    : archived ? render(<ArchivePage navigation={navigation} actions={controllers} projects={navigation.getSnapshot().projects!.projects.items}
      sessions={navigation.getSnapshot().sessions!.sessions.items} snapshots={new Map()} now={Date.now()} disabled={false} onOpenSession={() => undefined} onRemove={() => undefined}
      onAskRemove={() => undefined} onReadWords={async () => ({ words: [], complete: true })} />)
    : render(<SessionLists navigation={navigation} actions={controllers} projects={[navigation.getSnapshot().projects!.projects.items[0]!]} single
      sessions={navigation.getSnapshot().sessions!.sessions.items} now={Date.now()} narrow={false} disabled={false} onOpenSession={() => undefined} />);
  return { transport, session, store, actions, controllers, navigation, onSaved, onClose, ...view };
}

/** Hold both the actual save and its reader's volatile-presence refresh. */
function holdPause(transport: AppTransport) {
  let save!: () => void, presence!: () => void, saved = false;
  const saveGate = new Promise<void>(resolve => { save = resolve; });
  const presenceGate = new Promise<void>(resolve => { presence = resolve; });
  const invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'binding_pause') {
      await saveGate;
      const result = await invoke(name, args); saved = true; return result;
    }
    if (saved && name === 'session_list') await presenceGate;
    return invoke(name, args);
  });
  return { save, presence };
}

function pause(fixture: Awaited<ReturnType<typeof barrierSetup>>) {
  const binding = fixture.session.bindings[fixture.session.active_binding_id!]!;
  return fixture.actions.execute({ command: 'binding_pause', api_version: 1, op_id: '', params: { binding_id: binding.id, expected_generation: binding.generation } }, fixture.session.revision);
}

describe('Session lifecycle write readiness', () => {
  it.each([false, true])('waits for a save and its presence refresh before %s Archive/Restore uses the current revision', async archived => {
    const fixture = await barrierSetup(archived), gates = holdPause(fixture.transport);
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); });
    const original = fixture.session.revision;
    await act(async () => { fireEvent.click(cardButton(archived ? 'Restore' : 'Archive')); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commands(fixture.transport)).toEqual([]);
    await act(async () => { gates.save(); });
    await waitFor(() => expect(fixture.actions.getSnapshot()).toMatchObject({ writing: true, pending: null }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    await act(async () => { gates.presence(); await write; });
    if (!archived) {
      const dialog = await screen.findByRole('dialog', { name: 'Archive this session?' });
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Archive session' })); });
    }
    await waitFor(() => expect(commands(fixture.transport)).toEqual(['binding_pause', archived ? 'session_restore' : 'session_archive']));
    expect(fixture.transport.mutations.at(-1)?.command).toMatchObject({ params: { expected_revision: original + 1 } });
  });

  it('refuses a different lifecycle action while an uncertain saved action still needs Check again', async () => {
    const fixture = await barrierSetup();
    fixture.transport.failNext = 'binding_pause';
    await act(async () => { expect(await pause(fixture)).toBe(false); });
    const pending = fixture.actions.getSnapshot().pending;
    await act(async () => { fireEvent.click(cardButton('Archive')); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    expect(fixture.actions.getSnapshot().pending).toBe(pending);
    expect(notices.getSnapshot().map(notice => notice.text)).toContain(`For the “Review notes” session: ${pendingError}`);
  });

  it('times out Restore in plain words and never submits it when the old write eventually finishes', async () => {
    const fixture = await barrierSetup(true), gates = holdPause(fixture.transport);
    vi.useFakeTimers();
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(cardButton('Restore')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notices.getSnapshot().map(notice => notice.text)).toContain(`For the “Review notes” session: ${savingError}`);
    await act(async () => { gates.save(); gates.presence(); await write; });
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    expect(fixture.session.archived_at).toBeTruthy();
  });

  it('requires a renewed archive confirmation when a concurrent save refreshes its cancellation impacts', async () => {
    const fixture = await barrierSetup(false, true), gates = holdPause(fixture.transport);
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(screen.getByRole('button', { name: 'Archive session' })); });
    // A question becomes waiting as the save reaches disk, before its fresh reader completes.
    const item = Object.values(fixture.session.items).find(item => item?.status !== 'waiting_on_me')!;
    item.status = 'waiting_on_me';
    await act(async () => { gates.save(); });
    await waitFor(() => expect(fixture.actions.getSnapshot()).toMatchObject({ writing: true, pending: null }));
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    await act(async () => { gates.presence(); await write; });
    expect(screen.getByText('The session changed. Check the updated details, then confirm again.')).toBeTruthy();
    expect(screen.getByText(new RegExp(`${closeImpact(fixture.session).questions} questions are still open`))).toBeTruthy();
    expect(fixture.onSaved).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive session' })); });
    expect(commands(fixture.transport)).toEqual(['binding_pause', 'session_archive']);
    expect(fixture.onSaved).toHaveBeenCalledOnce();
  });

  it('cancels an archive confirmation wait without a late save after the previous write finishes', async () => {
    const fixture = await barrierSetup(false, true), gates = holdPause(fixture.transport);
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(screen.getByRole('button', { name: 'Archive session' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fixture.onClose).toHaveBeenCalledOnce();
    fixture.unmount();
    await act(async () => { gates.save(); gates.presence(); await write; });
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    expect(fixture.onSaved).not.toHaveBeenCalled();
  });

  it('Close confirmation also waits for a saved change to finish refreshing before using its revision', async () => {
    const fixture = await barrierSetup(false, true), gates = holdPause(fixture.transport);
    fixture.rerender(<SessionRowAction actions={fixture.actions} act="close" onDone={fixture.onClose} />);
    const review = await screen.findByRole('dialog', { name: /^Close / });
    const original = fixture.session.revision;
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(within(review).getByRole('button', { name: 'Close session' })); });
    await act(async () => { gates.save(); });
    await waitFor(() => expect(fixture.actions.getSnapshot()).toMatchObject({ writing: true, pending: null }));
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    await act(async () => { gates.presence(); await write; });
    await waitFor(() => expect(fixture.onClose).toHaveBeenCalledOnce());
    expect(commands(fixture.transport)).toEqual(['binding_pause', 'session_close']);
    expect(fixture.transport.mutations.at(-1)?.command).toMatchObject({ params: { expected_revision: original + 1 } });
  });

  it('card Rename waits for the same post-save refresh before saving the entered label', async () => {
    const fixture = await barrierSetup(), gates = holdPause(fixture.transport);
    fireEvent.click(cardButton('Rename'));
    fireEvent.change((await screen.findByRole('textbox', { name: 'Name' })), { target: { value: 'Ready to review' } });
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(screen.getByRole('button', { name: /^Save name/ })); });
    await act(async () => { gates.save(); });
    await waitFor(() => expect(fixture.actions.getSnapshot()).toMatchObject({ writing: true, pending: null }));
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    await act(async () => { gates.presence(); await write; });
    await waitFor(() => expect(fixture.session.name).toBe('Ready to review'));
    expect(commands(fixture.transport)).toEqual(['binding_pause', 'session_label_set']);
  });

  it.each(['Archive', 'Rename'] as const)('leaving the session page cancels its %s wait before the old save finishes', async action => {
    const fixture = await barrierSetup(), gates = holdPause(fixture.transport);
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); });
    fireEvent.click(cardButton(action));
    if (action === 'Rename') {
      fireEvent.change((await screen.findByRole('textbox', { name: 'Name' })), { target: { value: 'Ready to review' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save name/ }));
    }
    fixture.unmount();
    await act(async () => { gates.save(); gates.presence(); await write; });
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    expect(fixture.session.name).toBe('Review notes');
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('Undo waits for a different save to settle and restores with the current revision', async () => {
    const fixture = await barrierSetup();
    await archive();
    await waitFor(() => expect(cardButton('Archive').disabled).toBe(false));
    const undo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
    const gates = holdPause(fixture.transport);
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); undo(); undo(); });
    expect(commands(fixture.transport)).toEqual(['session_archive']);
    await act(async () => { gates.save(); });
    await waitFor(() => expect(fixture.actions.getSnapshot()).toMatchObject({ writing: true, pending: null }));
    expect(commands(fixture.transport)).toEqual(['session_archive', 'binding_pause']);
    await act(async () => { gates.presence(); await write; });
    await waitFor(() => expect(commands(fixture.transport)).toEqual(['session_archive', 'binding_pause', 'session_restore']));
    expect(fixture.session.archived_at).toBeUndefined();
    expect(fixture.transport.mutations.at(-1)?.command).toMatchObject({ params: { expected_revision: fixture.session.revision - 1, reopen: true } });
    expect(notices.getSnapshot().some(notice => notice.actions?.some(action => action.label === 'Undo'))).toBe(false);
  });
});

describe('Session archive cards', () => {
  it('Undo reads changes made after archive before submitting Restore', async () => {
    const transport = await setup(), session = transport.sessions.get(route.session_id)!;
    await archive(); await waitArchived();
    const archivedRevision = session.revision;
    // No hint: Undo itself must read the authoritative session at click time.
    session.description = 'Updated while archived'; ++session.revision;
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(session.archived_at).toBeUndefined());
    expect(transport.mutations.find(request => request.command.command === 'session_restore')?.command)
      .toMatchObject({ params: { expected_revision: archivedRevision + 1, reopen: true } });
    expect(session.description).toBe('Updated while archived');
    expect(session.state).toBe('active');
  });

  it('dismisses an archive receipt after an authoritative external restore, even after leaving the page', async () => {
    const transport = await setup(), session = transport.sessions.get(route.session_id)!;
    await archive(); await waitArchived();
    const staleUndo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
    await page('Projects');
    await screen.findByRole('heading', { name: 'Projects' });
    await act(async () => {
      delete session.archived_at; ++session.revision;
      transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
    });
    await waitFor(() => expect(notices.getSnapshot().some(notice => notice.id.startsWith('session-archive:'))).toBe(false));
    await act(async () => { staleUndo(); });
    expect(commands(transport)).toEqual(['session_archive']);
    expect(session.state).toBe('closed');
  });

  it('keeps the receipt through an incomplete catalogue and clears it after restore with its reader closed', async () => {
    const fixture = await barrierSetup();
    await archive();
    await waitFor(() => expect(cardButton('Archive').disabled).toBe(false));
    fixture.navigation.opened.close(route); fixture.unmount();
    fixture.transport.sessions.delete(route.session_id);
    await act(async () => { await fixture.navigation.refresh(); });
    expect(notices.getSnapshot().some(notice => notice.id.startsWith('session-archive:'))).toBe(true);
    fixture.transport.sessions.set(route.session_id, fixture.session);
    delete fixture.session.archived_at; ++fixture.session.revision;
    await act(async () => { await fixture.navigation.refresh(); });
    expect(notices.getSnapshot().some(notice => notice.id.startsWith('session-archive:'))).toBe(false);
    expect(commands(fixture.transport)).toEqual(['session_archive']);
  });

  it('keeps a rejected Undo actionable and uses a fresh revision and operation on retry', async () => {
    class RejectedUndo extends AppTransport {
      requests: OwnerMutationRequest[] = [];
      override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
        if ('command' in args.request && args.request.command.command === 'session_restore') {
          this.requests.push(structuredClone(args.request));
          if (this.requests.length === 1) return { api_version: 1, ok: false,
            error: { code: 'invalid_transition', message: 'Fixture refusal', hint: '', retryable: true, field_errors: [] } } as T;
        }
        return super.invoke<T>(name, args);
      }
    }
    const transport = new RejectedUndo(), session = transport.sessions.get(route.session_id)!;
    await setup(false, false, transport);
    await archive(); await waitArchived();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Undo' })); });
    expect(session.archived_at).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(notices.getSnapshot().find(notice => notice.id.startsWith('session-archive:'))!.text).toContain('try again');
    expect(notices.getSnapshot().find(notice => notice.id.startsWith('session-archive:'))!.text).toContain('For the “Review notes” session:');
    await page('Projects');
    await screen.findByRole('heading', { name: 'Projects' });
    expect(within(screen.getByRole('region', { name: 'Notifications' })).getByText(/^For the “Review notes” session:/)).toBeTruthy();
    ++session.revision;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(session.archived_at).toBeUndefined());
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.command).toMatchObject({ params: { expected_revision: session.revision - 1, reopen: true } });
    expect(transport.requests[1]!.command.op_id).not.toBe(transport.requests[0]!.command.op_id);
  });

  it('retries an uncertain Undo from its notice with the exact pending request', async () => {
    class UncertainUndo extends AppTransport {
      requests: OwnerMutationRequest[] = [];
      override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
        if ('command' in args.request && args.request.command.command === 'session_restore') {
          this.requests.push(structuredClone(args.request));
          if (this.requests.length === 1) throw new Error('Fixture transport failure');
        }
        return super.invoke<T>(name, args);
      }
    }
    const transport = new UncertainUndo();
    await setup(false, false, transport);
    await archive(); await waitArchived();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Undo' })); });
    const notification = screen.getByRole('region', { name: 'Notifications' });
    await act(async () => { fireEvent.click(within(notification).getByRole('button', { name: 'Check again' })); });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]).toEqual(transport.requests[0]);
    expect(transport.sessions.get(route.session_id)!.archived_at).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Restored and reopened “Review notes”.')).toBeTruthy();
  });

  it.each([undefined, 'Shared name'])('keeps separate Undo notices for two archived sessions named %s', async name => {
    const transport = new AppTransport(), ids = [route.session_id, secondId];
    for (const id of ids) {
      const session = transport.sessions.get(id)!;
      session.name = name; session.state = 'closed'; session.closed_at = session.updated_at; session.inputs = {};
      for (const item of Object.values(session.items)) if (item?.status === 'waiting_on_me') item.status = 'open';
    }
    transport.preferences.global.selected_navigation = { kind: 'project', project_id: route.project_id };
    // The newer session lists first, so the rows read in `ids` order.
    transport.sessions.get(secondId)!.updated_at = new Date(Date.parse(transport.sessions.get(route.session_id)!.updated_at) - 60_000).toISOString();
    render(<DesktopApp service={createDesktopService(transport)} />);
    const archiveButtons = () => screen.getAllByRole<HTMLButtonElement>('button', { name: /^Archive / });
    for (const id of ids) {
      await waitFor(() => expect(archiveButtons()[0]!.disabled).toBe(false));
      await act(async () => { fireEvent.click(archiveButtons()[0]!); });
      await waitFor(() => expect(transport.sessions.get(id)!.archived_at).toBeTruthy());
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2));
    const when = sessionWhen(Date.parse(transport.sessions.get(route.session_id)!.created_at), Date.now()).toLowerCase();
    const text = name ? `Archived “${name}”.` : `Archived the demo.local session from ${when}.`;
    expect(screen.getAllByText(text)).toHaveLength(2);
    const undoFor = (id: string) => within(document.querySelector<HTMLElement>(`[data-notice-id="session-archive:${route.project_id}:${id}"]`)!)
      .getByRole('button', { name: 'Undo' });
    await act(async () => { fireEvent.click(undoFor(route.session_id)); });
    await waitFor(() => expect(archiveButtons().map(button => button.disabled)).toEqual([false]));
    expect(transport.sessions.get(route.session_id)!.archived_at).toBeUndefined();
    expect(transport.sessions.get(secondId)!.archived_at).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(transport.mutations.filter(request => request.command.command === 'session_restore').map(request => request.session)).toEqual([route]);
    await act(async () => { fireEvent.click(undoFor(secondId)); });
    await waitFor(() => expect(archiveButtons().map(button => button.disabled)).toEqual([false, false]));
    expect(transport.sessions.get(secondId)!.archived_at).toBeUndefined();
    expect(transport.mutations.filter(request => request.command.command === 'session_restore').map(request => request.session))
      .toEqual([route, { ...route, session_id: secondId }]);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    await waitFor(() => expect(screen.getAllByText(name ? `Restored “${name}”; it stays closed.` : `Restored the demo.local session from ${when}; it stays closed.`)).toHaveLength(2));
  });

  it('keeps identical Restore failures separate for two sessions', async () => {
    const fixture = await barrierSetup(true), second = fixture.transport.sessions.get(secondId)!;
    second.name = fixture.session.name; second.state = 'closed'; second.closed_at = second.updated_at; second.archived_at = second.updated_at;
    await fixture.navigation.refresh();
    fixture.rerender(<ArchivePage navigation={fixture.navigation} actions={fixture.controllers} projects={fixture.navigation.getSnapshot().projects!.projects.items}
      sessions={fixture.navigation.getSnapshot().sessions!.sessions.items} snapshots={new Map()} now={Date.now()} disabled={false} onOpenSession={() => undefined} onRemove={() => undefined}
      onAskRemove={() => undefined} onReadWords={async () => ({ words: [], complete: true })} />);
    const invoke = fixture.transport.invoke.bind(fixture.transport);
    vi.spyOn(fixture.transport, 'invoke').mockImplementation(async (name, args) => name === 'session_get'
      ? { api_version: 1, ok: false, error: { code: 'io_error', message: 'Fixture read failed', hint: '', retryable: true, field_errors: [] } }
      : invoke(name, args));
    for (const button of screen.getAllByRole('button', { name: 'Restore Review notes' })) {
      await act(async () => { fireEvent.click(button); });
    }
    fixture.unmount();
    const errors = notices.getSnapshot().filter(notice => notice.text === `For the “Review notes” session: ${loadingError}`);
    expect(errors).toHaveLength(2);
    expect(new Set(errors.map(notice => notice.id)).size).toBe(2);
    expect(commands(fixture.transport)).toEqual([]);
  });

  it('keeps identical archived-topic Restore failures separate for two sessions', async () => {
    const fixture = await barrierSetup(), second = fixture.transport.sessions.get(secondId)!;
    second.name = fixture.session.name;
    const topic = structuredClone(Object.values(fixture.session.topics).find(topic => topic)!);
    topic.archived_at = fixture.session.updated_at;
    fixture.session.topics = { [topic.id]: structuredClone(topic) }; second.topics = { [topic.id]: structuredClone(topic) };
    await fixture.navigation.refresh();
    fixture.rerender(<ArchivePage navigation={fixture.navigation} actions={fixture.controllers} projects={fixture.navigation.getSnapshot().projects!.projects.items}
      sessions={fixture.navigation.getSnapshot().sessions!.sessions.items}
      snapshots={new Map([[sessionKey(route), fixture.session], [sessionKey({ ...route, session_id: secondId }), second]])}
      now={Date.now()} disabled={false} onOpenSession={() => undefined} onRemove={() => undefined}
      onAskRemove={() => undefined} onReadWords={async () => ({ words: [], complete: true })} />);
    for (const button of screen.getAllByRole('button', { name: `Restore ${topic.name}` })) {
      await act(async () => { fireEvent.click(button); });
    }
    const errors = notices.getSnapshot().filter(notice => notice.id.startsWith('topic-restore-failed:'));
    expect(errors).toHaveLength(2);
    expect(new Set(errors.map(notice => notice.id)).size).toBe(2);
    expect(errors[0]!.text).toBe(errors[1]!.text);
    expect(errors[0]!.text).toContain(`For “${topic.name}” in the “Review notes” session:`);
    fixture.unmount();
    expect(notices.getSnapshot().filter(notice => notice.id.startsWith('topic-restore-failed:'))).toEqual(errors);
    expect(commands(fixture.transport)).toEqual(['topic_restore', 'topic_restore']);
  });

  it.each([null, 'Shared name'])('keeps cancellation receipts for two closed sessions named %s separate', async name => {
    const fixture = await barrierSetup(), second = fixture.transport.sessions.get(secondId)!;
    const sample = Object.values(fixture.session.inputs).find(input => input?.state === 'queued')!;
    expect(sample).toBeTruthy();
    fixture.session.inputs = { [sample.id]: structuredClone(sample) };
    second.inputs = { [sample.id]: structuredClone(sample) };
    await fixture.store.refresh(true);
    const secondRoute = { ...route, session_id: secondId }, secondStore = fixture.navigation.opened.open(secondRoute);
    await secondStore.refresh();
    // The review reads its words from the session itself: a new revision carries the name to both stores.
    for (const session of [fixture.session, second]) { session.name = name ?? undefined; session.revision += 1; }
    await fixture.store.refresh(true); await secondStore.refresh(true);
    for (const store of [fixture.store, secondStore]) {
      fixture.rerender(<SessionRowAction key={store.getSnapshot().route.session_id} actions={fixture.controllers.forSession(store)} act="close" onDone={fixture.onClose} />);
      const review = await screen.findByRole('dialog', { name: /^Close / });
      await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Close session' })); });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Close / })).toBeNull());
    }
    const when = sessionWhen(Date.parse(fixture.session.created_at), Date.now()).toLowerCase();
    const agent = agentName(fixture.session.bindings[fixture.session.active_binding_id!]!.adapter_id);
    const subject = name ? `the “${name}” session` : `the ${agent} session from ${when}`;
    const text = `Closed ${subject}. 1 unsent message was cancelled.`;
    const receipts = notices.getSnapshot().filter(notice => notice.text === text);
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map(notice => notice.id)).size).toBe(2);
    expect(commands(fixture.transport)).toEqual(['session_close', 'session_close']);
  });

  it('keeps session archive confirmation counts unchanged by Open Ack proposals', async () => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    const before = closeImpact(session);
    const item = session.items['1.1']!;
    expect(item.status).toBe('open');
    item.ack_to = 'done';
    expect(closeImpact(session)).toEqual(before);
    await setup(true, false, transport);
    const impact = closeImpact(session);
    await archive(false);
    const warning = screen.getByRole('dialog').textContent;
    item.ack_to = null;
    expect(closeImpact(session)).toEqual(impact);
    expect(screen.getByRole('dialog').textContent).toBe(warning);
    expect(warning).toContain(`${impact.questions} question`);
    expect(warning).not.toContain('to ack');
    expect(commands(transport)).toEqual([]);
  });
  it.each([false, true])('archives from project/all sessions (%s), restores Closed, then reopens from All sessions', async all => {
    const transport = await setup(false, all);
    await archive(); await waitArchived();
    expect(screen.queryByRole('dialog')).toBeNull(); expect(card()).toBeNull();
    expect(commands(transport)).toEqual(['session_archive']); expect(transport.sessions.get(route.session_id)).toMatchObject({ state: 'closed' });
    await unfold();
    expect(queryCardButton('Reopen')).toBeNull();
    await act(async () => { fireEvent.click(cardButton('Restore')); });
    await waitFor(() => expect(transport.sessions.get(route.session_id)!.archived_at).toBeUndefined());
    await page('All sessions'); showTab(/^Closed/);
    await waitFor(() => expect(rowClosed()).toBe(true));
    expect(transport.sessions.get(route.session_id)!.state).toBe('closed');
    await reopen();
    expect(commands(transport)).toEqual(['session_archive', 'session_restore', 'session_reopen']);
  }, 15000);

  it.each([false, true])('confirms cancellation in plain words; Cancel preserves messages, then Undo resumes sending with owner paused=%s', async paused => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    session.bindings[session.active_binding_id!]!.owner_paused = paused;
    session.bindings[session.active_binding_id!]!.dispatch_state = paused ? 'paused' : 'enabled';
    const transport = await setup(true, false, fixture);
    // Use exactly two pending messages, regardless of the broader demo queue.
    const pending = Object.values(session.inputs).filter(input => input && ['queued', 'in_flight', 'needs_attention'].includes(input.state)).slice(0, 2);
    session.inputs = Object.fromEntries(pending.map(input => [input!.id, input!]));
    await archive(false);
    expect(screen.getByText(/1 of your messages hasn’t reached .+ and 1 is being delivered — archiving cancels them/)).toBeTruthy();
    expect(screen.getByText(/questions? (?:is|are) still open\. Restore and reopen the session before answering\./)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(commands(transport)).toEqual([]);
    await archive();
    await waitArchived();
    expect(Object.values(session.inputs).every(input => input?.state === 'cancelled')).toBe(true);
    expect((await screen.findByText('Archived and closed “Review notes”. 2 unsent messages were cancelled. Undo resumes sending, even if you paused it. Cancelled messages stay cancelled.'))).toBeTruthy();
    const undo = (await screen.findByRole('button', { name: 'Undo' }));
    const staleUndo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
    await act(async () => { fireEvent.click(undo); staleUndo(); });
    await waitFor(() => expect(cardButton('Close')).toBeTruthy());
    expect(commands(transport)).toEqual(['session_archive', 'session_restore']);
    expect(transport.mutations.find(request => request.command.command === 'session_restore')?.command).toMatchObject({ params: { reopen: true } });
    expect(session.state).toBe('active');
    expect(session.bindings[session.active_binding_id!]!).toMatchObject({ owner_paused: false, dispatch_state: 'enabled' });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(Object.values(session.inputs).every(input => input?.state === 'cancelled')).toBe(true);
  });

  it('keeps a quick Undo retriable while the archive navigation refresh is still running', async () => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    session.state = 'closed'; session.closed_at = session.updated_at;
    for (const item of Object.values(session.items)) if (item?.status === 'waiting_on_me') item.status = 'open';
    const transport = await setup(false, false, fixture);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (name === 'project_list') await gate;
      return invoke(name, args);
    });
    try {
      await archive();
      await screen.findByText('Archived “Review notes”.');
      const undo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
      await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); undo(); });
      expect(await screen.findByText('For the “Review notes” session: The session could not be restored while another change is finishing. Try again.')).toBeTruthy();
      expect(commands(transport)).toEqual(['session_archive']);
      expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
      expect(session.archived_at).toBeTruthy();
    } finally { await act(async () => { release(); }); }
    await waitFor(() => expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    await waitFor(() => expect(session.archived_at).toBeUndefined());
    expect(commands(transport)).toEqual(['session_archive', 'session_restore']);
  });

  it('keeps an archived session readable, blocks owner input, offers Restore before Reopen, and retains Remove', async () => {
    const transport = await setup();
    await archive(); await unfold();
    openRemove();
    expect(screen.getByRole('dialog', { name: /^Remove / })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: /^Remove / })).getByRole('button', { name: /^Cancel/ }));
    expect(cardButton('Restore')).toBeTruthy();
    expect(queryCardButton('Reopen')).toBeNull();
    const session = transport.sessions.get(route.session_id)!, item = session.items['1']!;
    expect(session.archived_at).toBeTruthy();
    const draft = { session: route, target: { item_id: item.id, topic_id: item.topic_id } } as OwnerDraft;
    expect(blockedDraft(draft, session)).toBe('This session is archived. Restore it, then reopen it to send this reply.');
  }, 15000);

  it('an Archive row opens the archived session to read, without restoring it; its card offers Restore session', async () => {
    const transport = await setup();
    await archive(); await unfold();
    fireEvent.click(within(card()).getByRole('button', { name: 'Review notes' }));
    const dot = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]');
      expect(found).not.toBeNull(); expect(found!.disabled).toBe(false); return found!;
    });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready'));
    fireEvent.click(dot);
    const connection = within(await waitFor(() => { const found = document.querySelector<HTMLElement>('.cc'); expect(found).not.toBeNull(); return found!; }));
    expect(connection.queryByRole('button', { name: 'Reopen session' })).toBeNull();
    expect(connection.getByRole('button', { name: 'Restore session' })).toBeTruthy();
    expect(transport.sessions.get(route.session_id)!.archived_at).toBeTruthy();
    expect(commands(transport)).toEqual(['session_archive']);
    await act(async () => { fireEvent.click(connection.getByRole('button', { name: 'Restore session' })); });
    await waitFor(() => expect(commands(transport)).toEqual(['session_archive', 'session_restore']));
  }, 15000);

  it('archives an already Closed session and lets Remove hide it until Undo', async () => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    session.state = 'closed'; session.closed_at = session.updated_at;
    const transport = await setup(false, false, fixture);
    expect(rowClosed()).toBe(true);
    await archive(); await unfold(); notices.clear();
    openRemove();
    // Remove waits until the session's words are read and quoted (E27).
    const remove = await waitFor(() => { const button = within(screen.getByRole('dialog', { name: /^Remove / })).getByRole<HTMLButtonElement>('button', { name: 'Remove session' }); expect(button.disabled).toBe(false); return button; });
    await act(async () => { fireEvent.click(remove); });
    await waitFor(() => expect(card()).toBeNull());
    fireEvent.click((await screen.findByRole('button', { name: 'Undo' })));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(cardButton('Restore')).toBeTruthy();
    expect(commands(transport)).toEqual(['session_archive']);
  }, 15000);

  it.each([
    ['active', false, false, true],
    ['closed', true, false, true],
    ['closed', false, true, true],
    ['closed', false, false, false],
  ] as const)('confirms %s with waiting=%s pending=%s: %s', async (state, waiting, pending, confirm) => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    session.state = state; session.closed_at = state === 'closed' ? session.updated_at : null;
    for (const item of Object.values(session.items)) if (item?.status === 'waiting_on_me') item.status = 'open';
    if (waiting) Object.values(session.items).find(item => item)!.status = 'waiting_on_me';
    const transport = await setup(pending, false, fixture);
    await archive(false);
    if (confirm) {
      const dialog = await screen.findByRole('dialog');
      expect(commands(transport)).toEqual([]);
      if (waiting) expect(within(dialog).getByText('1 question is still open. Restore and reopen the session before answering.')).toBeTruthy();
    } else {
      await waitArchived();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await screen.findByText('Archived “Review notes”.')).toBeTruthy();
    }
  });

  it('Undo of a Closed session keeps it Closed and sending paused', async () => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    session.state = 'closed'; session.closed_at = session.updated_at;
    const closedAt = session.closed_at;
    await setup(false, false, fixture);
    await archive();
    await waitArchived();
    expect(await screen.findByText('Archived “Review notes”.')).toBeTruthy();
    await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); });
    await waitFor(() => expect(rowClosed()).toBe(true));
    expect(session).toMatchObject({ state: 'closed', closed_at: closedAt });
    expect(session.bindings[session.active_binding_id!]!).toMatchObject({ owner_paused: true });
  });

  it('counts and announces only cancellations, excluding an in-flight committed result', async () => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    const sample = structuredClone(Object.values(session.inputs).find(input => input?.attempts.some(attempt => attempt.domain_result))!);
    expect(sample).toBeTruthy();
    sample.state = 'in_flight';
    const attempt = sample.attempts.find(attempt => attempt.domain_result)!;
    attempt.result_state = 'committed'; attempt.sealed_at = null; sample.active_attempt_id = attempt.id;
    session.inputs = { [sample.id]: sample };
    expect(closeImpact(session).delivering).toBe(0);
    await setup(false, false, fixture);
    session.inputs = { [sample.id]: sample };
    await archive(false);
    expect(screen.queryByText(/being delivered/)).toBeNull();
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive session' })); });
    await waitArchived();
    expect(await screen.findByText('Archived and closed “Review notes”.')).toBeTruthy();
    expect(screen.queryByText(/unsent message.*cancelled/)).toBeNull();
  });

  it.each(['active', 'closed'] as const)('Undo preserves the state submitted after %s confirmation refreshes', async initial => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    session.state = initial; session.closed_at = initial === 'closed' ? session.updated_at : null;
    await setup(false, false, transport);
    await archive(false);
    const dialog = await screen.findByRole('dialog');
    const submitted = initial === 'active' ? 'closed' : 'active';
    await act(async () => {
      session.state = submitted;
      session.closed_at = submitted === 'closed' ? session.updated_at : null;
      ++session.revision;
      transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
    });
    await waitFor(() => expect(within(dialog).queryByText(/Archiving closes this session/, { exact: false }) !== null).toBe(submitted === 'active'));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Archive session' })); });
    await waitArchived();
    expect(await screen.findByText(submitted === 'active' ? 'Archived and closed “Review notes”.' : 'Archived “Review notes”.')).toBeTruthy();
    await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); });
    await waitFor(() => expect(rowClosed()).toBe(submitted === 'closed'));
    await waitFor(() => expect(session.state).toBe(submitted));
    expect(transport.mutations.find(request => request.command.command === 'session_restore')?.command).toMatchObject({ params: { expected_revision: session.revision - 1 } });
    expect(session.bindings[session.active_binding_id!]!.owner_paused).toBe(submitted === 'closed');
  });

  it('prunes removed projects from archive expansion on load and the next layout save', async () => {
    const fixture = new AppTransport();
    fixture.preferences.global.session_archive_expanded_project_ids = [route.project_id, secondId];
    const store = new NavigationStore(createDesktopService(fixture));
    try {
      await store.start();
      expect(store.getSnapshot().preferences!.global.session_archive_expanded_project_ids).toEqual([route.project_id]);
      expect(await store.saveLayout({ waiting_collapsed: true }, fixture.preferences.revision)).toBe(true);
      expect(fixture.preferences.global.session_archive_expanded_project_ids).toEqual([route.project_id]);
    } finally { store.stop(); }
  });

  it('reconciles a lost Undo response with one exact restore-and-reopen action', async () => {
    class LostUndoTransport extends AppTransport {
      receipt: unknown;
      requests: OwnerMutationRequest[] = [];
      override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
        if ('command' in args.request && args.request.command.command === 'session_restore') {
          this.requests.push(structuredClone(args.request));
          if (this.receipt) return this.receipt as T;
          this.receipt = await super.invoke<T>(name, args); throw new Error('Lost Undo response');
        }
        return super.invoke<T>(name, args);
      }
    }
    const transport = new LostUndoTransport();
    await setup(false, false, transport);
    await archive(); await waitArchived();
    const undo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
    await act(async () => { undo(); undo(); });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: /^Sending to / });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' })); });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]).toEqual(transport.requests[0]);
    expect(transport.sessions.get(route.session_id)!.state).toBe('active');
    expect(await screen.findByText('Restored and reopened “Review notes”.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 15000);

  it.each(['active', 'closed'] as const)('reconciles a lost %s archive response before Undo restores the submitted state', async initial => {
    class LostResponseTransport extends AppTransport {
      private receipt: unknown;
      private archiveRequests: OwnerMutationRequest[] = [];
      override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
        if ('command' in args.request && args.request.command.command === 'session_archive') {
          this.archiveRequests.push(structuredClone(args.request));
          if (this.receipt) { expect(this.archiveRequests[1]).toEqual(this.archiveRequests[0]); return this.receipt as T; }
          this.receipt = await super.invoke<T>(name, args); throw new Error('Lost response');
        }
        return super.invoke<T>(name, args);
      }
    }
    const fixture = new LostResponseTransport(), session = fixture.sessions.get(route.session_id)!;
    session.state = initial; session.closed_at = initial === 'closed' ? session.updated_at : null;
    if (initial === 'closed') for (const item of Object.values(session.items)) if (item?.status === 'waiting_on_me') item.status = 'open';
    const transport = await setup(false, false, fixture);
    await archive();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Archive session' })).toBeNull();
    await act(async () => { transport.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision }); });
    await waitFor(() => expect(within(dialog).queryByText(/Archiving closes this session/, { exact: false })).toBeNull());
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Check again' })); });
    await waitArchived();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await screen.findByRole('button', { name: 'Undo' }))).toBeTruthy();
    expect(commands(transport)).toEqual(['session_archive']);
    await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); });
    await waitFor(() => expect(rowClosed()).toBe(initial === 'closed'));
    expect(session.state).toBe(initial);
    const restore = transport.mutations.find(request => request.command.command === 'session_restore')!.command;
    expect(restore.command === 'session_restore' && !!restore.params.reopen).toBe(initial === 'active');
  }, 15000);
});

describe('Archived sessions stay out of active projections and targets', () => {
  it('excludes archive from Connect existing session while keeping ordinary sessions available', () => {
    const service = createDesktopService(new AppTransport()), store = new NavigationStore(service);
    const active = { ...structuredClone(sessions.items[0]), name: 'Available session' } as SessionSummary;
    const archived = { ...active, session_id: secondId, name: 'Archived session', archived_at: '2026-10-09T00:00:00.000Z' };
    try {
      render(<BindSession store={store} project={projects.items[0] as ProjectSummary} sessions={[active, archived]} adapters={[]}
        disabled={false} close={() => undefined} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Attach to an existing Ariadne session' }));
      const select = screen.getByRole('combobox', { name: 'Registered Ariadne session' });
      expect(within(select).getByRole('option', { name: /Available session/ })).toBeTruthy();
      expect(within(select).queryByRole('option', { name: /Archived session/ })).toBeNull();
    } finally { store.stop(); }
  });
  it('removes archive from Waiting and sent messages', () => {
    const session = structuredClone(demo) as Session;
    const summary = sessions.items[0] as SessionSummary, project = projects.items[0] as ProjectSummary;
    const capture = { session, summary, project };
    expect(waitingRows([capture]).length + sentRows([capture]).length).toBeGreaterThan(0);
    session.archived_at = '2026-10-09T00:00:00.000Z';
    expect(waitingRows([capture])).toEqual([]); expect(sentRows([capture])).toEqual([]);

  });
  it.each([undefined, projects.items[0].canonical_root])('hides archived host sessions from discovery with project root %s', async root => {
    const summary = { ...structuredClone(sessions.items[0]), archived_at: '2026-10-09T00:00:00.000Z' } as SessionSummary;
    const candidate: DesktopDiscoveryCandidate = { session: route, binding_id: summary.active_binding!.id, adapter_id: 'codex',
      endpoint: { kind: 'unix_socket', path: '/tmp/fixture.sock' }, external_session_id: 'fixture-thread', cwd: projects.items[0].canonical_root,
      title: 'Archived host thread', host_version: 'fixture', observed_at: summary.updated_at, freshness: 'fresh', compatibility: 'unknown', availability: 'unknown', loaded: true };
    class DiscoveryTransport extends AppTransport { discovery = async () => ({ candidates: [candidate], error: null }); setConnectionUiOpen = async () => {}; }
    const controller = new DiscoveryController(createDesktopService(new DiscoveryTransport()));
    const release = controller.acquire();
    try {
      await controller.refresh();
      render(<CandidateList controller={controller} sessions={[summary]} root={root} select={() => undefined} />);
      expect(screen.queryByText('Archived host thread')).toBeNull();
      expect(screen.queryByRole('button', { name: root ? 'Use host session' : 'Register this project' })).toBeNull();
      expect(await screen.findByText(/No discovered host sessions/)).toBeTruthy();
    } finally { release(); controller.dispose(); }
  });
  it('excludes archive from project counts, agent lists, last activity and Continue targets', () => {
    const active = structuredClone(sessions.items[0]) as SessionSummary;
    const archived = { ...active, session_id: secondId, archived_at: '2026-10-09T00:00:00.000Z', updated_at: '2099-01-01T00:00:00.000Z' };
    const project = structuredClone(projects.items[0]) as ProjectSummary;
    const before = projectCardData(project, [active], Date.parse(active.updated_at), null);
    expect(projectCardData(project, [active, archived], Date.parse(active.updated_at), null)).toEqual(before);
    expect(continueTargets({ ...route, session_id: 'other' }, [active, archived]).map(target => target.route.session_id)).toEqual([active.session_id]);
  });
  it('recognizes archive through the discovered route and through the external binding identity', () => {
    const summary = { ...structuredClone(sessions.items[0]), archived_at: '2026-10-09T00:00:00.000Z' } as SessionSummary;
    const candidate = { session: route, adapter_id: summary.active_binding!.adapter_id, external_session_id: summary.active_binding!.external_session_id } as DesktopDiscoveryCandidate;
    expect(archivedCandidate(candidate, [summary])).toBe(true);
    expect(archivedCandidate({ ...candidate, session: null }, [summary])).toBe(true);
    expect(archivedCandidate({ ...candidate, external_session_id: 'another', session: null }, [summary])).toBe(false);
  });
});
