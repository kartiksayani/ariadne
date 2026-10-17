// The rails drawn beside a row: grey guides and the accent thread. Shared by every row kind, and
// kept apart from ItemRow so Strip can use it without importing ItemRow.
import type { Guide } from './model';

export function Guides({ guides }: { guides: readonly Guide[] }) {
  return <>{guides.map((guide, index) => {
    const color = guide.on ? 'var(--color-accent)' : 'var(--a-guide)', stroke = guide.on ? '1.5px' : '1px';
    return guide.kind === 'line'
      ? <div key={index} aria-hidden="true" className="tree-guide" data-from-bullet={guide.fromBullet || undefined} data-to-bullet={guide.toBullet || undefined}
        style={{ left: guide.x, width: stroke, background: color }} />
      : <div key={index} aria-hidden="true" className="tree-elbow" style={{ left: guide.x, width: guide.width, borderBottom: `${stroke} solid ${color}` }} />;
  })}</>;
}
