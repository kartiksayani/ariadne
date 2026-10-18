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
  /** What each action does. Hide, Unhide and Remove are the host's: without them those rows do not apply. */
  readonly on: Partial<ItemActionHandlers>;
  /** The item is hidden: the list carries `unhide` instead of `hide`. */
  readonly hidden?: boolean;
  /** The item is parked (Later): the later action reads "Unpark". */
  readonly later?: boolean;
  /** Why an action that fits the item cannot run right now (reconnecting, a message on its way). Absent when it can. */
  readonly held?: Readonly<Partial<Record<ItemActionId, string>>>;
  /** Replaces the status-dependent label of `followUp` ("Add a reply" on a waiting item that has one). */
  readonly replyLabel?: string;
  /** Whether `followUp` fits. A waiting item is answered in its answer box, so by default it does not apply there. */
  readonly replyApplies?: boolean;
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
export function useItemActions({ session, item, on, hidden = false, later = false, held, replyLabel, replyApplies }: UseItemActionsInput): readonly ItemActionView[] {
  const handlers = useRef(on);
  handlers.current = on;
  const has = (key: keyof ItemActionHandlers) => !!on[key];
  const status = item ? statusKey[item.status] : null;
  const topic = item && session ? session.topics[item.topic_id] : undefined;
  const archived = !!session && (session.archived_at != null || topic?.archived_at != null);
  const readOnly = !session || !item || archived || session.state !== 'active' || !topic;
  const readOnlyReason = readOnly ? (archived ? 'Archived' : 'This session is closed') : null;
  const heldKey = JSON.stringify(held ?? {}), hide = has('hide'), unhide = has('unhide'), remove = has('remove');
  return useMemo(() => {
    if (!item || status === null) return [];
    const closed = closedStatus.has(status), open = status === 'open';
    const heldBy: Readonly<Partial<Record<ItemActionId, string>>> = JSON.parse(heldKey);
    const run = (key: keyof ItemActionHandlers) => () => handlers.current[key]?.();
    // A message action is blocked by a closed or archived item, or by what the host says holds it; Later is the owner's own mark.
    const gated = (id: Extract<ItemActionId, 'followUp' | 'bring' | 'reopen' | 'later' | 'drop'>, label: string, icon: string, applies: boolean): ItemActionView => {
      const why = readOnlyReason ?? heldBy[id];
      return { id, label, icon, run: run(id), applies, ...(applies && why ? { disabledReason: why } : {}) };
    };
    const followLabel = replyLabel ?? (closed ? 'Follow up' : LABEL[status as 'open' | 'progress' | 'waiting'] ?? 'Reply');
    return [
      gated('followUp', followLabel, 'ph ph-chat-text', replyApplies ?? status !== 'waiting'),
      gated('bring', 'Bring it up', 'ph ph-megaphone-simple', open),
      gated('reopen', 'Back to Open', 'ph ph-arrow-counter-clockwise', closed && status !== 'replaced'),
      gated('later', later ? 'Unpark' : 'Later', later ? 'ph ph-arrow-u-up-left' : 'ph ph-clock', open),
      gated('drop', 'Drop', 'ph ph-x-circle', open),
      hidden ? { id: 'unhide', label: 'Unhide', icon: '', run: run('unhide'), applies: unhide } : { id: 'hide', label: 'Hide', icon: '', run: run('hide'), applies: hide },
      { id: 'remove', label: 'Remove', icon: 'ph ph-trash', run: run('remove'), applies: remove },
      { id: 'copyRef', label: 'Copy reference', icon: 'ph ph-copy', run: run('copyRef'), applies: true },
    ];
  }, [item?.id, status, hidden, later, readOnlyReason, heldKey, replyLabel, replyApplies, hide, unhide, remove]);
}
