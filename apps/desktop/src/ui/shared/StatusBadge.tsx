// Status Badge (handoff README Components; Status Badge.dc.html), shared by
// the tree rows and the detail panel. The colour is the status token; the
// pill background is that colour at 14%.
import { STATUS, statusColor, type StatusKey } from './status';
import './shared.css';

export function StatusBadge({ status, label, variant = 'pill', size = 17 }: {
  readonly status: StatusKey; readonly label?: string; readonly variant?: 'pill' | 'text' | 'icon'; readonly size?: number;
}) {
  const entry = STATUS[status], text = label || entry.label, color = statusColor(status);
  if (variant === 'icon') return <i className={`${entry.icon} status-badge-icon`} role="img" title={text} aria-label={text} style={{ fontSize: `${size}px`, color }} />;
  return <span className="status-badge" title={text} style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
    {variant === 'pill' && <i className={entry.icon} aria-hidden="true" />}<span>{text}</span>
  </span>;
}
