import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionPreferences } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { initialExpansion, normalizeSearch, sentenceRows } from '../../../src/selectors/tree/rows';

function seed() { return structuredClone(demo) as Session; }
function view(session: Session): SessionPreferences {
  return { session: { project_id: session.project_id, session_id: session.id }, tab_open: true, selected_item_id: null,
    tab_order: 0, expanded_item_ids: [], filters: { search: '', statuses: [], topic_id: null, archived: false, hide_later: false },
    rail: 'waiting', scroll: null };
}

describe('canonical sentence tree projection', () => {
  it('orders numeric siblings and topics without changing domain IDs or stored text', () => {
    const session = seed(), preferences = view(session);
    session.items['10'] = { ...session.items['1']!, id: '10', ordinal: 10 };
    session.items['3'] = { ...session.items['1']!, id: '3', ordinal: 3 };
    const before = JSON.stringify(session), rows = sentenceRows(immutable(session), preferences, new Set()).rows;
    expect(rows.filter(row => row.item.topic_id === session.items['1']!.topic_id && row.depth === 0).map(row => row.item.id))
      .toEqual(['1', '2', '3', '4', '5', '6', '7', '10']);
    expect(JSON.stringify(session)).toBe(before);
  });
  it('uses NFKC and locale-independent token search across sentences and canonical conversation', () => {
    const session = seed(), preferences = view(session);
    session.items['1']!.question = 'ＯＦＦＩＣＥ café'; session.items['1']!.why = 'Preserve network safety';
    preferences.filters.search = 'office CAFE\u0301 network';
    expect(normalizeSearch(preferences.filters.search)).toBe('office café network');
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.map(row => row.item.id)).toEqual(['1']);
    preferences.filters.search = 'native queue';
    const message = session.messages.find(message => message.kind === 'reply' && message.item_id === '1')!;
    message.body = 'Native queue receipt is the explicit domain explanation.';
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.map(row => row.item.id)).toContain('1');
  });
  it('excludes shared activity and unrelated touched-item backlinks from search', () => {
    const session = seed(), preferences = view(session); preferences.filters.search = 'secret diagnostic';
    const activity = session.messages.find(message => message.kind === 'activity')!;
    activity.body = 'secret diagnostic'; activity.items_touched = ['1'];
    expect(sentenceRows(immutable(session), preferences, new Set()).matchingTotal).toBe(0);
  });
  it('combines categories with AND and statuses with OR, preserving contextual ancestors', () => {
    const session = seed(), preferences = view(session);
    const child = session.items['1.1']!; child.question = 'Find the matching child'; child.status = 'open';
    preferences.filters.search = 'matching child'; preferences.filters.statuses = ['open', 'waiting_on_me'];
    preferences.filters.topic_id = child.topic_id;
    const selected = sentenceRows(immutable(session), preferences, new Set());
    expect(selected.rows.map(row => [row.item.id, row.context, row.expanded])).toEqual([['1', true, true], ['1.1', false, false]]);
    preferences.filters.statuses = ['done'];
    expect(sentenceRows(immutable(session), preferences, new Set()).rows).toHaveLength(0);
  });
  it('temporarily reveals an excluded item without overwriting filters or saved expansion', () => {
    const session = seed(), preferences = view(session); preferences.filters.statuses = ['waiting_on_me'];
    const original = JSON.stringify(preferences);
    const selected = sentenceRows(immutable(session), preferences, new Set(), ['1'], '1.1');
    expect(selected.rows.find(row => row.item.id === '1.1')).toMatchObject({ outsideFilters: true });
    expect(selected.rows.find(row => row.item.id === '1')).toMatchObject({ expanded: true, context: true });
    expect(JSON.stringify(preferences)).toBe(original);
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.some(row => row.item.id === '1.1')).toBe(false);
  });
  it('preserves explicit collapse through live changes, initializes active branches only for a new view', () => {
    const session = seed(), preferences = view(session);
    session.items['1.1']!.status = 'open';
    expect(initialExpansion(immutable(session))).toContain('1');
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.some(row => row.item.id === '1.1')).toBe(false);
    preferences.expanded_item_ids = [...initialExpansion(immutable(session))];
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.some(row => row.item.id === '1.1')).toBe(true);
    session.items['1.1']!.status = 'done'; session.items['1']!.status = 'done';
    expect(initialExpansion(immutable(session))).not.toContain('1');
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.some(row => row.item.id === '1.1')).toBe(true);
  });
  it('keeps Later and Archive filters local while retaining full sentence and outcome', () => {
    const session = seed(), preferences = view(session), frozen = immutable(session), before = JSON.stringify(frozen);
    const eligible = sentenceRows(frozen, preferences, new Set()).rows;
    const first = eligible[0].item;
    preferences.filters.hide_later = true;
    const hidden = sentenceRows(frozen, preferences, new Set([first.id]));
    expect(hidden.rows.find(row => row.item.id === first.id)?.context).toBe(true);
    expect(hidden.matchingTotal).toBeLessThan(eligible.length + 2);
    preferences.filters.hide_later = false; preferences.filters.archived = true;
    expect(sentenceRows(frozen, preferences, new Set()).rows.every(row => session.topics[row.item.topic_id]!.archived_at !== null)).toBe(true);
    expect(eligible[0].item.question).toBe(first.question); expect(eligible[0].item.outcome).toBe(first.outcome);
    expect(JSON.stringify(frozen)).toBe(before);
  });
  it('memoizes the current projection without retaining an unbounded search cache', () => {
    const frozen = immutable(seed()), preferences = view(seed());
    const first = sentenceRows(frozen, preferences, new Set());
    expect(sentenceRows(frozen, structuredClone(preferences), new Set())).toBe(first);
    preferences.filters.search = 'different'; expect(sentenceRows(frozen, preferences, new Set())).not.toBe(first);
  });
  it('rejects a contradictory session preference route before revealing a tree', () => {
    const frozen = immutable(seed()), preferences = view(seed()); preferences.session.session_id = preferences.session.project_id;
    expect(() => sentenceRows(frozen, preferences, new Set())).toThrow('route');
  });
  it('measures complete selection of 2,000 items before considering virtualization', () => {
    const session = seed(), base = session.items['1']!; session.items = {};
    for (let n = 1; n <= 2000; n++) session.items[String(n)] = { ...base, id: String(n), ordinal: n,
      question: `Complete sentence ${n} about immutable domain evidence`, outcome: 'A complete retained outcome.', parent: null };
    const preferences = view(session), frozen = immutable(session), start = performance.now();
    const result = sentenceRows(frozen, preferences, new Set());
    const elapsed = performance.now() - start;
    expect(result.rows).toHaveLength(2000); expect(result.scopeTotal).toBe(2000);
    expect(result.rows.at(-1)?.item.question).toBe('Complete sentence 2000 about immutable domain evidence');
    expect(Number.isFinite(elapsed)).toBe(true);
  });
});
