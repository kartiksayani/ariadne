// The thread: the accent line from the topic to the selected item, 3px over a 7px halo, with a rounded elbow into the
// item's chevron or icon. It is built from the model's guides that are on; the grey guides are not drawn (the tinted boxes
// carry the structure). Shared by every row kind, and kept apart from ItemRow so Strip can use it without importing ItemRow.
import type { Guide } from './model';

export function Guides({ guides }: { guides: readonly Guide[] }) {
  const on = guides.filter(guide => guide.on);
  // Where an elbow turns into a row, it draws the vertical piece too, so the corner stays round.
  const elbows = new Set(on.filter(guide => guide.kind === 'elbow').map(guide => guide.x));
  return <>{on.map((guide, index) => {
    if (guide.kind === 'elbow') return <div key={index} aria-hidden="true" className="tree-thread-elbow" style={{ left: guide.x - 1.5, width: guide.width + 1.5 }} />;
    if (guide.toBullet && elbows.has(guide.x)) return null;
    return <div key={index} aria-hidden="true" className="tree-thread" data-from-bullet={guide.fromBullet || undefined}
      style={{ left: guide.x - 1.5 }} />;
  })}</>;
}
