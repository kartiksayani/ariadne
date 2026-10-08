// The message rail (README §8), ported from Ariadne.dc.html:466-482 with the
// rail variant of Message Excerpt.dc.html. Hovering a message highlights the
// items it touched; clicking pins it. The rail follows the latest message
// until the owner scrolls up, then offers "N new messages · Jump to latest".
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RendererService } from '../../data/service';
import type { SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import { loadMessages } from '../../components/history/load';
import { useHistory } from '../../components/history/useHistory';
import { messageItems } from '../../components/history/MessageCard';
import { excerptView } from '../shared/excerpt';
import { notSent, withdrawn } from '../../selectors/waiting/stuck';
import { RailExcerpt } from '../shared/MessageExcerpt';
import { NotSentLine } from '../answer/NotSentLine';
import { editable, putBackBlocked, putBackCancelled, sendingAgain } from '../answer/held';
import type { DraftState, OwnerDraftStore } from '../../state/drafts/store';
import { followButton, jumpText } from './model';
import './rail.css';

const load = (service: RendererService, route: Parameters<typeof loadMessages>[1], revision: number, _selection: string, signal: AbortSignal) =>
  loadMessages(service, route, revision, signal);

/** Without a draft store there is no editor sending anything: the same empty state every time. */
const noDrafts: DraftState = Object.freeze({ entries: {}, ready: false, error: null, preferenceUncertain: false });
const noSubscribe = () => () => {};

export interface MessageRailProps {
  readonly service: RendererService;
  readonly store: SessionStore;
  /** The owner's draft store: "Put back in reply box" under a message that archive or close cancelled. Without it the line shows no button. */
  readonly drafts?: OwnerDraftStore;
  readonly selectedItemId?: string | null;
  readonly hoveredItemId?: string | null;
  readonly onHighlight: (itemIds: ReadonlySet<string>, messageIds: ReadonlySet<string>) => void;
  readonly onClose?: () => void;
  readonly closeDisabled?: boolean;
  /** Clock for day words; tests pin it. */
  readonly now?: () => number;
  /** Set for an earlier session: its message numbers read "codex #19" (shared/excerpt earlierAgent). */
  readonly earlierAgent?: string | null;
}

export function MessageRail({ service, store, drafts, selectedItemId = null, hoveredItemId = null, onHighlight, onClose, closeDisabled = false, now = Date.now,
  earlierAgent = null }: MessageRailProps) {
  const history = useHistory(service, store, 'messages', load);
  const draftState = useSyncExternalStore(drafts?.subscribe ?? noSubscribe, drafts?.getSnapshot ?? (() => noDrafts));
  // A message deleted (or taken back to edit) before it was sent leaves the history.
  const live = history.session.snapshot?.session, all = history.data?.items;
  const messages = useMemo(() => all && live ? all.filter(message => !withdrawn(live, message)) : all, [all, live]);
  const [hovered, setHovered] = useState<string | null>(null), [pinned, setPinned] = useState<string | null>(null);
  const [following, setFollowing] = useState(true), [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement>(null), lastScroll = useRef(0), seenThrough = useRef(0), initialized = useRef(false);
  const highlight = useRef(onHighlight);
  highlight.current = onHighlight;
  useEffect(() => {
    setHovered(null); setPinned(null); setFollowing(true); setUnseen(0);
    lastScroll.current = 0; seenThrough.current = 0; initialized.current = false;
  }, [store]);
  useEffect(() => {
    const message = messages?.find(value => value.id === (hovered ?? pinned));
    highlight.current(new Set(message ? messageItems(message) : []), new Set(message ? [message.id] : []));
  }, [messages, hovered, pinned]);
  useEffect(() => () => highlight.current(new Set(), new Set()), [store]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!messages || !element) return;
    const latest = messages.at(-1)?.number ?? 0;
    // A scroll event arrives asynchronously, so an update can land after the reader moved up
    // but before `following` cleared; the live position decides. A scrollTop that only shrank
    // because the viewport grew (still at the bottom) is not the reader scrolling up.
    const awayFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop > 8;
    const scrolledUp = initialized.current && following && element.scrollTop < lastScroll.current && awayFromBottom;
    if (scrolledUp) setFollowing(false);
    if (!initialized.current || (following && !scrolledUp)) {
      element.scrollTop = element.scrollHeight;
      lastScroll.current = element.scrollTop;
      seenThrough.current = latest;
      initialized.current = true;
      setUnseen(0);
    } else setUnseen(messages.filter(message => message.number > seenThrough.current).length);
  }, [messages, following]);
  const jump = () => {
    const element = scroller.current;
    if (element) { element.scrollTop = element.scrollHeight; lastScroll.current = element.scrollTop; }
    seenThrough.current = messages?.at(-1)?.number ?? 0;
    setUnseen(0); setFollowing(true);
  };
  const follow = followButton(following), at = now();
  const loading = !messages && (history.loading || history.session.status === 'loading');
  const focus = hoveredItemId ?? selectedItemId;
  return <aside className="pw-rail" aria-label="Messages">
    <div className="pw-rail-head">
      <span className="pw-rail-title">Messages</span>
      <span className="pw-rail-count">{messages?.length ?? 0}</span>
      <button type="button" className="btn btn-ghost pw-rail-follow" title="Follow new messages" style={{ color: follow.color }} onClick={jump}>
        <i className={follow.icon} aria-hidden="true" />{follow.text}</button>
      {onClose && <button type="button" className="btn btn-ghost btn-icon pw-rail-close" title="Hide messages (m)" aria-label="Hide messages"
        disabled={closeDisabled} onClick={() => { if (!closeDisabled) onClose(); }}><i className="ph ph-x" aria-hidden="true" /></button>}
    </div>
    <div ref={scroller} className="pw-rail-list" role="log" aria-label="Session messages" aria-live="off" onScroll={event => {
      const element = event.currentTarget;
      if (element.scrollTop < lastScroll.current || element.scrollHeight - element.clientHeight - element.scrollTop > 8) setFollowing(false);
      lastScroll.current = element.scrollTop;
    }}>
      {history.error && <div className="pw-rail-note" role="alert">{history.error}{history.data && ' Showing the previous messages.'}{' '}
        <button type="button" className="btn btn-ghost pw-rail-retry" onClick={history.retry}>Try again</button></div>}
      {history.session.status !== 'ready' && history.session.status !== 'loading' && <div className="pw-rail-note" role="status">
        {history.session.error ? plainFailure(history.session.error, 'The session is out of date.') : 'The session is out of date.'}</div>}
      {(!messages || messages.length === 0) && <div className="pw-rail-note">{loading ? 'Loading messages…' : 'No messages yet.'}</div>}
      {messages?.map(message => {
        const unsent = live ? notSent(live, message) : null;
        // The Not sent line sits under the card, not in it: its button can't live inside the card's own button.
        return <div className="pw-excerpt-group" key={message.id}>
          <RailExcerpt id={message.id} view={excerptView(message, at, earlierAgent)} active={message.id === hovered || message.id === pinned}
            highlight={focus !== null && messageItems(message).includes(focus)}
            onHover={on => setHovered(previous => on ? message.id : previous === message.id ? null : previous)}
            onPin={() => setPinned(previous => previous === message.id ? null : message.id)} />
          {live && unsent && <div className="pw-excerpt-unsent"><NotSentLine line={unsent.line} again={unsent.again || sendingAgain(draftState, live, unsent.input)}
            restoreHint={editable(unsent.input.kind) ? putBackBlocked(live, unsent.input) : null}
            onPutBack={!drafts || putBackBlocked(live, unsent.input) || !editable(unsent.input.kind) ? null
              : () => putBackCancelled(drafts, live, unsent.input)} /></div>}
        </div>;
      })}
    </div>
    {!following && unseen > 0 && <button type="button" className="btn btn-secondary pw-rail-jump" onClick={jump}>
      <i className="ph ph-arrow-down" aria-hidden="true" />{jumpText(unseen)}</button>}
  </aside>;
}
