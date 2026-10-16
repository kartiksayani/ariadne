import type { KeyboardEvent } from 'react';
import type { ItemRoute } from '../../generated/core';
import type { OwnerFocusRequest } from '../answer/useSubmit';
import type { RemoveTarget } from '../dialogs/remove';
import type { WorkspaceHandlers, WorkspaceIntent } from '../keys';

export type TreeRemoveTarget = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;
export interface FocusedItem { readonly item: { readonly id: string; readonly status: string; readonly topic_id: string }; readonly target: ItemRoute }
/** The App's share of the workspace keymap: actions on the focused or selected item, views and Esc. */
export function workspaceKeys(app: {
  readonly store: boolean;
  readonly focused: (event: KeyboardEvent<HTMLDivElement>) => FocusedItem | null;
  readonly oldestWaiting: () => ItemRoute | undefined;
  readonly focusOwner: (target: ItemRoute, intent: OwnerFocusRequest['intent'], optionIndex?: number) => void;
  readonly quickAnswer: (target: ItemRoute, index?: number) => boolean;
  readonly ack: (target: ItemRoute, repeat: boolean) => boolean;
  readonly queueBring: (target: ItemRoute) => Promise<void>;
  readonly toggleHidden: (target: ItemRoute) => boolean;
  readonly toggleLater: (target: ItemRoute, itemId: string) => boolean;
  readonly archiveTopic: (topicId: string) => boolean;
  readonly toggleGraph: () => void;
  readonly closeDetail: () => void;
  readonly closeConversation?: () => void;
  readonly clearFilters?: () => void;
  readonly askRemove: (target: TreeRemoveTarget) => boolean;
}): WorkspaceHandlers<HTMLDivElement> {
  const closed = ['done', 'decided', 'dropped'];
  const onItem = (act: (focused: FocusedItem, intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => boolean | void) =>
    (intent: WorkspaceIntent, event: KeyboardEvent<HTMLDivElement>) => { const focused = app.focused(event); return focused ? act(focused, intent, event) : false; };
  const search = () => {
    if (!app.store || app.closeConversation) return false;
    document.querySelector<HTMLInputElement>('[data-shell-search]')?.focus(); return true;
  };
  return {
    search,
    // Esc closes the answer box first (the editor stops it), then detail, then clears filters.
    escape: () => { if (app.closeConversation) { app.closeConversation(); return true; } app.closeDetail(); app.clearFilters?.(); return false; },
    answer: (_intent, event) => {
      const focused = app.focused(event);
      if (focused && app.ack(focused.target, event.repeat)) return true;
      const question = focused && focused.item.status === 'waiting_on_me' ? focused.target : app.closeConversation ? undefined : app.oldestWaiting();
      if (!question) return false;
      app.focusOwner({ ...question }, 'answer'); return true;
    },
    bring: onItem(({ target }, _intent, event) => { if (!event.repeat) void app.queueBring(target); return true; }),
    respond: onItem(({ item, target }) => {
      app.focusOwner(target, [...closed, 'replaced'].includes(item.status) ? 'followup' : item.status === 'in_progress' ? 'note' : 'reply'); return true;
    }),
    drop: onItem(({ target }) => { app.focusOwner(target, 'drop'); return true; }),
    reopen: onItem(({ item, target }) => { if (!closed.includes(item.status)) return false; app.focusOwner(target, 'reopen'); return true; }),
    choose: onItem(({ item, target }, intent) => {
      if (item.status !== 'waiting_on_me' || intent.kind !== 'choose') return false;
      app.focusOwner(target, 'answer', intent.index); return true;
    }),
    'choose-send': onItem(({ item, target }, intent) => item.status === 'waiting_on_me' && intent.kind === 'choose-send' && app.quickAnswer(target, intent.index)),
    'answer-words': onItem(({ item, target }) => item.status === 'waiting_on_me' && app.quickAnswer(target)),
    hide: onItem(({ target }, _intent, event) => !app.closeConversation && (event.repeat ? true : app.toggleHidden(target))),
    later: onItem(({ item, target }) => !app.closeConversation && app.toggleLater(target, item.id)),
    archive: onItem(({ item }) => !app.closeConversation && app.archiveTopic(item.topic_id)),
    graph: () => { if (!app.store || app.closeConversation) return false; app.toggleGraph(); return true; },
    // ⌫/Delete away from a row: ask to remove the focused or selected item (rows handle their own).
    remove: onItem(({ target }) => !app.closeConversation && app.askRemove({ kind: 'item', item: target })),
  };
}
