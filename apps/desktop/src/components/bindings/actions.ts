import { useSyncExternalStore } from 'react';
import type { MutationReceipt, OwnerCommand, OwnerMutationRequest } from '../../generated/core';
import { CoreFailure, immutable, ServiceFailure, type Immutable, type RendererService, type SessionStore } from '../../data';

interface ActionState {
  readonly writing: boolean;
  readonly pending: Immutable<OwnerMutationRequest> | null;
  readonly error: CoreFailure | ServiceFailure | null;
  readonly receipt: Immutable<MutationReceipt> | null;
}
/** One controller per opened session; lifecycle and recovery share its write barrier. */
export class SessionActions {
  private state: ActionState = Object.freeze({ writing: false, pending: null, error: null, receipt: null });
  private readonly listeners = new Set<() => void>();
  constructor(readonly service: RendererService, readonly session: SessionStore,
    private readonly operationId: () => string = () => crypto.randomUUID()) {}
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
    this.publish({ pending: immutable({ session: current.route, command: { ...command, op_id: this.operationId() } }), receipt: null, error: null });
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
      const rejected = failure instanceof CoreFailure && failure.error.code !== 'commit_uncertain';
      this.publish({ error: failure, ...(rejected ? { pending: null } : {}) });
      if (rejected) await this.session.refresh();
      return false;
    } finally { this.publish({ writing: false }); }
  }
}
export function useSessionActions(actions: SessionActions) {
  return useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
}
