// The archive strip from the owner's own archive receipt (E12). `topic_archive` publishes its receipt, then reads the session
// (the topic goes), then the lifecycle keeps the strip's Undo: one render where the topic is gone with nothing in its place.
// The hold would hand the reading row to a row above, and the strip would land below it. Bridging that render puts the strip
// in the topic's place in the same commit the topic goes.
import { useRef } from 'react';
import type { Immutable } from '../../data';
import type { MutationReceipt } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { Archived } from '../shared/useSessionLifecycle';

/** What the bridge reads of the session's action state. */
export interface ArchiveAction {
  readonly receipt: Immutable<MutationReceipt> | null;
  readonly error: unknown;
}

/**
 * The topic archived this visit: the lifecycle's, or until the lifecycle keeps it, the one the owner's latest receipt archived
 * (the session read already shows it archived). Only a receipt that arrives while this view is drawn for `scope` (the
 * session's route) bridges: the receipt current when the view was drawn or the route changed is an earlier visit's, whose
 * strip and Undo the lifecycle has let go. A receipt the lifecycle has kept bridges no more, so an Undo or a dismissal never
 * brings its strip back; nor does one whose follow-up read failed.
 */
export function useArchiveBridge(action: ArchiveAction, archived: Archived | null, session: Immutable<Session> | null, scope: string): Archived | null {
  const kept = useRef<Immutable<MutationReceipt> | null>(null);
  const visit = useRef<{ readonly scope: string; readonly receipt: Immutable<MutationReceipt> | null } | null>(null);
  const bridged = useRef<{ readonly receipt: Immutable<MutationReceipt>; readonly value: Archived } | null>(null);
  const receipt = action.receipt;
  if (visit.current?.scope !== scope) visit.current = { scope, receipt };
  if (archived) { if (receipt) kept.current = receipt; return archived; }
  const data = receipt && 'data' in receipt ? receipt.data : undefined;
  if (!receipt || receipt === visit.current.receipt || kept.current === receipt || action.error
    || data?.kind !== 'topic_lifecycle' || data.archived_at === null) return null;
  const topic = session?.topics[data.topic_id];
  if (!topic || topic.archived_at === null) return null;
  if (bridged.current?.receipt !== receipt) {
    bridged.current = { receipt, value: { topicId: topic.id, name: topic.short?.trim() || topic.name, waiting: 0, cancelled: 0 } };
  }
  return bridged.current.value;
}
