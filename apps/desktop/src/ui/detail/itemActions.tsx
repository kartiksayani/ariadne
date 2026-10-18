// One list of what the owner can do to an item, in the hover bar's order (SPEC 6.2). Details builds it once and shows it in
// two places: the actions row in the body, and the head's "…" menu. Each place leaves out what does not apply.
import { useMemo, useRef } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import { HideIcon } from '../shared/HideIcon';
import { closedStatus, statusKey } from './model';

export type ItemActionId = 'followUp' | 'bring' | 'reopen' | 'later' | 'drop' | 'hide' | 'unhide' | 'remove' | 'copyRef';

export interface ItemActionView {
  readonly id: ItemActionId;
  /** Status-dependent for `followUp` ("Reply", "Add a note", "Follow up", "Answer") and `later` ("Later" / "Unpark"). */
  readonly label: string;
  /** A Phosphor class. Empty for Hide / Unhide: draw `ItemActionIcon`. */
  readonly icon: string;
  /** Always runs the latest handler passed to the hook, so a stored copy of the list never goes stale. */
  readonly run: () => void;
  /** The action makes sense for this item's status. A consumer leaves out the rows where this is false. */
  readonly applies: boolean;
  /** Set when `applies` but it cannot run right now (the session is archived, reconnecting, or a message is on its way). */
  readonly disabledReason?: string;
}

export interface ItemActionHandlers {
  readonly hide: () => void;
  readonly unhide: () => void;
  readonly remove: () => void;
  readonly bring: () => void;
  readonly later: () => void;
  readonly reopen: () => void;
  readonly followUp: () => void;
  readonly drop: () => void;
  readonly copyRef: () => void;
}

export interface UseItemActionsInput {
  readonly session: Immutable<Session> | null | undefined;
  readonly item: Immutable<Item> | null | undefined;
  readonly on: ItemActionHandlers;
  /** The item is hidden: the list carries `unhide` instead of `hide`. */
  readonly hidden?: boolean;
  /** The item is parked (Later): the later action reads "Unpark". */
  readonly later?: boolean;
  /** Why the message actions (everything except hide, remove and copy) wait right now. Null or absent when they do not. */
  readonly held?: string | null;
}

/** The props `ItemConversation` takes for this list. W2 passes `onHide` / `onRemove` (App.tsx) and renders the "…" menu from `onActions`. */
export interface ItemActionsProps {
  /** Hide or unhide this item (the one Hide button of the Map's hover bar). */
  readonly onHide?: () => void;
  /** Ask to remove this item (the same path as the hover bar's Remove). */
  readonly onRemove?: () => void;
  /** The current list, emitted when what it shows changes. `null` when Details unmounts or has no item. */
  readonly onActions?: (actions: readonly ItemActionView[] | null) => void;
}

/** The list an item's Details emitted, with the item it belongs to. */
export interface ReportedActions { readonly itemId: string; readonly list: readonly ItemActionView[] }

/**
 * What the owner of `itemId` reports: its list replaces the held one; its `null` (unmount, no item) clears the held list only
 * when that list is the item's own, so a late `null` from the item just left cannot wipe the new item's list. The same list again keeps the held value (no re-render).
 */
export const reportActions = (held: ReportedActions | null, itemId: string, list: readonly ItemActionView[] | null): ReportedActions | null =>
  list ? (held?.itemId === itemId && held.list === list ? held : { itemId, list }) : held?.itemId === itemId ? null : held;

/** The held list when it is `itemId`'s; null for any other item, so the "…" menu never runs against the previous item. */
export const actionsOf = (held: ReportedActions | null, itemId: string | null | undefined): readonly ItemActionView[] | null =>
  held && itemId && held.itemId === itemId ? held.list : null;

const LABEL: Readonly<Record<'open' | 'progress' | 'waiting', string>> = { open: 'Reply', progress: 'Add a note', waiting: 'Answer' };

/** Draws an action's icon, including Hide / Unhide, which use the app's own outline eye. */
export function ItemActionIcon({ action }: { readonly action: Pick<ItemActionView, 'id' | 'icon'> }) {
  if (action.id === 'hide' || action.id === 'unhide') return <HideIcon hidden={action.id === 'unhide'} />;
  return <i className={action.icon} aria-hidden="true" />;
}

/**
 * The item's actions: follow up (reply / note / follow-up by status), Bring it up, Back to Open, Later / Unpark, Drop, then Hide
 * or Unhide, Remove and Copy reference. Every slot is present; `applies` says which fit the item. The returned array is the same
 * object while nothing visible changed, and `run` always calls the latest handler, so the list can be handed upward in an effect.
 */
export function useItemActions({ session, item, on, hidden = false, later = false, held = null }: UseItemActionsInput): readonly ItemActionView[] {
  const handlers = useRef(on);
  handlers.current = on;
  const status = item ? statusKey[item.status] : null;
  const topic = item && session ? session.topics[item.topic_id] : undefined;
  const archived = !!session && (session.archived_at != null || topic?.archived_at != null);
  const readOnly = !session || !item || archived || session.state !== 'active' || !topic;
  const reason = readOnly ? (archived ? 'Archived' : 'This session is closed') : held;
  return useMemo(() => {
    if (!item || status === null) return [];
    const closed = closedStatus.has(status), open = status === 'open';
    const run = (key: keyof ItemActionHandlers) => () => handlers.current[key]();
    const gated = (id: ItemActionId, label: string, icon: string, applies: boolean): ItemActionView =>
      ({ id, label, icon, run: run(id as keyof ItemActionHandlers), applies, ...(applies && reason ? { disabledReason: reason } : {}) });
    const followLabel = closed ? 'Follow up' : LABEL[status as 'open' | 'progress' | 'waiting'] ?? 'Reply';
    return [
      gated('followUp', followLabel, 'ph ph-chat-text', true),
      gated('bring', 'Bring it up', 'ph ph-megaphone-simple', open),
      gated('reopen', 'Back to Open', 'ph ph-arrow-counter-clockwise', closed && status !== 'replaced'),
      gated('later', later ? 'Unpark' : 'Later', later ? 'ph ph-arrow-u-up-left' : 'ph ph-clock', open),
      gated('drop', 'Drop', 'ph ph-x-circle', open),
      hidden ? { id: 'unhide', label: 'Unhide', icon: '', run: run('unhide'), applies: true } as ItemActionView
        : { id: 'hide', label: 'Hide', icon: '', run: run('hide'), applies: true } as ItemActionView,
      { id: 'remove', label: 'Remove', icon: 'ph ph-trash', run: run('remove'), applies: true },
      { id: 'copyRef', label: 'Copy reference', icon: 'ph ph-copy', run: run('copyRef'), applies: true },
    ];
  }, [item?.id, status, hidden, later, reason]);
}
