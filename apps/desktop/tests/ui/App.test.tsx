import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App, { DesktopApp } from '../../src/App';
import { createDesktopService } from '../../src/data/service';
import { AppTransport, route, secondId } from './app/transport';

vi.mock('react-dom/client', async importOriginal => {
  const actual = await importOriginal<typeof ReactDOM>();
  return { ...actual, createRoot: vi.fn(actual.createRoot) };
});

const mutations = (transport: AppTransport, command: string) => transport.mutations.filter(request => request.command.command === command);
async function openSession(id = route.session_id, pending = false) {
  const control = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(`button[data-session-id="${id}"]`);
    expect(button).not.toBeNull(); expect(button?.disabled).toBe(false); return button!;
  });
  fireEvent.click(control);
  await screen.findByRole('region', { name: 'Session workspace' });
  if (!pending) await waitFor(() => expect(screen.getByRole('button', { name: 'Pause dispatch' }).hasAttribute('disabled')).toBe(false));
}
async function allSessions() {
  const button = screen.getByRole('button', { name: 'All sessions' });
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
    expect(document.querySelector('.ref-header-context')?.textContent).toContain('Payments review');
    // No presence hint is emitted: opening after the host event must seed its canonical observation.
    await waitFor(() => expect(document.querySelector('.ref-header-context')?.textContent).toContain('Host running · fresh host event'));
    expect(transport.queries).toContainEqual({ session: null, request: { command: 'session_list', params: {
      project_id: route.project_id, state: null, cursor: null, limit: 100,
    } } });
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByRole('group', { name: 'Owner actions' });
    expect(screen.getAllByLabelText('Item detail')).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await screen.findAllByRole('region', { name: /Topic graph/ });
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(await screen.findByRole('tree', { name: 'Sentences' })).toBeTruthy();
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
    const tree = screen.getByRole('tree', { name: 'Sentences' }), detail = document.querySelector<HTMLElement>('.item-history')!;
    tree.scrollTop = 50; detail.scrollTop = 70; log.scrollTop = 123;
    const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
    const linked = session.messages.filter(message => message.item_id === '2' || message.items_touched.includes('2'));
    expect(linked.length).toBeGreaterThan(0);
    const message = linked.find(message => message.item_id !== '1' && !message.items_touched.includes('1'))!;
    expect(message).toBeTruthy();
    const card = log.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`)!;
    const mark = row.querySelector<HTMLElement>('.ref-tree-mark')!;
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
    await waitFor(() => expect(mark.style.background).toContain('75%'));
    expect(row.getAttribute('aria-selected')).toBe('false'); expect(document.activeElement).toBe(editor); unchanged();
    fireEvent.click(card.querySelector('.history-body')!); fireEvent.mouseLeave(card);
    expect(card.classList.contains('history-pinned')).toBe(true); expect(mark.style.background).toContain('75%'); unchanged();
    fireEvent.click(within(card).getByRole('button', { name: `Unpin message ${message.number}` }));
    await waitFor(() => expect(mark.style.background).toBe('transparent')); unchanged();
    fireEvent.mouseEnter(card); expect(mark.style.background).toContain('75%');
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await screen.findAllByRole('region', { name: /Topic graph/ });
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    const restored = await screen.findByRole('tree', { name: 'Sentences' });
    expect(restored.querySelector<HTMLElement>('[data-item-id="2"] .ref-tree-mark')!.style.background).toBe('transparent');
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
    fireEvent.click(screen.getByRole('button', { name: 'Pause dispatch' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm pause' }));
    await screen.findAllByRole('button', { name: 'Reconcile saved action' });
    const original = structuredClone(mutations(transport, 'binding_pause')[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Close .* tab/ }));
    await screen.findByRole('heading', { name: 'Projects' });
    await allSessions(); await openSession(secondId);
    expect(screen.queryByRole('button', { name: 'Reconcile saved action' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pause dispatch' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm pause' }));
    await screen.findByText('Action saved. Review the current binding before any further dispatch.');
    expect(mutations(transport, 'binding_pause')[1].session?.session_id).toBe(secondId);
    await allSessions(); await openSession(route.session_id, true);
    expect(mutations(transport, 'binding_pause')).toHaveLength(2);
    fireEvent.click(within(screen.getByRole('region', { name: 'Binding lifecycle' })).getByRole('button', { name: 'Reconcile saved action' }));
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
    expect(await screen.findByText(/No sentences match these filters/)).toBeTruthy();
    expect(mutations(transport, 'input_submit')).toHaveLength(0);
  });
  it('opens a native route over an earlier local selection without clearing its filters', async () => {
    const { transport } = setup(); await openSession();
    fireEvent.click(document.querySelector('[data-item-id="1"]')!);
    await screen.findByRole('group', { name: 'Owner actions' });
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('1'));
    const filters = structuredClone(transport.preferences.sessions[0].filters);
    await act(async () => { transport.emit('ariadne://route', { ...route, item_id: '2' }); });
    await waitFor(() => expect(transport.preferences.sessions[0].selected_item_id).toBe('2'));
    expect(await screen.findByLabelText('Owner input for #2')).toBeTruthy();
    expect(transport.preferences.sessions[0].filters).toEqual(filters);
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
  it('writes theme through navigation with exact explicit reconciliation while retaining unrelated global and draft preferences', async () => {
    const { transport } = setup(); await screen.findByRole('heading', { name: 'All sessions' });
    const before = structuredClone(transport.preferences); transport.failNext = 'preferences_patch';
    fireEvent.click(screen.getByRole('button', { name: 'Theme: system' }));
    await screen.findByRole('button', { name: 'Reconcile operation' });
    const request = structuredClone(mutations(transport, 'preferences_patch')[0]);
    expect(request.command).toMatchObject({ params: { entries: [{ kind: 'set_global', preferences: { ...before.global, theme: 'light' } }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile operation' }));
    await screen.findByRole('button', { name: 'Theme: light' });
    expect(mutations(transport, 'preferences_patch')[1]).toEqual(request);
    expect(transport.preferences.drafts).toEqual(before.drafts);
    expect(transport.preferences.global.selected_navigation).toEqual(before.global.selected_navigation);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
