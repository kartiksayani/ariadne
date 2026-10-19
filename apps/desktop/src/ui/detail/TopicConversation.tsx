// A topic's own conversation in Details (alpha.21 E5, E6; SPEC 5.3): the badge "Topic", its meta, the topic's name, what the
// agent and the owner said about the whole topic, and the composer "Reply about this topic…". It is a mode of the column, not
// a selection: no Back/Forward entry, no Focus, no Read toggle, no actions row, no change box. The reply is the stored
// TOPIC_REPLY draft, so nothing typed is lost to Esc, a session switch or closing Details.
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { sessionActionsFor } from '../../components/bindings/actions';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { useTopicReply } from '../answer/useTopicReply';
import { clockTime } from '../changes/clock';
import { agentName } from '../shell/model';
import { itemRemoved } from '../../selectors/removed';
import { displayStatus } from '../../selectors/waiting/replied';
import { ItemRefs } from '../shared/MarkdownText';
import { ItemRefSession } from '../peek/context';
import { Chat } from './Chat';
import { Composer } from './Composer';
import { useHidden } from '../remove/queue';
import { topicChat } from './model';
import type { Words } from './submit';
import './detail.css';

export interface TopicConversationProps {
  readonly drafts: OwnerDraftStore;
  readonly store: SessionStore;
  readonly topicId: string;
  /** An item named in the conversation was clicked. */
  readonly onOpenItem: (itemId: string) => void;
}

const SLOT_KEY = 'topic-reply';
const nearEnd = (pane: HTMLElement) => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;

export function TopicConversation({ drafts, store, topicId, onOpenItem }: TopicConversationProps) {
  const session = useSession(store).snapshot?.session, draftState = useOwnerDrafts(drafts, session);
  const actions = useMemo(() => sessionActionsFor(drafts.service, store), [drafts, store]);
  const topic = session?.topics[topicId];
  // The topic is in a pending removal's window: its box says so and nothing goes out until Undo (alpha.21 E28).
  const hidden = useHidden(), removing = !!session && hidden.topic({ project_id: session.project_id, session_id: session.id }, topicId);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const agent = binding ? agentName(binding.adapter_id) : 'the agent';
  const reply = useTopicReply(drafts, store, topicId, agent);
  const entries = useMemo(() => session ? topicChat(session, topicId, Date.now()) : [], [session, topicId]);
  const body = useRef<HTMLDivElement>(null), atEnd = useRef(true), shownEntries = useRef(0);
  // Opens at the latest message, and follows new ones while the owner is at the end; it never moves them otherwise.
  useLayoutEffect(() => {
    const pane = body.current;
    if (pane && (shownEntries.current === 0 || atEnd.current)) pane.scrollTop = pane.scrollHeight;
    shownEntries.current = entries.length;
  }, [entries]);
  const focusBox = () => document.querySelector<HTMLTextAreaElement>(`[data-owner-input="${CSS.escape(topicId)}"] textarea`)?.focus({ preventScroll: true });
  useEffect(() => { focusBox(); }, [topicId]);
  if (!session || !topic) return <p role="status">This topic is unavailable.</p>;
  const slot: Words = { id: reply.entry?.draft.op_id ?? null, kind: 'reply', text: reply.text, locked: reply.locked, changed: false };
  // Esc leaves the box for the topic's row (or, with no row, for nothing), so the next Esc closes Details with the words kept.
  const keys = () => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation(); event.preventDefault();
      const row = document.querySelector<HTMLElement>(`[data-topic-id="${CSS.escape(topicId)}"].tree-topic`);
      // The Graph has no topic row: the box lets go of focus instead, so the next Esc reaches the workspace and closes Details.
      if (row) row.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.stopPropagation(); event.preventDefault(); if (!reply.sendOff && !removing) void reply.send();
    }
  };
  const showBox = reply.entry !== undefined;
  return <article className="item-detail item-topic" data-detail-topic-id={topicId} aria-label={`Topic: ${topic.name}`}>
    <div className="detail-body" ref={body} onScroll={event => { atEnd.current = nearEnd(event.currentTarget); }}>
      <div className="detail-topic-head">
        <div className="detail-status">
          <span className="detail-badge detail-badge-topic"><i className="ph ph-tree-structure" aria-hidden="true" />Topic</span>
          <span className="detail-meta">{`Topic · started by ${agent} at ${clockTime(topic.created_at)}`}</span>
        </div>
        <h2 className="detail-question" title={topic.name}>{topic.name}</h2>
      </div>
      {entries.length > 0 && <ItemRefSession.Provider value={{ project_id: session.project_id, session_id: session.id }}><ItemRefs.Provider value={{
        lookup: id => { const target = session.items[id]; return target && !itemRemoved(session, target.id) ? { label: target.question, status: displayStatus(session, target) } : null; },
        route: id => ({ project_id: session.project_id, session_id: session.id, item_id: id }), onOpenItem,
      }}><Chat entries={entries} session={session} topicId={topicId} drafts={drafts} draftState={draftState} actions={actions}
        // A taken-back or put-back topic reply: its words are in the composer below, which is worth focusing.
        onOpenEditor={target => { if (target === 'topic_reply') focusBox(); }} /></ItemRefs.Provider></ItemRefSession.Provider>}
    </div>
    <div className="detail-dock">
      <Composer kind="topic" removing={removing} ownerKey={topicId} actions={actions} sentAs={showBox ? 'reply' : null} slots={[slot]} slotKey={() => SLOT_KEY}
        sendOff={() => removing || reply.sendOff} closable={false} register={() => {}} onEdit={(_slot, text) => reply.edit(text)} onKeyDown={keys}
        onSend={() => { void reply.send(); }} onCancel={() => {}} onReview={() => {}}
        before={reply.unavailable && <p className="detail-topic-why" role="status"><i className="ph ph-info" aria-hidden="true" />{reply.unavailable}</p>}>
        {reply.retry && <button type="button" className="btn btn-secondary" disabled={reply.preferenceUncertain} onClick={() => { void reply.sendAgain(); }}>Try sending again</button>}
        {reply.preferenceUncertain && <button type="button" className="btn btn-secondary" onClick={reply.retryPreferences}>Try saving your draft again</button>}
        {reply.error && <p className="detail-error" role="alert">{reply.error}</p>}
      </Composer>
    </div>
  </article>;
}
