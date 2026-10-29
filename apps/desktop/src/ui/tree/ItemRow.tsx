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
//
// Redraws (alpha.23 F6d): the row is memoised, so it renders only when one of its props changes. Every prop is a value, a row
// object the model keeps while it draws the same (model.ts `reuseRows`), or a callback that never changes (TreeView passes stable
// handles that call its latest code). The row builds its own actions from `stopped`, `ackDisabled` and `run`.
import { memo, useCallback, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { TreeFonts } from './fonts';
import { ItemReference, Markdown, MarkdownHighlight } from '../shared/MarkdownText';
import { shortLabel } from '../shared/short';
import { StatusBadge } from '../shared/StatusBadge';
import { SessionClosedChip } from '../shared/SessionClosedChip';
import { HideIcon } from '../shared/HideIcon';
import { ackRowLabel, ackTitle } from '../shared/ack';
import { STATUS } from '../shared/status';
import { closed, outcomeShown, visual, type ChangeMarker as MarkerKind, type ItemRow as Row } from './model';
import type { MatchField } from './mapSearch';
import { measurePreviewLines } from './clamp';
import { Guides } from './Guides';
import { Boxes, branchStyle } from './BoxSlices';
import { Strip } from './Strip';
import { ChangeMarker } from '../changes/ChangeMarker';
import { useDockInset } from '../shell/dockInset';

interface RowAction { readonly icon: string; readonly title: string; readonly run: () => void; readonly glyph?: ReactNode; readonly disabled?: boolean; readonly persistent?: boolean;
  /** A short word after the icon (the Ack's "→ Done"); the title stays the full tooltip and name. */ readonly label?: string }

/** What a row's buttons ask the Map to do, with the row's item id (TreeView's dispatcher acts on the rows it shows now). */
export type RowCommand = 'ack' | 'reply' | 'followup' | 'note' | 'reopen' | 'bring' | 'later' | 'drop' | 'hide' | 'remove';

/**
 * The row's Ack (when it has one) and its hover bar: always the same six slots in SPEC 6.2's order. A slot that does not apply is
 * greyed and says why; slots 1-4 are all greyed when the agent is not running or the session is archived (D4, `stopped`), and
 * while a message is on its way to the agent.
 */
function rowActions(row: Row, stopped: string | null, ackDisabled: boolean, run: (command: RowCommand, id: string) => void): RowAction[] {
  const item = row.item, list: RowAction[] = [], go = (command: RowCommand) => () => { run(command, item.id); };
  if (row.ack) list.push({ icon: 'ph ph-check', title: ackTitle(row.ack, item.status), label: ackRowLabel(row.ack), persistent: true, disabled: ackDisabled, run: go('ack') });
  const statusLabel = row.later ? 'Later' : STATUS[visual(row.status)].label;
  const open = item.status === 'open', isClosed = closed(item.status);
  // A message already on its way to the agent holds the row's other actions, as before.
  const inFlight = !!row.delivery && !row.delivery.failed && !isClosed;
  const slot = (action: string, applies: boolean, offer: { icon: string; title: string; run: () => void }): RowAction =>
    stopped ? { icon: offer.icon, title: `${action}: ${stopped}`, disabled: true, run: () => {} }
      : !applies ? { icon: offer.icon, title: `${action}: not for ${statusLabel} items`, disabled: true, run: () => {} }
      : inFlight ? { icon: offer.icon, title: `${action}: a message is on its way`, disabled: true, run: () => {} } : offer;
  const reply = item.status === 'waiting_on_me' ? { title: 'Answer (r)', command: 'reply' as const } : isClosed ? { title: 'Follow up (r)', command: 'followup' as const }
    : open ? { title: 'Reply (r)', command: 'reply' as const } : { title: 'Add a note (r)', command: 'note' as const };
  list.push(
    slot(reply.title.replace(/ \(r\)$/, ''), true, { icon: 'ph ph-chat-text', title: reply.title, run: go(reply.command) }),
    isClosed ? slot('Back to Open', item.status !== 'replaced', { icon: 'ph ph-arrow-counter-clockwise', title: 'Back to Open (o)', run: go('reopen') })
      : slot('Bring it up', open, { icon: 'ph ph-megaphone-simple', title: 'Bring it up (b)', run: go('bring') }),
    row.later ? slot('Unpark', true, { icon: 'ph ph-arrow-u-up-left', title: 'Unpark (z)', run: go('later') })
      : slot('Later', open, { icon: 'ph ph-clock', title: 'Later (z)', run: go('later') }),
    slot('Drop', open, { icon: 'ph ph-x-circle', title: 'Drop (d)', run: go('drop') }));
  list.push({ icon: '', glyph: <HideIcon hidden={row.hidden} />, title: row.hidden ? 'Unhide (x)' : 'Hide (x)', run: go('hide') });
  list.push({ icon: 'ph ph-trash', title: 'Remove (⌫)', run: go('remove') });
  return list;
}

const NO_TERMS: readonly string[] = Object.freeze([]);

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
/** A closed row's question and a row's grey preview lines: the text colour at the share that reads at 4.5:1 on every box tint, in both themes. */
const MUTED_QUESTION = 76;

/** Lines of an item's question or preview before "Show more" folds the rest away. */
const CLAMP_LINES = 3;
/** Folding must hide at least this many lines; a text one line over is shown whole. */
const MIN_HIDDEN_LINES = 1;

interface Preview {
  readonly node: ReactNode;
  /** The long text the clamp applies to, if any. */
  readonly text: string | null;
  /** The searched field this preview shows, when it shows one: a match in it lights the preview. */
  readonly field?: 'outcome' | 'note';
}

/** The outer box clips; the inner Markdown keeps its natural height for ResizeObserver. */
function PreviewText({ text }: { readonly text: string }) {
  return <div className="tree-clamp"><Markdown className="tree-clamp-content" text={text} inline /></div>;
}

/** The item's own details under the title, by priority (Item Row.dc.html:68-75). A delivery never takes this place. */
function preview(row: Row): Preview | null {
  const item = row.item;
  if (row.later) return { text: null, node: <div className="tree-line tree-line-tight" style={{ color: neutral(MUTED_QUESTION) }}><i className="ph ph-clock" /><span>Parked for later · still open</span></div> };
  if (item.status === 'waiting_on_me' && item.ask) return { text: item.ask, node: <div className="tree-line tree-ask"><PreviewText text={item.ask} /></div> };
  if (item.status === 'replaced' && row.replacedBy) {
    return { text: null, node: <div className="tree-line" style={{ color: neutral(MUTED_QUESTION) }}><i className="ph ph-arrow-bend-down-right tree-line-small" /><span>Replaced by</span>
      <ItemReference itemId={row.replacedBy.id} className="tree-jump" inline>{row.replacedBy.question}</ItemReference>
      <StatusBadge status={visual(row.replacedBy.status)} variant="text" ink /></div> };
  }
  // The same rule tells the search which outcomes are on the Map (model.ts `outcomeShown`).
  if (outcomeShown(item, row.later, row.replacedBy) && item.outcome) {
    return { text: item.outcome, field: 'outcome', node: <div className="tree-line tree-outcome"><i className="ph ph-arrow-elbow-down-right" style={{ color: `var(--st-${visual(item.status)})` }} />
      <PreviewText text={item.outcome} /></div> };
  }
  if (item.status === 'in_progress' && item.note) {
    return { text: item.note, field: 'note', node: <div className="tree-line tree-line-tight" style={{ color: 'var(--st-progress-ink)' }}><i className="ph ph-robot" /><PreviewText text={item.note} /></div> };
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
  readonly closedReason?: string;
  readonly note: string | null;
  /** Why the agent's slots are greyed ("archived", "the agent is not running"); null while the agent can be asked. */
  readonly stopped: string | null;
  /** The Ack can't be pressed now: a view change or a session action is saving, or this Ack is held. */
  readonly ackDisabled: boolean;
  /** Runs a button's command for this row's item. Stable: the Map dispatches it on the rows it shows when pressed. */
  readonly run: (command: RowCommand, id: string) => void;
  /** The search's current match, when it is on this row: which field holds it. */
  readonly current?: MatchField | null;
  /** The search's words, when this row holds a match: the outcome's highlight marks them. */
  readonly terms?: readonly string[];
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

export const ItemRow = memo(function ItemRow({ row, selected, focused, changeMarker, nextUnseen, nextUnseenPulse, closedReason, note, stopped, ackDisabled, run, current = null, terms = NO_TERMS, unfolded, onUnfold, remember, onFocus, onKeyDown, onSelect, onToggle, acked = false, onUndoAck, onPeekHover, onPeekLeave }: ItemRowProps) {
  const item = row.item, status = visual(row.status);
  const details = preview(row);
  // A note match shows on the In progress preview when the row draws one; any other row names it with the "In notes" tag.
  const showsNoteTag = row.matches.includes('note') && details?.field !== 'note';
  const muted = closed(item.status) || row.context || row.later || row.hidden;
  const actions = rowActions(row, stopped, ackDisabled, run);
  const actionButton = (action: RowAction) => {
    const button = <button key={action.title} type="button" tabIndex={action.persistent ? 0 : -1}
      className={`tree-action${action.persistent ? ' tree-action-ack' : ''}`} title={action.title} aria-label={action.title} disabled={action.disabled}
      data-labelled={action.label ? '' : undefined}
      onClick={event => { event.stopPropagation(); action.run(); }}>{action.glyph ?? <i className={action.icon} />}{action.label && <span className="tree-action-label">{action.label}</span>}</button>;
    // A greyed hover-bar button swallows clicks, and the floating bar can sit over the middle of a narrow row. The wrapper
    // (the button ignores the pointer, tree-rows.css) keeps the tooltip and lets that click through to select the row.
    return action.disabled && !action.persistent ? <span key={action.title} className="tree-action-off" title={action.title}>{button}</span> : button;
  };
  const persistent = actions.filter(action => action.persistent), hover = actions.filter(action => !action.persistent);
  const bar = useRef<HTMLSpanElement>(null), dockInset = useDockInset();
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={row.depth + 1} aria-selected={selected}
    aria-expanded={row.hasKids ? row.expanded : undefined} tabIndex={focused ? 0 : -1} className={`tree-row tree-item ${row.depth === 1 ? 'tree-item-root' : 'tree-item-child'}${row.hidden ? ' tree-item-hidden' : ''}`}
    data-open={unfolded || undefined} data-item-id={item.id} data-row={row.key} data-branch={row.branch}
    data-next-unseen={nextUnseen || undefined} data-next-unseen-pulse={nextUnseenPulse || undefined}
    style={branchStyle(row.branch, row.depth)} onFocus={(event: FocusEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) { placeActions(event.currentTarget, bar.current, dockInset); onFocus(row.key); } }}
    onKeyDown={onKeyDown} onClick={() => onSelect(item.id)} onMouseEnter={event => { placeActions(event.currentTarget, bar.current, dockInset); onPeekHover?.(item.id, event); }}
    onMouseMove={event => { placeActions(event.currentTarget, bar.current, dockInset); onPeekHover?.(item.id, event); }} onMouseLeave={() => onPeekLeave?.()}>
    <Boxes boxes={row.boxes} />
    {selected && <span aria-hidden="true" className="tree-selected-box" data-testid="selected-box" />}
    <Guides guides={row.guides} />
    {row.hasKids
      ? <button type="button" className="tree-chevron" tabIndex={-1} aria-label="Expand or collapse"
        onClick={event => { event.stopPropagation(); onToggle(item.id); }}><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></button>
      : <span className="tree-chevron-space" />}
    <span className="tree-icon"><StatusBadge status={status} variant="icon" /></span>
    <div className="tree-body">
      {/* One unfold flag opens the question and the details together; each folds at three lines when that hides a line. */}
      <div className="tree-heading"><ClampBlock className="tree-preview tree-question-block" text={item.question} open={unfolded} onToggle={() => onUnfold(item.id)}>
        <div className="tree-clamp"><div className="tree-question tree-clamp-content" style={{ color: muted ? neutral(MUTED_QUESTION) : 'var(--color-text)' }}>
          {row.segments.map((segment, index) => <span key={index} className={segment.hit ? 'tree-hit' : undefined}
            data-current={segment.hit && current === 'question' || undefined}>{segment.text}</span>)}
        </div></div>
      </ClampBlock></div>
      <MarkdownHighlight.Provider value={details?.field && row.matches.includes(details.field) ? { terms, current: current === details.field } : null}>
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
    <div className={`tree-end${persistent.some(action => action.label) ? ' tree-end-labelled' : ''}`}>
      {showsNoteTag && <span className="tree-note-hit" title="The search matches this item's notes" data-current={current === 'note' || undefined}><i className="ph ph-file-text" aria-hidden="true" />In notes</span>}
      {row.outside && <span className="tree-outside-tag" title="Outside your filter"><i className="ph ph-funnel" aria-hidden="true" />Outside filter</span>}
      <span className="tree-end-slot tree-end-marker" data-marker={changeMarker}>
        {changeMarker && <ChangeMarker kind={changeMarker} />}
      </span>
      {/* A closed session's chip takes the badge's place and its width, so the cluster never widens. */}
      <span className="tree-end-slot tree-end-badge">
        {row.sessionClosed ? <SessionClosedChip reason={closedReason} /> : <StatusBadge status={status} label={row.badge} variant="text" ink />}
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
});
