import { useEffect, useRef, useState } from 'react';
import { CoreFailure, type RendererService } from '../../data/service';
import { immutable, useSession, type Immutable, type SessionStore } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';

// The opened SessionStore owns subscriptions and reconciliation. A component
// only loads pages for its revision, and cannot publish a superseded response.
export function useHistory<T>(service: RendererService, store: SessionStore, selection: string,
  load: (service: RendererService, route: SessionRef, revision: number, selection: string, signal: AbortSignal) => Promise<T>) {
  const session = useSession(store), revision = session.snapshot?.session.revision;
  const identity = JSON.stringify([session.route.project_id, session.route.session_id, selection]);
  const [state, setState] = useState<{ identity: string; data: Immutable<T> | null; revision: number | null; loading: boolean; error: string | null }>({
    identity, data: null, revision: null, loading: true, error: null,
  });
  const generation = useRef(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const call = ++generation.current;
    if (!selection) {
      setState({ identity, data: null, revision: null, loading: false, error: null });
      return;
    }
    if (!revision || session.status === 'closed') return;
    const controller = new AbortController();
    setState(previous => ({ identity, data: previous.identity === identity ? previous.data : null,
      revision: previous.identity === identity ? previous.revision : null, loading: true, error: null }));
    void load(service, session.route, revision, selection, controller.signal).then(data => {
      if (generation.current !== call || store.getSnapshot().status === 'closed'
          || store.getSnapshot().snapshot?.session.revision !== revision) return;
      setState({ identity, data: immutable(data), revision, loading: false, error: null });
    }).catch((error: unknown) => {
      if (generation.current !== call) return;
      setState(previous => ({ ...previous, loading: false,
        error: error instanceof Error ? error.message : 'The complete history could not be read.' }));
      if (error instanceof CoreFailure && error.error.code === 'snapshot_changed') void store.refresh();
    });
    return () => { controller.abort(); ++generation.current; };
  }, [service, store, identity, revision, selection, load, retry, session.status === 'closed']);
  return { ...state, data: state.identity === identity ? state.data : null, session,
    retry: () => { void store.refresh(); setRetry(value => value + 1); } };
}
