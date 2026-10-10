import type { BindingSummary, Input, PresenceObservation, Session } from '../../generated/domain/models';
import type { Immutable } from '../../data';
import { awaitingAnswer } from './stuck';

export type DeliveryKind = 'cancelled' | 'skipped' | 'handled' | 'uncertain' | 'rejected' | 'failed'
  | 'missing' | 'waiting_result' | 'published' | 'received' | 'sent' | 'sending' | 'queued' | 'saved' | 'unavailable';
export interface DeliveryEvidence {
  readonly kind: DeliveryKind;
  readonly label: string;
  readonly detail: string;
}
const labels: Record<DeliveryKind, readonly [string, string]> = {
  cancelled: ['Cancelled', 'The saved input was cancelled.'],
  skipped: ['Skipped', 'An explicit owner resolution skipped this input.'],
  handled: ['Handled', 'The matching host turn and explicit domain result are complete.'],
  uncertain: ['Delivery uncertain', 'The agent may have got this message. Check before sending more.'],
  rejected: ['Rejected before delivery', 'The host rejected this attempt before delivery. This does not authorize automatic retry.'],
  failed: ['Failed', 'The matching host turn failed or was interrupted.'],
  missing: ['Missing result', 'The matching host turn ended without a committed explicit result.'],
  waiting_result: ['Waiting for result', 'The agent turn finished. An explicit domain result has not been committed.'],
  published: ['Reply published · agent working', 'An explicit result is committed; the matching turn is still incomplete.'],
  received: ['Received · agent working', 'The matching host turn is running.'],
  sent: ['Delivered · awaiting agent receipt', 'The host accepted this exact attempt; a matching turn has not started.'],
  sending: ['Delivering', 'The exact prepared attempt is awaiting delivery evidence.'],
  queued: ['Queued · waiting for connection', 'The input is saved while the bound host is unavailable, paused or busy.'],
  saved: ['Saved', 'The input is saved. No delivery is established.'],
  unavailable: ['Delivery evidence unavailable', 'Ariadne can’t tell what happened to this message yet. Refresh to check again.'],
};
function evidence(kind: DeliveryKind): DeliveryEvidence {
  return Object.freeze({ kind, label: labels[kind][0], detail: labels[kind][1] });
}
export function deliveryEvidence(input: Immutable<Input>, binding: Immutable<BindingSummary> | null,
  receipts: Immutable<Session>['operation_receipts'] = {},
  observedPresence: Immutable<PresenceObservation> | null = null): DeliveryEvidence {
  if (input.state === 'cancelled' || input.state === 'skipped' || input.state === 'handled') return evidence(input.state);
  if (input.active_attempt_id === null) {
    if (input.state !== 'queued') return evidence('unavailable');
    if (binding && binding.id !== input.binding_id) return evidence('unavailable');
    const presence = observedPresence ?? binding?.presence;
    const busy = presence?.generation === binding?.generation && presence?.freshness === 'fresh'
      && presence.connection_state === 'connected' && ['running', 'waiting_for_approval'].includes(presence.execution_state);
    return evidence(!binding || binding.connection_state !== 'connected' || binding.owner_paused
      || binding.dispatch_state !== 'enabled' || busy ? 'queued' : 'saved');
  }
  const attempt = input.attempts.find(attempt => attempt.id === input.active_attempt_id);
  if (!attempt || attempt.sealed_at !== null) return evidence('unavailable');
  const conflict = Object.values(receipts).some(entries => entries?.some(receipt =>
    receipt.actor_scope.kind === 'adapter' && receipt.actor_scope.binding_id === input.binding_id
    && receipt.result.data.kind === 'event_conflict' && receipt.result.data.input_id === input.id
    && receipt.result.data.attempt_id === attempt.id));
  if (conflict || attempt.acceptance === 'uncertain' || attempt.error?.code === 'protocol_conflict'
      || attempt.error?.code === 'delivery_uncertain') return evidence('uncertain');
  if (awaitingAnswer(input)) return evidence('missing');
  if (attempt.acceptance === 'rejected') return evidence('rejected');
  if (attempt.turn_state === 'failed' || attempt.turn_state === 'interrupted') return evidence('failed');
  if (attempt.result_state === 'missing') return evidence('missing');
  if (attempt.turn_state === 'completed') return evidence(attempt.result_state === 'pending' ? 'waiting_result' : 'unavailable');
  if (attempt.result_state === 'committed') return evidence('published');
  if (attempt.turn_state === 'running') return evidence('received');
  if (attempt.acceptance === 'accepted') return evidence('sent');
  if (attempt.acceptance === 'prepared') return evidence('sending');
  return evidence('unavailable');
}
