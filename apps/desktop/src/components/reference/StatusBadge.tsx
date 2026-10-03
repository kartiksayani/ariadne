import '../../styles/reference.css';

export const STATUS = {
  open: { label: 'Open', icon: 'ph ph-circle' },
  waiting: { label: 'Waiting on me', icon: 'ph-fill ph-question' },
  progress: { label: 'In progress', icon: 'ph ph-circle-half' },
  decided: { label: 'Decided', icon: 'ph ph-check-circle' },
  done: { label: 'Done', icon: 'ph-fill ph-check-circle' },
  dropped: { label: 'Dropped', icon: 'ph ph-x-circle' },
  replaced: { label: 'Replaced', icon: 'ph ph-arrow-circle-right' },
} as const;
// Source visual roles, not a domain wire-status schema.
export type Status = keyof typeof STATUS;
export type StatusBadgeProps = { status: Status; variant?: 'pill' | 'text' | 'icon'; label?: string; size?: number };

export function StatusBadge({ status, variant = 'pill', label, size = 17 }: StatusBadgeProps) {
  const visual = STATUS[status];
  const text = label || visual.label;
  const color = `var(--st-${status})`;
  if (variant === 'icon') return <i className={visual.icon} role="img" title={text} aria-label={text} style={{ display: 'block', lineHeight: 1, fontSize: size, color }} />;
  return <span className="ref-status" title={text} style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
    {variant === 'pill' && <i className={visual.icon} aria-hidden="true" style={{ fontSize: 14 }} />}<span>{text}</span>
  </span>;
}
