import { useState } from 'react';
import { useSession, type SessionStore } from '../../data/session-store';
import { itemRemoved } from '../../selectors/removed';
import { displayStatus } from '../../selectors/waiting/replied';
import { ItemReference, ItemRefs } from '../shared/MarkdownText';
import { ItemRefSession } from '../peek/context';
import { peekNames } from '../peek/names';
import { detailPath } from './model';

/** Where a long path folds: the first and second levels and the last stay, the rest hide behind "…" (SPEC 5.3). */
export const PATH_LEVELS = 3;

/** The slots of a path of `count` levels: every index, or the first two, a fold and the last. */
export function pathSlots(count: number, expanded: boolean): readonly (number | 'fold')[] {
  const all = Array.from({ length: count }, (_value, index) => index);
  return count <= PATH_LEVELS || expanded ? all : [0, 1, 'fold', count - 1];
}

/**
 * The head's breadcrumb: the topic, then each ancestor. More than three levels fold to the first, the second, "…" and the
 * last; "…" shows the full path. The topic segment scrolls the Map to its top; in topic mode the path is the topic alone.
 */
export function DetailPath({ store, itemId, topicId, onOpenItem, onTopic }: {
  readonly store: SessionStore;
  readonly itemId?: string;
  readonly topicId?: string;
  readonly onOpenItem: (itemId: string) => void;
  readonly onTopic?: () => void;
}) {
  const session = useSession(store).snapshot?.session;
  const [open, setOpen] = useState<string | null>(null);
  const item = itemId ? session?.items[itemId] : undefined;
  const topic = topicId ?? item?.topic_id;
  const path = session && itemId ? detailPath(session, itemId) : topic && session?.topics[topic] ? [{ label: session.topics[topic]!.name, itemId: null }] : [];
  const labels = session ? peekNames(session) : new Map<string, string>();
  const topicName = topic ? session?.topics[topic]?.name : undefined;
  const slots = pathSlots(path.length, open === itemId + '\0' + topic);
  return <ItemRefSession.Provider value={session ? { project_id: session.project_id, session_id: session.id } : null}><ItemRefs.Provider value={{
    lookup: id => { const target = session?.items[id]; return session && target && !itemRemoved(session, id) ? { label: target.question, status: displayStatus(session, target) } : null; },
    route: id => ({ project_id: session!.project_id, session_id: session!.id, item_id: id }), onOpenItem,
  }}><nav className="detail-path" aria-label="Item location">
    {slots.map((slot, position) => {
      const separator = position < slots.length - 1 && <i className="ph ph-caret-right" aria-hidden="true" />;
      if (slot === 'fold') return <span className="detail-crumb" key="fold">
        <button type="button" title="Show the full path" aria-label="Show the full path" onClick={() => setOpen(itemId + '\0' + topic)}>…</button>{separator}</span>;
      const crumb = path[slot]!;
      const full = crumb.itemId ? session?.items[crumb.itemId]?.question : topicName;
      return <span className="detail-crumb" key={crumb.itemId ?? 'topic'}>
        {crumb.itemId !== null ? <ItemReference itemId={crumb.itemId} title={full} ariaLabel={full} inline preserveContent>{labels.get(crumb.itemId)}</ItemReference>
          : <button type="button" title={full} aria-label={full} onClick={onTopic}>{crumb.label}</button>}
        {separator}
      </span>;
    })}
  </nav></ItemRefs.Provider></ItemRefSession.Provider>;
}
