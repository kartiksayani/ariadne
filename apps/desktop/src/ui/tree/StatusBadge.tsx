// "Status Badge" of the handoff: the 17px icon and the text badge.
import { STATUS, statusColor, type Visual } from './model';

export function StatusIcon({ status, size = 17 }: { status: Visual; size?: number }) {
  const value = STATUS[status];
  return <i className={`${value.icon} tree-status-icon`} title={value.label} aria-label={value.label}
    style={{ fontSize: `${size}px`, color: statusColor(status) }} />;
}

export function StatusText({ status, label }: { status: Visual; label?: string }) {
  const color = statusColor(status);
  return <span className="tree-badge" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{label || STATUS[status].label}</span>;
}
