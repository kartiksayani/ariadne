import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ItemChanges, loadItemChanges } from '../../../src/ui/changes/ItemChanges';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { AppTransport, route } from '../app/transport';
import { cursor } from '../history/fixtures';
import { changesFixture } from './fixture';
import { clockTime } from '../../../src/ui/changes/clock';
import { resetBoxOpen } from '../../../src/ui/changes/boxOpen';
import { openBox } from './open-box';

const sessions: OpenSessions[] = [];
afterEach(() => { cleanup(); sessions.splice(0).forEach(value => value.closeAll()); resetBoxOpen(); });
async function setup(value: ReturnType<typeof changesFixture>) {
  const transport = new AppTransport(); transport.sessions.set(value.session.id, value.session);
  const service = createDesktopService(transport), opened = new OpenSessions(service); sessions.push(opened);
  const store = opened.open(route); await store.refresh();
  return { transport, service, store };
}
const timeText = (at: string) => clockTime(at);

describe('item change box and history', () => {
  it('shows the unseen head with Mark seen, the rows before → after and the reason, and links to the source answer', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    const { service, store } = await setup(value), onOpenAnswer = vi.fn(), onMarkSeen = vi.fn();
    render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={onOpenAnswer} onMarkSeen={onMarkSeen} />);
    const box = openBox(screen.getByRole('region', { name: 'What changed' }));
    expect(box.getAttribute('data-state')).toBe('unseen');
    expect(within(box).getByText(`Changed since you looked · ${timeText(value.record().at)}`)).toBeTruthy();
    // The fixture item is open, so its note is "Notes" (alpha.25 C); "Progress" is only for an item in progress.
    const row = within(box).getByText('Notes').parentElement!;
    expect(row.querySelector('del')?.textContent).toBe('Earlier note.');
    expect(row.querySelector('.change-after')?.textContent).toBe('Current note.');
    expect(within(box).getByText('Why').parentElement?.textContent).toContain('The owner chose a smaller change.');
    fireEvent.click(within(box).getByRole('button', { name: 'Changed after your typed answer ↗' }));
    expect(onOpenAnswer).toHaveBeenCalledWith(value.answer.item_id, value.answer.message_id);
    fireEvent.click(within(box).getByRole('button', { name: 'Mark seen' }));
    expect(onMarkSeen).toHaveBeenCalledExactlyOnceWith(item.id, item.revision);
  });
  it('keeps the box after the dwell or Mark seen: only the head text changes, and Mark seen goes', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    const { service, store } = await setup(value), onMarkSeen = vi.fn();
    const view = render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} onMarkSeen={onMarkSeen} />);
    const before = openBox(screen.getByRole('region', { name: 'What changed' })).querySelector('.change-rows')!.textContent;
    const seen = { ...value.seen, items: [{ item_id: item.id, revision: item.revision }] };
    view.rerender(<ItemChanges service={service} store={store} session={value.session} item={item} seen={seen} onOpenAnswer={vi.fn()} onMarkSeen={onMarkSeen} />);
    const box = screen.getByRole('region', { name: 'What changed' });
    expect(box.getAttribute('data-state')).toBe('seen');
    expect(within(box).getByText(`Changed at ${timeText(value.record().at)}`)).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Mark seen' })).toBeNull();
    expect(box.querySelector('.change-rows')!.textContent).toBe(before);
  });
  it('shows the latest change as "Changed at" for an item already seen when Details opens, without Mark seen', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    item.revision = 3; item.changes!.unshift(value.record({ revision: 2, at: '2026-10-09T10:00:00.000Z', reason: 'The earlier change.', before: { note: 'Oldest note.' } }));
    item.changes![1] = value.record({ revision: 3 });
    const seen = { ...value.seen, items: [{ item_id: item.id, revision: 3 }] };
    const { service, store } = await setup(value);
    render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={seen} onOpenAnswer={vi.fn()} onMarkSeen={vi.fn()} />);
    const box = openBox(screen.getByRole('region', { name: 'What changed' }));
    expect(box.getAttribute('data-state')).toBe('seen');
    expect(within(box).getByText(`Changed at ${timeText(value.record().at)}`)).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Mark seen' })).toBeNull();
    expect(within(box).getByText('The owner chose a smaller change.')).toBeTruthy();
    expect(within(box).getByRole('button', { name: 'Older history (1)' })).toBeTruthy();
  });
  it('offers no Mark seen without a handler', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    const { service, store } = await setup(value);
    render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Mark seen' })).toBeNull();
  });
  it('counts the older history, loads it on open with a time column, and marks a rewording as not counted', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!;
    item.revision = 3; item.changes!.unshift(value.record({ revision: 1, wording_only: true, reason: 'Earlier wording.', before: { question: 'Earlier name.' } }));
    value.seen.items.push({ item_id: item.id, revision: 1 });
    const { transport, service, store } = await setup(value);
    render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Older history (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Earlier wording.')).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(transport.queries.some(query => query.request.command === 'item_changes')).toBe(true));
    expect(await screen.findByText('Earlier wording.')).toBeTruthy();
    expect(screen.getByText(/not counted as a change/)).toBeTruthy();
    expect(document.querySelector('.change-event time')?.textContent).toBe(timeText(value.record().at));
    expect(screen.getByRole('button', { name: 'Older history (1)' }).getAttribute('aria-expanded')).toBe('true');
  });
  it('does not headline a wording-only change: no box, only "History N events"', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!; item.changes![0].wording_only = true;
    const { service, store } = await setup(value);
    render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'What changed' })).toBeNull();
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('1 event')).toBeTruthy();
    // With no box the list is the content: open without a click.
    expect(await within(history).findByText(/not counted as a change/)).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: /History/ }));
    expect(within(history).queryByText(/not counted as a change/)).toBeNull();
  });
  it('shows nothing for an item with no recorded change', async () => {
    const value = changesFixture(), item = value.session.items['updated-0']!; item.changes = [];
    const { service, store } = await setup(value);
    const view = render(<ItemChanges service={service} store={store} session={value.session} item={item} seen={value.seen} onOpenAnswer={vi.fn()} />);
    expect(view.container.textContent).toBe('');
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
