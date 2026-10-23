import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ItemRoute, SessionRef } from '../../generated/core';
import { useSession, type SessionStore } from '../../data/session-store';
import type { OwnerDraftStore } from '../../state/drafts/store';
import type { NavigationStore } from '../../state/navigation/store';
import { useReadingSeen } from '../../state/preferences/reading';
import { displayStatus, ownerReplied } from '../../selectors/waiting/replied';
import { itemRemoved } from '../../selectors/removed';
import { sessionAnswerBlocked } from '../../selectors/sessionClosed';
import type { PendingSubmission } from '../answer/useSubmit';
import { AnswerSlot } from '../detail/AnswerSlot';
import { FileRefProject, ItemRefs, Markdown } from '../shared/MarkdownText';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';
import { ItemRefSession, PEEK_CLOSE_MS, PEEK_OPEN_MS, PeekContext, type PeekNavigation } from './context';
import { editableSelector } from '../keys';
import { peekPosition } from './position';
import { peekNames } from './names';
import { peekChange } from './change';
import { ChangeMarker } from '../changes/ChangeMarker';
import './peek.css';

export { usePeek } from './context';
export type PeekVisit = 'peek' | 'opened' | 'answered';
export interface PeekProviderProps {
  readonly lookup: (route: ItemRoute) => SessionStore | null;
  readonly drafts: OwnerDraftStore;
  /** Reads what the owner has seen, for the card's New/Changed pill. Peeking itself never marks anything seen. */
  readonly navigation?: NavigationStore;
  /** When Conversation owns input, only its item may offer answer actions. */
  readonly answerTarget?: ItemRoute;
  /** "Go to": select the item and scroll the Map to it; Details stays as it is. */
  readonly onGoTo: (route: ItemRoute) => void;
  /** "Open details": select the item and open Details on it. */
  readonly onOpenDetails: (route: ItemRoute) => void;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** 'peek' only for an explicit open (click or key); a hover is not a visit. */
  readonly onVisit?: (route: ItemRoute, action: PeekVisit) => void;
  readonly children: ReactNode;
}
type OpenPeek = { readonly route: ItemRoute; readonly anchor: HTMLElement; readonly anchorRect: DOMRect; readonly store: SessionStore; readonly explicit: boolean };
type Hover = { readonly route: ItemRoute; readonly anchor: HTMLElement };
type Timer = ReturnType<typeof setTimeout>;

const PEEK_WIDTH = 340;
const sameRoute = (left: ItemRoute, right: ItemRoute) => left.project_id === right.project_id && left.session_id === right.session_id && left.item_id === right.item_id;
/** A row or node may mark its name; the card sits under the name rather than the whole row. */
const anchorRect = (anchor: HTMLElement) => (anchor.querySelector<HTMLElement>('[data-peek-anchor]') ?? anchor).getBoundingClientRect();
const modal = () => !!document.querySelector('[aria-modal="true"]');
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** The scrollable ancestors of a name: what the owner's wheel or touch scrolls to move it. */
function scrollersOf(anchor: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let parent = anchor.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) found.push(parent);
  }
  return found;
}

export function PeekProvider({ lookup, drafts, navigation, answerTarget, onGoTo, onOpenDetails, onAgentNotRunning, onVisit, children }: PeekProviderProps) {
  const [shown, setShown] = useState<OpenPeek | null>(null);
  // `live` mirrors `shown` synchronously, so pointer and key handlers in one tick agree on what is open.
  const live = useRef<OpenPeek | null>(null), hover = useRef<Hover | null>(null);
  const opening = useRef<Timer | null>(null), closing = useRef<Timer | null>(null);
  const origin = useRef<{ anchor: HTMLElement; anchorRect: DOMRect } | null>(null);
  const current = useRef({ lookup, onVisit }); current.current = { lookup, onVisit };
  const card = useRef<HTMLDivElement>(null);
  const tookFocus = useRef(false), engaged = useRef(false), sending = useRef<() => boolean>(() => false);
  const cancelOpen = useCallback(() => { if (opening.current) clearTimeout(opening.current); opening.current = null; }, []);
  const cancelClose = useCallback(() => { if (closing.current) clearTimeout(closing.current); closing.current = null; }, []);
  const focusInside = useCallback(() => !!card.current && card.current.contains(document.activeElement), []);
  /** A send in flight, or words being typed in the card: a scroll or a Map change must not take it away. */
  const busy = useCallback(() => {
    const active = document.activeElement;
    return sending.current() || focusInside() && !!active?.matches('textarea, input, [contenteditable="true"]');
  }, [focusInside]);
  /** The owner is using the card: a pointer passing by neither closes nor replaces it. */
  const kept = useCallback(() => busy() || engaged.current || !!live.current?.explicit || focusInside(), [busy, focusInside]);
  /** `keepPending`: the grace timer closing a card must not cancel the open already waiting for the next name the pointer reached. */
  const close = useCallback((restore = true, keepPending = false) => {
    if (!keepPending) cancelOpen();
    cancelClose();
    if (restore && (tookFocus.current || focusInside()) && origin.current?.anchor.isConnected) origin.current.anchor.focus({ preventScroll: true });
    origin.current = null; live.current = null;
    tookFocus.current = false; engaged.current = false;
    setShown(null);
  }, [cancelOpen, cancelClose, focusInside]);
  /**
   * Map activity: close unless busy, giving focus back only if the card held it.
   * The pointer's next rest reopens a card here; after Escape it waits until the pointer leaves the name.
   */
  const closeAll = useCallback(() => {
    if (!live.current || busy()) return;
    hover.current = null;
    close(focusInside());
  }, [busy, close, focusInside]);
  const show = useCallback((route: ItemRoute, anchor: HTMLElement, explicit: boolean) => {
    cancelOpen(); cancelClose();
    if (modal()) return;
    const store = current.current.lookup(route);
    if (!store) return;
    // Nested references replace the card; retain its original outside anchor and focus source.
    const previous = origin.current, nested = !!card.current?.contains(anchor) && !!previous;
    const anchorOrigin = nested && previous ? previous : { anchor, anchorRect: anchorRect(anchor) };
    if (!live.current || !sameRoute(live.current.route, route)) engaged.current = false;
    origin.current = anchorOrigin;
    tookFocus.current = explicit || nested && (tookFocus.current || focusInside());
    const next = { route: { ...route }, ...anchorOrigin, store, explicit: explicit || nested && !!live.current?.explicit };
    live.current = next;
    setShown(next);
    if (explicit) current.current.onVisit?.(route, 'peek');
  }, [cancelOpen, cancelClose, focusInside]);
  const toggle = useCallback((route: ItemRoute, anchor: HTMLElement) => {
    if (live.current && sameRoute(live.current.route, route)) close(); else show(route, anchor, true);
  }, [close, show]);
  const leave = useCallback(() => {
    cancelClose();
    if (!live.current || kept()) return;
    closing.current = setTimeout(() => { closing.current = null; if (live.current && !kept()) close(false, true); }, PEEK_CLOSE_MS);
  }, [cancelClose, kept, close]);
  const hoverStart = useCallback((route: ItemRoute, anchor: HTMLElement, suppressed?: () => boolean) => {
    const open = live.current;
    if (open && sameRoute(open.route, route)) cancelClose();
    // The view's selected row or node: no hover card waits for it (D7).
    if (suppressed?.()) { hover.current = null; cancelOpen(); return; }
    const pending = hover.current;
    if (pending && pending.anchor === anchor && sameRoute(pending.route, route)) return;
    hover.current = { route, anchor };
    cancelOpen();
    if (open && sameRoute(open.route, route) || modal()) return;
    opening.current = setTimeout(() => {
      opening.current = null;
      if (hover.current?.anchor !== anchor || !anchor.isConnected || live.current && kept() || suppressed?.()) return;
      show(route, anchor, false);
    }, PEEK_OPEN_MS);
  }, [cancelClose, cancelOpen, kept, show]);
  const hoverEnd = useCallback(() => { hover.current = null; cancelOpen(); leave(); }, [cancelOpen, leave]);
  const dropHover = useCallback((route: ItemRoute) => {
    if (hover.current && sameRoute(hover.current.route, route)) { hover.current = null; cancelOpen(); }
    if (live.current && !live.current.explicit && sameRoute(live.current.route, route) && !busy()) close(focusInside());
  }, [cancelOpen, busy, close, focusInside]);
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (modal()) { cancelOpen(); return; }
      scrollKey(event);
      if (event.key !== 'Escape' || !card.current) return;
      if (event.target instanceof Element && event.target.closest('.pw-note')) return;
      // An open top-bar menu owns Escape before the peek. Peek lives in a portal,
      // so route Escape here even when its target is outside the app root.
      const control = document.querySelector<HTMLElement>('.tb-pop');
      if (control) {
        const owner = control.closest('.tb-anchor') ?? control;
        if (!(event.target instanceof Node) || !owner.contains(event.target)) {
          event.preventDefault(); event.stopPropagation();
          control.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }
        return;
      }
      const ownsFocus = tookFocus.current || focusInside();
      close();
      if (ownsFocus) { event.preventDefault(); event.stopPropagation(); }
    };
    const outside = (event: globalThis.MouseEvent) => {
      if (modal()) return;
      // A press is an action: no card pops up over it until the pointer leaves the name and rests again.
      if (!live.current) { cancelOpen(); return; }
      if (event.target instanceof Node && !card.current?.contains(event.target) && !shown?.anchor.contains(event.target)) close(false);
    };
    // A hover card closes on any scroll of whatever holds its name (the Map, the Graph, Details); scrolling inside the card does not.
    // A card the owner opened (click or key) ignores scroll events: Details and the Map scroll themselves (opening a conversation,
    // a row growing), and that must not take the card away. It closes on the owner's own scrolling instead (`ownerScroll`, below).
    const scrolled = (event: Event) => {
      const target = event.target, anchor = origin.current?.anchor;
      if (!live.current || live.current.explicit || target instanceof Node && card.current?.contains(target)) return;
      if (target === document || target === document.documentElement || target instanceof Node && !!anchor && target.contains(anchor)) closeAll();
    };
    // The owner's scrolling: a wheel or touch over a scroller that holds the card's name, or a scrolling key while focus is outside the card.
    const ownerScroll = (event: Event) => {
      const target = event.target, anchor = origin.current?.anchor;
      if (!live.current?.explicit || !anchor || !(target instanceof Node) || card.current?.contains(target)) return;
      if (scrollersOf(anchor).some(scroller => scroller.contains(target))) closeAll();
    };
    const scrollKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (!live.current?.explicit || !card.current || event.altKey || event.ctrlKey || event.metaKey || !SCROLL_KEYS.has(event.key)) return;
      if (!(target instanceof Element) || card.current.contains(target)) return;
      // Space on the name itself toggles the card; every other scrolling key closes it from the name too.
      if (event.key === ' ' && shown?.anchor.contains(target)) return;
      if (target.closest(editableSelector)) return;
      // Space only scrolls from the page itself: on a control or a row it activates or peeks.
      if (event.key === ' ' && target.closest('button, a, [role="button"], [role="treeitem"], [role="link"]')) return;
      closeAll();
    };
    const blurred = () => { hover.current = null; cancelOpen(); };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('mousedown', outside);
    document.addEventListener('scroll', scrolled, true);
    document.addEventListener('wheel', ownerScroll, { capture: true, passive: true });
    document.addEventListener('touchmove', ownerScroll, { capture: true, passive: true });
    window.addEventListener('blur', blurred);
    return () => {
      document.removeEventListener('keydown', keydown, true); document.removeEventListener('mousedown', outside);
      document.removeEventListener('scroll', scrolled, true); window.removeEventListener('blur', blurred);
      document.removeEventListener('wheel', ownerScroll, true); document.removeEventListener('touchmove', ownerScroll, true);
    };
  }, [shown, cancelOpen, close, closeAll, focusInside]);
  useEffect(() => () => { cancelOpen(); cancelClose(); }, [cancelOpen, cancelClose]);
  const peek = useMemo<PeekNavigation>(() => ({
    open: (route, anchor) => show(route, anchor, true), toggle, close: () => close(), closeAll, hoverStart, hoverEnd, dropHover,
    reference: route => {
      const session = current.current.lookup(route)?.getSnapshot().snapshot?.session, item = session?.items[route.item_id];
      if (!session || !item || itemRemoved(session, item.id)) return null;
      const labels = peekNames(session);
      return { name: labels.get(item.id)!, question: item.question, status: displayStatus(session, item) };
    },
    chipProps: route => ({
      onClick: event => { event.preventDefault(); event.stopPropagation(); show(route, event.currentTarget, true); },
      onKeyDown: event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); event.stopPropagation(); toggle(route, event.currentTarget); } },
      onMouseEnter: event => hoverStart(route, event.currentTarget),
      // A chip inside a row: the row's own hover must not take over while the pointer is on the chip.
      onMouseMove: event => { event.stopPropagation(); hoverStart(route, event.currentTarget); },
      onMouseLeave: hoverEnd,
    }),
    hoverProps: route => ({ onMouseEnter: event => hoverStart(route, event.currentTarget), onMouseLeave: hoverEnd }),
  }), [show, toggle, close, closeAll, hoverStart, hoverEnd, dropHover]);
  const leaveTo = (go: (route: ItemRoute) => void) => (route: ItemRoute) => { close(false); onVisit?.(route, 'opened'); go(route); };
  const goTo = leaveTo(onGoTo), openDetails = leaveTo(onOpenDetails);
  return <PeekContext.Provider value={peek}>{children}{shown && createPortal(<PeekCard key={JSON.stringify(shown.route)} shown={shown} drafts={drafts} card={card}
    navigation={navigation} sending={sending}
    allowAnswer={!answerTarget || sameRoute(answerTarget, shown.route)}
    onClose={() => close()} onGoTo={() => goTo(shown.route)} onOpenDetails={() => openDetails(shown.route)} onAgentNotRunning={onAgentNotRunning}
    onEngage={() => { engaged.current = true; cancelClose(); }} onPointerEnter={cancelClose} onPointerLeave={leave}
    onAnswered={() => onVisit?.(shown.route, 'answered')} />, document.body)}</PeekContext.Provider>;
}

const noStore = () => () => {};
/** What the owner has seen in the card's session, including marks still being saved. */
function usePeekSeen(navigation: NavigationStore | undefined, route: SessionRef) {
  const preferences = useSyncExternalStore(navigation?.subscribe ?? noStore, () => navigation?.getSnapshot().preferences ?? null);
  return useReadingSeen(navigation?.reading, preferences, route);
}

function PeekCard({ shown, drafts, card, navigation, sending, allowAnswer, onClose, onGoTo, onOpenDetails, onAgentNotRunning, onEngage, onPointerEnter, onPointerLeave, onAnswered }: {
  readonly shown: OpenPeek; readonly drafts: OwnerDraftStore; readonly card: RefObject<HTMLDivElement | null>;
  readonly navigation?: NavigationStore; readonly sending: MutableRefObject<() => boolean>;
  readonly allowAnswer: boolean;
  readonly onClose: () => void; readonly onGoTo: () => void; readonly onOpenDetails: () => void; readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  readonly onEngage: () => void; readonly onPointerEnter: () => void; readonly onPointerLeave: () => void; readonly onAnswered: () => void;
}) {
  const state = useSession(shown.store), session = state.snapshot?.session, item = session?.items[shown.route.item_id];
  const labels = useMemo(() => session ? peekNames(session) : null, [session]);
  const seen = usePeekSeen(navigation, shown.route);
  const change = useMemo(() => session && item ? peekChange(session, item, seen) : null, [session, item, seen]);
  const [position, setPosition] = useState({ left: 8, top: 48, maxWidth: PEEK_WIDTH, maxHeight: 500 });
  const valid = !!session && !!item && !itemRemoved(session, item.id);
  // The provider asks this while deciding whether a scroll or a Map change may close the card.
  useEffect(() => {
    sending.current = () => !!drafts.find(shown.route, shown.route.item_id, 'answer')?.saving;
    return () => { sending.current = () => false; };
  }, [drafts, shown, sending]);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      // scrollHeight includes padding, but the fixed card's border also needs room.
      const height = element.scrollHeight + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const rect = shown.anchor.isConnected ? anchorRect(shown.anchor) : shown.anchorRect;
      setPosition(peekPosition(rect, parseFloat(style.width) || PEEK_WIDTH, height, window.innerWidth, window.innerHeight));
    };
    measure();
    // An explicit open moves focus to the quiet close button: Space again closes, Tab reaches the options.
    if (shown.explicit) element.querySelector<HTMLButtonElement>('.peek-close')?.focus({ preventScroll: true });
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(element);
    return () => { window.removeEventListener('resize', measure); observer?.disconnect(); };
  }, [shown, card]);
  const title = item?.question ?? 'Item unavailable';
  const status = valid ? displayStatus(session, item) : null;
  const footer = <div className="peek-footer">
    <button type="button" className="peek-close" aria-label="Close peek" title="Close ( esc )" onClick={onClose}>esc to close</button>
    {valid && <>
      <button type="button" className="peek-button" onClick={onOpenDetails}><i className="ph ph-file-text" aria-hidden="true" />Open details</button>
      <button type="button" className="peek-button peek-go" onClick={onGoTo}><i className="ph ph-arrow-right" aria-hidden="true" />Go to</button>
    </>}
  </div>;
  return <div ref={card} className="item-peek" role="dialog" aria-label={`Peek: ${title}`} style={{ left: position.left, top: position.top, maxWidth: position.maxWidth, maxHeight: position.maxHeight }}
    onKeyDown={event => { if (event.key !== 'F6') event.stopPropagation(); }}
    onMouseDownCapture={onEngage} onKeyDownCapture={event => { if (event.key !== 'Escape') onEngage(); }} onClickCapture={onEngage}
    onMouseEnter={onPointerEnter} onMouseLeave={onPointerLeave}>
    {valid && status ? <ItemRefSession.Provider value={shown.route}><ItemRefs.Provider value={{ lookup: id => { const target = session.items[id]; return target && !itemRemoved(session, id) ? { label: target.question, name: labels?.get(id), status: displayStatus(session, target) } : null; }, route: id => ({ ...shown.route, item_id: id }), onOpenItem: onGoTo }}><FileRefProject.Provider value={session.project_id}>
      <div className="peek-head">
        <span className="peek-icon" aria-hidden="true"><StatusBadge status={statusKey[status]} variant="icon" size={15} /></span>
        <h2 className="peek-name" title={item.question}>{labels?.get(item.id) ?? item.question}</h2>
        {change?.marker && <ChangeMarker kind={change.marker} />}
        <StatusBadge status={statusKey[status]} />
      </div>
      <Markdown className="peek-summary" text={item.outcome || item.question} compact />
      {change?.strip && <p className="peek-strip"><strong>{change.strip.label}</strong> {change.strip.text}</p>}
      {allowAnswer && item.status === 'waiting_on_me' && !ownerReplied(session, item) && session.state === 'active' && session.archived_at == null
        ? <section className="peek-answer" aria-label="Answer question">
          {item.options.length === 0 ? <p className="peek-hint">This question wants your own words. Answer it in Details.</p>
            : <AnswerSlot drafts={drafts} store={shown.store} itemId={item.id} layout="compact" head onAgentNotRunning={onAgentNotRunning}
              onEscape={() => {}} onSent={() => { onAnswered(); void shown.store.refresh(); }} />}
        </section>
        : item.status === 'waiting_on_me' && !ownerReplied(session, item) && session.state !== 'active' && <p className="peek-hint">{sessionAnswerBlocked(session)}</p>}
      {footer}
    </FileRefProject.Provider></ItemRefs.Provider></ItemRefSession.Provider>
      : <><p role="status">{state.status === 'loading' ? 'Loading item…' : 'This item is unavailable.'}</p>{footer}</>}
  </div>;
}
