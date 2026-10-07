import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App, { DesktopApp } from '../../src/App';
import { createDesktopService } from '../../src/data/service';
import { WaitingStore } from '../../src/selectors/waiting/store';
import { MessageRail } from '../../src/components/rail/MessageRail';
import { TreeView } from '../../src/ui/tree/TreeView';
import { AppTransport, route, secondId } from './app/transport';
import { page, projections } from './history/fixtures';

vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDOM>();
  return { ...actual, createRoot: vi.fn(actual.createRoot) };
});
vi.mock('../../src/components/rail/MessageRail', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/components/rail/MessageRail')>();
  return { ...actual, MessageRail: vi.fn(actual.MessageRail) };
});
vi.mock('../../src/ui/tree/TreeView', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ui/tree/TreeView')>();
  return { ...actual, TreeView: vi.fn(actual.TreeView) };
});

const mutations = (transport: AppTransport, command: string) => transport.mutations.filter(request => request.command.command === command);
async function openSession(id = route.session_id, pending = false) {
  const control = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`);
    expect(button).not.toBeNull(); expect(button?.disabled).toBe(false); return button!;
  });
  fireEvent.click(control);
  await screen.findByRole('region', { name: 'Session tree' });
  if (!pending) await waitFor(() => expect(screen.getByRole('button', { name: 'Close session' }).hasAttribute('disabled')).toBe(false));
}
async function allSessions() {
  const button = screen.getByRole('button', { name: /^All sessions/ });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false)); fireEvent.click(button);
  await screen.findByRole('heading', { name: 'All sessions' });
}
function setup(strict = false) {
  const transport = new AppTransport(), service = createDesktopService(transport);
  const app = <DesktopApp service={service} />;
  return { transport, ...render(strict ? <StrictMode>{app}</StrictMode> : app) };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ordinary desktop composition', () => {
  it('opens the product navigator and reports an unavailable native service', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(await screen.findAllByText('Desktop service is unavailable.')).not.toHaveLength(0);
    expect(screen.queryByLabelText('Nonce')).toBeNull();
    expect(screen.queryByText('Ariadne scaffold')).toBeNull();
  });
  it('mounts and disposes the real entry point', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import('../../src/main');
    await screen.findByRole('heading', { name: 'Projects' });
    const entryRoot = vi.mocked(ReactDOM.createRoot).mock.results.at(-1)!.value as ReactDOM.Root;
    await act(async () => { entryRoot.unmount(); });
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('survives StrictMode replay with one route listener and releases every listener and timer at unmount', async () => {
    const intervals = new Set<ReturnType<typeof setInterval>>();
    const set = globalThis.setInterval, clear = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof set>) => {
      const timer = set(...args); intervals.add(timer); return timer;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation((timer: Parameters<typeof clear>[0]) => {
      intervals.delete(timer as ReturnType<typeof setInterval>); clear(timer);
    });
    const { transport, unmount } = setup(true);
    await screen.findByRole('heading', { name: 'All sessions' });
    await waitFor(() => expect(transport.listeners.get('ariadne://route')?.size).toBe(1));
    await openSession();
    expect(transport.queries.filter(request => request.request.command === 'session_get')).not.toHaveLength(0);
    unmount();
    await act(async () => { await Promise.resolve(); });
    expect([...transport.listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true);
    expect(intervals.size).toBe(0);
  });
  it('shows seeded presence to a late reader, shares tree/graph selection and opens complete detail and the message rail', async () => {
    const { transport } = setup(); await openSession();
    await waitFor(() => expect(document.querySelector('.shell-context')?.textContent).toContain('Ariadne canonical demo · started'));
    expect(document.querySelector('.shell-context')?.textContent).not.toMatch(/Host unknown|heartbeat/);
    // No presence hint is emitted: opening after the host event must seed its canonical observation.
    await waitFor(() => expect(document.querySelector('.tree-run')?.getAttribute('title')).toBe('Host running · fresh host event'));
    expect(document.querySelector('.tree-run')?.textContent).toBe('Agent running');
    expect(transport.queries).toContainEqual({ session: null, request: { command: 'session_list', params: {
      project_id: route.project_id, state: null, cursor: null, limit: 100,
    } } });
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByRole('group', { name: 'Owner actions' });
    expect(screen.getAllByLabelText('Item detail')).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await screen.findAllByRole('region', { name: /Topic graph/ });
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(screen.queryByRole('group', { name: 'Owner actions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Item 1:/ }));
    expect(await screen.findByRole('group', { name: 'Owner actions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(await screen.findByRole('tree', { name: 'Session items' })).toBeTruthy();
    // The icon-only toggle carries its own accessible name, not only a tooltip title.
    expect(screen.getByRole('button', { name: 'Messages (m)' }).getAttribute('aria-label')).toBe('Messages (m)');
    fireEvent.click(screen.getByRole('button', { name: 'Messages (m)' }));
    await screen.findByRole('log', { name: 'Complete session messages' });
    await waitFor(() => expect(transport.preferences.sessions[0].rail).toBe('activity'));
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(screen.queryByRole('group', { name: 'Owner actions' })).toBeNull();
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
  });
  it('composes transient rail and tree cross-highlights without selecting, focusing or writing preferences', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByRole('group', { name: 'Owner actions' });
    fireEvent.click(screen.getByRole('button', { name: 'Messages (m)' }));
    const log = await screen.findByRole('log', { name: 'Complete session messages' });
    const session = transport.sessions.get(route.session_id)!;
    await waitFor(() => expect(log.querySelectorAll('[data-message-id]')).toHaveLength(session.messages.length));
    await waitFor(() => expect(transport.preferences.sessions[0].rail).toBe('activity'));
    const before = structuredClone(transport.preferences), writes = transport.mutations.length;
    const tree = screen.getByRole('tree', { name: 'Session items' }), detail = document.querySelector<HTMLElement>('.item-history')!;
    tree.scrollTop = 50; detail.scrollTop = 70; log.scrollTop = 123;
    const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
    const linked = session.messages.filter(message => message.item_id === '2' || message.items_touched.includes('2'));
    expect(linked.length).toBeGreaterThan(0);
    const message = linked.find(message => message.item_id !== '1' && !message.items_touched.includes('1'))!;
    expect(message).toBeTruthy();
    const card = log.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`)!;
    const lit = (node: Element = row) => node.getAttribute('data-highlight');
    const unchanged = () => {
      expect(transport.preferences).toEqual(before); expect(transport.mutations).toHaveLength(writes);
      expect(tree.scrollTop).toBe(50); expect(detail.scrollTop).toBe(70); expect(log.scrollTop).toBe(123);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const editor = await screen.findByLabelText('Reply message'); editor.focus();
    fireEvent.mouseEnter(row);
    for (const message of linked) expect(log.querySelector(`[data-message-id="${message.id}"]`)!.classList.contains('history-highlight')).toBe(true);
    expect(document.activeElement).toBe(editor); unchanged();
    fireEvent.mouseLeave(row);
    expect(card.classList.contains('history-highlight')).toBe(false);
    fireEvent.mouseEnter(card);
    await waitFor(() => expect(lit()).toBe('strong'));
    expect(row.getAttribute('aria-selected')).toBe('false'); expect(document.activeElement).toBe(editor); unchanged();
    fireEvent.click(card.querySelector('.history-body')!); fireEvent.mouseLeave(card);
    expect(card.classList.contains('history-pinned')).toBe(true); expect(lit()).toBe('strong'); unchanged();
    fireEvent.click(within(card).getByRole('button', { name: `Unpin message ${message.number}` }));
    await waitFor(() => expect(lit()).toBeNull()); unchanged();
    fireEvent.mouseEnter(row); expect(card.classList.contains('history-highlight')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await screen.findAllByRole('region', { name: /Topic graph/ });
    expect(card.classList.contains('history-highlight')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    const restored = await screen.findByRole('tree', { name: 'Session items' });
    expect(lit(restored.querySelector('[data-item-id="2"]')!)).toBeNull();
    fireEvent.click(card.querySelector('.history-body')!);
    expect(card.classList.contains('history-pinned')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await screen.findAllByRole('region', { name: /Topic graph/ });
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    const returned = await screen.findByRole('tree', { name: 'Session items' });
    expect(lit(returned.querySelector('[data-item-id="2"]')!)).toBe('strong');
    expect(card.classList.contains('history-pinned')).toBe(true);
    expect(transport.preferences).toEqual(before); expect(transport.mutations).toHaveLength(writes);
    fireEvent.click(screen.getByRole('button', { name: 'Close message rail' }));
    await waitFor(() => expect(lit(returned.querySelector('[data-item-id="2"]')!)).toBeNull());
  });
  it('keeps the selected tree and complete rail idle when another session publishes presence', async () => {
    const starts = vi.spyOn(WaitingStore.prototype, 'start');
    const transport = new AppTransport(), second = transport.sessions.get(secondId)!;
    const binding = second.bindings[second.active_binding_id!]!;
    binding.id = '00000000-0000-4000-8000-000000000021';
    second.bindings = { [binding.id]: binding }; second.active_binding_id = binding.id;
    render(<DesktopApp service={createDesktopService(transport)} />);
    await openSession();
    const waiting = starts.mock.contexts[0] as WaitingStore;
    fireEvent.click(screen.getByRole('button', { name: 'Messages (m)' }));
    const log = await screen.findByRole('log', { name: 'Complete session messages' });
    await waitFor(() => {
      expect(waiting.getSnapshot().status).toBe('ready');
      expect(transport.preferences.sessions[0].rail).toBe('activity');
      expect(log.querySelectorAll('[data-message-id]')).toHaveLength(transport.sessions.get(route.session_id)!.messages.length);
    });
    const treeRenders = vi.mocked(TreeView).mock.calls.length;
    const railRenders = vi.mocked(MessageRail).mock.calls.length;
    const previous = waiting.getSnapshot(), observation = {
      ...waiting.sessionState(route)!.presence[transport.sessions.get(route.session_id)!.active_binding_id!],
      generation: binding.generation, last_seen_at: '2026-10-05T02:05:00.000Z', execution_state: 'running' as const, freshness: 'fresh' as const,
    };
    await act(async () => { transport.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation }); });
    expect(waiting.getSnapshot()).not.toBe(previous);
    expect(waiting.sessionState({ ...route, session_id: secondId })?.presence[binding.id]).toEqual(observation);
    expect.soft(vi.mocked(TreeView).mock.calls).toHaveLength(treeRenders);
    expect.soft(vi.mocked(MessageRail).mock.calls).toHaveLength(railRenders);
  });
  it('answers the latest oldest waiting question after a background capture finishes', async () => {
    const starts = vi.spyOn(WaitingStore.prototype, 'start');
    const { transport } = setup(); await openSession();
    const waiting = starts.mock.contexts[0] as WaitingStore;
    await waitFor(() => expect(waiting.getSnapshot().status).toBe('ready'));
    expect(waiting.getSnapshot().waiting[0].route.session_id).toBe(route.session_id);
    const first = transport.sessions.get(route.session_id)!, second = transport.sessions.get(secondId)!;
    const question = structuredClone(first.items['2']!);
    question.waiting_since = '2026-10-03T11:00:00.000Z'; question.current_round_id = null;
    second.items = { [question.id]: question }; second.topics = structuredClone(first.topics);
    second.messages = structuredClone(first.messages); ++second.revision;
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'session_get' && args.request.session?.session_id === secondId) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    let capture!: Promise<void>;
    await act(async () => { capture = waiting.refresh(); });
    await waitFor(() => expect(entered).toBe(true));
    await act(async () => { release(); await capture; });
    expect(waiting.getSnapshot().waiting[0].route.session_id).toBe(secondId);
    fireEvent.keyDown(document.querySelector('.product-app')!, { key: 'a' });
    const ownerInput = await screen.findByLabelText('Owner input for #2');
    await waitFor(() => expect(document.activeElement?.closest('[aria-label="Owner input for #2"]')).toBe(ownerInput));
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
    expect(mutations(transport, 'input_submit')).toHaveLength(0);
  });
  it('submits a deliberate owner reply through the shared draft service and renders its real Sent and conversation text', async () => {
    const { transport } = setup(); await openSession();
    const originalStatus = transport.sessions.get(route.session_id)?.items['1']?.status;
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    const editor = await screen.findByLabelText('Reply message');
    fireEvent.change(editor, { target: { value: 'Owner nonce: exact café\nsecond line' } });
    const send = within(screen.getByLabelText('Owner input for #1')).getByRole('button', { name: 'Send reply' });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false)); fireEvent.click(send);
    await waitFor(() => expect(mutations(transport, 'input_submit')).toHaveLength(1));
    expect(mutations(transport, 'input_submit')[0]).toMatchObject({ session: route, command: { params: { kind: 'reply', text: 'Owner nonce: exact café\nsecond line' } } });
    await screen.findByText(/Saved · Queue position/);
    fireEvent.click(await screen.findByRole('button', { name: /Timeline/ }));
    await waitFor(() => expect(within(document.querySelector('.item-history')!).getByText('Owner nonce: exact café second line', { exact: false })).toBeTruthy());
    expect(await screen.findAllByText(/Sent/)).not.toHaveLength(0);
    expect(transport.sessions.get(route.session_id)?.items['1']?.status).toBe(originalStatus);
  });
  it('keeps uncertain binding actions isolated across sessions and retries the frozen request after tab close and reopen', async () => {
    const { transport } = setup(); await openSession(); transport.failNext = 'binding_pause';
    // Close asks for a persisted pause first; the pause is the binding action under test.
    const pause = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause dispatch' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm Pause dispatch' }));
    };
    await pause();
    await screen.findAllByRole('button', { name: 'Reconcile saved action' });
    const original = structuredClone(mutations(transport, 'binding_pause')[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/^The saved binding pause is not confirmed\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Close .* tab/ }));
    await screen.findByRole('heading', { name: 'Projects' });
    await allSessions(); await openSession(secondId);
    expect(screen.queryByRole('button', { name: 'Reconcile saved action' })).toBeNull();
    await pause();
    await within(screen.getByRole('dialog')).findByRole('button', { name: 'Confirm session close' });
    expect(mutations(transport, 'binding_pause')[1].session?.session_id).toBe(secondId);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await allSessions(); await openSession(route.session_id, true);
    expect(mutations(transport, 'binding_pause')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Close session' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconcile saved action' }));
    await waitFor(() => expect(mutations(transport, 'binding_pause')).toHaveLength(3));
    expect(mutations(transport, 'binding_pause')[2]).toEqual(original);
  });
  it('saves the header search through the shared view writer without resetting another filter', async () => {
    const { transport } = setup();
    transport.preferences.sessions[0].filters.owners = [{ kind: 'me' }];
    await openSession();
    const count = mutations(transport, 'preferences_patch').length;
    fireEvent.change(screen.getByLabelText('Search questions and outcomes'), { target: { value: 'missing needle' } });
    await waitFor(() => expect(transport.preferences.sessions[0].filters.search).toBe('missing needle'));
    expect(transport.preferences.sessions[0].filters.owners).toEqual([{ kind: 'me' }]);
    expect(mutations(transport, 'preferences_patch')).toHaveLength(count + 1);
    expect(await screen.findByText(/^Nothing matches “missing/)).toBeTruthy();
    expect(mutations(transport, 'input_submit')).toHaveLength(0);
  });
  it('clears filters with Esc only when no detail is open, keeping the archive view', async () => {
    const { transport } = setup();
    transport.preferences.sessions[0].filters.owners = [{ kind: 'me' }];
    await openSession();
    const tree = screen.getByRole('tree', { name: 'Session items' });
    fireEvent.click(tree.querySelector('[data-item-id="1"]')!); await waitFor(() => expect(document.querySelector('.shell-detail')).not.toBeNull());
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    const count = mutations(transport, 'preferences_patch').length;
    fireEvent.keyDown(tree.querySelector('[data-item-id="1"]')!, { key: 'Escape' });
    expect(document.querySelector('.shell-detail')).toBeNull();
    expect(mutations(transport, 'preferences_patch')).toHaveLength(count);
    fireEvent.keyDown(tree.querySelector('[data-item-id="1"]')!, { key: 'Escape' });
    await waitFor(() => expect(transport.preferences.sessions[0].filters).toMatchObject({ search: '', statuses: [], owners: [], topic_id: null, hide_later: false, archived: false }));
  });
  it.each(['confirmed', 'reconciled'])('retains an unsubmitted tree search until the shared preference write is %s', async completion => {
    const { transport } = setup();
    transport.preferences.sessions[0].filters.owners = [{ kind: 'me' }];
    await openSession();
    const before = structuredClone(transport.preferences.sessions[0]);
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    const writes = mutations(transport, 'preferences_patch').length;
    const search = screen.getByLabelText('Search questions and outcomes') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'missing pending needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' }));
    await waitFor(() => expect(entered).toBe(true));
    expect(search.disabled).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(screen.getByText(/^Nothing matches “missing/)).toBeTruthy();
    expect(transport.preferences.sessions[0].filters.search).toBe(before.filters.search);
    expect(mutations(transport, 'preferences_patch')).toHaveLength(writes);
    if (completion === 'reconciled') transport.failNext = 'preferences_patch';
    await act(async () => { release(); await gate; });
    if (completion === 'reconciled') {
      const reconcile = await screen.findByRole('button', { name: 'Reconcile operation' });
      expect(search.disabled).toBe(true);
      expect(search.value).toBe('missing pending needle');
      expect(mutations(transport, 'preferences_patch')).toHaveLength(writes + 1);
      fireEvent.click(reconcile);
    }
    await waitFor(() => expect(transport.preferences.sessions[0].filters.search).toBe('missing pending needle'));
    await waitFor(() => expect(search.disabled).toBe(false));
    expect(transport.preferences.global.theme).toBe('light');
    expect(transport.preferences.sessions[0]).toEqual({ ...before, filters: { ...before.filters, search: 'missing pending needle' } });
    expect(mutations(transport, 'preferences_patch')).toHaveLength(writes + (completion === 'reconciled' ? 3 : 2));
    const searches = mutations(transport, 'preferences_patch').filter(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.filters.search === 'missing pending needle'));
    expect(searches).toHaveLength(1);
  });
  it('opens a native route over an earlier local selection without clearing its filters', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByRole('group', { name: 'Owner actions' });
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    const filters = structuredClone(transport.preferences.sessions[0].filters);
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(screen.queryByRole('group', { name: 'Owner actions' })).toBeNull();
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '2' }); });
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('2'));
    expect(await screen.findByLabelText('Owner input for #2')).toBeTruthy();
    expect(transport.preferences.sessions[0].filters).toEqual(filters);
  });
  it('retains an enabled Reply submission while its exact draft edit is still saving', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    const editor = await screen.findByLabelText('Reply message');
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    const text = 'Retain this Reply during its pending draft save.';
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'upsert_draft' && entry.draft.text === text)) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    fireEvent.change(editor, { target: { value: text } });
    await waitFor(() => expect(entered).toBe(true));
    const send = within(screen.getByLabelText('Owner input for #1')).getByRole('button', { name: 'Send reply' });
    expect(send.hasAttribute('disabled')).toBe(false); fireEvent.click(send);
    expect(mutations(transport, 'input_submit')).toHaveLength(0);
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(mutations(transport, 'input_submit')).toHaveLength(1));
    expect(mutations(transport, 'input_submit')[0].command).toMatchObject({ params: { text } });
  });
  it.each([
    { ordering: 'click then focus', outcome: 'confirmed' },
    { ordering: 'focus then click', outcome: 'confirmed' },
    { ordering: 'click then focus', outcome: 'uncertain' },
    { ordering: 'click then focus', outcome: 'rejected' },
    { ordering: 'click then focus', outcome: 'shortcut' },
    { ordering: 'click then focus', outcome: 'bring' },
    { ordering: 'click then focus', outcome: 'native route' },
    { ordering: 'click then focus', outcome: 'stopped' },
  ])('admits only the current enabled fork after its blur write: $ordering / $outcome', async ({ ordering, outcome }) => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('[role="treeitem"]') ? new DOMRect(0, 20, 300, 40) : rectangle.call(this);
    });
    const { transport, unmount } = setup(), invoke = transport.invoke.bind(transport);
    let release!: () => void, entered = false, reject = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('request' in request && request.request.command === 'item_rounds' && request.request.params.item_id === '1') {
        const session = transport.sessions.get(route.session_id)!;
        return { api_version: 1, ok: true, data: { kind: 'item_rounds', data: { item_id: '1', rounds: page(projections(session).rounds, session.revision) } } };
      }
      if ('command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.every(entry => entry.kind === 'set_session_view' && entry.preferences.scroll !== null)) {
        entered = true; await gate;
        if (reject) {
          reject = false; transport.mutations.push(structuredClone(request));
          return { api_version: 1, ok: false, error: { code: 'invalid_transition', message: 'Scroll edit rejected.',
            hint: 'Choose the view again.', retryable: false, field_errors: [] } };
        }
      }
      return invoke(name, args);
    });
    await openSession();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    const parent = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!;
    await act(async () => { parent.focus(); });
    expect(document.activeElement).toBe(parent);
    const fork = await screen.findByRole('button', { name: /^Fork · Item 1\.1/ });
    expect(fork.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      if (ordering === 'click then focus') { fireEvent.click(fork); fork.focus(); }
      else { fork.focus(); fireEvent.click(fork); }
    });
    await waitFor(() => expect(entered).toBe(true));
    expect(screen.getByLabelText('Search questions and outcomes').hasAttribute('disabled')).toBe(true);
    expect(transport.queries.some(query => query.request.command === 'reveal_item' && query.request.params.item_id === '1.1')).toBe(true);
    if (outcome === 'uncertain') transport.failNext = 'preferences_patch';
    if (outcome === 'rejected') reject = true;
    if (outcome === 'shortcut') {
      await act(async () => { fireEvent.keyDown(parent, { key: 'o' }); });
    }
    if (outcome === 'bring') await act(async () => { fireEvent.keyDown(parent, { key: 'b' }); });
    if (outcome === 'native route') {
      await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '2' }); });
      expect(transport.queries.some(query => query.request.command === 'reveal_item' && query.request.params.item_id === '2')).toBe(true);
    }
    if (outcome === 'stopped') unmount();
    await act(async () => { release(); await gate; });
    if (outcome === 'stopped') {
      expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
      expect(document.querySelector('.product-app')).toBeNull();
    } else if (outcome === 'confirmed') {
      await waitFor(() => expect(screen.getByLabelText('Search questions and outcomes').hasAttribute('disabled')).toBe(false));
      await screen.findByLabelText('Owner input for #1.1');
      expect(transport.preferences.sessions[0].selected_item_id).toBe('1.1');
      expect(transport.preferences.sessions[0].scroll).toEqual({ item_id: '1', offset: 20 });
    } else {
      if (outcome === 'uncertain') {
        const reconcile = await screen.findByRole('button', { name: 'Reconcile operation' });
        const frozen = structuredClone(mutations(transport, 'preferences_patch').at(-1));
        expect(screen.queryByLabelText('Owner input for #1.1')).toBeNull();
        fireEvent.click(reconcile);
        await waitFor(() => expect(screen.getByLabelText('Search questions and outcomes').hasAttribute('disabled')).toBe(false));
        expect(mutations(transport, 'preferences_patch').at(-1)).toEqual(frozen);
      } else if (outcome === 'shortcut') {
        const editor = await screen.findByLabelText('Reopen message');
        await waitFor(() => expect(document.activeElement).toBe(editor));
      } else if (outcome === 'bring') {
        await waitFor(() => expect(mutations(transport, 'input_submit')).toHaveLength(1));
        expect(mutations(transport, 'input_submit')[0].command).toMatchObject({ params: { kind: 'bring', text: 'Bring this up.', target: { item_id: '1' } } });
      }
      else await waitFor(() => expect(screen.getByLabelText('Search questions and outcomes').hasAttribute('disabled')).toBe(false));
      expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
      expect(screen.queryByLabelText('Owner input for #1.1')).toBeNull();
    }
    if (outcome !== 'confirmed') expect(mutations(transport, 'preferences_patch').some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id === '1.1'))).toBe(false);
  });
  it.each(['revision_conflict', 'commit_uncertain'] as const)('after a %s on the blur write, the fork click proceeds only for a definite conflict', async code => {
    const rectangle = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('[role="treeitem"]') ? new DOMRect(0, 20, 300, 40) : rectangle.call(this);
    });
    const { transport } = setup(), invoke = transport.invoke.bind(transport);
    let release!: () => void, entered = false, rejected = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('request' in request && request.request.command === 'item_rounds' && request.request.params.item_id === '1') {
        const session = transport.sessions.get(route.session_id)!;
        return { api_version: 1, ok: true, data: { kind: 'item_rounds', data: { item_id: '1', rounds: page(projections(session).rounds, session.revision) } } };
      }
      if (!rejected && 'command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.every(entry => entry.kind === 'set_session_view' && entry.preferences.scroll !== null)) {
        entered = true; await gate; rejected = true; transport.mutations.push(structuredClone(request));
        // A native-side writer advanced the document without notifying the renderer.
        if (code === 'revision_conflict') ++transport.preferences.revision;
        return { api_version: 1, ok: false, error: { code, message: 'Scroll edit rejected.', hint: 'Choose the view again.',
          retryable: false, field_errors: [] } };
      }
      return invoke(name, args);
    });
    await openSession();
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1"]')!);
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    const parent = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!;
    await act(async () => { parent.focus(); });
    const fork = await screen.findByRole('button', { name: /^Fork · Item 1\.1/ });
    await act(async () => { fireEvent.click(fork); fork.focus(); });
    await waitFor(() => expect(entered).toBe(true));
    await act(async () => { release(); await gate; });
    const selections = () => mutations(transport, 'preferences_patch').filter(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id === '1.1'));
    if (code === 'revision_conflict') {
      await screen.findByLabelText('Owner input for #1.1');
      expect(selections()).toHaveLength(1);
      const selection = selections()[0].command;
      expect(selection.command === 'preferences_patch' && selection.params.expected_preferences_revision).toBe(transport.preferences.revision - 1);
      expect(transport.preferences.sessions[0].selected_item_id).toBe('1.1');
    } else {
      await screen.findByRole('button', { name: 'Reconcile operation' });
      const writes = mutations(transport, 'preferences_patch').length;
      await act(async () => {});
      await screen.findByRole('button', { name: 'Reconcile operation' });
      expect(screen.queryByLabelText('Owner input for #1.1')).toBeNull();
      expect(selections()).toHaveLength(0);
      expect(mutations(transport, 'preferences_patch')).toHaveLength(writes);
      expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
    }
  });
  it.each(['parent selection', 'tab close', 'read failure'])('cancels a waiting detail link after %s during catalogue completion', async outcome => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    let releaseWrite!: () => void, releaseRead!: () => void, writing = false, reading = false, completed = false;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
        writing = true; await writeGate;
      }
      const hold = 'request' in args.request && args.request.request.command === 'project_list'
        && transport.preferences.global.theme === 'light' && !reading;
      if (hold) { reading = true; await readGate; }
      if (hold && outcome === 'read failure') { completed = true; throw new Error('Catalogue read unavailable'); }
      const response = await invoke(name, args);
      if (hold) completed = true;
      return response;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' }));
    await waitFor(() => expect(writing).toBe(true));
    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: 'Child items' })).getByRole('button', { name: /Item 1\.1/ })); });
    expect(screen.getByLabelText('Search questions and outcomes').hasAttribute('disabled')).toBe(true);
    await act(async () => { releaseWrite(); await writeGate; });
    await waitFor(() => expect(reading).toBe(true));
    const search = screen.getByLabelText('Search questions and outcomes');
    await waitFor(() => expect(search.hasAttribute('disabled')).toBe(false));
    expect(completed).toBe(false);
    if (outcome === 'parent selection') {
      fireEvent.click(document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!);
      await screen.findByLabelText('Owner input for #1');
      await waitFor(() => expect(search.hasAttribute('disabled')).toBe(false));
    } else if (outcome === 'tab close') {
      fireEvent.click(screen.getByRole('button', { name: /Close .* tab/ }));
      await screen.findByRole('heading', { name: 'Projects' });
    }
    await act(async () => { releaseRead(); await readGate; });
    await waitFor(() => expect(completed).toBe(true));
    if (outcome === 'tab close') {
      expect(screen.queryByLabelText('Owner input for #1')).toBeNull();
      expect(transport.preferences.sessions[0].tab_open).toBe(false);
    } else expect(screen.getByLabelText('Owner input for #1')).toBeTruthy();
    if (outcome === 'read failure') expect(document.querySelector('.nav-banner[role="alert"]')).not.toBeNull();
    expect(transport.preferences.global.theme).toBe('light');
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
    expect(mutations(transport, 'preferences_patch').some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id === '1.1'))).toBe(false);
  });
  it('retains the newer parent selection when child navigation finishes its late catalogue read', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    let release!: () => void, entered = false, completed = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const hold = !('command' in args.request) && args.request.request.command === 'project_list'
        && transport.preferences.sessions[0].selected_item_id === '1.1' && !entered;
      if (hold) { entered = true; await gate; }
      const response = await invoke(name, args);
      if (hold) completed = true;
      return response;
    });
    fireEvent.click(within(screen.getByRole('region', { name: 'Child items' })).getByRole('button', { name: /Item 1\.1/ }));
    await waitFor(() => expect(entered).toBe(true));
    await screen.findByLabelText('Owner input for #1.1');
    const search = screen.getByLabelText('Search questions and outcomes');
    await waitFor(() => expect(search.hasAttribute('disabled')).toBe(false));
    expect(completed).toBe(false);
    const parent = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!;
    fireEvent.click(parent);
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    await waitFor(() => expect(search.hasAttribute('disabled')).toBe(false));
    expect(completed).toBe(false);
    await act(async () => { release(); await gate; });
    await waitFor(() => expect(completed).toBe(true));
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
    expect(document.querySelector('.item-history > .history-header > strong')?.textContent).toBe('Item 1');
    expect(screen.getByLabelText('Owner input for #1')).toBeTruthy();
    expect(parent.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('region', { name: 'Child items' })).toBeTruthy();
  });
  it.each(['confirmed', 'reconciled'])('admits parent selection only after child navigation is %s', async completion => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_global')
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id === '1.1')) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    fireEvent.click(within(screen.getByRole('region', { name: 'Child items' })).getByRole('button', { name: /Item 1\.1/ }));
    await waitFor(() => expect(entered).toBe(true));
    const parent = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!;
    expect(parent.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByLabelText('Search questions and outcomes').hasAttribute('disabled')).toBe(true);
    const revealReads = transport.queries.filter(query => query.request.command === 'reveal_item').length;
    fireEvent.click(parent); fireEvent.keyDown(parent, { key: 'Enter' });
    expect(transport.queries.filter(query => query.request.command === 'reveal_item')).toHaveLength(revealReads);
    if (completion === 'reconciled') transport.failNext = 'preferences_patch';
    await act(async () => { release(); await gate; });
    if (completion === 'reconciled') {
      const reconcile = await screen.findByRole('button', { name: 'Reconcile operation' });
      expect(parent.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(parent); fireEvent.keyDown(parent, { key: 'Enter' });
      expect(transport.queries.filter(query => query.request.command === 'reveal_item')).toHaveLength(revealReads);
      fireEvent.click(reconcile);
    }
    await screen.findByLabelText('Owner input for #1.1');
    await waitFor(() => expect(parent.hasAttribute('aria-disabled')).toBe(false));
    fireEvent.keyDown(parent, { key: 'Enter' });
    await screen.findByLabelText('Owner input for #1');
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    expect(parent.getAttribute('aria-selected')).toBe('true');
  });
  it.each(['confirmed', 'reconciled'])('admits rail Close only after a shared preference write is %s', async completion => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByLabelText('Owner input for #1');
    fireEvent.click(screen.getByRole('button', { name: 'Messages (m)' }));
    await screen.findByRole('log', { name: 'Complete session messages' });
    await waitFor(() => expect(transport.preferences.sessions[0].rail).toBe('activity'));
    let release!: () => void, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_session_view' && entry.preferences.selected_item_id === '2')) {
        entered = true; await gate;
      }
      return invoke(name, args);
    });
    fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="2"]')!);
    await waitFor(() => expect(entered).toBe(true));
    const close = screen.getByRole('button', { name: 'Close message rail' });
    expect(close.hasAttribute('disabled')).toBe(true);
    const writes = mutations(transport, 'preferences_patch').length;
    fireEvent.click(close); fireEvent.keyDown(document.querySelector('.product-app')!, { key: 'm' });
    expect(screen.getByRole('log', { name: 'Complete session messages' })).toBeTruthy();
    expect(mutations(transport, 'preferences_patch')).toHaveLength(writes);
    if (completion === 'reconciled') transport.failNext = 'preferences_patch';
    await act(async () => { release(); await gate; });
    if (completion === 'reconciled') {
      const reconcile = await screen.findByRole('button', { name: 'Reconcile operation' });
      expect(close.hasAttribute('disabled')).toBe(true);
      fireEvent.click(close); fireEvent.keyDown(document.querySelector('.product-app')!, { key: 'm' });
      expect(mutations(transport, 'preferences_patch')).toHaveLength(writes + 1);
      fireEvent.click(reconcile);
    }
    await waitFor(() => expect(close.hasAttribute('disabled')).toBe(false)); fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('log', { name: 'Complete session messages' })).toBeNull());
    expect(transport.preferences.sessions[0].rail).toBe('hidden');
  });
  it('closes detail with Escape in the owner editor and keeps its draft for reopening', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    const editor = await screen.findByLabelText('Reply message');
    fireEvent.change(editor, { target: { value: 'Retain this draft when Escape closes detail.' } });
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.text === 'Retain this draft when Escape closes detail.')).toBe(true));
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Owner actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close detail' })).toBeNull();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    expect((await screen.findByLabelText('Reply message') as HTMLTextAreaElement).value).toBe('Retain this draft when Escape closes detail.');
    expect(mutations(transport, 'input_submit')).toHaveLength(0);
  });
  it('retains an unsent owner draft across tab close and reopen', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    fireEvent.change(await screen.findByLabelText('Reply message'), { target: { value: 'Keep this draft across views.' } });
    await waitFor(() => expect(transport.preferences.drafts.some(draft => draft.text === 'Keep this draft across views.')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Close .* tab/ }));
    await screen.findByRole('heading', { name: 'Projects' });
    await allSessions(); await openSession();
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    expect((await screen.findByLabelText('Reply message') as HTMLTextAreaElement).value).toBe('Keep this draft across views.');
    expect(mutations(transport, 'input_submit')).toHaveLength(0);
  });
  it('persists Later from the selected row while z typed in the owner editor stays draft text', async () => {
    const { transport } = setup(); await openSession();
    const row = () => document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="1"]')!;
    fireEvent.click(row()); fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    const editor = await screen.findByLabelText('Reply message') as HTMLTextAreaElement;
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    await act(async () => { row().focus(); fireEvent.keyDown(row(), { key: 'z' }); });
    await waitFor(() => expect(transport.preferences.later).toEqual([{ ...route, item_id: '1' }]));
    const laterWrites = () => mutations(transport, 'preferences_patch').filter(write => write.command.command === 'preferences_patch'
      && write.command.params.entries.some(entry => entry.kind === 'set_later'));
    expect(laterWrites()).toHaveLength(1); expect(editor.value).toBe('');
    editor.focus(); fireEvent.keyDown(editor, { key: 'z' }); fireEvent.change(editor, { target: { value: 'z' } });
    await waitFor(() => expect(transport.preferences.drafts.find(draft => draft.target.item_id === '1')?.text).toBe('z'));
    expect(laterWrites()).toHaveLength(1); expect(document.activeElement).toBe(editor);
  });
  it('writes theme through navigation with exact explicit reconciliation while retaining unrelated global and draft preferences', async () => {
    const { transport } = setup(); await screen.findByRole('heading', { name: 'All sessions' });
    const before = structuredClone(transport.preferences); transport.failNext = 'preferences_patch';
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' }));
    await screen.findByRole('button', { name: 'Reconcile operation' });
    const request = structuredClone(mutations(transport, 'preferences_patch')[0]);
    expect(request.command).toMatchObject({ params: { entries: [{ kind: 'set_global', preferences: { ...before.global, theme: 'light' } }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile operation' }));
    await screen.findByRole('button', { name: 'Switch to dark' });
    expect(mutations(transport, 'preferences_patch')[1]).toEqual(request);
    expect(transport.preferences.drafts).toEqual(before.drafts);
    expect(transport.preferences.global.selected_navigation).toEqual(before.global.selected_navigation);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
