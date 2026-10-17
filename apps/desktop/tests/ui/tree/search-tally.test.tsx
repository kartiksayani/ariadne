// The search tally (SPEC 6.9): the matches the Map does not show are counted apart, and counted only where the row would
// show the text (an outcome under a parked row, or a result behind a question's ask, is not on the Map).
import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { alsoMatching } from '../../../src/selectors/tree/search';
import { AppTransport, route } from '../app/transport';
import { shimTree, type ShimInput } from './shimTree';

function fixture() {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const view = transport.view();
  const model = (extra: Partial<ShimInput> = {}) => shimTree({ session: immutable(session), view, search: '', later: new Set(), collapsedTopics: new Set(),
    selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse('2026-10-07T12:00:00Z'), ...extra });
  return { session, view, model };
}

describe('the search tally', () => {
  it('counts a match the focus leaves out as "outside the focus", not as a collapsed or hidden one', () => {
    const { session, model } = fixture();
    session.items['1']!.question = 'zebra crossing';
    session.items['3']!.question = 'zebra herd';
    session.items['4']!.question = 'zebra stripes';
    const { search } = model({ search: 'zebra', focusRootId: '3' });
    expect(search).toMatchObject({ hidden: 0, collapsed: 0, outsideFocus: 2 });
    expect(search.reveal.topics).toContain(session.items['1']!.topic_id);
    expect(alsoMatching(search.hidden, search.collapsed, search.outsideFocus)).toBe('Also matching: 2 outside the focus.');
    // Without the focus the same two matches are on the Map.
    expect(model({ search: 'zebra' }).search).toMatchObject({ hidden: 0, collapsed: 0, outsideFocus: 0 });
  });

  it('counts an outcome only where the row would show it', () => {
    const { session, view, model } = fixture();
    // 1 is folded: 1.1 sits inside it, so a match in 1.1 is a collapsed one - when its row would show the text.
    view.expanded_item_ids = ['2', '3'];
    const child = session.items['1.1']!;
    child.question = 'Plain title'; child.outcome = 'a zebra in the result'; child.status = 'in_progress';
    expect(model({ search: 'zebra' }).search).toMatchObject({ hidden: 0, collapsed: 1 });
    // Parked for later, a row shows no outcome: nothing to find, nothing to count.
    child.status = 'open';
    expect(model({ search: 'zebra', later: new Set(['1.1']) }).search).toMatchObject({ hidden: 0, collapsed: 0 });
    // A waiting question shows its ask, not its outcome.
    child.status = 'waiting_on_me'; child.ask = session.items['2']!.ask;
    expect(model({ search: 'zebra' }).search).toMatchObject({ hidden: 0, collapsed: 0 });
  });
});
