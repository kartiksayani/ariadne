// The status chips and the topic select over the tree (Ariadne.dc.html:103-106).
// Counts follow the search and the topic, not the status chip itself.
import { CHIPS, type Chip } from './model';

export function FilterBar({ chips, counts, topics, topicId, showTopics, disabled, onChip, onTopic }: {
  chips: ReadonlySet<Chip>; counts: Readonly<Record<Chip, number>>; topics: readonly { readonly id: string; readonly name: string }[];
  topicId: string | null; showTopics: boolean; disabled: boolean;
  onChip: (chip: Chip) => void; onTopic: (topicId: string | null) => void;
}) {
  return <div className="tree-filters" role="group" aria-label="Filter items">
    {CHIPS.map(value => <button key={value.chip} type="button" className="tree-chip" data-chip={value.chip} aria-pressed={chips.has(value.chip)} disabled={disabled}
      onClick={() => onChip(value.chip)}>
      <i className={value.icon} style={{ color: value.iconColor }} /><span>{value.label}</span><span className="tree-chip-count">{counts[value.chip]}</span>
    </button>)}
    {showTopics && <select className="input tree-topic-select" aria-label="Topic" value={topicId ?? 'all'} disabled={disabled}
      onChange={event => onTopic(event.target.value === 'all' ? null : event.target.value)}>
      <option value="all">All topics</option>
      {topics.map(topic => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
    </select>}
  </div>;
}
