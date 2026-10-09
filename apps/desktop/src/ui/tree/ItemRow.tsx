// "Item Row" of the handoff (Item Row.dc.html): guides and the accent thread,
// the status icon, the question with search hits, the item's details (folded to
// two lines, with Show more) and under them the delivery of the owner's latest
// message, the collapsed note, the inline answer box, the round tag, hover actions, the
// id and the text badge.
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Markdown } from '../shared/MarkdownText';
import { StatusBadge } from '../shared/StatusBadge';
import { ackTitle } from '../shared/ack';
import { closed, visual, type Guide, type ItemRow as Row } from './model';

export interface RowAction { readonly icon: string; readonly title: string; readonly run: () => void; readonly glyph?: ReactNode; readonly label?: string; readonly disabled?: boolean; readonly persistent?: boolean }

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

/** Lines of an item's preview before "Show more" folds the rest away. */
const CLAMP_LINES = 2;
/** Row height of the preview text (tree.css `.tree-line`), when the browser reports none. */
const PREVIEW_LINE = 21;

interface Preview { readonly node: ReactNode; /** The long text the clamp applies to, if any. */ readonly text: string | null }

/** The item's own details under the title, by priority (Item Row.dc.html:68-75). A delivery never takes this place. */
function preview(row: Row, jump: () => void, open: boolean): Preview | null {
  const item = row.item;
  if (row.later) return { text: null, node: <div className="tree-line tree-line-tight" style={{ color: neutral(62) }}><i className="ph ph-clock" /><span>Parked for later · still open</span></div> };
  if (item.status === 'waiting_on_me' && item.ask) return { text: item.ask, node: <div className="tree-line tree-ask"><Markdown className="tree-clamp" text={item.ask} compact={!open} /></div> };
  if (item.status === 'replaced' && row.replacedBy) {
    return { text: null, node: <div className="tree-line" style={{ color: neutral(66) }}><i className="ph ph-arrow-bend-down-right tree-line-small" /><span>Replaced by</span>
      <button type="button" className="tree-jump" onClick={event => { event.stopPropagation(); jump(); }}>{row.replacedBy.question}</button>
      <StatusBadge status={visual(row.replacedBy.status)} variant="text" /></div> };
  }
  if ((closed(item.status) || item.status === 'open' || item.status === 'in_progress') && item.outcome) {
    return { text: item.outcome, node: <div className="tree-line tree-outcome"><i className="ph ph-arrow-elbow-down-right" style={{ color: `var(--st-${visual(item.status)})` }} />
      <Markdown className="tree-clamp" text={item.outcome} compact={!open} /></div> };
  }
  if (item.status === 'in_progress' && item.note) {
    return { text: item.note, node: <div className="tree-line tree-line-tight" style={{ color: 'var(--st-progress)' }}><i className="ph ph-robot" /><Markdown className="tree-clamp" text={item.note} compact={!open} /></div> };
  }
  return null;
}

/** The delivery of the owner's latest message, as a small line under the details; a stopped one shows its fix instead. */
function delivery(row: Row, fix: ReactNode): ReactNode {
  const value = row.delivery;
  if (!value) return null;
  if (value.stuck && fix) return fix;
  return <div className="tree-line tree-delivery" style={{ color: value.color }}><i className={value.icon} /><span>{value.text}</span></div>;
}

/** Measure title and excerpt separately; expanding shows both in full. */
function PreviewBlock({ row, value, open, onToggle }: { row: Row; value: Preview | null; open: boolean; onToggle: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const text = value?.text;
  useLayoutEffect(() => {
    const title = box.current?.previousElementSibling as HTMLElement | null;
    const excerpt = text == null ? null : box.current?.querySelector<HTMLElement>('.tree-clamp');
    const targets = [title, excerpt].filter((target): target is HTMLElement => !!target);
    const measure = () => {
      const overflows = targets.some(target => target.scrollHeight > (parseFloat(getComputedStyle(target).lineHeight) || PREVIEW_LINE) * CLAMP_LINES + 1);
      // Flattened block content still offers its complete structure even when the summary fits.
      setLong(previous => overflows || !!text?.includes('\n') || (open && previous));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    targets.forEach(target => observer.observe(target));
    return () => observer.disconnect();
  }, [text, row.item.question, open]);
  return <div ref={box} className="tree-preview" data-open={open || undefined} style={{ '--tree-clamp': CLAMP_LINES } as CSSProperties}>
    {value?.node}
    {long && <button type="button" className="tree-more" aria-expanded={open}
      onClick={event => { event.stopPropagation(); onToggle(); }}>{open ? 'Show less' : 'Show more'}</button>}
  </div>;
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
  /** A stopped delivery's inline fix (ui/answer/StuckNote); it takes the delivery line's place. */
  readonly fix?: ReactNode;
  /** The long preview is shown in full ("Show less" offered) instead of folded to two lines. */
  readonly unfolded: boolean;
  readonly onUnfold: (id: string) => void;
  readonly remember: (key: string, element: HTMLDivElement | null) => void;
  readonly onFocus: (key: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly onJump: (id: string) => void;
  readonly onHover: (id: string | null) => void;
}

export function ItemRow({ row, selected, focused, disabled = false, highlight, note, actions, answer, fix, unfolded, onUnfold, remember, onFocus, onKeyDown, onSelect, onToggle, onJump, onHover }: ItemRowProps) {
  const item = row.item, status = visual(row.status);
  const details = preview(row, () => { if (row.replacedBy) onJump(row.replacedBy.id); }, unfolded);
  const muted = closed(item.status) || row.context || row.later || row.hidden;
  const actionButton = (action: RowAction) => <button key={action.title} type="button" tabIndex={action.persistent ? 0 : -1}
    className={`tree-action${action.label ? ' tree-action-label' : ''}${action.persistent ? ' tree-action-ack' : ''}`} title={action.title} aria-label={action.title} disabled={action.disabled}
    onClick={event => { event.stopPropagation(); action.run(); }}>{action.glyph ?? <i className={action.icon} />}{action.label}</button>;
  const persistent = actions.filter(action => action.persistent), hover = actions.filter(action => !action.persistent);
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1} aria-selected={selected} aria-disabled={disabled || undefined}
    aria-expanded={row.hasKids ? row.expanded : undefined} tabIndex={focused ? 0 : -1} className={`tree-row tree-item ${row.depth === 1 ? 'tree-item-root' : 'tree-item-child'}${row.hidden ? ' tree-item-hidden' : ''}`}
    data-open={unfolded || undefined} data-item-id={item.id} data-row={row.key} data-highlight={highlight ?? undefined}
    style={{ paddingLeft: 12 + row.depth * 24 }} onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }}
    onKeyDown={onKeyDown} onClick={() => onSelect(item.id)} onMouseEnter={() => onHover(item.id)} onMouseLeave={() => onHover(null)}>
    <div className="tree-mark" />
    <Guides guides={row.guides} />
    {row.hasKids
      ? <button type="button" className="tree-chevron" tabIndex={-1} aria-label="Expand or collapse"
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></button>
      : <span className="tree-chevron-space" />}
    <span className="tree-icon"><StatusBadge status={status} variant="icon" /></span>
    <div className="tree-body">
      <div className="tree-question tree-clamp" style={{ color: muted ? neutral(64) : 'var(--color-text)' }}>
        {row.segments.map((segment, index) => <span key={index} className={segment.hit ? 'tree-hit' : undefined}>{segment.text}</span>)}
      </div>
      <PreviewBlock row={row} value={details} open={unfolded} onToggle={() => onUnfold(item.id)} />
      {item.ack_to && <div className="tree-line tree-line-tight" style={{ color: neutral(62) }}>{ackTitle(item.ack_to)}</div>}
      {delivery(row, fix)}
      {note && <button type="button" className="tree-collapsed" tabIndex={-1} data-weak={highlight === 'weak' || undefined}
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className="ph ph-dots-three" />{note}</button>}
      {answer && <div className="tree-answer" onClick={event => event.stopPropagation()}>{answer}</div>}
    </div>
    <div className="tree-end">
      {row.relatedCount > 0 && <span className="tree-related" role="img" aria-label={`${row.relatedCount} related item${row.relatedCount === 1 ? '' : 's'}`}
        title={`${row.relatedCount} related item${row.relatedCount === 1 ? '' : 's'}`}><i className="ph ph-link" aria-hidden="true" />{row.relatedCount}</span>}
      {row.rounds >= 2 && <span className="tree-round" title="Rounds of back and forth"><i className="ph ph-arrows-clockwise" />Round {row.rounds}</span>}
      {persistent.length > 0 && <span className="tree-ack-slot">{persistent.map(actionButton)}</span>}
      {hover.length > 0 && <span className="tree-actions">{hover.map(actionButton)}</span>}
      <span className="tree-id">{item.id}</span>
      <StatusBadge status={status} label={row.badge} variant="text" />
    </div>
  </div>;
}
