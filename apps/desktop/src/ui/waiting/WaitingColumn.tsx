// The "Waiting on me" column (handoff Ariadne.dc.html, aside "Waiting on me"):
// every open question across sessions, oldest first, each with a compact answer
// control, then the Sent inputs the agent has not picked up yet.
import { useEffect, useMemo, type MouseEvent, type ReactNode } from 'react';
import type { ItemRoute, SessionRef } from '../../generated/core';
import { CoreFailure } from '../../data';
import { QueueAnnouncements } from '../../components/accessibility/QueueAnnouncements';
import { useWaiting, type WaitingStore } from '../../selectors/waiting/store';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { useWorkspaceKeys } from '../keys';
import { AnswerControl, defaultSelection } from '../answer/AnswerControl';
import { useSubmit, type PendingSubmission } from '../answer/useSubmit';
import { waitingModel, type SentRowModel, type WaitingCardModel } from './model';
import './waiting.css';

export interface WaitingColumnProps {
  readonly store: WaitingStore;
  readonly drafts: OwnerDraftStore;
  readonly revealItem: (route: ItemRoute) => void;
  readonly openSession: (route: SessionRef) => void;
  /** The item open in the workspace; its card gets the selected ring. */
  readonly selected?: ItemRoute | null;
  /** Called instead of sending when the item's agent is not running (handoff 1ad). */
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** Lines above the cards, e.g. a navigation error. */
  readonly notice?: ReactNode;
  /** The clock for "Waiting X"; defaults to the current time. */
  readonly now?: number;
}

/** The column frame: header with the count pill, then the scrolling list. */
export function WaitingFrame({ count, loading = false, children }: { readonly count: string; readonly loading?: boolean; readonly children?: ReactNode }) {
  return <aside className="waiting" aria-label="Waiting on me">
    <div className="waiting-head">
      <span className="waiting-title">Waiting on me</span>
      <span className="waiting-count">{count}</span>
      <span className="waiting-order">Oldest first</span>
    </div>
    <div className="waiting-scroll">
      {loading && [0, 1].map(index => <div className="waiting-skeleton" key={index} aria-label="Loading waiting questions"><span /><span /><span /><span /></div>)}
      {children}
    </div>
  </aside>;
}

const same = (a: ItemRoute | null | undefined, b: ItemRoute) => !!a && a.project_id === b.project_id && a.session_id === b.session_id && a.item_id === b.item_id;

export function WaitingColumn({ store, drafts, revealItem, openSession, selected, onAgentNotRunning, notice, now }: WaitingColumnProps) {
  const state = useWaiting(store), draftState = useOwnerDrafts(drafts);
  useEffect(() => { void store.start(); }, [store]);
  useEffect(() => { if (!drafts.getSnapshot().ready) void drafts.load(); }, [drafts]);
  const clock = now ?? Date.now();
  const model = useMemo(() => waitingModel({ state, now: clock,
    draft: route => draftState.ready ? drafts.find(route, route.item_id, 'answer') : undefined,
    presence: (route, bindingId) => store.sessionState(route)?.presence[bindingId] ?? null,
  }), [state, draftState, drafts, store, clock]);
  const incomplete = state.counts?.completeness === 'partial' || state.unavailableProjects.length > 0;
  const current = state.status === 'ready' && !state.error;
  const loading = state.status === 'loading';
  return <WaitingFrame count={model.count} loading={loading}>
    <QueueAnnouncements state={state} />
    {notice}
    {state.status === 'stale' && <p className="waiting-notice" role="status">Showing the last complete queue read. Refresh is pending.</p>}
    {state.error && <div className="waiting-notice waiting-notice-warn" role="alert"><p>{state.error.message}</p>
      {state.error instanceof CoreFailure && <p>{state.error.error.hint}</p>}
      <button type="button" className="btn btn-secondary" onClick={() => { void store.refresh(); }}>Refresh queue</button></div>}
    {incomplete && <div className="waiting-notice" role="status">Queue counts are incomplete. Unavailable registered data is not counted as empty.
      {state.unavailableProjects.map(project => <p key={project.project_id}>{project.project?.display_name ?? 'Unavailable project'} · {project.canonical_root}</p>)}
      {state.counts?.unavailable_session_ids.map(id => <p key={id}>Unavailable session {id}</p>)}</div>}
    {draftState.preferenceUncertain && <div className="waiting-notice waiting-notice-warn" role="alert"><p>Saving your draft could not be confirmed. Sending waits until it is.</p>
      <button type="button" className="btn btn-secondary" onClick={() => { void drafts.retryPreferences(); }}>Retry saving draft preferences</button></div>}
    {!loading && model.cards.length === 0 &&<div className="waiting-empty">
      <i className="ph ph-check-circle" aria-hidden="true" />
      <div className="waiting-empty-title">Nothing waiting on you</div>
      <div className="waiting-empty-text">{model.emptyText}</div>
    </div>}
    {model.cards.map(card => <WaitingCard key={card.id} card={card} drafts={drafts} current={current} selected={same(selected, card.route)}
      revealItem={revealItem} onAgentNotRunning={onAgentNotRunning} onSaved={() => { void store.refresh(); }} />)}
    {model.sent.length > 0 && <>
      <div className="waiting-sent-label">Sent<span>· waiting for the agent to pick up</span></div>
      {model.sent.map(row => <SentRow key={row.id} row={row} open={() => { if (row.item) revealItem({ ...row.item }); else openSession({ ...row.session }); }} />)}
    </>}
  </WaitingFrame>;
}

function WaitingCard({ card, drafts, current, selected, revealItem, onAgentNotRunning, onSaved }: {
  readonly card: WaitingCardModel; readonly drafts: OwnerDraftStore; readonly current: boolean; readonly selected: boolean;
  readonly revealItem: (route: ItemRoute) => void; readonly onAgentNotRunning?: (submission: PendingSubmission) => void; readonly onSaved: () => void;
}) {
  const { item, delivery } = card;
  const submit = useSubmit({ drafts, session: card.session, current, itemId: item.id, intent: 'answer', onAgentNotRunning, onSaved });
  const entry = submit.entry, { another } = submit;
  // A receipt whose captured input answered an earlier round: start this round's draft.
  // The receipt of the current round stays for the detail panel's "Saved" view.
  const receipt = entry?.receipt?.data.kind === 'input_submit' ? card.session.inputs[entry.receipt.data.input_id] : undefined;
  const earlier = !!receipt && receipt.payload.context.round_id !== item.current_round_id;
  const operation = earlier ? entry!.draft.op_id : null;
  useEffect(() => { if (operation) another(); }, [operation]); // `another` closes over this entry; the operation keys it.
  const open =(event?: MouseEvent) => { event?.stopPropagation(); revealItem({ ...card.route }); };
  const retry = (event: MouseEvent) => {
    event.stopPropagation();
    if (delivery?.retry === 'revise') { submit.prepareRevised(); open(); }
    else open();
  };
  // A failed send keeps its choice frozen until it is resolved.
  const frozen = card.chosen ?? (entry?.uncertain ? entry.draft.selected_option_id : undefined);
  const selection = frozen !== undefined ? item.options.findIndex(option => option.id === frozen) : defaultSelection(item.options, entry?.draft.selected_option_id);
  const ring = delivery ? '0 0 0 1px color-mix(in srgb, var(--a-warn) 60%, transparent)'
    : selected ? '0 0 0 1.5px color-mix(in srgb, var(--color-text) 45%, transparent)' : '0 0 0 1px var(--color-divider)';
  return <div className="waiting-card" style={{ boxShadow: `${ring}, var(--a-lift)` }} data-waiting-item={item.id} aria-current={selected || undefined} onClick={open}>
    <div className="waiting-path">{card.path}</div>
    <div className="waiting-question">{item.question}</div>
    {card.ask && <div className="waiting-ask">{card.ask}</div>}
    {card.earlier && <div className="waiting-context"><i className="ph ph-clock-counter-clockwise" aria-hidden="true" /><span>{card.earlier}</span></div>}
    {card.last && <div className="waiting-context"><i className="ph ph-arrows-clockwise" aria-hidden="true" /><span>{card.last}</span></div>}
    {delivery && <div className="waiting-delivery" style={{ color: delivery.color }}><i className={delivery.icon} aria-hidden="true" /><span>{delivery.text}</span>
      {delivery.retry && <button type="button" className="btn btn-secondary waiting-delivery-action" onClick={retry}>Retry</button>}</div>}
    <div onClick={event => event.stopPropagation()}>
      <AnswerControl variant="compact" options={item.options} selected={selection} draft={entry?.draft.text ?? ''} label={`Answer #${item.id}`}
        locked={submit.locked || !!delivery || submit.changed} blocked={delivery || submit.changed ? undefined : submit.blocked ?? undefined}
        warn={submit.changed && !delivery ? 'This item changed. Review the current question and options; your text is retained.' : undefined}
        warnAction={submit.changed && !delivery ? { label: 'Review current target', onAction: submit.review } : undefined}
        onSelect={index => { const option = item.options[index]; if (option) submit.select(option.id); }}
        onDraft={submit.write} onSendOption={index => { const option = item.options[index]; if (option) submit.sendOption(option.id); }}
        onSendText={submit.sendText} />
    </div>
    {submit.error && !delivery && <p className="waiting-error" role="alert">{submit.error}</p>}
    <div className="waiting-foot"><i className="ph ph-clock" aria-hidden="true" /><span>Waiting {card.age}{card.tag && ` · asked in ${card.tag}`}</span>
      <button type="button" className="btn btn-ghost waiting-details" onClick={open}>Details</button></div>
  </div>;
}

function SentRow({ row, open }: { readonly row: SentRowModel; readonly open: () => void }) {
  const keys = useWorkspaceKeys<HTMLDivElement>({ enter: () => { open(); return true; } }, { scope: 'row' });
  return <div className="waiting-sent" role="button" tabIndex={0} onClick={open} onKeyDown={keys}>
    <div className="waiting-sent-question">{row.question}</div>
    <div className="waiting-sent-line" style={{ color: row.line.color }}><i className={row.line.icon} aria-hidden="true" /><span>{row.line.text}</span></div>
  </div>;
}
