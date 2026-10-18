import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Immutable } from '../../data/session-store';
import type { SessionSeen } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import { unseenTopicRows } from '../../selectors/changes/unseen';
import { closePeekFirst } from '../parts/parts';
import { ChangesPopover } from './ChangesPopover';
import { clockTime, weekdayName } from './clock';
import './changes.css';
import './popover.css';

const EDGE = 12, MAX_WIDTH = 540;

/**
 * The band's "◆ N new ◇ N changed since HH:MM ›" (SPEC 5.5) and the What changed popover it opens (D18).
 * The popover is portalled to `.product-app`, placed from the opener's rect under it, and never takes part in the Map's layout.
 * It closes on Escape, on a press outside, and when the Map scrolls. Nothing here clears a marker: only a row's own button,
 * Mark all caught up, or the dwell does.
 */
export function ChangesOpener({ session, topicId, seen, navigation, onOpenItem }: {
  readonly session: Immutable<Session>; readonly topicId: string; readonly seen: Immutable<SessionSeen> | null | undefined;
  readonly navigation: NavigationStore; readonly onOpenItem: (itemId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  const keyboard = useRef(false);
  const route = useMemo(() => ({ project_id: session.project_id, session_id: session.id }), [session.project_id, session.id]);
  const data = useMemo(() => unseenTopicRows(session, topicId, seen), [session, topicId, seen]);
  const undoToken = navigation.reading.undoToken(route, topicId);
  const canUndo = !!undoToken && navigation.reading.canUndo(undoToken);
  const [placement, setPlacement] = useState<CSSProperties>({ visibility: 'hidden' });
  const { summary, newCount, changedCount, list } = data;
  const shown = list.length > 0 || canUndo || open;
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) button.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect(), column = anchor.closest('.tree-column')?.getBoundingClientRect();
      const left0 = column?.left ?? 0, width0 = column?.width ?? (document.documentElement.clientWidth || window.innerWidth);
      const dock = parseFloat(getComputedStyle(anchor).getPropertyValue('--dock-inset')) || 0;
      const bottom = (column?.bottom ?? (document.documentElement.clientHeight || window.innerHeight)) - dock - 14;
      // As on the board: the Map's left edge plus 12, just under the topic band, whatever x the opener sits at.
      const band = anchor.closest('.tree-topic')?.getBoundingClientRect();
      const top = band?.bottom ?? rect.bottom + 6, width = Math.max(240, Math.min(MAX_WIDTH, width0 - EDGE * 2));
      const left = left0 + EDGE;
      setPlacement({ left, top, width, maxHeight: Math.max(160, bottom - top) });
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    const column = button.current?.closest('.tree-column');
    if (column) observer?.observe(column);
    return () => { window.removeEventListener('resize', place); observer?.disconnect(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (keyboard.current) panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false);
    };
    // Scrolling whatever holds the band (the Map) closes the popover; scrolling inside it does not.
    const scrolled = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !panel.current?.contains(target) && target.contains(button.current)) setOpen(false);
    };
    // Escape closes it from wherever focus is; a peek card open over it takes the first Escape (and is closed here, as the conversation does).
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      if (!closePeekFirst()) close(true);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); document.removeEventListener('scroll', scrolled, true); };
  }, [open]);

  // The topic can change or empty under an open popover; close it rather than leave it pointing at nothing.
  useEffect(() => { setOpen(false); }, [topicId, session.id]);
  if (!shown || !session.topics[topicId]) return null;

  const since = summary.baseline ? clockTime(summary.baseline) : null;
  const long = summary.longAbsence && list.length > 0;
  return <span className="changes-opener" data-open={open || undefined}>
    <button ref={button} type="button" className="changes-summary" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
      title="What changed since you last looked. The key is in the ? menu."
      onClick={event => { keyboard.current = event.detail === 0; setOpen(value => !value); }}>
      {list.length === 0 ? <><i className="ph ph-check" aria-hidden="true" /><span>All caught up</span></>
        : long ? <span>{summary.changeCount} changes{' '}<span className="changes-since">since {weekdayName(summary.baseline!)}</span></span> : <>
          {newCount > 0 && <span className="changes-count"><i className="changes-diamond" data-kind="new" aria-hidden="true" />{newCount} new</span>}
          {newCount > 0 && changedCount > 0 && ' '}
          {changedCount > 0 && <span className="changes-count"><i className="changes-diamond" data-kind="changed" aria-hidden="true" />{changedCount} changed</span>}
          {since && <>{' '}<span className="changes-since">since {since}</span></>}</>}
      <i className={open ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />
    </button>
    {canUndo && <button type="button" className="change-link changes-undo" onClick={() => navigation.reading.undo(undoToken!)}>Undo</button>}
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label="What changed" className="changes-popover" tabIndex={-1} style={placement}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!closePeekFirst()) close(true); }
        else if (event.key !== 'F6' && !event.metaKey && !event.ctrlKey) event.stopPropagation();
      }}>
      <header className="changes-head">
        <i className="ph ph-list" aria-hidden="true" />
        <h2>What changed</h2>
        {since && <span className="change-muted">since you looked at {since}</span>}
        <button type="button" className="btn btn-ghost changes-close" aria-label="Close" title="Close ( esc )" onClick={() => close(true)}><i className="ph ph-x" aria-hidden="true" /></button>
      </header>
      <ChangesPopover session={session} topicId={topicId} route={route} navigation={navigation} data={data} undoToken={undoToken}
        onOpenItem={itemId => { close(); onOpenItem(itemId); }} />
    </div>, button.current?.closest('.product-app') ?? document.body)}
  </span>;
}
