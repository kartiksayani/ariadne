import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { HistoryTransport } from '../history-actions/fixture';
import { goToSession } from './open';
import { route } from './transport';

afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); });

it('keeps the sole topic archive notice actionable through queued navigation and reconciliation with item detail open', async () => {
  const transport = new HistoryTransport(), session = transport.source;
  const item = session.items['8']!, topic = session.topics[item.topic_id]!;
  item.status = 'done';
  session.items = { [item.id]: item }; session.topics = { [topic.id]: topic }; session.inputs = {};
  const binding = session.bindings[session.active_binding_id!]!;
  binding.active_input_id = null; binding.owner_paused = true; binding.dispatch_state = 'paused';
  const service = createDesktopService(transport);
  render(<DesktopApp service={service} />);
  await goToSession(route);
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false');
  });
  fireEvent.click(document.querySelector(`[role="treeitem"][data-item-id="${item.id}"]`)!);
  await screen.findByRole('article', { name: `Detail of ${item.question}` });

  const region = screen.getByRole('region', { name: 'Notifications' });
  fireEvent.click(await screen.findByRole('button', { name: 'Archive topic' }));
  const undo = await within(region).findByRole<HTMLButtonElement>('button', { name: 'Undo' });
  const card = undo.closest<HTMLElement>('[data-notice-id]')!;
  expect(within(card).getByText(`Archived “${topic.name}”.`)).toBeTruthy();
  expect(topic.archived_at).not.toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.querySelector(`[data-item-id="${item.id}"][role="treeitem"]`)).toBeNull());
  await waitFor(() => expect(undo.disabled).toBe(false));

  const invoke = transport.invoke.bind(transport);
  let release!: () => void, writing = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if ('command' in args.request && args.request.command.command === 'preferences_patch'
      && args.request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
      writing = true; await gate;
    }
    return invoke(name, args);
  });
  const assertNotice = () => {
    expect(screen.getByRole('region', { name: 'Notifications' })).toBe(region);
    expect(region.parentElement).toBe(document.querySelector('.shell-notices'));
    expect(screen.getByRole('main').contains(region)).toBe(false);
    expect(region.closest('[inert],[aria-hidden="true"]')).toBeNull();
    expect(within(region).getByRole('button', { name: 'Undo' })).toBe(undo);
    expect(undo.closest('[data-notice-id]')).toBe(card);
    expect(card.isConnected).toBe(true); expect(undo.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Messages (m)' })).toBeNull();
  };
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' }));
    await waitFor(() => expect(writing).toBe(true));
    const tab = screen.getByRole('navigation', { name: 'Projects and sessions' }).querySelector<HTMLButtonElement>('[data-session-tab][aria-current="page"]')!;
    expect(tab.disabled).toBe(false);
    fireEvent.click(tab);
    await screen.findByText('Opening the session…');
    assertNotice();
    const captures = transport.queries.filter(query => query.request.command === 'preferences_get').length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(transport.queries.filter(query => query.request.command === 'preferences_get').length).toBeGreaterThan(captures));
    assertNotice();
  } finally {
    await act(async () => { release(); });
  }
  await waitFor(() => expect(screen.queryByText('Opening the session…')).toBeNull());
  expect(transport.preferences.global.theme).toBe('light');
  assertNotice();
  fireEvent.click(undo);
  await waitFor(() => expect(topic.archived_at).toBeNull());
  await waitFor(() => expect(document.querySelector(`[data-item-id="${item.id}"][role="treeitem"]`)).not.toBeNull());
  await waitFor(() => expect(within(region).queryByRole('button', { name: 'Undo' })).toBeNull());
  expect(transport.mutations.filter(request => ['topic_archive', 'topic_restore'].includes(request.command.command)).map(request => request.command.command))
    .toEqual(['topic_archive', 'topic_restore']);
  expect(item.status).toBe('done');
}, 10_000);
