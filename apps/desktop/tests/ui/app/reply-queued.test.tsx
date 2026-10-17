// r on the selected waiting item focuses Details' answer composer exactly once, after a navigation that waited for an
// owner save, and only for the navigation that is still current. The agent isn't running, so the answer then queues.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { notices } from '../../../src/ui/pages/notices';
import { goToPage } from './open';
import { AppTransport, route } from './transport';

afterEach(() => { cleanup(); notices.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

const words = 'Reply in your own words';

/** The current session with item 2 selected: a free-text question (its own words), its agent not running. */
async function replySession() {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  session.items['2']!.options = [];
  session.rounds[session.items['2']!.current_round_id!]!.options_snapshot = [];
  session.bindings[session.active_binding_id!]!.connection_state = 'disconnected';
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0], { tab_open: true, selected_item_id: '2' });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false'));
  await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
  const row = document.querySelector<HTMLElement>('[role="treeitem"][data-item-id="2"]')!;
  return { transport, session, row };
}

async function queuedReply() {
  const { transport, session, row } = await replySession();
  let release!: () => void, writing = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    const request = args.request;
    if ('command' in request && request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
      writing = true; await gate;
    }
    return invoke(name, args);
  });
  const bar = document.querySelector<HTMLElement>('.tb')!;
  const theme = within(bar).getByRole<HTMLButtonElement>('button', { name: 'Switch to light' });
  await waitFor(() => expect(theme.disabled).toBe(false));
  fireEvent.click(theme);
  await waitFor(() => expect(writing).toBe(true));
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const replyFocus = () => focus.mock.contexts.filter(element => element instanceof HTMLElement && element.getAttribute('aria-label') === words);
  try {
    vi.useFakeTimers();
    row.focus(); fireEvent.keyDown(row, { key: 'r', code: 'KeyR' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText('Opening the session…')).toBeTruthy();
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(replyFocus()).toHaveLength(0);
  } catch (error) { await act(async () => { release(); }); throw error; }
  finally { vi.useRealTimers(); }
  return { transport, session, row, release, replyFocus };
}

describe('Reply after queued navigation', () => {
  it('focuses the composer exactly once after an owner save exceeds the handoff timer, then queues the answer', async () => {
    const { transport, session, release, replyFocus } = await queuedReply();
    try {
      await act(async () => { release(); });
      const detail = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
      const box = within(detail).getByLabelText<HTMLTextAreaElement>(words);
      await waitFor(() => expect(document.activeElement === box).toBe(true));
      expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
      expect(transport.preferences.sessions[0]?.selected_item_id).toBe('2');
      expect(replyFocus()).toEqual([box]);
      ++session.revision;
      await act(async () => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: session.revision }); });
      await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false'));
      expect(document.activeElement).toBe(box);
      expect(replyFocus()).toEqual([box]);
      expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
      // The agent isn't running: Send asks first, and "Queue it" queues the answer once.
      fireEvent.change(box, { target: { value: 'Queue this for later.' } });
      const send = within(detail).getByRole<HTMLButtonElement>('button', { name: /^Send/ });
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      const dialog = await screen.findByRole('dialog', { name: /isn’t running for this session/ });
      fireEvent.click(within(dialog).getByRole('button', { name: /^Queue it/ }));
      await waitFor(() => expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1));
      // Queued: Details shows the answer's steps from Queued, and the item no longer waits on me.
      const steps = await screen.findByRole('region', { name: 'Your answer' });
      expect(steps.textContent).toMatch(/^Your answerQueued/);
      expect(screen.getByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' }).textContent).toMatch(/^Queued/);
      expect(screen.queryByLabelText(words)).toBeNull();
    } finally { await act(async () => { release(); }); }
  });

  it('abandons Reply focus when a newer Projects navigation supersedes the queued one', async () => {
    const { transport, release, replyFocus } = await queuedReply();
    try {
      // The switcher stays usable while the owner's save is in flight.
      await goToPage('Projects');
      // A page opens at once and cancels the queued session navigation (the store's openPage); there is no "Opening Projects…" wait.
      await screen.findByRole('heading', { name: 'Projects' });
      expect(screen.queryByText('Opening the session…')).toBeNull();
      await act(async () => { release(); });
      // A page is never saved (SPEC 6.16): the saved selection stays the session, while the Projects page is what shows.
      await waitFor(() => expect(screen.queryByText('Opening the session…')).toBeNull());
      expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
      expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
      expect(screen.queryByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' })).toBeNull();
      expect(replyFocus()).toHaveLength(0);
      expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    } finally { await act(async () => { release(); }); }
  });

  it('focuses Reply after a failed queued reveal retries and confirms the same navigation', async () => {
    const { transport, row } = await replySession();
    const navigations = vi.spyOn(NavigationStore.prototype, 'navigate');
    let releaseReveal!: () => void, releaseSave!: () => void, resolving = false, writing = false, attempts = 0;
    const heldReveal = new Promise<void>(resolve => { releaseReveal = resolve; });
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if (name === 'reveal_item' && request.session?.session_id === route.session_id && ++attempts === 1) {
        resolving = true; await heldReveal;
        return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Folder temporarily unavailable', hint: '', retryable: true, field_errors: [] } };
      }
      if ('command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
        writing = true; await heldSave;
      }
      return invoke(name, args);
    });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    let save!: Promise<boolean>;
    try {
      row.focus(); fireEvent.keyDown(row, { key: 'r', code: 'KeyR' });
      await waitFor(() => expect(resolving).toBe(true));
      const navigation = navigations.mock.contexts.at(-1) as NavigationStore;
      expect(navigation).toBeInstanceOf(NavigationStore);
      const request = navigation.getNavigationRequest();
      await act(async () => { save = navigation.saveTheme('light', navigation.getSnapshot().preferences!.revision); });
      await waitFor(() => expect(writing).toBe(true));
      await act(async () => { releaseReveal(); });
      expect(navigation.getSnapshot().pendingNavigation).not.toBeNull();
      expect(screen.queryByText(/This session could not be opened/)).toBeNull();
      expect(focus.mock.contexts.filter(element => element instanceof HTMLElement && element.getAttribute('aria-label') === words)).toHaveLength(0);
      await act(async () => { releaseSave(); await save; });
      const detail = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
      const box = within(detail).getByLabelText(words);
      await waitFor(() => expect(document.activeElement).toBe(box));
      expect(attempts).toBe(2);
      expect(navigation.getNavigationRequest()).toBe(request);
      expect(focus.mock.contexts.filter(element => element instanceof HTMLElement && element.getAttribute('aria-label') === words)).toEqual([box]);
      expect(screen.queryByText(/This session could not be opened/)).toBeNull();
    } finally { await act(async () => { releaseReveal(); releaseSave(); }); }
  });
});
