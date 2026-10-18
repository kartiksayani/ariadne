// A notice for words the owner left unsent before Ariadne restarted (alpha.21 E18, SPEC 11.2). Only drafts that were definitely
// never sent count (the store marks them `origin: 'recovered'`); a draft with a send attempt keeps its exact-operation recovery.
// The notice fires once, the first time after start that the draft's session is the one on screen. The words themselves are
// already in Details' composer; the notice only says so ("Nothing was sent") and offers "Show it". It goes when the owner edits
// or sends the words.
import { useEffect, useRef } from 'react';
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { itemRemoved } from '../../selectors/removed';
import { quoted } from '../../selectors/waiting/stuck';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { notices } from '../pages/notices';
import type { OpenTopicInDetails } from '../shell/detailTarget';
import { sentNoun } from './noticeText';

export interface RecoveredNoticesOptions {
  /** The session on screen; null when none is. */
  readonly session: Immutable<Session> | null;
  readonly drafts: OwnerDraftStore;
  /** Opens Details on the item. */
  readonly openItem: (itemId: string) => void;
  /** Opens Details in topic mode. */
  readonly openTopic: OpenTopicInDetails;
}

export function useRecoveredNotices({ session, drafts, openItem, openTopic }: RecoveredNoticesOptions): void {
  const state = useOwnerDrafts(drafts);
  const told = useRef(new Set<string>());
  const published = useRef(new Map<string, string>());
  const open = useRef({ openItem, openTopic });
  open.current = { openItem, openTopic };

  useEffect(() => {
    const live = new Set<string>();
    if (session && state.ready) for (const entry of Object.values(state.entries)) {
      const { draft } = entry;
      if (entry.origin !== 'recovered' || draft.session.project_id !== session.project_id || draft.session.session_id !== session.id) continue;
      live.add(draft.op_id);
      if (told.current.has(draft.op_id)) continue;
      const itemId = draft.target.item_id, item = itemId ? session.items[itemId] : undefined;
      const name = itemId ? item && !itemRemoved(session, item.id) ? item.question : undefined : session.topics[draft.target.topic_id]?.name;
      if (!name) continue;
      told.current.add(draft.op_id);
      const id = `recovered:${draft.op_id}`;
      published.current.set(draft.op_id, id);
      notices.push({ id, icon: 'ph ph-arrow-counter-clockwise', tone: 'neutral',
        text: `Ariadne restarted. Your unsent ${sentNoun(draft.intent)} ${quoted(name)} is back in Details’ composer, as you left it. Nothing was sent.`,
        actions: [{ label: 'Show it', run: () => { if (itemId) open.current.openItem(itemId); else open.current.openTopic(draft.target.topic_id); } }] });
    }
    for (const [opId, id] of [...published.current]) if (!live.has(opId)) { notices.dismiss(id); published.current.delete(opId); }
  }, [session, state]);

  useEffect(() => {
    const ids = published.current;
    return () => { for (const id of ids.values()) notices.dismiss(id); ids.clear(); };
  }, []);
}
