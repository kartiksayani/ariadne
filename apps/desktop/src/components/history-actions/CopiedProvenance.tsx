import { useState } from 'react';
import type { ItemRoute } from '../../generated/core';
import { useSession, type SessionStore } from '../../data';

/** The caller routes through RegisteredRoutes; copied local history is always retained. */
export function CopiedProvenance({ store, itemId, revealItem }: {
  store: SessionStore; itemId: string; revealItem: (route: ItemRoute) => Promise<unknown>;
}) {
  const state = useSession(store), origin = state.snapshot?.session.items[itemId]?.origin;
  const [unavailableSource, setUnavailableSource] = useState<{ identity: string; message: string } | null>(null);
  const [opening, setOpening] = useState(false);
  if (!origin) return null;
  const source = { project_id: origin.project_id, session_id: origin.session_id, item_id: origin.entity_id };
  const copied = { ...state.route, item_id: itemId };
  const identity = JSON.stringify(source);
  return <span className="copied-provenance">
    <button type="button" className="ref-button ref-secondary" disabled={opening} onClick={() => {
      setOpening(true); setUnavailableSource(null);
      void revealItem(source).catch((error: unknown) => setUnavailableSource({ identity,
        message: error instanceof Error ? error.message : 'The registered source could not be opened.' })).finally(() => setOpening(false));
    }}>Source item {source.item_id}</button>
    {unavailableSource?.identity === identity && <><span role="status">Original project is unavailable. {unavailableSource.message} Full copied history remains here.</span>
      <button type="button" className="ref-button ref-secondary" onClick={() => { void revealItem(copied).catch((error: unknown) => setUnavailableSource({ identity,
        message: error instanceof Error ? error.message : 'The copied item could not be opened.' })); }}>Open copied item {copied.item_id}</button></>}
  </span>;
}
