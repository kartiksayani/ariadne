// The box pass: the last step of treeModel. It gives each row its branch and its slice of every box around it.
// Pure and O(n x depth): no DOM measurement, so a row's height never depends on the boxes around it.
//
// A top item and everything below it share one tinted box; each child item opens a deeper box inside it. A row at depth d
// is inside d boxes (depth 1..d), a strip at depth d inside the d-1 boxes of its ancestors. The page draws one absolutely
// positioned slice per box per row, so the rows stay as tall as their text.
import type { Row } from './model';
import { branchSlot } from './branch';

/** One box's slice on one row. */
export interface Box {
  /** The box's depth: its column is X(k) = 20 + 22k and its right edge is inset (k - 1) * 6. */
  readonly k: number;
  /** The row that opens the box (its own item): rounded top corners. */
  readonly first: boolean;
  /** The row that closes the box (the last row of its item's subtree): rounded bottom corners. */
  readonly last: boolean;
  /** On a closing row, how many outer boxes close on the same row too: the inner box ends higher so each edge shows. */
  readonly outer: number;
}

/** The distance between two depths' bullet columns. */
export const COLUMN_STEP = 22;
/** The column of the bullet (chevron or icon) at a depth: X(k) = 20 + 22k. */
export const columnX = (depth: number) => 20 + COLUMN_STEP * depth;

export function withBoxes(rows: readonly Row[]): readonly Row[] {
  let rootOrdinal: number | null = null;
  return rows.map((row, at) => {
    if (row.kind === 'topic') { rootOrdinal = null; return row; }
    if (row.kind === 'item' && row.depth === 1) rootOrdinal = row.item.ordinal;
    const depth = row.kind === 'item' ? row.depth : row.depth - 1;
    const next = rows[at + 1], nextDepth = !next || next.kind === 'topic' ? 0 : next.depth;
    const boxes: Box[] = [];
    for (let k = 1; k <= depth; k++) {
      const last = nextDepth <= k;
      boxes.push({ k, first: row.kind === 'item' && k === row.depth, last, outer: last ? Math.max(0, k - Math.max(nextDepth, 1)) : 0 });
    }
    // A top-level strip sits between branches, in none of them.
    const branch = rootOrdinal === null || row.kind === 'strip' && row.depth === 1 ? null : branchSlot(rootOrdinal);
    return row.kind === 'item' ? { ...row, boxes, branch: branch ?? 0 } : { ...row, boxes, branch };
  });
}
