import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { CloseSessionDialog } from '../../../src/ui/pages/SessionDialogs';
import { route } from '../app/transport';
import { HistoryTransport } from './fixture';

const op = '00000000-0000-4000-8000-000000000098';
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); });

type Shape = 'connected' | 'disconnected' | 'paused' | 'unbound';
async function setup(shape: Shape) {
  const transport = new HistoryTransport();
  Object.values(transport.source.items).forEach(item => { if (item) { item.status = 'done'; item.waiting_since = null; } });
  transport.source.inputs = {};
  const binding = transport.source.bindings[transport.source.active_binding_id!]!;
  if (shape === 'connected') { binding.dispatch_state = 'enabled'; binding.connection_state = 'connected'; }
  if (shape === 'disconnected') { binding.dispatch_state = 'disconnected'; binding.connection_state = 'disconnected'; }
  if (shape === 'paused') { binding.dispatch_state = 'paused'; binding.connection_state = 'connected'; binding.owner_paused = true; }
  if (shape === 'unbound') transport.source.active_binding_id = null;
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const actions = new SessionActionControllers(service, () => op).forSession(store);
  let closed = 0;
  render(<CloseSessionDialog store={store} actions={actions} agent="codex" when="Today" onOpenSession={() => {}} onClose={() => { closed += 1; }} />);
  return { transport, closed: () => closed };
}
const dialog = () => within(screen.getByRole('dialog'));
const closeButton = () => dialog().getByRole('button', { name: 'Close session' }) as HTMLButtonElement;

describe('Close session dialog from the session pages', () => {
  it('asks to pause a connected, dispatching binding first', async () => {
    const { transport } = await setup('connected');
    expect(closeButton().disabled).toBe(true);
    expect(dialog().getByRole('button', { name: 'Pause dispatch' })).toBeTruthy();
    expect(transport.mutations).toHaveLength(0);
  });

  it.each(['disconnected', 'paused', 'unbound'] as const)('closes a %s session straight away', async shape => {
    const { transport, closed } = await setup(shape);
    expect(dialog().queryByRole('button', { name: 'Pause dispatch' })).toBeNull();
    expect(closeButton().disabled).toBe(false);
    if (shape === 'disconnected') expect(dialog().getByText('Dispatch is already stopped (binding not connected).')).toBeTruthy();
    await act(async () => { fireEvent.click(closeButton()); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['session_close']);
    expect(closed()).toBe(1);
  });
});
