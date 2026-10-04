import type { Message } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';

export function messageItems(message: Immutable<Message>): readonly string[] {
  return [...new Set([...(message.item_id === null ? [] : [message.item_id]), ...message.items_touched])];
}
export function MessageCard({ message, role, highlighted = false, pinned = false, onHover, onPin, onReveal }: {
  message: Immutable<Message>; role?: string; highlighted?: boolean; pinned?: boolean;
  onHover?: (active: boolean) => void; onPin?: () => void; onReveal: (itemId: string) => void;
}) {
  return <article className={`history-message${highlighted ? ' history-highlight' : ''}${pinned ? ' history-pinned' : ''}`}
    data-message-id={message.id} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}
    onClick={event => { if (onPin && !(event.target instanceof Element && event.target.closest('button'))) onPin(); }}>
    <div className="history-meta"><span>#{message.number}</span><strong>{message.author === 'owner' ? 'You' : message.author === 'agent' ? 'Agent' : 'System'}</strong>
      <time dateTime={message.created_at}>{message.created_at}</time>{role && <span>{role}</span>}
      {onPin && <button type="button" aria-label={`${pinned ? 'Unpin' : 'Pin'} message ${message.number}`} aria-pressed={pinned} onClick={onPin}>{pinned ? 'Pinned' : 'Pin'}</button>}
    </div>
    <div className="history-body">{message.body}</div>
    <div className="history-links">{messageItems(message).map(id => <button key={id} type="button" onClick={() => onReveal(id)}>Item {id}</button>)}</div>
    {message.origin && <p className="history-meta">Imported from session {message.origin.session_id} · original {message.origin.author} · message {message.origin.entity_id}</p>}
  </article>;
}
