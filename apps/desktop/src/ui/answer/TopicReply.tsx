// "Reply to topic": a message to the agent about a whole topic, not one of its
// items. The box opens under the topic band. Its draft is durable like the item
// drafts (state/drafts), follows the active binding, and once saved it closes;
// the topic's delivery line and the Waiting "Sent" rows track the message.
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import type { SessionActions } from '../../components/bindings/actions';
import { PausedNote } from '../../components/bindings/DispatchChip';
import { blockedDraft, emptyDraft, useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';

export interface TopicReplyProps {
  readonly drafts: OwnerDraftStore;
  readonly store: SessionStore;
  readonly actions: SessionActions;
  readonly topicId: string;
  readonly agent: string;
  /** Esc, Close, or the reply was saved. The draft stays when it wasn't sent. */
  readonly onClose: () => void;
}

export function TopicReply({ drafts, store, actions, topicId, agent, onClose }: TopicReplyProps) {
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const box = useRef<HTMLTextAreaElement>(null);
  const route = session ? { project_id: session.project_id, session_id: session.id } : null;
  const entry = route && state.ready ? drafts.findTopic(route, topicId) : undefined;
  useEffect(() => { void drafts.load(); }, [drafts]);
  // Opening the box takes up the saved draft, or starts one; a sent one makes way for a new one.
  useEffect(() => {
    if (!session || !state.ready) return;
    const existing = drafts.findTopic({ project_id: session.project_id, session_id: session.id }, topicId);
    if (existing?.receipt) drafts.another(existing.draft.op_id, session);
    else if (!existing) drafts.beginTopic(session, topicId);
  }, [drafts, session, state.ready, topicId]);
  useEffect(() => { box.current?.focus(); }, []);
  if (!session) return null;
  const live = current.status === 'ready' && !current.error;
  // `locked` is a save in progress or awaiting a retry: it disables the box. A view that is refreshing (`!live`) only holds
  // Send back: a disabled box drops the owner's keystrokes and focus falls to <body>, where keys become tree shortcuts.
  const locked = !entry || state.preferenceUncertain || entry.saving || entry.uncertain || !!entry.receipt;
  const sendOff = locked || !live;
  // Only the binding can change under a topic reply: it follows the active one.
  const rebased = entry && !entry.receipt && entry.draft.binding_id !== session.active_binding_id ? { ...entry.draft, binding_id: session.active_binding_id ?? '' } : entry?.draft;
  const blocked = rebased ? blockedDraft(rebased, session) : null;
  const send = async () => {
    if (!entry || sendOff || blocked) return;
    if (entry.draft.binding_id !== session.active_binding_id) drafts.review(entry.draft.op_id, session);
    if (await drafts.submit(entry.draft.op_id)) onClose();
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  };
  const retry = entry?.uncertain && !entry.saving;
  const error = (entry?.error ? plainFailure(entry.error) : state.error ? plainFailure(state.error) : null) ?? (blocked && blocked !== emptyDraft ? blocked : null);
  return <div className="tree-topic-reply" data-owner-input={`topic:${topicId}`} onKeyDown={keys} onClick={event => event.stopPropagation()}>
    <PausedNote actions={actions} />
    <textarea ref={box} className="input" rows={3} aria-label="Reply to this topic" placeholder={`Tell ${agent} something about this whole topic…`}
      value={entry && !entry.receipt ? entry.draft.text : ''} disabled={locked} onChange={event => { if (entry) drafts.edit(entry.draft.op_id, { text: event.target.value }); }} />
    <div className="tree-topic-reply-row">
      <button type="button" className="btn btn-primary" disabled={sendOff || !!blocked} onClick={() => { void send(); }}>
        <i className="ph ph-paper-plane-right" aria-hidden="true" />Send reply</button>
      {retry && <button type="button" className="btn btn-secondary" disabled={state.preferenceUncertain || !live}
        onClick={() => { void drafts.submit(entry.draft.op_id).then(saved => { if (saved) onClose(); }); }}>Try sending again</button>}
      <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      <span className="answer-hint">⌘↵ sends · Esc closes, keeps your draft</span>
    </div>
    {state.preferenceUncertain && <button type="button" className="btn btn-secondary" onClick={() => { void drafts.retryPreferences(); }}>Try saving your draft again</button>}
    {error && <p className="detail-error" role="alert">{error}</p>}
  </div>;
}
