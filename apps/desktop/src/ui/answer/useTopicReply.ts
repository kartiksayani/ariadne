// "Reply to topic": a message to the agent about a whole topic, not one of its items. It is written in Details' topic mode.
// Its draft is the stored TOPIC_REPLY draft (state/drafts): durable like the item drafts, following the active binding. Once it
// is sent the next keystroke starts a new draft; the topic's delivery line and the Waiting "Sent" rows track the message.
import { useEffect } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import { blockedDraft, emptyDraft, useOwnerDrafts, type DraftEntry, type OwnerDraftStore } from '../../state/drafts/store';

export interface TopicReplyState {
  /** The saved draft, once drafts are loaded and the topic takes a reply; null while it cannot. */
  readonly entry: DraftEntry | undefined;
  readonly text: string;
  /** Why no reply can be written now (no binding, archived, removed); the box shows it and stays read-only. */
  readonly unavailable: string | null;
  /** A save is in progress or awaits a retry: the box is locked. */
  readonly locked: boolean;
  /** Send is off: locked, the view refreshing, or the draft blocked. */
  readonly sendOff: boolean;
  /** The draft cannot go out as it is (empty, too long, the connection changed), in the owner's words. */
  readonly error: string | null;
  /** The last send's outcome is unknown: sending the same message once more is offered. */
  readonly retry: boolean;
  readonly preferenceUncertain: boolean;
  readonly edit: (text: string) => void;
  /** Sends the draft once; true when the core accepted it. */
  readonly send: () => Promise<boolean>;
  readonly sendAgain: () => Promise<boolean>;
  readonly retryPreferences: () => void;
}

/** Why no reply can go out now, or null; `boxShown`: a box is there (a stored draft), so typing is kept. */
export const topicReplyReason = (session: NonNullable<ReturnType<typeof useSession>['snapshot']>['session'], topicId: string, agent: string, boxShown: boolean): string | null => {
  const topic = session.topics[topicId];
  if (!topic || topic.removed_at) return 'This topic was removed, so it takes no reply.';
  if (topic.archived_at !== null) return 'This topic is archived. Restore it to reply.';
  // Without a binding no draft can start, so a box shows only when a stored draft is there to keep; then typing is kept.
  if (!session.active_binding_id && !boxShown) return 'You can write here once an agent is connected.';
  if (session.state !== 'active' || !session.active_binding_id) return `${agent === 'the agent' ? 'The agent' : agent} isn’t running, so a reply can’t go out yet.${boxShown ? ' Whatever you type here is kept.' : ''}`;
  return null;
};

/** The topic reply for `topicId` in the session of `store`; `agent` is the name the messages go to. */
export function useTopicReply(drafts: OwnerDraftStore, store: SessionStore, topicId: string, agent: string): TopicReplyState {
  const current = useSession(store), session = current.snapshot?.session, state = useOwnerDrafts(drafts, session);
  const route = session ? { project_id: session.project_id, session_id: session.id } : null;
  const entry = route && state.ready ? drafts.findTopic(route, topicId) : undefined;
  useEffect(() => { void drafts.load(); }, [drafts]);
  // Opening takes up the saved draft, or starts one; a sent one makes way for a new one. When no draft can start the box says why.
  useEffect(() => {
    if (!session || !state.ready) return;
    const existing = drafts.findTopic({ project_id: session.project_id, session_id: session.id }, topicId);
    if (existing?.receipt) drafts.another(existing.draft.op_id, session);
    else if (!existing) drafts.beginTopic(session, topicId);
  }, [drafts, session, state.ready, topicId]);
  const live = current.status === 'ready' && !current.error;
  const locked = !entry || state.preferenceUncertain || entry.saving || entry.uncertain || !!entry.receipt;
  const sendOff = locked || !live;
  // Only the binding can change under a topic reply: it follows the active one.
  const rebased = entry && session && !entry.receipt && entry.draft.binding_id !== session.active_binding_id
    ? { ...entry.draft, binding_id: session.active_binding_id ?? '' } : entry?.draft;
  const blocked = rebased && session ? blockedDraft(rebased, session) : null;
  const unavailable = session ? topicReplyReason(session, topicId, agent, entry !== undefined) : null;
  const send = async () => {
    if (!entry || !session || sendOff || blocked) return false;
    if (entry.draft.binding_id !== session.active_binding_id) drafts.review(entry.draft.op_id, session);
    return drafts.submit(entry.draft.op_id);
  };
  const error = (entry?.error ? plainFailure(entry.error) : state.error ? plainFailure(state.error) : null) ?? (blocked && blocked !== emptyDraft ? blocked : null);
  return {
    entry, text: entry && !entry.receipt ? entry.draft.text : '', unavailable, locked, sendOff: sendOff || !!blocked, error,
    retry: !!entry?.uncertain && !entry.saving, preferenceUncertain: state.preferenceUncertain,
    edit: text => { if (entry && !locked) drafts.edit(entry.draft.op_id, { text }); },
    send,
    sendAgain: async () => !!entry && !state.preferenceUncertain && live ? drafts.submit(entry.draft.op_id) : false,
    retryPreferences: () => { void drafts.retryPreferences(); },
  };
}
