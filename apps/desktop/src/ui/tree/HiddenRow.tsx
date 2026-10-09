import type { KeyboardEvent } from 'react';
import { Guides } from './ItemRow';
import type { HiddenRow as Row } from './model';

export function HiddenRow({ row, focused, remember, onFocus, onKeyDown, onToggle }: {
  row: Row; focused: boolean;
  remember: (key: string, element: HTMLDivElement | null) => void;
  onFocus: (key: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onToggle: (key: string) => void;
}) {
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
