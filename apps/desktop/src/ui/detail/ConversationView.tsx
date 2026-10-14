import { useEffect, useRef } from 'react';
import { useSession } from '../../data/session-store';
import { displayStatus } from '../../selectors/waiting/replied';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';
import { ItemConversation, type ItemDetailProps } from './ItemConversation';
import './conversation.css';

export function ConversationView({ onClose, ...props }: ItemDetailProps & { readonly onClose: () => void }) {
  const anchor = useRef<HTMLElement>(null);
  const session = useSession(props.store).snapshot?.session, item = session?.items[props.itemId];
  useEffect(() => { anchor.current?.focus({ preventScroll: true }); }, [props.itemId]);
  return <section ref={anchor} className="conversation-view" aria-label="Item conversation" tabIndex={-1} data-conversation-anchor="" onKeyDown={event => {
    if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.querySelector<HTMLElement>('[data-message-id]')?.focus({ preventScroll: true });
  }}>
    <header className="conversation-header">
      <div><h1>{item?.question ?? 'Conversation'}</h1>
        {item && session && <div className="conversation-meta"><span>{item.type}</span><StatusBadge status={statusKey[displayStatus(session, item)]} /></div>}
      </div>
      <button type="button" className="btn btn-secondary" onClick={onClose}><i className="ph ph-arrow-left" aria-hidden="true" />Back to Map</button>
    </header>
    {item && session ? <ItemConversation {...props} expanded /> : <p role="status">This item is unavailable. Go Back to Map.</p>}
  </section>;
}
