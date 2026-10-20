// "Item Row" of the handoff (Item Row.dc.html): guides and the accent thread,
// the status icon, the question with search hits, the item's details (folded to
// four lines, with Show more) and under them the delivery of the owner's latest
// message and the collapsed note.
//
// Layout contract (alpha.20, C4): a row's height and its text's width depend only on its text and the Map's width. The
// marker, the session-closed chip, the status badge, the related count and Ack sit in the end cluster, each in a slot that
// keeps its width whether or not it is filled (tree.css, `.tree-end`), so a marker clearing, an Ack landing or a status
// changing never rewraps the row. Selection is a background and the hover bar floats (absolute): just above the row's top
// edge, right-aligned, or just below the row where nothing is above it, or inside a row taller than the window (alpha.22).
// It never covers the row's own text.
import { useCallback, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { TreeFonts } from './fonts';
import { ItemReference, Markdown, MarkdownHighlight } from '../shared/MarkdownText';
import { shortLabel } from '../shared/short';
import { StatusBadge } from '../shared/StatusBadge';
import { SessionClosedChip } from '../shared/SessionClosedChip';
import { closed, outcomeShown, visual, type ChangeMarker as MarkerKind, type ItemRow as Row } from './model';
import { useMapSearch } from './mapSearch';
import { measurePreviewLines } from './clamp';
import { Guides } from './Guides';
import { Boxes, branchStyle } from './BoxSlices';
import { Strip } from './Strip';
import { ChangeMarker } from '../changes/ChangeMarker';
import { useDockInset } from '../shell/dockInset';

export interface RowAction { readonly icon: string; readonly title: string; readonly run: () => void; readonly glyph?: ReactNode; readonly disabled?: boolean; readonly persistent?: boolean }

/** How far the hover bar reaches above a row's top edge (tree.css `.tree-actions`): with less room than this above, it floats below. */
const BAR_ROOM = 24;

/**
 * Which side of the row the hover bar floats on: above, unless the sticky topic band or the top of the Map or window is closer than
 * the bar's reach (the first row under the band); then below, unless the row's bottom is as close to the Map's or window's bottom
 * or to the answer dock that covers it (`inset`, a row taller than the window); then inside the row, in the empty column under its
 * end cluster, below the first line, so the bar is always on screen and still never covers text. Above or below, the bar ends where
 * the end cluster begins (the leftmost cluster edge of this row and of the row it floats over), so it never covers a row's Ack,
 * status pill or related count. Written straight to the bar, so no render and no layout depends on it.
 */
export function placeActions(row: HTMLElement, bar: HTMLElement | null, inset = 0) {
  if (!bar) return;
  const band = row.closest('.tree-topic-group')?.querySelector('.tree-topic')?.getBoundingClientRect().bottom ?? -Infinity;
  const top = row.closest('.tree-scroll')?.getBoundingClientRect().top ?? -Infinity;
  const bottom = Math.min(row.closest('.tree-scroll')?.getBoundingClientRect().bottom ?? Infinity, window.innerHeight) - inset;
  const floor = Math.max(band, top, 0), rect = row.getBoundingClientRect();
  const side = rect.top - floor >= BAR_ROOM ? 'above' : bottom - rect.bottom >= BAR_ROOM ? 'below' : 'inside';
  if (bar.dataset.side !== side) bar.dataset.side = side;
  if (side === 'inside') {
    bar.style.removeProperty('right');
    const cluster = row.querySelector('.tree-end')?.getBoundingClientRect().bottom ?? rect.top;
    bar.style.top = `${Math.max(floor, cluster) - rect.top + 4}px`;
    return;
  }
  bar.style.removeProperty('top');
  const next = side === 'above' ? row.previousElementSibling : row.nextElementSibling;
  const lefts = [row, next?.matches('.tree-item') ? next : null]
    .map(element => element?.querySelector('.tree-end')?.getBoundingClientRect().left).filter((left): left is number => left !== undefined);
  if (lefts.length === 0) { bar.style.removeProperty('right'); return; }
  const right = `${Math.max(0, rect.right - Math.min(...lefts))}px`;
  if (bar.style.right !== right) bar.style.right = right;
}

const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;

/** Lines of an item's question or preview before "Show more" folds the rest away. */
const CLAMP_LINES = 3;
/** Folding must hide at least this many lines; a text one line over is shown whole. */
const MIN_HIDDEN_LINES = 1;

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
  // The same rule tells the search which outcomes are on the Map (model.ts `outcomeShown`).
  if (outcomeShown(item, row.later, row.replacedBy) && item.outcome) {
    return { text: item.outcome, node: <div className="tree-line tree-outcome"><i className="ph ph-arrow-elbow-down-right" style={{ color: `var(--st-${visual(item.status)})` }} />
      <PreviewText text={item.outcome} /></div> };
  }
  if (item.status === 'in_progress' && item.note) {
    return { text: item.note, node: <div className="tree-line tree-line-tight" style={{ color: 'var(--st-progress)' }}><i className="ph ph-robot" /><PreviewText text={item.note} /></div> };
  }
  return null;
}

/** The delivery of the owner's latest message, as a small line under the details. A stuck one is fixed in Details (StuckNote), not here. */
function delivery(row: Row): ReactNode {
  const value = row.delivery;
  if (!value) return null;
  return <div className="tree-line tree-delivery" style={{ color: value.color }}><i className={value.icon} /><span>{value.text}</span></div>;
}

/**
 * Clamp a text block (the question, or the details under it) only when folding hides at least MIN_HIDDEN_LINES lines.
 * The block holds one `.tree-clamp` that is measured; the item's one unfold flag opens every block of the row together.
 */
function ClampBlock({ text, open, onToggle, className = 'tree-preview', children }: {
  text: string | null | undefined; open: boolean; onToggle: () => void; className?: string; children: ReactNode;
}) {
  const fonts = useContext(TreeFonts);
  const box = useRef<HTMLDivElement>(null);
  const [clamp, setClamp] = useState({ lines: 0, height: 0 });
  const long = clamp.lines >= CLAMP_LINES + MIN_HIDDEN_LINES;
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
  return <div ref={box} className={className} data-open={open || undefined} data-clamped={long && !open || undefined}
    style={{ '--tree-clamp': CLAMP_LINES, '--tree-clamp-height': `${clamp.height}px` } as CSSProperties}
    onFocus={event => { if (long && !open && event.target.closest('.tree-clamp') && event.target.matches(':focus-visible')) onToggle(); }}>
    {children}
    {long && <button type="button" className="tree-more" aria-expanded={open}
      onClick={event => { event.stopPropagation(); onToggle(); }}>{open ? 'Show less' : 'Show more'}</button>}
  </div>;
}

export interface ItemRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly changeMarker?: MarkerKind;
  /** The last N target keeps its outline after its brief arrival pulse. */
  readonly nextUnseen?: boolean;
  readonly nextUnseenPulse?: boolean;
  /** Selection is held while a view write is unconfirmed. */
  readonly disabled?: boolean;
  readonly closedReason?: string;
  readonly note: string | null;
  readonly actions: readonly RowAction[];
  /** The long preview is shown in full ("Show less" offered) instead of folded to three lines. */
  readonly unfolded: boolean;
  readonly onUnfold: (id: string) => void;
  readonly remember: (key: string, element: HTMLDivElement | null) => void;
  readonly onFocus: (key: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string) => void;
  /** The item's Ack sits in its 6 s hold: the row shows "✓ Acked · Undo" over the area left of the Ack slot (D11). */
  readonly acked?: boolean;
  readonly onUndoAck?: (id: string) => void;
  readonly onPeekHover?: (id: string, event: MouseEvent<HTMLDivElement>) => void;
  readonly onPeekLeave?: () => void;
}

export function ItemRow({ row, selected, focused, changeMarker, nextUnseen, nextUnseenPulse, disabled = false, closedReason, note, actions, unfolded, onUnfold, remember, onFocus, onKeyDown, onSelect, onToggle, acked = false, onUndoAck, onPeekHover, onPeekLeave }: ItemRowProps) {
  const item = row.item, status = visual(row.status);
  const details = preview(row);
  const muted = closed(item.status) || row.context || row.later || row.hidden;
  const search = useMapSearch(), current = search.current?.id === item.id ? search.current.field : null;
  const actionButton = (action: RowAction) => {
    const button = <button key={action.title} type="button" tabIndex={action.persistent ? 0 : -1}
      className={`tree-action${action.persistent ? ' tree-action-ack' : ''}`} title={action.title} aria-label={action.title} disabled={action.disabled}
      onClick={event => { event.stopPropagation(); action.run(); }}>{action.glyph ?? <i className={action.icon} />}</button>;
    // A greyed hover-bar button swallows clicks, and the floating bar can sit over the middle of a narrow row. The wrapper
    // (the button ignores the pointer, tree-rows.css) keeps the tooltip and lets that click through to select the row.
    return action.disabled && !action.persistent ? <span key={action.title} className="tree-action-off" title={action.title}>{button}</span> : button;
  };
  const persistent = actions.filter(action => action.persistent), hover = actions.filter(action => !action.persistent);
  const bar = useRef<HTMLSpanElement>(null), dockInset = useDockInset();
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1} aria-selected={selected} aria-disabled={disabled || undefined}
    aria-expanded={row.hasKids ? row.expanded : undefined} tabIndex={focused ? 0 : -1} className={`tree-row tree-item ${row.depth === 1 ? 'tree-item-root' : 'tree-item-child'}${row.hidden ? ' tree-item-hidden' : ''}`}
    data-open={unfolded || undefined} data-item-id={item.id} data-row={row.key} data-branch={row.branch}
    data-next-unseen={nextUnseen || undefined} data-next-unseen-pulse={nextUnseenPulse || undefined}
    style={branchStyle(row.branch, row.depth)} onFocus={(event: FocusEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) { placeActions(event.currentTarget, bar.current, dockInset); onFocus(row.key); } }}
    onKeyDown={onKeyDown} onClick={() => onSelect(item.id)} onMouseEnter={event => { placeActions(event.currentTarget, bar.current, dockInset); onPeekHover?.(item.id, event); }}
    onMouseMove={event => { placeActions(event.currentTarget, bar.current, dockInset); onPeekHover?.(item.id, event); }} onMouseLeave={() => onPeekLeave?.()}>
    <Boxes boxes={row.boxes} />
    {selected && <span aria-hidden="true" className="tree-selected-box" />}
    <Guides guides={row.guides} />
    {row.hasKids
      ? <button type="button" className="tree-chevron" tabIndex={-1} aria-label="Expand or collapse"
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></button>
      : <span className="tree-chevron-space" />}
    <span className="tree-icon"><StatusBadge status={status} variant="icon" /></span>
    <div className="tree-body">
      {/* One unfold flag opens the question and the details together; each folds at three lines when that hides a line. */}
      <div className="tree-heading"><ClampBlock className="tree-preview tree-question-block" text={item.question} open={unfolded} onToggle={() => onUnfold(item.id)}>
        <div className="tree-clamp"><div className="tree-question tree-clamp-content" style={{ color: muted ? neutral(64) : 'var(--color-text)' }}>
          {row.segments.map((segment, index) => <span key={index} className={segment.hit ? 'tree-hit' : undefined}
            data-current={segment.hit && current === 'question' || undefined}>{segment.text}</span>)}
        </div></div>
      </ClampBlock></div>
      <MarkdownHighlight.Provider value={row.matches.includes('outcome') ? { terms: search.terms, current: current === 'outcome' } : null}>
        <ClampBlock text={details?.text} open={unfolded} onToggle={() => onUnfold(item.id)}>{details?.node}</ClampBlock>
      </MarkdownHighlight.Provider>
      {delivery(row)}
      {note && <Strip variant="inside" text={note} depth={row.depth} onClick={() => onToggle(item.id)} />}
    </div>
    {/* The hover bar floats against the row itself (absolute), above its top edge or, with no room above, below its bottom
        edge, so it never covers the row's text and showing it never moves or rewraps anything. It is inside the row, so
        moving the pointer from the row onto it keeps the row hovered. */}
    {hover.length > 0 && <span ref={bar} className="tree-actions" data-side="above">{hover.map(actionButton)}</span>}
    {/* The end cluster, in the board's order. Every slot keeps its width filled or empty (tree.css `.tree-end`). */}
    <div className="tree-end">
      {row.outside && <span className="tree-outside-tag" title="Outside your filter"><i className="ph ph-funnel" aria-hidden="true" />Outside filter</span>}
      <span className="tree-end-slot tree-end-marker" data-marker={changeMarker}>
        {changeMarker && <ChangeMarker kind={changeMarker} />}
      </span>
      {/* A closed session's chip takes the badge's place and its width, so the cluster never widens. */}
      <span className="tree-end-slot tree-end-badge">
        {row.sessionClosed ? <SessionClosedChip reason={closedReason} /> : <StatusBadge status={status} label={row.badge} variant="text" />}
      </span>
      <span className="tree-end-slot tree-end-related">
        {row.relatedCount > 0 && <span className="tree-related" role="img" aria-label={`${row.relatedCount} related item${row.relatedCount === 1 ? '' : 's'}`}
          title={`${row.relatedCount} related item${row.relatedCount === 1 ? '' : 's'}`}><i className="ph ph-link" aria-hidden="true" />{row.relatedCount}</span>}
      </span>
      <span className="tree-end-slot tree-ack-slot">{!acked && persistent.map(actionButton)}</span>
      {/* The held Ack: drawn over the area left of the Ack slot, so the row never rewraps. */}
      {acked && <span className="tree-acked" role="status"><i className="ph ph-check" aria-hidden="true" />Acked<span aria-hidden="true">·</span>
        <button type="button" className="tree-acked-undo" aria-label={`Undo Ack of ${shortLabel(item)}`} tabIndex={-1}
          onClick={event => { event.stopPropagation(); onUndoAck?.(item.id); }}>Undo</button></span>}
    </div>
  </div>;
}
