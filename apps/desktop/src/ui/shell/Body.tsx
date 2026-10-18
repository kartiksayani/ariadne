import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { bodyLayout } from './model';
import { useDockInset } from './dockInset';
import { SideCovered } from './sideCovered';
import { DETAILS_RAIL, useDetailsColumn } from '../../state/details/column';
import { Notices } from '../pages/notices';
import { Toast } from './ToastView';
import { useMapNoticeTop, useNoticeStackBottom } from './noticeTop';

/** Body state the dock and the Details column replace; until then the shell keeps today's layout. */
export interface LegacyBody {
  readonly conversation?: ReactNode;
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
function useNoticeBand(view: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, toast: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const host = view.current, notices = layer.current, lifted = toast.current;
    if (!open || !host || !notices) return undefined;
    let frame = 0;
    const place = () => {
      frame = 0;
      const bounds = host.getBoundingClientRect();
      const header = host.querySelector('.conversation-header')?.getBoundingClientRect(), dock = host.querySelector('.detail-dock')?.getBoundingClientRect();
      notices.style.setProperty('--notice-top', `${Math.max(0, (header?.bottom ?? bounds.top) - bounds.top) + 8}px`);
      const bottom = `${Math.max(0, bounds.bottom - (dock?.top ?? bounds.bottom)) + 8}px`;
      notices.style.setProperty('--notice-bottom', bottom);
      // The toast keeps clear of the composer the same way.
      lifted?.style.setProperty('--notice-bottom', bottom);
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
      lifted?.style.removeProperty('--notice-bottom');
    };
  }, [view, layer, toast, open]);
}

/**
 * The shell body: the main area and the side column, with the dock floating over both at the bottom. It publishes the
 * dock's height as `--dock-inset` and sizes the side column from `useDetailsColumn` (C9): the owner's width, or the 36px
 * rail while Details is folded.
 */
export function Body({ main, side, dock, conversation }: BodyProps) {
  const ref = useRef<HTMLDivElement>(null), view = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null), toast = useRef<HTMLDivElement>(null);
  useNoticeBand(view, layer, toast, !!conversation);
  const mapTop = useMapNoticeTop(ref, !conversation);
  useNoticeStackBottom(ref, !conversation);
  const width = useWidth(ref);
  // No dock (a page), no room under it.
  const dockInset = useDockInset(), inset = dock ? dockInset : 0;
  const column = useDetailsColumn();
  const railed = !!side && column.folded;
  const layout = bodyLayout({ width, detail: !!side && !railed, detailWidth: column.width });
  const sideWidth = !side ? 0 : railed ? DETAILS_RAIL : layout.detailWidth;
  // The retained grid can exceed a narrow viewport; Conversation follows the viewport instead.
  return <div ref={ref} className="shell-body-viewport" style={{ '--dock-inset': `${inset}px` } as CSSProperties}>
    <div className="shell-body" style={{ gridTemplateColumns: railed ? `${layout.columns} ${DETAILS_RAIL}px` : layout.columns }}>
    <main className="shell-center" inert={!!conversation || undefined} aria-hidden={!!conversation || undefined}><div className="shell-center-content">{main}</div></main>
    {side && <SideCovered.Provider value={!!conversation}>{side}</SideCovered.Provider>}
    </div>
    {conversation && <div ref={view} className="shell-conversation" style={{ left: 0 }}>{conversation}</div>}
    {dock && <div className="shell-dock">{dock}</div>}
    <div ref={layer} className="shell-notices" data-placement={conversation ? 'conversation' : mapTop !== null ? 'map' : undefined}
      style={{ left: 0, right: conversation ? 0 : sideWidth, ...(mapTop !== null ? { '--notice-top': `${mapTop}px` } : {}) } as CSSProperties}><Notices /></div>
    <div ref={toast} className="shell-toast" data-placement={conversation ? 'conversation' : undefined} style={{ left: 0, right: conversation ? 0 : sideWidth }}><Toast /></div>
  </div>;
}
