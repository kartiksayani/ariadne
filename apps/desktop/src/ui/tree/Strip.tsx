// The one strip of the Map. A run of omitted siblings (hidden, not matching the filter, or outside the focus) and the
// folded branch's chip. The Map look piece gives both one dashed style.
import type { KeyboardEvent } from 'react';
import { Guides } from './Guides';
import { Boxes, branchStyle } from './BoxSlices';
import type { StripRow } from './model';

export type StripProps =
  /** A treeitem row standing in for a run of omitted siblings. */
  | {
    readonly variant: 'row';
    readonly row: StripRow;
    readonly focused: boolean;
    readonly remember: (key: string, element: HTMLDivElement | null) => void;
    readonly onFocus: (key: string) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    /** Opens or closes the hidden items under the strip's parent. Only a hidden strip toggles. */
    readonly onToggle: (row: StripRow) => void;
  }
  /** The chip inside an item's body that stands for its folded descendants. */
  | {
    readonly variant: 'inside';
    readonly text: string;
    readonly onClick: () => void;
  };

export function Strip(props: StripProps) {
  if (props.variant === 'inside') {
    return <button type="button" className="tree-collapsed" tabIndex={-1}
      onClick={event => { event.stopPropagation(); props.onClick(); }}><i className="ph ph-dots-three" />{props.text}</button>;
  }
  const { row, focused, remember, onFocus, onKeyDown, onToggle } = props;
  const hidden = row.reason === 'hidden';
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1}
    aria-expanded={hidden ? row.expanded : undefined} tabIndex={focused ? 0 : -1} className="tree-row tree-hidden-group"
    data-row={row.key} data-strip={row.reason} data-branch={row.branch ?? undefined} style={branchStyle(row.branch, row.depth)}
    onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }} onKeyDown={onKeyDown}
    onClick={hidden ? () => onToggle(row) : undefined}>
    <Boxes boxes={row.boxes} />
    <Guides guides={row.guides} />
    {hidden && <span className="tree-chevron"><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></span>}
    <span>{row.reason === 'hidden' ? `${row.count} ${row.count === 1 ? 'item' : 'items'} hidden`
      : row.reason === 'filter' ? `${row.count} not matching` : `${row.count} outside the focus`}</span>
    {row.waiting > 0 && <span className="tree-hidden-waiting"><i className="ph-fill ph-question" />waiting on you</span>}
  </div>;
}
