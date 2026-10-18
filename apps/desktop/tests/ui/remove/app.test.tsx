// Remove through the composed app: the detail trash and ⌫ ask first, the row goes
// at once, Undo brings it back, and leaving the page runs the command.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route, secondId } from '../app/transport';
import { goToSession } from '../app/open';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-item-id="${id}"]`);

const ready = async () => {
  await goToSession(route); await screen.findByRole('tree', { name: 'Session items' });
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-busy')).toBe('false');
  });
};
const removeKey = async (id: string) => {
  fireEvent.click(row(id)!);
  await waitFor(() => expect(row(id)!.getAttribute('aria-selected')).toBe('true'));
  row(id)!.focus(); fireEvent.keyDown(row(id)!, { key: 'Delete' });
};
const strip = (name: RegExp) => screen.findByRole('button', { name });

// Never lose typed text (E28): each row's words are quoted with Copy before the command runs, or it goes at once only
// when there are none. Fixture: item 4 has a cancelled note and a queued drop; item 1 has a cancelled answer and 1.1 below.
it.each([
  ['a leaf with none of your words goes at once', '8', null, 0],
  ['a leaf with words asks, quoting each one', '4', 'Remove item', 2],
  ['a parent asks, listing what goes together', '1', 'Remove 2 items', 1],
] as const)('%s', async (_, id, confirm, quotes) => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  await ready();
  await removeKey(id);
  if (confirm) {
    const dialog = await screen.findByRole('dialog', { name: /^Remove “/ });
    expect(within(dialog).getAllByTestId('dialog-quote')).toHaveLength(quotes);
    expect(within(dialog).getAllByRole('button', { name: 'Copy' })).toHaveLength(quotes);
    if (id === '1') expect(within(dialog).getByRole('region', { name: 'Removed together' }).querySelectorAll('li')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
  } else expect(screen.queryByRole('dialog')).toBeNull();
  // The rows give way to one strip in their place; the toast says when the agent is told.
  await waitFor(() => expect(row(id)).toBeNull());
  await strip(/^Removed “/);
  expect(screen.getByTestId('toast').textContent).toMatch(/is told in 5 s\./);
  expect(transport.mutations.some(request => request.command.command === 'item_remove')).toBe(false);
}, 10_000);

it('the strip undoes; leaving the page runs the command and the strip goes', async () => {
  const transport = new AppTransport(); render(<DesktopApp service={createDesktopService(transport)} />);
  await ready();
  await removeKey('8');
  fireEvent.click(await strip(/^Removed “/));
  await waitFor(() => expect(row('8')).not.toBeNull());
  expect(screen.queryByRole('button', { name: /^Removed “/ })).toBeNull();
  await removeKey('8');
  await strip(/^Removed “/);
  await act(async () => { window.dispatchEvent(new Event('pagehide')); });
  await waitFor(() => expect(transport.mutations.find(request => request.command.command === 'item_remove')).toMatchObject({
    session: route, command: { params: { item_id: '8' } } }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Removed “/ })).toBeNull());
  expect(row('8')).toBeNull();
}, 10_000);

// The Archive page's Remove of an archived topic takes the app's Remove flow (E34): its words quoted with Copy, the
// family check, the pinned review. An archived topic can't be archived instead.
const T10 = '00000000-0000-4000-8000-000000000010', T11 = '00000000-0000-4000-8000-000000000011';
async function archivePage() {
  const trigger = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-popover-trigger="switcher"]');
    expect(button).not.toBeNull(); expect(button!.disabled).toBe(false); return button!;
  });
  fireEvent.click(trigger);
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Switch session or project' })).getByRole('button', { name: 'Archive' }));
  await screen.findByRole('heading', { name: 'Archive', level: 1 });
}
async function askArchived(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `More for ${name}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from Ariadne/ }));
  return within(await screen.findByRole('dialog', { name: `Remove the “${name}” topic?` }));
}

it.each([
  // Archiving cancelled the queued drop (`topic_archived`); removing the archived topic deletes it, so it's quoted.
  ['quotes every word, the archive-cancelled ones too, and removes after the family check', route.session_id, T10, false],
  // The session isn't read yet (archived sessions aren't watched): it is read first, then asked the same way.
  ['in an archived session not read yet, reads it first and asks the same way', secondId, T10, false],
  // A copy continued from elsewhere: core would remove it there too, and words there can't be shown.
  ['a continued topic can only be cancelled', route.session_id, T11, true],
] as const)('Archive page topic Remove: %s', async (_, sessionId, topicId, family) => {
  const transport = new AppTransport();
  // The second session holds a copy of the first's work, archived with it.
  if (sessionId === secondId) transport.sessions.set(secondId, { ...structuredClone(transport.sessions.get(route.session_id)!), id: secondId, title: 'Separate session', archived_at: transport.sessions.get(secondId)!.updated_at });
  const session = transport.sessions.get(sessionId)!;
  session.topics[topicId]!.archived_at = session.updated_at;
  const drop = session.inputs['00000000-0000-4000-8000-000000000076']!;
  drop.state = 'cancelled'; drop.cancel_cause = 'topic_archived';
  render(<DesktopApp service={createDesktopService(transport)} />);
  await ready();
  await archivePage();
  const name = session.topics[topicId]!.name;
  const dialog = await askArchived(name);
  // Already archived: no "Archive instead", and no note offering it.
  expect(dialog.queryByRole('button', { name: /Archive instead/ })).toBeNull();
  expect(dialog.queryByText(/archive it instead/)).toBeNull();
  if (family) {
    await waitFor(() => expect(dialog.getByText(/continues? in|may continue in another session/)).toBeTruthy());
    expect(dialog.queryByRole('button', { name: 'Remove topic' })).toBeNull();
    expect(dialog.getAllByRole('button').map(button => button.textContent)).toEqual([expect.stringMatching(/^Cancel/)]);
    fireEvent.click(dialog.getByRole('button', { name: /^Cancel/ }));
  } else {
    const quotes = dialog.getAllByTestId('dialog-quote').map(quote => quote.querySelector('blockquote')!.textContent);
    expect(quotes).toHaveLength(5);
    expect(quotes).toContain(drop.payload.text);
    expect(dialog.getAllByRole('button', { name: 'Copy' })).toHaveLength(5);
    const remove = await waitFor(() => { const button = dialog.getByRole<HTMLButtonElement>('button', { name: 'Remove topic' }); expect(button.disabled).toBe(false); return button; });
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByRole('button', { name: `More for ${name}` })).toBeNull());
  }
  expect(transport.mutations.some(request => request.command.command === 'topic_remove')).toBe(false);
}, 15_000);

// E27 for a whole session: core deletes every input in it, so the Archive page's session Remove quotes them all first.
it('Archive page session Remove quotes every word in the session with Copy before Remove can run', async () => {
  const transport = new AppTransport(), first = transport.sessions.get(route.session_id)!;
  transport.sessions.set(secondId, { ...structuredClone(first), id: secondId, title: 'Separate session', archived_at: first.updated_at });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await ready();
  await archivePage();
  fireEvent.click(await screen.findByRole('button', { name: /^More for / }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Remove from Ariadne/ }));
  const dialog = within(await screen.findByRole('dialog', { name: /^Remove / }));
  const remove = await waitFor(() => { const button = dialog.getByRole<HTMLButtonElement>('button', { name: 'Remove session' }); expect(button.disabled).toBe(false); return button; });
  const texts = Object.values(first.inputs).filter(input => input && ['queued', 'in_flight', 'needs_attention', 'cancelled'].includes(input.state)).map(input => input!.payload.text);
  expect(dialog.getAllByTestId('dialog-quote').map(quote => quote.querySelector('blockquote')!.textContent).sort()).toEqual(texts.sort());
  expect(dialog.getAllByRole('button', { name: 'Copy' })).toHaveLength(texts.length);
  expect(dialog.getByText(/haven’t reached .* yet; removing cancels them; copy your words below first\./)).toBeTruthy();
  fireEvent.click(remove);
  expect(transport.mutations.some(request => request.command.command === 'session_remove')).toBe(false);
}, 15_000);
