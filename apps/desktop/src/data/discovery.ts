import { useSyncExternalStore } from 'react';
import type { DesktopDiscoveryCandidate, DesktopDiscoverySnapshot } from '../generated/core';
import { validateDiscovery, type RendererService } from './service';

export const candidateIdentity = (candidate: DesktopDiscoveryCandidate): string => JSON.stringify([
  candidate.adapter_id, candidate.endpoint.kind,
  candidate.endpoint.kind === 'unix_socket' ? candidate.endpoint.path : candidate.endpoint.name,
  candidate.external_session_id,
]);
export interface DiscoveryState {
  readonly snapshot: DesktopDiscoverySnapshot | null;
  readonly error: string | null;
  readonly reading: boolean;
}
const empty: DiscoveryState = { snapshot: null, error: null, reading: false };
const errorMessage = 'Discovery could not refresh. Showing the last complete snapshot; manual entry remains available.';

/** One application lifetime, combined view visibility, and one read in flight. */
export class DiscoveryController {
  private state = empty;
  private listeners = new Set<() => void>();
  private consumers = new Set<symbol>();
  private activation: Promise<void> = Promise.resolve();
  private revision = 0;
  private opened = false;
  private activatedRevision = -1;
  private pendingActivations = 0;
  private disposed = false;
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly service: Pick<RendererService, 'discovery' | 'setConnectionUiOpen'>) {}
  getSnapshot = (): DiscoveryState => this.state;
  subscribe = (receive: () => void) => { this.listeners.add(receive); return () => { this.listeners.delete(receive); }; };
  private publish(change: Partial<DiscoveryState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach(receive => receive());
  }
  acquire(): () => void {
    if (this.disposed) return () => {};
    const token = Symbol(); this.consumers.add(token);
    if (this.consumers.size === 1) this.setOpen(true);
    return () => {
      if (!this.consumers.delete(token)) return;
      if (this.consumers.size === 0) this.setOpen(false);
    };
  }
  private setOpen(open: boolean) {
    const revision = ++this.revision;
    ++this.pendingActivations;
    if (this.timer) clearInterval(this.timer);
    this.timer = open ? setInterval(() => { void this.refresh(); }, 5000) : null;
    this.activation = this.activation.then(async () => {
      try {
        await this.service.setConnectionUiOpen(open);
        this.opened = open;
        this.activatedRevision = revision;
      } catch { if (!this.disposed) this.publish({ error: errorMessage }); }
      finally { --this.pendingActivations; }
      if (open && this.activatedRevision === revision && revision === this.revision && !this.disposed && this.consumers.size > 0) void this.refresh();
    });
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.consumers.size === 0 || this.inFlight || this.pendingActivations > 0) return;
    if (!this.opened || this.activatedRevision !== this.revision) { this.setOpen(true); return; }
    this.inFlight = true;
    const revision = this.revision;
    this.publish({ reading: true });
    try {
      const snapshot = await this.service.discovery();
      validateDiscovery(snapshot);
      if (!this.disposed && revision === this.revision && this.consumers.size > 0) {
        // A failed native provider scan cannot replace the last complete read.
        if (snapshot.error) this.publish({ error: errorMessage });
        else this.publish({ snapshot: structuredClone(snapshot), error: null });
      }
    } catch { if (!this.disposed && revision === this.revision) this.publish({ error: errorMessage }); }
    finally {
      this.inFlight = false;
      if (!this.disposed) this.publish({ reading: false });
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.consumers.clear(); this.setOpen(false); this.listeners.clear();
  }
}
const noSubscription = () => () => {};
const emptySnapshot = () => empty;
export function useDiscovery(controller?: DiscoveryController): DiscoveryState {
  return useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
}
