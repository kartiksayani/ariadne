import { itemRemoved } from '../../selectors/removed';
// The item detail panel (handoff README §5 "Item detail"; Ariadne.dc.html
// lines 324-464), laid out like a chat. The shell's aside holds the header;
// DetailPath fills the header's breadcrumb and ItemDetail the body: what the
// item is (head, delivery, outcome, why, children, links) scrolls
// and ends in the chat, oldest first; the owner's composer stays
// docked under it (quick replies above a reply box that grows as you type).
import { useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { sessionActionsFor } from '../../components/bindings/actions';
import { PausedNote } from '../../components/bindings/DispatchChip';
import { useSupervisorHealth } from '../../components/bindings/health';
import type { OwnerFocusRequest, PendingSubmission } from '../answer/useSubmit';
import { ackTarget, ackTitle, useAck } from '../shared/ack';
import { STATUS } from '../shared/status';
import { StuckNote } from '../answer/StuckNote';
import { NotSentLine } from '../answer/NotSentLine';
import { editable, editQueued, inEditor, putBackBlocked, putBackCancelled, sendingAgain } from '../answer/held';
import { useGrow } from '../answer/useGrow';
import { AnswerSlot, answerSlotError, changedText } from './AnswerSlot';
import { FileRefProject, fileLinkProps, ItemReference, ItemRefs, LinkOpener, Markdown, singleParagraph, useProjectFile } from '../shared/MarkdownText';
import { fileLinkTitle, fileReference, safeHref } from '../shared/markdown';
import { copyText } from '../shared/clipboard';
import { shortLabel } from '../shared/short';
import { displayStatus } from '../../selectors/waiting/replied';
import { CopyMessage } from './CopyMessage';
import { StatusBadge } from '../shared/StatusBadge';
import { actionText, boxText, detailModel, detailPath, type ActionKey, type Kid, type LinkView, type OpenMode, type PendingView, type WordsKind } from './model';
import { useDetailSubmit, type DraftTarget, type Words } from './submit';
import './detail.css';

/** The pane is scrolled to (nearly) its end. */
const nearEnd = (pane: HTMLElement) => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;

/** Return focus to the item's row so workspace keys work again. */
function focusRoot(itemId: string) {
  const row = [...document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`)].find(element => !element.closest('.shell-detail'));
  if (row) row.focus();
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function DetailPath({ store, itemId, onOpenItem }: { readonly store: SessionStore; readonly itemId: string; readonly onOpenItem: (itemId: string) => void }) {
  const session = useSession(store).snapshot?.session;
  const path = session ? detailPath(session, itemId) : [];
  return <nav className="detail-path" aria-label="Item location">
    {path.map((crumb, index) => <span className="detail-crumb" key={crumb.itemId ?? 'topic'}>
      {/* The topic crumb has no reveal target yet; item crumbs open their item. */}
      <button type="button" onClick={() => { if (crumb.itemId) onOpenItem(crumb.itemId); }}>{crumb.label}</button>
      {index < path.length - 1 && <i className="ph ph-caret-right" aria-hidden="true" />}
    </span>)}
  </nav>;
}

export interface ItemDetailProps {
  readonly drafts: OwnerDraftStore;
  readonly store: SessionStore;
  readonly itemId: string;
  readonly later: boolean;
  readonly onLater?: (value: boolean) => Promise<boolean>;
  readonly onBring?: () => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly focusRequest?: OwnerFocusRequest;
  readonly onFocusRequestConsumed?: (token: number) => void;
  readonly highlightedMessageIds?: ReadonlySet<string>;
  /** A send while the agent isn't running opens the "Agent isn't running" dialog (1ad). */
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** Set for an earlier session's item: its message numbers read "codex #19" (shared/excerpt earlierAgent). */
  readonly earlierAgent?: string | null;
  /** Where a copied item came from (its Source item button): shown with the item's references, not under the composer. */
  readonly provenance?: ReactNode;
  readonly hiddenItemIds?: readonly string[];
}

const sectionLabel = (text: string) => <div className="detail-label">{text}</div>;

const kindName: Readonly<Record<WordsKind, string>> = { reply: 'reply', note: 'note', followup: 'follow-up' };

interface WordsFieldProps {
  readonly slot: Words;
  /** What the words go out as now. */
  readonly sentAs: WordsKind;
  readonly first: boolean;
  /** Hands the box's textarea to the panel, so a key can focus the draft it names. */
  readonly register: (element: HTMLTextAreaElement | null) => void;
  readonly sendOff: boolean;
  /** The box was opened by a button and holds no words: it can be closed. */
  readonly closable: boolean;
  readonly onEdit: (text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onReview: () => void;
}

/**
 * One draft of the owner's words. It edits its own draft in place and is labelled by what it will be sent as, so the
 * owner sees the kind before sending. Its mount does not depend on the section around it, so typing and focus survive
 * the item changing status.
 */
function WordsField({ slot, sentAs, first, register, sendOff, closable, onEdit, onKeyDown, onSend, onCancel, onReview }: WordsFieldProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const attach = (element: HTMLTextAreaElement | null) => { ref.current = element; register(element); };
  useGrow(ref, slot.text);
  // A locked draft (an attempt in flight or awaiting a retry) goes out as the kind it was saved with: its label, button and
  // hint name that kind, and it carries no note about a change.
  const kind = slot.locked ? slot.kind : sentAs, text = boxText[kind], noteId = useId();
  const note = slot.kind !== sentAs && !slot.locked;
  return <>
    {slot.changed && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{changedText}</span>
      <button type="button" className="btn btn-secondary answer-warn-action" disabled={slot.locked} onClick={onReview}>Review current target</button></div>}
    <div className="detail-box">
      {note && <p className="detail-box-note" id={noteId}>{`This will be sent as a ${kindName[sentAs]}, which fits the item now. You wrote it as a ${kindName[slot.kind]}.`}</p>}
      <textarea ref={attach} className="input" rows={1} aria-label={first ? text.label : `${text.label}, another draft`} aria-describedby={note ? noteId : undefined}
        placeholder={text.placeholder} value={slot.text} disabled={slot.locked} onChange={event => onEdit(event.target.value)} onKeyDown={onKeyDown} />
      <div className="detail-box-row">
        <button type="button" className="btn btn-primary" disabled={sendOff} aria-label={first ? text.button : `${text.button}, another draft`} onClick={onSend}>
          <i className="ph ph-paper-plane-right" aria-hidden="true" />{text.button}</button>
        {closable && <button type="button" className="btn btn-ghost detail-cancel" onClick={onCancel}>Cancel</button>}
        <span className="detail-box-hint">{closable ? text.hint : text.hint.replace('Esc cancels, keeps your draft', 'Esc leaves the box, keeps your draft')}</span>
      </div>
    </div>
  </>;
}

/** "You replied: “…”" for a one-paragraph reply; a longer reply keeps its paragraphs and lists below the words. */
function OwnerReply({ text }: { readonly text: string }) {
  return <ItemRefs.Provider value={null}>{singleParagraph(text)
    ? <span>You replied: “<Markdown text={text} inline />”</span>
    : <div className="detail-reply"><span>You replied:</span><Markdown text={text} /></div>}</ItemRefs.Provider>;
}

/** What the owner sent, inside their bubble: the option they chose, a one-press request, or their own words. */
function YouSaid({ how, text, note = '' }: { readonly how: PendingView['how']; readonly text: string; readonly note?: string }) {
  return <>
    <i className={`${how === 'chose' ? 'ph ph-check-circle' : 'ph ph-user'} detail-msg-icon detail-you-icon`} aria-hidden="true" />
    {how === 'chose' ? <div className="detail-reply"><span>{`You chose “${text}”`}</span>{note.trim() && <ItemRefs.Provider value={null}><Markdown text={note} /></ItemRefs.Provider>}</div> : how === 'action' ? <div className="detail-reply"><span>{text}</span>{note.trim() && <ItemRefs.Provider value={null}><Markdown text={note} /></ItemRefs.Provider>}</div> : <OwnerReply text={text} />}
  </>;
}

function KidButton({ kid, onOpen }: { readonly kid: Kid; readonly onOpen: (id: string) => void }) {
  return <button type="button" className={`detail-kid${kid.closed ? ' detail-kid-closed' : ''}`} onClick={() => onOpen(kid.id)}>
    <span className="detail-kid-icon"><StatusBadge status={kid.status} variant="icon" size={15} /></span><span className="detail-kid-text">{kid.question}</span>
  </button>;
}

/** A short child list scrolls independently; its fade disappears once the last row is visible. */
function ChildrenBox({ kids, onOpen }: { readonly kids: readonly Kid[]; readonly onOpen: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => { const node = box.current; if (node) setMore(node.scrollHeight - node.clientHeight - node.scrollTop > 1); };
  useEffect(() => {
    measure();
    if (!box.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [kids]);
  return <div className={`detail-kids-box${more ? ' detail-kids-more' : ''}`}>
    <div className="detail-kids-scroll" ref={box} onScroll={measure} onFocus={event => {
      const node = event.currentTarget, row = event.target.getBoundingClientRect(), bounds = node.getBoundingClientRect();
      if (row.bottom > bounds.bottom) node.scrollTop += row.bottom - bounds.bottom;
      else if (row.top < bounds.top) node.scrollTop -= bounds.top - row.top;
      measure();
    }}>{kids.map(kid => <KidButton key={kid.id} kid={kid} onOpen={onOpen} />)}</div>
  </div>;
}

/**
 * One of the item's links. A web address opens in the browser (and is the link's real address, shown on hover);
 * a file opens in the text editor once the desktop finds it in the project's folder; anything else is plain text.
 */
function ItemLink({ link }: { readonly link: LinkView }) {
  const open = useContext(LinkOpener), file = useProjectFile(link.target), web = safeHref(link.target);
  const body = <><i className={link.icon} aria-hidden="true" /><span className="detail-link-label">{link.label}</span>{link.meta && <span className="detail-link-meta">{link.meta}</span>}</>;
  if (link.kind === 'item') return <ItemReference className="detail-link" itemId={link.target}>{body}</ItemReference>;
  if (web) {
    const click = (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); event.stopPropagation(); open(web); };
    return <a className="detail-link" href={web} title={web} rel="noreferrer noopener" onClick={click}>{body}</a>;
  }
  const reference = fileReference(link.target);
  if (file && reference) return <a className="detail-link" {...fileLinkProps(fileLinkTitle(reference), file.open)}>{body}</a>;
  return <div className="detail-link detail-link-plain">{body}</div>;
}

export function ItemDetail({ drafts, store, itemId, later, onLater, onBring, onOpenItem, focusRequest, onFocusRequestConsumed, highlightedMessageIds, onAgentNotRunning, earlierAgent = null, provenance, hiddenItemIds }: ItemDetailProps) {
  const current = useSession(store), session = current.snapshot?.session;
  const item = session?.items[itemId];
  const submit = useDetailSubmit(drafts, store, itemId);
  const draftState = useOwnerDrafts(drafts, session);
  // A failed answer stays reachable after the question closes, outside the answer control.
  const retained = session && draftState.ready ? drafts.find({ project_id: session.project_id, session_id: session.id }, itemId, 'answer') : undefined;
  const [mode, setMode] = useState<OpenMode | null>(null);
  const [focusBox, setFocusBox] = useState(0);
  const [copied, setCopied] = useState(false);
  const [laterError, setLaterError] = useState(false);
  // The drop reason is local; the sent text wraps it (Ariadne.dc.html:1207).
  const [reason, setReason] = useState('');
  // The boxes' textareas by key, and the key of the one typed in last: `r` goes to that draft (else the newest).
  const boxes = useRef(new Map<string, HTMLTextAreaElement>()), edited = useRef<string | null>(null), dropBox = useRef<HTMLInputElement>(null);
  const handled = useRef<number | null>(null);
  // The scrolling body, and whether the owner is reading its end (the latest message) or has scrolled up.
  const body = useRef<HTMLDivElement>(null), atEnd = useRef(true), justSent = useRef(false);
  const presence = session?.active_binding_id ? current.presence[session.active_binding_id] ?? null : null;
  // The session's write barrier, shared with the session bar: Resume, Cancel and Retry go through it.
  const actions = useMemo(() => sessionActionsFor(drafts.service, store), [drafts, store]);
  const ack = useAck(actions, itemId);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : undefined;
  const health = useSupervisorHealth(drafts.service, binding?.id, binding?.generation);
  const model = session ? detailModel({ session, itemId, now: Date.now(), mode, later, saving: submit.saving, presence, health, earlierAgent,
    replyDraft: mode === 'reply' || submit.written.length > 0, hiddenItemIds }) : null;
  const round = item?.current_round_id ? session?.rounds[item.current_round_id] : null;
  const currentQuestionOpen = item?.status === 'waiting_on_me' && !!round && round.closed_at === null
    && round.question_revision === item.question_revision;
  const archived = session?.archived_at != null || (item && session?.topics[item.topic_id]?.archived_at != null);
  const showAnswer = !archived && currentQuestionOpen && !!(model?.answer || retained?.uncertain || retained?.error);
  const savedAnswers = !showAnswer && session ? drafts.savedAnswers({ project_id: session.project_id, session_id: session.id }, itemId) : [];
  const ackTo = session && item ? ackTarget(session, item) : null;
  // An open item is replied to and an in-progress item gets notes: that box is always there, never behind a button. Other
  // boxes (drop reason, follow-up on a finished item) open on press.
  // Words are bound to the draft they were typed in: the box edits that draft in place whatever the item's status does, and
  // the label says what the words go out as now (`fit`). Every draft that holds words shows, so none is ever hidden.
  const fit = model?.box ?? null;
  // A box the owner opened stays only while its action is still offered (Drop goes once a message is on its way).
  const modeFits = (value: OpenMode) => !!model && ((value === 'reply' && !!model.followUp) || !!model.open?.actions.some(action => action.action === value));
  const shownMode = mode && modeFits(mode) ? mode : null;
  const standingEmpty = !!model && !!fit && !!model.open && (model.status === 'open' || model.status === 'progress');
  const dropOpen = shownMode === 'drop';
  const wantBlank = !!fit && ((standingEmpty && !dropOpen) || (!!shownMode && shownMode !== 'drop'));
  const slots: readonly Words[] = !fit ? [] : submit.written.length ? submit.written : wantBlank ? [submit.blank(fit)] : [];
  useEffect(() => { if (mode && model && !modeFits(mode)) setMode(null); });
  // A box is keyed by its draft, so removing one draft never hands its mount (and the owner's focus) to another. The empty box
  // keeps one key when its first keystroke makes it a draft, so that keystroke does not remount the textarea.
  // A saved draft the owner empties keeps the key it had, so its textarea (focus, caret) stays mounted.
  const lead = useRef<string | null>(null), blankShown = useRef(false);
  if (blankShown.current && slots[0]?.id) lead.current = slots[0].id;
  blankShown.current = slots.length === 1 && slots[0]?.id === null;
  const slotKey = (slot: Words) => slot.id === null || slot.id === lead.current ? 'blank' : slot.id;

  // Open at the conversation: its start for an unanswered ask, its end after an exchange.
  // The item's references remain above it in the same scroller. Arrivals leave a reader where they are.
  const showLatest = () => {
    const pane = body.current;
    if (!pane) return;
    if (pane.querySelector('.detail-chat [data-owner-said="true"], .detail-chat .detail-msg-result')) pane.scrollTop = pane.scrollHeight;
    else {
      const chat = pane.querySelector('.detail-chat');
      if (chat) pane.scrollTop += chat.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    }
    atEnd.current = nearEnd(pane);
  };
  const sentJustNow = () => { justSent.current = true; showLatest(); };
  const chatKey = model ? model.chat.map(entry => `${entry.id}:${entry.message.body}:${entry.result}:${entry.pending?.input.state}:${entry.asks.map(ask => `${ask.text}:${ask.now}`).join(',')}:${entry.forks.length}`).join('|') : null;
  useEffect(() => {
    if (chatKey === null) return;
    if (atEnd.current || justSent.current) showLatest();
    justSent.current = false;
  }, [chatKey]);
  // The composer growing shrinks the scrolling body; at the end of the chat, the end stays in view.
  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => { if (atEnd.current) showLatest(); });
    watch.observe(element);
    return () => watch.disconnect();
  }, [chatKey === null]);

  // Words open in the box that fits the status, whichever box the action or a put-back names.
  const openBox = (next: OpenMode) => { setMode(next === 'drop' || !fit ? next : fit); setFocusBox(value => value + 1); };
  const closeBox = () => { setMode(null); focusRoot(itemId); };
  const send = async (target: DraftTarget, text: string, as?: 'reply' | 'note' | 'followup') => {
    const sent = await submit.send(target, text, as);
    if (sent) { setMode(null); sentJustNow(); }
    return sent;
  };
  const sendWords = (slot: Words) => { if (fit && slot.text.trim()) void send(slot, slot.text, fit); };
  const sendDrop = () => { if (model) void send('drop', actionText('drop', model.question, reason)).then(sent => { if (sent) setReason(''); }); };
  const toggleLater = async () => { try { setLaterError(!await onLater?.(!later)); } catch { setLaterError(true); } };
  const act = (action: ActionKey) => {
    if (!model) return;
    if (action === 'bring') onBring?.();
    else if (action === 'later') void toggleLater();
    else if (action === 'reopen') void send('reopen', actionText('reopen', model.question));
    else openBox(action);
  };

  useEffect(() => {
    if (!focusBox) return;
    if (dropOpen) { dropBox.current?.focus(); return; }
    const keys = slots.map(slotKey), key = edited.current !== null && keys.includes(edited.current) ? edited.current : keys.at(-1);
    if (key !== undefined) boxes.current.get(key)?.focus();
  }, [focusBox]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  // Keyboard actions arrive from the workspace keymap as focus requests.
  useEffect(() => {
    if (!focusRequest || handled.current === focusRequest.token || !model || !item) return;
    const { intent, token } = focusRequest;
    if (intent === 'answer' || (model.status === 'waiting' && intent === 'reply' && !model.followUp)) return;
    handled.current = token;
    onFocusRequestConsumed?.(token);
    if (model.followUp) { if (intent === 'reply' && !model.followUp.disabled) openBox('reply'); return; }
    if (!model.open) return;
    const available = new Set(model.open.actions.filter(action => !action.disabled).map(action => action.action));
    if ((intent === 'reply' || intent === 'note' || intent === 'followup' || intent === 'drop') && available.has(intent)) openBox(intent);
    else if (intent === 'reopen' && available.has('reopen')) void send('reopen', actionText('reopen', model.question));
  });

  if (!session || !item || !model) return <p role="status">The current item is unavailable. Refresh its registered session.</p>;
  // A reopen that could not go out was written against an older item (OwnerInput's Review step). Only the Open section offers it.
  const reopenStale = !!model.open && submit.changed('reopen');
  const answerFocus = focusRequest && model.status === 'waiting' && !model.followUp && focusRequest.intent === 'reply' ? { ...focusRequest, intent: 'answer' as const } : focusRequest;
  const copy = () => {
    void copyText(`${model.id} — ${model.question}`).then(() => setCopied(true), () => {});
  };
  // The owner's boxes, docked in one place whatever section the item's status shows above them, so a box keeps its mount (and
  // the owner's focus and caret) when the status changes. data-owner-input marks them with their changed-target warnings, like the
  // answer slot (native tests).
  // A box that holds words has nothing to cancel: its text is kept either way, and Esc only leaves it. Offline, its send waits for the connection.
  const sendHeld = !!fit && !!model.open?.actions.find(value => value.action === fit)?.disabled;
  const closable = submit.written.length === 0 && !standingEmpty;
  // The Send button and the keys follow one rule: nothing goes out while this says no.
  const sendOff = (slot: Words) => !submit.ready || submit.saving !== null || slot.changed || sendHeld || !slot.text.trim();
  const wordsKey = (slot: Words) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeBox(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.stopPropagation(); event.preventDefault(); if (!sendOff(slot)) sendWords(slot); }
  };
  const dropKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeBox(); return; }
    if (event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); if (!dropOff) sendDrop(); }
  };
  const dropOff = !submit.ready || submit.saving !== null;
  const owner = (slots.length > 0 || dropOpen || reopenStale) && <div className="detail-owner-input" data-owner-input={itemId}>
    <PausedNote actions={actions} />
    {reopenStale && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{changedText}</span>
      <button type="button" className="btn btn-secondary answer-warn-action" disabled={submit.locked('reopen')} onClick={() => submit.review('reopen')}>Review current target</button></div>}
    {fit && slots.map((slot, index) => <WordsField key={slotKey(slot)} slot={slot} sentAs={fit} first={index === 0} sendOff={sendOff(slot)}
      register={element => { const key = slotKey(slot); if (element) boxes.current.set(key, element); else boxes.current.delete(key); }}
      closable={closable} onEdit={value => { edited.current = slotKey(slot); submit.edit(slot, value); }} onKeyDown={wordsKey(slot)} onSend={() => sendWords(slot)} onCancel={closeBox}
      onReview={() => submit.review(slot)} />)}
    {dropOpen && <div className="detail-box">
      <input ref={dropBox} className="input" aria-label="Drop reason" placeholder="Reason (optional), e.g. the metric already covers it" value={reason}
        disabled={submit.locked('drop')} onChange={event => setReason(event.target.value)} onKeyDown={dropKey} />
      <div className="detail-box-row">
        <button type="button" className="btn btn-secondary" disabled={dropOff} onClick={sendDrop}>
          <i className="ph ph-x-circle" aria-hidden="true" />Drop item</button>
        <button type="button" className="btn btn-ghost detail-cancel" onClick={closeBox}>Cancel</button>
        <span className="detail-box-hint">Enter drops · the agent confirms</span>
      </div>
    </div>}
  </div>;
  const docked = !!(model.open || model.followUp || showAnswer || savedAnswers.length > 0 || owner || ackTo || ack.error || submit.error);
  return <ItemRefs.Provider value={{ lookup: id => {
    const target = session.items[id];
    return target && !itemRemoved(session, target.id) ? { label: shortLabel(target), status: displayStatus(session, target) } : null;
  }, onOpenItem }}><FileRefProject.Provider value={session.project_id}><article className="item-detail" data-detail-item-id={itemId} data-status={model.status} aria-label={`Detail of #${model.id}`}>
    <div className="detail-body" ref={body} onScroll={event => { atEnd.current = nearEnd(event.currentTarget); }}>
    <div className="detail-head">
      {/* The handoff embeds the badge in a block host; its line box makes the row 23px. */}
      <div className="detail-status"><div className="detail-badge"><StatusBadge status={model.display} label={model.badgeLabel} /></div>
        <span className="detail-meta">{model.meta}</span>
        <span className="detail-reference"><span>Agent reference</span><button type="button" className="btn btn-ghost detail-copy" onClick={copy}>
          <i className={copied ? 'ph ph-check' : 'ph ph-copy'} aria-hidden="true" />{copied ? 'Copied' : 'Copy reference'}</button></span></div>
      <h2 className="detail-question"><Markdown text={model.question} inline /></h2>
    </div>

    {model.steps && <section className="detail-section detail-steps" aria-label={model.stepsTitle}>
      {sectionLabel(model.stepsTitle)}
      <div className="detail-stepper">{model.steps.map(step => <div className="detail-step" key={step.label}>
        <div className="detail-step-track"><span className="detail-step-dot" style={{ background: step.dotBg, boxShadow: step.dotRing }} />
          {step.line && <span className="detail-step-line" style={{ background: step.lineBg }} />}</div>
        <span className="detail-step-label" style={{ color: step.color, fontWeight: step.weight }}>{step.label}</span>
      </div>)}</div>
      {model.delivery && <div className="detail-delivery" role="status" style={{ color: model.delivery.color }}>
        <i className={model.delivery.icon} aria-hidden="true" /><span>{model.delivery.text}</span></div>}
    </section>}

    {model.outcome && <section className="detail-section detail-outcome" aria-label="Current outcome">
      <div className="detail-label" style={{ color: model.outcome.color }}>{model.outcome.label}</div>
      <Markdown className="detail-outcome-text" text={model.outcome.text} />
    </section>}

    {model.note && <div className="detail-note"><i className="ph ph-robot" aria-hidden="true" /><Markdown text={model.note} inline /></div>}

    {model.why && <section className="detail-section detail-why">{sectionLabel('Why')}<Markdown className="detail-why-text" text={model.why} /></section>}

    {model.replaced && <section className="detail-section">
      {sectionLabel('Replaced by')}
      <button type="button" className="detail-replaced" onClick={() => onOpenItem(model.replaced!.id)}>
        <i className="ph ph-arrow-bend-down-right" aria-hidden="true" /><span>{model.replaced.question}</span><StatusBadge status={model.replaced.status} variant="text" />
      </button>
    </section>}

    {model.kids.length > 0 && <section className="detail-section detail-kids" aria-label="Child items">
      {sectionLabel(model.kidLabel)}
      <ChildrenBox kids={model.kids} onOpen={onOpenItem} />
    </section>}

    {model.related.length > 0 && <section className="detail-section detail-related" aria-label="Related items">
      {sectionLabel('Related items')}
      {model.related.map(target => <button key={target.id} type="button" className={`detail-related-item${target.hidden ? ' is-hidden' : ''}`}
        title={target.question} aria-label={`#${target.id} ${target.label}${target.hidden ? ' (hidden)' : ''} · ${STATUS[target.status].label}`} onClick={() => onOpenItem(target.id)}>
        <span className="detail-related-number">#{target.id}</span><span className="detail-related-label">{target.label}</span>
        {target.hidden && <span className="detail-related-hidden">Hidden</span>}<StatusBadge status={target.status} variant="text" />
      </button>)}
    </section>}

    {model.links.length > 0 && <section className="detail-section detail-links" aria-label="Item links">
      {sectionLabel('Links')}
      {model.links.map((link, index) => <ItemLink key={index} link={link} />)}
    </section>}

    {provenance && item.origin && <section className="detail-section detail-provenance" aria-label="Original item">
      {sectionLabel('Copied from')}
      {provenance}
    </section>}

    {model.prev && <section className="detail-section" aria-label="Former outcome">
      <div className="detail-label detail-label-row"><span>Before you reopened it</span><StatusBadge status={model.prev.status} variant="text" /></div>
      <Markdown className="detail-prev" text={model.prev.outcome} />
    </section>}

    {model.chat.length > 0 && <section className="detail-section detail-chat" aria-label="Conversation">
      <ol className="detail-chat-list">
        {model.chat.map(entry => <li key={entry.id} data-message-id={entry.id} data-pending={entry.pending?.input.id}
          data-round={entry.asks[0]?.ordinal}
          data-owner-said={entry.you && !Object.values(session.inputs).some(input => input?.message_id === entry.id && input.state === 'cancelled') ? 'true' : undefined}
          className={`detail-turn${entry.unsent ? ' detail-turn-cancelled' : ''}${entry.asks.some(ask => ask.now) ? ' detail-turn-now' : ''}${entry.pending ? ' detail-turn-pending' : ''}${highlightedMessageIds?.has(entry.id) ? ' excerpt-highlighted' : ''}`}>
          {entry.marker && <div className="detail-chat-marker">{entry.marker}</div>}
          <div className={`detail-msg${entry.you ? ' detail-msg-you' : ''}`}>
            <div className={`detail-bubble ${entry.you ? 'detail-bubble-you' : 'detail-bubble-agent'}`}>
              {entry.you ? <><YouSaid {...entry.you} /><span className="detail-pending-caption">you · {entry.message.when}</span>
                {entry.pending?.caption && <span className="detail-pending-caption">{entry.pending.caption}</span>}</>
                : <><div className="detail-agent-meta"><span>{entry.message.number}</span><span>{entry.message.who}</span><span>{entry.message.when}</span></div>
                  <Markdown text={entry.message.body} />
                  {entry.asks.filter(ask => !ask.text && ask.now).map(ask => <span key={ask.ordinal} className="tag tag-accent detail-waiting-tag">Waiting on you</span>)}</>}
            </div><CopyMessage text={entry.message.body} />
          </div>
          {entry.asks.filter(ask => ask.text || entry.you && ask.now).map(ask => <div className="detail-msg" key={ask.ordinal}>
            <div className="detail-bubble detail-bubble-agent">{ask.text && <Markdown text={ask.text} />}
              {ask.now && <span className="tag tag-accent detail-waiting-tag">Waiting on you</span>}</div>
            {ask.text && <CopyMessage text={ask.text} />}
          </div>)}
          {entry.note && <div className="detail-chat-marker">{entry.note}</div>}
          {entry.unsent && <NotSentLine line={entry.unsent.line} again={entry.unsent.again || sendingAgain(draftState, session, entry.unsent.input)}
            restoreHint={editable(entry.unsent.input.kind) ? putBackBlocked(session, entry.unsent.input) : null}
            onPutBack={putBackBlocked(session, entry.unsent.input) || !editable(entry.unsent.input.kind) ? null : async () => {
              const outcome = await putBackCancelled(drafts, session, entry.unsent!.input);
              if (inEditor(outcome) && outcome.intent !== 'answer' && outcome.intent !== 'topic_reply') openBox(outcome.intent);
              return outcome;
            }} />}
          {entry.pending?.stuck && <StuckNote actions={actions} input={entry.pending.input} stuck={entry.pending.stuck}
            onEdit={async () => {
              const outcome = await editQueued(drafts, session, entry.pending!.input, actions);
              if (inEditor(outcome) && outcome.intent !== 'answer' && outcome.intent !== 'topic_reply') openBox(outcome.intent);
              return outcome;
            }} />}
          {entry.result && <div className="detail-msg detail-msg-result"><span aria-hidden="true">↳</span><Markdown className="detail-msg-text" text={entry.result} inline /><CopyMessage text={entry.result} /></div>}
          {entry.forks.map(fork => <button type="button" className="detail-fork" key={fork.id} onClick={() => onOpenItem(fork.id)}>
            <i className="ph ph-git-fork" aria-hidden="true" /><span>Branched into {fork.question}</span><StatusBadge status={fork.status} variant="text" /></button>)}
        </li>)}
      </ol>
    </section>}
    </div>

    {docked && <div className="detail-dock">
    {ackTo && <section className="detail-section detail-ack" aria-label="Acknowledge item">
      <button type="button" className="btn btn-secondary detail-action" title={ackTitle(ackTo, item.status)} aria-label={ackTitle(ackTo, item.status)}
        disabled={ack.busy} onClick={() => { void ack.run(item.id); }}>
        <i className="ph ph-check" aria-hidden="true" />Ack<span className="detail-key" aria-hidden="true">a</span>
      </button><span className="detail-hint">{ackTitle(ackTo, item.status)}</span>
    </section>}
    {ack.error && <p className="detail-error" role="alert">{ack.error}</p>}
    {submit.error && !(showAnswer && submit.error === answerSlotError(draftState, retained)
      || savedAnswers.some(entry => entry.error && submit.error === plainFailure(entry.error)))
      && <p className="detail-error" role="alert">{submit.error}</p>}
    {model.open && <section className="detail-section detail-open" aria-label={model.open.title}>
      {sectionLabel(model.open.title)}
      <div className="detail-actions" role="group" aria-label="Item actions">
        {model.open.actions.map(action => <button type="button" key={action.action} className={`btn ${action.primary ? 'btn-primary' : 'btn-secondary'} detail-action`}
          aria-pressed={action.primary ? undefined : action.pressed} disabled={action.disabled || (!draftState.ready && action.action !== 'later') || (!submit.ready && action.action === 'bring') || (action.action === 'reopen' && submit.locked('reopen'))} title={action.title}
          onClick={() => act(action.action)}>
          <i className={action.icon} aria-hidden="true" />{action.label}<span className="detail-key" aria-hidden="true">{action.key}</span>
        </button>)}
      </div>
      <div className="detail-hint">{model.open.hint}</div>
      {!owner && <PausedNote actions={actions} />}
      {laterError && <p className="detail-error" role="alert">Later was not saved. Keep the current view and try again.</p>}
    </section>}

    {model.followUp && <section className="detail-section detail-open" aria-label="Reply">
      <div className="detail-actions" role="group" aria-label="Item actions">
        <button type="button" className="btn btn-secondary detail-action" aria-pressed={mode === 'reply'} disabled={model.followUp.disabled || !draftState.ready}
          title="Reply in your own words" onClick={() => openBox('reply')}>
          <i className="ph ph-chat-text" aria-hidden="true" />{model.followUp.label}<span className="detail-key" aria-hidden="true">r</span>
        </button>
      </div>
      <div className="detail-hint">{model.followUp.hint}</div>
    </section>}

    {/* The one place the owner's boxes live: the same mount for every status, so typing and focus survive a status change. */}
    {owner && <section className="detail-section detail-open" aria-label="Your message">
      {owner}
    </section>}

    {showAnswer && <section className="detail-section detail-answer" aria-label="Your answer">
      {model.answer?.heading && <div className="detail-label detail-label-accent">Your answer</div>}
      {model.answer && <PausedNote actions={actions} />}
      {/* While the follow-up box is open, it is the detail's one data-owner-input. */}
      <AnswerSlot drafts={drafts} store={store} itemId={itemId} blocked={model.answer?.blocked} focusRequest={answerFocus}
        marked={!owner}
        onFocusRequestConsumed={onFocusRequestConsumed} onEscape={() => focusRoot(itemId)} onAgentNotRunning={onAgentNotRunning} onSent={sentJustNow} />
    </section>}
    {savedAnswers.length > 0 && <section className="detail-section detail-open detail-saved-message" aria-label="Saved message">
      {sectionLabel('Saved message')}
      <p className="detail-hint">{!currentQuestionOpen && "The agent isn't waiting for this answer any more. "}Your draft is kept. Copy it into a reply if you still want to send it.</p>
      {savedAnswers.map(entry => <div className="detail-box" key={entry.draft.op_id}>
        {entry.draft.selected_option_id && <p className="detail-hint">{item.options.find(option => option.id === entry.draft.selected_option_id)?.label
          ? `You chose “${item.options.find(option => option.id === entry.draft.selected_option_id)!.label}”`
          : 'Your saved choice is no longer listed.'}</p>}
        {entry.draft.text && <><textarea className="input" aria-label="Saved answer text" readOnly value={entry.draft.text} rows={3} />
          <CopyMessage text={entry.draft.text} /></>}
        <button type="button" className="btn btn-secondary" disabled={entry.saving || draftState.preferenceUncertain}
          onClick={() => { void drafts.discard(entry.draft.op_id); }}>Discard</button>
        {entry.error && <p className="detail-error" role="alert">{plainFailure(entry.error)}</p>}
      </div>)}
      {draftState.preferenceUncertain && <button type="button" className="btn btn-secondary" onClick={() => { void drafts.retryPreferences(); }}>Try saving your draft again</button>}
    </section>}
    </div>}
  </article></FileRefProject.Provider></ItemRefs.Provider>;
}
