// Status Badge (handoff README Components; Status Badge.dc.html). The colour
// is the status token; the pill background is that colour at 14%.
import type { StatusKey } from './model';

const MAP: Readonly<Record<StatusKey, { readonly label: string; readonly icon: string }>> = {
  open: { label: 'Open', icon: 'ph ph-circle' },
  waiting: { label: 'Waiting on me', icon: 'ph-fill ph-question' },
  progress: { label: 'In progress', icon: 'ph ph-circle-half' },
  decided: { label: 'Decided', icon: 'ph ph-check-circle' },
  done: { label: 'Done', icon: 'ph-fill ph-check-circle' },
  dropped: { label: 'Dropped', icon: 'ph ph-x-circle' },
  replaced: { label: 'Replaced', icon: 'ph ph-arrow-circle-right' },
};

export function StatusBadge({ status, label, variant = 'pill', size = 17 }: {
  readonly status: StatusKey; readonly label?: string; readonly variant?: 'pill' | 'text' | 'icon'; readonly size?: number;
}) {
  const entry = MAP[status], text = label || entry.label, color = `var(--st-${status}, var(--color-neutral-400))`;
  if (variant === 'icon') return <i className={`${entry.icon} status-badge-icon`} title={text} aria-label={text} style={{ fontSize: size, color }} />;
  return <span className="status-badge" title={text} style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
    {variant === 'pill' && <i className={entry.icon} aria-hidden="true" />}<span>{text}</span>
  </span>;
}
