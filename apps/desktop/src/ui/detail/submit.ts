// The detail panel's submit seam. It wraps the owner draft store so the panel
// never touches drafts directly; WP2's ui/answer/useSubmit.ts can replace this
// hook without changing ItemDetail.
//
// The owner's words (a reply, a note or a follow-up) are bound to the draft they were typed in: the panel edits that
// draft in place, whatever the item's status does meanwhile, and nothing is ever copied from one draft to another. What
// the words go out as follows the status when they are sent (`send`'s `as`); the draft keeps its own revisions, so an
// item that changed since still asks for a review first.
import { useEffect, useRef, useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { plainFailure } from '../../data/plain';
import type { InputKind } from '../../generated/domain/models';
import { useOwnerDrafts, type DraftEntry, type OwnerDraftStore, type OwnerIntent } from '../../state/drafts/store';
import type { WordsKind } from './model';

export type DetailIntent = Exclude<OwnerIntent, 'answer' | 'bring'>;
const WORDS: ReadonlySet<string> = new Set<WordsKind>(['reply', 'note', 'followup']);
const loadingError = "Ariadne is still loading this session's latest changes. Try again.";

/** One of the item's drafts of the owner's words, as the dock shows it. */
export interface Words {
  /** The draft's own id; null for the empty box before anything is typed. */
  readonly id: string | null;
  /** The box the words were written in. */
  readonly kind: WordsKind;
  readonly text: string;
  /** The draft is locked while it is saving or awaits a retry. */
  readonly locked: boolean;
  /** The item or its binding changed since the draft was written; it must be reviewed before sending. */
  readonly changed: boolean;
}
/** An intent's own draft, or one specific draft of the owner's words. */
export type DraftTarget = DetailIntent | Words;

export interface DetailSubmit {
  /** Drafts are loaded and the session is ready, so edits and sends can start. */
  readonly ready: boolean;
  /** The draft is locked while its operation is saving or awaits a retry. */
  readonly locked: (target: DraftTarget) => boolean;
  readonly edit: (target: DraftTarget, text: string) => void;
  /** The item or its binding changed since the saved draft was written; it must be reviewed before sending. */
  readonly changed: (target: DraftTarget) => boolean;
  /** Re-bases the saved draft on the current item revision and binding, keeping its text. */
  readonly review: (target: DraftTarget) => void;
  /**
   * Saves the text into the draft and submits it; resolves true once the core accepted it. `as` is the kind the owner's words
   * go out as (default: the draft's own); the draft is saved with that kind in the same save that marks it sent.
   */
  readonly send: (target: DraftTarget, text?: string, as?: DetailIntent) => Promise<boolean>;
  /** Every unsent draft of this item that holds words, oldest first: none is ever hidden. */
  readonly written: readonly Words[];
  /** The empty box for one kind, used while no draft holds words. */
  readonly blank: (kind: WordsKind) => Words;
  /** The kind of an owner input for this item being saved right now. */
  readonly saving: InputKind | null;
  /** The latest failure for this item's drafts, as a sentence. */
  readonly error: string | null;
}

export function useDetailSubmit(drafts: OwnerDraftStore, store: SessionStore, itemId: string): DetailSubmit {
  const state = useOwnerDrafts(drafts), current = useSession(store), session = current.snapshot?.session;
  const [sendError, setSendError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const request = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => { void drafts.load(); }, [drafts]);
  useEffect(() => {
    setSendError(null);
    setReopening(false);
    return () => { if (request.current) request.current.cancelled = true; request.current = null; };
  }, [drafts, store, itemId]);
  useEffect(() => {
    if (current.status === 'ready' && !current.error) setSendError(error => error === loadingError ? null : error);
  }, [current.status, current.error]);
  const route = session ? { project_id: session.project_id, session_id: session.id } : null;
  const find = (intent: DetailIntent): DraftEntry | undefined => route ? drafts.find(route, itemId, intent) : undefined;
  const intentOf = (target: DraftTarget): DetailIntent => typeof target === 'string' ? target : target.kind;
  // A specific draft of words is found by its id, so two drafts of one kind never stand in for each other.
  const entryOf = (target: DraftTarget): DraftEntry | undefined => typeof target !== 'string' && target.id ? state.entries[target.id] : find(intentOf(target));
  // A submitted draft keeps its receipt; the next edit starts a fresh one.
  const open = (target: DraftTarget): string | null => {
    if (!session) return null;
    const entry = entryOf(target);
    if (entry && !entry.receipt) return entry.draft.op_id;
    if (entry) drafts.another(entry.draft.op_id, session);
    return find(intentOf(target))?.draft.op_id ?? drafts.begin(session, itemId, intentOf(target));
  };
  // A saved, unsent draft written against an older item revision or binding. An attempted
  // (uncertain) draft stays frozen for an exact retry instead.
  const changedEntry = (entry: DraftEntry | undefined, currentSession = session): boolean => {
    const item = currentSession?.items[itemId];
    if (!currentSession || !item || !entry || entry.receipt || entry.saving || entry.uncertain) return false;
    // An untouched draft holds no owner content: it follows the current item and binding on send.
    if (!entry.draft.text && entry.draft.selected_option_id === null) return false;
    return item.revision !== entry.draft.target_revision || item.question_revision !== entry.draft.question_revision
      || currentSession.active_binding_id !== entry.draft.binding_id;
  };
  const lockedEntry = (entry: DraftEntry | undefined) => !state.ready || state.preferenceUncertain || (!!entry && (entry.saving || entry.uncertain));
  const changed = (target: DraftTarget) => changedEntry(entryOf(target));
  const review = (target: DraftTarget) => { const entry = entryOf(target); if (session && entry) { setSendError(null); drafts.review(entry.draft.op_id, session); } };
  const ready = state.ready && current.status === 'ready' && !current.error && !!session;
  const mine = Object.values(state.entries).filter(entry => route && entry.draft.session.project_id === route.project_id
    && entry.draft.session.session_id === route.session_id && entry.draft.target.item_id === itemId);
  const failed = mine.find(entry => entry.draft.intent !== 'answer' && entry.error);
  const written = mine.filter(entry => !entry.receipt && WORDS.has(entry.draft.intent) && entry.draft.text.trim())
    .map((entry): Words => ({ id: entry.draft.op_id, kind: entry.draft.intent as WordsKind, text: entry.draft.text, locked: lockedEntry(entry), changed: changedEntry(entry) }));
  return {
    ready,
    locked: target => target === 'reopen' && reopening || lockedEntry(entryOf(target)),
    // Typing needs only the loaded drafts and a snapshot: a refresh in progress (status 'stale') must not swallow the owner's
    // words. Sending still waits for `ready`, and a draft written against an older snapshot is reviewed before it goes.
    edit: (target, text) => { if (!state.ready || !session) return; const id = open(target); if (id) drafts.edit(id, { text }); },
    changed, review,
    send: async (target, text, as) => {
      // Reopen is a one-press request. Keep that intent across an in-flight refresh,
      // but never replay it after navigation, a timeout or a changed target.
      const attempt = target === 'reopen' ? { cancelled: false } : null;
      if (attempt && request.current && !request.current.cancelled) return false;
      if (attempt) { request.current = attempt; setReopening(true); }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        setSendError(null);
        if (attempt && (store.getSnapshot().status !== 'ready' || store.getSnapshot().error)) {
          await Promise.race([
            store.refresh(true),
            new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
          ]);
          if (attempt.cancelled) return false;
        }
        const latest = store.getSnapshot();
        const sendingSession = latest.snapshot?.session;
        if (!drafts.getSnapshot().ready || !sendingSession || latest.status !== 'ready' || latest.error
            || (!attempt && sendingSession !== session)) {
          setSendError(loadingError);
          return false;
        }
        if (attempt && (sendingSession.items[itemId]?.question !== session?.items[itemId]?.question
            || sendingSession.items[itemId]?.status !== session?.items[itemId]?.status
            || sendingSession.items[itemId]?.outcome !== session?.items[itemId]?.outcome
            || sendingSession.items[itemId]?.why !== session?.items[itemId]?.why
            || sendingSession.active_binding_id !== session?.active_binding_id)) {
          setSendError('This item changed. Review it before sending. Your text is kept.');
          return false;
        }
        const stored = typeof target !== 'string' && target.id ? drafts.getSnapshot().entries[target.id]
          : drafts.find(latest.route, itemId, intentOf(target));
        // A stale draft with owner content waits for a review; an empty one follows the current item and binding.
        if (changedEntry(stored, sendingSession)) { setSendError('This item changed. Review it before sending. Your text is kept.'); return false; }
        if (drafts.getSnapshot().preferenceUncertain || stored?.saving || stored?.uncertain) { setSendError('This message is being saved or needs a retry. Your text is kept.'); return false; }
        const item = sendingSession.items[itemId];
        if (item && stored && !stored.receipt && (item.revision !== stored.draft.target_revision
          || item.question_revision !== stored.draft.question_revision || sendingSession.active_binding_id !== stored.draft.binding_id)) drafts.review(stored.draft.op_id, sendingSession);
        if (stored?.receipt) drafts.another(stored.draft.op_id, sendingSession);
        const id = drafts.find(latest.route, itemId, intentOf(target))?.draft.op_id ?? drafts.begin(sendingSession, itemId, intentOf(target));
        // A specific words draft must keep its identity even if a newer one exists.
        const sendingId = typeof target !== 'string' && target.id && !stored?.receipt ? target.id : id;
        if (!sendingId) { setSendError('This action is no longer available for the current item.'); return false; }
        const entry = drafts.getSnapshot().entries[sendingId];
        if (text !== undefined && entry && !entry.uncertain && entry.draft.text !== text) drafts.edit(sendingId, { text });
        const sent = await drafts.submit(sendingId, as);
        if (attempt?.cancelled) return false;
        if (!sent && !drafts.getSnapshot().entries[sendingId]?.error && !drafts.getSnapshot().error) {
          setSendError('This message could not be saved. Try again.');
        }
        return sent;
      } catch (error: unknown) {
        if (!attempt?.cancelled) setSendError(plainFailure(error, 'This message could not be saved. Try again.'));
        return false;
      } finally {
        clearTimeout(timeout);
        if (attempt && request.current === attempt) { request.current = null; setReopening(false); }
      }
    },
    written,
    blank: kind => {
      const entry = find(kind), live = entry && !entry.receipt ? entry : undefined;
      return { id: live?.draft.op_id ?? null, kind, text: live?.draft.text ?? '', locked: lockedEntry(entry), changed: changedEntry(live) };
    },
    saving: (mine.find(entry => entry.saving)?.draft.intent as InputKind | undefined) ?? null,
    error: sendError ?? (failed?.error ? plainFailure(failed.error) : state.error ? plainFailure(state.error) : null),
  };
}
