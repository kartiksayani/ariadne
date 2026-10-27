// The chip row (SPEC §6.10, 8.2): one row in flow under the top bar, above the Tree and the Graph. Chips toggle statuses
// (multi-select, picked chips combine with OR); a chip shows when it counts something, has hidden items behind it, or is picked.
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

/** The hidden matches of the picked filter, as the strip says them (alpha.24): `remaining` are not drawn (inside Focus), `shown`
 * are drawn because the filter's own reveal opened them, `outside` lie outside Focus. `owned` is whether the filter's reveal holds
 * anything to put away. */
export interface HiddenNote { readonly remaining: number; readonly shown: number; readonly outside: number; readonly owned: boolean }

/** `active` is the filter itself (picked chips, owners, hide-later or a leftover saved status), so Clear shows whenever the
 * Map is filtered, even with no chip picked. `hidden` counts the hidden items each chip would match beside its visible count;
 * `note` and its two actions speak for the hidden matches (the Graph passes no `onShow`: it draws no hidden nodes). */
export function FilterRow({ counts, hidden, picked, active, shown, total, note, disabled, onChip, onClear, onShowHidden, onHideShown }: {
  counts: Readonly<Record<Chip, number>>; hidden?: Readonly<Record<Chip, number>>; picked: readonly Chip[]; active: boolean; shown: number; total: number;
  note?: HiddenNote | null; disabled: boolean; onChip: (chip: Chip) => void; onClear: () => void; onShowHidden?: () => void; onHideShown?: () => void;
}) {
  const behind = (chip: Chip) => hidden?.[chip] ?? 0;
  const drawn = CHIP_ORDER.filter(chip => counts[chip] > 0 || behind(chip) > 0 || picked.includes(chip));
  const putAway = note && (note.shown > 0 || note.owned) && onHideShown;
  const offer = note && note.remaining > 0;
  const outsideOnly = note && note.remaining === 0 && note.outside > 0;
  return <div className="tree-filter-row" role="group" aria-label="Filter items">
    <div className="tree-filter-chips">
      {drawn.map(chip => {
        const view = CHIP_VIEW[chip], on = picked.includes(chip), more = behind(chip);
        return <button key={chip} type="button" className="tree-filter-chip" aria-pressed={on}
          aria-label={`${view.label} ${counts[chip]}${more ? `, ${more} more hidden` : ''}`} disabled={disabled} onClick={() => onChip(chip)}>
          <i className={view.icon} style={{ color: view.color }} aria-hidden="true" />
          <span>{view.label}</span><span className="tree-filter-count">{counts[chip]}</span>
          {more > 0 && <span className="tree-filter-behind" aria-hidden="true">+{more} hidden</span>}
        </button>;
      })}
    </div>
    <div className="tree-filter-end">
      {!active ? <span className="tree-filter-hint">{drawn.length ? 'Pick a status' : 'Nothing to filter'}</span> : <>
        <span className="tree-filter-summary" role="status">
          <span className="tree-filter-wide">Showing {shown} of {total} items</span>
          <span className="tree-filter-narrow" aria-hidden="true">{shown} of {total}</span>
        </span>
        {putAway && <span className="tree-filter-note">
          <span aria-hidden="true">·</span>
          {note.shown > 0 && <span>{note.shown} hidden shown</span>}
          <button type="button" className="tree-filter-clear" disabled={disabled} onClick={onHideShown}>Hide them</button>
        </span>}
        {(offer || outsideOnly) && <span className="tree-filter-note">
          <span aria-hidden="true">·</span>
          <span>{outsideOnly ? `${note.outside} hidden match outside Focus`
            : `+${note.remaining} hidden match${note.outside > 0 ? ` (${note.outside} outside Focus)` : ''}`}</span>
          {offer && onShowHidden && <button type="button" className="tree-filter-clear" disabled={disabled} onClick={onShowHidden}>Show them</button>}
        </span>}
        <button type="button" className="tree-filter-clear" disabled={disabled} onClick={onClear}>Clear</button>
      </>}
    </div>
  </div>;
}
