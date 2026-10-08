import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { route } from '../app/transport';
import { sessionButton } from '../app/open';
import { HistoryTransport } from './fixture';

afterEach(cleanup);
async function openSource() {
  fireEvent.click(await sessionButton(route)); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close session' }).hasAttribute('disabled')).toBe(false));
}
it('opens guarded history in ordinary App and sends an approved Continue into the explicitly selected target', async () => {
  const transport = new HistoryTransport(), source = structuredClone(transport.source);
  render(<DesktopApp service={createDesktopService(transport)} />); await openSource();
  const topic = Object.values(source.topics)[0]!, controls = within(screen.getByRole('treeitem', { name: topic.name }));
  fireEvent.click(controls.getByRole('button', { name: 'Archive' }));
  // A topic with open items asks first; Archive is offered, never refused.
  const confirm = within(screen.getByRole('dialog', { name: `Archive “${topic.name}”?` }));
  expect((confirm.getByRole('button', { name: 'Archive topic' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
  expect(transport.mutations.filter(value => value.command.command === 'topic_archive')).toHaveLength(0);
  fireEvent.click(controls.getByRole('button', { name: 'Continue here' }));
  const picker = within(screen.getByRole('dialog', { name: `Continue “${topic.name}” in another session` }));
  // The topic's own session is not a target.
  expect(picker.queryByRole('button', { name: source.title })).toBeNull();
  fireEvent.click(picker.getByRole('button', { name: 'Separate session' }));
  await screen.findByRole('dialog', { name: `Continue “${topic.name}” in this session` });
  const send = await screen.findByRole('button', { name: /^Send to / });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  expect(transport.mutations.filter(value => value.command.command === 'topic_continue')).toHaveLength(0);
  fireEvent.click(send);
  await waitFor(() => expect(transport.mutations.filter(value => value.command.command === 'topic_continue')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const request = transport.mutations.find(value => value.command.command === 'topic_continue')!;
  expect(request.session?.session_id).toBe(transport.target.id);
  expect(transport.source).toEqual(source);
  expect(screen.getByRole('region', { name: 'Session tree' }).textContent).toContain(topic.name);
});
