import { useEffect, useRef } from 'react';
import type { OpenSessions } from '../../data/session-store';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { notices } from '../../ui/pages/notices';
import { conflictNotice, isViewConflict } from '../../ui/shared/conflictNotice';

/** Failed sends keep their text and exact retry; refreshing only updates the view. */
export function DraftConflictNotices({ drafts, opened }: { readonly drafts: OwnerDraftStore; readonly opened: OpenSessions }) {
  const state = useOwnerDrafts(drafts);
  const seen = useRef(new Map<string, unknown>());
  useEffect(() => {
    const active = new Set<string>();
    for (const entry of Object.values(state.entries)) {
      const id = `draft-conflict:${entry.draft.op_id}`;
      if (!isViewConflict(entry.error) || entry.receipt) continue;
      active.add(id);
      if (seen.current.get(id) === entry.error) continue;
      seen.current.set(id, entry.error);
      const store = opened.open(entry.draft.session);
      void conflictNotice(entry.error, { id, draftAtRisk: true, refresh: async () => {
        await store.refresh(true);
        const current = store.getSnapshot();
        return current.status === 'ready' && !current.error;
      } });
    }
    for (const id of seen.current.keys()) if (!active.has(id)) { notices.dismiss(id); seen.current.delete(id); }
  }, [state.entries, opened]);
  useEffect(() => () => { for (const id of seen.current.keys()) notices.dismiss(id); seen.current.clear(); }, []);
  return null;
}
