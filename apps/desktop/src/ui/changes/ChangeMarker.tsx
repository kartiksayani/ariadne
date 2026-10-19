import './marker.css';

/** `seen` is the transient pill that replaces New / Changed for the rest of the visit once the 1 s dwell clears the marker (SPEC 3.7, 9.10). */
export type MarkerKind = 'new' | 'changed' | 'seen';
export type MarkerForm = 'pill' | 'diamond';
/** Where the dwell cleared it: only the Seen pill's title says so. */
export type SeenWhere = 'details' | 'dock';

const LABEL: Readonly<Record<MarkerKind, string>> = { new: 'New', changed: 'Changed', seen: 'Seen' };
const PILL_TITLE: Readonly<Record<MarkerKind, string>> = { new: 'New: you haven’t seen this item yet', changed: 'Changed since you last saw it', seen: 'Marked seen after a second' };
const SEEN_TITLE: Readonly<Record<SeenWhere, string>> = { details: 'Marked seen after a second in Details', dock: 'Marked seen after a second in the dock' };

/**
 * The one New / Changed / Seen marker (SPEC 3.7). A pill by default; the diamond alone on Graph nodes and in tight spots.
 * Seen has no diamond form: it is always the pill, with a check in place of the diamond.
 */
export function ChangeMarker({ kind, form = 'pill', seenWhere }: { readonly kind: MarkerKind; readonly form?: MarkerForm; readonly seenWhere?: SeenWhere }) {
  const label = LABEL[kind], shown = kind === 'seen' ? 'pill' : form;
  const title = shown !== 'pill' ? label : kind === 'seen' && seenWhere ? SEEN_TITLE[seenWhere] : PILL_TITLE[kind];
  return <span className="change-marker" data-testid="change-marker" data-kind={kind} data-form={shown} role="img" aria-label={label} title={title}>
    {kind === 'seen' ? <svg aria-hidden="true" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 6.3 2.4 2.4 4.6-5" /></svg> : <i aria-hidden="true" />}
    {shown === 'pill' && <span aria-hidden="true">{label}</span>}
  </span>;
}
