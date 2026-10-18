// The answer dock (board screen 2, §5.2, §6.4): a 40px line, or the open dock at one waiting question of this session,
// floating over the Map and Details. It never opens by itself, and it never selects, focuses or scrolls anything in the
// Map: only the owner's own clicks on a path segment or on the question's title do (`onOpenItem`).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { useWaiting, type WaitingStore } from '../../selectors/waiting/store';
import { receiptWithdrawn, useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { DockStore, dockSessionKey } from '../../state/dock/store';
import { clampDockHeight, DOCK_LINE, DOCK_MIN, loadDockHeight, releaseDockHeight, saveDockHeight } from '../../state/dock/height';
import { useHidden } from '../remove/queue';
import { AnswerSlot } from '../detail/AnswerSlot';
import { QuestionDelivery } from '../answer/QuestionDelivery';
import type { PendingSubmission } from '../answer/useSubmit';
import { useSeenDwell } from '../changes/useSeenDwell';
import { peekNames } from '../peek/names';
import { navigationVisits } from '../navigation/visits';
import { ownerName } from '../shell/model';
import { agentProduct } from '../../state/navigation/switcher';
import { useDockModel } from './api';
import { useIntents } from '../intents';
import { closedLine, compareOtherGroups, dockPath, dockQuestions, dockStateChip, sentWaiting, waitingAge } from './model';
import { connectionKind } from '../shared/connection';
import './dock.css';

export { dockQuestions } from './model';

export interface AnswerDockProps {
  readonly store: SessionStore;
  readonly waiting: WaitingStore;
  readonly drafts: OwnerDraftStore;
  /** The waiting item Details is answering: it leaves the dock's list ("N more waiting"). */
  readonly answering?: string | null;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  readonly onSeen?: (itemId: string, revision: number) => void;
  /** A path segment: select that item. */
  readonly onOpenItem?: (itemId: string) => void;
  /** Test clock. */
  readonly now?: () => number;
}

const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],[role="alertdialog"]';
const quote = (text: string) => `“${text}”`;

export function AnswerDock({ store, waiting, drafts, answering = null, onAgentNotRunning, onSeen, onOpenItem, now = Date.now }: AnswerDockProps) {
  const context = useDockModel();
  const [local] = useState(() => context ? null : new DockStore());
  const model = context?.store ?? local!;
  useEffect(() => () => local?.dispose(), [local]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const current = useSession(store), session = current.snapshot?.session;
  const saved = useOwnerDrafts(drafts, session), queue = useWaiting(waiting);
  const hidden = useHidden();
  const route = current.route, sessionKey = dockSessionKey(route);
  const root = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(loadDockHeight), [drag, setDrag] = useState<number | null>(null);
  const [popover, setPopover] = useState<'others' | 'drafts' | 'sent' | null>(null);
  const [fullPath, setFullPath] = useState(false);
  const pointer = useRef<{ y: number; start: number; value: number } | null>(null);
  useEffect(() => { void waiting.start(); }, [waiting]);
  // `saved` is the drafts' snapshot: a new receipt or draft recomputes the list.
  const questions = useMemo(() => dockQuestions(session, drafts, itemId => itemId === answering || !!session && hidden.item(route, session, itemId)),
    [session, drafts, saved, answering, hidden, route]);
  const loaded = current.status !== 'loading' && !!session;
  useLayoutEffect(() => {
    const selected = model.getSnapshot().current;
    if (session && selected && model.getSnapshot().session === sessionKey) {
      const entry = drafts.find(route, selected.itemId, 'answer');
      const item = session.items[selected.itemId];
      // A receipt from any place (Details, the peek, a key) holds the question as Sent, then moves on.
      if (entry?.receipt && !questions.some(question => question.id === selected.id) && item?.question_revision === entry.draft.question_revision) model.sent(selected.id);
    }
    model.sync(sessionKey, questions, loaded);
  }, [model, questions, sessionKey, session, drafts, route, loaded]);
  useEffect(() => { setPopover(null); setFullPath(false); }, [sessionKey]);
  useEffect(() => { setFullPath(false); }, [state.current?.id]);
  const open = state.open && !!state.current && state.session === sessionKey;
  const reading = open ? session?.items[state.current!.itemId] : null;
  const observe = useCallback(() => { if (reading) onSeen?.(reading.id, reading.revision); }, [onSeen, reading?.id, reading?.revision]);
  useSeenDwell(current.status === 'ready' && !current.error && reading ? `${sessionKey}:${reading.id}` : null, reading?.revision, onSeen ? observe : undefined);
  // The rendered height goes to the provider: the Map and Details keep that much room at their bottom.
  const report = context?.setHeight;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !report) return undefined;
    const update = () => report(Math.round(element.getBoundingClientRect().height) || DOCK_LINE);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update); observer?.observe(element);
    return () => { observer?.disconnect(); };
  }, [report, open]);
  useEffect(() => () => report?.(0), [report]);
  // `[` and `]` are intents (ui/keys.ts): the workspace keymap asks for them anywhere outside a text box or dialog.
  useIntents({
    'dock.prev': ({ repeat }) => { if (!repeat) model.step(-1); return true; },
    'dock.next': ({ repeat }) => { if (!repeat) model.step(1); return true; },
    'dock.fold': () => { if (!model.getSnapshot().open) return false; model.fold(); return true; },
  });
  // 1–9 while the open dock has no rival for the focus; ⌘↵ only with the focus in the dock. A send elsewhere (Details)
  // disables its field and drops the focus to <body>, so a second ⌘↵ there must never send the dock's question.
  // An idle 1–9 also moves the focus to the option it picked, so the cards' own ⌘↵ and ↵ send it next.
  // Never Esc: Esc belongs to whatever has the focus. A key another handler took (defaultPrevented) is left alone.
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(editable) || document.querySelector('[aria-modal="true"]')) return;
      const inDock = !!target && !!root.current?.contains(target);
      const idle = !document.activeElement || document.activeElement === document.body;
      if (!model.getSnapshot().open || !(inDock || idle)) return;
      else if (!event.metaKey && /^[1-9]$/.test(event.key)) {
        if (inDock && target?.closest('.answer')) return;
        const choice = root.current?.querySelector<HTMLButtonElement>(`.answer-dock-current [data-answer-option="${Number(event.key) - 1}"]`);
        choice?.click(); choice?.focus();
      } else if (event.metaKey && event.key === 'Enter') {
        if (!inDock || target?.closest('.answer')) return;
        root.current?.querySelector<HTMLButtonElement>('.answer-dock-current [data-answer-send]')?.click();
      } else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [model]);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return;
    const value = pointer.current.start + pointer.current.y - event.clientY;
    pointer.current.value = value;
    if (value >= DOCK_MIN && model.getSnapshot().questions.length > 0) { if (!model.getSnapshot().open) model.show(); setDrag(clampDockHeight(value, window.innerHeight)); }
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointer.current) return;
    const value = pointer.current.value; pointer.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDrag(null);
    const result = releaseDockHeight(value, window.innerHeight);
    if (result.fold) { model.fold(); return; }
    setHeight(result.height); saveDockHeight(result.height);
    if (model.getSnapshot().questions.length > 0) model.show();
  };
  const names = useMemo(() => session ? peekNames(session) : new Map<string, string>(), [session]);
  const nameOf = (itemId: string) => names.get(itemId) ?? session?.items[itemId]?.question ?? itemId;
  const otherRows = queue.waiting.filter(row => dockSessionKey(row.route) !== sessionKey);
  const unsent = questions.filter(question => question.id !== model.holding());
  const kept = Object.values(saved.entries).filter(entry => entry.draft.intent === 'answer' && entry.draft.session.project_id === route.project_id
    && entry.draft.session.session_id === route.session_id && !entry.receipt && (entry.draft.text.trim() || entry.draft.selected_option_id)
    && entry.draft.target.item_id !== state.current?.itemId);
  const sent = sentWaiting(session, drafts);
  // A failed answer stays on its own question in the dock, with its Retry; it is not also "sent".
  const inDock = new Set(questions.map(question => question.itemId));
  const standing = session ? Object.values(session.inputs).filter(input => !!input && input.target.item_id
    && ['queued', 'in_flight', 'needs_attention'].includes(input.state)
    && !(input.state === 'needs_attention' && input.kind === 'answer' && inDock.has(input.target.item_id))).sort((a, b) => b!.seq - a!.seq) : [];
  // The pager reads the model's list, which keeps a just-sent question in its place: "1 of N" stays true during the hold.
  const paged = state.session === sessionKey ? state.questions : questions;
  const index = paged.findIndex(question => question.id === state.current?.id);
  const item = open ? session?.items[state.current!.itemId] : undefined;
  // The connection decides what the line says first (SPEC 5.12): loading, closed and unreadable take its place; the rest add a chip.
  // Unreadable with no read at all has no questions to show; with a last read the dock keeps them and a chip says answers wait.
  const kind = connectionKind(current), blind = kind === 'unreadable' && !session, replaced = kind === 'loading' || kind === 'closed' || blind;
  const stateChip = dockStateChip(kind);
  const waitingNow = unsent.length > 0 && !replaced;
  const toggle = (name: 'others' | 'drafts' | 'sent') => setPopover(value => value === name ? null : name);
  // "N sent" counts answers not picked up yet; with none, the chip still opens the list of picked-up or stuck ones.
  const sentCount = sent.length || standing.length;
  const sentChip = sentCount > 0 && <button type="button" className="dock-sent" aria-expanded={popover === 'sent'} onClick={() => toggle('sent')}
    title={sent.length ? 'Answers sent and not picked up yet' : 'Sent, picked up or needing a look'}>
    <i className="ph ph-paper-plane-tilt" aria-hidden="true" /><span className="dock-wide">{sentCount} sent{sent.length ? ', waiting for the agent' : ''}</span>
    <span className="dock-narrow" aria-hidden="true">{sentCount} sent</span></button>;
  const othersChip = otherRows.length > 0 && <button type="button" className="dock-others" aria-expanded={popover === 'others'} onClick={() => toggle('others')}
    title="Questions waiting on you in other sessions">
    <i className="ph ph-squares-four" aria-hidden="true" /><span className="dock-wide">{otherRows.length} in other sessions</span><span className="dock-narrow" aria-hidden="true">{otherRows.length} elsewhere</span></button>;
  // Drafts on other questions, or on one no longer waiting (withdrawn, session closed): reachable from the line too.
  const keptChip = kept.length > 0 && <button type="button" className="dock-draft" aria-expanded={popover === 'drafts'} title={kept.map(entry => nameOf(entry.draft.target.item_id ?? '')).join(', ')} onClick={() => {
    const target = questions.find(question => question.itemId === kept[0]!.draft.target.item_id);
    if (kept.length === 1 && target) model.show(target.id); else toggle('drafts');
  }}><i className="ph ph-pencil-simple" aria-hidden="true" /><span className="dock-wide">Draft kept on {quote(nameOf(kept[0]!.draft.target.item_id ?? ''))}{kept.length > 1 ? ` +${kept.length - 1}` : ''}</span>
    <span className="dock-narrow" aria-hidden="true">Draft kept</span></button>;
  const stateNote = stateChip && <span className="dock-state" data-kind={kind}><i className={stateChip.icon} aria-hidden="true" />
    <span className="dock-wide">{stateChip.wide}</span><span className="dock-narrow" aria-hidden="true">{stateChip.narrow}</span></span>;
  const visibleHeight = open ? drag ?? height : null;
  const first = unsent[0] ?? null;
  return <section ref={root} className="answer-dock" aria-label="Answer dock" data-open={open || undefined} data-waiting={waitingNow || open || undefined}
    data-sized={open && visibleHeight !== null || undefined}
    style={open && visibleHeight !== null ? { height: visibleHeight, '--dock-question-max': `${Math.max(40, Math.round((visibleHeight - 96) * 0.42))}px` } as React.CSSProperties : undefined}>
    {(open || waitingNow) && <div className="answer-dock-grip" role="separator" aria-label="Resize answer dock" aria-orientation="horizontal" tabIndex={0}
      title="Drag to change the dock’s height; drag it down to fold it" aria-valuemin={DOCK_MIN} aria-valuenow={visibleHeight ?? undefined}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = root.current?.getBoundingClientRect().height || DOCK_LINE;
        pointer.current = { y: event.clientY, start, value: start }; event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={resize} onPointerUp={finish} onPointerCancel={() => { pointer.current = null; setDrag(null); }}
      onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault(); event.stopPropagation();
        // Folded, ↑ opens the dock at its kept height; open, the arrows step it by 16px and fold it under 120.
        if (!open) { if (event.key === 'ArrowUp' && waitingNow) model.show(); return; }
        const base = visibleHeight ?? Math.max(DOCK_MIN, Math.round(root.current?.getBoundingClientRect().height ?? 0));
        const result = releaseDockHeight(base + (event.key === 'ArrowUp' ? 16 : -16), window.innerHeight);
        if (result.fold) { model.fold(); return; }
        setHeight(result.height); saveDockHeight(result.height);
      }}><span aria-hidden="true" /></div>}
    {!open ? <div className="answer-dock-line">
      {kind === 'loading' ? <span className="dock-line-text dock-line-quiet dock-line-loading" role="status">
        <i className="ph ph-circle-notch dock-muted" aria-hidden="true" /><span className="dock-skeleton" aria-hidden="true" />Checking for questions…</span>
        : kind === 'closed' ? <span className="dock-line-text dock-line-quiet"><i className="ph ph-lock-simple dock-muted" aria-hidden="true" />{closedLine(session)}</span>
          : blind ? <span className="dock-line-text dock-line-quiet"><i className="ph ph-warning-circle dock-danger" aria-hidden="true" />
            <span className="dock-wide">Questions in this session can’t be read until its file can.</span><span className="dock-narrow">Questions can’t be read right now.</span></span>
            : waitingNow ? <>
        <button type="button" className="dock-pill" title="Open the answer dock at this question" onClick={() => model.show(first!.id)}>
          <i className="ph-fill ph-question" aria-hidden="true" />{answering ? `${unsent.length} more waiting` : `${unsent.length} waiting`}</button>
        <span className="dock-line-text">{first!.question}</span>
      </> : answering && session?.items[answering] ? <span className="dock-line-text dock-line-quiet">
        <i className="ph-fill ph-question" aria-hidden="true" />Answering {quote(nameOf(answering))} in Details</span>
        : <span className="dock-line-text dock-line-quiet"><i className="ph ph-check-circle dock-done" aria-hidden="true" /><span>Nothing waiting on you<span className="dock-wide">. New questions open here.</span></span></span>}
      <span className="dock-spacer" />
      {blind ? <>{keptChip}{othersChip}</> : kind === 'closed' ? keptChip : replaced ? null : <>{stateNote}{keptChip}{sentChip}{othersChip}</>}
      {waitingNow && <button type="button" className="dock-icon" aria-label="Open the answer dock" title="Open the answer dock at the next waiting question ( ] )"
        onClick={() => model.show()}><i className="ph ph-caret-up" aria-hidden="true" /></button>}
    </div> : <>
      <div className="answer-dock-head">
        <i className="ph-fill ph-question dock-head-icon" aria-hidden="true" />
        <span className="dock-head-title">{answering ? 'Answering' : 'Waiting on you'}</span>
        <span className="dock-pager">
          <button type="button" className="dock-icon dock-small" aria-label="Previous question" title="Previous question ( [ )" disabled={index <= 0} onClick={() => model.step(-1)}>
            <i className="ph ph-arrow-left" aria-hidden="true" /></button>
          <span aria-live="polite">{Math.max(1, index + 1)} of {Math.max(1, paged.length)}</span>
          <button type="button" className="dock-icon dock-small" aria-label="Next question" title="Next question ( ] )" disabled={index >= paged.length - 1} onClick={() => model.step(1)}>
            <i className="ph ph-arrow-right" aria-hidden="true" /></button>
        </span>
        {keptChip}
        {session && item && <nav className="dock-path" aria-label="Question location">{dockPath(session, item.id, fullPath).map((part, at) => <span key={`${part.itemId ?? part.label}:${at}`} className="dock-crumb" data-more={part.more || undefined}>
          {at > 0 && <span className="dock-crumb-sep" aria-hidden="true">›</span>}
          {part.more ? <button type="button" className="dock-link" title="Show the full path" onClick={() => setFullPath(true)}>…</button>
            : part.itemId && onOpenItem ? <button type="button" className="dock-link" title={`Go to “${part.label}”`} onClick={() => onOpenItem(part.itemId!)}>{part.label}</button>
              : <span className="dock-crumb-text" title={part.full}>{part.label}</span>}</span>)}</nav>}
        <span className="dock-spacer" />
        {item?.waiting_since && <span className="dock-age dock-wide">Waiting {waitingAge(Date.parse(item.waiting_since), now())}</span>}
        {stateNote}{sentChip}{othersChip}
        <button type="button" className="dock-icon" aria-label="Fold the dock" title="Fold the dock" onClick={() => model.fold()}><i className="ph ph-caret-down" aria-hidden="true" /></button>
      </div>
      {/* Keyed by item, not question revision: a revised question keeps the owner's field, its text and its focus. */}
      {item && <div className="answer-dock-current" key={state.current!.itemId}>
        <div className="dock-question">
          <h2 className="dock-question-title">{onOpenItem
            ? <button type="button" className="dock-question-open" aria-label={`Open ${item.question}`} title={`Go to “${item.question}”`} onClick={() => onOpenItem(item.id)}>{item.question}</button>
            : item.question}</h2>
          {item.ask && <p className="dock-question-ask">{item.ask}</p>}
          {item.note && item.note.split(/\n{2,}/).map((paragraph, at) => <p key={at} className="dock-question-body">{paragraph}</p>)}
        </div>
        <AnswerSlot drafts={drafts} store={store} itemId={item.id} layout="dock" onEscape={() => {}} onAgentNotRunning={onAgentNotRunning}
          onSent={() => { navigationVisits.record(route, item.id, 'answered'); model.sent(state.current!.id); void store.refresh(); }} />
      </div>}
    </>}
    {popover === 'drafts' && <div className="dock-popover dock-popover-left" role="dialog" aria-label="Kept drafts">
      <div className="dock-popover-title">Drafts kept</div>
      {kept.map(entry => {
        const target = questions.find(question => question.itemId === entry.draft.target.item_id);
        return <div key={entry.draft.op_id} className="dock-kept">
          <button type="button" className="dock-link dock-kept-open" disabled={!target} onClick={() => { model.show(target?.id); setPopover(null); }}>{nameOf(entry.draft.target.item_id ?? '')}</button>
          {!target && <span className="dock-kept-note">No longer waiting. Your words are kept in Details.</span>}
          {entry.draft.text && <textarea className="dock-kept-words" readOnly aria-label="Kept words" value={entry.draft.text} rows={2} />}
        </div>;
      })}
    </div>}
    {popover === 'sent' && <div className="dock-popover" role="dialog" aria-label="Sent answers">
      <div className="dock-popover-title">Sent, waiting for the agent</div>
      {standing.map(input => <div key={input!.id} className="dock-sent-row"><p>{input!.payload.target_snapshot.item_question ?? input!.payload.target_snapshot.topic_name}</p>
        <QuestionDelivery drafts={drafts} store={store} itemId={input!.target.item_id!} inputId={input!.id} /></div>)}
      {sent.filter(id => !session?.inputs[id]).length > 0 && <p className="dock-kept-note" role="status">Sending…</p>}
    </div>}
    {popover === 'others' && <OtherSessionQuestions waiting={waiting} drafts={drafts} currentSession={sessionKey} onAgentNotRunning={onAgentNotRunning} now={now} />}
  </section>;
}

export function OtherSessionQuestions({ waiting, drafts, currentSession, onAgentNotRunning, now = Date.now }: {
  readonly waiting: WaitingStore; readonly drafts: OwnerDraftStore; readonly currentSession: string;
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void; readonly now?: () => number;
}) {
  const queue = useWaiting(waiting), hidden = useHidden();
  const [openRow, setOpenRow] = useState<string | null>(null);
  const groups = new Map<string, typeof queue.waiting>();
  for (const row of queue.waiting) {
    const key = dockSessionKey(row.route);
    const captured = waiting.sessionState(row.route)?.snapshot?.session;
    if (key === currentSession || captured && hidden.item(row.route, captured, row.item.id)) continue;
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const incomplete = queue.counts?.completeness === 'partial' || queue.unavailableProjects.length > 0;
  return <div className="dock-popover dock-others-list" role="dialog" aria-label="Questions in other sessions">
    <div className="dock-popover-title">Waiting in other sessions</div>
    {queue.status === 'stale' && <p className="dock-kept-note" role="status">Showing the last complete read. Refresh is pending.</p>}
    {queue.error && <p className="dock-kept-note" role="alert">Some sessions could not be read. Showing the last questions.
      <button type="button" className="btn btn-secondary" onClick={() => { void waiting.refresh(); }}>Refresh</button></p>}
    {incomplete && <p className="dock-kept-note" role="status">Some projects couldn’t be read, so this list may be short.</p>}
    {[...groups].map(([key, rows]) => {
      const session = waiting.sessionState(rows[0]!.route)?.snapshot?.session;
      const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
      return { key, rows, agent: binding ? agentProduct(binding.adapter_id) : 'the agent', name: (session && ownerName(session)) ?? rows[0]!.sessionLabel, project: rows[0]!.projectLabel };
    }).sort(compareOtherGroups).map(({ key, rows, agent, name }) => {
      return <section key={key} className="dock-other-group">
        <h3><i className="ph ph-terminal-window" aria-hidden="true" />{rows[0]!.projectLabel} · {name}</h3>
        {rows.map(row => {
          const store = waiting.storeOf(row.route), expanded = openRow === row.id;
          const entry = drafts.find(row.route, row.item.id, 'answer'), read = waiting.sessionState(row.route)?.snapshot?.session;
          // A cancelled or skipped answer is not "Sent": the question waits again.
          const answered = !!entry?.receipt && !(read && receiptWithdrawn(entry, read));
          return <div key={row.id} className="dock-other-row" data-open={expanded || undefined}>
            <button type="button" className="dock-other-head" aria-expanded={expanded} title={expanded ? 'Fold it' : 'Read and answer it here'}
              onClick={() => setOpenRow(value => value === row.id ? null : row.id)}>
              <i className={answered ? 'ph ph-paper-plane-tilt' : 'ph-fill ph-question'} aria-hidden="true" />
              <span className="dock-other-text">{row.item.question}</span>
              <span className="dock-other-age">{answered ? 'Sent' : row.item.waiting_since ? waitingAge(Date.parse(row.item.waiting_since), now()) : ''}</span>
              <i className={expanded ? 'ph ph-caret-down' : 'ph ph-caret-right'} aria-hidden="true" />
            </button>
            {expanded && store && <AnswerSlot drafts={drafts} store={store} itemId={row.item.id} layout="list" onEscape={() => setOpenRow(null)} onAgentNotRunning={onAgentNotRunning}
              hint={`Goes to ${agent} in “${name}”, once.`}
              onSent={() => { navigationVisits.record(row.route, row.item.id, 'answered'); void store.refresh(); void waiting.refresh(); }} />}
          </div>;
        })}
      </section>;
    })}
    <p className="dock-others-foot">Answer here and stay in this session. Each answer goes to its own session’s agent, once. The switcher by the logo takes you there.</p>
  </div>;
}
