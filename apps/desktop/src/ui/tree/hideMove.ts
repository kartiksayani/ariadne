// Hide moves on (alpha.24): hiding the selected item, or an ancestor of it, selects the next item on the same level, else the
// previous one, else the parent; the Map does not move. The view on screen (the Map, or the Graph in its place) says what it
// will show once the item is hidden, and presents the move in the same update the hide's write publishes.
import { indexSession, type Immutable } from '../../data';
import type { RevealedItem } from '../../data/routes';
import type { SessionPreferences, SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { Row } from './model';

/**
 * The item selected once `hiddenId` is hidden: the next of its siblings (same topic, same parent) that the view shows as an
 * ordinary row, else the previous one, else its nearest shown ancestor, else none. `shown` lists the items the view shows as
 * ordinary rows once the item is hidden, in display order; dimmed rows of an open hidden group are not in it.
 */
export function selectionAfterHide(session: Immutable<Session>, hiddenId: string, shown: readonly string[]): string | null {
  const item = session.items[hiddenId];
  if (!item) return null;
  const siblings = (indexSession(session).childrenByParent.get(item.parent) ?? []).filter(value => value.topic_id === item.topic_id);
  const rank = new Map(siblings.map((value, index) => [value.id, index])), mine = rank.get(hiddenId) ?? -1;
  const candidates = shown.filter(id => id !== hiddenId && rank.has(id));
  const next = candidates.find(id => rank.get(id)! > mine) ?? [...candidates].reverse().find(id => rank.get(id)! < mine);
  if (next) return next;
  const visible = new Set(shown), seen = new Set<string>();
  for (let id = item.parent; id && !seen.has(id); id = session.items[id]?.parent ?? null) {
    if (visible.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/** The items a Map shows as ordinary rows, in its order: context and revealed rows count, dimmed hidden rows do not. */
export const shownItems = (rows: readonly Row[]): string[] => rows.flatMap(row => row.kind === 'item' && !row.hidden ? [row.key] : []);

/** What a hide (or its Undo) moved the selection to, for the view on screen to show without moving. */
export interface HideMove {
  readonly kind: 'hide' | 'unhide';
  /** The item hidden, or unhidden by Undo. */
  readonly itemId: string;
  /** The item selected now, as the view's own reveal (a click echo: no scroll, no centring); null when none is. */
  readonly own: RevealedItem | null;
  /** Whether the view selection moves (false when only the bigger view's item follows the rule, and for a plain Unhide). */
  readonly select: boolean;
  /** The session view the write saves (an unhide's: where the item comes back, and whether Focus comes back with it). */
  readonly after?: Immutable<SessionPreferences>;
}

export interface HideView {
  readonly route: SessionRef;
  /** The item to select once `itemId` is hidden, from the view as it will show `after` (the saved view with the hide in it). */
  choose(itemId: string, after: Immutable<SessionPreferences>): string | null;
  /**
   * The item the owner chose in this view while the hide's write was in flight, outside what the hide takes (`going`): that
   * newer choice stays selected instead of the hide's (S3). Null when there is none.
   */
  newer?(going: ReadonlySet<string>): string | null;
  /** Called in the update that publishes the write, before it publishes: the view takes the move as its own. */
  present(move: HideMove): void;
}

/** The mounted views that answer for their session: the Map registers while it shows rows, the Graph while it is open. */
export const hideViews = new Set<HideView>();
export const hideViewFor = (route: SessionRef): HideView | null =>
  [...hideViews].find(view => view.route.project_id === route.project_id && view.route.session_id === route.session_id) ?? null;
