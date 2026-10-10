// The status menu reads and toggles the saved status set.
import { ActionMenu } from '../shared/ActionMenu';
import { CHIPS, type Chip } from './model';

export function FilterBar({ chips, counts, disabled, onChip }: {
  chips: ReadonlySet<Chip>; counts: Readonly<Record<Chip, number>>; disabled: boolean;
  onChip: (chip: Chip) => void;
}) {
  const selected = CHIPS.filter(value => value.chip !== 'all' && chips.has(value.chip));
  const active = selected.length > 0;
  const label = active ? `Filter: ${selected.map(value => value.label).join(', ')}` : 'Filter';
  return <div className="tree-filters" role="group" aria-label="Filter items">
    <ActionMenu label={label} title={label} buttonClassName="btn btn-ghost btn-icon tree-filter-button" disabled={disabled} active={active}
      icon={<><i className="ph ph-funnel" aria-hidden="true" />{active && <span className="tree-filter-dot" aria-hidden="true" />}</>}>
      {close => <>
        {CHIPS.filter(value => value.chip !== 'all').map(value => <button key={value.chip} type="button" role="menuitemcheckbox"
          className="tree-filter-option" aria-checked={chips.has(value.chip)} disabled={disabled} onClick={() => onChip(value.chip)}>
          <span className="tree-filter-check" aria-hidden="true">{chips.has(value.chip) && <i className="ph ph-check" />}</span>
          <i className={value.icon} style={{ color: value.iconColor }} aria-hidden="true" /><span>{value.label}</span>
          <span className="tree-chip-count">{counts[value.chip]}</span>
        </button>)}
        <button type="button" role="menuitem" className="tree-filter-option" disabled={disabled} onClick={() => { onChip('all'); close(); }}>
          <i className="ph ph-list" aria-hidden="true" /><span>Show all</span><span className="tree-chip-count">{counts.all}</span>
        </button>
      </>}
    </ActionMenu>
  </div>;
}
