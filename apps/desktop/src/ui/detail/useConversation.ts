import { useEffect, useRef, useState } from 'react';

/** The item whose conversation shows in the bigger view, in the session `route` (a route key). */
export interface ConversationTarget { readonly route: string; readonly itemId: string; readonly dividerId: string | null }

export interface Conversation {
  /** The bigger view's item; it may belong to another session than the current one until the effect drops it. */
  readonly conversation: ConversationTarget | null;
  /** The bigger view is open on the current session. */
  readonly conversationOpen: boolean;
  /**
   * Opens the bigger view on `itemId` of the current session, with the unread divider from `dividerId`. Returns false,
   * and changes nothing, when it shows that item already.
   */
  readonly showConversation: (itemId: string, dividerId: () => string | null) => boolean;
  /** Back to Map: closes the view and returns focus to where the owner opened it from. */
  readonly closeConversation: () => void;
}

/**
 * The bigger conversation view's state for the current session (`routeKey`). `onChange` runs before it opens on an item
 * or closes, so pending owner requests cannot land in the wrong view. Leaving the session closes the view.
 */
export function useConversation(routeKey: string, onChange: () => void): Conversation {
  const [conversation, setConversation] = useState<ConversationTarget | null>(null);
  const conversationOpen = conversation?.route === routeKey;
  const conversationOrigin = useRef<HTMLElement | null>(null), restoreConversationFocus = useRef(false);
  const closeConversation = () => {
    if (!conversationOpen) return;
    onChange();
    restoreConversationFocus.current = true; setConversation(null);
  };
  useEffect(() => {
    if (conversation && conversation.route !== routeKey) { restoreConversationFocus.current = false; setConversation(null); }
    if (!conversation && restoreConversationFocus.current) {
      restoreConversationFocus.current = false;
      const origin = conversationOrigin.current;
      const expand = document.querySelector<HTMLElement>('[aria-label="Open the conversation in a bigger view"]');
      (origin?.isConnected ? origin : expand)?.focus({ preventScroll: true });
    }
  }, [conversation, routeKey]);
  const showConversation = (itemId: string, dividerId: () => string | null) => {
    if (!conversation) conversationOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (conversation?.itemId === itemId && conversation.route === routeKey) return false;
    onChange();
    setConversation({ route: routeKey, itemId, dividerId: dividerId() });
    return true;
  };
  return { conversation, conversationOpen, showConversation, closeConversation };
}
