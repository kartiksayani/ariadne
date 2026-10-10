import { useEffect, useRef } from 'react';
import type { OpenSessions, SessionStore } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { notices } from '../../ui/pages/notices';
import { conflictNotice, isViewConflict } from '../../ui/shared/conflictNotice';

/** Failed sends keep their text and exact retry; refreshing only updates the view. */
export function DraftConflictNotices({ drafts, opened, selectedSession }: {
  readonly drafts: OwnerDraftStore; readonly opened: OpenSessions; readonly selectedSession?: SessionRef | null;
}) {
  const state = useOwnerDrafts(drafts);
  const seen = useRef(new Map<string, { readonly error: unknown; readonly store: SessionStore }>());
  const projectId = selectedSession?.project_id, sessionId = selectedSession?.session_id;
  useEffect(() => {
    const active = new Set<string>();
    const subscriptions: (() => void)[] = [];
    for (const entry of Object.values(state.entries)) {
      const id = `draft-conflict:${entry.draft.op_id}`;
      if (!isViewConflict(entry.error) || entry.receipt) continue;
      if (entry.draft.session.project_id !== projectId || entry.draft.session.session_id !== sessionId) continue;
      const store = opened.get(entry.draft.session);
      if (!store || store.getSnapshot().status === 'closed') continue;
      active.add(id);
      subscriptions.push(store.subscribe(() => {
        if (store.getSnapshot().status === 'closed') { notices.dismiss(id); seen.current.delete(id); }
      }));
      const previous = seen.current.get(id);
      if (previous?.error === entry.error && previous.store === store) continue;
      const scope = { error: entry.error, store };
      seen.current.set(id, scope);
      const isCurrent = () => seen.current.get(id) === scope && opened.get(entry.draft.session) === store && store.getSnapshot().status !== 'closed';
      void conflictNotice(entry.error, { id, draftAtRisk: true, isCurrent, refresh: async () => {
        if (!isCurrent()) return false;
        await store.refresh(true);
        const current = store.getSnapshot();
        return current.status === 'ready' && !current.error;
      } });
    }
    for (const id of seen.current.keys()) if (!active.has(id)) { notices.dismiss(id); seen.current.delete(id); }
    return () => { subscriptions.forEach(unsubscribe => unsubscribe()); };
  }, [state.entries, opened, projectId, sessionId]);
  useEffect(() => () => { for (const id of seen.current.keys()) notices.dismiss(id); seen.current.clear(); }, []);
  return null;
}
