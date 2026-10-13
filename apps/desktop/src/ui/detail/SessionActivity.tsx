import type { Immutable } from '../../data/session-store';
import type { Message, Session } from '../../generated/domain/models';
import { excerptView } from '../shared/excerpt';
import { CopyMessage } from './CopyMessage';
import { notSent } from '../../selectors/waiting/stuck';
import { NotSentLine } from '../answer/NotSentLine';
import { itemRemoved } from '../../selectors/removed';

/** The same associations that make saved messages reachable in an item's conversation. */
export function inItemConversation(session: Immutable<Session>, message: Immutable<Message>): boolean {
  // Removed by agent retains conversation messages, but explicitly excludes lifecycle notices.
  const reachable = (id: string) => !!session.items[id] && (message.kind !== 'lifecycle' || !itemRemoved(session, id));
  return !!(message.item_id && reachable(message.item_id)) || message.items_touched.some(reachable)
    || Object.values(session.items).some(item => item && reachable(item.id) && (item.created_message_id === message.id || item.updated_message_ids.includes(message.id)))
    || Object.values(session.rounds).some(round => round && reachable(round.item_id) && (round.opened_message_id === message.id
      || round.agent_message_ids.includes(message.id) || round.owner_message_ids.includes(message.id)));
}

/** Topic replies and session lifecycle messages formerly reachable only in Messages. */
export function SessionActivity({ session, earlierAgent = null }: { readonly session: Immutable<Session>; readonly earlierAgent?: string | null }) {
  const messages = session.messages.filter(message => !inItemConversation(session, message));
  if (!messages.length) return null;
  return <details className="session-activity">
    <summary>Session activity · {messages.length}</summary>
    <ol aria-label="Session activity">
      {messages.map(message => {
        const view = excerptView(message, Date.now(), earlierAgent), unsent = notSent(session, message);
        return <li key={message.id} data-message-id={message.id}>
          <span className="excerpt-note">{view.number} · {view.who}{message.topic_id && ` · ${session.topics[message.topic_id]?.name ?? 'Topic'}`}</span>
          {unsent && <NotSentLine line={unsent.line} again={unsent.again} onPutBack={null} />}
          <p style={{ whiteSpace: 'pre-wrap' }}>{message.body}</p><CopyMessage text={message.body} />
        </li>;
      })}
    </ol>
  </details>;
}
