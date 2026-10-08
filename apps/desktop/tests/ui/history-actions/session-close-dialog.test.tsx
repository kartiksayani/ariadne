import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { CloseSessionDialog } from '../../../src/ui/pages/SessionDialogs';
import { notices } from '../../../src/ui/pages/notices';
import { route } from '../app/transport';
import { HistoryTransport } from './fixture';

const op = '00000000-0000-4000-8000-000000000098';
const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); notices.clear(); opened.splice(0).forEach(sessions => sessions.closeAll()); });

type Shape = 'connected' | 'disconnected' | 'paused' | 'unbound';
async function setup(shape: Shape, settled = true) {
  const transport = new HistoryTransport();
  if (settled) {
    Object.values(transport.source.items).forEach(item => { if (item) { item.status = 'done'; item.waiting_since = null; } });
    transport.source.inputs = {};
  }
  const binding = transport.source.bindings[transport.source.active_binding_id!]!;
  if (shape === 'connected') { binding.dispatch_state = 'enabled'; binding.connection_state = 'connected'; binding.owner_paused = false; }
  if (shape === 'disconnected') { binding.dispatch_state = 'disconnected'; binding.connection_state = 'disconnected'; }
  if (shape === 'paused') { binding.dispatch_state = 'paused'; binding.connection_state = 'connected'; binding.owner_paused = true; }
  if (shape === 'unbound') transport.source.active_binding_id = null;
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const actions = new SessionActionControllers(service, () => op).forSession(store);
  let closed = 0;
  render(<CloseSessionDialog store={store} actions={actions} agent="codex" when="Today" onClose={() => { closed += 1; }} />);
  return { transport, closed: () => closed };
}
const dialog = () => within(screen.getByRole('dialog'));
const closeButton = () => dialog().getByRole('button', { name: 'Close session' }) as HTMLButtonElement;

describe('Close session dialog from the session pages', () => {
  it.each(['connected', 'disconnected', 'paused', 'unbound'] as const)('closes a %s session in one confirmation, without pausing first', async shape => {
    const { transport, closed } = await setup(shape);
    expect(dialog().queryByRole('button', { name: /Pause/ })).toBeNull();
    expect(closeButton().disabled).toBe(false);
    await act(async () => { fireEvent.click(closeButton()); });
    expect(transport.mutations.map(value => value.command.command)).toEqual(['session_close']);
    expect(closed()).toBe(1);
  });

  it('says what stays open and what it cancels, closes anyway and reports the cancelled messages', async () => {
    const { transport, closed } = await setup('connected', false);
    const unsent = Object.values(transport.source.inputs).filter(input => input && ['queued', 'in_flight', 'needs_attention'].includes(input.state)).length;
    expect(unsent).toBeGreaterThan(0);
    const warning = screen.getByRole('dialog').querySelector('[data-close-warning]')!;
    // The queued (or failed) ones haven't reached codex; the one in flight is being delivered.
    expect(warning.textContent).toMatch(/still open, \d+ of your messages ha(s|ve)n’t reached codex and 1 is being delivered — closing cancels those messages\.$/);
    expect(closeButton().disabled).toBe(false);
    await act(async () => { fireEvent.click(closeButton()); });
    expect(transport.source.state).toBe('closed'); expect(closed()).toBe(1);
    expect(notices.getSnapshot().map(notice => notice.text)).toContain(
      `Closed the codex session. ${unsent} unsent message${unsent === 1 ? ' was' : 's were'} cancelled.`);
  });
});
