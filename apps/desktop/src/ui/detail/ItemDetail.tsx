// The item detail panel (handoff README §5 "Item detail"; Ariadne.dc.html
// lines 324-464). The shell's aside holds the header and scroll container;
// DetailPath fills the header's breadcrumb and ItemDetail the scroll body.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { sessionActionsFor } from '../../components/bindings/actions';
import { PausedNote } from '../../components/bindings/DispatchChip';
import { useSupervisorHealth } from '../../components/bindings/health';
import type { OwnerFocusRequest, PendingSubmission } from '../answer/useSubmit';
import { StuckNote } from '../answer/StuckNote';
import { NotSentLine } from '../answer/NotSentLine';
import { editable, editQueued, inEditor, putBackBlocked, putBackCancelled } from '../answer/held';
import { AnswerSlot, changedText } from './AnswerSlot';
import { TimelineExcerpt } from '../shared/MessageExcerpt';
import { Markdown, singleParagraph } from '../shared/MarkdownText';
import { StatusBadge } from '../shared/StatusBadge';
import { actionText, boxText, detailModel, detailPath, type ActionKey, type Kid, type OpenMode } from './model';
import { useDetailSubmit } from './submit';
import './detail.css';

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
}

const sectionLabel = (text: string) => <div className="detail-label">{text}</div>;

/** "You replied: “…”" for a one-paragraph reply; a longer reply keeps its paragraphs and lists below the words. */
function OwnerReply({ text }: { readonly text: string }) {
  if (singleParagraph(text)) return <span>You replied: “<Markdown text={text} inline />”</span>;
  return <div className="detail-round-reply"><span>You replied:</span><Markdown text={text} /></div>;
}

function KidButton({ kid, onOpen }: { readonly kid: Kid; readonly onOpen: (id: string) => void }) {
  return <button type="button" className={`detail-kid${kid.closed ? ' detail-kid-closed' : ''}`} onClick={() => onOpen(kid.id)}>
    <span className="detail-kid-icon"><StatusBadge status={kid.status} variant="icon" size={15} /></span><span className="detail-kid-text">{kid.question}</span>
  </button>;
}

export function ItemDetail({ drafts, store, itemId, later, onLater, onBring, onOpenItem, focusRequest, onFocusRequestConsumed, highlightedMessageIds, onAgentNotRunning, earlierAgent = null }: ItemDetailProps) {
  const current = useSession(store), session = current.snapshot?.session;
  const submit = useDetailSubmit(drafts, store, itemId);
  const draftState = useOwnerDrafts(drafts);
  // An attempted answer stays reachable here (Try sending again) after the item stops waiting.
  const retained = session && draftState.ready ? drafts.find({ project_id: session.project_id, session_id: session.id }, itemId, 'answer') : undefined;
  const retainedAnswer = !!retained?.uncertain;
  const [mode, setMode] = useState<OpenMode | null>(null);
  const [focusBox, setFocusBox] = useState(0);
  const [copied, setCopied] = useState(false);
  const [laterError, setLaterError] = useState(false);
  // The drop reason is local; the sent text wraps it (Ariadne.dc.html:1207).
  const [reason, setReason] = useState('');
  const box = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const handled = useRef<number | null>(null);
  const presence = session?.active_binding_id ? current.presence[session.active_binding_id] ?? null : null;
  // The session's write barrier, shared with the session bar: Resume, Cancel and Retry go through it.
  const actions = useMemo(() => sessionActionsFor(drafts.service, store), [drafts, store]);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : undefined;
  const health = useSupervisorHealth(drafts.service, binding?.id, binding?.generation);
  const model = session ? detailModel({ session, itemId, now: Date.now(), mode, later, saving: submit.saving, presence, health, earlierAgent,
    replyDraft: mode === 'reply' || !!submit.text('reply').trim() }) : null;
  const item = session?.items[itemId];

  const openBox = (next: OpenMode) => { setMode(next); setFocusBox(value => value + 1); };
  const closeBox = () => { setMode(null); focusRoot(itemId); };
  const send = async (intent: 'reply' | 'note' | 'followup' | 'drop' | 'reopen', text: string) => {
    const sent = await submit.send(intent, text);
    if (sent) setMode(null);
    return sent;
  };
  const sendBox = () => {
    if (!model || !mode) return;
    if (mode === 'drop') void send('drop', actionText('drop', model.question, reason)).then(sent => { if (sent) setReason(''); });
    else if (submit.text(mode).trim()) void send(mode, submit.text(mode));
  };
  const toggleLater = async () => { try { setLaterError(!await onLater?.(!later)); } catch { setLaterError(true); } };
  const act = (action: ActionKey) => {
    if (!model) return;
    if (action === 'bring') onBring?.();
    else if (action === 'later') void toggleLater();
    else if (action === 'reopen') void send('reopen', actionText('reopen', model.question));
    else openBox(action);
  };

  useEffect(() => { if (focusBox) box.current?.focus(); }, [focusBox]);
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
  const boxKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeBox(); return; }
    if (mode !== 'drop' && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.stopPropagation(); event.preventDefault(); sendBox(); }
    if (mode === 'drop' && event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); sendBox(); }
  };
  const text = mode && mode !== 'drop' ? boxText[mode] : null;
  // The open box's saved draft, or a reopen that could not go out, was written against an older item (OwnerInput's Review step).
  const stale = mode && submit.changed(mode) ? mode : submit.changed('reopen') ? 'reopen' : null;
  const answerFocus = focusRequest && model.status === 'waiting' && !model.followUp && focusRequest.intent === 'reply' ? { ...focusRequest, intent: 'answer' as const } : focusRequest;
  const copy = () => {
    try { void navigator.clipboard?.writeText(`${model.id} — ${model.question}`).catch(() => {}); } catch { /* The reference still shows. */ }
    setCopied(true);
  };
  // The open box: the Open section's actions, or the follow-up of a waiting item whose input is pending.
  // data-owner-input marks it with its changed-target warning, like the answer slot (native tests).
  // The Follow-up section shows only its own (reply) warning, never the reopen one.
  const ownerBox = (warn: typeof stale) => (warn || mode) && <div className="detail-owner-input" data-owner-input={itemId}>
    <PausedNote actions={actions} />
    {warn && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{changedText}</span>
      <button type="button" className="btn btn-secondary answer-warn-action" disabled={submit.locked(warn)} onClick={() => submit.review(warn)}>Review current target</button></div>}
    {text && mode && <div className="detail-box">
      <textarea ref={box} className="input" rows={3} aria-label={text.label} placeholder={text.placeholder} value={submit.text(mode)} disabled={submit.locked(mode)}
        onChange={event => submit.edit(mode, event.target.value)} onKeyDown={boxKey} />
      <div className="detail-box-row">
        <button type="button" className="btn btn-primary" disabled={!submit.ready || !submit.text(mode).trim() || submit.saving !== null || stale === mode} onClick={sendBox}>
          <i className="ph ph-paper-plane-right" aria-hidden="true" />{text.button}</button>
        <button type="button" className="btn btn-ghost detail-cancel" onClick={closeBox}>Cancel</button>
        <span className="detail-box-hint">{text.hint}</span>
      </div>
    </div>}
    {mode === 'drop' && <div className="detail-box">
      <input ref={box} className="input" aria-label="Drop reason" placeholder="Reason (optional), e.g. the metric already covers it" value={reason}
        disabled={submit.locked('drop')} onChange={event => setReason(event.target.value)} onKeyDown={boxKey} />
      <div className="detail-box-row">
        <button type="button" className="btn btn-secondary" disabled={!submit.ready || submit.saving !== null || stale === 'drop'} onClick={sendBox}>
          <i className="ph ph-x-circle" aria-hidden="true" />Drop item</button>
        <button type="button" className="btn btn-ghost detail-cancel" onClick={closeBox}>Cancel</button>
        <span className="detail-box-hint">Enter drops · the agent confirms</span>
      </div>
    </div>}
  </div>;

  return <article className="item-detail" data-status={model.status} aria-label={`Detail of #${model.id}`}>
    <div className="detail-head">
      {/* The handoff embeds the badge in a block host; its line box makes the row 23px. */}
      <div className="detail-status"><div className="detail-badge"><StatusBadge status={model.display} label={model.badgeLabel} /></div>
        <span className="detail-meta">{model.meta}</span></div>
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
      {model.stuck && <StuckNote actions={actions} input={model.stuck.input} stuck={model.stuck.note}
        onEdit={async () => {
          // An answer goes back to the answer slot below; anything else opens the box that now holds it.
          const outcome = await editQueued(drafts, session, model.stuck!.input, actions);
          if (inEditor(outcome) && outcome.intent !== 'answer' && outcome.intent !== 'topic_reply') openBox(outcome.intent);
          return outcome;
        }} />}
    </section>}

    {model.open && <section className="detail-section detail-open" aria-label={model.open.title}>
      {sectionLabel(model.open.title)}
      <div className="detail-actions" role="group" aria-label="Item actions">
        {model.open.actions.map(action => <button type="button" key={action.action} className={`btn ${action.primary ? 'btn-primary' : 'btn-secondary'} detail-action`}
          aria-pressed={action.primary ? undefined : action.pressed} disabled={action.disabled || (!submit.ready && action.action !== 'later')} title={action.title}
          onClick={() => act(action.action)}>
          <i className={action.icon} aria-hidden="true" />{action.label}<span className="detail-key" aria-hidden="true">{action.key}</span>
        </button>)}
      </div>
      <div className="detail-hint">{model.open.hint}</div>
      {ownerBox(stale) || <PausedNote actions={actions} />}
      {submit.error && <p className="detail-error" role="alert">{submit.error}</p>}
      {laterError && <p className="detail-error" role="alert">Later was not saved. Keep the current view and try again.</p>}
    </section>}

    {model.followUp && <section className="detail-section detail-open" aria-label="Follow-up">
      <div className="detail-actions" role="group" aria-label="Item actions">
        <button type="button" className="btn btn-secondary detail-action" aria-pressed={mode === 'reply'} disabled={model.followUp.disabled || !submit.ready}
          title="Reply in your own words" onClick={() => openBox('reply')}>
          <i className="ph ph-chat-text" aria-hidden="true" />{model.followUp.label}<span className="detail-key" aria-hidden="true">r</span>
        </button>
      </div>
      <div className="detail-hint">{model.followUp.hint}</div>
      {(mode === 'reply' || stale === 'reply') && ownerBox(stale === 'reply' ? 'reply' : null)}
      {submit.error && <p className="detail-error" role="alert">{submit.error}</p>}
    </section>}

    {(model.answer || retainedAnswer) && <section className="detail-section detail-answer" aria-label="Your answer">
      {model.answer?.heading && <div className="detail-label detail-label-accent">Your answer</div>}
      {model.answer?.ask && <Markdown className="detail-ask" text={model.answer.ask} />}
      {model.answer && <PausedNote actions={actions} />}
      {/* While the follow-up box is open, it is the detail's one data-owner-input. */}
      <AnswerSlot drafts={drafts} store={store} itemId={itemId} blocked={model.answer?.blocked} focusRequest={answerFocus}
        marked={!(model.followUp && (mode === 'reply' || stale === 'reply'))}
        onFocusRequestConsumed={onFocusRequestConsumed} onEscape={() => focusRoot(itemId)} onAgentNotRunning={onAgentNotRunning} />
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
      {model.kids.map(kid => <KidButton key={kid.id} kid={kid} onOpen={onOpenItem} />)}
    </section>}

    {model.links.length > 0 && <section className="detail-section detail-links" aria-label="Item links">
      {sectionLabel('Links')}
      {model.links.map((link, index) => <a href="#" key={index} className="detail-link" onClick={event => event.preventDefault()}>
        <i className={link.icon} aria-hidden="true" /><span className="detail-link-label">{link.label}</span>{link.meta && <span className="detail-link-meta">{link.meta}</span>}
      </a>)}
    </section>}

    {model.prev && <section className="detail-section" aria-label="Former outcome">
      <div className="detail-label detail-label-row"><span>Before you reopened it</span><StatusBadge status={model.prev.status} variant="text" /></div>
      <Markdown className="detail-prev" text={model.prev.outcome} />
    </section>}

    {model.rounds.length > 0 && <section className="detail-section detail-rounds" aria-label="Back and forth">
      <div className="detail-label-row"><span className="detail-label">Back and forth</span><span className="detail-count">{model.roundsCount}</span></div>
      {model.rounds.map(round => <div className={`detail-round${round.now ? ' detail-round-now' : ''}`} key={round.label} aria-label={round.label}>
        <div className="detail-round-head"><span>{round.label}</span><span className="detail-round-range">{round.range}</span>
          {round.now && <span className="tag tag-accent detail-round-tag">Waiting on you</span>}</div>
        <div className="detail-round-line"><i className="ph ph-robot" aria-hidden="true" /><Markdown text={round.ask} inline /></div>
        {round.you && <div className="detail-round-line detail-round-you"><i className={round.you.chosen ? 'ph ph-check-circle' : 'ph ph-user'} aria-hidden="true" />
          {round.you.chosen ? <span>{`You chose “${round.you.text}”`}</span> : <OwnerReply text={round.you.text} />}</div>}
        {round.result && <div className="detail-round-line detail-round-result"><i className="ph ph-arrow-elbow-down-right" aria-hidden="true" /><Markdown text={round.result} inline /></div>}
        {round.forks.map(fork => <button type="button" className="detail-fork" key={fork.id} onClick={() => onOpenItem(fork.id)}>
          <i className="ph ph-git-fork" aria-hidden="true" /><span>{fork.question}</span><StatusBadge status={fork.status} variant="text" /></button>)}
      </div>)}
    </section>}

    <section className="detail-section detail-timeline" aria-label="Timeline">
      {sectionLabel('Timeline')}
      <div className="detail-timeline-list">{model.timeline.map(entry => <TimelineExcerpt key={entry.id} id={entry.id} message={entry.message} mark={entry.mark} label={entry.label}
        note={entry.note} last={entry.last} highlighted={highlightedMessageIds?.has(entry.id)}
        after={entry.unsent && <NotSentLine line={entry.unsent.line} again={entry.unsent.again}
          restoreHint={editable(entry.unsent.input.kind) ? putBackBlocked(session, entry.unsent.input) : null}
          onPutBack={putBackBlocked(session, entry.unsent.input) || !editable(entry.unsent.input.kind) ? null : async () => {
            const outcome = await putBackCancelled(drafts, session, entry.unsent!.input);
            if (inEditor(outcome) && outcome.intent !== 'answer' && outcome.intent !== 'topic_reply') openBox(outcome.intent);
            return outcome;
          }} />} />)}</div>
    </section>

    <div className="detail-reference">
      <span>Agent reference</span><code>{model.id}</code>
      <button type="button" className="btn btn-ghost detail-copy" onClick={copy}><i className={copied ? 'ph ph-check' : 'ph ph-copy'} aria-hidden="true" />{copied ? 'Copied' : 'Copy reference'}</button>
    </div>
  </article>;
}
