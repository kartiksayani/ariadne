// The chip row (SPEC §6.10, 8.2): one row in flow under the top bar, above the Tree and the Graph. Chips toggle statuses
// (multi-select, picked chips combine with OR); a chip shows when it counts something or is picked.
import { STATUS } from '../shared/status';
import { CHIP_ORDER, type Chip } from '../../selectors/tree/filter';

const CHIP_VIEW: Readonly<Record<Chip, { readonly label: string; readonly icon: string; readonly color: string }>> = {
  waiting: { label: STATUS.waiting.label, icon: STATUS.waiting.icon, color: 'var(--st-waiting)' },
  toack: { label: 'To ack', icon: 'ph ph-check', color: 'var(--color-text)' },
  open: { label: STATUS.open.label, icon: STATUS.open.icon, color: 'var(--st-open)' },
  progress: { label: STATUS.progress.label, icon: STATUS.progress.icon, color: 'var(--st-progress)' },
  sent: { label: STATUS.agent.label, icon: STATUS.agent.icon, color: 'var(--st-agent)' },
  blocked: { label: 'Blocked', icon: 'ph ph-lock-simple', color: 'var(--st-open)' },
  decided: { label: STATUS.decided.label, icon: STATUS.decided.icon, color: 'var(--st-decided)' },
  done: { label: STATUS.done.label, icon: STATUS.done.icon, color: 'var(--st-done)' },
  later: { label: 'Later', icon: 'ph ph-clock', color: 'var(--st-open)' },
  replaced: { label: STATUS.replaced.label, icon: STATUS.replaced.icon, color: 'var(--st-replaced)' },
};

/** The chip's name, as the notices say it ("Waiting on me"). */
export const chipLabel = (chip: Chip): string => CHIP_VIEW[chip].label;

/** `active` is the filter itself (picked chips, owners, hide-later or a leftover saved status), so Clear shows whenever the
 * Map is filtered, even with no chip picked. */
export function FilterRow({ counts, picked, active, shown, total, disabled, onChip, onClear }: {
  counts: Readonly<Record<Chip, number>>; picked: readonly Chip[]; active: boolean; shown: number; total: number;
  disabled: boolean; onChip: (chip: Chip) => void; onClear: () => void;
}) {
  return <div className="tree-filter-row" role="group" aria-label="Filter items">
    <div className="tree-filter-chips">
      {CHIP_ORDER.filter(chip => counts[chip] > 0 || picked.includes(chip)).map(chip => {
        const view = CHIP_VIEW[chip], on = picked.includes(chip);
        return <button key={chip} type="button" className="tree-filter-chip" aria-pressed={on} aria-label={`${view.label} ${counts[chip]}`}
          disabled={disabled} onClick={() => onChip(chip)}>
          <i className={view.icon} style={{ color: view.color }} aria-hidden="true" />
          <span>{view.label}</span><span className="tree-filter-count">{counts[chip]}</span>
        </button>;
      })}
    </div>
    <div className="tree-filter-end">
      {!active ? <span className="tree-filter-hint">Pick a status</span> : <>
        <span className="tree-filter-summary" role="status">
          <span className="tree-filter-wide">Showing {shown} of {total} items</span>
          <span className="tree-filter-narrow" aria-hidden="true">{shown} of {total}</span>
        </span>
        <button type="button" className="tree-filter-clear" disabled={disabled} onClick={onClear}>Clear</button>
      </>}
    </div>
  </div>;
}
