import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ItemRoute } from '../../generated/core';
import { useSession, type SessionStore } from '../../data/session-store';
import type { OwnerDraftStore } from '../../state/drafts/store';
import { displayStatus, ownerReplied } from '../../selectors/waiting/replied';
import { itemRemoved } from '../../selectors/removed';
import { sessionAnswerBlocked } from '../../selectors/sessionClosed';
import type { PendingSubmission } from '../answer/useSubmit';
import { AnswerSlot } from '../detail/AnswerSlot';
import { FileRefProject, ItemRefs, Markdown } from '../shared/MarkdownText';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';
import { copyText } from '../shared/clipboard';
import { ItemRefSession, PeekContext, type PeekNavigation } from './context';
import { peekPosition } from './position';
import { peekNames } from './names';
import './peek.css';

export { usePeek } from './context';
export type PeekVisit = 'peek' | 'opened' | 'answered';
export interface PeekProviderProps {
  readonly lookup: (route: ItemRoute) => SessionStore | null;
  readonly drafts: OwnerDraftStore;
  /** When Conversation owns input, only its item may offer answer actions. */
  readonly answerTarget?: ItemRoute;
  readonly onGoTo: (route: ItemRoute) => void;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** Records only the first displayed item revision after one uninterrupted second. */
  readonly onPeekSeen?: (route: ItemRoute, observedRevision: number) => void;
  readonly onVisit?: (route: ItemRoute, action: PeekVisit) => void;
  readonly children: ReactNode;
}
type OpenPeek = { readonly route: ItemRoute; readonly anchor: HTMLElement; readonly anchorRect: DOMRect; readonly store: SessionStore; readonly focus: boolean };
type Hover = { readonly route: ItemRoute; readonly anchor: HTMLElement };

export function PeekProvider({ lookup, drafts, answerTarget, onGoTo, onAgentNotRunning, onPeekSeen, onVisit, children }: PeekProviderProps) {
  const [shown, setShown] = useState<OpenPeek | null>(null);
  const hover = useRef<Hover | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ anchor: HTMLElement; anchorRect: DOMRect } | null>(null);
  const current = useRef({ lookup, onVisit }); current.current = { lookup, onVisit };
  const command = useRef(false), card = useRef<HTMLDivElement>(null);
  const tookFocus = useRef(false);
  const cancelHover = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const close = useCallback((restore = true) => {
    cancelHover();
    if (restore && (tookFocus.current || card.current?.contains(document.activeElement)) && origin.current?.anchor.isConnected) origin.current.anchor.focus({ preventScroll: true });
    origin.current = null;
    tookFocus.current = false;
    setShown(null);
  }, [cancelHover]);
  const show = useCallback((route: ItemRoute, anchor: HTMLElement, focus: boolean) => {
    cancelHover();
    if (document.querySelector('[aria-modal="true"]')) return;
    const store = current.current.lookup(route);
    if (!store) return;
    // Nested references replace the card; retain its original outside anchor and focus source.
    const previous = origin.current, nested = !!card.current?.contains(anchor) && !!previous;
    const anchorOrigin = nested && previous ? previous : { anchor, anchorRect: anchor.getBoundingClientRect() };
    origin.current = anchorOrigin;
    tookFocus.current = focus || nested && (tookFocus.current || !!card.current?.contains(document.activeElement));
    setShown({ route: { ...route }, ...anchorOrigin, store, focus });
    current.current.onVisit?.(route, 'peek');
  }, [cancelHover]);
  const schedule = useCallback(() => {
    cancelHover();
    const source = hover.current;
    if (!source || !command.current || document.querySelector('[aria-modal="true"]')) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (hover.current === source && command.current && source.anchor.isConnected) show(source.route, source.anchor, false);
    }, 500);
  }, [cancelHover, show]);
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) { cancelHover(); return; }
      if (event.key === 'Escape' && card.current) {
        if (event.target instanceof Element && event.target.closest('.pw-note')) return;
        // These controls own Escape before the peek, including when the Map
        // holding a session rename is covered. Peek lives in a portal, so route
        // Escape here even when its target is outside the app root.
        const control = document.querySelector<HTMLElement>('.shell-text-size-menu')
          ?? document.querySelector<HTMLElement>('.pw-rename');
        if (control) {
          const owner = control.closest('.shell-text-size') ?? control;
          if (!(event.target instanceof Node) || !owner.contains(event.target)) {
            event.preventDefault(); event.stopPropagation();
            control.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          }
          return;
        }
        const ownsFocus = tookFocus.current || card.current.contains(document.activeElement);
        close();
        if (ownsFocus) { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (event.key === 'Meta' && !command.current) { command.current = true; schedule(); }
    };
    const keyup = (event: globalThis.KeyboardEvent) => { if (event.key === 'Meta' || !event.metaKey) { command.current = false; cancelHover(); } };
    const outside = (event: globalThis.MouseEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (event.target instanceof Node && !card.current?.contains(event.target) && !shown?.anchor.contains(event.target)) close(false);
    };
    const blurred = () => { command.current = false; hover.current = null; cancelHover(); };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('keyup', keyup, true);
    document.addEventListener('mousedown', outside);
    window.addEventListener('blur', blurred);
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('keyup', keyup, true); document.removeEventListener('mousedown', outside); window.removeEventListener('blur', blurred); cancelHover(); };
  }, [shown, schedule, cancelHover, close]);
  const navigation = useMemo<PeekNavigation>(() => ({
    open: (route, anchor) => show(route, anchor, true), close,
    reference: route => {
      const session = current.current.lookup(route)?.getSnapshot().snapshot?.session, item = session?.items[route.item_id];
      if (!session || !item || itemRemoved(session, item.id)) return null;
      const labels = peekNames(session);
      return { name: labels.get(item.id)!, question: item.question, status: displayStatus(session, item) };
    },
    chipProps: route => ({
      onClick: event => { event.preventDefault(); event.stopPropagation(); show(route, event.currentTarget, true); },
      onKeyDown: event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); event.stopPropagation(); show(route, event.currentTarget, true); } },
      onMouseEnter: event => { hover.current = { route, anchor: event.currentTarget }; command.current = event.metaKey; schedule(); },
      onMouseMove: event => { if (command.current !== event.metaKey) { command.current = event.metaKey; if (!hover.current) hover.current = { route, anchor: event.currentTarget }; schedule(); } },
      onMouseLeave: () => { hover.current = null; cancelHover(); },
    }),
  }), [show, close, schedule, cancelHover]);
  return <PeekContext.Provider value={navigation}>{children}{shown && createPortal(<PeekCard key={JSON.stringify(shown.route)} shown={shown} drafts={drafts} card={card}
    allowAnswer={!answerTarget || answerTarget.project_id === shown.route.project_id && answerTarget.session_id === shown.route.session_id && answerTarget.item_id === shown.route.item_id}
    onClose={close} onGoTo={() => { close(false); onVisit?.(shown.route, 'opened'); onGoTo(shown.route); }} onAgentNotRunning={onAgentNotRunning}
    onPeekSeen={onPeekSeen} onAnswered={() => onVisit?.(shown.route, 'answered')} />, document.body)}</PeekContext.Provider>;
}

function PeekCard({ shown, drafts, card, allowAnswer, onClose, onGoTo, onAgentNotRunning, onPeekSeen, onAnswered }: {
  readonly shown: OpenPeek; readonly drafts: OwnerDraftStore; readonly card: RefObject<HTMLDivElement | null>;
  readonly allowAnswer: boolean;
  readonly onClose: () => void; readonly onGoTo: () => void; readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  readonly onPeekSeen?: (route: ItemRoute, observedRevision: number) => void; readonly onAnswered: () => void;
}) {
  const state = useSession(shown.store), session = state.snapshot?.session, item = session?.items[shown.route.item_id];
  const labels = useMemo(() => session ? peekNames(session) : null, [session]);
  const [position, setPosition] = useState({ left: 12, top: 12, maxWidth: 340, maxHeight: 500 });
  const [copied, setCopied] = useState(false), [copyFailed, setCopyFailed] = useState(false);
  const valid = !!session && !!item && !itemRemoved(session, item.id);
  const seenCallback = useRef(onPeekSeen); seenCallback.current = onPeekSeen;
  useEffect(() => {
    if (!valid) return;
    // A refresh during this opening must not acknowledge the newer text.
    const observedRevision = item!.revision;
    const timer = setTimeout(() => seenCallback.current?.(shown.route, observedRevision), 1000);
    return () => clearTimeout(timer);
  }, [shown, valid]);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const measure = () => {
      const chromeBottom = Math.max(0, ...Array.from(document.querySelectorAll('.shell-header, .shell-tabs, .tree-breadcrumb'),
        chrome => chrome.getBoundingClientRect().bottom));
      const style = getComputedStyle(element);
      // scrollHeight includes padding, but the fixed card's border also needs room.
      const height = element.scrollHeight + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const anchorRect = shown.anchor.isConnected ? shown.anchor.getBoundingClientRect() : shown.anchorRect;
      setPosition(peekPosition(anchorRect, 340, height, window.innerWidth, window.innerHeight, chromeBottom));
    };
    measure();
    if (shown.focus) element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(element);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); observer?.disconnect(); };
  }, [shown, card]);
  const title = item?.question ?? 'Item unavailable';
  return <div ref={card} className="item-peek" role="dialog" aria-label={`Peek: ${title}`} style={{ left: position.left, top: position.top, maxWidth: position.maxWidth, maxHeight: position.maxHeight }}
    onKeyDown={event => { if (event.key !== 'F6') event.stopPropagation(); }}>
    <div className="peek-head"><h2>{title}</h2><button type="button" className="btn btn-ghost btn-icon" aria-label="Close peek" title="Close peek (Esc)" onClick={onClose}><i className="ph ph-x" aria-hidden="true" /></button></div>
    {valid ? <ItemRefSession.Provider value={shown.route}><ItemRefs.Provider value={{ lookup: id => { const target = session.items[id]; return target && !itemRemoved(session, id) ? { label: target.question, name: labels?.get(id), status: displayStatus(session, target) } : null; }, route: id => ({ ...shown.route, item_id: id }), onOpenItem: onGoTo }}><FileRefProject.Provider value={session.project_id}>
      <div className="peek-tags"><span>{item.type}</span><StatusBadge status={statusKey[displayStatus(session, item)]} /></div>
      <Markdown className="peek-summary" text={item.outcome || item.ask || item.why || 'No summary yet.'} compact />
      {allowAnswer && item.status === 'waiting_on_me' && !ownerReplied(session, item) && session.state === 'active' && session.archived_at == null
        ? <PeekAnswer drafts={drafts} store={shown.store} itemId={item.id} onAgentNotRunning={onAgentNotRunning} onAnswered={onAnswered} onGoTo={onGoTo} />
        : item.status === 'waiting_on_me' && !ownerReplied(session, item) && session.state !== 'active' && <p className="peek-hint">{sessionAnswerBlocked(session)}</p>}
      <div className="peek-footer"><button type="button" className="btn btn-secondary" onClick={() => {
        void copyText(`${item.id} — ${item.question}`).then(() => { setCopied(true); setCopyFailed(false); }, () => setCopyFailed(true));
      }}>{copied ? 'Copied' : 'Copy reference'}</button><button type="button" className="btn btn-primary peek-go" onClick={onGoTo}>Go to</button></div>
      {copyFailed && <label className="peek-copy-fallback">Select and copy reference<input className="input" readOnly value={`${item.id} — ${item.question}`} onFocus={event => event.currentTarget.select()} /></label>}
    </FileRefProject.Provider></ItemRefs.Provider></ItemRefSession.Provider> : <p role="status">{state.status === 'loading' ? 'Loading item…' : 'This item is unavailable.'}</p>}
  </div>;
}

function PeekAnswer({ drafts, store, itemId, onAgentNotRunning, onAnswered, onGoTo }: {
  readonly drafts: OwnerDraftStore; readonly store: SessionStore; readonly itemId: string;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void; readonly onAnswered: () => void; readonly onGoTo: () => void;
}) {
  return <section className="peek-answer" aria-label="Answer question">
    <AnswerSlot drafts={drafts} store={store} itemId={itemId} onAgentNotRunning={onAgentNotRunning}
      onEscape={() => {}} onSent={() => { onAnswered(); void store.refresh(); }} />
    <button type="button" className="btn btn-ghost peek-details" onClick={onGoTo}>Open details</button>
  </section>;
}
