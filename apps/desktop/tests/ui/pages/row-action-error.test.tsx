// A page row's Close, Reopen or Rename shares its session's lifecycle with the top bar. An error that lifecycle already held
// (from an earlier action) is not the row action's: it must not be pushed as a notice or end the action on mount.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionActionControllers, type SessionActions } from '../../../src/components/bindings/actions';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { SessionRowAction } from '../../../src/ui/pages/SessionRowAction';
import { notices } from '../../../src/ui/pages/notices';
import { SessionLifecycleOwner, useSessionLifecycleFor } from '../../../src/ui/shared/SessionLifecycleOwner';
import { route } from '../app/transport';
import { HistoryTransport } from '../history-actions/fixture';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); notices.clear(); opened.splice(0).forEach(sessions => sessions.closeAll()); });

/** The top bar's side: its Close click on an already closed session leaves the lifecycle holding an error. */
function Bar({ actions, onDone }: { readonly actions: SessionActions; readonly onDone: () => void }) {
  const lifecycle = useSessionLifecycleFor(actions);
  const [acting, setActing] = useState(false);
  return <>
    <button type="button" onClick={() => lifecycle.close()}>Bar Close</button>
    <button type="button" onClick={() => setActing(true)}>Row Reopen</button>
    <output aria-label="Held error">{lifecycle.error ?? ''}</output>
    {acting && <SessionRowAction actions={actions} act="reopen" onDone={() => { setActing(false); onDone(); }} />}
  </>;
}

describe('a row action beside a lifecycle that already holds an error', () => {
  it('asks its own review and neither notices nor ends on the old error', async () => {
    const transport = new HistoryTransport(); transport.source.state = 'closed'; transport.source.closed_at = transport.source.updated_at;
    const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
    const store = sessions.open(route); await store.refresh();
    const actions = new SessionActionControllers(service, () => '00000000-0000-4000-8000-000000000096').forSession(store);
    const onDone = vi.fn();
    render(<SessionLifecycleOwner actions={actions}><Bar actions={actions} onDone={onDone} /></SessionLifecycleOwner>);
    fireEvent.click(screen.getByRole('button', { name: 'Bar Close' }));
    await waitFor(() => expect(screen.getByLabelText('Held error').textContent).toBe('This session is already closed. Nothing changed.'));
    fireEvent.click(screen.getByRole('button', { name: 'Row Reopen' }));
    expect(await screen.findByRole('dialog', { name: /^Reopen/ })).toBeTruthy();
    expect(notices.getSnapshot()).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });
});
