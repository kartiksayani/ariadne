import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { SeenState } from '../../selectors/changes/seen';
import { detailModel } from './model';

/** Only the initial baseline can be mapped to message time. Item revisions cannot. */
export function conversationDivider(session: Immutable<Session>, itemId: string, seen: SeenState): string | null {
  const item = session.items[itemId];
  if (!item || !seen || seen.items.some(read => read.item_id === itemId)) return null;
  const baseline = Date.parse(seen.since);
  if (!Number.isFinite(baseline)) return null;
  const chat = detailModel({ session, itemId, now: Date.now(), later: false, mode: null, saving: null })?.chat ?? [];
  const times = chat.map(entry => Date.parse(session.messages.find(message => message.id === entry.id)?.created_at ?? ''));
  if (times.some(time => !Number.isFinite(time))) return null;
  const first = times.findIndex(time => time > baseline);
  // Neither an entirely new conversation nor an entirely read one needs a divider.
  if (first <= 0 || times.slice(first).some(time => time <= baseline)) return null;
  return chat[first].id;
}
