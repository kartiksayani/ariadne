// treeModel for tests that hold the saved view and nothing else: the filter is built from it on every call, so a test
// that edits `view.filters` between calls sees the edit. `local` stands for the browser-only chips (To ack, Sent, Blocked, Later).
import { treeModel, type TreeInput, type TreeModel } from '../../../src/ui/tree/model';
import { filterOf, type LocalChip } from '../../../src/selectors/tree/filter';

export type ShimInput = Omit<TreeInput, 'filter'> & { readonly local?: readonly LocalChip[] };
export const shimTree = ({ local = [], ...input }: ShimInput): TreeModel =>
  treeModel({ ...input, filter: filterOf({ session: input.session, view: input.view, later: input.later, local }) });
