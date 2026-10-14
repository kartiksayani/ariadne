import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useSession } from '../../data/session-store';
import { displayStatus } from '../../selectors/waiting/replied';
import { StatusBadge } from '../shared/StatusBadge';
import { statusKey } from '../shared/status';
import { badgeLabel } from '../tree/model';
import { ItemConversation, type ItemDetailProps } from './ItemConversation';
import { useClipped } from './useClipped';
import './conversation.css';

export function ConversationView({ onClose, ...props }: ItemDetailProps & { readonly onClose: () => void }) {
  const anchor = useRef<HTMLElement>(null);
  const [titleExpanded, setTitleExpanded] = useState(false);
  const session = useSession(props.store).snapshot?.session, item = session?.items[props.itemId];
  const [titleNode, setTitleNode] = useState<HTMLElement | null>(null);
  // The title is a button only while it hides words (or shows them all and can be folded again).
  const titleClipped = useClipped(titleNode, `${item?.question ?? ''}\0${titleExpanded}`);
  const titleButton = titleClipped || titleExpanded;
  const toggleTitle = () => setTitleExpanded(value => !value);
  useEffect(() => { setTitleExpanded(false); anchor.current?.focus({ preventScroll: true }); }, [props.itemId]);
  return <section ref={anchor} className="conversation-view" aria-label="Item conversation" tabIndex={-1} data-conversation-anchor="" onKeyDown={event => {
    if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.querySelector<HTMLElement>('[data-message-id]')?.focus({ preventScroll: true });
  }}>
    <header className="conversation-header">
      {/* One element throughout, so folding the title keeps its focus: it is a button only while there is more to show or fold. */}
      <div className="conversation-heading"><h1><span ref={setTitleNode} className={`conversation-title${titleExpanded ? ' conversation-title-expanded' : ''}${titleButton ? ' conversation-title-button' : ''}`}
        title={item?.question} {...(titleButton ? { role: 'button', tabIndex: 0, 'aria-expanded': titleExpanded,
          'aria-label': `${titleExpanded ? 'Collapse' : 'Expand'} title: ${item?.question ?? 'Conversation'}`,
          onClick: toggleTitle, onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleTitle(); }
          } } : {})}>{item?.question ?? 'Conversation'}</span></h1>
        {item && session && <div className="conversation-meta"><span className="conversation-type">{item.type}</span><StatusBadge status={statusKey[displayStatus(session, item)]}
          label={badgeLabel(item, props.later, displayStatus(session, item))} /></div>}
      </div>
      <button type="button" className="btn btn-secondary" onClick={onClose}><i className="ph ph-arrow-left" aria-hidden="true" />Back to Map</button>
    </header>
    {item && session ? <ItemConversation {...props} expanded /> : <p role="status">This item is unavailable. Go Back to Map.</p>}
  </section>;
}
