import { useMemo, useState } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { changeCard, type ChangeRow } from '../../selectors/changes/card';
import { shortLabel } from '../shared/short';
import { Compare } from './Compare';
import { answerGroups, limitGroups, newlyBlocked, readAs } from './model';

export function ChangeName({ row, onOpenItem }: { readonly row: ChangeRow; readonly onOpenItem: (id: string) => void }) {
  return <button type="button" className="change-name" onClick={() => onOpenItem(row.item.id)}>{shortLabel(row.item)}</button>;
}

export function AnswerChanges({ session, inputId, onOpenItem }: { readonly session: Immutable<Session>; readonly inputId: string; readonly onOpenItem: (id: string) => void }) {
  const card = useMemo(() => changeCard(session, inputId), [session, inputId]);
  const blocked = useMemo(() => newlyBlocked(session, card), [session, card]);
  const groups = useMemo(() => answerGroups(session, card, blocked), [session, card, blocked]);
  const interpretations = useMemo(() => readAs(session, card), [session, card]);
  const [expanded, setExpanded] = useState(false), [wording, setWording] = useState(false);
  if (!card.total && !card.groups.reworded.length) return null;
  const limited = limitGroups(groups, expanded);
  const rewordings = card.groups.reworded.reduce((count, row) => count + row.records.length, 0);
  return <section className="answer-changes change-surface" aria-label="What your answer changed">
    <h3>What your answer changed</h3>
    {card.answer?.selectedOption ? <p>Because you chose {card.answer.selectedOption.label}:</p> : <>
      {card.answer && <blockquote className="change-owner-words">{card.answer.text}</blockquote>}
      {interpretations.map(text => <p className="change-read-as" key={text}>{text}</p>)}
    </>}
    {limited.shown.map(group => <div className="change-group" key={group.label}><h4>{group.label}</h4>
      <ul>{group.rows.map(row => <li key={row.item.id}><ChangeName row={row} onOpenItem={onOpenItem} /><Compare row={row} session={session} />
        {blocked.has(row.item.id) && group.label !== 'Now blocked' && <span className="change-muted">Now blocked</span>}
      </li>)}</ul></div>)}
    {limited.summary && <button type="button" className="change-link" onClick={() => setExpanded(true)}>{limited.summary}</button>}
    {rewordings > 0 && <><button type="button" className="change-link change-muted" aria-expanded={wording} onClick={() => setWording(value => !value)}>
      {wording ? 'Hide rewordings' : `${rewordings} ${rewordings === 1 ? 'rewording' : 'rewordings'} not shown`}</button>
      {wording && <ul aria-label="Rewordings">{card.groups.reworded.map(row => <li key={row.item.id}><ChangeName row={row} onOpenItem={onOpenItem} /><Compare row={row} session={session} /></li>)}</ul>}</>}
  </section>;
}
