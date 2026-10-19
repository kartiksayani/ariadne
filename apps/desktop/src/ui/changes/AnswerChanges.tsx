import { useMemo, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { changeCard, type ChangeRow } from '../../selectors/changes/card';
import { peekNames } from '../peek/names';
import { shortLabel } from '../shared/short';
import { Compare } from './Compare';
import { ItemName } from './ItemName';
import { answerEffects, limitEffects, newlyBlocked, readAs, type EffectKind } from './model';

export function ChangeName({ row, onOpenItem }: { readonly row: ChangeRow; readonly onOpenItem: (id: string) => void }) {
  return <button type="button" className="change-name" onClick={() => onOpenItem(row.item.id)}>{shortLabel(row.item)}</button>;
}

const KIND: Readonly<Record<EffectKind, { readonly label: string; readonly icon: string }>> = {
  created: { label: 'Created', icon: 'ph ph-plus' },
  changed: { label: 'Changed', icon: 'ph ph-pencil-simple' },
  blocked: { label: 'Blocked', icon: 'ph ph-lock-simple' },
};

const stripReadAs = (text: string) => text.replace(/^Read as:\s*/, '');

/**
 * "Because you chose …" (SPEC 6.8): the owner's words, how the agent read them, and what the answer did, as a ruled list of
 * effects. Five rows show, then "and N more" / "Show fewer". Details shows it once, under the newest answer that changed something.
 */
export function AnswerChanges({ session, inputId, onOpenItem }: { readonly session: Immutable<Session>; readonly inputId: string; readonly onOpenItem: (id: string) => void }) {
  const card = useMemo(() => changeCard(session, inputId), [session, inputId]);
  const blocked = useMemo(() => newlyBlocked(session, card), [session, card]);
  const effects = useMemo(() => answerEffects(session, card, blocked), [session, card, blocked]);
  const interpretations = useMemo(() => readAs(session, card).map(stripReadAs), [session, card]);
  const labels = peekNames(session), route = { project_id: session.project_id, session_id: session.id };
  const [expanded, setExpanded] = useState(false), [wording, setWording] = useState(false);
  if (!card.total && !card.groups.reworded.length) return null;
  const limited = limitEffects(effects, expanded);
  const rewordings = card.groups.reworded.reduce((count, row) => count + row.records.length, 0);
  const chosen = card.answer?.selectedOption, words = card.answer?.text ?? '';
  return <section className="because-card" data-testid="because-card" aria-label="What your answer changed">
    <h3 className="because-title"><i className="ph ph-arrow-bend-down-right" aria-hidden="true" />{chosen ? `Because you chose “${chosen.label}”` : 'Because of what you wrote'}</h3>
    {(words.trim() || interpretations.length > 0) && <dl className="because-grid">
      {words.trim() && <><dt>You wrote</dt><dd className="because-words">{words}</dd></>}
      {interpretations.length > 0 && <><dt>Read as</dt><dd className="because-read">{interpretations.map(text => <span key={text}>{text}</span>)}</dd></>}
    </dl>}
    {limited.shown.length > 0 && <ul className="because-effects">
      {limited.shown.map(effect => <li key={`${effect.kind}:${effect.row.item.id}`} className="because-effect" data-kind={effect.kind}>
        <span className="because-kind"><i className={KIND[effect.kind].icon} aria-hidden="true" />{KIND[effect.kind].label}</span>
        <span className="because-what"><ItemName item={effect.row.item} route={route} label={labels.get(effect.row.item.id)} onOpen={onOpenItem} />
          {effect.note && <span className="because-note"> · {effect.note}</span>}
          {effect.kind === 'changed' && <Compare row={effect.row} session={session} />}</span>
      </li>)}
    </ul>}
    {limited.more > 0 && <button type="button" className="change-link" onClick={() => setExpanded(true)}>and {limited.more} more</button>}
    {expanded && effects.length > 6 && <button type="button" className="change-link" onClick={() => setExpanded(false)}>Show fewer</button>}
    {rewordings > 0 && <><button type="button" className="change-link change-muted" aria-expanded={wording} onClick={() => setWording(value => !value)}>
      {wording ? 'Hide rewordings' : `${rewordings} ${rewordings === 1 ? 'rewording' : 'rewordings'} not shown`}</button>
      {wording && <ul aria-label="Rewordings" className="because-rewordings">{card.groups.reworded.map(row => <li key={row.item.id}><ChangeName row={row} onOpenItem={onOpenItem} /><Compare row={row} session={session} /></li>)}</ul>}</>}
  </section>;
}
