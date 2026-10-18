import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { route } from '../app/transport';
import { goToSession } from '../app/open';
import { HistoryTransport } from './fixture';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openSource() {
  await goToSession(route); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
      expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
    });
}
it.each(['Cancel', 'Escape', 'Close session'])('returns focus to the connection button after %s through an asynchronous lifecycle review', async finish => {
  const transport = new HistoryTransport(), user = userEvent.setup();
  render(<DesktopApp service={createDesktopService(transport)} />); await openSource();
  // Close session is on the top bar's connection card (SPEC 5.12), opened from the connection button.
  const trigger = document.querySelector<HTMLButtonElement>('[data-popover-trigger="connection"]')!;
  await user.click(trigger);
  const card = await waitFor(() => { const found = document.querySelector<HTMLElement>('.cc'); expect(found).not.toBeNull(); return found!; });
  let release!: () => void;
  const refresh = new Promise<void>(resolve => { release = resolve; });
  const invoke = transport.invoke.bind(transport);
  vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
    if (name === 'session_get') await refresh;
    return invoke(name, args);
  });
  // A hint leaves the visible session stale, so Close waits for the latest capture.
  ++transport.source.revision;
  act(() => { transport.emit('ariadne://session_changed', { session_id: route.session_id, revision: transport.source.revision }); });
  expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('stale');
  const close = within(card).getByRole('button', { name: 'Close session' });
  close.focus(); expect(document.activeElement).toBe(close);
  await user.click(close);
  expect(document.querySelector('.cc')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => { release(); });
  const review = await screen.findByRole('dialog', { name: /^Close / });
  if (finish === 'Escape') await user.keyboard('{Escape}');
  else await user.click(within(review).getByRole('button', { name: finish }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(transport.mutations.filter(value => value.command.command === 'session_close')).toHaveLength(finish === 'Close session' ? 1 : 0);
});

it('opens guarded history in ordinary App and sends an approved Continue into the explicitly selected target', async () => {
  const transport = new HistoryTransport(), source = structuredClone(transport.source);
  render(<DesktopApp service={createDesktopService(transport)} />); await openSource();
  const topic = Object.values(source.topics)[0]!, controls = within(screen.getByRole('treeitem', { name: topic.name }));
  fireEvent.click(controls.getByRole('button', { name: /^More actions for/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Archive topic/ }));
  // A topic with open items asks first; Archive is offered, never refused.
  const confirm = within(screen.getByRole('dialog', { name: `Archive “${topic.name}”?` }));
  expect((confirm.getByRole('button', { name: 'Archive topic' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
  expect(transport.mutations.filter(value => value.command.command === 'topic_archive')).toHaveLength(0);
  fireEvent.click(controls.getByRole('button', { name: 'Continue elsewhere' }));
  const picker = within(screen.getByRole('dialog', { name: `Continue “${topic.name}” in another session` }));
  // The topic's own session is not a target.
  expect(picker.queryByRole('button', { name: source.title })).toBeNull();
  fireEvent.click(picker.getByRole('button', { name: 'Separate session' }));
  await screen.findByRole('dialog', { name: new RegExp(`^Continue “${topic.name}” in “.+”$`) });
  const send = await screen.findByRole('button', { name: /^Send summary/ });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  expect(transport.mutations.filter(value => value.command.command === 'topic_continue')).toHaveLength(0);
  fireEvent.click(send);
  await waitFor(() => expect(transport.mutations.filter(value => value.command.command === 'topic_continue')).toHaveLength(1));
  // The flow ends with "Sent once", then Done.
  fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const request = transport.mutations.find(value => value.command.command === 'topic_continue')!;
  expect(request.session?.session_id).toBe(transport.target.id);
  expect(transport.source).toEqual(source);
  expect(screen.getByRole('region', { name: 'Session tree' }).textContent).toContain(topic.name);
});
