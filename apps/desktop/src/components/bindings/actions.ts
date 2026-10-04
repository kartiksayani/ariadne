import { useSyncExternalStore } from 'react';
import type { MutationReceipt, OwnerCommand, OwnerMutationRequest, SessionRef } from '../../generated/core';
import { CoreFailure, immutable, ServiceFailure, type Immutable, type RendererService, type SessionStore } from '../../data';

interface ActionState {
  readonly writing: boolean;
  readonly pending: Immutable<OwnerMutationRequest> | null;
  readonly error: CoreFailure | ServiceFailure | null;
  readonly receipt: Immutable<MutationReceipt> | null;
}
function definitiveRejection(failure: CoreFailure | ServiceFailure, command: OwnerCommand): boolean {
  if (!(failure instanceof CoreFailure)) return false;
  // Verified replay-first transaction guards in recovery/mod.rs and
  // bindings/mod.rs reject before publication. Recovery's delivery_uncertain
  // denotes missing idle attestation or ineligible retry before mutation.
  // Generic routing/store/host failures can precede replay of an earlier save;
  // their error codes cannot establish that the original operation was unsaved.
  const lifecycle = command.command === 'binding_pause' || command.command === 'binding_resume' || command.command === 'binding_disconnect';
  return (lifecycle || command.command === 'input_resolve')
      && ['revision_conflict', 'binding_mismatch', 'invalid_transition'].includes(failure.error.code)
    || command.command === 'input_resolve' && failure.error.code === 'delivery_uncertain'
    || lifecycle && failure.error.code === 'stale_generation';
}
/** One controller per opened session; lifecycle and recovery share its write barrier. */
export class SessionActions {
  private state: ActionState = Object.freeze({ writing: false, pending: null, error: null, receipt: null });
  private readonly listeners = new Set<() => void>();
  private currentSession: SessionStore;
  private readonly route: Immutable<SessionRef>;
  constructor(readonly service: RendererService, session: SessionStore,
    private readonly operationId: () => string = () => crypto.randomUUID()) {
    this.currentSession = session;
    this.route = immutable(session.getSnapshot().route);
  }
  get session(): SessionStore { return this.currentSession; }
  /** Reopening a tab replaces its reader, never its pending operation. */
  attachSession(session: SessionStore): void {
    const route = session.getSnapshot().route;
    if (route.project_id !== this.route.project_id || route.session_id !== this.route.session_id) {
      throw new Error('A session action controller cannot change its registered route.');
    }
    this.currentSession = session;
  }
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ActionState>) {
    this.state = Object.freeze({ ...this.state, ...update });
    this.listeners.forEach(listener => listener());
  }
  async execute(command: OwnerCommand, reviewedRevision: number): Promise<boolean> {
    const current = this.session.getSnapshot();
    if (this.state.writing || this.state.pending || current.status !== 'ready' || current.error
        || current.snapshot?.session.revision !== reviewedRevision) return false;
    this.publish({ pending: immutable({ session: this.route, command: { ...command, op_id: this.operationId() } }), receipt: null, error: null });
    return this.retry();
  }
  async retry(): Promise<boolean> {
    if (this.state.writing || !this.state.pending) return false;
    const request = structuredClone(this.state.pending) as OwnerMutationRequest;
    this.publish({ writing: true, error: null });
    try {
      const receipt = await this.service.executeOwner(request);
      if (!('data' in receipt) || receipt.session_id !== request.session?.session_id
          || receipt.operation_id !== request.command.op_id || !Number.isSafeInteger(receipt.revision) || receipt.revision <= 0) {
        throw new ServiceFailure('invalid_response');
      }
      const command = request.command, data = receipt.data;
      const matches = command.command === 'binding_connect' ? data.kind === 'binding_connect'
        : command.command === 'input_resolve' ? data.kind === 'input_resolve' && data.input_id === command.params.input_id
          && data.attempt_id === command.params.attempt_id && data.resolution_kind === command.params.decision
        : (command.command === 'binding_pause' || command.command === 'binding_resume' || command.command === 'binding_disconnect')
          && data.kind === 'binding_state'
          && data.binding_id === command.params.binding_id && data.generation === command.params.expected_generation;
      if (!matches) throw new ServiceFailure('invalid_response');
      this.publish({ pending: null, receipt: immutable(receipt) });
      await this.session.refresh();
      return true;
    } catch (error: unknown) {
      const failure = error instanceof CoreFailure || error instanceof ServiceFailure ? error : new ServiceFailure('transport');
      // A transport failure or ambiguous commit can have persisted. Keep every
      // byte, including attestation time and revision, for exact receipt replay.
      const rejected = definitiveRejection(failure, request.command);
      this.publish({ error: failure, ...(rejected ? { pending: null } : {}) });
      if (rejected) await this.session.refresh();
      return false;
    } finally { this.publish({ writing: false }); }
  }
}
/** Owned by the application, independently of mounted views or open tabs. */
export class SessionActionControllers {
  private readonly controllers = new Map<string, SessionActions>();
  constructor(private readonly service: RendererService, private readonly operationId: () => string = () => crypto.randomUUID()) {}
  forSession(session: SessionStore): SessionActions {
    const route = session.getSnapshot().route;
    const key = JSON.stringify([route.project_id, route.session_id]);
    let actions = this.controllers.get(key);
    if (!actions) {
      actions = new SessionActions(this.service, session, this.operationId);
      this.controllers.set(key, actions);
    } else actions.attachSession(session);
    return actions;
  }
}
export function useSessionActions(actions: SessionActions) {
  return useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
}
