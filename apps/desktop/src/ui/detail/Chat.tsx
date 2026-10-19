// The conversation list of Details: the agent's and the owner's messages in saved order, each under its label ("Agent raised
// this", "You replied"), with where an owner's message stands under its bubble (queued, picked up, not sent) and its fix when
// it is stuck. It serves an item's conversation and a topic's (`topicChat` in ./model builds the entries for a topic). The
// owner's boxes live in ./Composer, not here.
import { useState, type ReactNode } from 'react';
import type { Immutable } from '../../data';
import type { Input, Session } from '../../generated/domain/models';
import type { SessionActions } from '../../components/bindings/actions';
import type { DraftState, OwnerDraftStore } from '../../state/drafts/store';
import { editable, editQueued, inEditor, putBackBlocked, putBackCancelled, sendingAgain, type EditTarget, type ReviewOutcome } from '../answer/held';
import { NotSentLine } from '../answer/NotSentLine';
import { ReviewResult, StuckNote, useStuckRetry } from '../answer/StuckNote';
import { ActionFailure } from '../../components/edge-states/EdgeState';
import { peekNames } from '../peek/names';
import { ItemReference, ItemRefs, Markdown, singleParagraph } from '../shared/MarkdownText';
import { STATUS } from '../shared/status';
import { StatusBadge } from '../shared/StatusBadge';
import { clock } from '../shell/model';
import { CopyMessage } from './CopyMessage';
import type { BubbleStatus, ChatEntry, PendingView } from './model';

export interface ChatProps {
  /** The messages, oldest first (`detailModel(...).chat` for an item, `topicChat(...)` for a topic). */
  readonly entries: readonly ChatEntry[];
  readonly session: Immutable<Session>;
  /** The item the conversation belongs to; absent for a topic's conversation. */
  readonly itemId?: string;
  /** The topic the conversation belongs to; absent for an item's conversation. */
  readonly topicId?: string;
  /** The bigger view: arrow keys walk the messages. */
  readonly expanded?: boolean;
  /** The entry that starts the "New since you last looked" divider. */
  readonly dividerId?: string | null;
  /** When the owner last looked (epoch ms): the divider reads "New since you last looked at 20:40". */
  readonly dividerAt?: number | null;
  /** Content above the list inside the section (the item conversation's label row). */
  readonly header?: ReactNode;
  readonly drafts: OwnerDraftStore;
  readonly draftState: DraftState;
  /** The session's write barrier: StuckNote's Resume, Cancel and Retry go through it. */
  readonly actions: SessionActions;
  /** A message was taken back (Undo, Edit) or put back: the editor named by `target` now holds its words and is worth opening. */
  readonly onOpenEditor: (target: EditTarget) => void;
  /** Extra content under one entry (the Because card, W3). */
  readonly after?: (entryId: string) => ReactNode;
}

/** The owner's own words: a one-paragraph reply reads inline; a longer one keeps its paragraphs and lists. The label above says who. */
function OwnerReply({ text }: { readonly text: string }) {
  return <ItemRefs.Provider value={null}>{singleParagraph(text) ? <span><Markdown text={text} inline /></span>
    : <div className="detail-reply"><Markdown text={text} /></div>}</ItemRefs.Provider>;
}

/** What the owner sent, inside their bubble: the option they chose, a one-press request, or their own words. */
function YouSaid({ how, text, note = '' }: { readonly how: PendingView['how']; readonly text: string; readonly note?: string }) {
  return <>
    <i className={`${how === 'chose' ? 'ph ph-check-circle' : 'ph ph-user'} detail-msg-icon detail-you-icon`} aria-hidden="true" />
    {how === 'chose' ? <div className="detail-reply"><span>{`You chose “${text}”`}</span>{note.trim() && <ItemRefs.Provider value={null}><Markdown text={note} /></ItemRefs.Provider>}</div> : how === 'action' ? <div className="detail-reply"><span>{text}</span>{note.trim() && <ItemRefs.Provider value={null}><Markdown text={note} /></ItemRefs.Provider>}</div> : <OwnerReply text={text} />}
  </>;
}

interface StatusLineProps {
  readonly status: BubbleStatus;
  readonly actions: SessionActions;
  /** Undo: take the queued message back and put its words in the editor (held.ts `editQueued`). */
  readonly onUndo: (input: Immutable<Input>) => Promise<ReviewOutcome>;
}

/** Retry on a stopped delivery the agent never received: one resend of the same message (StuckNote's own Retry, lifted). A failed write shows under the line. */
function NotSent({ status, actions }: { readonly status: Extract<BubbleStatus, { kind: 'not_sent' }>; readonly actions: SessionActions }) {
  const retry = useStuckRetry(actions, status.input, status.stuck);
  return <>
    <div className="detail-bubble-status detail-bubble-status-problem" data-status="not_sent" role="status">
      <span>⚠ Not sent. Your words are kept.</span>
      {retry && <button type="button" className="btn btn-ghost detail-status-action" disabled={retry.disabled} title={retry.title} onClick={retry.run}>Retry</button>}
    </div>
    {retry?.acted && <div className="stuck-failure"><ActionFailure actions={actions} /></div>}
  </>;
}

/** Under an owner bubble: "✓ Sent at 21:25 · waiting for the agent Undo", "✓ Picked up at 21:26" or "⚠ Not sent. Your words are kept. Retry". */
function StatusLine({ status, actions, onUndo }: StatusLineProps) {
  const [undoing, setUndoing] = useState(false);
  const [result, setResult] = useState<ReviewOutcome | null>(null);
  if (status.kind === 'picked_up') return <div className="detail-bubble-status" data-status="picked_up" role="status">{`✓ Picked up${status.at ? ` at ${status.at}` : ''}`}</div>;
  if (status.kind === 'not_sent') return <NotSent status={status} actions={actions} />;
  const undo = () => {
    if (undoing) return;
    setUndoing(true);
    void onUndo(status.input).then(outcome => { setUndoing(false); setResult(outcome); }, () => { setUndoing(false); setResult({ kind: 'unavailable' }); });
  };
  return <>
    <div className="detail-bubble-status" data-status="sent" role="status">
      <span>{`✓ Sent${status.at ? ` at ${status.at}` : ''} · waiting for the agent`}</span>
      {status.undo && <button type="button" className="btn btn-ghost detail-status-action" disabled={undoing} title="Take it back to edit; it isn’t sent until you send it again" onClick={undo}>Undo</button>}
    </div>
    {result && <ReviewResult outcome={result} />}
  </>;
}

export function Chat({ entries, session, expanded = false, dividerId, dividerAt, header, drafts, draftState, actions, onOpenEditor, after }: ChatProps) {
  const relatedLabels = peekNames(session);
  const edit = async (input: Immutable<Input>) => {
    const outcome = await editQueued(drafts, session, input, actions);
    if (inEditor(outcome)) onOpenEditor(outcome.intent);
    return outcome;
  };
  return <section className="detail-section detail-chat" aria-label="Conversation">
    {header}
    <ol className="detail-chat-list" onKeyDown={event => {
      if (!expanded || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey
        || (event.target instanceof Element && event.target.closest('input,textarea,button,a,select,[contenteditable="true"]'))) return;
      const messages = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-message-id]')];
      const current = event.target instanceof Element ? messages.indexOf(event.target.closest<HTMLElement>('[data-message-id]')!) : -1;
      const next = current < 0 ? 0 : Math.max(0, Math.min(messages.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      event.preventDefault(); event.stopPropagation(); messages[next]?.focus({ preventScroll: true });
      messages[next]?.scrollIntoView?.({ block: 'nearest' });
    }}>
      {entries.map(entry => <li key={entry.id} tabIndex={expanded ? -1 : undefined} data-message-id={entry.id} data-pending={entry.pending?.input.id}
        data-round={entry.asks[0]?.ordinal}
        data-owner-said={entry.you && !Object.values(session.inputs).some(input => input?.message_id === entry.id && input.state === 'cancelled') ? 'true' : undefined}
        className={`detail-turn${entry.unsent ? ' detail-turn-cancelled' : ''}${entry.asks.some(ask => ask.now) ? ' detail-turn-now' : ''}${entry.pending ? ' detail-turn-pending' : ''}${entry.status ? ' detail-turn-status' : ''}`}>
        {entry.id === dividerId && <div className="conversation-unseen" data-testid="new-divider">{`New since you last looked${dividerAt ? ` at ${clock(dividerAt)}` : ''}`}</div>}
        <div className={`detail-msg${entry.you ? ' detail-msg-you' : ''}`}>
          {!entry.you && <span className="detail-avatar" aria-hidden="true"><i className="ph ph-robot" /></span>}
          <div className="detail-msg-main">
            <div className="detail-chat-label" data-testid="chat-label"><span>{entry.label}</span><span className="detail-chat-time">{entry.message.when}</span></div>
            <div className={`detail-bubble ${entry.you ? 'detail-bubble-you' : 'detail-bubble-agent'}`}>
              {entry.you ? <><YouSaid {...entry.you} />
                {!entry.status && entry.pending?.caption && <span className="detail-pending-caption">{entry.pending.caption}</span>}</>
                : <><Markdown text={entry.message.body} />
                  {entry.asks.filter(ask => !ask.text && ask.now).map(ask => <span key={ask.ordinal} className="tag tag-accent detail-waiting-tag">Waiting on you</span>)}</>}
            </div>
            {entry.status && <StatusLine status={entry.status} actions={actions} onUndo={edit} />}
          </div>
          <CopyMessage text={entry.message.body} />
        </div>
        {entry.asks.filter(ask => ask.text || entry.you && ask.now).map(ask => <div className="detail-msg" key={ask.ordinal}>
          <span className="detail-avatar" aria-hidden="true"><i className="ph ph-robot" /></span>
          <div className="detail-bubble detail-bubble-agent">{ask.text && <Markdown text={ask.text} />}
            {ask.now && <span className="tag tag-accent detail-waiting-tag">Waiting on you</span>}</div>
          {ask.text && <CopyMessage text={ask.text} />}
        </div>)}
        {entry.unsent && <NotSentLine line={entry.unsent.line} again={entry.unsent.again || sendingAgain(draftState, session, entry.unsent.input)}
          restoreHint={editable(entry.unsent.input.kind) ? putBackBlocked(session, entry.unsent.input) : null}
          onPutBack={putBackBlocked(session, entry.unsent.input) || !editable(entry.unsent.input.kind) ? null : async () => {
            const outcome = await putBackCancelled(drafts, session, entry.unsent!.input);
            if (inEditor(outcome)) onOpenEditor(outcome.intent);
            return outcome;
          }} />}
        {entry.pending?.stuck && !(entry.status?.kind === 'sent' && entry.status.undo) && <StuckNote actions={actions} input={entry.pending.input} stuck={entry.pending.stuck}
          retryAbove={entry.status?.kind === 'not_sent'} onEdit={() => edit(entry.pending!.input)} />}
        {entry.result && <div className="detail-msg detail-msg-result"><span aria-hidden="true">↳</span><Markdown className="detail-msg-text" text={entry.result} inline /><CopyMessage text={entry.result} /></div>}
        {entry.forks.map(fork => <ItemReference itemId={fork.id} className="detail-fork" key={fork.id} preserveContent title={fork.question}
          ariaLabel={`Branched into ${relatedLabels.get(fork.id)} · ${STATUS[fork.status].label}`}>
          <i className="ph ph-git-fork" aria-hidden="true" /><span>Branched into {relatedLabels.get(fork.id)}</span><StatusBadge status={fork.status} variant="text" /></ItemReference>)}
        {after?.(entry.id)}
      </li>)}
    </ol>
  </section>;
}
