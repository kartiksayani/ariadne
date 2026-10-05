import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RendererService } from '../../data/service';
import type { SessionStore } from '../../data/session-store';
import type { RegisteredRoutes, RevealedItem } from '../../data/routes';
import { loadMessages } from '../history/load';
import { useHistory } from '../history/useHistory';
import { MessageCard, messageItems } from '../history/MessageCard';
import '../history/history.css';
import './rail.css';

const load = (service: RendererService, route: Parameters<typeof loadMessages>[1], revision: number, _selection: string, signal: AbortSignal) =>
  loadMessages(service, route, revision, signal);

export function MessageRail({ service, store, routes, selectedItemId = null, hoveredItemId = null, onHighlight, onReveal, onClose, closeDisabled = false }: {
  service: RendererService; store: SessionStore; routes: RegisteredRoutes;
  selectedItemId?: string | null; hoveredItemId?: string | null;
  onHighlight: (itemIds: ReadonlySet<string>, messageIds: ReadonlySet<string>) => void;
  onReveal: (reveal: RevealedItem) => void; onClose?: () => void; closeDisabled?: boolean;
}) {
  const history = useHistory(service, store, 'messages', load);
  const messages = history.data?.items;
  const [hovered, setHovered] = useState<string | null>(null), [pinned, setPinned] = useState<string | null>(null);
  const [following, setFollowing] = useState(true), [unseen, setUnseen] = useState(0);
  const [routeError, setRouteError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null), lastScroll = useRef(0), seenThrough = useRef(0);
  const initialized = useRef(false), request = useRef(0);
  const highlight = useRef(onHighlight);
  highlight.current = onHighlight;
  useEffect(() => {
    setHovered(null); setPinned(null); setFollowing(true); setUnseen(0); setRouteError(null);
    lastScroll.current = 0; seenThrough.current = 0; initialized.current = false; ++request.current;
    return () => { ++request.current; };
  }, [store]);
  useEffect(() => {
    const message = messages?.find(value => value.id === (hovered ?? pinned));
    highlight.current(new Set(message ? messageItems(message) : []), new Set(message ? [message.id] : []));
  }, [messages, hovered, pinned]);
  useEffect(() => () => highlight.current(new Set(), new Set()), [store]);
  useLayoutEffect(() => {
    if (!messages || !scroller.current) return;
    const latest = messages.at(-1)?.number ?? 0;
    if (!initialized.current || following) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
      lastScroll.current = scroller.current.scrollTop;
      seenThrough.current = latest; initialized.current = true; setUnseen(0);
    } else {
      setUnseen(messages.filter(message => message.number > seenThrough.current).length);
    }
  }, [messages, following]);
  const reveal = (itemId: string) => {
    const call = ++request.current;
    setRouteError(null);
    void routes.revealItem({ ...history.session.route, item_id: itemId }).then(result => {
      if (request.current === call && result) onReveal(result);
    }).catch((failure: unknown) => { if (request.current === call) setRouteError(failure instanceof Error ? failure.message : 'The registered item could not be opened.'); });
  };
  const jump = () => {
    const element = scroller.current;
    if (element) { element.scrollTop = element.scrollHeight; lastScroll.current = element.scrollTop; }
    seenThrough.current = messages?.at(-1)?.number ?? 0;
    setUnseen(0); setFollowing(true);
  };
  return <aside className="ariadne-reference message-history-rail" aria-label="Session message rail">
    <header className="history-header"><strong>Messages</strong>{onClose && <button type="button" disabled={closeDisabled} onClick={() => { if (!closeDisabled) onClose(); }} aria-label="Close message rail">Close</button>}</header>
    {history.loading && <p role="status">Loading complete message history…</p>}
    {history.error && <p role="alert">{history.error} {history.data && 'Showing the previous complete history.'} <button type="button" onClick={history.retry}>Retry history read</button></p>}
    {history.session.status !== 'ready' && <p role="status">{history.session.error?.message ?? 'The registered session is stale.'}</p>}
    {routeError && <p role="alert">{routeError}</p>}
    {!following && <button type="button" className="rail-jump" onClick={jump}>{unseen} new messages · Jump to latest</button>}
    <div ref={scroller} className="rail-messages" role="log" aria-label="Complete session messages" aria-live="off" onScroll={event => {
      const element = event.currentTarget;
      if (element.scrollTop < lastScroll.current || element.scrollHeight - element.clientHeight - element.scrollTop > 8) setFollowing(false);
      lastScroll.current = element.scrollTop;
    }}>
      {messages?.map(message => <MessageCard key={message.id} message={message} pinned={message.id === pinned}
        highlighted={message.id === (hovered ?? pinned) || messageItems(message).some(id => id === selectedItemId || id === hoveredItemId)}
        onHover={active => setHovered(active ? message.id : null)} onPin={() => setPinned(previous => previous === message.id ? null : message.id)} onReveal={reveal} />)}
      {messages?.length === 0 && <p>No stored messages yet.</p>}
    </div>
  </aside>;
}
