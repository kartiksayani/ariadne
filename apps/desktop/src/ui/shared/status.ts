// The seven statuses as the handoff draws them (README Status model and
// Status Badge.dc.html). Each key names its `--st-*` colour token.
import type { ItemStatus } from '../../generated/domain/models';

export type StatusKey = 'open' | 'waiting' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced';

export const statusKey: Readonly<Record<ItemStatus, StatusKey>> = {
  open: 'open', waiting_on_me: 'waiting', in_progress: 'progress', decided: 'decided', done: 'done', dropped: 'dropped', replaced: 'replaced',
};

export const STATUS: Readonly<Record<StatusKey, { readonly label: string; readonly icon: string }>> = {
  open: { label: 'Open', icon: 'ph ph-circle' },
  waiting: { label: 'Waiting on me', icon: 'ph-fill ph-question' },
  progress: { label: 'In progress', icon: 'ph ph-circle-half' },
  decided: { label: 'Decided', icon: 'ph ph-check-circle' },
  done: { label: 'Done', icon: 'ph-fill ph-check-circle' },
  dropped: { label: 'Dropped', icon: 'ph ph-x-circle' },
  replaced: { label: 'Replaced', icon: 'ph ph-arrow-circle-right' },
};

export const statusColor = (status: StatusKey): string => `var(--st-${status})`;
