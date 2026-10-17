import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import type { Session } from '../../../src/generated/domain/models';
import type { SessionPreferences } from '../../../src/generated/core';
import { columnX, type Box } from '../../../src/ui/tree/boxes';
import { graphSession, preferences } from '../graph/fixture';
import { shimTree } from './shimTree';

// The box pass (ALPHA20-REPLAN D1): a row at depth d sits inside d boxes, one per ancestor-or-self item; a strip inside the
// boxes of its ancestors. The box that a row opens (its own) has rounded top corners, the one it closes rounded bottom
// corners, and a row's slices never depend on its text, so the height of a row never depends on them.

const rows = (session: Session, view: SessionPreferences = preferences()) => shimTree({ session: immutable(session), view, search: '', later: new Set(),
  collapsedTopics: new Set(), selectedId: null, revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.parse(session.updated_at) }).rows;
const shape = (boxes: readonly Box[]) => boxes.map(box => `${box.k}${box.first ? 'f' : ''}${box.last ? `l${box.outer}` : ''}`).join(' ');

describe('box pass', () => {
  it('gives each row one slice per box around it, opening on its own item and closing on its last row', () => {
    const list = rows(graphSession(), preferences({ expanded_item_ids: ['1', '1.1'] }));
    const at = (key: string) => list.find(row => row.key === key)!;
    // Topic A: 1 > (1.1 > 1.1.1, 1.2); 2; 3. Rows after 1.1.1: 1.2 (depth 2) ends box 3 and box 2 of 1.1.
    const table: ReadonlyArray<readonly [string, string]> = [
      ['1', '1f'], ['1.1', '1 2f'], ['1.1.1', '1 2l0 3fl1'], ['1.2', '1l0 2fl1'], ['2', '1fl0'], ['3', '1fl0'],
    ];
    for (const [key, expected] of table) expect([key, shape((at(key) as { boxes: readonly Box[] }).boxes)]).toEqual([key, expected]);
    const topicRow = list.find(row => row.kind === 'topic')!;
    expect('boxes' in topicRow).toBe(false);
  });

  it('puts a strip in its ancestors’ boxes only, and a top-level strip in none', () => {
    const session = graphSession();
    const list = rows(session, preferences({ expanded_item_ids: ['1'], hidden_item_ids: ['1.2', '2'] }));
    const strips = list.filter(row => row.kind === 'strip');
    expect(strips.map(row => [row.parent, shape(row.boxes)])).toEqual([['1', '1l0'], [null, '']]);
  });

  it('closes one box per row for each level the next row steps back out', () => {
    const session = graphSession(), template = session.items['1.1.1']!;
    session.items['1.1.1.1'] = { ...structuredClone(template), id: '1.1.1.1', parent: '1.1.1', ordinal: 1 };
    const list = rows(session, preferences({ expanded_item_ids: ['1', '1.1', '1.1.1'] }));
    const deepest = list.find(row => row.key === '1.1.1.1') as { boxes: readonly Box[] };
    // Next row is 1.2 at depth 2: boxes 4, 3 and 2 close here, the innermost ending highest.
    expect(shape(deepest.boxes)).toBe('1 2l0 3l1 4fl2');
  });

  it('keeps the column and the box clamps: X(k) = 20 + 22k', () => {
    expect([0, 1, 2, 5].map(columnX)).toEqual([20, 42, 64, 130]);
  });
});
