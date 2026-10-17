// One owner for a session's lifecycle (C3) per screen. The review dialog, the running guard and the Undo state live
// once, in the workspace; the top bar's connection card, the Map and a page row read that one instance.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SessionActions } from '../../components/bindings/actions';
import { useSessionLifecycle, type SessionLifecycle } from './useSessionLifecycle';

interface Owned { readonly actions: SessionActions; readonly lifecycle: SessionLifecycle }
const Owner = createContext<Owned | null>(null);

/**
 * Mounts the lifecycle of `actions`' session (null: no session) and renders its dialog after `children`. It keeps
 * the same element whether or not a session is shown, so switching never remounts what it wraps.
 */
export function SessionLifecycleOwner({ actions, children }: { readonly actions: SessionActions | null; readonly children: ReactNode }) {
  const lifecycle = useSessionLifecycle(actions);
  const owned = useMemo(() => actions ? { actions, lifecycle } : null, [actions, lifecycle]);
  return <Owner.Provider value={owned}>{children}{lifecycle.dialog}</Owner.Provider>;
}

/**
 * The lifecycle of `actions`' session: the owner's instance when one owns this session (its dialog then renders at
 * the owner, so `dialog` here is null), else an instance of its own, for a view mounted outside the workspace.
 */
export function useSessionLifecycleFor(actions: SessionActions | null): SessionLifecycle {
  const owned = useContext(Owner);
  const shared = owned && actions && owned.actions === actions ? owned.lifecycle : null;
  const own = useSessionLifecycle(shared ? null : actions);
  return useMemo(() => shared ? { ...shared, dialog: null } : own, [shared, own]);
}
