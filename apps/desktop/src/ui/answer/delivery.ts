// The owner-facing delivery line (handoff `deliveryOf`) and stepper (`stepsOf`).
// Stages come from persisted input evidence (`selectors/waiting/delivery.ts`)
// or from the draft store before the input exists; nothing here infers timing.
import type { InputKind } from '../../generated/domain/models';
import type { DeliveryKind } from '../../selectors/waiting/delivery';
import type { DraftEntry } from '../../state/drafts/store';

/** Sending → Received, plus Queued (agent not running), Checking (reconcile first) and Failed (Retry; the answer is kept). */
export type DeliveryStage = 'queued' | 'sending' | 'received' | 'checking' | 'failed';

/**
 * Nearest handoff stage for each evidence kind. Gaps: "Received" here means the
 * host turn is running, not that the agent fetched the input; `missing` (the
 * turn ended without a result) has no handoff stage and shows as received.
 */
const stages: Readonly<Record<DeliveryKind, DeliveryStage | null>> = {
  queued: 'queued', saved: 'sending', sending: 'sending', sent: 'sending',
  received: 'received', published: 'received', waiting_result: 'received', missing: 'received',
  uncertain: 'checking', unavailable: 'checking',
  failed: 'failed', rejected: 'failed',
  handled: null, cancelled: null, skipped: null,
};
export const deliveryStage = (kind: DeliveryKind): DeliveryStage | null => stages[kind];

/** Stage of a draft whose input is not in the session yet: saving, saved, unknown or refused. */
export function draftStage(entry: DraftEntry): DeliveryStage | null {
  if (entry.saving || entry.receipt) return 'sending';
  if (entry.uncertain) return entry.rejected ? 'failed' : 'checking';
  return entry.error ? 'failed' : null;
}

export interface DeliveryLine {
  readonly icon: string;
  readonly color: string;
  readonly text: string;
}
const muted = 'color-mix(in srgb, var(--color-text) 66%, transparent)';

/** “label”, cut to 38 characters and an ellipsis past 40. */
export const quote = (text: string): string => `“${text.length > 40 ? `${text.slice(0, 38)}…` : text}”`;

type Kind = InputKind;
const sending = (label: string, agent: string): Record<Kind, string> => ({
  answer: `Sending ${label}…`, bring: 'Asking the agent to bring this up…', reply: 'Sending your reply…', drop: 'Sending your drop request…',
  note: 'Sending your note…', followup: 'Sending your follow-up…', reopen: 'Asking the agent to reopen this…', continue: `Sending the topic summary to ${agent}…`,
  removed: `Telling ${agent}…`, topic_reply: 'Sending your reply on this topic…',
});
const received = (label: string, agent: string): Record<Kind, string> => ({
  answer: `You answered ${label} · received, waiting for the agent`, bring: 'Asked the agent to bring this up · received, waiting for the agent',
  reply: 'Your reply was received · waiting for the agent', drop: 'Drop request received · waiting for the agent',
  note: 'Note received · the agent is folding it in', followup: 'Follow-up received · waiting for the agent',
  reopen: 'Reopen request received · waiting for the agent', continue: 'Summary received · the agent is picking the topic up',
  removed: `${agent} was told and won't bring them up again.`, topic_reply: 'Your reply on this topic was received · waiting for the agent',
});

/** The line under a card or Sent row. `label` is the chosen option or the reply text; `agent` the receiving agent's name. */
export function deliveryLine(stage: DeliveryStage, kind: InputKind, label: string, agent: string): DeliveryLine {
  const quoted = quote(label), key: Kind = kind;
  if (stage === 'queued') return { icon: 'ph ph-hourglass-medium', color: muted, text: `Queued for ${agent || 'the agent'} · delivers when it’s running again` };
  if (stage === 'sending') return { icon: 'ph ph-paper-plane-tilt', color: muted, text: sending(quoted, agent)[key] };
  if (stage === 'received') return { icon: 'ph ph-check', color: 'var(--a-acc-text)', text: received(quoted, agent)[key] };
  if (stage === 'checking') return { icon: 'ph ph-circle-notch', color: muted, text: `Checking whether ${quoted} was delivered…` };
  return { icon: 'ph ph-warning-circle', color: 'var(--a-warn)', text: `Couldn’t deliver ${quoted}. Your answer is kept.` };
}

export interface DeliveryStep {
  readonly label: string;
  /** done: before the current step; current; todo: after it. */
  readonly state: 'done' | 'current' | 'todo';
  readonly failed: boolean;
}
/**
 * The four-step stepper for the detail panel's "Your answer" section:
 * Sending, Received, In progress, Resolved. `stage` is the live submission's;
 * without one, an answered item shows In progress or Resolved.
 */
export function deliverySteps(stage: DeliveryStage | null, answered: 'in_progress' | 'resolved' | null): readonly DeliveryStep[] | null {
  const current = stage ? (stage === 'received' ? 1 : 0) : answered === 'in_progress' ? 2 : answered === 'resolved' ? 3 : -1;
  if (current < 0) return null;
  return ['Sending', 'Received', 'In progress', 'Resolved'].map((label, index) => ({
    label: index === 0 && stage === 'failed' ? 'Not delivered' : index === 0 && stage === 'checking' ? 'Checking…' : index === 0 && stage === 'queued' ? 'Queued' : label,
    state: index < current ? 'done' : index === current ? 'current' : 'todo',
    failed: index === current && stage === 'failed',
  }));
}
