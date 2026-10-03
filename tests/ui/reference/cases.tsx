import type { ReactNode } from 'react';
import { StatusBadge, STATUS } from '../../../apps/desktop/src/components/reference/StatusBadge';
import { TreeRow, type TreeRowProps } from '../../../apps/desktop/src/components/reference/TreeRow';
import { AnswerControl, type AnswerControlProps } from '../../../apps/desktop/src/components/reference/AnswerControl';
import { MessageExcerpt, type MessageExcerptProps } from '../../../apps/desktop/src/components/reference/MessageExcerpt';

// Deterministic presentation inputs: never imported by the application entry.
export type ReferenceCase = { id: string; component: 'Status Badge' | 'Item Row' | 'Answer Control' | 'Message Excerpt'; source: Record<string, unknown>; render: () => ReactNode; region?: 'textarea' };
const noop = () => {};
const options = [
  { id: 'approve', label: 'Approve', consequence: 'Continue with the current plan.', recommended: true },
  { id: 'change', label: 'Change the plan', consequence: 'Keep the question open.' },
];
const sourceOptions = options.map(option => ({ label: option.label, consequence: option.consequence, rec: option.recommended }));
const row = (id: string, props: TreeRowProps): ReferenceCase => ({
  id, component: 'Item Row', render: () => <TreeRow {...props} />,
  source: { row: {
    item: { ...props.item, q: props.item.question, type: props.item.explanation ? 'explanation' : 'question', options: sourceOptions },
    depth: props.depth, selected: props.selected, hovered: props.hovered, focus: props.focused, context: props.context,
    hl: props.touched, hasKids: props.hasChildren, expanded: props.expanded, collapsedNote: props.collapsedSummary, roundTag: props.roundTag,
    guides: props.guides?.map(guide => ({ x: guide.x, on: guide.accent, kind: guide.elbowWidth !== undefined ? 'elbow' : 'line', elbowW: guide.elbowWidth })),
    segs: props.segments?.map(segment => ({ t: segment.text, hit: segment.match })),
    delivery: props.delivery && { ...props.delivery, color: props.delivery.color || 'var(--a-acc-text)', hasAction: !!props.delivery.action },
    replacedBy: props.replacement && { q: props.replacement.question, status: props.replacement.status },
    actions: props.actions?.map(action => ({ icon: action.icon, title: action.label })),
    answering: !!props.answer, ctl: { selected: -1, draft: '', noText: true },
  } },
});
const answer = (id: string, extra: Partial<AnswerControlProps>, region?: 'textarea'): ReferenceCase => {
  const props: AnswerControlProps = { options, selected: null, draft: '', onSelect: noop, onDraft: noop, onSubmit: noop, noText: true, ...extra };
  return { id, component: 'Answer Control', region, render: () => <AnswerControl {...props} />,
    source: { variant: props.variant || 'full', options: sourceOptions, ctl: { selected: options.findIndex(option => option.id === props.selected), draft: props.draft, noText: props.noText, warn: props.warning, blocked: props.blocked } } };
};
const excerpt = 'I checked the current plan and found a question that needs your input before we can continue.';
const message = (id: string, props: MessageExcerptProps): ReferenceCase => ({ id, component: 'Message Excerpt', render: () => <MessageExcerpt {...props} />, source: { ...props, msg: { ...props.message, time: props.message.when } } });
const item = { id: 'Q-42', question: 'Should we continue with the current plan?', status: 'open' as const };

export const cases: ReferenceCase[] = [
  ...Object.keys(STATUS).flatMap(status => (['pill', 'text', 'icon'] as const).map(variant => {
    const props = { status: status as keyof typeof STATUS, variant };
    return { id: `status-${status}-${variant}`, component: 'Status Badge' as const, source: props, render: () => <StatusBadge {...props} /> };
  })),
  ...Object.keys(STATUS).map(status => row(`row-${status}`, { item: { ...item, status: status as keyof typeof STATUS, ask: 'Choose a path to proceed.', note: 'Agent is checking the plan.', outcome: 'The current plan was confirmed.' }, replacement: { question: 'Which plan should replace this?', status: 'waiting' } })),
  row('row-selected-focused', { item, selected: true, focused: true, hasChildren: true, expanded: true, depth: 2, roundTag: '2', guides: [{ x: 18 }, { x: 42, accent: true }, { x: 42, elbowWidth: 16 }], actions: [{ kind: 'bring', label: 'Bring into view', icon: 'ph ph-crosshair', onClick: noop }] }),
  row('row-hover-context', { item, hovered: true, context: true, hasChildren: true }),
  row('row-touched', { item, touched: 'strong' }),
  row('row-collapsed-search', { item, touched: 'weak', collapsedSummary: '3 hidden questions', segments: [{ text: 'Should we ' }, { text: 'continue', match: true }, { text: ' with the current plan?' }] }),
  row('row-later', { item: { ...item, later: true } }),
  row('row-explained', { item: { ...item, status: 'done', explanation: true, outcome: 'The evidence explains the current plan.' } }),
  row('row-delivery', { item: { ...item, later: true }, delivery: { text: 'Waiting for acknowledgement', icon: 'ph ph-clock', action: 'Retry' } }),
  row('row-inline-answer', { item: { ...item, status: 'waiting', ask: 'Choose a path to proceed.' }, selected: true, answer: <AnswerControl options={options} selected={null} draft="" onSelect={noop} onDraft={noop} onSubmit={noop} noText /> }),
  answer('answer-full-empty', {}),
  answer('answer-full-selected', { selected: 'approve' }),
  answer('answer-compact-empty', { variant: 'compact' }),
  answer('answer-compact-selected', { variant: 'compact', selected: 'change' }),
  answer('answer-warning-blocked', { selected: 'approve', warning: 'The question changed · review your answer', blocked: 'Offline · your draft is kept' }),
  // The supplied reply hint describes prototype submission semantics. The release
  // contract combines option + text; compare the genuine textarea region separately.
  answer('answer-textarea', { noText: false, draft: 'Additional context for this answer.' }, 'textarea'),
  ...(['plain', 'highlight', 'active', 'origin'] as const).map(state => message(`message-rail-${state}`, { message: { number: 42, author: state === 'origin' ? 'me' : 'agent', when: 'Today 09:30', excerpt }, variant: 'rail', active: state === 'active', highlight: state === 'highlight', mark: state === 'origin' ? 'origin' : 'created' })),
  ...(['created', 'updated', 'origin', 'answer'] as const).flatMap(mark => (['me', 'agent'] as const).map(author => message(`message-timeline-${mark}-${author}`, { message: { number: 42, author, when: 'Today 09:30', excerpt, tag: mark === 'origin' ? 'Origin' : undefined }, variant: 'timeline', mark, last: mark === 'answer', note: mark === 'origin' ? 'Parent context remains visible.' : undefined }))),
];
