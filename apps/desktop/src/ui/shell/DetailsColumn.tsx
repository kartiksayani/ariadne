import { useContext, useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ItemHistoryContext } from './itemHistory';
import { useDockInset } from './dockInset';
import { SideCovered } from './sideCovered';
import { useDetailsColumn, useDetailsRange } from '../../state/details/column';
import { HideIcon } from '../shared/HideIcon';

export interface DetailsColumnProps {
  /** The column's content: the item's details. */
  readonly children: ReactNode;
  /** The column header's breadcrumb. */
  readonly path?: ReactNode;
  /** The item's status icon (and its New marker), shown in the rail while Details is folded. */
  readonly rail?: ReactNode;
  readonly onClose?: () => void;
  readonly onRemove?: () => void;
  readonly hidden?: boolean;
  readonly hiddenNotice?: string;
  readonly onHide?: () => void;
}

const STEP = 16;

/**
 * The Details column, in the shell's side slot: the resize edge, the head (history, path, Hide, Remove, Fold, Close) and the
 * scroll area, or the 36px rail it folds to. Its width and fold come from `useDetailsColumn` (C9); the shell body lays the
 * column out at that width. The dock floats over the bottom of the window, so the column leaves the dock's height free at
 * its bottom and its composer sits above the dock.
 */
export function DetailsColumn({ children, path, rail, onClose, onRemove, hidden = false, hiddenNotice, onHide }: DetailsColumnProps) {
  const history = useContext(ItemHistoryContext);
  const covered = useContext(SideCovered);
  const column = useDetailsColumn(), range = useDetailsRange();
  const inset = useDockInset();
  const start = useRef<{ x: number; width: number } | null>(null);
  const railButton = useRef<HTMLButtonElement>(null), foldButton = useRef<HTMLButtonElement>(null);
  // Folding and unfolding by the owner move focus to the control that replaces the one they used.
  const moved = useRef(false), shown = useRef(column.folded);
  useEffect(() => {
    if (shown.current === column.folded) return;
    shown.current = column.folded;
    if (moved.current) (column.folded ? railButton : foldButton).current?.focus();
    moved.current = false;
  }, [column.folded]);
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { x: event.clientX, width: column.width };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) column.setWidth(start.current.width + start.current.x - event.clientX);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    start.current = null;
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowLeft' ? column.width + STEP : event.key === 'ArrowRight' ? column.width - STEP
      : event.key === 'Home' ? range.min : event.key === 'End' ? range.max : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    column.setWidth(next);
  };
  const change = (fold: boolean) => { moved.current = true; if (fold) column.fold(); else column.unfold(); };
  const inertAside = covered || undefined;
  const folded = column.folded;
  return <aside className={`shell-detail${hidden ? ' shell-detail-hidden' : ''}${folded ? ' shell-detail-folded' : ''}`} aria-label="Item detail"
    style={{ paddingBottom: inset }} inert={inertAside} aria-hidden={inertAside}>
    {/* Folded, the content stays mounted at its open width, out of sight and reach, so typed text and scroll positions survive. */}
    <div className="shell-detail-body" style={folded ? { width: column.width } : undefined} inert={folded || undefined} aria-hidden={folded || undefined}>
      <div className="shell-detail-resize" role="separator" aria-orientation="vertical" aria-label="Resize detail panel"
        aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={column.width} tabIndex={folded ? -1 : 0}
        title="Drag to change the width of Details. Ariadne remembers it."
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={keyDown}
        onDoubleClick={() => column.setWidth(range.standard)} />
      <div className="shell-detail-head">
        {history && <div className="shell-detail-history" role="group" aria-label="Item navigation">
          <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Back (⌘[)" aria-label="Back"
            disabled={!history.canBack} onClick={history.back}><i className="ph ph-arrow-left" aria-hidden="true" /></button>
          <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Forward (⌘])" aria-label="Forward"
            disabled={!history.canForward} onClick={history.forward}><i className="ph ph-arrow-right" aria-hidden="true" /></button>
        </div>}
        <div className="shell-detail-path">
          <div className="shell-detail-path-content" aria-hidden={hidden || undefined} inert={hidden || undefined}>{path}</div>
          {hidden && <div className="shell-detail-hidden-notice" role="status">
            <span title={hiddenNotice ?? 'Hidden — this item is hidden from the list.'}>{hiddenNotice ?? 'Hidden — this item is hidden from the list.'}</span>
            {onHide && <button type="button" className="btn btn-ghost" title={hiddenNotice ? 'Unhide this item and its hidden parents' : 'Unhide'} onClick={onHide}>Unhide</button>}
          </div>}
        </div>
        {onHide && <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title={hidden ? hiddenNotice ? 'Unhide this item and its hidden parents' : 'Unhide' : 'Hide (x)'}
          aria-label={hidden ? 'Unhide item' : 'Hide item'} aria-pressed={hidden} onClick={onHide}><HideIcon /></button>}
        <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Remove (⌫)" aria-label="Remove item" onClick={onRemove}>
          <i className="ph ph-trash" aria-hidden="true" /></button>
        <button ref={foldButton} type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Fold Details" aria-label="Fold Details" onClick={() => change(true)}>
          <i className="ph ph-caret-double-right" aria-hidden="true" /></button>
        <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Close (Esc)" aria-label="Close detail" onClick={onClose}>
          <i className="ph ph-x" aria-hidden="true" /></button>
      </div>
      <div className="shell-detail-scroll">{children}</div>
    </div>
    {folded && <button ref={railButton} type="button" className="shell-detail-rail" title="Show Details" aria-label="Show Details" onClick={() => change(false)}>
      <i className="ph ph-caret-double-left" aria-hidden="true" />{rail}<span className="shell-detail-rail-label">Details</span></button>}
  </aside>;
}
