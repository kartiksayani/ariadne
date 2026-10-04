import type { FocusEventHandler, KeyboardEventHandler, ReactNode, Ref } from 'react';
import { StatusBadge, type Status } from './StatusBadge';
import '../../styles/reference.css';

export type TreeRowProps = {
  item: { id: string; question: string; status: Status; explanation?: boolean; ask?: string; note?: string; outcome?: string; later?: boolean };
  depth?: number;
  selected?: boolean;
  hovered?: boolean;
  focused?: boolean;
  context?: boolean;
  touched?: 'strong' | 'weak';
  segments?: readonly { text: string; match?: boolean }[];
  guides?: readonly { x: number; accent?: boolean; elbowWidth?: number }[];
  hasChildren?: boolean;
  expanded?: boolean;
  collapsedSummary?: string;
  roundTag?: string;
  delivery?: { text: string; icon: string; color?: string; action?: string; onAction?: () => void };
  replacement?: { question: string; status: Status; onReveal?: () => void };
  actions?: readonly { kind: 'bring' | 'reply' | 'note' | 'followup' | 'drop' | 'reopen' | 'later'; label: string; icon: string; onClick: () => void }[];
  answer?: ReactNode;
  onSelect?: () => void;
  onToggle?: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  rowRef?: Ref<HTMLDivElement>;
  tabIndex?: number;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
};

export function TreeRow({ item, depth = 1, selected = false, hovered = false, focused = false, context = false, touched, segments, guides = [], hasChildren = false, expanded = false, collapsedSummary, roundTag, delivery, replacement, actions = [], answer, onSelect, onToggle, onEnter, onLeave, rowRef, tabIndex, onFocus, onKeyDown }: TreeRowProps) {
  const closed = ['decided', 'done', 'dropped', 'replaced'].includes(item.status);
  const muted = closed || context || (item.status === 'open' && item.later);
  const supporting = delivery ? 'delivery' : item.status === 'open' && item.later ? 'later' : item.status === 'waiting' && item.ask ? 'ask' : item.status === 'progress' && item.note ? 'note' : item.status === 'replaced' && replacement ? 'replacement' : closed && item.outcome ? 'outcome' : null;
  const label = item.status === 'open' && item.later ? 'Later' : item.status === 'done' && item.explanation ? 'Explained' : undefined;
  const toggle = () => onToggle?.();
  return <div ref={rowRef} className="ariadne-reference ref-tree-row" role="treeitem" aria-selected={selected} aria-level={depth + 1} aria-expanded={hasChildren ? expanded : undefined} tabIndex={tabIndex ?? (selected ? 0 : -1)} onFocus={onFocus} onClick={onSelect} onMouseEnter={onEnter} onMouseLeave={onLeave} onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented && event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); onSelect?.(); } }} style={{ paddingLeft: 12 + depth * 24, background: selected ? 'color-mix(in srgb, var(--color-text) 7%, transparent)' : touched === 'strong' ? 'color-mix(in srgb, var(--color-accent) 9%, transparent)' : hovered ? 'color-mix(in srgb, var(--color-text) 4%, transparent)' : 'transparent', boxShadow: selected && focused ? 'inset 0 0 0 1.5px color-mix(in srgb, var(--color-accent) 80%, transparent)' : 'none' }}>
    <div className="ref-tree-mark" style={{ background: touched ? `color-mix(in srgb, var(--color-accent) ${touched === 'strong' ? 75 : 40}%, transparent)` : 'transparent' }} />
    {guides.map((guide, index) => guide.elbowWidth !== undefined ? <div key={index} className="ref-tree-elbow" style={{ left: guide.x, width: guide.elbowWidth }} /> : <div key={index} className="ref-tree-guide" style={{ left: guide.x, width: guide.accent ? 1.5 : 1, background: guide.accent ? 'var(--color-accent)' : 'var(--a-guide)' }} />)}
    {hasChildren ? <button type="button" className="ref-toggle" aria-label="Expand or collapse" onClick={event => { event.stopPropagation(); toggle(); }}><i className={`ph ph-caret-${expanded ? 'down' : 'right'}`} aria-hidden="true" style={{ fontSize: 12 }} /></button> : <span className="ref-tree-spacer" />}
    <span className="ref-tree-icon"><StatusBadge status={item.status} variant="icon" size={17} /></span>
    <div className="ref-tree-content"><div className="ref-tree-question" style={{ color: muted ? 'color-mix(in srgb, var(--color-text) 64%, transparent)' : 'var(--color-text)' }}>{(segments?.length ? segments : [{ text: item.question }]).map((segment, index) => <span key={index} style={{ borderRadius: 3, background: segment.match ? 'color-mix(in srgb, var(--color-accent) 32%, transparent)' : 'transparent' }}>{segment.text}</span>)}</div>
      {supporting === 'delivery' && delivery && <div className="ref-tree-support" style={{ color: delivery.color || 'var(--a-acc-text)' }}><i className={delivery.icon} aria-hidden="true" style={{ fontSize: 14 }} /><span>{delivery.text}</span>{delivery.action && <button className="ref-button ref-ghost" type="button" onClick={event => { event.stopPropagation(); delivery.onAction?.(); }}>{delivery.action}</button>}</div>}
      {supporting === 'later' && <div className="ref-tree-support ref-later"><i className="ph ph-clock" aria-hidden="true" style={{ fontSize: 14 }} /><span>Parked for later · still open</span></div>}
      {supporting === 'ask' && <div style={{ fontSize: 14, lineHeight: '21px', color: 'var(--a-acc-text)' }}>{item.ask}</div>}
      {supporting === 'note' && <div className="ref-tree-support ref-progress-note" style={{ color: 'var(--st-progress)' }}><i className="ph ph-robot" aria-hidden="true" style={{ fontSize: 14 }} /><span>{item.note}</span></div>}
      {supporting === 'replacement' && replacement && <div className="ref-tree-support" style={{ color: 'color-mix(in srgb, var(--color-text) 66%, transparent)' }}><i className="ph ph-arrow-bend-down-right" aria-hidden="true" style={{ fontSize: 13 }} /><span>Replaced by</span><button className="ref-replacement" type="button" onClick={event => { event.stopPropagation(); replacement.onReveal?.(); }}>{replacement.question}</button><StatusBadge status={replacement.status} variant="text" /></div>}
      {supporting === 'outcome' && <div className="ref-tree-outcome"><i className="ph ph-arrow-elbow-down-right" aria-hidden="true" style={{ flex: 'none', marginTop: 4, fontSize: 13, color: `var(--st-${item.status})` }} /><span style={{ textWrap: 'pretty' }}>{item.outcome}</span></div>}
      {collapsedSummary && <button className="ref-collapsed" type="button" onClick={event => { event.stopPropagation(); toggle(); }} style={{ color: touched === 'weak' ? 'var(--a-acc-text)' : 'color-mix(in srgb, var(--color-text) 62%, transparent)' }}><i className="ph ph-dots-three" aria-hidden="true" style={{ fontSize: 14 }} />{collapsedSummary}</button>}
      {answer && <div className="ref-inline-answer" onClick={event => event.stopPropagation()}>{answer}</div>}
    </div>
    <div className="ref-tree-end">{roundTag && <span className="ref-round" title="Rounds of back and forth"><i className="ph ph-arrows-clockwise" aria-hidden="true" style={{ fontSize: 12 }} />{roundTag}</span>}{(selected || hovered) && actions.length > 0 && <span className="ref-actions">{actions.filter(action => item.status !== 'replaced' || action.kind !== 'reopen').map(action => <button type="button" key={action.kind} className="ref-action" title={action.label} aria-label={action.label} onClick={event => { event.stopPropagation(); action.onClick(); }}><i className={action.icon} aria-hidden="true" style={{ fontSize: 14 }} /></button>)}</span>}<span className="ref-tree-id" style={{ opacity: selected || hovered ? 1 : 0 }}>{item.id}</span><StatusBadge status={item.status} label={label} variant="text" /></div>
  </div>;
}
