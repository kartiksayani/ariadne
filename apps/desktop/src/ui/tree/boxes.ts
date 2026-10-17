// The box pass: the last step of treeModel. It gives each row its branch, nested boxes and thread.
// Today it changes nothing; the Map look piece fills it in. Pure and O(n): no DOM measurement.
import type { Row } from './model';

export function withBoxes(rows: readonly Row[]): readonly Row[] {
  return rows;
}
