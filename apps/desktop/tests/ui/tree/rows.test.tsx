import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionPreferences } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { initialExpansion, normalizeSearch, sentenceRows } from '../../../src/selectors/tree/rows';
import { chipsOf, toggleChip, topicCounts, treeModel } from '../../../src/ui/tree/model';
import { closedSessionQuestion, waitingOnOwner } from '../../../src/selectors/sessionClosed';
import { displayStatus } from '../../../src/selectors/waiting/replied';

function seed() { return structuredClone(demo) as Session; }
function view(session: Session): SessionPreferences {
  return { session: { project_id: session.project_id, session_id: session.id }, tab_open: true, selected_item_id: null,
    tab_order: 0, expanded_item_ids: [], filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false },
    scroll: null };
}

describe('saved status filter chips', () => {
  it.each(['closed', 'archived'] as const)('excludes %s waiting questions from matching rows and zero counts', state => {
    const session = seed(), preferences = view(session);
    session.state = 'closed';
    if (state === 'archived') session.archived_at = session.updated_at;
    const frozen = immutable(session);
    const project = () => treeModel({ session: frozen, view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) });
    expect(project().rows.some(row => row.kind === 'item' && row.item.id === '2')).toBe(true);
    expect(project().counts.waiting).toBe(0);
    preferences.filters.statuses = ['waiting_on_me'];
    expect(project().rows).toEqual([]);
    expect(project().searchCount).toBe(0);
    expect(project().counts.waiting).toBe(0);
    expect(sentenceRows(frozen, preferences, new Set()).matchingTotal).toBe(0);
    expect(sentenceRows(frozen, preferences, new Set()).rows).toEqual([]);
  });
  it.each(['closed', 'archived'] as const)('preserves a Sent standing answer in a %s session', state => {
    const session = seed(), item = session.items['2']!;
    const answer = structuredClone(session.answers[session.answers.length - 1]!);
    answer.id = crypto.randomUUID(); answer.item_id = item.id; answer.question_revision = item.question_revision;
    const input = Object.values(session.inputs).find(value => value?.target.item_id === item.id)!;
    input.state = 'handled'; answer.input_id = input.id;
    session.answers.push(answer);
    session.state = 'closed';
    if (state === 'archived') session.archived_at = session.updated_at;
    const frozen = immutable(session), preferences = view(session);
    expect(displayStatus(frozen, item)).toBe('sent');
    expect(closedSessionQuestion(frozen, item)).toBe(false);
    expect(waitingOnOwner(frozen, item)).toBe(false);
    preferences.filters.statuses = ['in_progress'];
    const model = treeModel({ session: frozen, view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) });
    expect(model.rows.find(row => row.kind === 'item' && row.item.id === item.id)).toMatchObject({ status: 'sent', sessionClosed: false });
    expect(model.counts.waiting).toBe(0);
    expect(sentenceRows(frozen, preferences, new Set()).rows.some(row => row.item.id === item.id)).toBe(true);
  });
  it('places Ack counts after both waiting counts and before other statuses', () => {
    const statuses = ['open', 'sent', 'queued', 'done', 'waiting_on_me', 'in_progress'] as const;
    expect(topicCounts(statuses, 1).map(count => count.text)).toEqual([
      '1 waiting on you', '1 sent', '1 queued', '1 to ack', '1 open', '1 in progress', '1 closed',
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

describe('saved topic and explicit filter folds', () => {
  it('ignores the retired topic filter while allowing a deliberate reveal', () => {
    const session = immutable(seed()), preferences = view(seed());
    const normal = sentenceRows(session, preferences, new Set());
    preferences.filters.topic_id = 'no-longer-visible-in-the-menu';
    expect(sentenceRows(session, preferences, new Set())).toEqual(normal);
    preferences.filters.search = 'no matches';
    expect(sentenceRows(session, preferences, new Set(), [], '1.1').rows.map(row => row.item.id)).toEqual(['1', '1.1']);
  });
  it('opens matching ancestors until explicitly folded and lets a deliberate reveal reopen them', () => {
    const session = seed(), preferences = view(session);
    session.items['1.1']!.question = 'Unique matching descendant';
    preferences.filters.search = 'unique matching descendant';
    const frozen = immutable(session);
    expect(sentenceRows(frozen, preferences, new Set()).rows.map(row => row.item.id)).toEqual(['1', '1.1']);
    expect(sentenceRows(frozen, preferences, new Set(), [], null, new Set(['1'])).rows.map(row => row.item.id)).toEqual(['1']);
    expect(sentenceRows(frozen, preferences, new Set(), [], '1.1', new Set(['1'])).rows.map(row => row.item.id)).toEqual(['1', '1.1']);
    expect(preferences.expanded_item_ids).toEqual([]);
  });
});

describe('canonical sentence tree projection', () => {
  it('counts every link direction once per connected item in the tree badge', () => {
    const session = seed(), preferences = view(session);
    for (const item of Object.values(session.items)) if (item) {
      delete item.related; delete item.affects; delete item.depends_on;
    }
    session.items['1']!.related = ['2'];
    session.items['1']!.affects = ['3'];
    session.items['1']!.depends_on = ['4'];
    session.items['5']!.affects = ['1'];
    session.items['6']!.depends_on = ['1'];
    session.items['2']!.affects = ['1'];
    const rows = treeModel({ session: immutable(session), view: preferences, search: '', later: new Set(),
      collapsedTopics: new Set(), selectedId: null, revealId: null, temporaryExpanded: [], presence: null,
      summaries: [], now: Date.parse('2026-10-07T12:00:00Z') }).rows;
    expect(rows.find(row => row.kind === 'item' && row.item.id === '1')).toMatchObject({ relatedCount: 5 });
    expect(rows.find(row => row.kind === 'item' && row.item.id === '2')).toMatchObject({ relatedCount: 1 });
  });
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


describe('continuous Map rails', () => {
  const model = (session: Session, selectedId: string | null = null, collapsed = false) => {
    const preferences = view(session);
    preferences.expanded_item_ids = collapsed ? [] : ['1', '1.1'];
    return treeModel({ session: immutable(session), view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
  };
  it('joins the parent bullet to the last direct child, across intervening descendants', () => {
    const session = seed();
    session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2 };
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1', ordinal: 1 };
    const rows = model(session), get = (key: string) => rows.find(row => row.key === key)!;
    expect(get('1').guides).toContainEqual({ kind: 'line', x: 44, width: 24, on: false, fromBullet: true, toBullet: false });
    expect(get('1.1').guides).toContainEqual({ kind: 'line', x: 44, width: 24, on: false, fromBullet: false, toBullet: false });
    expect(get('1.1.1').guides).toContainEqual({ kind: 'line', x: 44, width: 24, on: false, fromBullet: false, toBullet: false });
    expect(get('1.2').guides).toContainEqual({ kind: 'line', x: 44, width: 24, on: false, fromBullet: false, toBullet: true });
    expect(get('1.2').guides).toContainEqual({ kind: 'elbow', x: 44, width: 24, on: false });
    expect(get('2').guides.some(guide => guide.x === 44)).toBe(false);
    const topic = get(session.items['1']!.topic_id);
    expect(topic.guides.some(guide => guide.fromBullet && guide.x === 20)).toBe(true);
  });
  it('accents only the path to the selection, with decorative hues on roots only', () => {
    const session = seed(), rows = model(session, '1.1');
    const root = rows.find(row => row.key === '1')!, child = rows.find(row => row.key === '1.1')!;
    expect(root.guides.some(guide => guide.on && guide.fromBullet && guide.x === 44)).toBe(true);
    expect(child.guides.some(guide => guide.on && guide.toBullet && guide.x === 44)).toBe(true);
    expect(rows.find(row => row.key === '2')!.guides.some(guide => guide.on)).toBe(false);
    for (const row of rows) if (row.kind === 'item') expect(row.hue !== undefined).toBe(row.depth === 1);
    expect(model(session, '2').find(row => row.key === '1')).toMatchObject({ hue: root.kind === 'item' ? root.hue : undefined });
  });
  it('removes child stems when folded and retains continuous rails through hidden groups and filters', () => {
    const session = seed();
    expect(model(session, null, true).find(row => row.key === '1')!.guides.some(guide => guide.x === 44)).toBe(false);
    const preferences = view(session); preferences.expanded_item_ids = ['1']; preferences.hidden_item_ids = ['1.1'];
    const rows = treeModel({ session: immutable(session), view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
    const hidden = rows.find(row => row.kind === 'hidden')!;
    expect(hidden.guides).toContainEqual({ kind: 'line', x: 44, width: 24, on: false, fromBullet: false, toBullet: true });
    preferences.filters.search = session.items['1.1']!.question;
    const filtered = treeModel({ session: immutable(session), view: preferences, search: preferences.filters.search, later: new Set(), collapsedTopics: new Set(),
      selectedId: '1.1', revealId: '1.1', temporaryExpanded: ['1'], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
    expect(filtered.find(row => row.key === '1')!.guides.some(guide => guide.fromBullet && guide.x === 44)).toBe(true);
  });
  it('builds all rails for 2,000 items without DOM measurements', () => {
    const session = seed(), base = session.items['1']!; session.items = {};
    for (let n = 1; n <= 2000; n++) session.items[String(n)] = { ...base, id: String(n), ordinal: n, parent: null };
    expect(model(session, '2000').filter(row => row.kind === 'item')).toHaveLength(2000);
  });
});
