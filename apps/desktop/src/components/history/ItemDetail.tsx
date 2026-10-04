import { useEffect, useRef, useState } from 'react';
import type { RendererService } from '../../data/service';
import type { Immutable, SessionStore } from '../../data/session-store';
import type { RegisteredRoutes, RevealedItem } from '../../data/routes';
import type { Message, RoundProjection } from '../../generated/domain/models';
import { loadItemHistory, type ItemHistory } from './load';
import { useHistory } from './useHistory';
import { MessageCard } from './MessageCard';
import './history.css';

const load = (service: RendererService, route: Parameters<typeof loadItemHistory>[1], revision: number, itemId: string, signal: AbortSignal) =>
  loadItemHistory(service, route, itemId, revision, signal);
const terminal = new Set(['decided', 'done', 'dropped', 'replaced']);
export function itemTimeline(history: Immutable<ItemHistory>): readonly Immutable<Message>[] {
  const values = new Map<string, Immutable<Message>>();
  const created = history.conversation.timeline_context.created_message;
  if (created) values.set(created.id, created);
  for (const message of [...history.item.updated_messages.items, ...history.conversation.messages.items]) values.set(message.id, message);
  for (const round of history.rounds.rounds.items) {
    for (const message of [...round.owner_messages.items, ...round.agent_messages.items]) values.set(message.id, message);
  }
  return [...values.values()].sort((a, b) => a.number - b.number);
}
function RoundCard({ projection, current, reveal }: { projection: Immutable<RoundProjection>; current: boolean; reveal: (itemId: string) => void }) {
  const round = projection.round;
  const answeredMessages = new Set(projection.answers.items.map(answer => answer.message_id));
  return <section className={`history-round${current ? ' history-current' : ''}`} aria-label={`Round ${round.ordinal}`}>
    <div className="history-meta"><strong>Round {round.ordinal}</strong>{current && <span>Current round</span>}{round.closed_at && <span>Closed · {round.closed_at}</span>}</div>
    <h3>{round.question_snapshot}</h3>
    {round.ask_snapshot && <p className="history-body history-ask">{round.ask_snapshot}</p>}
    {round.options_snapshot.length > 0 && <ul className="history-options">{round.options_snapshot.map(option => <li key={option.id}>
      <strong>{option.label}</strong>{option.recommended && <span> · Recommended</span>}<p className="history-body">{option.consequence}</p>
    </li>)}</ul>}
    {projection.answers.items.map(answer => <article className="history-answer" key={answer.id} aria-label={`Answer ${answer.seq}`}>
      <div className="history-meta">You · {answer.created_at}{answer.supersedes_answer_id && <span>Replaces a previous answer</span>}</div>
      {answer.selected_option_id !== null && <p><strong>Chosen: {answer.options_snapshot.find(option => option.id === answer.selected_option_id)?.label ?? answer.selected_option_id}</strong></p>}
      <div className="history-body">{answer.text}</div>
    </article>)}
    {projection.owner_messages.items.filter(message => !answeredMessages.has(message.id)).map(message =>
      <MessageCard key={message.id} message={message} role="Owner reply" onReveal={reveal} />)}
    {projection.agent_messages.items.map(message => <MessageCard key={message.id} message={message} role={message.kind === 'reply' ? 'Agent reply' : 'Related activity'} onReveal={reveal} />)}
    {projection.results.items.map(value => <article className="history-result" key={`${value.input_id}:${value.attempt_id}`}>
      <div className="history-meta">Result · {value.result.outcome} · {value.result.committed_at}</div>
      <div className="history-body">{value.result.explanation}</div>
      {value.result.followup_item_ids.map(id => <button className="history-link" key={id} type="button" onClick={() => reveal(id)}>Follow-up · Item {id}</button>)}
    </article>)}
    {projection.forks.items.map(fork => <button className="history-fork" key={fork.item_id} type="button" onClick={() => reveal(fork.item_id)}>
      <i className="ph ph-git-fork" aria-hidden="true" />Fork · Item {fork.item_id} · {fork.question}<span>{fork.status.replace(/_/g, ' ')}</span>
    </button>)}
    {round.origin && <p className="history-meta">Original round {round.origin.entity_id} · session {round.origin.session_id}</p>}
  </section>;
}

export function ItemDetail({ service, store, itemId, routes, onReveal, highlightedMessageIds = new Set<string>(), onIntent, onClose }: {
  service: RendererService; store: SessionStore; itemId: string | null; routes: RegisteredRoutes;
  onReveal: (reveal: RevealedItem) => void; highlightedMessageIds?: ReadonlySet<string>;
  onIntent?: (intent: 'followup' | 'reopen', itemId: string) => void; onClose?: () => void;
}) {
  const history = useHistory(service, store, itemId ?? '', load);
  const [mode, setMode] = useState<'rounds' | 'timeline'>('rounds');
  const [routeError, setRouteError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => { ++request.current; setRouteError(null); return () => { ++request.current; }; }, [store, itemId]);
  const data = history.data, item = data?.item.item;
  const session = history.session.snapshot?.session;
  const topic = item ? session?.topics[item.topic_id] : null;
  const children = item ? Object.values(session?.items ?? {}).filter(value => value?.parent === item.id)
    .sort((a, b) => a!.ordinal - b!.ordinal) : [];
  const canAct = Boolean(onIntent && item && session?.state === 'active' && topic && topic.archived_at === null
    && !history.loading && !history.error && history.session.status === 'ready' && history.revision === session.revision);
  const open = (route: Parameters<RegisteredRoutes['revealItem']>[0]) => {
    const call = ++request.current;
    setRouteError(null);
    void routes.revealItem(route).then(result => { if (call === request.current && result) onReveal(result); })
      .catch((failure: unknown) => { if (call === request.current) setRouteError(failure instanceof Error ? failure.message : 'The registered item could not be opened.'); });
  };
  const reveal = (id: string) => {
    open({ ...history.session.route, item_id: id });
  };
  const timeline = data ? itemTimeline(data) : [];
  return <aside className="ariadne-reference item-history" aria-label="Item detail">
    <header className="history-header"><strong>Item {itemId ?? 'detail'}</strong>{onClose && <button type="button" onClick={onClose} aria-label="Close item detail">Close</button>}</header>
    {!itemId && <p>Select an item to read its complete history.</p>}
    {history.loading && itemId && <p role="status">Loading complete item history…</p>}
    {history.error && <p role="alert">{history.error} {data && 'Showing the previous complete history.'} <button type="button" onClick={history.retry}>Retry history read</button></p>}
    {history.session.status !== 'ready' && <p role="status">{history.session.error?.message ?? 'The registered session is stale.'}</p>}
    {routeError && <p role="alert">{routeError}</p>}
    {item && data && <>
      <nav className="history-meta" aria-label="Item location"><span>{topic?.name ?? 'Topic unavailable'}</span>
        {item.parent && <button type="button" className="history-link" onClick={() => reveal(item.parent!)}>Parent · Item {item.parent}</button>}<span>Item {item.id}</span></nav>
      <h2>{item.question}</h2><p className="history-meta">{item.status.replace(/_/g, ' ')} · {item.type} · history revision {history.revision}</p>
      <p className="history-meta">Owner · {item.owner.kind === 'me' ? 'You' : item.owner.kind === 'other' ? item.owner.name : `Agent ${item.owner.binding_id}`}</p>
      {item.ask !== null && <section aria-label="Current ask"><strong>Ask</strong><p className="history-body">{item.ask}</p></section>}
      {item.note !== null && <p className="history-body">{item.note}</p>}
      {item.outcome !== null && <section aria-label="Current outcome"><strong>Outcome</strong><p className="history-body">{item.outcome}</p>{item.why !== null && <p className="history-body">{item.why}</p>}</section>}
      {item.replaced_by && <button type="button" className="history-link" onClick={() => reveal(item.replaced_by!)}>Replaced by Item {item.replaced_by}</button>}
      {data.item.status_history.items.filter(entry => entry.previous_outcome !== null).map((entry, index) => <section key={index} className="history-former" aria-label="Former outcome">
        <strong>Former {entry.old_status.replace(/_/g, ' ')} outcome</strong><p className="history-body">{entry.previous_outcome}</p>
        {entry.previous_why !== null && <p className="history-body">{entry.previous_why}</p>}{entry.reason !== null && <p className="history-body">{entry.reason}</p>}
        {entry.previous_replaced_by && <button type="button" onClick={() => reveal(entry.previous_replaced_by!)}>Former replacement · Item {entry.previous_replaced_by}</button>}
      </section>)}
      {terminal.has(item.status) && <div className="history-actions">
        <button type="button" disabled={!canAct} onClick={() => onIntent?.('followup', item.id)}>Follow up</button>
        {item.status !== 'replaced' && <button type="button" disabled={!canAct} onClick={() => onIntent?.('reopen', item.id)}>Request reopen</button>}
      </div>}
      {children.length > 0 && <section aria-label="Child items"><strong>Children</strong>{children.map(child => child && <button type="button" className="history-link" key={child.id} onClick={() => reveal(child.id)}>Item {child.id} · {child.question}</button>)}</section>}
      {item.links.length > 0 && <section aria-label="Item links"><strong>Links</strong>{item.links.map((link, index) => <p key={index} className="history-body">{link.kind.toUpperCase()} · {link.label} · {link.target}</p>)}</section>}
      {item.source_round_id && <p className="history-meta">Source round · {item.source_round_id}</p>}
      {item.origin && <button type="button" className="history-link" onClick={() => open({ project_id: item.origin!.project_id,
        session_id: item.origin!.session_id, item_id: item.origin!.entity_id })}>Original Item {item.origin.entity_id} · session {item.origin.session_id}</button>}
      <div className="history-tabs" role="group" aria-label="Item history view">
        <button type="button" aria-pressed={mode === 'rounds'} onClick={() => setMode('rounds')}>Back and forth</button>
        <button type="button" aria-pressed={mode === 'timeline'} onClick={() => setMode('timeline')}>Timeline · {timeline.length}</button>
      </div>
      {mode === 'rounds' ? <div className="history-rounds">{data.rounds.rounds.items.map(round =>
        <RoundCard key={round.round.id} projection={round} current={round.round.id === item.current_round_id} reveal={reveal} />)}
        {!data.rounds.rounds.items.length && <p>No question rounds have been recorded.</p>}</div>
        : <div className="history-timeline">{timeline.map(message => <MessageCard key={message.id} message={message}
          role={message.id === item.created_message_id ? 'Created' : message.origin ? 'Origin' : data.item.updated_messages.items.some(value => value.id === message.id) ? 'Updated' : 'Conversation'}
          highlighted={highlightedMessageIds.has(message.id)} onReveal={reveal} />)}</div>}
    </>}
  </aside>;
}
