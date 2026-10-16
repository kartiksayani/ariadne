import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { waitingOnOwner } from '../../selectors/waiting/rows';
import { useWaiting, type WaitingStore } from '../../selectors/waiting/store';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { DockStore, type DockQuestion } from '../../state/dock/store';
import { clampDockHeight, DOCK_FOLD_THRESHOLD, DOCK_LINE, DOCK_MIN, loadDockHeight, saveDockHeight } from '../../state/dock/height';
import { AnswerSlot } from '../detail/AnswerSlot';
import { QuestionDelivery } from '../answer/QuestionDelivery';
import type { PendingSubmission } from '../answer/useSubmit';
import { useSeenDwell } from '../changes/useSeenDwell';
import './dock.css';

export const dockQuestionId = (session: Immutable<Session>, itemId: string) => `${itemId}:${session.items[itemId]?.question_revision}`;
export function dockQuestions(session: Immutable<Session> | null | undefined, drafts: OwnerDraftStore): DockQuestion[] {
  if (!session) return [];
  const route = { project_id: session.project_id, session_id: session.id };
  return Object.values(session.items).filter(item => {
    if (!item || !waitingOnOwner(session, item)) return false;
    const entry = drafts.find(route, item.id, 'answer');
    const input = entry?.receipt?.data.kind === 'input_submit' ? session.inputs[entry.receipt.data.input_id] : null;
    return !entry?.receipt || entry.draft.question_revision !== item.question_revision || input?.state === 'cancelled' || input?.state === 'needs_attention';
  }).sort((a, b) => (a!.waiting_since ?? '').localeCompare(b!.waiting_since ?? '') || a!.id.localeCompare(b!.id, undefined, { numeric: true }))
    .map(item => ({ id: dockQuestionId(session, item!.id), itemId: item!.id, question: item!.question }));
}

export interface AnswerDockProps {
  readonly store: SessionStore;
  readonly waiting: WaitingStore;
  readonly drafts: OwnerDraftStore;
  readonly onHeight: (height: number) => void;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  readonly onSeen?: (itemId: string, revision: number) => void;
}

/** Plain working dock. This layer never selects, focuses or scrolls anything in the Map. */
export function AnswerDock({ store, waiting, drafts, onHeight, onAgentNotRunning, onSeen }: AnswerDockProps) {
  const model = useMemo(() => new DockStore(), []), state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const current = useSession(store), session = current.snapshot?.session;
  const saved = useOwnerDrafts(drafts, session), queue = useWaiting(waiting);
  const route = current.route, sessionKey = JSON.stringify([route.project_id, route.session_id]);
  const root = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(loadDockHeight), [drag, setDrag] = useState<number | null>(null);
  const [others, setOthers] = useState(false), [draftList, setDraftList] = useState(false), [sentList, setSentList] = useState(false);
  const pointer = useRef<{ y: number; height: number; value: number } | null>(null);
  const questions = useMemo(() => dockQuestions(session, drafts), [session, drafts, saved.entries]);
  const reading = state.open && state.session === sessionKey ? session?.items[state.current?.itemId ?? ''] : null;
  const observe = useCallback(() => { if (reading) onSeen?.(reading.id, reading.revision); }, [onSeen, reading?.id, reading?.revision]);
  useSeenDwell(current.status === 'ready' && !current.error && reading ? `${sessionKey}:${reading.id}` : null, reading?.revision, onSeen ? observe : undefined);
  useLayoutEffect(() => {
    const selected = model.getSnapshot().current;
    if (session && selected && model.getSnapshot().session === sessionKey) {
      const entry = drafts.find(route, selected.itemId, 'answer');
      const item = session.items[selected.itemId];
      if (entry?.receipt && !questions.some(question => question.id === selected.id) && item?.question_revision === entry.draft.question_revision) model.sent(selected.id);
    }
    model.sync(sessionKey, questions);
  }, [model, questions, sessionKey, session, drafts, route]);
  useEffect(() => () => model.dispose(), [model]);
  useEffect(() => { setOthers(false); setDraftList(false); setSentList(false); }, [sessionKey]);
  const visibleHeight = state.open && state.current ? drag ?? height : DOCK_LINE;
  const heightCallback = useRef(onHeight); heightCallback.current = onHeight;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const update = () => heightCallback.current(element.getBoundingClientRect().height || visibleHeight);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update); observer?.observe(element);
    return () => observer?.disconnect();
  }, [visibleHeight, others, draftList, sentList]);
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.shiftKey
        || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"],[role="alertdialog"]')
        || document.querySelector('[aria-modal="true"]')) return;
      const plain = !event.metaKey;
      // A focused answer control owns its own choice/send keys, including in other sessions.
      if ((/^[1-9]$/.test(event.key) || event.metaKey && event.key === 'Enter') && event.target instanceof Element && event.target.closest('.answer')) return;
      if (plain && (event.key === '[' || event.key === ']')) model.step(event.key === '[' ? -1 : 1);
      else if (plain && event.key === 'Escape' && model.getSnapshot().open) model.fold();
      else if (model.getSnapshot().open && plain && /^[1-9]$/.test(event.key)) {
        root.current?.querySelector<HTMLButtonElement>(`[data-answer-option="${Number(event.key) - 1}"]`)?.click();
      } else if (model.getSnapshot().open && event.metaKey && event.key === 'Enter') root.current?.querySelector<HTMLButtonElement>('[data-answer-send]')?.click();
      else return;
      event.preventDefault(); event.stopPropagation();
    };
    document.addEventListener('keydown', keys, true);
    return () => document.removeEventListener('keydown', keys, true);
  }, [model]);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return;
    const value = pointer.current.height + pointer.current.y - event.clientY;
    pointer.current.value = value;
    if (value >= DOCK_MIN) { model.show(); setDrag(clampDockHeight(value, window.innerHeight - 96)); }
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return;
    const value = pointer.current.value; pointer.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDrag(null);
    if (value < DOCK_FOLD_THRESHOLD) model.fold();
    else { const next = clampDockHeight(value, window.innerHeight - 96); setHeight(next); saveDockHeight(next); model.show(); }
  };
  const otherRows = queue.waiting.filter(row => row.route.project_id !== route.project_id || row.route.session_id !== route.session_id);
  const entries = Object.values(saved.entries).filter(entry => entry.draft.session.project_id === route.project_id && entry.draft.session.session_id === route.session_id
    && !entry.receipt && (entry.draft.text || entry.draft.selected_option_id));
  const sentAnswers = session ? Object.values(session.inputs).filter(input => input?.kind === 'answer' && input.target.item_id && !['cancelled', 'skipped'].includes(input.state))
    .sort((a, b) => b!.seq - a!.seq).map(input => ({ id: input!.id, itemId: input!.target.item_id!, question: input!.payload.target_snapshot.item_question })) : [];
  for (const entry of Object.values(saved.entries)) if (entry.receipt?.data.kind === 'input_submit' && entry.draft.intent === 'answer' && entry.draft.session.project_id === route.project_id
    && entry.draft.session.session_id === route.session_id && entry.draft.target.item_id && !session?.inputs[entry.receipt.data.input_id])
    sentAnswers.push({ id: entry.receipt.data.input_id, itemId: entry.draft.target.item_id, question: session?.items[entry.draft.target.item_id]?.question ?? null });
  const index = questions.findIndex(question => question.id === state.current?.id);
  return <section ref={root} className="answer-dock" aria-label="Answer dock" data-open={state.open || undefined} style={{ height: visibleHeight }}>
    {(questions.length > 0 || state.current) && <div className="answer-dock-resize" role="separator" aria-label="Resize answer dock" aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={DOCK_MIN} aria-valuemax={2400} aria-valuenow={height}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); pointer.current = { y: event.clientY, height: visibleHeight, value: visibleHeight }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={resize} onPointerUp={finish} onPointerCancel={() => { pointer.current = null; setDrag(null); }}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Home') { model.fold(); return; }
        const next = clampDockHeight(height + (event.key === 'ArrowUp' ? 16 : -16), window.innerHeight - 96);
        setHeight(next); saveDockHeight(next); model.show();
      }} />}
    <div className="answer-dock-line">
      <button type="button" onClick={() => model.show()} disabled={!questions.length && !state.current}>{questions.length} waiting on you</button>
      {state.open && state.current && <>
        <button type="button" aria-label="Previous question" disabled={index <= 0} onClick={() => model.step(-1)}>[</button>
        <span>{Math.max(1, index + 1)} of {Math.max(1, questions.length)}</span>
        <button type="button" aria-label="Next question" disabled={index >= questions.length - 1} onClick={() => model.step(1)}>]</button>
        <select aria-label="Question pager" value={state.current.id} onChange={event => model.show(event.target.value)}>
          {index < 0 && <option value={state.current.id}>{state.current.question}</option>}
          {questions.map(question => <option key={question.id} value={question.id}>{question.question}</option>)}
        </select>
      </>}
      <button type="button" onClick={() => setSentList(value => !value)} aria-expanded={sentList}>{sentAnswers.length} sent</button>
      {entries.length > 0 && <button type="button" onClick={() => setDraftList(value => !value)} aria-expanded={draftList}>Draft kept on {entries.map(entry => `“${session?.items[entry.draft.target.item_id ?? '']?.question ?? entry.draft.target.item_id}”`).join(', ')}</button>}
      {otherRows.length > 0 && <button type="button" onClick={() => setOthers(value => !value)} aria-expanded={others}>{otherRows.length} in other sessions</button>}
      {state.open && <button type="button" onClick={() => model.fold()}>Fold the dock</button>}
    </div>
    {state.open && state.current && <div className="answer-dock-content">
      <p>{session?.topics[session.items[state.current.itemId]?.topic_id ?? '']?.name} › {state.current.question}</p>
      <AnswerSlot drafts={drafts} store={store} itemId={state.current.itemId} onEscape={() => model.fold()} onAgentNotRunning={onAgentNotRunning}
        onSent={() => { model.sent(state.current!.id); void store.refresh(); }} />
    </div>}
    {draftList && <div className="answer-dock-popover" aria-label="Kept drafts">{entries.map(entry => <div key={entry.draft.op_id}>
      <button type="button" disabled={!questions.some(question => question.itemId === entry.draft.target.item_id)} onClick={() => {
        model.show(questions.find(question => question.itemId === entry.draft.target.item_id)?.id); setDraftList(false);
      }}>{session?.items[entry.draft.target.item_id ?? '']?.question ?? 'Earlier question'}</button>
      <textarea readOnly aria-label="Kept words" value={entry.draft.text} />
    </div>)}</div>}
    {sentList && <div className="answer-dock-popover" aria-label="Sent answers">{sentAnswers.map(answer => <div key={answer.id}>
      <p>{answer.question}</p><QuestionDelivery drafts={drafts} store={store} itemId={answer.itemId} inputId={answer.id} />
    </div>)}</div>}
    {others && <OtherSessionQuestions waiting={waiting} drafts={drafts} currentSession={sessionKey} onAgentNotRunning={onAgentNotRunning} onClose={() => setOthers(false)} />}
  </section>;
}

export function OtherSessionQuestions({ waiting, drafts, currentSession, onAgentNotRunning, onClose }: {
  readonly waiting: WaitingStore; readonly drafts: OwnerDraftStore; readonly currentSession: string;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void; readonly onClose: () => void;
}) {
  const queue = useWaiting(waiting);
  const groups = new Map<string, typeof queue.waiting>();
  for (const row of queue.waiting) {
    const key = JSON.stringify([row.route.project_id, row.route.session_id]);
    if (key !== currentSession) groups.set(key, [...groups.get(key) ?? [], row]);
  }
  return <div className="answer-dock-popover" aria-label="Questions in other sessions">
    <button type="button" onClick={onClose}>Close other sessions</button>
    {queue.status !== 'ready' && <p role="status">{queue.error ? 'Some sessions could not be read. Showing the last questions.' : 'Updating questions…'}</p>}
    {[...groups].map(([key, rows]) => <section key={key}><h3>{rows[0]!.projectLabel} · {rows[0]!.sessionLabel}</h3>
      {rows.map(row => { const store = waiting.storeOf(row.route); return store && <div key={row.id}><p>{row.item.question}</p>
        <AnswerSlot drafts={drafts} store={store} itemId={row.item.id} onEscape={onClose} onAgentNotRunning={onAgentNotRunning}
          onSent={() => { void store.refresh(); void waiting.refresh(); }} />
      </div>; })}
    </section>)}
  </div>;
}
