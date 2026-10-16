import { useContext, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { DETAIL_DEFAULT, DETAIL_MIN } from './model';
import { ItemHistoryContext } from './itemHistory';
import { SideLayoutContext, type SideLayout } from './sideLayout';
import { HideIcon } from '../shared/HideIcon';

export interface DetailsColumnProps {
  /** The column's content: the item's details. */
  readonly children: ReactNode;
  /** The column header's breadcrumb. */
  readonly path?: ReactNode;
  readonly onClose?: () => void;
  readonly onRemove?: () => void;
  readonly hidden?: boolean;
  readonly hiddenNotice?: string;
  readonly onHide?: () => void;
  /** Saves the width the owner dragged the column to; without it the column cannot be resized. */
  readonly onResize?: (width: number) => void;
}

const STEP = 16;
/** Outside a shell body (previews), the column shows at its default width and cannot be resized. */
const fixed: SideLayout = {
  width: DETAIL_DEFAULT, max: DETAIL_DEFAULT, drag: null, covered: false, preview: () => {}, step: () => {}, commit: () => {}, flush: () => {},
};

/** The Details column, in the shell's side slot: the resize edge, the head (history, path, Hide, Remove, Close) and the scroll area. */
export function DetailsColumn({ children, path, onClose, onRemove, hidden = false, hiddenNotice, onHide, onResize }: DetailsColumnProps) {
  const history = useContext(ItemHistoryContext);
  const layout = useContext(SideLayoutContext) ?? fixed;
  const start = useRef<{ x: number; width: number } | null>(null);
  const clampWidth = (value: number) => Math.min(layout.max, Math.max(DETAIL_MIN, Math.round(value)));
  const save = (value: number) => onResize?.(value);
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = { x: event.clientX, width: layout.width };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current) layout.preview(clampWidth(start.current.width + start.current.x - event.clientX));
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    start.current = null;
    if (layout.drag !== null) layout.commit(layout.drag, save);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowLeft' ? layout.width + STEP : event.key === 'ArrowRight' ? layout.width - STEP
      : event.key === 'Home' ? DETAIL_MIN : event.key === 'End' ? layout.max : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    layout.step(clampWidth(next), save);
  };
  const covered = layout.covered || undefined;
  return <aside className={`shell-detail${hidden ? ' shell-detail-hidden' : ''}`} aria-label="Item detail" inert={covered} aria-hidden={covered}>
    {onResize && <div className="shell-detail-resize" role="separator" aria-orientation="vertical" aria-label="Resize detail panel"
      aria-valuemin={DETAIL_MIN} aria-valuemax={layout.max} aria-valuenow={layout.width} tabIndex={0} title="Drag to resize; double-click for the default width"
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={keyDown}
      onBlur={() => layout.flush(save)} onDoubleClick={() => layout.commit(DETAIL_DEFAULT, save)} />}
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
      <button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Close (Esc)" aria-label="Close detail" onClick={onClose}>
        <i className="ph ph-x" aria-hidden="true" /></button>
    </div>
    <div className="shell-detail-scroll">{children}</div>
  </aside>;
}
