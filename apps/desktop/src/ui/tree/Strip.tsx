// The one strip of the Map: a dashed 20px pill with an icon and a count. It stands for a run of omitted siblings (hidden, not
// matching the filter, or outside the focus), for one item or topic in its place (removed, removed by the agent, archived:
// a button, E29), and, inside an item's body, for the folded branch under it.
import type { KeyboardEvent } from 'react';
import { Guides } from './Guides';
import { Boxes, branchStyle } from './BoxSlices';
import type { PlaceStrip, StripReason, StripRow } from './model';

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
    /** A strip in an item's or topic's place: Undo (removed, archived) or open the bin (removed by the agent). */
    readonly onPlace?: (row: StripRow) => void;
  }
  /** The chip inside an item's body that stands for its folded descendants: "N inside", and "· N waiting" when questions wait. */
  | {
    readonly variant: 'inside';
    readonly text: string;
    /** The item's depth: the chip takes the tint of the box two steps deeper. */
    readonly depth: number;
    readonly onClick: () => void;
  };

const ICON: Readonly<Record<StripReason, string>> = { hidden: 'ph ph-dots-three', filter: 'ph ph-funnel', focus: 'ph ph-crosshair-simple',
  removed: 'ph ph-trash', 'agent-removed': 'ph ph-trash', archived: 'ph ph-archive' };
const TITLE: Readonly<Record<StripReason, string | undefined>> = { hidden: undefined, filter: 'Hidden by the status filter', focus: 'Outside the focus',
  removed: 'Undo the remove', 'agent-removed': 'Open the bin', archived: 'Undo the archive' };

const items = (count: number) => `${count} item${count === 1 ? '' : 's'}`;
/**
 * A place strip's words (SPEC 10.3, 10.13, 10.14, 11.3): "Removed “x”", "Removed “x” and the 4 items below it",
 * "Removed “T” · 25 items · Undo", "Claude Code removed “x” · 3 items", "Archived “T” · 25 items · Undo".
 */
export function placeText(place: PlaceStrip): string {
  if (place.reason === 'archived') return `Archived “${place.name}” · ${items(place.count)} · Undo`;
  if (place.reason === 'agent-removed') return `${place.agent ?? 'The agent'} removed “${place.name}”${place.count > 1 ? ` · ${items(place.count)}` : ''}`;
  if (!place.itemId) return `Removed “${place.name}” · ${items(place.count)}${place.ended ? '' : ' · Undo'}`;
  return place.count > 1 ? `Removed “${place.name}” and the ${items(place.count - 1)} below it` : `Removed “${place.name}”`;
}

/** "3 hidden", "3 not matching" or "3 outside the focus", and " · 2 waiting" when questions wait inside. */
export function stripText(row: Pick<StripRow, 'reason' | 'count' | 'waiting' | 'place'>): string {
  if (row.place) return placeText(row.place);
  const what = row.reason === 'hidden' ? 'hidden' : row.reason === 'filter' ? 'not matching' : 'outside the focus';
  return `${row.count} ${what}${row.waiting > 0 ? ` · ${row.waiting} waiting` : ''}`;
}

export function Strip(props: StripProps) {
  if (props.variant === 'inside') {
    return <button type="button" className="tree-collapsed" tabIndex={-1} data-step={Math.min(props.depth + 2, 5)}
      onClick={event => { event.stopPropagation(); props.onClick(); }}><i className="ph ph-dots-three" />{props.text}</button>;
  }
  const { row, focused, remember, onFocus, onKeyDown, onToggle, onPlace } = props;
  const hidden = row.reason === 'hidden';
  if (row.place) {
    // A removed strip whose window ended offers no Undo: its click and keys do nothing (E29).
    const ended = !!row.place.ended;
    const place = () => { if (!ended) onPlace?.(row); };
    return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1} tabIndex={focused ? 0 : -1}
      className="tree-row tree-hidden-group tree-place" data-row={row.key} data-strip={row.reason} data-branch={row.branch ?? undefined}
      style={branchStyle(row.branch, row.depth)} aria-label={stripText(row)} aria-disabled={ended || undefined}
      onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); place(); } else onKeyDown(event); }}>
      <Boxes boxes={row.boxes} />
      <Guides guides={row.guides} />
      <button type="button" tabIndex={-1} className="tree-strip" title={ended ? undefined : TITLE[row.reason]} onClick={event => { event.stopPropagation(); place(); }}>
        <i className={ICON[row.reason]} aria-hidden="true" />
        <span>{stripText(row)}</span>
      </button>
    </div>;
  }
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
