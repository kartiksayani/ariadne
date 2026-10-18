import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { shortLabel } from '../../../src/ui/shared/short';
import { AppTransport, route } from '../app/transport';
import { useWideWindow } from '../shell/wideWindow';
useWideWindow();
/** The fixture's old in-flight messages get the "hasn't been picked up" notice (alpha.21 E17); these tests are about other notices. */
const alertsExceptStuck = () => screen.queryAllByRole('alert').filter(alert => !alert.querySelector('[data-notice-id^="stuck:"]'));

const original = '00000000-0000-4000-8000-000000000099';
afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); });

it.each(['registered lookup', 'source capture', 'navigation capture'] as const)(
  'keeps copied history and reports its unavailable source locally after a failed %s', async phase => {
    const transport = new AppTransport(), copy = transport.sessions.get(route.session_id)!;
    copy.items['1']!.origin = { project_id: original, session_id: original,
      topic_id: copy.items['1']!.topic_id, entity_id: '77', source_revision: 1 };
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    transport.preferences.sessions = [{ ...transport.view(), selected_item_id: '1' }];
    const source = structuredClone(copy);
    source.project_id = original; source.id = original;
    source.items['77'] = { ...source.items['1']!, id: '77', parent: null };
    let captures = 0;
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if (!('command' in request) && request.session?.project_id === original) {
        if (name === 'session_get') ++captures;
        if (name === 'reveal_item' && phase === 'registered lookup'
          || name === 'session_get' && captures === (phase === 'source capture' ? 1 : 2)) {
          return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Source folder missing', hint: '', retryable: false, field_errors: [] } };
        }
        if (name === 'session_get') return { api_version: 1, ok: true, data: { kind: name, data: { session: source, freshness: 'fresh' } } };
      }
      return invoke(name, args);
    });
    render(<DesktopApp service={createDesktopService(transport)} />);
    const sourceButton = await screen.findByRole<HTMLButtonElement>('button', { name: 'Source item' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false'));
    const detail = sourceButton.closest<HTMLElement>('.copied-provenance')!;
    fireEvent.click(sourceButton);
    const fallback = await within(detail).findByRole('status');
    expect(fallback.textContent).toContain('The original project folder is missing or can’t be read. Restore it or move it back, then try again. Full copied history remains here.');
    await waitFor(() => expect(sourceButton.disabled).toBe(false));
    expect(screen.queryByText(/Opening the session/)).toBeNull();
    expect(alertsExceptStuck()).toEqual([]);
    expect(notices.getSnapshot().some(notice => /couldn’t read or save|could not be opened/.test(notice.text))).toBe(false);
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
    expect(transport.mutations.some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_global'
        && entry.preferences.selected_navigation.kind === 'session' && entry.preferences.selected_navigation.session.project_id === original))).toBe(false);
    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: `Open copied item: ${shortLabel(copy.items['1']!)}` })); });
    await waitFor(() => expect(screen.queryByText(/Opening the session/)).toBeNull());
    expect(alertsExceptStuck()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Source item' })).toBe(sourceButton);
  }, 10_000);

it.each(['dock path', 'Back history'] as const)('reports an unavailable %s link without changing selection or leaving Opening', async caller => {
  const transport = new AppTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  transport.preferences.sessions = [{ ...transport.view(), selected_item_id: '1' }];
  await act(async () => { render(<DesktopApp service={createDesktopService(transport)} />); });
  await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1"]' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false'));
  if (caller === 'Back history') {
    await act(async () => { fireEvent.click(document.querySelector('[role="treeitem"][data-item-id="1.1"]')!); });
    await screen.findByLabelText(/^Detail of /, { selector: '[data-detail-item-id="1.1"]' });
    await waitFor(() => expect(screen.getByLabelText<HTMLButtonElement>('Back', { selector: 'button' }).disabled).toBe(false));
  }
  const selected = transport.preferences.sessions[0].selected_item_id;
  const invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if (name === 'reveal_item') return { api_version: 1, ok: false,
      error: { code: 'io_error', message: 'Link folder missing', hint: '', retryable: false, field_errors: [] } };
    return invoke(name, args);
  });
  if (caller === 'Back history') fireEvent.click(screen.getByLabelText('Back', { selector: 'button' }));
  else {
    // The dock's question title opens its question in Details.
    const dock = screen.getByRole('region', { name: 'Answer dock' });
    fireEvent.click(await within(dock).findByRole('button', { name: /^\d+ (more )?waiting$/ }));
    await waitFor(() => expect(dock.querySelector('.answer-dock-current [data-owner-input="2"]')).not.toBeNull());
    fireEvent.click(dock.querySelector<HTMLButtonElement>('.dock-question-open')!);
  }
  await screen.findByText('This session could not be opened. Check that its project folder is available, then try again.');
  expect(screen.queryByText(/couldn’t read or save/)).toBeNull();
  expect(screen.queryByText(/Opening the session/)).toBeNull();
  expect(transport.preferences.sessions[0].selected_item_id).toBe(selected);
  expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
  expect(screen.getByLabelText(/^Detail of /, { selector: `[data-detail-item-id="${selected}"]` })).toBeTruthy();
}, 10_000);

it('discards a delayed unavailable-source failure after Projects supersedes its one-second handoff', async () => {
  const transport = new AppTransport(), copy = transport.sessions.get(route.session_id)!;
  copy.items['1']!.origin = { project_id: original, session_id: original,
    topic_id: copy.items['1']!.topic_id, entity_id: '77', source_revision: 1 };
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  transport.preferences.sessions = [{ ...transport.view(), selected_item_id: '1' }];
  await act(async () => { render(<DesktopApp service={createDesktopService(transport)} />); });
  const source = await screen.findByRole('button', { name: 'Source item' });
  await waitFor(() => expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if (name === 'reveal_item' && args.request.session?.project_id === original) {
      await held;
      return { api_version: 1, ok: false, error: { code: 'io_error', message: 'Source folder missing', hint: '', retryable: false, field_errors: [] } };
    }
    return invoke(name, args);
  });
  try {
    vi.useFakeTimers();
    fireEvent.click(source);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText('Opening the session…')).toBeTruthy();
    // Projects is a page link in the switcher (not a saved selection): it shows at once and cancels the queued handoff.
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]')!);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Switch session or project' })).getByRole('button', { name: 'Projects' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); release(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
    // The page is not saved: the selection stays on the session it was on, and the handoff never lands.
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(screen.queryByText(/Opening|Full copied history|couldn’t read or save|could not be opened/)).toBeNull();
    expect(alertsExceptStuck()).toEqual([]);
    expect(notices.getSnapshot().filter(notice => !notice.id.startsWith('stuck:'))).toEqual([]);
    expect(transport.preferences.sessions[0].selected_item_id).toBe('1');
  } finally { await act(async () => { release(); }); vi.useRealTimers(); }
}, 10_000);
