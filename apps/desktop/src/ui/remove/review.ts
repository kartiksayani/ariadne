// What the owner reviews before an item or topic removal (E27, E28), and what the commit compares with a fresh read.
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { DraftState } from '../../state/drafts/store';
import type { RemoveTarget } from '../dialogs/remove';
import { togetherRows, type RemoveReview } from '../dialogs/RemoveDialog';
import { removeSubject } from './model';
import { itemScope, topicScope, wordsInScope } from './words';

type Placed = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;

/** The review of `target` in `session`: its subject, what goes together, the words that go, and the pinned scope; null when gone. */
export function removeReview(session: Immutable<Session>, target: Placed, drafts: Pick<DraftState, 'entries'>): RemoveReview | null {
  const subject = removeSubject(session, target);
  if (!subject || subject.kind !== 'item' && subject.kind !== 'topic') return null;
  const scope = target.kind === 'item' ? itemScope(session, target.item.item_id) : topicScope(target.topic_id);
  const words = wordsInScope(session, drafts, scope);
  const ids = target.kind === 'item' ? [...scope.items]
    : [target.topic_id, ...Object.values(session.items).flatMap(item => item?.topic_id === target.topic_id ? [item.id] : [])];
  return { target, subject, together: target.kind === 'item' ? togetherRows(session, target.item.item_id) : [], words,
    pinned: { scope: ids, words: words.map(entry => entry.key) } };
}

interface DraftsSource { readonly getSnapshot: () => Pick<DraftState, 'entries'>; readonly subscribe: (listener: () => void) => () => void }
const saving = (state: Pick<DraftState, 'entries'>, route: SessionRef) => Object.values(state.entries).some(entry => !!entry?.saving
  && entry.draft.session.project_id === route.project_id && entry.draft.session.session_id === route.session_id);

/**
 * Resolves once no owner send is being saved in `route` (the shared submit lock: a draft saving), or after `ms` as a
 * backstop; the recheck after it still sees any input a late save makes.
 */
export function draftsSettled(drafts: DraftsSource, route: SessionRef, ms = 30_000): Promise<void> {
  if (!saving(drafts.getSnapshot(), route)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); stop(); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = drafts.subscribe(() => { if (!saving(drafts.getSnapshot(), route)) done(); });
  });
}
