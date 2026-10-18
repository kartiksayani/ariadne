// Domain statuses plus the owner's local Sent and Queued delivery projections.
import type { DisplayStatus } from '../../selectors/waiting/replied';

export type StatusKey = 'open' | 'waiting' | 'agent' | 'queued' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';

export const statusKey: Readonly<Record<DisplayStatus, StatusKey>> = {
  open: 'open', waiting_on_me: 'waiting', sent: 'agent', queued: 'queued', in_progress: 'progress', decided: 'decided', done: 'done', dropped: 'dropped', replaced: 'replaced',
};

export const STATUS: Readonly<Record<StatusKey, { readonly label: string; readonly icon: string }>> = {
  open: { label: 'Open', icon: 'ph ph-circle' },
  waiting: { label: 'Waiting on me', icon: 'ph-fill ph-question' },
  agent: { label: 'Sent', icon: 'ph ph-paper-plane-tilt' },
  queued: { label: 'Queued', icon: 'ph ph-hourglass-medium' },
  progress: { label: 'In progress', icon: 'ph ph-circle-half' },
  decided: { label: 'Decided', icon: 'ph ph-check-circle' },
  done: { label: 'Done', icon: 'ph-fill ph-check-circle' },
  dropped: { label: 'Dropped', icon: 'ph ph-x-circle' },
  replaced: { label: 'Replaced', icon: 'ph ph-arrows-clockwise' },
};

export const statusColor = (status: StatusKey): string => `var(--st-${status === 'queued' ? 'open' : status})`;
