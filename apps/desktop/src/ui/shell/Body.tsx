import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { bodyLayout, DETAIL_DEFAULT, DETAIL_MIN } from './model';
import { WaitingFold } from './fold';
import { ItemHistoryContext } from './itemHistory';
import { HideIcon } from '../shared/HideIcon';

export interface BodyProps {
  readonly waiting: ReactNode;
  readonly center: ReactNode;
  readonly detail?: ReactNode;
  /** The detail header's breadcrumb. */
  readonly detailPath?: ReactNode;
  readonly rail?: ReactNode;
  readonly onCloseDetail?: () => void;
  readonly onRemove?: () => void;
  readonly hidden?: boolean;
  readonly onHide?: () => void;
  /** The owner's saved detail width; null or absent for the default. */
  readonly detailWidth?: number | null;
  /** Saves the width the owner dragged the detail panel to. */
  readonly onResizeDetail?: (width: number) => void;
  /** The owner's saved fold of the Waiting column. */
  readonly waitingFolded?: boolean;
  /** Saves the owner's fold of the Waiting column; without it the column cannot fold. */
  readonly onFoldWaiting?: (folded: boolean) => void;
}

const STEP = 16, SETTLE_MS = 500;

/** The body's width, following window resizes; null where it cannot be measured. */
function useWidth(ref: RefObject<HTMLDivElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(entries => { const entry = entries[entries.length - 1]; if (entry) setWidth(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function Body({ waiting, center, detail, detailPath, rail, onCloseDetail, onRemove, hidden = false, onHide, detailWidth = null, onResizeDetail,
  waitingFolded = false, onFoldWaiting }: BodyProps) {
  const ref = useRef<HTMLDivElement>(null);
  const history = useContext(ItemHistoryContext);
  const width = useWidth(ref);
  const [peek, setPeek] = useState(false);
  // The width being dragged or stepped, until it is saved.
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; width: number } | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layout = bodyLayout({ width, detail: !!detail, rail: !!rail, detailWidth: drag ?? detailWidth, folded: waitingFolded, peek });
  // Peeking ends once the window is wide enough again.
  useEffect(() => { if (!layout.narrow) setPeek(false); }, [layout.narrow]);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  const fold = useMemo(() => ({ folded: layout.folded, toggle: onFoldWaiting && (() => {
    if (!layout.folded) { setPeek(false); onFoldWaiting(true); return; }
    if (waitingFolded) onFoldWaiting(false);
    if (layout.narrow) setPeek(true);
  }) }), [layout.folded, layout.narrow, waitingFolded, onFoldWaiting]);
  const commit = (value: number) => {
    if (settle.current) { clearTimeout(settle.current); settle.current = null; }
    setDrag(null);
    onResizeDetail?.(value);
  };
  const clampWidth = (value: number) => Math.min(layout.detailMax, Math.max(DETAIL_MIN, Math.round(value)));
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { x: event.clientX, width: layout.detailWidth };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) setDrag(clampWidth(start.current.width + start.current.x - event.clientX));
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    start.current = null;
    if (drag !== null) commit(drag);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowLeft' ? layout.detailWidth + STEP : event.key === 'ArrowRight' ? layout.detailWidth - STEP
      : event.key === 'Home' ? DETAIL_MIN : event.key === 'End' ? layout.detailMax : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const value = clampWidth(next);
    setDrag(value);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => commit(value), SETTLE_MS);
  };
  return <div ref={ref} className="shell-body" style={{ gridTemplateColumns: layout.columns }}>
    <div className={`shell-waiting${layout.folded ? ' shell-waiting-folded' : ''}`}>
      <WaitingFold.Provider value={fold}>{waiting}</WaitingFold.Provider></div>
    <main className="shell-center">{center}</main>
    {detail && <aside className="shell-detail" aria-label="Item detail">
      {onResizeDetail && <div className="shell-detail-resize" role="separator" aria-orientation="vertical" aria-label="Resize detail panel"
        aria-valuemin={DETAIL_MIN} aria-valuemax={layout.detailMax} aria-valuenow={layout.detailWidth} tabIndex={0} title="Drag to resize; double-click for the default width"
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={keyDown}
        onBlur={() => { if (settle.current && drag !== null) commit(drag); }} onDoubleClick={() => commit(DETAIL_DEFAULT)} />}
      <div className="shell-detail-head">
        {history && <div className="shell-detail-history" role="group" aria-label="Item navigation">
          <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Back (⌘[)" aria-label="Back"
            disabled={!history.canBack} onClick={history.back}><i className="ph ph-arrow-left" aria-hidden="true" /></button>
          <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Forward (⌘])" aria-label="Forward"
            disabled={!history.canForward} onClick={history.forward}><i className="ph ph-arrow-right" aria-hidden="true" /></button>
        </div>}
        <div className="shell-detail-path">{detailPath}</div>
        {onHide && <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title={hidden ? 'Unhide (x)' : 'Hide (x)'}
          aria-label={hidden ? 'Unhide item' : 'Hide item'} onClick={onHide}><HideIcon hidden={hidden} /></button>}
        <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Remove (⌫)" aria-label="Remove item" onClick={onRemove}>
          <i className="ph ph-trash" aria-hidden="true" /></button>
        <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Close (Esc)" aria-label="Close detail" onClick={onCloseDetail}>
          <i className="ph ph-x" aria-hidden="true" /></button>
      </div>
      <div className="shell-detail-scroll">{detail}</div>
    </aside>}
    {rail}
  </div>;
}
