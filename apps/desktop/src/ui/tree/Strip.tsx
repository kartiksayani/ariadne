// The one strip of the Map: a dashed 20px pill with an icon and a count. It stands for a run of omitted siblings (hidden, not
// matching the filter, or outside the focus) and, inside an item's body, for the folded branch under it.
import type { KeyboardEvent } from 'react';
import { Guides } from './Guides';
import { Boxes, branchStyle } from './BoxSlices';
import type { StripReason, StripRow } from './model';

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
  /** The chip inside an item's body that stands for its folded descendants: "N inside", and "· N waiting" when questions wait. */
  | {
    readonly variant: 'inside';
    readonly text: string;
    /** The item's depth: the chip takes the tint of the box two steps deeper. */
    readonly depth: number;
    readonly onClick: () => void;
  };

const ICON: Readonly<Record<StripReason, string>> = { hidden: 'ph ph-dots-three', filter: 'ph ph-funnel', focus: 'ph ph-crosshair-simple' };
const TITLE: Readonly<Record<StripReason, string | undefined>> = { hidden: undefined, filter: 'Hidden by the status filter', focus: 'Outside the focus' };

/** "3 hidden", "3 not matching" or "3 outside the focus", and " · 2 waiting" when questions wait inside. */
export function stripText(row: Pick<StripRow, 'reason' | 'count' | 'waiting'>): string {
  const what = row.reason === 'hidden' ? 'hidden' : row.reason === 'filter' ? 'not matching' : 'outside the focus';
  return `${row.count} ${what}${row.waiting > 0 ? ` · ${row.waiting} waiting` : ''}`;
}

export function Strip(props: StripProps) {
  if (props.variant === 'inside') {
    return <button type="button" className="tree-collapsed" tabIndex={-1} data-step={Math.min(props.depth + 2, 5)}
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
    <span className="tree-strip" title={TITLE[row.reason]} data-open={hidden && row.expanded || undefined}>
      <i className={ICON[row.reason]} aria-hidden="true" />
      <span>{stripText(row)}</span>
    </span>
  </div>;
}
