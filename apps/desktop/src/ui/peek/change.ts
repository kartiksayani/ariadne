import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import { isChangedSinceRead, isNewToOwner, type SeenState } from '../../selectors/changes/seen';

export interface PeekChange {
  readonly marker: 'new' | 'changed' | null;
  /** "Progress · 21:08." then the agent's reason, or "Changed by your answer:" then the reason. */
  readonly strip: { readonly label: string; readonly text: string } | null;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** What the card says changed: the same New/Changed rule as the Map, and the latest change the owner hasn't seen. */
export function peekChange(session: Immutable<Session>, item: Immutable<Item>, seen: SeenState): PeekChange {
  if (isNewToOwner(item, seen)) return { marker: 'new', strip: null };
  if (!seen || !isChangedSinceRead(item, seen)) return { marker: null, strip: null };
  const read = seen.items.find(value => value.item_id === item.id)?.revision ?? 0, since = Date.parse(seen.since);
  const latest = (item.changes ?? []).filter(record => !record.wording_only && record.revision > read && Date.parse(record.at) > since).at(-1);
  if (!latest) return { marker: 'changed', strip: null };
  const text = latest.reason?.trim() || 'The agent updated this item.';
  const cause = session.messages.find(message => message.id === latest.cause_message_id);
  if (cause?.input_id) return { marker: 'changed', strip: { label: 'Changed by your answer:', text } };
  const what = Object.prototype.hasOwnProperty.call(latest.before, 'options') ? 'Options changed'
    : item.status === 'in_progress' ? 'Progress' : 'Changed';
  return { marker: 'changed', strip: { label: `${what} · ${clock.format(new Date(latest.at))}.`, text } };
}
