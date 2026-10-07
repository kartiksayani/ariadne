// "Item Row" of the handoff (Item Row.dc.html): guides and the accent thread,
// the status icon, the question with search hits, exactly one supporting line,
// the collapsed note, the inline answer box, the round tag, hover actions, the
// id and the text badge.
import type { KeyboardEvent, ReactNode } from 'react';
import { StatusIcon, StatusText } from './StatusBadge';
import { closed, visual, type Guide, type ItemRow as Row } from './model';

export interface RowAction { readonly icon: string; readonly title: string; readonly run: () => void }

const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;

export function Guides({ guides }: { guides: readonly Guide[] }) {
  return <>{guides.map((guide, index) => {
    const color = guide.on ? 'var(--color-accent)' : 'var(--a-guide)', stroke = guide.on ? '1.5px' : '1px';
    return guide.kind === 'line'
      ? <div key={index} className="tree-guide" style={{ left: guide.x, width: stroke, background: color }} />
      : <div key={index} className="tree-elbow" style={{ left: guide.x, width: guide.width, borderLeft: `${guide.through ? '0px' : stroke} solid ${color}`,
        borderBottom: `${stroke} solid ${color}`, borderBottomLeftRadius: guide.through ? 0 : 7 }} />;
  })}</>;
}

/** The one supporting line, by priority (Item Row.dc.html:68-75). */
function supporting(row: Row, jump: () => void): ReactNode {
  const item = row.item, delivery = row.delivery;
  if (delivery) return <div className="tree-line" style={{ color: delivery.color }}><i className={delivery.icon} /><span>{delivery.text}</span></div>;
  if (row.later) return <div className="tree-line tree-line-tight" style={{ color: neutral(62) }}><i className="ph ph-clock" /><span>Parked for later · still open</span></div>;
  if (item.status === 'waiting_on_me' && item.ask) return <div className="tree-line tree-ask">{item.ask}</div>;
  if (item.status === 'in_progress' && item.note) return <div className="tree-line tree-line-tight" style={{ color: 'var(--st-progress)' }}><i className="ph ph-robot" /><span>{item.note}</span></div>;
  if (item.status === 'replaced' && row.replacedBy) {
    return <div className="tree-line" style={{ color: neutral(66) }}><i className="ph ph-arrow-bend-down-right tree-line-small" /><span>Replaced by</span>
      <button type="button" className="tree-jump" onClick={event => { event.stopPropagation(); jump(); }}>{row.replacedBy.question}</button>
      <StatusText status={visual(row.replacedBy.status)} /></div>;
  }
  if (closed(item.status) && item.outcome) {
    return <div className="tree-line tree-outcome"><i className="ph ph-arrow-elbow-down-right" style={{ color: `var(--st-${visual(item.status)})` }} /><span>{item.outcome}</span></div>;
  }
  return null;
}

export interface ItemRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly focused: boolean;
  /** Selection is held while a view write is unconfirmed. */
  readonly disabled?: boolean;
  /** strong: the hovered message touched this item; weak: it touched something folded inside. */
  readonly highlight: 'strong' | 'weak' | null;
  readonly note: string | null;
  readonly actions: readonly RowAction[];
  readonly answer: ReactNode;
  readonly remember: (key: string, element: HTMLDivElement | null) => void;
  readonly onFocus: (key: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly onJump: (id: string) => void;
  readonly onHover: (id: string | null) => void;
}

export function ItemRow({ row, selected, focused, disabled = false, highlight, note, actions, answer, remember, onFocus, onKeyDown, onSelect, onToggle, onJump, onHover }: ItemRowProps) {
  const item = row.item, status = visual(item.status);
  const muted = closed(item.status) || row.context || row.later;
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1} aria-selected={selected} aria-disabled={disabled || undefined}
    aria-expanded={row.hasKids ? row.expanded : undefined} tabIndex={focused ? 0 : -1} className="tree-row tree-item"
    data-item-id={item.id} data-row={row.key} data-highlight={highlight ?? undefined}
    style={{ paddingLeft: 12 + row.depth * 24 }} onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }}
    onKeyDown={onKeyDown} onClick={() => onSelect(item.id)} onMouseEnter={() => onHover(item.id)} onMouseLeave={() => onHover(null)}>
    <div className="tree-mark" />
    <Guides guides={row.guides} />
    {row.hasKids
      ? <button type="button" className="tree-chevron" tabIndex={-1} aria-label="Expand or collapse"
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></button>
      : <span className="tree-chevron-space" />}
    <span className="tree-icon"><StatusIcon status={status} /></span>
    <div className="tree-body">
      <div className="tree-question" style={{ color: muted ? neutral(64) : 'var(--color-text)' }}>
        {row.segments.map((segment, index) => <span key={index} className={segment.hit ? 'tree-hit' : undefined}>{segment.text}</span>)}
      </div>
      {supporting(row, () => { if (row.replacedBy) onJump(row.replacedBy.id); })}
      {note && <button type="button" className="tree-collapsed" tabIndex={-1} data-weak={highlight === 'weak' || undefined}
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className="ph ph-dots-three" />{note}</button>}
      {answer && <div className="tree-answer" onClick={event => event.stopPropagation()}>{answer}</div>}
    </div>
    <div className="tree-end">
      {row.rounds >= 2 && <span className="tree-round" title="Rounds of back and forth"><i className="ph ph-arrows-clockwise" />Round {row.rounds}</span>}
      {actions.length > 0 && <span className="tree-actions">{actions.map(action => <button key={action.title} type="button" tabIndex={-1}
        className="tree-action" title={action.title} aria-label={action.title}
        onClick={event => { event.stopPropagation(); action.run(); }}><i className={action.icon} /></button>)}</span>}
      <span className="tree-id">{item.id}</span>
      <StatusText status={status} label={row.badge} />
    </div>
  </div>;
}
