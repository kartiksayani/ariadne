// The App's share of the keys (C4, converted to intents for C5). Keys that only make sense where focus is
// (Esc, the option digits) stay key handlers; every other workspace key asks for an intent (ui/keys.ts
// `keyIntents`), and the App answers the ones that act on the current view's selected item.
import type { ItemRoute } from '../../generated/core';
import type { OwnerFocusRequest } from '../answer/useSubmit';
import type { RemoveTarget } from '../dialogs/remove';
import type { Intent, IntentHandler } from '../intents';
import { intentKeyHandlers, type WorkspaceHandlers } from '../keys';
import { scrollingDetails, startDetailScroll } from './detailScroll';

export type TreeRemoveTarget = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;
export interface FocusedItem { readonly item: { readonly id: string; readonly status: string; readonly topic_id: string }; readonly target: ItemRoute }
export interface ItemIntentApp {
  readonly store: boolean;
  /** A page (Projects, All sessions, Archive) shows: the Map's selection is hidden behind it, so item keys and Esc do nothing. */
  readonly onPage: boolean;
  readonly toggleFilters: () => void;
  /** The current view's selected item: the conversation's item in the bigger view, else the Map's selection. Never the row under the pointer. */
  readonly focused: () => FocusedItem | null;
  readonly focusOwner: (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number) => void;
  /** Opens the question's Details and sends option `index` of it at once, with the answer box's guards. False when nothing was started. */
  readonly quickAnswer: (target: ItemRoute, index: number) => boolean;
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
export function workspaceKeys(app: Pick<ItemIntentApp, 'focused' | 'focusOwner' | 'quickAnswer' | 'closeDetail' | 'closeConversation' | 'clearFilters' | 'onPage'>): WorkspaceHandlers<HTMLDivElement> {
  // An open menu owns its keys; the answer dock sends its own question, never the Map's selected one.
  const menuOpen = () => !!document.querySelector('[role="menu"]');
  return {
    ...intentKeyHandlers<HTMLDivElement>(),
    // Esc closes the answer box first (the editor stops it), then detail, then clears filters. On a page it is not the Map's.
    escape: () => { if (app.onPage) return false; if (app.closeConversation) { app.closeConversation(); return true; } app.closeDetail(); app.clearFilters?.(); return false; },
    choose: intent => {
      const focused = app.focused();
      if (!focused || focused.item.status !== 'waiting_on_me' || intent.kind !== 'choose') return false;
      app.focusOwner(focused.target, 'answer', intent.index); return true;
    },
    // ⌥1–9: pick option N of the selected waiting question and send it at once (the guards live in App's quickAnswer).
    'choose-send': (intent, event) => {
      const focused = app.focused();
      if (!focused || focused.item.status !== 'waiting_on_me' || intent.kind !== 'choose-send' || menuOpen()
        || (event.target instanceof Element && event.target.closest('.answer-dock'))) return false;
      return app.quickAnswer(focused.target, intent.index);
    },
    // ⌥↑ / ⌥↓: scroll Details while the keys are down; the Map's selection and scroll stay where they are. Key-repeat presses
    // of a scroll already running are swallowed, never stepped.
    'details-up': (_intent, event) => event.repeat ? scrollingDetails('up') : !menuOpen() && startDetailScroll('up', event),
    'details-down': (_intent, event) => event.repeat ? scrollingDetails('down') : !menuOpen() && startDetailScroll('down', event),
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
