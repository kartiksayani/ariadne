// The topic band of the session tree (Ariadne.dc.html:137-148): chevron, name,
// session chip, hover actions, counts, the delivery line and the all-closed
// prompt.
import type { KeyboardEvent, ReactNode } from 'react';
import type { TopicRow as Row } from './model';

export interface TopicAction { readonly icon: string; readonly label: string; readonly title: string; readonly run: () => void; readonly archive?: boolean }

export interface TopicRowProps {
  readonly row: Row;
  readonly focused: boolean;
  readonly actions: readonly TopicAction[];
  /** Offer "Archive topic" when everything in it is closed. */
  readonly prompt: (() => void) | null;
  readonly remember: (key: string, element: HTMLDivElement | null) => void;
  readonly onFocus: (key: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onToggle: (topicId: string) => void;
  /** The open "Reply to topic" box (ui/answer/TopicReply), under the band. */
  readonly reply?: ReactNode;
  /** A stopped delivery's inline fix (ui/answer/StuckNote); it takes the delivery line's place. */
  readonly fix?: ReactNode;
}

export function TopicRow({ row, focused, actions, prompt, remember, onFocus, onKeyDown, onToggle, reply, fix }: TopicRowProps) {
  const topic = row.topic;
  // A click focuses the band, which tints it and shows its actions; the chevron folds.
  return <div ref={element => remember(row.key, element)} role="treeitem" aria-level={1} aria-expanded={row.expanded} aria-label={topic.name}
    tabIndex={focused ? 0 : -1} className="tree-row tree-topic" data-topic-id={topic.id} data-row={row.key} data-first={row.first || undefined}
    onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }} onKeyDown={onKeyDown}>
    <div className="tree-topic-head">
      <button type="button" className="tree-chevron" tabIndex={-1} aria-label="Expand or collapse topic"
        onClick={event => { event.stopPropagation(); onToggle(topic.id); }}><i className={row.expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} /></button>
      <span className="tree-topic-name" data-earlier={row.earlier || undefined}>{topic.name}</span>
      {row.chip && <span className="tree-session-chip" title={row.chip.title}><i className="ph ph-clock-counter-clockwise" />{row.chip.label}</span>}
      <span className="tree-topic-end">
        {actions.length > 0 && <span className="tree-topic-actions">{actions.map(action => <button key={action.label} type="button" tabIndex={-1}
          className="tree-topic-action" title={action.title} data-shortcut-archive-topic={action.archive ? topic.id : undefined}
          onClick={event => { event.stopPropagation(); action.run(); }}><i className={action.icon} />{action.label}</button>)}</span>}
        {row.counts.map(count => <span key={count.text} className="tree-count"><i className={count.icon} style={{ color: count.color }} />{count.text}</span>)}
      </span>
    </div>
    {row.delivery?.stuck && fix ? <div className="tree-topic-fix">{fix}</div>
      : row.delivery && <div className="tree-topic-line" style={{ color: row.delivery.color }}><i className={row.delivery.icon} /><span>{row.delivery.text}</span></div>}
    {prompt && <div className="tree-topic-line tree-prompt"><i className="ph ph-check-circle" /><span>Everything here is closed.</span>
      <button type="button" className="btn btn-ghost" onClick={event => { event.stopPropagation(); prompt(); }}><i className="ph ph-archive" />Archive topic</button></div>}
    {reply}
  </div>;
}
