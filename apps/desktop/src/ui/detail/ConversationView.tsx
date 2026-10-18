import { useEffect, useRef } from 'react';
import { useSession } from '../../data/session-store';
import { useDetailsColumn } from '../../state/details/column';
import { DetailHead, type DetailHeadControls } from '../shell/DetailHead';
import { DetailPath } from './DetailPath';
import { ItemConversation, type ItemDetailProps } from './ItemConversation';
import './conversation.css';

/**
 * The bigger view (SPEC 5.3, 6.3): Details over the Map's place, its body and composer centred at 760px. It has the column's
 * head with "← Map" first. The Map stays mounted underneath, inert, so it keeps its scroll.
 */
export function ConversationView({ onClose, head, onTopic, ...props }: ItemDetailProps & {
  readonly onClose: () => void;
  readonly head?: DetailHeadControls;
  readonly onTopic?: () => void;
}) {
  const anchor = useRef<HTMLElement>(null);
  const column = useDetailsColumn();
  const session = useSession(props.store).snapshot?.session, item = session?.items[props.itemId];
  useEffect(() => { anchor.current?.focus({ preventScroll: true }); }, [props.itemId]);
  return <section ref={anchor} className="conversation-view" aria-label="Item conversation" tabIndex={-1} data-conversation-anchor="" onKeyDown={event => {
    if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.querySelector<HTMLElement>('[data-message-id]')?.focus({ preventScroll: true });
  }}>
    <DetailHead bigger onBackToMap={onClose} {...head}
      path={<DetailPath store={props.store} itemId={props.itemId} onOpenItem={props.onOpenItem} onTopic={onTopic} />}
      fold={<button type="button" className="btn btn-ghost btn-icon shell-detail-action" title="Fold Details" aria-label="Fold Details" onClick={column.fold}>
        <i className="ph ph-caret-double-right" aria-hidden="true" /></button>} />
    {item && session ? <ItemConversation {...props} expanded /> : <p role="status">This item is unavailable. Go Back to Map.</p>}
  </section>;
}
