import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionPreferences } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { initialExpansion, normalizeSearch } from '../../../src/selectors/tree/rows';
import { sentenceRows } from './scope';
import { topicCounts } from '../../../src/ui/tree/model';
import { branchSlot } from '../../../src/ui/tree/branch';
import { chipCounts, savedChips, toggleSavedChip, type LocalChip } from '../../../src/selectors/tree/filter';
import { shimTree } from './shimTree';
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
    const project = () => shimTree({ session: frozen, view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) });
    const waiting = () => chipCounts({ session: frozen, view: preferences, later: new Set(), local: [] }).waiting;
    expect(project().rows.some(row => row.kind === 'item' && row.item.id === '2')).toBe(true);
    expect(waiting()).toBe(0);
    preferences.filters.statuses = ['waiting_on_me'];
    expect(project().rows).toEqual([]);
    expect(project().shownCount).toBe(0);
    expect(waiting()).toBe(0);
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
    const project = (local: readonly LocalChip[] = []) => shimTree({ session: frozen, view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at), local });
    const found = (local?: readonly LocalChip[]) => project(local).rows.find(row => row.kind === 'item' && row.item.id === item.id);
    expect(found()).toMatchObject({ status: 'sent', sessionClosed: false });
    // Sent is its own chip (D14): the Sent chip keeps the item, In progress no longer does.
    expect(found(['sent'])).toMatchObject({ status: 'sent', sessionClosed: false });
    preferences.filters.statuses = ['in_progress'];
    expect(found()).toBeUndefined();
    expect(chipCounts({ session: frozen, view: preferences, later: new Set(), local: [] }).waiting).toBe(0);
    expect(sentenceRows(frozen, preferences, new Set()).rows.some(row => row.item.id === item.id)).toBe(false);
    preferences.filters.statuses = [];
    expect(sentenceRows(frozen, preferences, new Set(), [], null, new Set(), ['sent']).rows.some(row => row.item.id === item.id)).toBe(true);
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
    expect(savedChips(full)).toEqual([]);
    expect(toggleSavedChip(full, 'open')).toEqual(['open']);
    expect(savedChips(['done'])).toEqual(['done']);
    expect(toggleSavedChip(['done'], 'open')).toEqual(['open', 'done']);
  });
});

describe('saved topic and explicit filter folds', () => {
  it('ignores the retired topic filter while allowing a deliberate reveal', () => {
    const session = immutable(seed()), preferences = view(seed());
    const normal = sentenceRows(session, preferences, new Set());
    preferences.filters.topic_id = 'no-longer-visible-in-the-menu';
    expect(sentenceRows(session, preferences, new Set())).toEqual(normal);
    // A search that matches nothing scopes nothing (SPEC §6.9); a deliberate reveal still opens its row.
    preferences.filters.search = 'no matches';
    expect(sentenceRows(session, preferences, new Set()).rows).toEqual(normal.rows);
    const revealed = sentenceRows(session, preferences, new Set(), [], '1.1').rows.map(row => row.item.id);
    expect(revealed.slice(0, 2)).toEqual(['1', '1.1']);
    expect(revealed).toEqual(expect.arrayContaining(normal.rows.map(row => row.item.id)));
  });
  it('opens matching ancestors until explicitly folded and lets a deliberate reveal reopen them', () => {
    const session = seed(), preferences = view(session);
    session.items['1.1']!.question = 'Unique matching descendant';
    const frozen = immutable(session), ids = (rows: { readonly rows: readonly { readonly item: { readonly id: string } }[] }) => rows.rows.map(row => row.item.id);
    // A search never opens a folded branch: 1.1 stays inside its folded parent.
    preferences.filters.search = 'unique matching descendant';
    expect(ids(sentenceRows(frozen, preferences, new Set()))).not.toContain('1.1');
    // A status filter does, until the owner folds the ancestor under it.
    preferences.filters.statuses = ['open'];
    expect(ids(sentenceRows(frozen, preferences, new Set())).slice(0, 2)).toEqual(['1', '1.1']);
    expect(ids(sentenceRows(frozen, preferences, new Set(), [], null, new Set(['1'])))).not.toContain('1.1');
    expect(ids(sentenceRows(frozen, preferences, new Set(), [], '1.1', new Set(['1']))).slice(0, 2)).toEqual(['1', '1.1']);
    expect(preferences.expanded_item_ids).toEqual([]);
  });
});

describe('canonical sentence tree projection', () => {
  // Search in place (SPEC §6.9): a search marks matching questions and outcomes on the rows; it never scopes them.
  const matching = (session: ReturnType<typeof immutable<Session>>, search: string) =>
    shimTree({ session, view: { ...view(seed()), expanded_item_ids: ['1'] }, search, later: new Set(), collapsedTopics: new Set(), selectedId: null,
      revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z') })
      .rows.flatMap(row => row.kind === 'item' && row.matches.length ? [row.item.id] : []);
  // Full-width "OFFICE", a precomposed "café", and "CAFE" with a combining acute accent.
  const office = 'ＯＦＦＩＣＥ', cafe = 'café', decomposed = 'CAFÉ';
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
    const rows = shimTree({ session: immutable(session), view: preferences, search: '', later: new Set(),
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
  it('uses NFKC and locale-independent token search over questions and outcomes, not the conversation', () => {
    const session = seed();
    session.items['1']!.question = `${office} ${cafe}`; session.items['1']!.why = 'Preserve network safety';
    expect(normalizeSearch(`office ${decomposed} network`)).toBe(`office ${cafe} network`);
    expect(matching(immutable(session), `office ${decomposed}`)).toEqual(['1']);
    // The why and the conversation are not searched; every word must be in the question or in the outcome.
    expect(matching(immutable(session), `office ${decomposed} network`)).toEqual([]);
    const message = session.messages.find(message => message.kind === 'reply' && message.item_id === '1')!;
    message.body = 'Native queue receipt is the explicit domain explanation.';
    expect(matching(immutable(session), 'native queue')).toEqual([]);
    session.items['1']!.outcome = 'A native queue holds the receipt.';
    expect(matching(immutable(session), 'native queue')).toEqual(['1']);
  });
  it('excludes shared activity and unrelated touched-item backlinks from search', () => {
    const session = seed();
    const activity = session.messages.find(message => message.kind === 'activity')!;
    activity.body = 'secret diagnostic'; activity.items_touched = ['1'];
    expect(matching(immutable(session), 'secret diagnostic')).toEqual([]);
  });
  it('keeps token matching correct as queries change on the same immutable snapshot, and never scopes the rows', () => {
    const session = seed(), preferences = view(session);
    session.items['1']!.question = `${office} ${cafe}`; session.items['1']!.outcome = 'Confirmed network';
    session.items['2']!.question = 'Separate orchard';
    session.messages.find(message => message.kind === 'reply' && message.item_id === '1')!.body = 'Canonical receipt';
    const activity = session.messages.find(message => message.kind === 'activity')!;
    activity.body = 'Excluded diagnostic'; activity.items_touched = ['1'];
    const frozen = immutable(session), plain = sentenceRows(frozen, preferences, new Set());
    for (const [search, expected] of [
      [`office ${decomposed}`, ['1']], ['confirmed network', ['1']], [`office ${decomposed} network`, []], ['separate orchard', ['2']],
      ['canonical receipt', []], ['office orchard', []], ['excluded diagnostic', []], [office, ['1']], ['  \t ', []],
    ] as const) {
      expect(matching(frozen, search)).toEqual(expected);
      preferences.filters.search = search;
      expect(sentenceRows(frozen, preferences, new Set()).rows).toEqual(plain.rows);
    }
  });
  it.each(['question', 'outcome', 'why', 'topic', 'owner_input', 'reply'] as const)('reads searchable %s text from the snapshot it is given', field => {
    const session = seed();
    const changeText = (text: string): void => {
      if (field === 'topic') session.topics[session.items['1']!.topic_id]!.name = text;
      else if (field === 'owner_input' || field === 'reply') {
        session.messages.find(message => message.kind === field && message.item_id === '1')!.body = text;
      } else session.items['1']![field] = text;
    };
    // Only the question and the outcome are searched (SPEC §6.9).
    const searched = field === 'question' || field === 'outcome' ? ['1'] : [];
    changeText('BeforeToken');
    const before = immutable(session);
    expect(matching(before, 'beforetoken')).toEqual(searched);
    changeText('AfterToken'); session.revision++;
    const after = immutable(session);
    expect(matching(after, 'beforetoken')).toEqual([]);
    expect(matching(after, 'aftertoken')).toEqual(searched);
    expect(matching(before, 'aftertoken')).toEqual([]);
  });
  it('combines categories with AND and statuses with OR, preserving contextual ancestors', () => {
    const session = seed(), preferences = view(session);
    const child = session.items['1.1']!; child.question = 'Find the matching child'; child.status = 'open';
    preferences.filters.statuses = ['open', 'waiting_on_me'];
    preferences.filters.topic_id = child.topic_id;
    const selected = sentenceRows(immutable(session), preferences, new Set());
    expect(selected.rows.slice(0, 2).map(row => [row.item.id, row.context, row.expanded])).toEqual([['1', true, true], ['1.1', false, false]]);
    expect(selected.rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1.1', '2', '4', '8']);
    // A search on top narrows nothing.
    preferences.filters.search = 'matching child';
    expect(sentenceRows(immutable(session), preferences, new Set()).rows).toEqual(selected.rows);
    preferences.filters.statuses = ['done'];
    expect(sentenceRows(immutable(session), preferences, new Set()).rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1']);
  });
  it('counts the union of selected statuses, which a search never narrows', () => {
    const session = seed(), preferences = view(session);
    preferences.filters.statuses = ['open', 'in_progress'];
    const frozen = immutable(session), selected = sentenceRows(frozen, preferences, new Set());
    expect(selected.rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1.1', '3', '4', '8']);
    expect(selected.matchingTotal).toBe(4);
    expect(selected.scopeTotal).toBe(9);
    preferences.filters.search = 'receipt';
    const searched = sentenceRows(frozen, preferences, new Set());
    expect(searched.rows.filter(row => !row.context).map(row => row.item.id)).toEqual(['1.1', '3', '4', '8']);
    expect(searched.matchingTotal).toBe(4);
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
  it('memoizes the current projection, which a search does not change', () => {
    const frozen = immutable(seed()), preferences = view(seed());
    const first = sentenceRows(frozen, preferences, new Set());
    expect(sentenceRows(frozen, structuredClone(preferences), new Set())).toBe(first);
    preferences.filters.search = 'different'; expect(sentenceRows(frozen, preferences, new Set())).toBe(first);
    preferences.filters.statuses = ['open']; expect(sentenceRows(frozen, preferences, new Set())).not.toBe(first);
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
    return shimTree({ session: immutable(session), view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
  };
  it('joins the parent bullet to the last direct child, across intervening descendants', () => {
    const session = seed();
    session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2 };
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1', ordinal: 1 };
    const rows = model(session), get = (key: string) => rows.find(row => row.key === key)!;
    expect(get('1').guides).toContainEqual({ kind: 'line', x: 42, width: 22, on: false, fromBullet: true, toBullet: false });
    expect(get('1.1').guides).toContainEqual({ kind: 'line', x: 42, width: 22, on: false, fromBullet: false, toBullet: false });
    expect(get('1.1.1').guides).toContainEqual({ kind: 'line', x: 42, width: 22, on: false, fromBullet: false, toBullet: false });
    expect(get('1.2').guides).toContainEqual({ kind: 'line', x: 42, width: 22, on: false, fromBullet: false, toBullet: true });
    expect(get('1.2').guides).toContainEqual({ kind: 'elbow', x: 42, width: 22, on: false });
    expect(get('2').guides.some(guide => guide.x === 42)).toBe(false);
    const topic = get(session.items['1']!.topic_id);
    expect(topic.guides.some(guide => guide.fromBullet && guide.x === 20)).toBe(true);
  });
  it('accents only the path to the selection, and every row of a branch shares its top item’s hue slot', () => {
    const session = seed(), rows = model(session, '1.1');
    const root = rows.find(row => row.key === '1')!, child = rows.find(row => row.key === '1.1')!;
    expect(root.guides.some(guide => guide.on && guide.fromBullet && guide.x === 42)).toBe(true);
    expect(child.guides.some(guide => guide.on && guide.toBullet && guide.x === 42)).toBe(true);
    expect(rows.find(row => row.key === '2')!.guides.some(guide => guide.on)).toBe(false);
    expect(root).toMatchObject({ branch: branchSlot(session.items['1']!.ordinal) });
    expect(child).toMatchObject({ branch: branchSlot(session.items['1']!.ordinal) });
    expect(model(session, '2').find(row => row.key === '1')).toMatchObject({ branch: root.kind === 'item' ? root.branch : undefined });
  });
  it('removes child stems when folded and retains continuous rails through hidden groups and filters', () => {
    const session = seed();
    expect(model(session, null, true).find(row => row.key === '1')!.guides.some(guide => guide.x === 42)).toBe(false);
    const preferences = view(session); preferences.expanded_item_ids = ['1']; preferences.hidden_item_ids = ['1.1'];
    const rows = shimTree({ session: immutable(session), view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
    const hidden = rows.find(row => row.kind === 'strip')!;
    expect(hidden.guides).toContainEqual({ kind: 'line', x: 42, width: 22, on: false, fromBullet: false, toBullet: true });
    // A status filter with the hidden selection revealed keeps the rail from its parent.
    preferences.filters.statuses = ['open'];
    const filtered = shimTree({ session: immutable(session), view: preferences, search: '', later: new Set(), collapsedTopics: new Set(),
      selectedId: '1.1', revealId: '1.1', temporaryExpanded: ['1'], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
    expect(filtered.find(row => row.key === '1')!.guides.some(guide => guide.fromBullet && guide.x === 42)).toBe(true);
  });
  it('builds all rails for 2,000 items without DOM measurements', () => {
    const session = seed(), base = session.items['1']!; session.items = {};
    for (let n = 1; n <= 2000; n++) session.items[String(n)] = { ...base, id: String(n), ordinal: n, parent: null };
    expect(model(session, '2000').filter(row => row.kind === 'item')).toHaveLength(2000);
  });
});
