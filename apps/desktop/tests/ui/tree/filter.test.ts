import { beforeEach, describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionPreferences } from '../../../src/generated/core';
import type { ItemStatus, Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { isBlocked } from '../../../src/selectors/tree/blocked';
import {
  CHIP_ORDER, chipCounts, filterOf, filterSignature, loadLocalChips, pickedChips, saveLocalChips, toggleLocalChip, toggleSavedChip,
  type Chip, type FilterScope, type LocalChip,
} from '../../../src/selectors/tree/filter';
import { displayStatus } from '../../../src/selectors/waiting/replied';

const seed = () => structuredClone(demo) as Session;
function prefs(session: Session, filters: Partial<SessionPreferences['filters']> = {}, hidden: string[] = []): SessionPreferences {
  return { session: { project_id: session.project_id, session_id: session.id }, tab_open: true, selected_item_id: null,
    tab_order: 0, expanded_item_ids: [], hidden_item_ids: hidden, scroll: null,
    filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false, ...filters } };
}
function scope(session: Session, filters: Partial<SessionPreferences['filters']> = {}, local: LocalChip[] = [], later: string[] = [], hidden: string[] = []): FilterScope {
  return { session: immutable(session), view: immutable(prefs(session, filters, hidden)), later: new Set(later), local };
}
/** The demo's item 2 waits on the owner. A standing answer makes it Sent; a queued input makes it Queued. */
function answered(session: Session, state: 'handled' | 'queued'): void {
  const item = session.items['2']!, input = Object.values(session.inputs).find(value => value?.target.item_id === item.id)!;
  const answer = structuredClone(session.answers[session.answers.length - 1]!);
  answer.id = crypto.randomUUID(); answer.item_id = item.id; answer.question_revision = item.question_revision;
  input.state = state; answer.input_id = input.id;
  if (state === 'queued') input.payload.target_snapshot.question_revision = item.question_revision;
  session.answers.push(answer);
}
const matching = (session: Session, filters: Partial<SessionPreferences['filters']>, local: LocalChip[] = [], later: string[] = []) => {
  const value = scope(session, filters, local, later), filter = filterOf(value);
  return Object.values(value.session.items).filter(item => !!item && filter.matches(item)).map(item => item!.id).sort();
};

describe('chip predicates (D14)', () => {
  it('has the board order', () => {
    expect(CHIP_ORDER).toEqual(['waiting', 'toack', 'open', 'progress', 'sent', 'blocked', 'decided', 'done', 'later', 'replaced']);
  });
  it.each<[string, Partial<SessionPreferences['filters']>, string[]]>([
    ['Waiting on me', { statuses: ['waiting_on_me'] }, ['2']],
    ['Open (parked included)', { statuses: ['open'] }, ['1.1', '4', '8']],
    ['In progress', { statuses: ['in_progress'] }, ['3']],
    ['Decided', { statuses: ['decided'] }, ['5']],
    ['Done', { statuses: ['done'] }, ['1']],
    ['Replaced', { statuses: ['replaced'] }, ['7']],
    ['a legacy saved Dropped', { statuses: ['dropped'] }, ['6']],
  ])('saved chip %s', (_name, filters, ids) => {
    expect(matching(seed(), filters)).toEqual(ids);
  });
  it('Open keeps a parked item', () => {
    expect(matching(seed(), { statuses: ['open'] }, [], ['4'])).toContain('4');
  });
  it('Later matches any status in the later set', () => {
    expect(matching(seed(), {}, ['later'], ['4', '5'])).toEqual(['4', '5']);
  });
  it('To ack matches an item with an ack target only', () => {
    const session = seed();
    session.items['3']!.ack_to = 'in_progress';
    session.items['4']!.ack_to = 'open';
    session.items['2']!.ack_to = 'open';
    expect(matching(session, {}, ['toack'])).toEqual(['3', '4']);
  });
  it('Sent is the display status, not the saved one; In progress leaves it out', () => {
    const session = seed();
    answered(session, 'handled');
    expect(displayStatus(immutable(session), immutable(session).items['2']!)).toBe('sent');
    expect(matching(session, {}, ['sent'])).toEqual(['2']);
    expect(matching(session, { statuses: ['in_progress'] })).toEqual(['3']);
    expect(matching(session, { statuses: ['waiting_on_me'] })).toEqual([]);
  });
  it('In progress includes a Queued reply', () => {
    const session = seed();
    answered(session, 'queued');
    const status = displayStatus(immutable(session), immutable(session).items['2']!);
    expect(status).toBe('queued');
    expect(matching(session, { statuses: ['in_progress'] })).toEqual(['2', '3']);
    expect(matching(session, {}, ['sent'])).toEqual([]);
  });
  it('Blocked uses isBlocked', () => {
    const session = seed();
    session.items['4']!.depends_on = ['3'];
    expect(matching(session, {}, ['blocked'])).toEqual(['4']);
  });
  it('picked chips combine with OR, saved and local together', () => {
    const session = seed();
    session.items['4']!.depends_on = ['3'];
    expect(matching(session, { statuses: ['done'] }, ['blocked'])).toEqual(['1', '4']);
    expect(matching(session, { statuses: ['done', 'decided'] })).toEqual(['1', '5']);
  });
  it('nothing picked matches everything; a complete saved set is no filter', () => {
    const session = seed(), all = Object.keys(session.items).sort();
    expect(matching(session, {})).toEqual(all);
    expect(matching(session, { statuses: ['waiting_on_me', 'open', 'in_progress', 'decided', 'done', 'dropped', 'replaced'] })).toEqual(all);
    expect(filterOf(scope(session)).active).toBe(false);
  });
  it('a waiting question of a closed session is not Waiting on me', () => {
    const session = seed();
    session.state = 'closed';
    expect(matching(session, { statuses: ['waiting_on_me'] })).toEqual([]);
  });
  it('the owners and hide-later scope narrow every chip', () => {
    const session = seed();
    expect(matching(session, { owners: [{ kind: 'me' }] }, ['blocked', 'later'], ['4', '3'])).toEqual(['4']);
    expect(matching(session, { hide_later: true }, ['later'], ['4'])).toEqual([]);
    expect(filterOf(scope(session, { hide_later: true })).active).toBe(true);
    expect(filterOf(scope(session, { owners: [{ kind: 'me' }] })).active).toBe(true);
  });
  it('is active exactly when something is picked', () => {
    const session = seed();
    expect(filterOf(scope(session, { statuses: ['open'] })).active).toBe(true);
    expect(filterOf(scope(session, {}, ['later'])).active).toBe(true);
    expect(filterOf(scope(session, { statuses: ['dropped'] })).active).toBe(true);
  });
});

describe('chip counts', () => {
  it('count inside the scope and agree with the filter', () => {
    const session = seed();
    session.items['4']!.depends_on = ['3'];
    session.items['3']!.ack_to = 'in_progress';
    const value = scope(session, {}, [], ['8']), counts = chipCounts(value);
    expect(counts).toEqual({ waiting: 1, toack: 1, open: 3, progress: 1, sent: 0, blocked: 1, decided: 1, done: 1, later: 1, replaced: 1 });
    for (const chip of CHIP_ORDER) {
      const one = scope(session, {}, [], ['8'], []);
      const saved: Partial<Record<Chip, ItemStatus>> = { waiting: 'waiting_on_me', open: 'open', progress: 'in_progress', decided: 'decided', done: 'done', replaced: 'replaced' };
      const filter = filterOf(saved[chip] ? scope(session, { statuses: [saved[chip]!] }, [], ['8']) : { ...one, local: [chip as LocalChip] });
      expect(Object.values(one.session.items).filter(item => !!item && filter.matches(item)).length).toBe(counts[chip]);
    }
  });
  it('leave hidden items out except in Waiting on me', () => {
    const session = seed();
    expect(chipCounts(scope(session, {}, [], [], ['2', '4'])).open).toBe(2);
    expect(chipCounts(scope(session, {}, [], [], ['2', '4'])).waiting).toBe(1);
  });
  it('follow the saved owners, archived topics and removed items', () => {
    const session = seed();
    expect(chipCounts(scope(session, { owners: [{ kind: 'me' }] })).open).toBe(3);
    expect(chipCounts(scope(session, { archived: true })).open).toBe(0);
    session.items['8']!.removed_at = session.updated_at;
    expect(chipCounts(scope(session)).open).toBe(2);
  });
  it('count a Blocked item that has since been settled as zero', () => {
    const session = seed();
    session.items['4']!.depends_on = ['3'];
    expect(chipCounts(scope(session)).blocked).toBe(1);
    session.items['3']!.status = 'done';
    expect(chipCounts(scope(session)).blocked).toBe(0);
  });
});

describe('Blocked (D16)', () => {
  const blocked = (session: Session, id: string) => isBlocked(immutable(session), immutable(session).items[id]!);
  it('is false without dependencies', () => expect(blocked(seed(), '4')).toBe(false));
  it.each<ItemStatus>(['open', 'waiting_on_me', 'in_progress'])('is true while a dependency is %s', status => {
    const session = seed();
    session.items['5']!.depends_on = ['8']; session.items['5']!.status = 'open';
    session.items['8']!.status = status;
    expect(blocked(session, '5')).toBe(true);
  });
  it.each<ItemStatus>(['decided', 'done', 'dropped', 'replaced'])('is false once the dependency is %s', status => {
    const session = seed();
    session.items['4']!.depends_on = ['8'];
    session.items['8']!.status = status;
    expect(blocked(session, '4')).toBe(false);
  });
  it('counts a missing dependency as settled', () => {
    const session = seed();
    session.items['4']!.depends_on = ['nope'];
    expect(blocked(session, '4')).toBe(false);
  });
  it('counts a removed dependency as settled, also through a removed parent', () => {
    const session = seed();
    session.items['4']!.depends_on = ['1.1'];
    expect(blocked(session, '4')).toBe(true);
    session.items['1']!.removed_at = session.updated_at;
    expect(blocked(session, '4')).toBe(false);
  });
  it('reads a chain one hop at a time', () => {
    const session = seed();
    session.items['4']!.depends_on = ['8'];
    session.items['8']!.depends_on = ['3'];
    expect(blocked(session, '4')).toBe(true);
    expect(blocked(session, '8')).toBe(true);
    session.items['8']!.status = 'done';
    expect(blocked(session, '4')).toBe(false);
    expect(blocked(session, '8')).toBe(false);
  });
  it('is false for an item that is not live', () => {
    const session = seed();
    session.items['5']!.depends_on = ['8'];
    expect(session.items['5']!.status).toBe('decided');
    expect(blocked(session, '5')).toBe(false);
  });
  it('is true with one unsettled among several dependencies', () => {
    const session = seed();
    session.items['4']!.depends_on = ['1', '5', '8'];
    expect(blocked(session, '4')).toBe(true);
  });
});

describe('saved and local toggles', () => {
  it('picks and drops a saved chip, and saves no filter once the last one is dropped', () => {
    expect(toggleSavedChip([], 'open')).toEqual(['open']);
    expect(toggleSavedChip(['open'], 'waiting')).toEqual(['waiting_on_me', 'open']);
    expect(toggleSavedChip(['waiting_on_me', 'open'], 'open')).toEqual(['waiting_on_me']);
    expect(toggleSavedChip(['open'], 'open')).toEqual([]);
  });
  it('keeps a legacy dropped until Clear and ignores a local chip', () => {
    expect(toggleSavedChip(['dropped'], 'open')).toEqual(['open', 'dropped']);
    expect(toggleSavedChip(['open'], 'blocked')).toEqual(['open']);
  });
  it('treats a complete saved set as no filter when toggling', () => {
    expect(toggleSavedChip(['waiting_on_me', 'open', 'in_progress', 'decided', 'done', 'dropped', 'replaced'], 'open')).toEqual(['open']);
  });
  it('toggles local chips in a stable order', () => {
    expect(toggleLocalChip(['sent'], 'toack')).toEqual(['toack', 'sent']);
    expect(toggleLocalChip(['toack', 'sent'], 'toack')).toEqual(['sent']);
  });
  it('lists the picked chips in board order', () => {
    expect(pickedChips(scope(seed(), { statuses: ['replaced', 'waiting_on_me'] }, ['later', 'toack']))).toEqual(['waiting', 'toack', 'later', 'replaced']);
  });
});

describe('filterSignature (D17)', () => {
  const sign = (filters: Partial<SessionPreferences['filters']>, local: LocalChip[] = []) => filterSignature(scope(seed(), filters, local));
  it('changes with saved chips, owners, hide-later, archived and the local chips', () => {
    const base = sign({});
    for (const other of [sign({ statuses: ['open'] }), sign({ owners: [{ kind: 'me' }] }), sign({ hide_later: true }), sign({ archived: true }), sign({}, ['blocked'])])
      expect(other).not.toBe(base);
  });
  it('ignores the search, the retired topic filter, the order of picks and a complete saved set', () => {
    expect(sign({ search: 'x', topic_id: crypto.randomUUID() })).toBe(sign({}));
    expect(sign({ statuses: ['open', 'done'] })).toBe(sign({ statuses: ['done', 'open'] }));
    expect(sign({}, ['sent', 'toack'])).toBe(sign({}, ['toack', 'sent']));
    expect(sign({ statuses: ['waiting_on_me', 'open', 'in_progress', 'decided', 'done', 'dropped', 'replaced'] })).toBe(sign({}));
  });
});

describe('local chips storage (D15)', () => {
  beforeEach(() => localStorage.clear());
  it('round-trips per session', () => {
    saveLocalChips('a', ['sent', 'blocked']);
    saveLocalChips('b', ['later']);
    expect(loadLocalChips('a')).toEqual(['sent', 'blocked']);
    expect(loadLocalChips('b')).toEqual(['later']);
    expect(loadLocalChips('c')).toEqual([]);
  });
  it('drops an emptied session from storage', () => {
    saveLocalChips('a', ['sent']);
    saveLocalChips('a', []);
    expect(JSON.parse(localStorage.getItem('ariadne.map.filter.v1')!)).toEqual({});
  });
  it.each(['not json', '[]', 'null', '7', '{"a":"sent"}', '{"a":[1,"nope"]}'])('falls back to nothing for %s', raw => {
    localStorage.setItem('ariadne.map.filter.v1', raw);
    expect(loadLocalChips('a')).toEqual([]);
  });
  it('keeps the valid chips of a partly valid entry, once each, and never reads an inherited key', () => {
    localStorage.setItem('ariadne.map.filter.v1', '{"a":["sent","nope","sent","later"],"__proto__":["sent"]}');
    expect(loadLocalChips('a')).toEqual(['sent', 'later']);
    expect(loadLocalChips('toString')).toEqual([]);
  });
  it('keeps the 50 most recently changed sessions', () => {
    for (let index = 0; index < 52; index++) saveLocalChips(`s${index}`, ['sent']);
    saveLocalChips('s10', ['later']);
    const stored = JSON.parse(localStorage.getItem('ariadne.map.filter.v1')!) as Record<string, string[]>;
    expect(Object.keys(stored)).toHaveLength(50);
    expect(stored.s0).toBeUndefined();
    expect(stored.s1).toBeUndefined();
    expect(stored.s10).toEqual(['later']);
    expect(stored.s51).toEqual(['sent']);
  });
  it('survives a storage that refuses the write', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('quota'); };
    try { expect(() => saveLocalChips('a', ['sent'])).not.toThrow(); } finally { Storage.prototype.setItem = original; }
  });
});
