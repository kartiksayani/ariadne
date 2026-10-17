// treeModel for tests that hold the saved view and nothing else: the filter is built from it on every call, so a test
// that edits `view.filters` between calls sees the edit.
import { treeModel, type TreeInput, type TreeModel } from '../../../src/ui/tree/model';
import { filterOf } from '../../../src/selectors/tree/filter';

export type ShimInput = Omit<TreeInput, 'filter'>;
export const shimTree = (input: ShimInput): TreeModel => treeModel({ ...input, filter: filterOf({ session: input.session, view: input.view, later: input.later, local: [] }) });
