import { useContext, useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { DetailHead, type DetailHeadControls } from './DetailHead';
import { useDockInset } from './dockInset';
import { SideCovered } from './sideCovered';
import { useDetailsColumn, useDetailsRange } from '../../state/details/column';

export interface DetailsColumnProps {
  /** The column's content: the item's details. */
  readonly children: ReactNode;
  /** The column header's breadcrumb. */
  readonly path?: ReactNode;
  /** The item's status icon (and its New marker), shown in the rail while Details is folded. */
  readonly rail?: ReactNode;
  /** The head's Read, Focus and "…" controls; none, the head shows the path and Fold only. */
  readonly head?: DetailHeadControls;
  /** The item is hidden from the Map: its title reads dimmed. "Unhide" is in the head's "…". */
  readonly hidden?: boolean;
}

const STEP = 16;

/**
 * The Details column, in the shell's side slot: the resize edge, the head (path, history, Read, Focus, "…", Fold) and the
 * scroll area, or the 36px rail it folds to. Its width and fold come from `useDetailsColumn` (C9); the shell body lays the
 * column out at that width. The dock floats over the bottom of the window, so the column leaves the dock's height free at
 * its bottom and its composer sits above the dock.
 */
export function DetailsColumn({ children, path, rail, head, hidden = false }: DetailsColumnProps) {
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
      <DetailHead path={path} hidden={hidden} {...head} fold={<button ref={foldButton} type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Fold Details"
        aria-label="Fold Details" onClick={() => change(true)}><i className="ph ph-caret-double-right" aria-hidden="true" /></button>} />
      <div className="shell-detail-scroll">{children}</div>
    </div>
    {folded && <button ref={railButton} type="button" className="shell-detail-rail" title="Show Details" aria-label="Show Details" onClick={() => change(false)}>
      <i className="ph ph-caret-double-left" aria-hidden="true" />{rail}<span className="shell-detail-rail-label">Details</span></button>}
  </aside>;
}
