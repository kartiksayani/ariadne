import { useId, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { ChangeRow, ChangedField } from '../../selectors/changes/card';
import { shortLabel } from '../shared/short';
import { STATUS } from '../shared/status';
import './changes.css';

const fieldNames: Record<ChangedField['field'], string> = { question: 'Name', short: 'Short name', type: 'Kind', status: 'Status',
  note: 'Note', ask: 'Question for you', options: 'Choices', outcome: 'Outcome', why: 'Why', links: 'Links', related: 'Related', affects: 'Affects', depends_on: 'Depends on' };
function valueText(value: ChangedField['before'], field: ChangedField['field'], session: Immutable<Session>): string {
  if (value === null || value === undefined || value === '') return 'None';
  if (typeof value === 'string') return field === 'status' && value in STATUS ? STATUS[value as keyof typeof STATUS].label : value;
  if (Array.isArray(value)) return value.length ? value.map(entry => {
    if (typeof entry === 'string') return session.items[entry] ? shortLabel(session.items[entry]!) : 'Item no longer available';
    return 'consequence' in entry ? `${entry.label}${entry.consequence ? ` — ${entry.consequence}` : ''}` : entry.label || entry.target;
  }).join('\n') : 'None';
  return String(value);
}

/** All before/after surfaces share this compact control and accessible label. */
export function Compare({ row, session, why }: { readonly row: ChangeRow; readonly session: Immutable<Session>; readonly why?: string | null }) {
  const [open, setOpen] = useState(false), id = useId();
  if (!row.fields.length) return null;
  return <span className="change-compare">
    <button type="button" className={`btn btn-ghost change-compare-button${open ? ' is-open' : ''}`} title="Show before and after"
      aria-label="Show before and after" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M4 3h6v18H4zM14 3h6v18h-6M7 8h10m-3-3 3 3-3 3M17 16H7m3-3-3 3 3 3" />
      </svg>
    </button>
    {open && <span id={id} className="change-comparison">{row.fields.map(field => <span key={field.field} className="change-field">
      <strong>{fieldNames[field.field]}</strong><span><span className="change-value-label">Before</span><del>{valueText(field.before, field.field, session)}</del></span>
      <span><span className="change-value-label">After</span><mark>{valueText(field.current, field.field, session)}</mark></span>
    </span>)}{why && !row.fields.some(field => field.field === 'why') && <span className="change-field"><strong>Why</strong><span>{why}</span></span>}</span>}
  </span>;
}
