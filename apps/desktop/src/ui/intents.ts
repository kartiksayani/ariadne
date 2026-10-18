// C5: what a key (or a button) asks for, apart from who answers it. Views register handlers for the intents
// they own; ui/keys.ts maps keys to intents in one table. No key clicks a hidden button.
// The latest registration answers first, so a view mounted over another (the bigger view over the Map) wins
// while it is mounted; a handler that returns false passes the intent to the one below it.
import { useEffect, useRef } from 'react';

export type Intent =
  | 'switcher.open' | 'help.toggle' | 'focus.toggle' | 'recent.open' | 'topic.continue'
  | 'item.ack' | 'item.drop' | 'item.hide' | 'item.remove' | 'item.bring' | 'item.respond' | 'item.later' | 'item.reopen'
  | 'view.toggleGraph' | 'search.focus' | 'filter.toggle' | 'map.nextUnseen' | 'map.backToSelected' | 'map.top'
  | 'dock.prev' | 'dock.next' | 'dock.fold';

/** Returns true when it handled the intent. `repeat` is true for a held key. */
export type IntentHandler = (context: { readonly repeat: boolean }) => boolean;

const handlers = new Map<Intent, IntentHandler[]>();

export function registerIntent(intent: Intent, handler: IntentHandler): () => void {
  const list = handlers.get(intent) ?? [];
  handlers.set(intent, [...list, handler]);
  return () => {
    const current = handlers.get(intent) ?? [];
    const at = current.lastIndexOf(handler);
    if (at >= 0) handlers.set(intent, [...current.slice(0, at), ...current.slice(at + 1)]);
  };
}

/** Asks the views for the intent, latest registration first. True if one handled it. */
export function dispatchIntent(intent: Intent, context: { readonly repeat?: boolean } = {}): boolean {
  const list = handlers.get(intent) ?? [];
  for (let at = list.length - 1; at >= 0; at--) if (list[at]!({ repeat: context.repeat ?? false })) return true;
  return false;
}

/** Whether any view answers the intent now. For tests and for disabling a control that would do nothing. */
export const hasIntentHandler = (intent: Intent) => (handlers.get(intent)?.length ?? 0) > 0;

/** Registers handlers while the component is mounted; each call sees the latest render's handler. */
export function useIntents(map: Partial<Record<Intent, IntentHandler>>): void {
  const latest = useRef(map);
  latest.current = map;
  const names = Object.keys(map).sort().join(' ');
  useEffect(() => {
    const offs = names.split(' ').filter(Boolean).map(name => registerIntent(name as Intent,
      context => latest.current[name as Intent]?.(context) ?? false));
    return () => offs.forEach(off => off());
  }, [names]);
}
