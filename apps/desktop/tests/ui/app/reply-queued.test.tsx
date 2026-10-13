import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from './transport';

afterEach(() => { cleanup(); notices.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function replySession() {
  const transport = new AppTransport(), first = transport.sessions.get(route.session_id)!;
  const other = structuredClone(first); other.id = secondId; other.title = 'Other questions';
  other.inputs = {}; other.operation_receipts = {};
  other.items['2']!.options = [];
  other.rounds[other.items['2']!.current_round_id!]!.options_snapshot = [];
  transport.sessions.set(secondId, other);
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0], { tab_open: true, rail: 'waiting' });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('region', { name: 'Session tree' });
  await waitFor(() => expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false'));
  const card = await waitFor(() => {
    const target = document.querySelector<HTMLElement>(`[data-waiting-item="2"][data-session-id="${secondId}"]`);
    expect(target).not.toBeNull(); return target!;
  });
  return { transport, other, card };
}

async function queuedReply() {
  const { transport, other, card } = await replySession();
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
  const header = document.querySelector<HTMLElement>('.shell-header')!;
  const theme = within(header).getByRole<HTMLButtonElement>('button', { name: 'Switch to light' });
  await waitFor(() => expect(theme.disabled).toBe(false));
  fireEvent.click(theme);
  await waitFor(() => expect(writing).toBe(true));
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const replyFocus = () => focus.mock.contexts.filter(element => element instanceof HTMLElement && element.getAttribute('aria-label') === 'Reply in your own words');
  try {
    vi.useFakeTimers();
    card.focus(); fireEvent.keyDown(card, { key: 'r', code: 'KeyR' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText('Opening the session…')).toBeTruthy();
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(replyFocus()).toHaveLength(0);
  } catch (error) { await act(async () => { release(); }); throw error; }
  finally { vi.useRealTimers(); }
  return { transport, other, release, replyFocus };
}

describe('Reply after queued navigation', { timeout: 10_000 }, () => {
  it('selects the other session and focuses Reply exactly once after an owner save exceeds the handoff timer', async () => {
    const { transport, other, release, replyFocus } = await queuedReply();
    try {
      await act(async () => { release(); });
      const detail = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
      const words = within(detail).getByLabelText<HTMLTextAreaElement>('Reply in your own words');
      await waitFor(() => expect(document.activeElement === words).toBe(true));
      expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
      expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.selected_item_id).toBe('2');
      expect(replyFocus()).toEqual([words]);
      ++other.revision;
      await act(async () => { transport.emit('ariadne://session_changed', { session_id: secondId, revision: other.revision }); });
      await waitFor(() => expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false'));
      expect(document.activeElement).toBe(words);
      expect(replyFocus()).toEqual([words]);
      expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    } finally { await act(async () => { release(); }); }
  });

  it('abandons Reply focus when a newer Projects navigation supersedes the queued session', async () => {
    const { transport, release, replyFocus } = await queuedReply();
    try {
      fireEvent.click(within(screen.getByLabelText('Projects and sessions')).getByRole('button', { name: 'Projects' }));
      expect(screen.getByText('Opening Projects…')).toBeTruthy();
      await act(async () => { release(); });
      await waitFor(() => expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'projects' }));
      await waitFor(() => expect(screen.queryByText('Opening Projects…')).toBeNull());
      expect(screen.queryByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' })).toBeNull();
      expect(replyFocus()).toHaveLength(0);
      expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.selected_item_id ?? null).toBeNull();
      expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    } finally { await act(async () => { release(); }); }
  });

  it('focuses Reply after a failed queued reveal retries and confirms the same navigation', async () => {
    const { transport, card } = await replySession();
    const navigations = vi.spyOn(NavigationStore.prototype, 'navigate');
    let releaseReveal!: () => void, releaseSave!: () => void, resolving = false, writing = false, attempts = 0;
    const heldReveal = new Promise<void>(resolve => { releaseReveal = resolve; });
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if (name === 'reveal_item' && request.session?.session_id === secondId && ++attempts === 1) {
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
      card.focus(); fireEvent.keyDown(card, { key: 'r', code: 'KeyR' });
      await waitFor(() => expect(resolving).toBe(true));
      const navigation = navigations.mock.contexts.at(-1) as NavigationStore;
      expect(navigation).toBeInstanceOf(NavigationStore);
      const request = navigation.getNavigationRequest();
      await act(async () => { save = navigation.saveTheme('light', navigation.getSnapshot().preferences!.revision); });
      await waitFor(() => expect(writing).toBe(true));
      await act(async () => { releaseReveal(); });
      expect(navigation.getSnapshot().pendingNavigation).not.toBeNull();
      expect(screen.queryByText(/This session could not be opened/)).toBeNull();
      expect(screen.queryByLabelText('Reply in your own words')).toBeNull();
      await act(async () => { releaseSave(); await save; });
      const detail = await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="2"]' });
      const words = within(detail).getByLabelText('Reply in your own words');
      await waitFor(() => expect(document.activeElement).toBe(words));
      expect(attempts).toBe(2);
      expect(navigation.getNavigationRequest()).toBe(request);
      expect(focus.mock.contexts.filter(element => element instanceof HTMLElement && element.getAttribute('aria-label') === 'Reply in your own words')).toEqual([words]);
      expect(screen.queryByText(/This session could not be opened/)).toBeNull();
    } finally { await act(async () => { releaseReveal(); releaseSave(); }); }
  });
});
