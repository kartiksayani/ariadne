import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionActionControllers } from '../../../src/components/bindings/actions';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { SessionLists } from '../../../src/ui/pages/SessionLists';
import { ArchivePage } from '../../../src/ui/pages/ArchivePage';
import { sessionKey } from '../../../src/ui/pages/model';
import { notices } from '../../../src/ui/pages/notices';
import { route, secondId } from '../app/transport';
import { HistoryTransport } from '../history-actions/fixture';
const stores: NavigationStore[] = [];
afterEach(() => { cleanup(); notices.clear(); stores.splice(0).forEach(store => store.stop()); });
async function setup(archived = false) {
  const transport = new HistoryTransport();
  const first = transport.sessions.get(route.session_id)!, second = transport.sessions.get(secondId)!;
  first.name = 'Open review'; second.name = 'Closed review'; second.state = 'closed'; second.closed_at = second.updated_at;
  if (archived) second.archived_at = second.updated_at;
  const service = createDesktopService(transport), navigation = new NavigationStore(service); stores.push(navigation); await navigation.start();
  const actions = new SessionActionControllers(service), state = navigation.getSnapshot();
  const props = { navigation, actions, projects: state.projects!.projects.items, sessions: state.sessions!.sessions.items,
    snapshots: new Map([...transport.sessions.values()].map(session => [sessionKey({ project_id: session.project_id, session_id: session.id }), session])),
    now: Date.now(), narrow: false, disabled: false, onOpenSession: vi.fn(), onRemove: vi.fn() };
  return { props, first, second, transport };
}
const rowName = (name: string) => screen.queryByRole('button', { name });
const tab = (name: RegExp) => within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name });

describe('All sessions status tabs', () => {
  it('opens on All (SPEC 14.2) and selects Open or Closed without writing', async () => {
    const { props, transport } = await setup(); render(<SessionLists {...props} currentSession={route} />);
    expect(tab(/^All/).getAttribute('aria-pressed')).toBe('true');
    expect(tab(/^Open/).getAttribute('aria-pressed')).toBe('false');
    expect(rowName('Open review')).toBeTruthy(); expect(rowName('Closed review')).toBeTruthy();
    fireEvent.click(tab(/^Open/));
    expect(rowName('Open review')).toBeTruthy(); expect(rowName('Closed review')).toBeNull();
    fireEvent.click(tab(/^Closed/));
    // A closed row keeps Close, greyed (SPEC 14.2); Reopen lives on the connection card of the opened session.
    const close = screen.getByRole('button', { name: 'Close Closed review' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true); expect(close.title).toBe('Already closed');
    expect(rowName('Open review')).toBeNull();
    fireEvent.click(tab(/^All/));
    expect(rowName('Open review')).toBeTruthy(); expect(rowName('Closed review')).toBeTruthy();
    expect(transport.mutations).toEqual([]);
  });
  it('a project with no sessions says what to do, names its last archived one, and opens Archive explicitly', async () => {
    const { props, first } = await setup(true); first.state = 'closed'; first.archived_at = '2026-10-01T00:00:00.000Z';
    await props.navigation.refresh();
    const onOpenArchive = vi.fn();
    render(<SessionLists {...props} single sessions={props.navigation.getSnapshot().sessions!.sessions.items} onOpenArchive={onOpenArchive} />);
    expect(screen.getByText(/^No sessions in /)).toBeTruthy();
    expect(screen.getByText(/Its last one, “.*”, is in Archive\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Archive' })); expect(onOpenArchive).toHaveBeenCalledOnce();
  });
  it('lists no archived session under any tab', async () => {
    const { props } = await setup(true); render(<SessionLists {...props} />);
    fireEvent.click(tab(/^All/)); expect(rowName('Closed review')).toBeNull();
  });
  it('a row opens its session, and its Rename names it through the Name dialog', async () => {
    const { props, transport } = await setup(); render(<SessionLists {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
    expect(props.onOpenSession).toHaveBeenCalledWith(route);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Open review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Name this session' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Next review' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /^Save name/ })); });
    await waitFor(() => expect(transport.mutations.map(request => request.command.command)).toContain('session_label_set'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Name this session' })).toBeNull());
  });
  it('a row’s Close asks once through the lifecycle review, then closes', async () => {
    const { props, transport } = await setup(); render(<SessionLists {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Open review' }));
    const review = await screen.findByRole('dialog', { name: /^Close / });
    expect(transport.mutations).toEqual([]);
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: 'Close session' })); });
    await waitFor(() => expect(transport.mutations.map(request => request.command.command)).toEqual(['session_close']));
  });
});
describe('the unified Archive page', () => {
  it('lists sessions and topics, and restores a topic without a current session', async () => {
    const { props, first } = await setup(true); const topic = Object.values(first.topics)[0]!; topic.archived_at = first.updated_at;
    render(<ArchivePage {...props} />);
    expect(screen.getByRole('heading', { name: 'Archive' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: /^Sessions · / })).getByRole('button', { name: 'Restore Closed review' })).toBeTruthy();
    const topics = screen.getByRole('region', { name: /^Topics · / });
    expect(within(topics).getByText(topic.name)).toBeTruthy();
    await act(async () => { fireEvent.click(within(topics).getByRole('button', { name: `Restore ${topic.name}` })); });
    await waitFor(() => expect(first.topics[topic.id]!.archived_at).toBeNull());
    expect(within(screen.getByRole('region', { name: /^Topics · / })).getByText('Back in the Map')).toBeTruthy();
  });
  it('a session row opens that archived session to read, without restoring it', async () => {
    const { props, second, transport } = await setup(true);
    render(<ArchivePage {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Closed review' }));
    expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith({ project_id: second.project_id, session_id: second.id });
    expect(transport.mutations).toEqual([]);
    expect(screen.getByRole('button', { name: 'Restore Closed review' })).toBeTruthy();
  });
  it('a topic row opens the session it was archived from', async () => {
    const { props, first, transport } = await setup(true); const topic = Object.values(first.topics)[0]!; topic.archived_at = first.updated_at;
    render(<ArchivePage {...props} />);
    fireEvent.click(within(screen.getByRole('region', { name: /^Topics · / })).getByRole('button', { name: topic.name }));
    expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith({ project_id: first.project_id, session_id: first.id });
    expect(transport.mutations).toEqual([]);
  });
  it('opens nothing while navigation is saving', async () => {
    const { props } = await setup(true);
    render(<ArchivePage {...props} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Closed review' }));
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });
  it('restores a session closed and says so in its row', async () => {
    const { props, transport } = await setup(true);
    render(<ArchivePage {...props} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore Closed review' })); });
    await waitFor(() => expect(transport.mutations.map(request => request.command.command)).toContain('session_restore'));
    expect(await screen.findByText('Restored, closed')).toBeTruthy();
  });
});
