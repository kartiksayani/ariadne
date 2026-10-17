import './marker.css';

export type MarkerKind = 'new' | 'changed';
export type MarkerForm = 'pill' | 'diamond';

const LABEL: Readonly<Record<MarkerKind, string>> = { new: 'New', changed: 'Changed' };
const PILL_TITLE: Readonly<Record<MarkerKind, string>> = { new: 'New: you haven’t seen this item yet', changed: 'Changed since you last saw it' };

/** The one New / Changed marker (SPEC 3.7). A pill by default; the diamond alone on Graph nodes and in tight spots. */
export function ChangeMarker({ kind, form = 'pill' }: { readonly kind: MarkerKind; readonly form?: MarkerForm }) {
  const label = LABEL[kind];
  return <span className="change-marker" data-testid="change-marker" data-kind={kind} data-form={form} role="img" aria-label={label}
    title={form === 'pill' ? PILL_TITLE[kind] : label}>
    <i aria-hidden="true" />
    {form === 'pill' && <span aria-hidden="true">{label}</span>}
  </span>;
}
