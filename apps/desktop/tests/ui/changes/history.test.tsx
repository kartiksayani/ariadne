import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ItemChanges, loadItemChanges } from '../../../src/ui/changes/ItemChanges';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { AppTransport, route } from '../app/transport';
import { cursor } from '../history/fixtures';
import { changesFixture } from './fixture';

const sessions: OpenSessions[] = [];
afterEach(() => { cleanup(); sessions.splice(0).forEach(value => value.closeAll()); });
describe('item change context and history', () => {
  it('shows the reason and a source-answer link, keeps context after reading, and loads older wording changes', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    item.revision = 3; item.changes!.unshift(value.record({ revision: 1, wording_only: true, reason: 'Earlier wording.', before: { question: 'Earlier name.' } }));
    value.seen.items.push({ item_id: item.id, revision: 1 });
    const transport = new AppTransport(); transport.sessions.set(value.session.id, value.session);
    const service = createDesktopService(transport), opened = new OpenSessions(service); sessions.push(opened);
    const store = opened.open(route); await store.refresh();
    const onOpenAnswer = vi.fn();
    const view = render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={onOpenAnswer} />);
    expect(screen.getByRole('region', { name: 'What changed' })).toBeTruthy();
    expect(screen.getByText('The owner chose a smaller change.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'What changed' })).getByRole('button', { name: 'Changed after your typed answer ↗' }));
    expect(onOpenAnswer).toHaveBeenCalledWith(value.answer.item_id, value.answer.message_id);
    const seen = { ...value.seen, items: [{ item_id: item.id, revision: 3 }] };
    view.rerender(<ItemChanges service={service} store={store} session={value.session} item={item} seen={seen} onOpenAnswer={onOpenAnswer} />);
    expect(screen.getByRole('region', { name: 'What changed' })).toBeTruthy();
    const details = document.querySelector('details')!; details.open = true; fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(transport.queries.some(query => query.request.command === 'item_changes')).toBe(true));
    expect(await screen.findByText('Earlier wording.')).toBeTruthy();
    expect(screen.getByText(/Rewording/)).toBeTruthy();
  });
  it('does not headline a wording-only change', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!; item.changes![0].wording_only = true;
    const transport = new AppTransport(); transport.sessions.set(value.session.id, value.session);
    const service = createDesktopService(transport), opened = new OpenSessions(service); sessions.push(opened);
    const store = opened.open(route); await store.refresh();
    render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'What changed' })).toBeNull();
    expect(screen.getByText('Change history')).toBeTruthy();
  });
  it('follows item_changes pages, preserving large before text and rejecting wrong snapshot/cursor responses', async () => {
    const value = changesFixture(), large = 'Never lose this text. '.repeat(5000);
    const first = value.record({ before: { note: large } }), second = value.record({ revision: 3 });
    const query = vi.fn().mockResolvedValueOnce({ item_id: 'updated-0', changes: { items: [first], snapshot_revision: value.session.revision, next_cursor: cursor('item_changes', 1, value.session.revision) } })
      .mockResolvedValueOnce({ item_id: 'updated-0', changes: { items: [second], snapshot_revision: value.session.revision, next_cursor: null } });
    const service = { query } as unknown as ReturnType<typeof createDesktopService>;
    const result = await loadItemChanges(service, route, value.session.revision, 'updated-0', new AbortController().signal);
    expect(result.items).toEqual([first, second]); expect(result.items[0].before.note).toBe(large); expect(query).toHaveBeenCalledTimes(2);
    query.mockResolvedValue({ item_id: 'updated-0', changes: { items: [], snapshot_revision: value.session.revision + 1, next_cursor: null } });
    await expect(loadItemChanges(service, route, value.session.revision, 'updated-0', new AbortController().signal)).rejects.toThrow('invalid response');
    query.mockResolvedValue({ item_id: 'updated-0', changes: { items: [], snapshot_revision: value.session.revision, next_cursor: cursor('item_messages', 1, value.session.revision) } });
    await expect(loadItemChanges(service, route, value.session.revision, 'updated-0', new AbortController().signal)).rejects.toThrow('invalid response');
  });
});
