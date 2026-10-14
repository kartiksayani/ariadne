// "Item Row" of the handoff (Item Row.dc.html): guides and the accent thread,
// the status icon, the question with search hits, the item's details (folded to
// four lines, with Show more) and under them the delivery of the owner's latest
// message, the collapsed note, the inline answer box, the round tag, hover actions, the
// top-line text badge.
import { useCallback, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { TreeFonts } from './fonts';
import { ItemReference, Markdown } from '../shared/MarkdownText';
import { shortLabel } from '../shared/short';
import { StatusBadge } from '../shared/StatusBadge';
import { ackTitle } from '../shared/ack';
import { SessionClosedChip } from '../shared/SessionClosedChip';
import { closed, visual, type ChangeMarker, type Guide, type ItemRow as Row } from './model';
import { measurePreviewLines } from './clamp';

export interface RowAction { readonly icon: string; readonly title: string; readonly run: () => void; readonly glyph?: ReactNode; readonly disabled?: boolean; readonly persistent?: boolean }

const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;

export function Guides({ guides }: { guides: readonly Guide[] }) {
  return <>{guides.map((guide, index) => {
    const color = guide.on ? 'var(--color-accent)' : 'var(--a-guide)', stroke = guide.on ? '1.5px' : '1px';
    return guide.kind === 'line'
      ? <div key={index} aria-hidden="true" className="tree-guide" data-from-bullet={guide.fromBullet || undefined} data-to-bullet={guide.toBullet || undefined}
        style={{ left: guide.x, width: stroke, background: color }} />
      : <div key={index} aria-hidden="true" className="tree-elbow" style={{ left: guide.x, width: guide.width, borderBottom: `${stroke} solid ${color}` }} />;
  })}</>;
}

/** Lines of an item's preview before "Show more" folds the rest away. */
const CLAMP_LINES = 4;
const MIN_HIDDEN_LINES = 3;

interface Preview { readonly node: ReactNode; /** The long text the clamp applies to, if any. */ readonly text: string | null }

/** The outer box clips; the inner Markdown keeps its natural height for ResizeObserver. */
function PreviewText({ text }: { readonly text: string }) {
  return <div className="tree-clamp"><Markdown className="tree-clamp-content" text={text} inline /></div>;
}

/** The item's own details under the title, by priority (Item Row.dc.html:68-75). A delivery never takes this place. */
function preview(row: Row): Preview | null {
  const item = row.item;
  if (row.later) return { text: null, node: <div className="tree-line tree-line-tight" style={{ color: neutral(62) }}><i className="ph ph-clock" /><span>Parked for later · still open</span></div> };
  if (item.status === 'waiting_on_me' && item.ask) return { text: item.ask, node: <div className="tree-line tree-ask"><PreviewText text={item.ask} /></div> };
  if (item.status === 'replaced' && row.replacedBy) {
    return { text: null, node: <div className="tree-line" style={{ color: neutral(66) }}><i className="ph ph-arrow-bend-down-right tree-line-small" /><span>Replaced by</span>
      <ItemReference itemId={row.replacedBy.id} className="tree-jump" inline>{row.replacedBy.question}</ItemReference>
      <StatusBadge status={visual(row.replacedBy.status)} variant="text" /></div> };
  }
  if ((closed(item.status) || item.status === 'open' || item.status === 'in_progress') && item.outcome) {
    return { text: item.outcome, node: <div className="tree-line tree-outcome"><i className="ph ph-arrow-elbow-down-right" style={{ color: `var(--st-${visual(item.status)})` }} />
      <PreviewText text={item.outcome} /></div> };
  }
  if (item.status === 'in_progress' && item.note) {
    return { text: item.note, node: <div className="tree-line tree-line-tight" style={{ color: 'var(--st-progress)' }}><i className="ph ph-robot" /><PreviewText text={item.note} /></div> };
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

/** Clamp the body only when folding hides at least three lines. */
function PreviewBlock({ value, open, onToggle }: { value: Preview | null; open: boolean; onToggle: () => void }) {
  const fonts = useContext(TreeFonts);
  const box = useRef<HTMLDivElement>(null);
  const [clamp, setClamp] = useState({ lines: 0, height: 0 });
  const long = clamp.lines >= CLAMP_LINES + MIN_HIDDEN_LINES;
  const text = value?.text;
  const measure = useCallback(() => {
    const excerpt = text == null ? null : box.current?.querySelector<HTMLElement>('.tree-clamp');
    const next = excerpt ? measurePreviewLines(excerpt, CLAMP_LINES) : { lines: 0, height: 0 };
    setClamp(previous => previous.lines === next.lines && previous.height === next.height ? previous : next);
  }, [text]);
  useLayoutEffect(() => { measure(); }, [measure, fonts]);
  useLayoutEffect(() => {
    const excerpt = text == null ? null : box.current?.querySelector<HTMLElement>('.tree-clamp');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (excerpt) observer?.observe(excerpt);
    const content = excerpt?.querySelector<HTMLElement>('.tree-clamp-content');
    if (content) observer?.observe(content);
    return () => { observer?.disconnect(); };
  }, [text, measure]);
  return <div ref={box} className="tree-preview" data-open={open || undefined} data-clamped={long && !open || undefined}
    style={{ '--tree-clamp': CLAMP_LINES, '--tree-clamp-height': `${clamp.height}px` } as CSSProperties}
    onFocus={event => { if (long && !open && event.target.closest('.tree-clamp') && event.target.matches(':focus-visible')) onToggle(); }}>
    {value?.node}
    {long && <button type="button" className="tree-more" aria-expanded={open}
      onClick={event => { event.stopPropagation(); onToggle(); }}>{open ? 'Show less' : 'Show more'}</button>}
  </div>;
}

export interface ItemRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly changeMarker?: ChangeMarker;
  /** The last N target keeps its outline after its brief arrival pulse. */
  readonly nextUnseen?: boolean;
  readonly nextUnseenPulse?: boolean;
  /** Selection is held while a view write is unconfirmed. */
  readonly disabled?: boolean;
  readonly closedReason?: string;
  readonly note: string | null;
  readonly actions: readonly RowAction[];
  readonly answer: ReactNode;
  /** A stopped delivery's inline fix (ui/answer/StuckNote); it takes the delivery line's place. */
  readonly fix?: ReactNode;
  /** The long preview is shown in full ("Show less" offered) instead of folded to four lines. */
  readonly unfolded: boolean;
  readonly onUnfold: (id: string) => void;
  readonly remember: (key: string, element: HTMLDivElement | null) => void;
  readonly onFocus: (key: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string) => void;
  /** Enters Focus on a top-level item; null leaves it. */
  readonly onFocusBranch?: (id: string | null) => void;
  /** This top-level item is the one Focus is on: its button reads Unfocus. */
  readonly branchFocused?: boolean;
  readonly names?: ReadonlyMap<string, string>;
  readonly onPeekHover?: (id: string, event: MouseEvent<HTMLDivElement>) => void;
  readonly onPeekLeave?: () => void;
}

export function ItemRow({ row, selected, focused, changeMarker, nextUnseen, nextUnseenPulse, disabled = false, closedReason, note, actions, answer, fix, unfolded, onUnfold, remember, onFocus, onKeyDown, onSelect, onToggle, onFocusBranch, branchFocused = false, names, onPeekHover, onPeekLeave }: ItemRowProps) {
  const item = row.item, status = visual(row.status);
  const details = preview(row);
  const muted = closed(item.status) || row.context || row.later || row.hidden;
  const actionButton = (action: RowAction) => <button key={action.title} type="button" tabIndex={action.persistent ? 0 : -1}
    className={`tree-action${action.persistent ? ' tree-action-ack' : ''}`} title={action.title} aria-label={action.title} disabled={action.disabled}
    onClick={event => { event.stopPropagation(); action.run(); }}>{action.glyph ?? <i className={action.icon} />}</button>;
  const persistent = actions.filter(action => action.persistent), hover = actions.filter(action => !action.persistent);
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1} aria-selected={selected} aria-disabled={disabled || undefined}
    aria-expanded={row.hasKids ? row.expanded : undefined} tabIndex={focused ? 0 : -1} className={`tree-row tree-item ${row.depth === 1 ? 'tree-item-root' : 'tree-item-child'}${row.hidden ? ' tree-item-hidden' : ''}`}
    data-open={unfolded || undefined} data-item-id={item.id} data-row={row.key}
    data-next-unseen={nextUnseen || undefined} data-next-unseen-pulse={nextUnseenPulse || undefined}
    style={{ paddingLeft: 12 + row.depth * 24 }} onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }}
    onKeyDown={onKeyDown} onClick={() => onSelect(item.id)} onMouseEnter={event => onPeekHover?.(item.id, event)}
    onMouseMove={event => onPeekHover?.(item.id, event)} onMouseLeave={() => onPeekLeave?.()}>
    {row.hue !== undefined && <span aria-hidden="true" className="tree-top-colour" style={{ background: `hsl(${row.hue} 48% 58%)` }} />}
    <Guides guides={row.guides} />
    {row.hasKids
      ? <button type="button" className="tree-chevron" tabIndex={-1} aria-label="Expand or collapse"
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></button>
      : <span className="tree-chevron-space" />}
    <span className="tree-icon" onDoubleClick={event => { if (!disabled && !item.parent && onFocusBranch) { event.stopPropagation(); onFocusBranch(branchFocused ? null : item.id); } }}><StatusBadge status={status} variant="icon" /></span>
    <div className="tree-body">
      <div className="tree-heading"><div className="tree-question" style={{ color: muted ? neutral(64) : 'var(--color-text)' }}>
        {row.segments.map((segment, index) => <span key={index} className={segment.hit ? 'tree-hit' : undefined}>{segment.text}</span>)}
      </div><span className="tree-row-status">
        {changeMarker && <span className={`tree-change-marker tree-change-${changeMarker}`} role="img"
          aria-label={changeMarker === 'new' ? 'New to you' : 'Changed since you read it'} title={changeMarker === 'new' ? 'New to you' : 'Changed since you read it'}>
          {changeMarker === 'new' ? 'New' : null}</span>}
        {row.sessionClosed && <SessionClosedChip reason={closedReason} />}
        <StatusBadge status={status} label={row.badge} variant="text" /></span></div>
      <PreviewBlock value={details} open={unfolded} onToggle={() => onUnfold(item.id)} />
      {!item.parent && onFocusBranch && <button type="button" className="tree-focus-action" tabIndex={-1} disabled={disabled}
        aria-label={`${branchFocused ? 'Unfocus' : 'Focus on'} ${names?.get(item.id) ?? shortLabel(item)}`}
        onClick={event => { event.stopPropagation(); onFocusBranch(branchFocused ? null : item.id); }}>{branchFocused ? 'Unfocus' : 'Focus'}</button>}
      {row.ack && <div className="tree-line tree-line-tight" style={{ color: neutral(62) }}>{ackTitle(row.ack, item.status)}</div>}
      {delivery(row, fix)}
      {note && <button type="button" className="tree-collapsed" tabIndex={-1}
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className="ph ph-dots-three" />{note}</button>}
      {answer && <div className="tree-answer" onClick={event => event.stopPropagation()}>{answer}</div>}
    </div>
    <div className="tree-end">
      {row.relatedCount > 0 && <span className="tree-related" role="img" aria-label={`${row.relatedCount} related item${row.relatedCount === 1 ? '' : 's'}`}
        title={`${row.relatedCount} related item${row.relatedCount === 1 ? '' : 's'}`}><i className="ph ph-link" aria-hidden="true" />{row.relatedCount}</span>}
      {row.rounds >= 2 && <span className="tree-round" title="Rounds of back and forth"><i className="ph ph-arrows-clockwise" />Round {row.rounds}</span>}
      {actions.length > 0 && <span className="tree-action-grid">
        {persistent.length > 0 && <span className="tree-ack-slot">{persistent.map(actionButton)}</span>}
        {hover.length > 0 && <span className="tree-actions">{hover.map(actionButton)}</span>}
      </span>}
    </div>
  </div>;
}
