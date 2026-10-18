import { Keycap } from '../../parts/parts';

/**
 * The band's Next unseen button (D21): "Next unseen" (narrow "Next"), or "Next · 5 of 10" once one is outlined, with an `n` keycap.
 * It steps the same way the `n` key does. Nothing to step to, nothing drawn.
 */
export function NextUnseen({ position, total, onNext }: {
  /** 1-based place of the outlined item among this topic's unseen ones; null while none of them is outlined. */
  readonly position: number | null;
  readonly total: number;
  readonly onNext: () => void;
}) {
  if (total <= 0) return null;
  return <button type="button" className="tree-band-next" title="Go to the next unseen item ( n )"
    aria-label={position === null ? 'Next unseen' : `Next unseen, ${position} of ${total}`} onClick={onNext}>
    <i className="ph ph-arrow-down" aria-hidden="true" />
    {position === null ? <span>Next<span className="tree-wide-only"> unseen</span></span> : <span>Next · {position} of {total}</span>}
    <Keycap>n</Keycap>
  </button>;
}
