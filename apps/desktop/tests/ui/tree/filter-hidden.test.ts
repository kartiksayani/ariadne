// alpha.24 "filter with hidden items": the model's tally of the hidden matches and the filter's own in-memory reveal (G1, G2, G4, G10, G15).
import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { hiddenGroupKey } from '../../../src/ui/tree/hidden';
import { NO_REVEAL, type Row } from '../../../src/ui/tree/model';
import { shimTree, type ShimInput } from './shimTree';
import { AppTransport, route } from '../app/transport';

// The demo: topic A holds 1 (done) with 1.1 (open), 2 (waiting), 3 (in progress), 4 (open), 5, 6, 7; topic B holds 8 (open).
function fixture(hidden: string[], statuses: string[] = ['open']) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const view = transport.view(); view.hidden_item_ids = hidden; view.filters.statuses = statuses as typeof view.filters.statuses;
  const topicA = session.items['1']!.topic_id, topicB = session.items['8']!.topic_id;
  const input: ShimInput = { session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(),
    selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z') };
  return { session, view, topicA, topicB, model: (extra: Partial<ShimInput> = {}) => shimTree({ ...input, ...extra }) };
}
const items = (rows: readonly Row[]) => rows.flatMap(row => row.kind === 'item' ? [row.key] : []);

describe('the filter tally of hidden matches', () => {
  it('G15: counts every hidden match as remaining while nothing is revealed, and draws none of them', () => {
    const { model } = fixture(['4', '8', '1.1']);
    const built = model();
    expect(built.filterHidden).toMatchObject({ remaining: 3, shown: 0, outside: 0 });
    expect(items(built.rows)).not.toContain('4'); expect(items(built.rows)).not.toContain('8'); expect(items(built.rows)).not.toContain('1.1');
  });

  it('G15, G2: "Show them" reveals each hidden match; the same tally then reads them as shown', () => {
    const { model, topicA, topicB } = fixture(['4', '8', '1.1']);
    const reveal = model().filterHidden.reveal;
    expect(reveal.groups).toEqual(expect.arrayContaining([hiddenGroupKey(topicA, null), hiddenGroupKey(topicA, '1'), hiddenGroupKey(topicB, null)]));
    const shown = model({ filterShown: reveal });
    expect(items(shown.rows)).toEqual(expect.arrayContaining(['4', '8', '1.1']));
    for (const id of ['4', '8', '1.1']) expect(shown.rows.find(row => row.key === id)).toMatchObject({ hidden: true });
    expect(shown.filterHidden).toMatchObject({ remaining: 0, shown: 3, outside: 0 });
  });

  it('G1: a non-matching hidden item stays hidden and is not counted', () => {
    const { model } = fixture(['2', '4']);
    const built = model();
    expect(built.filterHidden.remaining).toBe(1);
    expect(items(model({ filterShown: built.filterHidden.reveal }).rows)).not.toContain('2');
  });

  it('G2: a hidden match under a hidden parent is revealed through the parent\'s group', () => {
    const { model, topicA } = fixture(['1']);
    const built = model();
    expect(built.filterHidden).toMatchObject({ remaining: 1, shown: 0 });
    expect(built.filterHidden.reveal.groups).toEqual([hiddenGroupKey(topicA, null)]);
    const shown = model({ filterShown: built.filterHidden.reveal });
    expect(items(shown.rows)).toEqual(expect.arrayContaining(['1', '1.1']));
    expect(shown.rows.find(row => row.key === '1' && row.kind === 'item')).toMatchObject({ hidden: true, context: true });
    expect(shown.filterHidden).toMatchObject({ remaining: 0, shown: 1 });
  });

  it('G2: a hidden match inside an item or topic the owner folded under this filter is revealed through the fold', () => {
    const { model, topicB } = fixture(['1.1', '8']);
    const folded = { filterCollapsedItemIds: new Set(['1']), filterCollapsedTopicIds: new Set([topicB]) };
    const built = model(folded);
    expect(built.filterHidden).toMatchObject({ remaining: 2 });
    expect(built.filterHidden.reveal.items).toEqual(['1']); expect(built.filterHidden.reveal.topics).toEqual([topicB]);
    const shown = model({ ...folded, filterShown: built.filterHidden.reveal });
    expect(items(shown.rows)).toEqual(expect.arrayContaining(['1.1', '8']));
    expect(shown.filterHidden).toMatchObject({ remaining: 0, shown: 2 });
  });

  it('G4: a group the owner opened by hand is not the filter\'s: its matches are not counted as shown, and stay when the reveal goes', () => {
    const { model, topicA, topicB } = fixture(['4', '8']);
    const byHand = new Set([hiddenGroupKey(topicA, null)]);
    const handOpen = model({ expandedHiddenGroups: byHand });
    expect(items(handOpen.rows)).toContain('4'); expect(items(handOpen.rows)).not.toContain('8');
    expect(handOpen.filterHidden).toMatchObject({ remaining: 1, shown: 0 });
    // The filter's reveal also lists the hand-opened group (it reveals what it needs): only the other group is the filter's.
    const both = model({ expandedHiddenGroups: byHand, filterShown: { items: [], topics: [], groups: [hiddenGroupKey(topicA, null), hiddenGroupKey(topicB, null)] } });
    expect(both.filterHidden).toMatchObject({ remaining: 0, shown: 1 });
    expect(items(both.rows)).toEqual(expect.arrayContaining(['4', '8']));
    const away = model({ expandedHiddenGroups: byHand, filterShown: NO_REVEAL });
    expect(items(away.rows)).toContain('4'); expect(items(away.rows)).not.toContain('8');
  });

  it('G1: the search\'s own reveal is separate: matches it opened are neither remaining nor the filter\'s shown', () => {
    const { model, topicA } = fixture(['4']);
    const searched = model({ search: 'x', searchShown: { items: [], topics: [], groups: [hiddenGroupKey(topicA, null)] } });
    expect(items(searched.rows)).toContain('4');
    expect(searched.filterHidden).toMatchObject({ remaining: 0, shown: 0 });
    // The filter's reveal alone does not touch what the search holds.
    const reveal = model().filterHidden.reveal;
    expect(model({ search: 'x', filterShown: reveal }).filterHidden).toMatchObject({ remaining: 0, shown: 1 });
  });

  it('G4: a selected or revealed hidden match is drawn anyway and belongs to no reveal', () => {
    const { model } = fixture(['4', '8']);
    const revealed = model({ revealId: '4', selectedId: '4' });
    expect(items(revealed.rows)).toContain('4');
    expect(revealed.filterHidden).toMatchObject({ remaining: 1, shown: 0 });
    // Hiding the revealed item's group again by Hide them leaves it as it was: the filter's reveal never held it.
    expect(items(model({ revealId: '4', selectedId: '4', filterShown: NO_REVEAL }).rows)).toContain('4');
  });

  it('G10: in Focus, only matches inside the focused branch are remaining; the rest are counted outside, and Show them leaves Focus alone', () => {
    const { model } = fixture(['4', '8', '1.1']);
    const focused = model({ focusRootId: '4' });
    expect(focused.filterHidden).toMatchObject({ remaining: 1, shown: 0, outside: 2 });
    const reveal = focused.filterHidden.reveal;
    expect(reveal.groups.length).toBe(1);
    const shown = model({ focusRootId: '4', filterShown: reveal });
    expect(items(shown.rows)).toContain('4'); expect(items(shown.rows)).not.toContain('8');
    expect(shown.filterHidden).toMatchObject({ remaining: 0, shown: 1, outside: 2 });
  });

  it('G1: with no filter active the tally is zero and a leftover reveal draws nothing', () => {
    const { model } = fixture(['4', '8'], []);
    const plain = model();
    expect(plain.filtering).toBe(false);
    expect(plain.filterHidden).toMatchObject({ remaining: 0, shown: 0, outside: 0 });
    const leftover = model({ filterShown: { items: [], topics: [], groups: [hiddenGroupKey(model().rows.find(row => row.kind === 'topic')!.key, null)] } });
    expect(items(leftover.rows)).toEqual(items(plain.rows));
  });

  it('G15: a filter with no hidden item has nothing to tally', () => {
    const { model } = fixture([]);
    expect(model().filterHidden).toMatchObject({ remaining: 0, shown: 0, outside: 0 });
    expect(model().filterHidden.reveal).toEqual(NO_REVEAL);
  });
});
