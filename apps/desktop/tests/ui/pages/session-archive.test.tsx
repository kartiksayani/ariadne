import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { blockedDraft } from '../../../src/state/drafts/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from '../app/transport';
import { sessionButton } from '../app/open';
import { projectCard } from '../../../src/ui/pages/model';
import { continueTargets } from '../../../src/ui/dialogs/ContinueTopicDialog';
import { BindSession } from '../../../src/components/navigation/Registration';
import { NavigationStore } from '../../../src/state/navigation/store';
import { waitingRows, sentRows } from '../../../src/selectors/waiting/rows';
import { tabModels } from '../../../src/ui/shell/model';
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
import { ArchiveSessionDialog, CloseSessionDialog } from '../../../src/ui/pages/SessionDialogs';
import { pendingError, savingError } from '../../../src/ui/shared/lifecycleReady';

const barrierNavigations: NavigationStore[] = [];
afterEach(() => { cleanup(); notices.clear(); barrierNavigations.splice(0).forEach(navigation => navigation.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
const card = () => document.querySelector<HTMLElement>(`[data-session-card="${route.session_id}"]`)!;
const commands = (transport: AppTransport) => transport.mutations.filter(request => request.command.command !== 'preferences_patch').map(request => request.command.command);
async function setup(pending = false, all = false, transport = new AppTransport()) {
  const session = transport.sessions.get(route.session_id)!;
  if (!pending) session.inputs = {};
  session.name = 'Review notes';

  if (pending) {
    const sample = Object.values(session.inputs).find(input => input)!;
    session.inputs = Object.fromEntries([0, 1].map(index => { const input = structuredClone(sample); input.id = `00000000-0000-4000-8000-00000000008${index}`; input.state = index ? 'in_flight' : 'queued'; return [input.id, input]; }));
  }
  transport.preferences.global.selected_navigation = { kind: 'project', project_id: route.project_id };
  render(<DesktopApp service={createDesktopService(transport)} />);
  const open = session.state === 'closed' ? await screen.findByRole('button', { name: 'Reopen' }) : await sessionButton(route);
  if (all) { fireEvent.click(open); await screen.findByRole('region', { name: 'Session tree' }); await waitFor(() => expect((document.querySelector('[data-shell-tab="all_sessions"]') as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(document.querySelector('[data-shell-tab="all_sessions"]')!); }
  await screen.findAllByText('Review notes');
  await waitFor(() => expect((within(card()).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
  return transport;
}
async function archive(confirm = true) {
  await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: 'Archive' })); });
  const dialog = screen.queryByRole('dialog'), button = dialog && within(dialog).queryByRole('button', { name: 'Archive session' });
  if (confirm && button) await act(async () => { fireEvent.click(button); });
}
async function unfold() {
  const fold = await screen.findByRole('button', { name: 'Archived · 1' });
  await waitFor(() => expect((fold as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(fold); });
  await screen.findAllByText('Review notes');
}

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
    : render(<SessionLists navigation={navigation} actions={controllers} groups={[{ project: navigation.getSnapshot().projects!.projects.items[0], openLink: false }]}
      sessions={navigation.getSnapshot().sessions!.sessions.items} snapshots={new Map()} openTabs={new Set()} now={Date.now()} disabled={false}
      onOpenProject={() => undefined} onOpenSession={() => undefined} onRemove={async () => true} />);
  return { transport, session, store, actions, onSaved, onClose, ...view };
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
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: archived ? 'Restore' : 'Archive' })); });
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
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: 'Archive' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    expect(fixture.actions.getSnapshot().pending).toBe(pending);
    expect(notices.getSnapshot().map(notice => notice.text)).toContain(pendingError);
  });

  it('times out Restore in plain words and never submits it when the old write eventually finishes', async () => {
    const fixture = await barrierSetup(true), gates = holdPause(fixture.transport);
    vi.useFakeTimers();
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(within(card()).getByRole('button', { name: 'Restore' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(notices.getSnapshot().map(notice => notice.text)).toContain(savingError);
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
    expect(screen.getByText(new RegExp(`${closeImpact(fixture.session).questions} questions are waiting`))).toBeTruthy();
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
    fixture.rerender(<CloseSessionDialog store={fixture.store} actions={fixture.actions} agent="codex" when="Today" onClose={fixture.onClose} />);
    const original = fixture.session.revision;
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(screen.getByRole('button', { name: 'Close session' })); });
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
    fireEvent.click(within(card()).getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Ready to review' } });
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
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
    fireEvent.click(within(card()).getByRole('button', { name: action }));
    if (action === 'Rename') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Session name' }), { target: { value: 'Ready to review' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    }
    fixture.unmount();
    await act(async () => { gates.save(); gates.presence(); await write; });
    expect(commands(fixture.transport)).toEqual(['binding_pause']);
    expect(fixture.session.name).toBe('Review notes');
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('Undo waits for a different save to settle and preserves its original revision guard', async () => {
    const fixture = await barrierSetup();
    await archive();
    await waitFor(() => expect((within(card()).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
    const undo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
    const gates = holdPause(fixture.transport);
    let write!: Promise<boolean>;
    await act(async () => { write = pause(fixture); undo(); undo(); });
    expect(commands(fixture.transport)).toEqual(['session_archive']);
    await act(async () => { gates.save(); });
    await waitFor(() => expect(fixture.actions.getSnapshot()).toMatchObject({ writing: true, pending: null }));
    expect(commands(fixture.transport)).toEqual(['session_archive', 'binding_pause']);
    await act(async () => { gates.presence(); await write; });
    expect(commands(fixture.transport)).toEqual(['session_archive', 'binding_pause']);
    expect(fixture.session.archived_at).toBeTruthy();
    await waitFor(() => expect(notices.getSnapshot().map(notice => notice.text)).toContain('The session could not be changed. Try again.'));
  });
});

describe('Session archive cards', () => {
  it.each([undefined, 'Shared name'])('keeps separate Undo notices for two archived sessions named %s', async name => {
    const transport = new AppTransport(), ids = [route.session_id, secondId];
    for (const id of ids) {
      const session = transport.sessions.get(id)!;
      session.name = name; session.state = 'closed'; session.closed_at = session.updated_at; session.inputs = {};
      for (const item of Object.values(session.items)) if (item?.status === 'waiting_on_me') item.status = 'open';
    }
    transport.preferences.global.selected_navigation = { kind: 'project', project_id: route.project_id };
    render(<DesktopApp service={createDesktopService(transport)} />);
    const sessionCard = (id: string) => document.querySelector<HTMLElement>(`[data-session-card="${id}"]`)!;
    for (const id of ids) {
      await waitFor(() => expect((within(sessionCard(id)).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
      await act(async () => { fireEvent.click(within(sessionCard(id)).getByRole('button', { name: 'Archive' })); });
      await waitFor(() => expect(transport.sessions.get(id)!.archived_at).toBeTruthy());
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2));
    const text = name ? `Archived “${name}”.` : 'Archived the session.';
    expect(screen.getAllByText(text)).toHaveLength(2);
    const undoFor = (id: string) => within(document.querySelector<HTMLElement>(`[data-notice-id="session-archive:${route.project_id}:${id}"]`)!)
      .getByRole('button', { name: 'Undo' });
    await act(async () => { fireEvent.click(undoFor(route.session_id)); });
    await waitFor(() => expect((within(sessionCard(route.session_id)).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
    expect(transport.sessions.get(route.session_id)!.archived_at).toBeUndefined();
    expect(transport.sessions.get(secondId)!.archived_at).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(transport.mutations.filter(request => request.command.command === 'session_restore').map(request => request.session)).toEqual([route]);
    await act(async () => { fireEvent.click(undoFor(secondId)); });
    await waitFor(() => expect((within(sessionCard(secondId)).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
    expect(transport.sessions.get(secondId)!.archived_at).toBeUndefined();
    expect(transport.mutations.filter(request => request.command.command === 'session_restore').map(request => request.session))
      .toEqual([route, { ...route, session_id: secondId }]);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
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
  it.each([false, true])('confirms Active without pending inputs on the %s All sessions view, remembers the fold, restores Closed then reopens', async all => {
    const transport = await setup(false, all);
    await archive();
    await screen.findByRole('button', { name: 'Archived · 1' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card()).toBeNull();
    expect(commands(transport)).toEqual(['session_archive']);
    expect(transport.sessions.get(route.session_id)).toMatchObject({ state: 'closed' });
    await unfold();
    expect(transport.preferences.global.session_archive_expanded_project_ids).toEqual([route.project_id]);
    expect(within(card()).queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(within(card()).getByRole('button', { name: all ? 'Go to tab' : 'Open in a tab' })).toBeTruthy();
    fireEvent.click(document.querySelector('[data-shell-tab="projects"]')!);
    await waitFor(() => expect(document.querySelector(`[data-project-id="${route.project_id}"] .pw-project-open`)).toBeTruthy());
    fireEvent.click(document.querySelector(`[data-project-id="${route.project_id}"] .pw-project-open`)!);
    await screen.findAllByText('Review notes');
    expect(screen.getByRole('button', { name: 'Archived · 1' }).getAttribute('aria-expanded')).toBe('true');
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: 'Restore' })); });
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Reopen' })).toBeTruthy());
    expect(transport.sessions.get(route.session_id)!.state).toBe('closed');
    expect(transport.sessions.get(route.session_id)!.archived_at).toBeUndefined();
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: 'Reopen' })); });
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
    expect(screen.getByText(/question.*waiting for your answer;.*leaves? Waiting until you restore/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(commands(transport)).toEqual([]);
    await archive();
    await screen.findByRole('button', { name: 'Archived · 1' });
    expect(Object.values(session.inputs).every(input => input?.state === 'cancelled')).toBe(true);
    expect((await screen.findByText('Archived and closed “Review notes”. 2 unsent messages were cancelled. Undo resumes sending, even if you paused it. Cancelled messages stay cancelled.'))).toBeTruthy();
    const undo = (await screen.findByRole('button', { name: 'Undo' }));
    const staleUndo = notices.getSnapshot().find(notice => notice.actions?.[0]?.label === 'Undo')!.actions![0].run;
    await act(async () => { fireEvent.click(undo); staleUndo(); });
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Close session' })).toBeTruthy());
    expect(commands(transport)).toEqual(['session_archive', 'session_restore']);
    expect(transport.mutations.find(request => request.command.command === 'session_restore')?.command).toMatchObject({ params: { reopen: true } });
    expect(session.state).toBe('active');
    expect(session.bindings[session.active_binding_id!]!).toMatchObject({ owner_paused: false, dispatch_state: 'enabled' });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(Object.values(session.inputs).every(input => input?.state === 'cancelled')).toBe(true);
  });

  it('shows a plain error for a quick Undo while the archive navigation refresh is still running', async () => {
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
      expect(await screen.findByText('The session could not be restored while another change is finishing. Find it under Archived and try Restore again.')).toBeTruthy();
      expect(commands(transport)).toEqual(['session_archive']);
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      expect(session.archived_at).toBeTruthy();
    } finally { await act(async () => { release(); }); }
    await unfold();
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: 'Restore' })); });
    await waitFor(() => expect(session.archived_at).toBeUndefined());
    expect(commands(transport)).toEqual(['session_archive', 'session_restore']);
  });

  it('keeps an archived session readable, blocks owner input, offers Restore before Reopen, and retains Remove', async () => {
    const transport = await setup();
    await archive(); await unfold();
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Open in a tab' }));
    await screen.findByRole('region', { name: 'Session tree' });
    expect(screen.getByText('Archived session · restore it, then reopen it to resume sending.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reopen session' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore session' })).toBeTruthy();
    const session = transport.sessions.get(route.session_id)!, item = session.items['1']!;
    expect(session.archived_at).toBeTruthy();
    const draft = { session: route, target: { item_id: item.id, topic_id: item.topic_id } } as OwnerDraft;
    expect(blockedDraft(draft, session)).toBe('This session is archived. Restore it, then reopen it to send this reply.');
  }, 15000);

  it('archives an already Closed session and lets Remove hide it until Undo', async () => {
    const fixture = new AppTransport(), session = fixture.sessions.get(route.session_id)!;
    session.state = 'closed'; session.closed_at = session.updated_at;
    const transport = await setup(false, false, fixture);
    expect(within(card()).getByRole('button', { name: 'Reopen' })).toBeTruthy();
    await archive(); await unfold(); notices.clear();
    fireEvent.click(within(card()).getByRole('button', { name: 'Remove' }));
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove session' })); });
    await waitFor(() => expect(card()).toBeNull());
    fireEvent.click((await screen.findByRole('button', { name: 'Undo' })));
    await waitFor(() => expect(card()).not.toBeNull());
    expect(within(card()).getByRole('button', { name: 'Restore' })).toBeTruthy();
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
      if (waiting) expect(within(dialog).getByText('1 question is waiting for your answer; it leaves Waiting until you restore the session.')).toBeTruthy();
    } else {
      await screen.findByRole('button', { name: 'Archived · 1' });
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
    await screen.findByRole('button', { name: 'Archived · 1' });
    expect(await screen.findByText('Archived “Review notes”.')).toBeTruthy();
    await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); });
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'Reopen' })).toBeTruthy());
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
    await screen.findByRole('button', { name: 'Archived · 1' });
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
    await screen.findByRole('button', { name: 'Archived · 1' });
    expect(await screen.findByText(submitted === 'active' ? 'Archived and closed “Review notes”.' : 'Archived “Review notes”.')).toBeTruthy();
    await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); });
    await waitFor(() => expect(within(card()).getByRole('button', { name: submitted === 'active' ? 'Close session' : 'Reopen' })).toBeTruthy());
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
    await archive(); await screen.findByRole('button', { name: 'Archived · 1' });
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
    await screen.findByRole('button', { name: 'Archived · 1' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await screen.findByRole('button', { name: 'Undo' }))).toBeTruthy();
    expect(commands(transport)).toEqual(['session_archive']);
    await act(async () => { fireEvent.click((await screen.findByRole('button', { name: 'Undo' }))); });
    await waitFor(() => expect(within(card()).getByRole('button', { name: initial === 'active' ? 'Close session' : 'Reopen' })).toBeTruthy());
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
  it('removes archive from Waiting and sent messages, and from the All sessions badge while preserving its readable tab', () => {
    const session = structuredClone(demo) as Session;
    const summary = sessions.items[0] as SessionSummary, project = projects.items[0] as ProjectSummary;
    const capture = { session, summary, project };
    expect(waitingRows([capture]).length + sentRows([capture]).length).toBeGreaterThan(0);
    session.archived_at = '2026-10-09T00:00:00.000Z';
    expect(waitingRows([capture])).toEqual([]); expect(sentRows([capture])).toEqual([]);
    const models = tabModels({ selection: 'all_sessions', projectCount: 1, sessions: [{ id: route.session_id, project: 'Example', agent: 'codex',
      createdAt: null, endedAt: null, running: false, on: false, archived: true }] }, Date.now());
    expect(models.find(tab => tab.id === 'all_sessions')!.sub).toBe('');
    expect(models.find(tab => tab.id === route.session_id)).toBeTruthy();
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
    const before = projectCard(project, [active], Date.parse(active.updated_at));
    expect(projectCard(project, [active, archived], Date.parse(active.updated_at))).toEqual(before);
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
