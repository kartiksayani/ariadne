// The desktop delivery supervisor's health per binding (runtime publishes it).
// One reader per renderer service: it reads the latest entries once, then
// follows `ariadne://supervisor_health`. Claude Code bindings are driven by the
// Mod and may have no entry; a missing entry means "unknown", never a warning.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { validHealth, type RendererService, type SupervisorHealth, type Unsubscribe } from '../../data/service';
import { retryIn } from './dispatch';

type Entries = Readonly<Record<string, SupervisorHealth>>;

export class SupervisorHealthStore {
  private entries: Entries = Object.freeze({});
  private readonly listeners = new Set<() => void>();
  private started: Promise<void> | null = null;
  private unsubscribe: Unsubscribe | null = null;
  constructor(private readonly service: RendererService) {}
  readonly getSnapshot = (): Entries => this.entries;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private receive = (entry: SupervisorHealth) => {
    if (!validHealth(entry)) return;
    const previous = this.entries[entry.binding_id];
    // A newer generation replaces an older one; an older update never overwrites a newer one.
    if (previous && previous.generation === entry.generation && Date.parse(previous.updated_at) > Date.parse(entry.updated_at)) return;
    // The runtime forgets an entry by sending it as plain 'running' (no reason, no retry). It replaces
    // that generation's entry, which then reads healthy and still turns away older updates; a forget
    // for another generation is not about the entry held and leaves it alone.
    const forget = entry.state === 'running' && entry.reason === null && entry.retry_in_seconds === null;
    if (forget && previous && previous.generation !== entry.generation) return;
    this.entries = Object.freeze({ ...this.entries, [entry.binding_id]: Object.freeze({ ...entry }) });
    this.listeners.forEach(listener => listener());
  };
  start(): Promise<void> {
    if (this.started) return this.started;
    const token = this.token = {};
    this.started = (async () => {
      try {
        const unsubscribe = await this.service.subscribe('ariadne://supervisor_health', this.receive);
        // Stopped while subscribing: release at once.
        if (this.token === token) this.unsubscribe = unsubscribe; else unsubscribe();
      } catch { /* Health stays unknown. */ }
      try { if (this.token === token) (await this.service.supervisorHealth?.() ?? []).forEach(this.receive); } catch { /* Health stays unknown. */ }
    })();
    return this.started;
  }
  private token: object | null = null;
  stop(): void { this.unsubscribe?.(); this.unsubscribe = null; this.started = null; this.token = null; }
  /** Follows health while at least one view reads it; the last release stops listening. */
  retain(): () => void {
    this.users += 1; void this.start();
    let released = false;
    return () => { if (released) return; released = true; if (--this.users === 0) this.stop(); };
  }
  private users = 0;
  /** The binding generation's entry; an entry of another generation is not this binding's health. */
  of(bindingId: string | null | undefined, generation: string | null | undefined): SupervisorHealth | null {
    const entry = bindingId ? this.entries[bindingId] : undefined;
    return entry && entry.generation === generation ? entry : null;
  }
}

const stores = new WeakMap<RendererService, SupervisorHealthStore>();
export function healthStore(service: RendererService): SupervisorHealthStore {
  let store = stores.get(service);
  if (!store) { store = new SupervisorHealthStore(service); stores.set(service, store); }
  return store;
}

/** Re-renders once a second while any of `entries` counts down to a retry, so "retrying in Ns" stays current. */
function useCountdown(entries: readonly (SupervisorHealth | null | undefined)[]): void {
  const [, tick] = useState(0);
  const counting = entries.some(entry => (retryIn(entry, Date.now()) ?? 0) > 0);
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [counting]);
}

/** The supervisor health of one binding generation, or null when unknown. */
export function useSupervisorHealth(service: RendererService | null | undefined, bindingId: string | null | undefined, generation: string | null | undefined): SupervisorHealth | null {
  const store = service ? healthStore(service) : null;
  useEffect(() => store?.retain(), [store]);
  useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? empty, store?.getSnapshot ?? empty);
  const health = store?.of(bindingId, generation) ?? null;
  useCountdown([health]);
  return health;
}

export type HealthLookup = (bindingId: string | null | undefined, generation: string | null | undefined) => SupervisorHealth | null;
/** Supervisor health for any binding generation (views spanning sessions); null when unknown. */
export function useSupervisorHealthLookup(service: RendererService | null | undefined): HealthLookup {
  const store = service ? healthStore(service) : null;
  useEffect(() => store?.retain(), [store]);
  const entries = useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? empty, store?.getSnapshot ?? empty);
  useCountdown(Object.values(entries));
  return useCallback<HealthLookup>((bindingId, generation) => store?.of(bindingId, generation) ?? null, [store, entries]);
}
const noop = () => () => {};
const none: Entries = Object.freeze({});
const empty = () => none;
