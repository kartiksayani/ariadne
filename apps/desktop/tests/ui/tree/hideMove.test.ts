// Hide moves on (alpha.24 D1, R4): the item selected once an item is hidden, from the Map as it will show after the hide.
import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { selectionAfterHide, shownItems } from '../../../src/ui/tree/hideMove';
import { hiddenGroupKey } from '../../../src/ui/tree/hidden';
import { shimTree, type ShimInput } from './shimTree';
import { AppTransport, route } from '../app/transport';
import type { Session } from '../../../src/generated/domain/models';

/** The demo session: topic A holds roots 1 to 7 (1.1 under 1); topic B holds 8 alone. 1.2 and 1.3 join 1.1 under 1. */
function fixture() {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  session.items['1.2'] = { ...session.items['1.1']!, id: '1.2', ordinal: 2, question: 'Second child' };
  session.items['1.3'] = { ...session.items['1.1']!, id: '1.3', ordinal: 3, question: 'Third child' };
  const view = transport.view(); view.expanded_item_ids = ['1'];
  const input: ShimInput = { session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(),
    selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z') };
  /** The Map once `id` is hidden too, and the item the rule selects then. */
  const after = (id: string, extra: Partial<ShimInput> = {}) => {
    const hidden = { ...view, hidden_item_ids: [...view.hidden_item_ids ?? [], id] };
    const model = shimTree({ ...input, ...extra, view: hidden });
    return selectionAfterHide(immutable(session), id, shownItems(model.rows));
  };
  return { session: session as Session, view, after, input };
}

describe('the item selected once an item is hidden', () => {
  it('row 1: a middle sibling hands over to the next one', () => {
    expect(fixture().after('1.2')).toBe('1.3');
    expect(fixture().after('3')).toBe('4');
  });
  it('row 2: the last sibling hands over to the previous one', () => {
    expect(fixture().after('1.3')).toBe('1.2');
    expect(fixture().after('7')).toBe('6');
  });
  it('row 3: an only child hands over to its parent', () => {
    const { session, after } = fixture();
    delete session.items['1.2']; delete session.items['1.3'];
    expect(after('1.1')).toBe('1');
  });
  it('row 4: the only root of a topic selects nothing', () => {
    expect(fixture().after('8')).toBeNull();
  });
  it('row 5: a next sibling already hidden or filtered out is skipped', () => {
    const hidden = fixture();
    hidden.view.hidden_item_ids = ['4'];
    expect(hidden.after('3')).toBe('5');
    hidden.view.hidden_item_ids = ['4', '5', '6', '7'];
    expect(hidden.after('3')).toBe('2');
    // Open only: 1.1, 1.2, 1.3 and 4 are open; 1 shows as their context.
    const filtered = fixture();
    filtered.view.filters.statuses = ['open'];
    expect(filtered.after('1.2')).toBe('1.3');
    expect(filtered.after('4')).toBe('1');
  });
  it('a dimmed row of an open hidden group is no candidate (the group was already open: Path B)', () => {
    const { view, session, after } = fixture();
    view.hidden_item_ids = ['5', '6', '7'];
    const groups = new Set([hiddenGroupKey(session.items['4']!.topic_id, null)]);
    expect(after('4', { expandedHiddenGroups: groups })).toBe('3');
  });
  it('review 6: with the filter\'s reveal open the rule reads the Map as it draws it: the revealed context row is a candidate, the dimmed row is not', () => {
    const { view, input, after } = fixture();
    // Open only: 1.1 (hidden), 1.2 and 1.3 are open children of 1, which the owner folded under this filter. 1.1 is a hidden match,
    // so "Show them" unfolds 1, and 1.2 and 1.3 are drawn beside the dimmed 1.1.
    view.filters.statuses = ['open']; view.hidden_item_ids = ['1.1'];
    const folded = { filterCollapsedItemIds: new Set(['1']) };
    const reveal = shimTree({ ...input, ...folded }).filterHidden.reveal;
    expect(reveal.items).toEqual(['1']);
    // Hiding 1.2 with 1 still folded: 1.3 is not drawn, so the selection falls back to the parent.
    expect(after('1.2', folded)).toBe('1');
    // With the reveal the Map draws 1.3, so the rule hands over to it; the dimmed 1.1 is no candidate.
    expect(after('1.2', { ...folded, filterShown: reveal })).toBe('1.3');
    const model = shimTree({ ...input, ...folded, view: { ...view, hidden_item_ids: ['1.1', '1.2', '1.3'] }, filterShown: reveal });
    expect(model.rows.find(row => row.kind === 'item' && row.key === '1.1')).toMatchObject({ hidden: true });
    expect(shownItems(model.rows)).not.toContain('1.1');
  });
  it('row 6: an ancestor is the subject: its own siblings take over', () => {
    expect(fixture().after('1')).toBe('2');
  });
  it('the parent fallback is the nearest ancestor the Map still shows', () => {
    const { session, view, after } = fixture();
    session.items['1.1.1'] = { ...session.items['1.1']!, id: '1.1.1', parent: '1.1', ordinal: 1, status: 'open' };
    view.expanded_item_ids = ['1', '1.1'];
    // Open only: 1 (done) shows as context, 1.1 and 1.1.1 are open. 1.1.1 has no sibling: its parent takes over.
    view.filters.statuses = ['open'];
    delete session.items['1.2']; delete session.items['1.3'];
    expect(after('1.1.1')).toBe('1.1');
    // An ancestor not shown at all is passed over: the selection goes to the next one up that is.
    expect(selectionAfterHide(immutable(session), '1.1.1', ['1'])).toBe('1');
  });
  it('Focus on a root that is hidden ends: the roots the Map shows without it are the candidates', () => {
    const { view, after } = fixture();
    view.focused_item_id = '3';
    // The hide's patch ends Focus, so the projection the rule reads has none.
    expect(after('3', { focusRootId: null })).toBe('4');
  });
});
