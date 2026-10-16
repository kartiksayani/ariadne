// The App's share of the keys (C4, converted to intents for C5). Keys that only make sense where focus is
// (Esc, the option digits) stay key handlers; every other workspace key asks for an intent (ui/keys.ts
// `keyIntents`), and the App answers the ones that act on the current view's selected item.
import type { ItemRoute } from '../../generated/core';
import type { OwnerFocusRequest } from '../answer/useSubmit';
import type { RemoveTarget } from '../dialogs/remove';
import type { Intent, IntentHandler } from '../intents';
import { intentKeyHandlers, type WorkspaceHandlers } from '../keys';

export type TreeRemoveTarget = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;
export interface FocusedItem { readonly item: { readonly id: string; readonly status: string; readonly topic_id: string }; readonly target: ItemRoute }
export interface ItemIntentApp {
  readonly store: boolean;
  readonly toggleFilters: () => void;
  /** The current view's selected item: the conversation's item in the bigger view, else the Map's selection. Never the row under the pointer. */
  readonly focused: () => FocusedItem | null;
  readonly focusOwner: (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number) => void;
  readonly ack: (target: ItemRoute, repeat: boolean) => boolean;
  readonly queueBring: (target: ItemRoute) => Promise<void>;
  readonly toggleHidden: (target: ItemRoute) => boolean;
  readonly toggleLater: (target: ItemRoute, itemId: string) => boolean;
  readonly toggleGraph: () => void;
  readonly closeDetail: () => void;
  readonly closeConversation?: () => void;
  readonly clearFilters?: () => void;
  readonly askRemove: (target: TreeRemoveTarget) => boolean;
}

/** The App root's keys: every intent key, plus Esc and the option digits. */
export function workspaceKeys(app: Pick<ItemIntentApp, 'focused' | 'focusOwner' | 'closeDetail' | 'closeConversation' | 'clearFilters'>): WorkspaceHandlers<HTMLDivElement> {
  return {
    ...intentKeyHandlers<HTMLDivElement>(),
    // Esc closes the answer box first (the editor stops it), then detail, then clears filters.
    escape: () => { if (app.closeConversation) { app.closeConversation(); return true; } app.closeDetail(); app.clearFilters?.(); return false; },
    choose: intent => {
      const focused = app.focused();
      if (!focused || focused.item.status !== 'waiting_on_me' || intent.kind !== 'choose') return false;
      app.focusOwner(focused.target, 'answer', intent.index); return true;
    },
  };
}

/**
 * The intents the App answers: those that act on the current view's selected item, and the view toggles it owns.
 * Hide, Later, Remove and Graph wait while the bigger view covers the Map, as they did before (the top bar owns Search).
 */
export function itemIntents(app: ItemIntentApp): Partial<Record<Intent, IntentHandler>> {
  const closed = ['done', 'decided', 'dropped'];
  const onItem = (act: (focused: FocusedItem, repeat: boolean) => boolean) =>
    ({ repeat }: { readonly repeat: boolean }) => { const focused = app.focused(); return focused ? act(focused, repeat) : false; };
  return {
    'filter.toggle': () => { if (!app.store) return false; app.toggleFilters(); return true; },
    'view.toggleGraph': () => { if (!app.store || app.closeConversation) return false; app.toggleGraph(); return true; },
    'item.ack': onItem(({ target }, repeat) => app.ack(target, repeat)),
    'item.bring': onItem(({ target }, repeat) => { if (!repeat) void app.queueBring(target); return true; }),
    'item.respond': onItem(({ item, target }) => {
      app.focusOwner(target, [...closed, 'replaced'].includes(item.status) ? 'followup' : item.status === 'in_progress' ? 'note' : 'reply'); return true;
    }),
    'item.drop': onItem(({ target }) => { app.focusOwner(target, 'drop'); return true; }),
    'item.reopen': onItem(({ item, target }) => { if (!closed.includes(item.status)) return false; app.focusOwner(target, 'reopen'); return true; }),
    'item.hide': onItem(({ target }, repeat) => !app.closeConversation && (repeat ? true : app.toggleHidden(target))),
    'item.later': onItem(({ item, target }) => !app.closeConversation && app.toggleLater(target, item.id)),
    'item.remove': onItem(({ target }) => !app.closeConversation && app.askRemove({ kind: 'item', item: target })),
  };
}
