import { useId } from 'react';
import { StatusBadge, type Status } from './StatusBadge';
import '../../styles/reference.css';

// Layout/viewport algorithms belong to the graph module. These primitives accept
// explicit geometry, including source fixture geometry for region comparisons.
export type GraphNode = {
  id: string; short: string; question: string; status: Status; x: number; y: number;
  background: string; ring: string; opacity: number; titleColor: string; questionColor: string;
  descendants?: { text: string; title: string };
};
export type GraphEdge = { id: string; path: string; selected?: boolean; replacement?: boolean; label?: { x: number; y: number } };
export type TopicGraphProps = { width: number; height: number; nodes: readonly GraphNode[]; edges: readonly GraphEdge[]; onReveal?: (id: string) => void };

export function TopicGraph({ width, height, nodes, edges, onReveal }: TopicGraphProps) {
  const marker = useId();
  return <div className="ariadne-reference ref-graph" style={{ width, height }}>
    <svg width={width} height={height} className="ref-graph-edges" aria-hidden="true">
      <defs><marker id={marker} viewBox="0 0 8 8" refX={4} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" style={{ fill: 'var(--st-replaced)' }} /></marker></defs>
      {edges.map(edge => <g key={edge.id}><path d={edge.path} fill="none" markerEnd={edge.replacement ? `url(#${marker})` : undefined} style={{ stroke: edge.replacement ? 'var(--st-replaced)' : edge.selected ? 'var(--color-accent)' : 'var(--a-edge)', strokeWidth: edge.selected ? 1.75 : 1.25, strokeDasharray: edge.replacement ? '4 4' : undefined }} />{edge.label && <text x={edge.label.x} y={edge.label.y} textAnchor="middle" style={{ fill: 'var(--st-replaced)', fontSize: 11, fontFamily: 'var(--font-body)' }}>replaced by</text>}</g>)}
    </svg>
    {nodes.map(node => <div key={node.id} className="ref-graph-node" data-row={node.id} role="button" tabIndex={0} title={node.question} onClick={() => onReveal?.(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onReveal?.(node.id); } }} style={{ left: node.x, top: node.y, background: node.background, boxShadow: node.ring, opacity: node.opacity }}>
      <div className="ref-graph-title"><span style={{ flex: 'none', display: 'flex' }}><StatusBadge status={node.status} variant="icon" size={14} /></span><span className="ref-graph-short" style={{ color: node.titleColor }}>{node.short}</span>{node.descendants && <span className="ref-graph-descendants" title={node.descendants.title}>{node.descendants.text}</span>}</div>
      <div className="ref-graph-question" style={{ color: node.questionColor }}>{node.question}</div>
    </div>)}
  </div>;
}
