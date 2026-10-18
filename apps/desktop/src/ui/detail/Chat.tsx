// The conversation list of Details: the agent's and the owner's messages in saved order, with each owner message's delivery
// state (not sent, stuck) and the answer's changes under it. It serves an item's conversation today and a topic's next
// (`topicChat` in ./model builds the entries for a topic). The owner's boxes live in ./Composer, not here.
import type { ReactNode } from 'react';
import type { Immutable } from '../../data';
import type { Session } from '../../generated/domain/models';
import type { SessionActions } from '../../components/bindings/actions';
import type { DraftState, OwnerDraftStore } from '../../state/drafts/store';
import { AnswerChanges } from '../changes/AnswerChanges';
import { editable, editQueued, inEditor, putBackBlocked, putBackCancelled, sendingAgain, type EditTarget } from '../answer/held';
import { NotSentLine } from '../answer/NotSentLine';
import { StuckNote } from '../answer/StuckNote';
import { peekNames } from '../peek/names';
import { ItemReference, ItemRefs, Markdown, singleParagraph } from '../shared/MarkdownText';
import { STATUS } from '../shared/status';
import { StatusBadge } from '../shared/StatusBadge';
import { CopyMessage } from './CopyMessage';
import type { ChatEntry, PendingView } from './model';

export interface ChatProps {
  /** The messages, oldest first (`detailModel(...).chat` for an item, `topicChat(...)` for a topic). */
  readonly entries: readonly ChatEntry[];
  readonly session: Immutable<Session>;
  /** The item the conversation belongs to; absent for a topic's conversation. */
  readonly itemId?: string;
  /** The topic the conversation belongs to; absent for an item's conversation. */
  readonly topicId?: string;
  /** The bigger view: wider labels, arrow keys walk the messages. */
  readonly expanded?: boolean;
  /** The entry that starts the "New since you last looked" divider. */
  readonly dividerId?: string | null;
  /** Content above the list inside the section (the item conversation's label row). */
  readonly header?: ReactNode;
  readonly drafts: OwnerDraftStore;
  readonly draftState: DraftState;
  /** The session's write barrier: StuckNote's Resume, Cancel and Retry go through it. */
  readonly actions: SessionActions;
  readonly onOpenItem: (itemId: string) => void;
  /** A message was taken back (Edit) or put back: the editor named by `target` now holds its words and is worth opening. */
  readonly onOpenEditor: (target: EditTarget) => void;
  /** Extra content under one entry (the Because card, W3). */
  readonly after?: (entryId: string) => ReactNode;
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

export function Chat({ entries, session, expanded = false, dividerId, header, drafts, draftState, actions, onOpenItem, onOpenEditor, after }: ChatProps) {
  const relatedLabels = peekNames(session);
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
        className={`detail-turn${entry.unsent ? ' detail-turn-cancelled' : ''}${entry.asks.some(ask => ask.now) ? ' detail-turn-now' : ''}${entry.pending ? ' detail-turn-pending' : ''}`}>
        {entry.id === dividerId && <div className="conversation-unseen">New since you last looked</div>}
        {entry.marker && <div className="detail-chat-marker">{entry.marker}</div>}
        <div className={`detail-msg${entry.you ? ' detail-msg-you' : ''}`}>
          <div className={`detail-bubble ${entry.you ? 'detail-bubble-you' : 'detail-bubble-agent'}`}>
            {entry.you ? <>{expanded && <span className="detail-pending-caption">You · {entry.message.when}</span>}<YouSaid {...entry.you} />
              {!expanded && <span className="detail-pending-caption">you · {entry.message.when}</span>}
              {entry.pending?.caption && <span className="detail-pending-caption">{entry.pending.caption}</span>}</>
              : <><div className="detail-agent-meta">{expanded ? <span>Agent</span> : <><span>{entry.message.number}</span><span>{entry.message.who}</span></>}<span>{entry.message.when}</span></div>
                <Markdown text={entry.message.body} />
                {entry.asks.filter(ask => !ask.text && ask.now).map(ask => <span key={ask.ordinal} className="tag tag-accent detail-waiting-tag">Waiting on you</span>)}</>}
          </div><CopyMessage text={entry.message.body} />
        </div>
        {entry.asks.filter(ask => ask.text || entry.you && ask.now).map(ask => <div className="detail-msg" key={ask.ordinal}>
          <div className="detail-bubble detail-bubble-agent">{ask.text && <Markdown text={ask.text} />}
            {ask.now && <span className="tag tag-accent detail-waiting-tag">Waiting on you</span>}</div>
          {ask.text && <CopyMessage text={ask.text} />}
        </div>)}
        {entry.you && (() => {
          const input = Object.values(session.inputs).find(value => value?.message_id === entry.id);
          const answer = session.answers.find(value => value.message_id === entry.id);
          const inputId = input?.id ?? answer?.input_id;
          return inputId ? <AnswerChanges session={session} inputId={inputId} onOpenItem={onOpenItem} /> : null;
        })()}
        {entry.note && <div className="detail-chat-marker">{entry.note}</div>}
        {entry.unsent && <NotSentLine line={entry.unsent.line} again={entry.unsent.again || sendingAgain(draftState, session, entry.unsent.input)}
          restoreHint={editable(entry.unsent.input.kind) ? putBackBlocked(session, entry.unsent.input) : null}
          onPutBack={putBackBlocked(session, entry.unsent.input) || !editable(entry.unsent.input.kind) ? null : async () => {
            const outcome = await putBackCancelled(drafts, session, entry.unsent!.input);
            if (inEditor(outcome)) onOpenEditor(outcome.intent);
            return outcome;
          }} />}
        {entry.pending?.stuck && <StuckNote actions={actions} input={entry.pending.input} stuck={entry.pending.stuck}
          onEdit={async () => {
            const outcome = await editQueued(drafts, session, entry.pending!.input, actions);
            if (inEditor(outcome)) onOpenEditor(outcome.intent);
            return outcome;
          }} />}
        {entry.result && <div className="detail-msg detail-msg-result"><span aria-hidden="true">↳</span><Markdown className="detail-msg-text" text={entry.result} inline /><CopyMessage text={entry.result} /></div>}
        {entry.forks.map(fork => <ItemReference itemId={fork.id} className="detail-fork" key={fork.id} preserveContent title={fork.question}
          ariaLabel={`Branched into ${relatedLabels.get(fork.id)} · ${STATUS[fork.status].label}`}>
          <i className="ph ph-git-fork" aria-hidden="true" /><span>Branched into {relatedLabels.get(fork.id)}</span><StatusBadge status={fork.status} variant="text" /></ItemReference>)}
        {after?.(entry.id)}
      </li>)}
    </ol>
  </section>;
}
