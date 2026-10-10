// What a failure says to the owner. Core's own error messages and hints are written for
// logs ("The session revision changed before cancellation"), so the screen never shows
// them: each known error code has one plain sentence, and anything else reads
// "Ariadne couldn't do that. Try again." The raw detail goes to the console for diagnostics.
import { CoreFailure, ServiceFailure } from './service';
import type { CoreErrorCode } from '../generated/core';

export const COULDNT_DO_THAT = 'Ariadne couldn’t do that. Try again.';
const changed = 'This changed while you were working. Look at it as it is now, then try again.';
const connection = 'The agent connection changed. Check the connection, then try again.';
const WORDS: Readonly<Partial<Record<CoreErrorCode, string>>> = {
  invalid_argument: 'Something in that isn’t valid. Check it and try again.',
  not_found: 'Ariadne can’t find that any more. It may have been removed.',
  invalid_ref: 'Ariadne can’t find that item in this session.',
  binding_ambiguous: connection, binding_mismatch: connection, binding_conflict: connection, stale_generation: connection,
  incompatible_adapter: 'Ariadne can’t work with that agent.',
  unsupported_host_version: 'Ariadne can’t work with this version of the agent. Update it and try again.',
  unsupported: 'Ariadne can’t do that with this agent.',
  host_unreachable: 'Ariadne couldn’t reach the agent. Check that it is running, then try again.',
  revision_conflict: changed, snapshot_changed: changed, question_changed: changed, invalid_transition: changed,
  unhandled_owner_message: 'The agent hasn’t handled an earlier message yet. Wait for it, then try again.',
  result_already_committed: 'The agent already saved its answer.',
  attempt_sealed: 'That message was already settled.',
  result_missing: 'The agent hasn’t saved its answer yet. It may still be working.',
  delivery_uncertain: 'Ariadne isn’t sure whether the agent got the message. Check before sending it again.',
  queue_full: 'Too many messages are waiting. Let the agent catch up, then try again.',
  topic_not_archivable: 'This topic can’t be archived right now.',
  session_not_closable: 'This session can’t be closed right now.',
  preview_stale: 'The summary is out of date. Prepare it again.',
  io_error: 'Ariadne couldn’t read or save its data. Try again.',
  store_busy: 'Ariadne is busy with something else. Try again in a moment.',
  capacity_exceeded: 'That is too large for Ariadne to keep.',
  commit_uncertain: 'Ariadne isn’t sure that change was saved.',
  corrupt_session: 'Ariadne can’t read this session’s saved data.',
  future_schema: 'This session was saved by a newer Ariadne. Update Ariadne to open it.',
  permission_denied: 'Ariadne isn’t allowed to do that. Check the folder’s permissions.',
  protocol_conflict: 'Ariadne and the agent disagree about what happened. Try again.',
  control_path_too_long: 'That folder’s path is too long for Ariadne to use.',
};

/**
 * For registering a project and connecting a session only: core words those refusals for the owner
 * ("Folder not found: …", "Check the folder path, then register again."), so they are shown as written.
 */
export function registrationFailure(failure: unknown): string {
  return failure instanceof CoreFailure && !(failure instanceof OwnFailure) ? `${failure.error.message} ${failure.error.hint}`.trim() : plainFailure(failure);
}

/** A failure Ariadne raised itself, whose message is already written for the owner. */
export class OwnFailure extends CoreFailure {}

/**
 * What to say when opening the original of a copied item failed. Core sends `io_error` when the project's folder is
 * missing or can't be read: say which folder and what to do. It sends `not_found` when the original session was removed
 * or its project is no longer registered: the folder is fine, the item is gone. Null for any other failure, which
 * `plainFailure` words. The folder's path is the owner's own; the OS reason goes to the console only.
 */
export function originalFailure(failure: unknown, path: string | null): string | null {
  if (!(failure instanceof CoreFailure) || failure instanceof OwnFailure || !['not_found', 'io_error'].includes(failure.error.code)) return null;
  console.debug('Ariadne core error', failure.error.code, failure.error.message, failure.error.hint);
  if (failure.error.code === 'not_found') return 'The original item is no longer in Ariadne.';
  return `The original project folder ${path ? `(${path}) ` : ''}is missing or can’t be read. Restore it or move it back, then try again.`;
}

/** One plain sentence for a failure; `fallback` replaces "Ariadne couldn't do that" where the caller knows what was attempted. */
export function plainFailure(failure: unknown, fallback: string = COULDNT_DO_THAT): string {
  if (failure instanceof OwnFailure) return failure.message;
  if (failure instanceof CoreFailure) {
    console.debug('Ariadne core error', failure.error.code, failure.error.message, failure.error.hint);
    return WORDS[failure.error.code] ?? fallback;
  }
  if (failure instanceof ServiceFailure) {
    console.debug('Ariadne service error', failure.reason);
    return failure.reason === 'transport' ? 'Ariadne couldn’t reach its background service. Try again.' : fallback;
  }
  return fallback;
}
