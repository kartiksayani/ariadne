// The detail panel's submit seam. It wraps the owner draft store so the panel
// never touches drafts directly; WP2's ui/answer/useSubmit.ts can replace this
// hook without changing ItemDetail.
import { useEffect } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import type { InputKind } from '../../generated/domain/models';
import { useOwnerDrafts, type DraftEntry, type OwnerDraftStore, type OwnerIntent } from '../../state/drafts/store';

export type DetailIntent = Exclude<OwnerIntent, 'answer' | 'bring'>;

export interface DetailSubmit {
  /** Drafts are loaded and the session is ready, so edits and sends can start. */
  readonly ready: boolean;
  /** The saved draft text for one intent. */
  readonly text: (intent: DetailIntent) => string;
  /** The draft is locked while its operation is saving or awaits a retry. */
  readonly locked: (intent: DetailIntent) => boolean;
  readonly edit: (intent: DetailIntent, text: string) => void;
  /** Saves the text into the intent's draft and submits it; resolves true once the core accepted it. */
  readonly send: (intent: DetailIntent, text?: string) => Promise<boolean>;
  /** The kind of an owner input for this item being saved right now. */
  readonly saving: InputKind | null;
  /** The latest failure for this item's drafts, as a sentence. */
  readonly error: string | null;
}

export function useDetailSubmit(drafts: OwnerDraftStore, store: SessionStore, itemId: string): DetailSubmit {
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  useEffect(() => { void drafts.load(); }, [drafts]);
  const route = session ? { project_id: session.project_id, session_id: session.id } : null;
  const find = (intent: DetailIntent): DraftEntry | undefined => route ? drafts.find(route, itemId, intent) : undefined;
  // A submitted draft keeps its receipt; the next edit starts a fresh one.
  const open = (intent: DetailIntent): string | null => {
    if (!session) return null;
    const entry = find(intent);
    if (entry?.receipt) drafts.another(entry.draft.op_id, session);
    return find(intent)?.draft.op_id ?? drafts.begin(session, itemId, intent);
  };
  const ready = state.ready && current.status === 'ready' && !!session;
  const mine = Object.values(state.entries).filter(entry => route && entry.draft.session.project_id === route.project_id
    && entry.draft.session.session_id === route.session_id && entry.draft.target.item_id === itemId);
  const failed = mine.find(entry => entry.error);
  return {
    ready,
    text: intent => { const entry = find(intent); return entry && !entry.receipt ? entry.draft.text : ''; },
    locked: intent => { const entry = find(intent); return state.preferenceUncertain || (!!entry && (entry.saving || entry.uncertain)); },
    edit: (intent, text) => { if (!ready) return; const id = open(intent); if (id) drafts.edit(id, { text }); },
    send: async (intent, text) => {
      if (!ready) return false;
      const id = open(intent);
      if (!id) return false;
      const entry = drafts.getSnapshot().entries[id];
      if (text !== undefined && entry && !entry.uncertain && entry.draft.text !== text) drafts.edit(id, { text });
      return drafts.submit(id);
    },
    saving: (mine.find(entry => entry.saving)?.draft.intent as InputKind | undefined) ?? null,
    error: failed?.error?.message ?? state.error?.message ?? null,
  };
}
