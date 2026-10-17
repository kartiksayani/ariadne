// Which long item questions and previews the owner has unfolded ("Show more"). Kept in memory for
// the running app, per item, so a row that is folded away, filtered out or re-created
// comes back as the owner left it. One flag per item opens its question and its details together.
import { useCallback, useState } from 'react';

const unfolded = new Set<string>();

export function useUnfolded(project: string, session: string) {
  const [, rerender] = useState(0);
  const key = (id: string) => `${project}/${session}/${id}`;
  const toggle = useCallback((id: string) => {
    const full = `${project}/${session}/${id}`;
    if (unfolded.has(full)) unfolded.delete(full); else unfolded.add(full);
    rerender(count => count + 1);
  }, [project, session]);
  /** Unfolds an item without toggling it: a search step that lands on a folded row shows its words. */
  const open = useCallback((id: string) => {
    const full = `${project}/${session}/${id}`;
    if (unfolded.has(full)) return;
    unfolded.add(full);
    rerender(count => count + 1);
  }, [project, session]);
  return { isUnfolded: (id: string) => unfolded.has(key(id)), toggle, open };
}
