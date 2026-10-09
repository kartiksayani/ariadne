import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionPreferences } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { initialExpansion, normalizeSearch, sentenceRows } from '../../../src/selectors/tree/rows';
import { chipsOf, toggleChip, topicCounts } from '../../../src/ui/tree/model';

function seed() { return structuredClone(demo) as Session; }
function view(session: Session): SessionPreferences {
  return { session: { project_id: session.project_id, session_id: session.id }, tab_open: true, selected_item_id: null,
    tab_order: 0, expanded_item_ids: [], filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false },
    rail: 'waiting', scroll: null };
}

describe('saved status filter chips', () => {
  it('places Ack counts after both waiting counts and before other statuses', () => {
    const statuses = ['open', 'waiting_on_agent', 'done', 'waiting_on_me', 'in_progress'] as const;
    expect(topicCounts(statuses, 1).map(count => count.text)).toEqual([
      '1 waiting on you', '1 waiting on agent', '1 to ack', '1 open', '1 in progress', '1 closed',
    ]);
    expect(topicCounts(statuses).map(count => count.text)).not.toContain('0 to ack');
  });
  it('treats every known saved status as All before toggling, while preserving partial groups', () => {
    const full = ['open', 'waiting_on_me', 'in_progress', 'decided', 'done', 'dropped', 'replaced', 'open'] as const;
    expect([...chipsOf(full)]).toEqual(['all']);
    expect(toggleChip(full, 'open')).toEqual(['open']);
    expect([...chipsOf(['done'])]).toEqual(['closed']);
    expect(toggleChip(['done'], 'open')).toEqual(['open', 'done']);
  });
});

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
  it('keeps token matching correct as queries change on the same immutable snapshot', () => {
    const session = seed(), preferences = view(session);
    session.items['1']!.question = 'ＯＦＦＩＣＥ café'; session.items['1']!.outcome = 'Confirmed network';
    session.items['2']!.question = 'Separate orchard';
    session.messages.find(message => message.kind === 'reply' && message.item_id === '1')!.body = 'Canonical receipt';
    const activity = session.messages.find(message => message.kind === 'activity')!;
    activity.body = 'Excluded diagnostic'; activity.items_touched = ['1'];
    const frozen = immutable(session);
    for (const [search, expected] of [
      ['office CAFE\u0301 network', ['1']], ['separate orchard', ['2']],
      ['canonical receipt', ['1']], ['office orchard', []], ['excluded diagnostic', []], ['ＯＦＦＩＣＥ', ['1']],
    ] as const) {
      preferences.filters.search = search;
      expect(sentenceRows(frozen, preferences, new Set()).rows.filter(row => !row.context).map(row => row.item.id)).toEqual(expected);
    }
    preferences.filters.search = '  \t ';
    expect(sentenceRows(frozen, preferences, new Set()).matchingTotal).toBe(sentenceRows(frozen, view(session), new Set()).matchingTotal);
  });
  it.each(['question', 'outcome', 'why', 'topic', 'owner_input', 'reply'] as const)('refreshes searchable %s text when an immutable session snapshot is replaced', field => {
    const session = seed(), preferences = view(session);
    const changeText = (text: string): void => {
      if (field === 'topic') session.topics[session.items['1']!.topic_id]!.name = text;
      else if (field === 'owner_input' || field === 'reply') {
        session.messages.find(message => message.kind === field && message.item_id === '1')!.body = text;
      } else session.items['1']![field] = text;
    };
    changeText('BeforeToken');
    const before = immutable(session);
    preferences.filters.search = 'beforetoken';
    expect(sentenceRows(before, preferences, new Set()).rows.some(row => row.item.id === '1' && !row.context)).toBe(true);
    changeText('AfterToken'); session.revision++;
    const after = immutable(session);
    expect(sentenceRows(after, preferences, new Set()).matchingTotal).toBe(0);
    preferences.filters.search = 'aftertoken';
    expect(sentenceRows(after, preferences, new Set()).rows.some(row => row.item.id === '1' && !row.context)).toBe(true);
    expect(sentenceRows(before, preferences, new Set()).matchingTotal).toBe(0);
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
  it('counts the union of selected statuses and narrows that union with search', () => {
    const session = seed(), preferences = view(session);
    preferences.filters.statuses = ['open', 'in_progress'];
    const frozen = immutable(session), selected = sentenceRows(frozen, preferences, new Set());
    expect(selected.rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1.1', '3', '4', '8']);
    expect(selected.matchingTotal).toBe(4);
    expect(selected.scopeTotal).toBe(9);
    preferences.filters.search = 'receipt';
    const searched = sentenceRows(frozen, preferences, new Set());
    expect(searched.rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1.1', '3']);
    expect(searched.matchingTotal).toBe(2);
    preferences.filters.statuses = [];
    preferences.filters.search = '';
    expect(sentenceRows(frozen, preferences, new Set()).matchingTotal).toBe(9);
  });
  it('matches canonical owners exactly with OR within owners and AND across categories', () => {
    const session = seed(), preferences = view(session);
    for (const item of Object.values(session.items)) if (item) item.owner = { kind: 'me' };
    session.items['1']!.owner = { kind: 'other', name: '  Exact person  ' };
    session.items['2']!.owner = { kind: 'agent', binding_id: session.active_binding_id! };
    session.items['3']!.owner = { kind: 'me' };
    const frozen = immutable(session);
    preferences.filters.owners = [{ kind: 'other', name: 'Exact person' }];
    expect(sentenceRows(frozen, preferences, new Set()).matchingTotal).toBe(0);
    preferences.filters.owners = [session.items['1']!.owner, session.items['2']!.owner];
    const result = sentenceRows(frozen, preferences, new Set());
    expect(result.rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1', '2']);
    preferences.filters.statuses = ['waiting_on_me'];
    expect(sentenceRows(frozen, preferences, new Set()).rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['2']);
    preferences.filters.owners = [{ kind: 'agent', binding_id: session.id }];
    expect(sentenceRows(frozen, preferences, new Set()).matchingTotal).toBe(0);
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
