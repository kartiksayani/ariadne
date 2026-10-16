import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreError, NavigationSelection, OwnerMutationRequest, PreferencesPatchEntry } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { NavigationWorkspace } from '../../../src/components/navigation/NavigationWorkspace';
import { NavigationStore } from '../../../src/state/navigation/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from '../app/transport';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const entries = (request: OwnerMutationRequest): PreferencesPatchEntry[] => {
  if (request.command.command !== 'preferences_patch') throw new Error('Expected preferences patch');
  return request.command.params.entries;
};
const seenOnly = (request: OwnerMutationRequest) => entries(request).every(entry => entry.kind === 'mark_seen');
const selectionOf = (request: OwnerMutationRequest) => entries(request).find(entry => entry.kind === 'set_global')?.preferences.selected_navigation;
const second: NavigationSelection = { kind: 'session', session: { ...route, session_id: secondId } };
const projects: NavigationSelection = { kind: 'projects' };
const allSessions: NavigationSelection = { kind: 'all_sessions' };

class QueuedTransport extends AppTransport {
  readonly attempts: OwnerMutationRequest[] = [];
  beforePatch: ((request: OwnerMutationRequest) => Promise<CoreError | void>) | null = null;
  beforePreferences: (() => Promise<void>) | null = null;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if (name === 'preferences_get') await this.beforePreferences?.();
    if ('command' in request && request.command.command === 'preferences_patch') {
      this.attempts.push(structuredClone(request));
      const failure = await this.beforePatch?.(request);
      if (failure) return { api_version: 1, ok: false, error: failure } as T;
      if (request.command.params.expected_preferences_revision !== this.preferences.revision) {
        this.mutations.push(structuredClone(request));
        return { api_version: 1, ok: false, error: { code: 'revision_conflict', message: 'Preferences changed.',
          hint: 'Reload before retrying.', retryable: false, field_errors: [], current_revision: this.preferences.revision } } as T;
      }
    }
    return super.invoke<T>(name, args);
  }
}

const stores: NavigationStore[] = [];
async function setup() {
  const transport = new QueuedTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  transport.preferences.sessions = [transport.view(), { ...transport.view(secondId), tab_order: 1 }];
  const store = new NavigationStore(createDesktopService(transport));
  stores.push(store); shownStore = store;
  await store.start();
  await store.opened.open(route).refresh();
  await act(async () => {
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[]}
      renderSession={view => <p>Showing {view.store.getSnapshot().snapshot?.session.id}</p>} />);
  });
  return { store, transport };
}
// The tab row is gone (SPEC §2), so nothing in the window asks for a saved Projects or All sessions selection any more.
// The queue behind navigation is the store's, so these tests ask the store for each destination as a click did.
let shownStore: NavigationStore;
async function click(selection: NavigationSelection) {
  await act(async () => { void shownStore.navigate(selection); });
}
/** What the window shows for a saved selection: a session's Map (the test renders its id), or a page heading. */
function showing(selection: NavigationSelection) {
  if (selection.kind === 'session') return screen.queryByText(`Showing ${selection.session.session_id}`);
  return screen.queryByRole('heading', { name: selection.kind === 'all_sessions' ? 'All sessions' : 'Projects', level: 1 });
}
async function advance(milliseconds = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
function ownerSelections(transport: QueuedTransport) {
  return transport.attempts.filter(request => !seenOnly(request)).map(selectionOf);
}
const opening = () => screen.queryAllByRole('status').find(element => /^Opening(?: |…)/.test(element.textContent ?? ''));
function shown(selection: NavigationSelection, store: NavigationStore, transport: QueuedTransport) {
  expect(transport.preferences.global.selected_navigation).toEqual(selection);
  expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual(selection);
  expect(showing(selection)).not.toBeNull();
  expect(opening()).toBeUndefined();
  expect(store.getSnapshot()).toMatchObject({ pendingNavigation: null, writing: false, pendingOperationId: null, error: null });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-13T10:00:00.000Z'); });
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); notices.clear(); vi.useRealTimers(); });

describe('latest queued workspace navigation', () => {
  it('supersedes a retained startup item lookup as soon as preferences are available', async () => {
    const transport = new QueuedTransport(), catalogue = gate(), lookup = gate();
    transport.beforePreferences = () => catalogue.promise;
    const store = new NavigationStore(createDesktopService(transport)); stores.push(store);
    const invoke = transport.invoke.bind(transport);
    let resolving = false;
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'reveal_item' && args.request.request.params.item_id === '1') {
        resolving = true; await lookup.promise;
      }
      return invoke(name, args);
    });
    const starting = store.start();
    await advance();
    transport.emit('ariadne://route', { ...route, item_id: '1' });
    await act(async () => { catalogue.release(); await starting; });
    await advance();
    expect(resolving).toBe(true);
    transport.emit('ariadne://route', { ...route, item_id: '2' });
    await advance();
    expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('2');
    await act(async () => { lookup.release(); });
    await advance();
    const views = transport.attempts.flatMap(request => entries(request).filter(entry => entry.kind === 'set_session_view'));
    expect(views.map(entry => entry.preferences.selected_item_id)).toEqual(['2']);
    expect(store.getSnapshot()).toMatchObject({ error: null, pendingNavigation: null });
  });

  it('reserves a native item link before resolving it and supersedes an older queued tab', async () => {
    const { store, transport } = await setup(), owner = gate(), lookup = gate();
    transport.beforePatch = async request => {
      if (entries(request).some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) await owner.promise;
    };
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'reveal_item') await lookup.promise;
      return invoke(name, args);
    });
    let saving!: Promise<boolean>;
    await act(async () => { saving = store.saveTheme('light', transport.preferences.revision); });
    await click(projects);
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '2' }); });
    expect(store.getSnapshot().pendingNavigation).toEqual({ kind: 'session', session: route });
    await act(async () => { owner.release(); });
    await advance();
    expect(ownerSelections(transport)).toEqual([{ kind: 'session', session: route }]);
    expect(store.getSnapshot().pendingNavigation).not.toBeNull();
    await act(async () => { lookup.release(); });
    await advance();
    expect(await saving).toBe(true);
    shown({ kind: 'session', session: route }, store, transport);
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id)?.selected_item_id).toBe('2');
    expect(ownerSelections(transport).some(selection => selection?.kind === 'projects')).toBe(false);
  });

  it.each(['item', 'session'] as const)('settles an unavailable native %s link with a specific message and no owner write', async link => {
    const { store, transport } = await setup(), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if (!('command' in args.request) && args.request.session?.session_id === secondId
        && (name === 'reveal_item' || name === 'session_get')) {
        return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Folder missing', hint: '', retryable: false, field_errors: [] } };
      }
      return invoke(name, args);
    });
    await act(async () => { transport.emit('ariadne://route', { ...route, session_id: secondId, item_id: link === 'item' ? '77' : null }); });
    await advance();
    expect(screen.getByRole('alert').textContent).toContain('This session could not be opened. Check that its project folder is available, then try again.');
    expect(screen.queryByText(/couldn’t read or save/)).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, pendingNavigation: null });
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(ownerSelections(transport)).toEqual([]);
  });

  it('quietly releases a superseded navigation rejection while the newest destination prepares', async () => {
    const { store, transport } = await setup(), rejected = gate(), capture = gate();
    transport.beforePatch = async request => {
      if (selectionOf(request)?.kind === 'projects') {
        await rejected.promise;
        return { code: 'invalid_transition', message: 'The old destination is unavailable.', hint: 'Choose another view.',
          retryable: false, field_errors: [] };
      }
    };
    await click(projects);
    expect(ownerSelections(transport)).toEqual([projects]);
    await click(second);
    transport.beforePreferences = () => capture.promise;
    await act(async () => { rejected.release(); });
    await advance();
    expect(store.getSnapshot()).toMatchObject({ error: null, pendingNavigation: second });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(notices.getSnapshot()).toHaveLength(0);
    await act(async () => { capture.release(); });
    await advance();
    shown(second, store, transport);
    expect(ownerSelections(transport)).toEqual([projects, second]);
  });

  it('retains the explicit session destination when a same-session reveal conflicts with a foreign route change', async () => {
    const { store, transport } = await setup();
    const selected: NavigationSelection = { kind: 'session', session: route };
    const reveal = await store.routes.revealItem({ ...route, item_id: '2' });
    expect(reveal?.kind).toBe('item');
    let changed = false;
    transport.beforePatch = async request => {
      if (!seenOnly(request) && !changed) {
        changed = true;
        transport.preferences.revision += 1;
        transport.preferences.global.selected_navigation = projects;
        transport.preferences.global.theme = 'light';
        transport.preferences.sessions[0].tab_open = false;
      }
    };
    await act(async () => { expect(await store.navigate(selected, reveal)).toBe(true); });
    shown(selected, store, transport);
    expect(transport.preferences.sessions.find(view => view.session.session_id === route.session_id))
      .toMatchObject({ tab_open: true, selected_item_id: '2' });
    expect(transport.preferences.global.theme).toBe('light');
    expect(ownerSelections(transport)).toEqual([selected, selected]);
    expect(notices.getSnapshot()).toHaveLength(0);
  });

  it.each(['register', 'bind'] as const)('keeps a newer tab click when an earlier %s operation finishes', async action => {
    const { store, transport } = await setup(), owner = gate(), started = gate();
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('command' in request && (request.command.command === 'project_register' || request.command.command === 'binding_connect')) {
        transport.mutations.push(structuredClone(request));
        started.release();
        await owner.promise;
        if (request.command.command === 'project_register') return { api_version: 1, ok: true,
          data: { operation_id: request.command.op_id, project_id: route.project_id, registry_revision: 2 } };
        const session = transport.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!;
        return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, session_id: session.id, revision: session.revision,
          data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities,
            setup_instruction: 'Ready to use.' } } };
      }
      return invoke(name, args);
    });
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = action === 'register' ? store.register('/fixtures/ariadne-demo') : store.bind({ project_id: route.project_id,
        adapter_id: 'demo.local', configuration: { namespace: 'demo.local', values: {} }, endpoint: { kind: 'unix_socket', path: '/tmp/fixture.sock' },
        external_session_id: 'fixture-session', existing_session_id: route.session_id });
      await started.promise;
    });
    await click(second);
    expect(store.getSnapshot().pendingNavigation).toEqual(second);
    await act(async () => { owner.release(); expect(await saving).toBe(true); });
    await advance();
    shown(second, store, transport);
    expect(ownerSelections(transport)).toEqual([second]);
    expect(screen.getByText(`Showing ${secondId}`)).toBeTruthy();
  });

  it('keeps the switcher enabled during an owner write and saves only the newest navigation after it', async () => {
    const { store, transport } = await setup(), owner = gate();
    transport.beforePatch = async request => { if (selectionOf(request)?.kind === 'session') await owner.promise; };
    let saving!: Promise<boolean>;
    await act(async () => { saving = store.saveTheme('dark', 1); });
    expect(store.getSnapshot().writing).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]')!.disabled).toBe(false);
    await click(projects);
    await click(second);
    expect(opening()).toBeDefined();
    expect(store.getSnapshot()).toMatchObject({ pendingNavigation: second });
    expect(transport.attempts).toHaveLength(1);
    transport.beforePatch = null;
    await act(async () => { owner.release(); expect(await saving).toBe(true); });
    await advance();
    shown(second, store, transport);
    expect(ownerSelections(transport)).toEqual([{ kind: 'session', session: route }, second]);
    expect(transport.preferences.global.theme).toBe('dark');
    expect(screen.getByText(`Showing ${secondId}`)).toBeTruthy();
  });

  it('supersedes a click during an in-flight seen batch and counts the wait from latest admission', async () => {
    const { store, transport } = await setup(), seen = gate();
    transport.beforePatch = async request => { if (seenOnly(request)) await seen.promise; };
    await advance(1000);
    await click(projects);
    await advance(300);
    await click(second);
    await advance(199);
    expect(ownerSelections(transport)).toEqual([]);
    expect(store.getSnapshot()).toMatchObject({ pendingNavigation: second });
    await advance(300);
    expect(ownerSelections(transport)).toEqual([]);
    await advance(1);
    shown(second, store, transport);
    expect(ownerSelections(transport)).toEqual([second]);
    transport.beforePatch = null;
    await act(async () => { seen.release(); });
    await advance(1000);
    expect(ownerSelections(transport)).toEqual([second]);
    expect(store.getSnapshot().error).toBeNull();
  });

  it('cancels an obsolete navigation during seen-conflict classification before replay', async () => {
    const { store, transport } = await setup(), seen = gate(), committed = gate(), classification = gate();
    let ownerAttempt = false, classify = false;
    transport.beforePatch = async request => {
      if (seenOnly(request)) { await seen.promise; return; }
      if (!ownerAttempt) {
        ownerAttempt = true;
        seen.release();
        await committed.promise;
        classify = true;
      }
    };
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const result = await invoke(name, args);
      if ('command' in args.request && args.request.command.command === 'preferences_patch' && seenOnly(args.request)) committed.release();
      return result;
    });
    transport.beforePreferences = async () => { if (classify) await classification.promise; };
    await advance(1000);
    await click(projects);
    await advance(500);
    expect(ownerSelections(transport)).toEqual([projects]);
    expect(store.getSnapshot().writing).toBe(true);
    await click(second);
    await click(allSessions);
    expect(store.getSnapshot()).toMatchObject({ pendingNavigation: allSessions });
    expect(opening()).toBeDefined();
    await act(async () => { classification.release(); });
    await advance();
    shown(allSessions, store, transport);
    expect(ownerSelections(transport)).toEqual([projects, allSessions]);
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('keeps confirmation armed after the bounded UI return and cancels superseded callers immediately', async () => {
    const { store, transport } = await setup(), owner = gate();
    transport.beforePatch = async () => { await owner.promise; };
    const saving = store.saveTheme('dark', 1);
    await advance();
    const older = store.navigate(projects);
    const olderCompletion = store.getNavigationCompletion(store.getNavigationRequest());
    const latest = store.navigate(second);
    const completion = store.getNavigationCompletion(store.getNavigationRequest());
    expect(await older).toBe(false);
    expect(await olderCompletion).toBe(false);
    let settled = false, confirmed = false;
    void latest.then(() => { settled = true; });
    void completion.then(() => { confirmed = true; });
    await advance(999);
    expect(settled).toBe(false);
    await advance(1);
    expect(await latest).toBe(false);
    expect(confirmed).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ pendingNavigation: second });
    expect(opening()).toBeDefined();
    transport.beforePatch = null;
    await act(async () => { owner.release(); expect(await saving).toBe(true); });
    await advance();
    expect(await completion).toBe(true);
    shown(second, store, transport);
    expect(ownerSelections(transport)).toEqual([{ kind: 'session', session: route }, second]);
  });

  it.each(['commit_uncertain', 'transport'] as const)('retains the newest click behind %s and resumes only after explicit reconciliation', async code => {
    const { store, transport } = await setup();
    let failed = false;
    transport.beforePatch = async () => {
      if (!failed) {
        failed = true;
        if (code === 'transport') throw new Error('Owner response lost');
        return { code, message: 'Completion unknown.', hint: '', retryable: true, field_errors: [] };
      }
    };
    let saved!: boolean;
    await act(async () => { saved = await store.saveTheme('dark', 1); });
    expect(saved).toBe(false);
    const operation = store.getSnapshot().pendingOperationId;
    await click(projects);
    await click(second);
    await advance(1000);
    expect(transport.attempts).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({ pendingOperationId: operation, pendingNavigation: second });
    expect(opening()).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    await advance();
    shown(second, store, transport);
    expect(transport.attempts[1]).toEqual(transport.attempts[0]);
    expect(ownerSelections(transport).slice(2)).toEqual([second]);
    expect(transport.preferences.global.theme).toBe('dark');
  });

  it('cancels retained navigation on stop without submitting it after the owner finishes', async () => {
    const { store, transport } = await setup(), owner = gate();
    transport.beforePatch = async () => { await owner.promise; };
    const saving = store.saveTheme('dark', 1);
    await advance();
    const waiting = store.navigate(second);
    const completion = store.getNavigationCompletion(store.getNavigationRequest());
    await advance(1000);
    expect(await waiting).toBe(false);
    await act(async () => { store.stop(); owner.release(); expect(await saving).toBe(false); });
    expect(await completion).toBe(false);
    await advance();
    expect(transport.attempts).toHaveLength(1);
    expect(store.getSnapshot().pendingNavigation).toBeNull();
    expect(store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'session', session: route });
  });
});
