// The view of one message for both Message Excerpt variants (handoff README
// Components; Message Excerpt.dc.html): number, author, day and time, body.
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Message, SessionSummary } from '../../generated/domain/models';
import { agentName, clock, dayWord, ownerName } from '../shell/model';

export interface ExcerptView {
  /** "#18", or "codex #18" for an earlier session's message. */
  readonly number: string;
  readonly author: 'me' | 'agent' | 'system';
  /** "You", "Agent" or "System". */
  readonly who: string;
  readonly icon: string;
  /** "15:04", or "Yesterday 17:18" before today. */
  readonly when: string;
  readonly body: string;
}

/** A message's number, with the agent's name for an earlier session's message: "#19", "codex #19". */
export const messageNumber = (message: Immutable<Message>, agent: string | null = null) => agent ? `${agent} #${message.number}` : `#${message.number}`;

const running = (session: Immutable<SessionSummary>) => session.archived_at == null && session.state === 'active' && session.active_binding?.connection_state === 'connected';
/**
 * The agent name an earlier session's messages carry (Ariadne.dc.html:1788, as the Waiting cards' "asked in codex #19"):
 * set while this session's agent isn't running and another session of its project is; null otherwise.
 */
export function earlierAgent(route: SessionRef, sessions: readonly Immutable<SessionSummary>[]): string | null {
  const own = sessions.find(session => session.project_id === route.project_id && session.session_id === route.session_id);
  if (!own?.active_binding || running(own)) return null;
  const live = sessions.some(session => session.project_id === route.project_id && session.session_id !== route.session_id && running(session));
  // The owner's name for the session, when set, stands in for the agent's.
  return live ? ownerName(own) ?? agentName(own.active_binding.adapter_id) : null;
}

export function excerptView(message: Immutable<Message>, now: number, agent: string | null = null): ExcerptView {
  const at = Date.parse(message.created_at), day = Number.isNaN(at) ? '' : dayWord(at, now);
  const time = Number.isNaN(at) ? '' : clock(at);
  const author = message.author === 'owner' ? 'me' : message.author === 'agent' ? 'agent' : 'system';
  return {
    number: messageNumber(message, agent), author,
    who: author === 'me' ? 'You' : author === 'agent' ? 'Agent' : 'System',
    icon: author === 'me' ? 'ph ph-user' : author === 'agent' ? 'ph ph-robot' : 'ph ph-info',
    when: day ? `${day} ${time}` : time,
    body: message.body,
  };
}
