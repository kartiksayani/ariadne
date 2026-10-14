import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import type { SeenState } from '../../selectors/changes/seen';
import { detailModel } from './model';

/** Apply receipts describe the atomic batch's final revision, including replies without change records. */
function messageRevisions(session: Immutable<Session>, item: Immutable<Item>): Map<string, number> | null {
  const revisions = new Map<string, number>();
  const messages = new Map(session.messages.map(message => [message.id, message]));
  const involved = new Set([item.created_message_id, ...item.updated_message_ids,
    ...(item.changes ?? []).map(change => change.cause_message_id)]);
  for (const receipts of Object.values(session.operation_receipts)) {
    for (const receipt of receipts ?? []) {
      const data = receipt.result.data;
      if (data.kind !== 'apply') continue;
      const revision = data.item_revisions[item.id];
      if (revision === undefined) continue;
      if (!Number.isSafeInteger(revision) || revision < 1 || revision > item.revision) return null;
      let batchTime: number | undefined;
      for (const identity of data.messages) {
        const message = messages.get(identity.id);
        if (!message || !involved.has(identity.id) && message.item_id !== item.id && !message.items_touched.includes(item.id)) continue;
        const time = Date.parse(message.created_at);
        if (!Number.isFinite(time) || batchTime !== undefined && time !== batchTime || message.number !== identity.number
          || revisions.has(identity.id) && revisions.get(identity.id) !== revision) return null;
        batchTime = time;
        revisions.set(identity.id, revision);
      }
    }
  }
  // Creation reaches revision one. A retained receipt can prove that the same
  // atomic batch made further changes before the new item became visible.
  if (!revisions.has(item.created_message_id)) {
    const created = messages.get(item.created_message_id);
    if (item.origin || !created || Date.parse(created.created_at) !== Date.parse(item.created_at)
      || (item.changes ?? []).some(change => change.cause_message_id === item.created_message_id)) return null;
    revisions.set(item.created_message_id, 1);
  }
  // A parent's opening is contextual history. Its earlier message number proves
  // that it already existed when this child was created, even without child receipts.
  const parent = item.parent ? session.items[item.parent] : undefined;
  const context = parent ? messages.get(parent.created_message_id) : undefined;
  const created = messages.get(item.created_message_id);
  if (context && created && !revisions.has(context.id) && context.number < created.number
    && Date.parse(context.created_at) <= Date.parse(created.created_at)) revisions.set(context.id, 0);
  for (const change of item.changes ?? []) {
    const message = messages.get(change.cause_message_id);
    const revision = revisions.get(change.cause_message_id);
    // A change cause alone does not cover later replies or other operations in
    // its batch. It validates a receipt, but cannot replace a missing receipt.
    if (!message || !Number.isFinite(Date.parse(change.at)) || Date.parse(change.at) !== Date.parse(message.created_at)
      || revision !== undefined && change.revision > revision) return null;
  }
  return revisions;
}

/** Keep a boundary only when every agent entry has exact evidence on the same side of the read revision. */
export function conversationDivider(session: Immutable<Session>, itemId: string, seen: SeenState): string | null {
  const item = session.items[itemId];
  if (!item || !seen) return null;
  const read = seen.items.find(value => value.item_id === itemId);
  if (read && (!Number.isSafeInteger(read.revision) || read.revision < 1 || read.revision >= item.revision)) return null;
  const chat = detailModel({ session, itemId, now: Date.now(), later: false, mode: null, saving: null })?.chat ?? [];
  const messages = new Map(session.messages.map(message => [message.id, message]));
  const revisions = read ? messageRevisions(session, item) : null;
  const baseline = Date.parse(seen.since);
  if (read ? !revisions : !Number.isFinite(baseline)) return null;
  const unread: boolean[] = [];
  let previousRevision = 0;
  for (const entry of chat) {
    // Owner messages, including inputs whose message page is still arriving,
    // are already known to their author and never anchor the divider.
    if (entry.message.author === 'me') { unread.push(false); continue; }
    const message = messages.get(entry.id);
    const time = Date.parse(message?.created_at ?? '');
    const revision = revisions?.get(entry.id);
    if (!Number.isFinite(time) || read && (revision === undefined || revision < previousRevision)) return null;
    previousRevision = revision ?? 0;
    unread.push(read ? revision! > read.revision : time > baseline);
  }
  const first = unread.indexOf(true);
  // Neither an entirely new conversation nor an entirely read one needs a divider.
  if (first <= 0 || chat.slice(first).some((entry, index) => entry.message.author !== 'me' && !unread[first + index])) return null;
  return chat[first].id;
}
