import { useState } from 'react';
import type { ItemRoute } from '../../generated/core';
import { originalFailure, plainFailure, useSession, type SessionStore } from '../../data';
import { shortLabel } from '../../ui/shared/short';

/** The caller routes through RegisteredRoutes; copied local history is always retained. */
export function CopiedProvenance({ store, itemId, revealItem, projectPath = () => null }: {
  store: SessionStore; itemId: string; revealItem: (route: ItemRoute) => Promise<unknown>;
  /** The folder of a registered project, to name it when it can't be opened. */
  projectPath?: (projectId: string) => string | null;
}) {
  const state = useSession(store), item = state.snapshot?.session.items[itemId], origin = item?.origin;
  const [unavailableSource, setUnavailableSource] = useState<{ identity: string; message: string } | null>(null);
  const [opening, setOpening] = useState(false);
  if (!item || !origin) return null;
  const source = { project_id: origin.project_id, session_id: origin.session_id, item_id: origin.entity_id };
  const copied = { ...state.route, item_id: itemId };
  const identity = JSON.stringify(source);
  return <span className="copied-provenance">
    <button type="button" className="btn btn-secondary" disabled={opening} onClick={() => {
      setOpening(true); setUnavailableSource(null);
      void revealItem(source).catch((error: unknown) => setUnavailableSource({ identity,
        message: originalFailure(error, projectPath(source.project_id)) ?? `Original project is unavailable. ${plainFailure(error, 'The original item could not be opened.')}` }))
        .finally(() => setOpening(false));
    }}>Source item</button>
    {unavailableSource?.identity === identity && <><span role="status">{unavailableSource.message} Full copied history remains here.</span>
      <button type="button" className="btn btn-secondary" onClick={() => { void revealItem(copied).catch((error: unknown) => setUnavailableSource({ identity,
        message: `Original project is unavailable. ${plainFailure(error, 'The copied item could not be opened.')}` })); }}>Open copied item: {shortLabel(item)}</button></>}
  </span>;
}
