import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { HistoryTransport } from '../history-actions/fixture';
import { goToSession } from './open';
import { route } from './transport';

afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); });

it('keeps the sole topic archive strip actionable through queued navigation and reconciliation with item detail open', async () => {
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
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
  });
  fireEvent.click(document.querySelector(`[role="treeitem"][data-item-id="${item.id}"]`)!);
  await screen.findByRole('article', { name: `Detail of ${item.question}` });

  fireEvent.click(await screen.findByRole('button', { name: 'Archive topic' }));
  // E33: archive asks first, then leaves one strip in the topic's place whose click is Undo.
  const dialog = within(await screen.findByRole('dialog', { name: `Archive the “${topic.name}” topic?` }));
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Archive topic' })); });
  const stripName = new RegExp(`^Archived “${topic.name}” · 1 item · Undo$`);
  const strip = await screen.findByRole('treeitem', { name: stripName });
  expect(screen.getByTestId('toast').textContent).toContain(`Archived “${topic.name}”. It’s in Archive with all its history.`);
  expect(topic.archived_at).not.toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.querySelector(`[data-item-id="${item.id}"][role="treeitem"]`)).toBeNull());

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
    // The strip outlives a navigation to the session already shown.
    const current = screen.getByRole('treeitem', { name: stripName });
    expect(current.closest('[inert],[aria-hidden="true"]')).toBeNull();
    expect(current.isConnected).toBe(true);
    expect(strip.getAttribute('data-row')).toBe(current.getAttribute('data-row'));
    expect(screen.queryByRole('button', { name: 'Messages (m)' })).toBeNull();
  };
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light' }));
    await waitFor(() => expect(writing).toBe(true));
    // Choosing the session already shown, from the top bar's switcher, queues a navigation behind the held write.
    const switcher = document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]')!;
    expect(switcher.disabled).toBe(false);
    fireEvent.click(switcher);
    const current = within(await screen.findByRole('dialog', { name: 'Switch session or project' }))
      .getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true')!;
    fireEvent.click(current);
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
  fireEvent.click(within(screen.getByRole('treeitem', { name: stripName })).getByRole('button'));
  await waitFor(() => expect(topic.archived_at).toBeNull());
  await waitFor(() => expect(document.querySelector(`[data-item-id="${item.id}"][role="treeitem"]`)).not.toBeNull());
  await waitFor(() => expect(screen.queryByRole('treeitem', { name: stripName })).toBeNull());
  expect(transport.mutations.filter(request => ['topic_archive', 'topic_restore'].includes(request.command.command)).map(request => request.command.command))
    .toEqual(['topic_archive', 'topic_restore']);
  expect(item.status).toBe('done');
}, 10_000);
