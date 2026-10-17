// The one strip of the Map. Today it draws what two older pieces drew: the "N items hidden" row
// and the folded branch's chip. The Map look piece gives both one dashed style.
import type { KeyboardEvent } from 'react';
import { Guides } from './Guides';
import type { StripRow } from './model';

export type StripProps =
  /** A treeitem row standing in for a group of hidden siblings. */
  | {
    readonly variant: 'hidden';
    readonly row: StripRow;
    readonly focused: boolean;
    readonly remember: (key: string, element: HTMLDivElement | null) => void;
    readonly onFocus: (key: string) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    readonly onToggle: (key: string) => void;
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
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1}
    aria-expanded={row.expanded} tabIndex={focused ? 0 : -1} className="tree-row tree-hidden-group"
    data-row={row.key} style={{ paddingLeft: 12 + row.depth * 24 }}
    onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }} onKeyDown={onKeyDown}
    onClick={() => onToggle(row.key)}>
    <Guides guides={row.guides} />
    <span className="tree-chevron"><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></span>
    <span>{row.count} {row.count === 1 ? 'item' : 'items'} hidden</span>
    {row.waiting && <span className="tree-hidden-waiting"><i className="ph-fill ph-question" />waiting on you</span>}
  </div>;
}
