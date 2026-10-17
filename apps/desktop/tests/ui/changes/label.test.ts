import { describe, expect, it } from 'vitest';
import type { Item, ItemChangeRecord } from '../../../src/generated/domain/models';
import { changeLabel } from '../../../src/selectors/changes/label';
import { changedLately } from '../../../src/selectors/changes/lately';
import { changesFixture } from './fixture';

const record = (revision: number, before: ItemChangeRecord['before'], patch: Partial<ItemChangeRecord> = {}): ItemChangeRecord =>
  ({ revision, at: `2026-10-10T0${revision}:00:00Z`, cause_message_id: 'cause', before, ...patch });
const item = (patch: Partial<Item>) => ({ ...changesFixture().session.items['updated-0']!, ...patch }) as Item;

describe('changeLabel', () => {
  it('calls an item with no record New', () => expect(changeLabel(item({}), null, [])).toBe('New'));
  it('reads a status change as Before → After from the current item when nothing came later', () => {
    expect(changeLabel(item({ status: 'decided' }), record(2, { status: 'open' }), [])).toBe('Open → Decided');
  });
  it('reads waiting_on_me and in_progress by their names', () => {
    expect(changeLabel(item({ status: 'in_progress' }), record(2, { status: 'waiting_on_me' }), [])).toBe('Waiting on me → In progress');
  });
  it('names option changes and progress, and calls anything else Changed', () => {
    expect(changeLabel(item({ status: 'open' }), record(2, { options: [] }), [])).toBe('Options changed');
    expect(changeLabel(item({ status: 'in_progress' }), record(2, { note: 'old' }), [])).toBe('Progress');
    expect(changeLabel(item({ status: 'open' }), record(2, { note: 'old' }), [])).toBe('Changed');
    expect(changeLabel(item({ status: 'open' }), record(2, { why: 'old' }), [])).toBe('Changed');
  });
  it('takes each "after" from the first later record that has the field: status → note → status', () => {
    const first = record(2, { status: 'open' }), note = record(3, { note: 'n' }), second = record(4, { status: 'in_progress' });
    const current = item({ status: 'decided' });
    // The first status change ended in progress (the later record's "before"), not at the current Decided.
    expect(changeLabel(current, first, [note, second])).toBe('Open → In progress');
    // The note was edited while the item was in progress.
    expect(changeLabel(current, note, [second])).toBe('Progress');
    expect(changeLabel(current, second, [])).toBe('In progress → Decided');
  });
  it('ignores records that are not later than the one named', () => {
    const early = record(1, { status: 'waiting_on_me' }), main = record(2, { status: 'open' });
    expect(changeLabel(item({ status: 'decided' }), main, [early])).toBe('Open → Decided');
  });
});

describe('changedLately', () => {
  it('lists the six items whose latest real change is newest, skips rewordings, and ranks never-changed items by creation', () => {
    const value = changesFixture(0, 0, 0);
    const add = (id: string, patch: Partial<Item>) => value.add(id, id, patch);
    add('a', { changes: [record(2, { status: 'open' }, { at: '2026-10-10T05:00:00Z' })], status: 'decided' });
    add('b', { changes: [record(2, { note: 'x' }, { at: '2026-10-10T04:00:00Z' }), record(3, { question: 'old' }, { at: '2026-10-10T09:00:00Z', wording_only: true })] });
    add('c', { changes: [], created_at: '2026-10-10T06:00:00Z' });
    add('d', { changes: [record(2, { why: 'x' }, { at: '2026-10-10T03:00:00Z' })] });
    add('e', { changes: [record(2, { why: 'x' }, { at: '2026-10-10T02:00:00Z' })] });
    add('f', { changes: [record(2, { why: 'x' }, { at: '2026-10-10T01:30:00Z' })] });
    add('g', { changes: [record(2, { why: 'x' }, { at: '2026-10-10T01:10:00Z' })] });
    const lately = changedLately(value.session);
    expect(lately.map(entry => entry.item.id)).toEqual(['c', 'a', 'b', 'd', 'e', 'f']);
    expect(lately[0]!.record).toBeNull();
    expect(lately[1]!.record!.revision).toBe(2);
    expect(lately[2]!.record!.wording_only).toBeFalsy();
    expect(lately[2]!.later.map(entry => entry.revision)).toEqual([3]);
  });
});
