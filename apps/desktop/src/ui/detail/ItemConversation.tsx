import { createPortal } from 'react-dom';
import { Dialog } from '../dialogs/Dialog';
import { ItemChanges } from '../changes/ItemChanges';
import { AnswerChanges } from '../changes/AnswerChanges';
import { ChangeMarker } from '../changes/ChangeMarker';
import { useDetailMarker } from '../changes/useDetailMarker';
import { answerInputId, latestChangedAnswer } from '../changes/model';
import { isChangedSinceRead, type SeenState } from '../../selectors/changes/seen';
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
import type { Immutable } from '../../data';
import type { Session } from '../../generated/domain/models';
import { useOwnerDrafts, type DraftEntry, type OwnerDraftStore } from '../../state/drafts/store';
import { sessionActionsFor, useSessionActions } from '../../components/bindings/actions';
import { PausedNote } from '../../components/bindings/DispatchChip';
import { useSupervisorHealth } from '../../components/bindings/health';
import type { OwnerFocusRequest, PendingSubmission } from '../answer/useSubmit';
import { ackHoldFor, ackTarget, ackTitle, useAckHeld } from '../shared/ack';
import { STATUS } from '../shared/status';
import { Chat } from './Chat';
import { Composer } from './Composer';
import { AnswerSlot, answerSlotError, changedText } from './AnswerSlot';
import { FileRefProject, fileLinkProps, ItemReference, ItemRefs, LinkOpener, Markdown, useProjectFile } from '../shared/MarkdownText';
import { fileLinkTitle, fileReference, safeHref } from '../shared/markdown';
import { copyText } from '../shared/clipboard';
import { notices } from '../pages/notices';
import { displayStatus } from '../../selectors/waiting/replied';
import { waitingOnOwner } from '../../selectors/waiting/rows';
import { closedSessionQuestion, sessionAnswerBlocked } from '../../selectors/sessionClosed';
import { SessionClosedChip } from '../shared/SessionClosedChip';
import { CopyMessage } from './CopyMessage';
import { StatusBadge } from '../shared/StatusBadge';
import { hiddenSource } from '../tree/hidden';
import { useHidden } from '../remove/queue';
import { actionText, closedStatus, detailModel, type ActionKey, type Kid, type LinkView, type OpenMode } from './model';
import { useDetailSubmit, type DraftTarget, type Words } from './submit';
import './detail.css';
import { ItemRefSession, usePeek } from '../peek/context';
import { peekNames } from '../peek/names';
import { navigationVisits } from '../navigation/visits';
import { useClipped } from './useClipped';
import { useDockBudget } from './useDockBudget';
import { ActionsRow } from './ActionsRow';
import { useItemActions, type ItemActionsProps } from './itemActions';

/** Opening scrolls so the "New since you last looked" divider sits this far below the top of the body (SPEC 5.3 item 7). */
const NEW_DIVIDER_ABOVE = 140;

/** The pane is scrolled to (nearly) its end. */
const nearEnd = (pane: HTMLElement) => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;

const resizeTargets = (pane: HTMLElement) => new Set<Element>([pane, ...pane.children, ...pane.querySelectorAll('.detail-turn-now .detail-bubble-agent')]);

/**
 * Keep the current ask readable above the options, with the pane's one-click full-text pattern. The expand control shows only
 * while the text is clipped (or its dialog is open), and the dialog follows the text if the agent edits the question.
 */
function ConversationQuestion({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const clipped = useClipped(node, text);
  const id = useId();
  return <><div className="conversation-question">
    <div id={id} ref={setNode} className="conversation-question-text"><Markdown text={text} inline compact /></div>
    {(clipped || expanded) && <button type="button" className="btn btn-ghost btn-icon conversation-question-toggle" aria-label="Expand question"
      aria-expanded={expanded} aria-controls={expanded ? `${id}-full` : id} aria-haspopup="dialog" onClick={() => setExpanded(true)}>
      <i className="ph ph-caret-down" aria-hidden="true" />
    </button>}
  </div>
    {expanded && createPortal(<div onKeyDown={event => event.stopPropagation()}><Dialog label="Current question" width={640} onCancel={() => setExpanded(false)}>
      <h2 className="dialog-title">Current question</h2>
      <div id={`${id}-full`} className="dialog-body"><Markdown text={text} /></div>
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setExpanded(false)}>Close question</button></div>
    </Dialog></div>, document.body)}
  </>;
}

/** Return focus to the item's row so workspace keys work again. */
function focusRoot(itemId: string) {
  const conversation = document.querySelector<HTMLElement>('[data-conversation-anchor]');
  if (conversation) { conversation.focus({ preventScroll: true }); return; }
  const row = [...document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`)].find(element => !element.closest('.shell-detail'));
  if (row) row.focus();
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export interface ItemDetailProps extends ItemActionsProps {
  readonly expanded?: boolean;
  readonly onOpenConversation?: () => void;
  readonly dividerId?: string | null;
  /** When the owner last looked, for the divider's "New since you last looked at 20:40". */
  readonly dividerAt?: number | null;
  readonly drafts: OwnerDraftStore;
  readonly store: SessionStore;
  readonly itemId: string;
  readonly later: boolean;
  readonly onLater?: (value: boolean) => Promise<boolean>;
  readonly onBring?: () => void;
  readonly onOpenItem: (itemId: string) => void;
  readonly focusRequest?: OwnerFocusRequest;
  readonly onFocusRequestConsumed?: (token: number) => void;
  /** A send while the agent isn't running opens the "Agent isn't running" dialog (1ad). */
  readonly onAgentNotRunning?: (submission: PendingSubmission) => void;
  /** Set for an earlier session's item: its message numbers read "codex #19" (shared/excerpt earlierAgent). */
  readonly earlierAgent?: string | null;
  /** Where a copied item came from (its Source item button): shown with the item's references, not under the composer. */
  readonly provenance?: ReactNode;
  readonly hiddenItemIds?: readonly string[];
  readonly seen?: SeenState;
  readonly answerJump?: { readonly messageId: string; readonly token: number };
  readonly onAnswerJumpConsumed?: (token: number) => void;
  readonly onOpenAnswer?: (itemId: string, messageId: string) => void;
  /** Saves "seen" for this item at the revision shown (the change box's Mark seen). Without it the box has no button. */
  readonly onMarkSeen?: (itemId: string, revision: number) => void;
}

const sectionLabel = (text: string) => <div className="detail-label">{text}</div>;

/** One answer eligibility rule for the pane, conversation and shell footer. */
export function conversationAnswerState(session: Immutable<Session>, itemId: string, retained?: Pick<DraftEntry, 'uncertain' | 'error'>): { readonly showAnswer: boolean; readonly live: boolean } {
  const item = session.items[itemId];
  if (!item) return { showAnswer: false, live: false };
  const round = item.current_round_id ? session.rounds[item.current_round_id] : null;
  const currentQuestionOpen = item.status === 'waiting_on_me' && !!round && round.closed_at === null
    && round.question_revision === item.question_revision;
  const archived = session.archived_at != null || session.topics[item.topic_id]?.archived_at != null;
  const model = detailModel({ session, itemId, mode: null, saving: null, later: false, now: Date.now() });
  const showAnswer = !archived && (closedSessionQuestion(session, item) || currentQuestionOpen && !!(model?.answer || retained?.uncertain || retained?.error));
  return { showAnswer, live: showAnswer && !!model?.answer && waitingOnOwner(session, item) };
}

function KidButton({ kid }: { readonly kid: Kid }) {
  const peek = useContext(ItemRefs), scope = useContext(ItemRefSession);
  const navigation = usePeek();
  const name = scope ? navigation?.reference({ ...scope, item_id: kid.id })?.name : undefined;
  return <ItemReference itemId={kid.id} className={`detail-kid${kid.closed ? ' detail-kid-closed' : ''}`} ariaLabel={kid.question} preserveContent>
    <span className="detail-kid-icon"><StatusBadge status={kid.status} variant="icon" size={15} /></span><span className="detail-kid-text">{name ?? peek?.lookup(kid.id)?.name ?? kid.question}</span>
  </ItemReference>;
}

/** A short child list scrolls independently; its fade disappears once the last row is visible. */
function ChildrenBox({ kids }: { readonly kids: readonly Kid[] }) {
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
    }}>{kids.map(kid => <KidButton key={kid.id} kid={kid} />)}</div>
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

export function ItemConversation({ drafts, store, itemId, later, onLater, onBring, onOpenItem, focusRequest, onFocusRequestConsumed, onAgentNotRunning, earlierAgent = null, provenance, hiddenItemIds, seen, answerJump, onAnswerJumpConsumed, onOpenAnswer, expanded = false, onOpenConversation, dividerId, dividerAt, onHide, onRemove, onActions, onMarkSeen }: ItemDetailProps) {
  const current = useSession(store), session = current.snapshot?.session;
  const pendingRemoval = useHidden();
  const item = session?.items[itemId];
  const submit = useDetailSubmit(drafts, store, itemId);
  const draftState = useOwnerDrafts(drafts, session);
  // A failed answer stays reachable after the question closes, outside the answer control.
  const retained = session && draftState.ready ? drafts.find({ project_id: session.project_id, session_id: session.id }, itemId, 'answer') : undefined;
  const [mode, setMode] = useState<OpenMode | null>(null);
  const [focusBox, setFocusBox] = useState(0);
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [laterError, setLaterError] = useState(false);
  // Keep typed drop words in the same per-item draft store when either surface unmounts.
  const dropDraft = drafts.find(current.route, itemId, 'drop');
  const dropText = dropDraft && !dropDraft.receipt ? dropDraft.draft.text : '';
  // Drop drafts always hold the complete message to send. Decode only our current
  // question's envelope for the reason field; an older envelope stays an editable message.
  const suffix = `: ${item?.question ?? ''}`, prefix = 'Let’s drop this';
  const envelope = dropText.startsWith(prefix) && dropText.endsWith(suffix)
    ? dropText.slice(prefix.length, -suffix.length) : null;
  const reason = !dropText ? '' : envelope === '' ? '' : envelope?.startsWith(' (') && envelope.endsWith(')') ? envelope.slice(2, -1) : null;
  const setReason = (text: string) => submit.edit('drop', `${prefix}${text ? ` (${text})` : ''}${suffix}`);
  // The boxes' textareas by key, and the key of the one typed in last: `r` goes to that draft (else the newest).
  const boxes = useRef(new Map<string, HTMLTextAreaElement>()), edited = useRef<string | null>(null), dropBox = useRef<HTMLInputElement>(null);
  const handled = useRef<number | null>(null);
  // The scrolling body, and whether the owner is reading its end (the latest message) or has scrolled up.
  const body = useRef<HTMLDivElement>(null), atEnd = useRef(true), justSent = useRef(false);
  // Following an ask is distinct from following the transcript's end: later context can follow the ask.
  const followingAsk = useRef(false), positionedScroll = useRef<number | null>(null);
  const resizeWatch = useRef<{ observer: ResizeObserver; targets: Set<Element> } | null>(null);
  const presence = session?.active_binding_id ? current.presence[session.active_binding_id] ?? null : null;
  // The session's write barrier, shared with the session bar: Resume, Cancel and Retry go through it.
  const actions = useMemo(() => sessionActionsFor(drafts.service, store), [drafts, store]);
  // Ack starts a 6 s hold in the session's hold store, which saves it or drops it on Undo; Details shows the Undo here.
  const ackHold = useMemo(() => ackHoldFor(current.route.session_id, actions), [current.route.session_id, actions]);
  const ackHeld = useAckHeld(current.route.session_id).has(itemId);
  // Details draws the Undo for this item while it is open; closing it hands the Undo to a notice.
  useEffect(() => ackHold.showing([itemId]), [ackHold, itemId]);
  const noticeKey = JSON.stringify([current.route.project_id, current.route.session_id, itemId]);
  const copyAttempt = useRef(0), copyMounted = useRef(true);
  useEffect(() => {
    copyMounted.current = true;
    return () => { copyMounted.current = false; ++copyAttempt.current; };
  }, [noticeKey]);
  const ackNoticeId = JSON.stringify(['item-ack', current.route.project_id, current.route.session_id, itemId]);
  const actionState = useSessionActions(actions);
  useEffect(() => () => notices.dismiss(ackNoticeId), [ackNoticeId]);
  const laterNoticeId = `detail-later:${noticeKey}`;
  useEffect(() => () => notices.dismiss(laterNoticeId), [laterNoticeId]);
  useEffect(() => {
    if (!laterError) { notices.dismiss(laterNoticeId); return; }
    notices.push({ id: laterNoticeId, icon: 'ph ph-warning-circle', tone: 'problem', text: 'Later was not saved. Keep the current view and try again.' });
  }, [laterNoticeId, laterError]);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : undefined;
  const health = useSupervisorHealth(drafts.service, binding?.id, binding?.generation);
  const model = session ? detailModel({ session, itemId, now: Date.now(), mode, later, saving: submit.saving, presence, health, earlierAgent,
    replyDraft: mode === 'reply' || submit.written.length > 0, hiddenItemIds }) : null;
  const round = item?.current_round_id ? session?.rounds[item.current_round_id] : null;
  const currentQuestionOpen = item?.status === 'waiting_on_me' && !!round && round.closed_at === null
    && round.question_revision === item.question_revision;
  const answerState = session ? conversationAnswerState(session, itemId, retained) : { showAnswer: false, live: false };
  const showAnswer = answerState.showAnswer;
  // The bigger view's pinned question owns its dock while it can be answered: r goes to it and no reply box shows there.
  // A sealed, handled answer leaves room for the reply box below it.
  const answerOnly = expanded && showAnswer && !model?.followUp?.answered;
  const dock = useRef<HTMLDivElement>(null);
  useDockBudget(dock, expanded && showAnswer);
  const savedAnswers = !showAnswer && session ? drafts.savedAnswers({ project_id: session.project_id, session_id: session.id }, itemId) : [];
  const ackTo = session && item ? ackTarget(session, item) : null;
  // An open item is replied to and an in-progress item gets notes: that box is always there, never behind a button. Other
  // boxes (drop reason, follow-up on a finished item) open on press.
  // Words are bound to the draft they were typed in: the box edits that draft in place whatever the item's status does, and
  // the label says what the words go out as now (`fit`). Every draft that holds words shows, so none is ever hidden.
  const fit = model?.box ?? null;
  // Sending temporarily removes Drop from the actions. Keep an explicitly opened
  // editor through that attempt; acceptance closes it, while a failure leaves it editable.
  const dropAttempt = !!dropDraft && !dropDraft.receipt && (dropDraft.saving || dropDraft.uncertain);
  const modeFits = (value: OpenMode) => !!model && ((value === 'reply' && !!model.followUp)
    || !!model.open?.actions.some(action => action.action === value)
    || value === 'drop' && dropAttempt && model.status === 'open' && model.box === 'reply');
  const shownMode = mode && modeFits(mode) ? mode : null;
  const standingEmpty = !!model && !!fit && (expanded && !showAnswer || !!model.open && (model.status === 'open' || model.status === 'progress'));
  const dropOpen = shownMode === 'drop' || dropAttempt;
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

  const openingChangePositioned = useRef(false);
  // Open at the current ask, even after a long earlier conversation. Once answered, open at the end.
  // The sticky title stays above the ask; arrivals leave a reader where they are.
  const showLatest = () => {
    const pane = body.current;
    if (!pane) return;
    // Opening: the view scrolls once to 140px above the "New since you last looked" divider (SPEC 5.3 item 7). The divider is
    // fixed for this selection (W2 computes it before the dwell), so later arrivals leave a reader where they are.
    const divider = !openingChangePositioned.current && !justSent.current ? pane.querySelector<HTMLElement>('[data-testid="new-divider"], .conversation-unseen') : null;
    if (divider) {
      openingChangePositioned.current = true;
      pane.scrollTop = Math.max(0, pane.scrollTop + divider.getBoundingClientRect().top - pane.getBoundingClientRect().top - NEW_DIVIDER_ABOVE);
      positionedScroll.current = pane.scrollTop;
      followingAsk.current = false; atEnd.current = nearEnd(pane);
      return;
    }
    if (expanded) {
      if (justSent.current || openingChangePositioned.current && atEnd.current) pane.scrollTop = pane.scrollHeight;
      else if (!openingChangePositioned.current) pane.scrollTop = 0;
      openingChangePositioned.current = true;
      atEnd.current = nearEnd(pane); followingAsk.current = false; return;
    }
    if (!openingChangePositioned.current) {
      openingChangePositioned.current = true;
      if (item && isChangedSinceRead(item, seen)) {
        pane.scrollTop = 0; positionedScroll.current = 0;
        followingAsk.current = false; atEnd.current = false;
        return;
      }
    }
    const waiting = pane.querySelector('.detail-turn-now');
    const tag = waiting?.querySelector('.detail-waiting-tag');
    const anchor = tag?.closest('.detail-bubble-agent') ?? waiting;
    followingAsk.current = !!anchor;
    if (anchor) {
      const bounds = pane.getBoundingClientRect();
      const top = anchor.getBoundingClientRect().top - bounds.top;
      // A long ask can exceed the available height. Keep its waiting marker visible and leave all its words scrollable.
      const marker = tag?.getBoundingClientRect();
      const bottom = marker && pane.clientHeight > 0 ? marker.top + marker.height - bounds.top - pane.clientHeight : top;
      pane.scrollTop += Math.max(top, bottom);
    } else if (pane.querySelector('.detail-chat [data-owner-said="true"], .detail-chat .detail-msg-result')) pane.scrollTop = pane.scrollHeight;
    else {
      const chat = pane.querySelector('.detail-chat');
      if (chat) pane.scrollTop += chat.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    }
    positionedScroll.current = pane.scrollTop;
    atEnd.current = nearEnd(pane);
  };
  useEffect(() => { atEnd.current = true; followingAsk.current = false; positionedScroll.current = null; openingChangePositioned.current = false; setTitleExpanded(false); }, [itemId]);
  const sentJustNow = () => { navigationVisits.record(current.route, itemId, 'answered'); justSent.current = true; showLatest(); };
  const chatKey = model ? model.chat.map(entry => `${entry.id}:${entry.message.body}:${entry.result}:${entry.pending?.input.state}:${entry.asks.map(ask => `${ask.text}:${ask.now}`).join(',')}:${entry.forks.length}`).join('|') : null;
  useEffect(() => {
    if (chatKey === null) return;
    if (atEnd.current || justSent.current) showLatest();
    justSent.current = false;
  }, [chatKey, itemId]);
  // Composer growth and late text/font reflow can move the ask without changing the body's own size.
  // Keep the observer across draft renders: observing again emits an initial notification even when nothing resized.
  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const targets = resizeTargets(element);
    const measure = () => new Map([...targets].map(target => {
      const { width, height } = target.getBoundingClientRect();
      return [target, `${width ?? 0}:${height ?? 0}`] as const;
    }));
    let sizes = measure(), viewport = `${element.clientWidth}:${element.clientHeight}:${element.scrollHeight}`;
    const watch = new ResizeObserver(() => {
      const next = measure(), nextViewport = `${element.clientWidth}:${element.clientHeight}:${element.scrollHeight}`;
      const changed = viewport !== nextViewport || [...new Set([...sizes.keys(), ...next.keys()])]
        .some(target => (sizes.get(target) ?? '0:0') !== (next.get(target) ?? '0:0'));
      sizes = next; viewport = nextViewport;
      if (!changed) return;
      if (followingAsk.current && element.querySelector('.detail-turn-now')) showLatest();
      else if (atEnd.current) {
        element.scrollTop = element.scrollHeight;
        positionedScroll.current = element.scrollTop;
      }
    });
    for (const target of targets) watch.observe(target);
    resizeWatch.current = { observer: watch, targets };
    return () => { watch.disconnect(); resizeWatch.current = null; };
  }, [noticeKey, chatKey === null]);
  // A section above the conversation can change height while the chat only changes position.
  // Refresh the targets after renders without resetting the previous measurements.
  useEffect(() => {
    const element = body.current, watch = resizeWatch.current;
    if (!element || !watch) return;
    const next = resizeTargets(element);
    for (const target of watch.targets) if (!next.has(target)) { watch.observer.unobserve(target); watch.targets.delete(target); }
    for (const target of next) if (!watch.targets.has(target)) { watch.targets.add(target); watch.observer.observe(target); }
  });

  useEffect(() => {
    if (!answerJump || !body.current) return;
    const target = body.current.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(answerJump.messageId)}"]`);
    if (!target) return;
    followingAsk.current = false; atEnd.current = false;
    const pane = body.current;
    pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    onAnswerJumpConsumed?.(answerJump.token);
  }, [answerJump?.token, answerJump?.messageId, chatKey, onAnswerJumpConsumed]);

  // Words open in the box that fits the status, whichever box the action or a put-back names.
  const openBox = (next: OpenMode) => { setMode(next === 'drop' || !fit ? next : fit); setFocusBox(value => value + 1); };
  const closeBox = () => { setMode(null); focusRoot(itemId); };
  const send = async (target: DraftTarget, text: string, as?: 'reply' | 'note' | 'followup') => {
    const sent = await submit.send(target, text, as);
    if (sent) { setMode(null); sentJustNow(); }
    return sent;
  };
  const sendWords = (slot: Words) => { if (fit && slot.text.trim()) void send(slot, slot.text, fit); };
  const sendDrop = () => { if (model) void send('drop', reason === null ? dropText : actionText('drop', model.question, reason)); };
  const toggleLater = async () => { try { setLaterError(!await onLater?.(!later)); } catch { setLaterError(true); } };
  const act = (action: ActionKey) => {
    if (!model) return;
    if (action === 'bring') onBring?.();
    else if (action === 'later') void toggleLater();
    else if (action === 'reopen') void send('reopen', actionText('reopen', model.question));
    else openBox(action);
  };

  const copy = () => {
    if (!item) return;
    const attempt = ++copyAttempt.current;
    const currentCopy = () => copyMounted.current && attempt === copyAttempt.current;
    void copyText(`${item.id} — ${item.question}`).then(() => {
      if (currentCopy()) notices.push({ id: `detail-copy:${noticeKey}`, icon: 'ph ph-check', text: 'Item copied.' });
    }, () => {
      if (currentCopy()) notices.push({ id: `detail-copy:${noticeKey}`, icon: 'ph ph-warning-circle', tone: 'problem', text: 'Copy failed. Try again.' });
    });
  };
  // One list of actions feeds the actions row here and the head's "…" menu (W2 renders it from `onActions`). Each action goes
  // through the same path as before: a box opens, Bring it up and Back to Open send, Later toggles. What holds one back comes
  // from the model, so the readiness rules stay where they were.
  const openByKey = new Map((model?.open?.actions ?? []).map(action => [action.action, action] as const));
  const boxAction = (['reply', 'note', 'followup'] as const).find(key => openByKey.has(key)) ?? null;
  const holdFor = (key: ActionKey | null, ownReason: string | null = null): string | undefined => {
    if (!model) return undefined;
    const offered = key ? openByKey.get(key) : null;
    if (key && !offered) return 'A message is on its way';
    if (offered?.disabled) return 'Reconnecting to the agent';
    if (key !== 'later' && !draftState.ready) return 'Your drafts are still loading';
    return ownReason ?? undefined;
  };
  const held = {
    ...(model?.followUp ? { followUp: model.followUp.disabled ? 'Reconnecting to the agent' : !draftState.ready ? 'Your drafts are still loading' : undefined }
      : boxAction ? { followUp: holdFor(boxAction) } : {}),
    bring: holdFor('bring', !submit.ready ? 'Sending is not ready yet' : null),
    reopen: holdFor('reopen', submit.locked('reopen') ? 'Your request is on its way' : null),
    drop: holdFor('drop'),
  };
  const heldActions = Object.fromEntries(Object.entries(held).filter(([, reason]) => !!reason)) as Partial<Record<'followUp' | 'bring' | 'reopen' | 'drop', string>>;
  // Hidden by itself or by an ancestor: the "…" menu offers Unhide for both, as the Map's hover bar does.
  const hiddenHere = !!session && hiddenSource(session, new Set(hiddenItemIds ?? []), itemId) !== null;
  const actionList = useItemActions({ session, item, hidden: hiddenHere, later, held: heldActions,
    replyApplies: model ? !!model.followUp || (model.status !== 'waiting' && !!boxAction) : false, replyLabel: model?.followUp?.label,
    on: { followUp: () => { const box = model?.followUp ? 'reply' : boxAction; if (box) act(box); }, bring: () => act('bring'), later: () => act('later'),
      reopen: () => act('reopen'), drop: () => act('drop'), copyRef: copy, hide: onHide, unhide: onHide, remove: onRemove } });
  const emitActions = useRef(onActions);
  emitActions.current = onActions;
  useEffect(() => { emitActions.current?.(actionList); }, [actionList]);
  useEffect(() => () => emitActions.current?.(null), []);
  const marker = useDetailMarker(item, seen);
  // The Because card shows once, under the newest answer that changed something (SPEC 5.3 item 8).
  const becauseAt = useMemo(() => session && model ? latestChangedAnswer(session, model.chat) : null, [session, chatKey]);
  const becauseInput = session && becauseAt ? answerInputId(session, becauseAt) : null;

  useEffect(() => {
    if (!focusBox) return;
    if (dropOpen) { dropBox.current?.focus(); return; }
    const keys = slots.map(slotKey), key = edited.current !== null && keys.includes(edited.current) ? edited.current : keys.at(-1);
    if (key !== undefined) boxes.current.get(key)?.focus();
  }, [focusBox]);
  // Keyboard actions arrive from the workspace keymap as focus requests.
  useEffect(() => {
    if (!focusRequest || handled.current === focusRequest.token || !model || !item) return;
    const { intent, token } = focusRequest;
    if (intent === 'answer' || (model.status === 'waiting' && intent === 'reply' && (!model.followUp || answerOnly))) return;
    handled.current = token;
    onFocusRequestConsumed?.(token);
    if (model.followUp) { if (intent === 'reply' && !model.followUp.disabled) openBox('reply'); return; }
    if (!model.open) return;
    const available = new Set(model.open.actions.filter(action => !action.disabled).map(action => action.action));
    if ((intent === 'reply' || intent === 'note' || intent === 'followup' || intent === 'drop') && available.has(intent)) openBox(intent);
    else if (intent === 'reopen' && available.has('reopen')) void send('reopen', actionText('reopen', model.question));
  });

  if (!session || !item || !model) return <p role="status">The current item is unavailable. Open its session again.</p>;
  // A reopen that could not go out was written against an older item (OwnerInput's Review step). Only the Open section offers it.
  const reopenStale = !!model.open && submit.changed('reopen');
  const answerFocus = focusRequest && model.status === 'waiting' && (!model.followUp || answerOnly) && focusRequest.intent === 'reply' ? { ...focusRequest, intent: 'answer' as const } : focusRequest;
  // The owner's boxes, docked in one place whatever section the item's status shows above them, so a box keeps its mount (and
  // the owner's focus and caret) when the status changes. data-owner-input marks them with their changed-target warnings, like the
  // answer slot (native tests).
  // A box that holds words has nothing to cancel: its text is kept either way, and Esc only leaves it. Offline, its send waits for the connection.
  const sendHeld = !!fit && !!model.open?.actions.find(value => value.action === fit)?.disabled;
  const closable = submit.written.length === 0 && !standingEmpty;
  // The Send button and the keys follow one rule: nothing goes out while this says no.
  // An item (or one above it, or its topic) in a pending removal's window sends nothing until Undo (alpha.21 E28).
  const removing = !!session && pendingRemoval.item({ project_id: session.project_id, session_id: session.id }, session, itemId);
  const sendOff = (slot: Words) => removing || !submit.ready || submit.saving !== null || slot.changed || sendHeld || !slot.text.trim();
  const wordsKey = (slot: Words) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeBox(); return; }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.stopPropagation(); event.preventDefault(); if (!sendOff(slot)) sendWords(slot); }
  };
  const dropKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeBox(); return; }
    if (event.key === 'Enter' && (!(event.currentTarget instanceof HTMLTextAreaElement) || event.metaKey || event.ctrlKey)) {
      event.stopPropagation(); event.preventDefault(); if (!dropOff) sendDrop();
    }
  };
  const dropOff = !submit.ready || submit.saving !== null || submit.locked('drop') || submit.changed('drop');
  const owner = !answerOnly && (slots.length > 0 || dropOpen || reopenStale);
  const composer = owner && <Composer kind={model.status === 'waiting' ? 'waiting' : 'plain'} expanded={expanded} removing={removing} sending={submit.saving !== null} ownerKey={itemId} actions={actions} sentAs={fit} slots={slots} slotKey={slotKey}
    sendOff={sendOff} closable={closable} register={(key, element) => { if (element) boxes.current.set(key, element); else boxes.current.delete(key); }}
    onEdit={(slot, value) => { edited.current = slotKey(slot); submit.edit(slot, value); }} onKeyDown={wordsKey} onSend={sendWords} onCancel={closeBox}
    onReview={slot => submit.review(slot)}
    before={reopenStale && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{changedText}</span>
      <button type="button" className="btn btn-secondary answer-warn-action" disabled={submit.locked('reopen')} onClick={() => submit.review('reopen')}>Review this question</button></div>}>
    {dropOpen && <div className="detail-box">
      {submit.changed('drop') && <div className="answer-warn" role="alert"><span>{changedText}</span>
        <button type="button" className="btn btn-secondary" onClick={() => submit.review('drop')}>Review this question</button></div>}
      {(dropDraft?.uncertain || reason === null) ? <>
        <textarea className="input" aria-label="Saved drop message" value={dropText} readOnly={dropDraft?.uncertain} disabled={!dropDraft?.uncertain && submit.locked('drop')} rows={2}
          onChange={event => submit.edit('drop', event.target.value)} onKeyDown={dropKey} />
        {dropDraft?.uncertain ? <>
        <p role="status">This message needs a retry. Your text is kept.</p>
        <button type="button" className="btn btn-secondary" disabled={dropDraft.saving || draftState.preferenceUncertain || !submit.ready}
          onClick={() => { void drafts.submit(dropDraft.draft.op_id); }}>Try sending again</button>
        {dropDraft.rejected && <button type="button" className="btn btn-secondary" disabled={dropDraft.saving || draftState.preferenceUncertain}
          onClick={() => { setMode('drop'); drafts.prepareRevised(dropDraft.draft.op_id, session); }}>Edit and send again</button>}
        </> : <><button type="button" className="btn btn-secondary" disabled={dropOff} onClick={sendDrop}>Drop item</button>
          <button type="button" className="btn btn-ghost detail-cancel" onClick={closeBox}>Cancel</button></>}
      </> : <><input ref={dropBox} className="input" aria-label="Drop reason" placeholder="Reason (optional), e.g. the metric already covers it" value={reason}
        disabled={submit.locked('drop')} onChange={event => setReason(event.target.value)} onKeyDown={dropKey} />
      <div className="detail-box-row">
        <button type="button" className="btn btn-secondary" disabled={dropOff} onClick={sendDrop}>
          <i className="ph ph-x-circle" aria-hidden="true" />Drop item</button>
        <button type="button" className="btn btn-ghost detail-cancel" onClick={closeBox}>Cancel</button>
        <span className="detail-box-hint">Enter drops · the agent confirms</span>
      </div></>}
    </div>}
  </Composer>;
  const docked = !!(showAnswer || savedAnswers.length > 0 || owner || submit.error || (expanded && model.delivery));
  const disabledActions = model.open?.actions.some(action => action.disabled);
  const dockHint = current.status !== 'ready' || current.error || disabledActions ? model.open?.hint
    : model.chat.some(entry => entry.pending) ? model.delivery?.text : null;
  const relatedLabels = peekNames(session);
  // The change box sits under the "why"; with no box, the bare history closes the body, after the conversation (SPEC 5.3, 9.11).
  const changes = (part: 'box' | 'history') => <ItemChanges service={drafts.service} store={store} session={session} item={item} seen={seen}
    onOpenAnswer={onOpenAnswer ?? ((id) => onOpenItem(id))} onMarkSeen={onMarkSeen} part={part} />;
  return <ItemRefSession.Provider value={{ project_id: session.project_id, session_id: session.id }}><ItemRefs.Provider value={{ lookup: id => {
    const target = session.items[id];
    return target && !itemRemoved(session, target.id) ? { label: target.question, status: displayStatus(session, target) } : null;
  }, route: id => ({ project_id: session.project_id, session_id: session.id, item_id: id }), onOpenItem }}><FileRefProject.Provider value={session.project_id}><article className={`item-detail${expanded ? ' item-conversation' : ''}`} data-detail-item-id={itemId} data-item-revision={item.revision} data-status={model.status} aria-label={`Detail of ${item.question}`}>
    <div className="detail-body" ref={body} onScroll={event => {
      const pane = event.currentTarget;
      if (pane.scrollTop !== positionedScroll.current) followingAsk.current = false;
      atEnd.current = nearEnd(pane);
    }}>
    <div className={`detail-head${titleExpanded ? ' detail-head-expanded' : ''}`}>
      {/* The badge row (SPEC 5.3 item 1): status, New / Changed / Seen, and who raised it and when. */}
      <div className="detail-status"><div className={`detail-badge${closedSessionQuestion(session, item) ? ' detail-badge-session-closed' : ''}`}><StatusBadge status={model.display} label={model.badgeLabel} />
        {closedSessionQuestion(session, item) && <SessionClosedChip reason={sessionAnswerBlocked(session)} />}</div>
        {marker && <span className="detail-marker-slot"><ChangeMarker kind={marker} seenWhere="details" /></span>}
        <span className="detail-meta" title={model.meta}>{model.meta}</span></div>
      <h2 className="detail-question" title={model.question}><Markdown text={model.question} inline compact={!titleExpanded} /></h2>
      <button type="button" className="btn btn-ghost detail-title-toggle" aria-label={titleExpanded ? 'Collapse title' : 'Expand title'}
        aria-expanded={titleExpanded} onClick={() => setTitleExpanded(value => !value)}>
        <i className="ph ph-caret-down" aria-hidden="true" />
      </button>
    </div>

    {!expanded && model.steps && <section className="detail-section detail-steps" aria-label={model.stepsTitle}>
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
      {/* The label is for a screen reader; the board draws the outcome with an elbow icon in the status colour (SPEC 5.3 item 3). */}
      <div className="detail-label detail-outcome-label" style={{ color: model.outcome.color }}>{model.outcome.label}</div>
      <i className="ph ph-arrow-elbow-down-right detail-outcome-icon" aria-hidden="true" style={{ color: model.outcome.color }} />
      <Markdown className="detail-outcome-text" text={model.outcome.text} />
    </section>}

    {model.note && <div className="detail-note"><i className="ph ph-robot" aria-hidden="true" /><Markdown text={model.note} inline /></div>}

    {model.why && <section className="detail-section detail-why">{sectionLabel('Why')}<Markdown className="detail-why-text" text={model.why} /></section>}

    {changes('box')}

    {/* The actions (SPEC 5.3 item 5): the primary one, then the hover bar's icons. The pinned region below holds only the composer. */}
    <ActionsRow actions={actionList} statusLabel={later ? 'Later' : STATUS[model.status].label} closed={closedStatus.has(model.status)} hint={dockHint ?? model.open?.hint} pressed={mode === 'drop' ? 'drop' : mode ? 'followUp' : null}
      ack={ackTo ? { title: ackTitle(ackTo, item.status), held: ackHeld, disabled: actionState.writing || !!actionState.pending,
        onAck: () => ackHold.ack(item), onUndo: () => ackHold.undo(item.id) } : null} />
    {model.open && dockHint && <div className="detail-hint detail-delivery-hint" title={dockHint}>{dockHint}</div>}
    {model.followUp && !answerOnly && <div className="detail-hint detail-delivery-hint" title={model.followUp.hint}>{model.followUp.hint}</div>}
    {model.open && !owner && <PausedNote actions={actions} />}

    {model.replaced && <section className="detail-section">
      {sectionLabel('Replaced by')}
      <ItemReference itemId={model.replaced.id} className="detail-replaced" title={model.replaced.question} ariaLabel={model.replaced.question} preserveContent>
        <i className="ph ph-arrow-bend-down-right" aria-hidden="true" /><span>{relatedLabels.get(model.replaced.id)}</span><StatusBadge status={model.replaced.status} variant="text" />
      </ItemReference>
    </section>}

    {model.kids.length > 0 && <section className="detail-section detail-kids" aria-label="Child items">
      {sectionLabel(model.kidLabel)}
      <ChildrenBox kids={model.kids} />
    </section>}

    {model.related.length > 0 && <section className="detail-section detail-related" aria-label="Related items">
      <div className="detail-label detail-label-row"><span>Related</span><span className="detail-related-count">{model.related.reduce((count, section) => count + section.items.length, 0)}</span></div>
      {model.related.flatMap(section => section.items.map(target => <ItemReference key={`${section.direction}:${target.id}`} itemId={target.id} className={`detail-related-item${target.hidden ? ' is-hidden' : ''}`} preserveContent
        title={target.question} ariaLabel={`${section.kind}: ${target.question}${target.hidden ? ' (hidden)' : ''} · ${STATUS[target.status].label}`}>
        <span className="detail-related-kind">{section.kind}</span>
        <span className="detail-related-icon"><StatusBadge status={target.status} variant="icon" size={15} /></span>
        <span className="detail-related-label">{relatedLabels.get(target.id)}</span>
        {target.hidden && <span className="detail-related-hidden">hidden</span>}
      </ItemReference>))}
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


    {(model.chat.length > 0 || onOpenConversation) && <Chat entries={model.chat} session={session} itemId={itemId} expanded={expanded} dividerId={dividerId}
      drafts={drafts} draftState={draftState} actions={actions} dividerAt={dividerAt}
      after={entryId => entryId === becauseAt && becauseInput ? <AnswerChanges session={session} inputId={becauseInput} onOpenItem={onOpenItem} /> : null}
      onOpenEditor={target => { if (target !== 'answer' && target !== 'topic_reply') openBox(target); }}
      header={!expanded && <div className="detail-label detail-label-row"><span>Conversation</span>
        {onOpenConversation && <button type="button" className="btn btn-ghost btn-icon" aria-label="Open the conversation in a bigger view"
          title="Open the conversation in a bigger view" onClick={onOpenConversation}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 3h7v7M21 3l-8 8M10 21H3v-7M3 21l8-8" /></svg></button>}
      </div>} />}

    {changes('history')}
    </div>

    {docked && <div ref={dock} className={`detail-dock${expanded && showAnswer ? ' detail-dock-question' : ''}${answerState.live ? ' detail-dock-waiting' : ''}`}>
    {expanded && model.delivery && <div className="detail-delivery" role="status" style={{ color: model.delivery.color }}>
      <i className={model.delivery.icon} aria-hidden="true" /><span>{model.delivery.text}</span></div>}
    {submit.error && !(showAnswer && submit.error === answerSlotError(draftState, retained)
      || savedAnswers.some(entry => entry.error && submit.error === plainFailure(entry.error)))
      && <p className="detail-error" role="alert">{submit.error}</p>}

    {showAnswer && <section className="detail-section detail-answer" aria-label="Your answer">
      {model.answer && !owner && <PausedNote actions={actions} />}
      {/* While the follow-up box is open, it is the detail's one data-owner-input. */}
      {expanded && answerState.live && <div className="conversation-pin"><h3>Your turn · {relatedLabels.get(itemId)}</h3>
        {/* Keyed by the item alone: an edit to the question text keeps an open full-question dialog (and its focus) mounted. */}
        <ConversationQuestion key={itemId} text={item.ask || item.question} /></div>}
      <AnswerSlot drafts={drafts} store={store} itemId={itemId} layout={expanded ? 'wide' : 'details'} head blocked={model.answer?.blocked} focusRequest={answerFocus}
        marked={!owner}
        onFocusRequestConsumed={onFocusRequestConsumed} onEscape={() => focusRoot(itemId)} onAgentNotRunning={onAgentNotRunning} onSent={sentJustNow} />
    </section>}

    {/* The one place the owner's boxes live: the same mount for every status, so typing and focus survive a status change. */}
    {composer}
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
  </article></FileRefProject.Provider></ItemRefs.Provider></ItemRefSession.Provider>;
}
