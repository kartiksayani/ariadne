import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { route } from '../app/transport';
import { HistoryTransport } from './fixture';

afterEach(cleanup);
async function openSource() {
  const button = await waitFor(() => {
    const control = document.querySelector<HTMLButtonElement>(`button[data-session-id="${route.session_id}"]`);
    expect(control?.disabled).toBe(false); return control!;
  });
  fireEvent.click(button); await screen.findByRole('region', { name: 'History actions' });
}
it('opens guarded history in ordinary App and sends an approved Continue into the explicitly selected target', async () => {
  const transport = new HistoryTransport(), source = structuredClone(transport.source);
  render(<DesktopApp service={createDesktopService(transport)} />); await openSource();
  const controls = within(screen.getByRole('region', { name: 'History actions' })), topic = Object.values(source.topics)[0]!;
  fireEvent.click(controls.getByRole('button', { name: `Archive ${topic.name}` }));
  expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm topic archive' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(controls.getByRole('button', { name: `Continue ${topic.name}` }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Separate session' }));
  const send = await screen.findByRole('button', { name: 'Send to Separate session' });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  expect(transport.mutations.filter(value => value.command.command === 'topic_continue')).toHaveLength(0);
  fireEvent.click(send);
  await waitFor(() => expect(transport.mutations.filter(value => value.command.command === 'topic_continue')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const request = transport.mutations.find(value => value.command.command === 'topic_continue')!;
  expect(request.session?.session_id).toBe(transport.target.id);
  expect(transport.source).toEqual(source);
  expect(screen.getByRole('region', { name: 'Session workspace' }).textContent).toContain(topic.name);
});
