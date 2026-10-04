import type { ItemRoute, OpenRoute } from '../generated/core';
import { OpenSessions, type SessionStore } from './session-store';
import { revealAncestors } from './selectors';
import { CoreFailure, ServiceFailure, type RendererService, type Unsubscribe } from './service';

interface ItemReveal {
  readonly kind: 'item';
  readonly route: ItemRoute;
  readonly store: SessionStore;
  readonly temporaryExpandedItemIds: readonly string[];
}
interface MissingItemReveal {
  readonly kind: 'missing_item';
  readonly session: Pick<ItemRoute, 'project_id' | 'session_id'>;
  readonly requestedItemId: ItemRoute['item_id'];
  readonly store: SessionStore;
  readonly banner: string;
}
export type RevealedItem = ItemReveal | MissingItemReveal;
export class RegisteredRoutes {
  private request = 0;
  constructor(private readonly service: RendererService, private readonly sessions: OpenSessions) {}
  async revealItem(route: ItemRoute): Promise<RevealedItem | null> {
    const request = ++this.request;
    const session = { project_id: route.project_id, session_id: route.session_id };
    let registered: ItemRoute | null = null;
    let missingBanner: string | null = null;
    try {
      registered = await this.service.query({ session, request: { command: 'reveal_item', params: { item_id: route.item_id } } });
    } catch (error: unknown) {
      if (request !== this.request) return null;
      if (!(error instanceof CoreFailure) || error.error.code !== 'not_found') throw error;
      missingBanner = error.message;
    }
    if (request !== this.request) return null;
    if (registered && (registered.project_id !== route.project_id || registered.session_id !== route.session_id || registered.item_id !== route.item_id)) {
      throw new ServiceFailure('invalid_response');
    }
    const store = this.sessions.open(session);
    await store.refresh();
    if (request !== this.request) return null;
    const state = store.getSnapshot();
    if (state.error) throw state.error;
    if (!state.snapshot || state.status === 'closed') throw new ServiceFailure('invalid_response');
    if (!registered || !state.snapshot.session.items[registered.item_id]) {
      return Object.freeze({ kind: 'missing_item', session: Object.freeze(session), requestedItemId: route.item_id, store,
        banner: missingBanner ?? 'The item is no longer available in this session.' });
    }
    return Object.freeze({ kind: 'item', route: Object.freeze({ ...registered }), store,
      temporaryExpandedItemIds: revealAncestors(state.snapshot.session, registered) });
  }
  async subscribe(receive: (route: OpenRoute, reveal: RevealedItem | null) => void,
    failed: (error: CoreFailure | ServiceFailure) => void): Promise<Unsubscribe> {
    let closed = false;
    const unsubscribe = await this.service.subscribe('ariadne://route', (route) => {
      if (closed) return;
      if (route.item_id === null) {
        ++this.request;
        this.sessions.open({ project_id: route.project_id, session_id: route.session_id });
        receive(route, null);
      } else {
        void this.revealItem({ ...route, item_id: route.item_id }).then((reveal) => {
          if (!closed && reveal) receive(route, reveal);
        }).catch((error: unknown) => {
          if (!closed) failed(error instanceof CoreFailure || error instanceof ServiceFailure ? error : new ServiceFailure('invalid_response'));
        });
      }
    });
    return () => { closed = true; ++this.request; unsubscribe(); };
  }
}
