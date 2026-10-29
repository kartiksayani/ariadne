import { useId, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { ChangeRow, ChangedField } from '../../selectors/changes/card';
import { Markdown } from '../shared/MarkdownText';
import { parseMarkdown } from '../shared/markdown';
import { shortLabel } from '../shared/short';
import { STATUS } from '../shared/status';
import './changes.css';

export const fieldNames: Record<ChangedField['field'], string> = { question: 'Name', short: 'Short name', type: 'Kind', status: 'Status',
  note: 'Notes', ask: 'Question for you', options: 'Choices', outcome: 'Outcome', why: 'Why', links: 'Links', related: 'Related', affects: 'Affects', depends_on: 'Depends on' };
export function valueText(value: ChangedField['before'], field: ChangedField['field'], session: Immutable<Session>): string {
  if (value === null || value === undefined || value === '') return 'None';
  if (typeof value === 'string') return field === 'status' && value in STATUS ? STATUS[value as keyof typeof STATUS].label : value;
  if (Array.isArray(value)) return value.length ? value.map(entry => {
    if (typeof entry === 'string') return session.items[entry] ? shortLabel(session.items[entry]!) : 'Item no longer available';
    return 'consequence' in entry ? `${entry.label}${entry.consequence ? ` — ${entry.consequence}` : ''}` : entry.label || entry.target;
  }).join('\n') : 'None';
  return String(value);
}

/** The fields that hold the agent's prose: their before and after read as Markdown, like the text they came from. */
const proseFields: ReadonlySet<ChangedField['field']> = new Set(['question', 'note', 'ask', 'outcome', 'why']);
const isProse = (value: ChangedField['before'], field: ChangedField['field']): value is string => proseFields.has(field) && typeof value === 'string' && value.trim() !== '';
/** True when a prose value would not draw as one plain line (several lines, a list, a heading, a quote...). Other values are one line. */
export function isBlockValue(value: ChangedField['before'], field: ChangedField['field']): boolean {
  if (!isProse(value, field)) return false;
  const { blocks, rest } = parseMarkdown(value);
  return rest !== '' || /\n/.test(value.trim()) || blocks.length !== 1 || blocks[0].t !== 'p';
}
/**
 * One before or after value. Prose renders as Markdown; `block` draws it as a block (the box stacks a multi-line value), otherwise
 * a one-paragraph value stays a span in its line. Everything else, and an empty value ("None"), keeps `valueText`.
 */
export function ChangeValue({ value, field, session, block = false }: { readonly value: ChangedField['before']; readonly field: ChangedField['field'];
  readonly session: Immutable<Session>; readonly block?: boolean }) {
  return isProse(value, field) ? <Markdown text={value} inline={!block} /> : <>{valueText(value, field, session)}</>;
}

/** All before/after surfaces share this compact control and accessible label. */
export function Compare({ row, session, why, variant = 'icon' }: { readonly row: ChangeRow; readonly session: Immutable<Session>; readonly why?: string | null;
  /** `link` is the board's "› Before → after" line (SPEC 5.3); `icon` is the compact button the other surfaces use. */
  readonly variant?: 'icon' | 'link' }) {
  const [open, setOpen] = useState(false), id = useId();
  if (!row.fields.length) return null;
  const link = variant === 'link';
  return <span className={link ? 'change-compare change-compare-link' : 'change-compare'}>
    {link ? <button type="button" className="change-compare-toggle" title="Show before and after" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <i className={open ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />{open ? 'Hide before → after' : 'Before → after'}</button>
    : <button type="button" className={`btn btn-ghost change-compare-button${open ? ' is-open' : ''}`} title="Show before and after"
      aria-label="Show before and after" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M4 3h6v18H4zM14 3h6v18h-6M7 8h10m-3-3 3 3-3 3M17 16H7m3-3-3 3 3 3" />
      </svg>
    </button>}
    {open && <span id={id} className="change-comparison" data-testid="change-comparison" data-single={row.fields.length === 1 || undefined}>{row.fields.map(field => <span key={field.field} className="change-field">
      <strong>{fieldNames[field.field]}</strong><span><span className="change-value-label">Before</span><del><ChangeValue value={field.before} field={field.field} session={session} /></del></span>
      <span><span className="change-value-label">After</span><mark><ChangeValue value={field.current} field={field.field} session={session} /></mark></span>
    </span>)}{why && !row.fields.some(field => field.field === 'why') && <span className="change-field"><strong>Why</strong><span><Markdown text={why} inline /></span></span>}</span>}
  </span>;
}
