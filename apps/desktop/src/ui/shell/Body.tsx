import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { bodyLayout, WAITING_FOLDED, WAITING_WIDTH } from './model';
import { WaitingFold } from './fold';
import { useDockInset } from './dockInset';
import { SideCovered } from './sideCovered';
import { DETAILS_RAIL, useDetailsColumn } from '../../state/details/column';
import { Notices } from '../pages/notices';

/** Body state the dock replaces; until then the shell keeps today's layout. */
export interface LegacyBody {
  readonly conversation?: ReactNode;
  readonly waiting?: ReactNode;
  /** The owner's saved fold of the Waiting column. */
  readonly waitingFolded?: boolean;
  /** Saves the owner's fold of the Waiting column; without it the column cannot fold. */
  readonly onFoldWaiting?: (folded: boolean) => void;
}

export interface BodyProps extends LegacyBody {
  readonly main: ReactNode;
  /** The side column (`DetailsColumn`); absent, the Map takes the full width. */
  readonly side?: ReactNode;
  /** Floats over the main and side areas, anchored to the bottom. */
  readonly dock?: ReactNode;
}

/** The body's visible width, following window resizes; null where it cannot be measured. */
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

/**
 * While the conversation view is open, notices keep to the band between its header and its footer, so a notice that never
 * auto-dismisses (an actionable one) can never cover Back to Map, own words or Send. The band follows both as they resize.
 */
function useNoticeBand(view: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const host = view.current, notices = layer.current;
    if (!open || !host || !notices) return undefined;
    let frame = 0;
    const place = () => {
      frame = 0;
      const bounds = host.getBoundingClientRect();
      const header = host.querySelector('.conversation-header')?.getBoundingClientRect(), dock = host.querySelector('.detail-dock')?.getBoundingClientRect();
      notices.style.setProperty('--notice-top', `${Math.max(0, (header?.bottom ?? bounds.top) - bounds.top) + 8}px`);
      notices.style.setProperty('--notice-bottom', `${Math.max(0, bounds.bottom - (dock?.top ?? bounds.bottom)) + 8}px`);
    };
    // Placing in a frame keeps the observers from reporting a resize loop.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const watched = new Set<Element>();
    const watch = () => {
      const next = new Set<Element>([host, ...host.querySelectorAll('.conversation-header, .detail-dock')]);
      for (const element of watched) if (!next.has(element)) { resize?.unobserve(element); watched.delete(element); }
      for (const element of next) if (!watched.has(element)) { resize?.observe(element); watched.add(element); }
    };
    // The footer appears, goes and changes while the view stays open.
    const mutate = new MutationObserver(() => { watch(); schedule(); });
    mutate.observe(host, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    watch(); place();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect(); mutate.disconnect(); window.removeEventListener('resize', schedule);
      notices.style.removeProperty('--notice-top'); notices.style.removeProperty('--notice-bottom');
    };
  }, [view, layer, open]);
}

/**
 * The shell body: the main area and the side column, with the dock floating over both at the bottom. It publishes the
 * dock's height as `--dock-inset` and sizes the side column from `useDetailsColumn` (C9): the owner's width, or the 36px
 * rail while Details is folded.
 */
export function Body({ main, side, dock, conversation, waiting, waitingFolded = false, onFoldWaiting }: BodyProps) {
  const ref = useRef<HTMLDivElement>(null), view = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null);
  useNoticeBand(view, layer, !!conversation);
  const width = useWidth(ref);
  const inset = useDockInset();
  const [peek, setPeek] = useState(false);
  const column = useDetailsColumn();
  const railed = !!side && column.folded;
  const layout = bodyLayout({ width, detail: !!side && !railed, detailWidth: column.width, folded: waitingFolded, peek });
  // The side column's width: the rail, or the open width (which the Waiting column may squeeze until it goes).
  const sideWidth = !side ? 0 : railed ? DETAILS_RAIL : layout.detailWidth;
  // Peeking ends once the window is wide enough again.
  useEffect(() => { if (!layout.narrow) setPeek(false); }, [layout.narrow]);
  const fold = useMemo(() => ({ folded: layout.folded, toggle: onFoldWaiting && (() => {
    if (!layout.folded) { setPeek(false); onFoldWaiting(true); return; }
    if (waitingFolded) onFoldWaiting(false);
    if (layout.narrow) setPeek(true);
  }) }), [layout.folded, layout.narrow, waitingFolded, onFoldWaiting]);
  // The retained grid can exceed a narrow viewport; Conversation follows the viewport instead.
  return <div ref={ref} className="shell-body-viewport" style={{ '--dock-inset': `${inset}px` } as CSSProperties}>
    <div className="shell-body" style={{ gridTemplateColumns: railed ? `${layout.columns} ${DETAILS_RAIL}px` : layout.columns }}>
    <div className={`shell-waiting${layout.folded ? ' shell-waiting-folded' : ''}`}>
      <WaitingFold.Provider value={fold}>{waiting}</WaitingFold.Provider></div>
    <main className="shell-center" inert={!!conversation || undefined} aria-hidden={!!conversation || undefined}><div className="shell-center-content">{main}</div></main>
    {side && <SideCovered.Provider value={!!conversation}>{side}</SideCovered.Provider>}
    </div>
    {conversation && <div ref={view} className="shell-conversation" style={{ left: layout.folded ? WAITING_FOLDED : WAITING_WIDTH }}>{conversation}</div>}
    {dock && <div className="shell-dock">{dock}</div>}
    <div ref={layer} className="shell-notices" data-conversation={conversation ? '' : undefined} style={{ left: layout.folded ? WAITING_FOLDED : WAITING_WIDTH, right: conversation ? 0 : sideWidth }}><Notices /></div>
  </div>;
}
