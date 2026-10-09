import { useSyncExternalStore } from 'react';
import type { MutationReceipt, OwnerCommand, OwnerMutationRequest, SessionRef } from '../../generated/core';
import { CoreFailure, immutable, ServiceFailure, type Immutable, type RendererService, type SessionStore } from '../../data';
import type { ContinuationReceipt } from '../../generated/domain/models';

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validContinuation(receipt: ContinuationReceipt): boolean {
  const itemRef = (value: unknown) => typeof value === 'string'
    && value.split('.').every(part => /^[1-9][0-9]*$/.test(part) && Number.isSafeInteger(Number(part)));
  const values = new Set([receipt.target_topic_id, receipt.target_input_id, receipt.operation_id]);
  const sourceIds = new Set([receipt.source_project_id, receipt.source_session_id, receipt.source_topic_id,
    ...Object.keys(receipt.message_id_map ?? {}), ...Object.keys(receipt.round_id_map ?? {}), ...Object.keys(receipt.answer_id_map ?? {})]);
  if (values.size !== 3 || ![...values].every(uuid) || !timestamp(receipt.confirmed_at)) return false;
  if (sourceIds.has(receipt.target_topic_id) || sourceIds.has(receipt.target_input_id)) return false;
  for (const [index, map] of [receipt.item_id_map, receipt.message_id_map, receipt.round_id_map, receipt.answer_id_map].entries()) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    const entries = Object.entries(map);
    if (entries.some(([key, value]) => !(index === 0 ? itemRef(key) && itemRef(value) : uuid(key) && uuid(value)))
        || new Set(entries.map(([, value]) => value)).size !== entries.length) return false;
    if (index > 0) {
      for (const [, value] of entries) {
        if (!uuid(value) || sourceIds.has(value) || values.has(value)) return false;
        values.add(value);
      }
    }
  }
  return true;
}

interface ActionState {
  readonly writing: boolean;
  readonly pending: Immutable<OwnerMutationRequest> | null;
  readonly error: CoreFailure | ServiceFailure | null;
  readonly receipt: Immutable<MutationReceipt> | null;
}
/** binding_connect replays its exact operation first; every guard after that rejects before saving (bindings/mod.rs connect_guarded). */
const connectRejections = ['binding_conflict', 'binding_mismatch', 'not_found', 'incompatible_adapter', 'host_unreachable',
  'unsupported_host_version', 'unsupported', 'invalid_transition', 'protocol_conflict', 'control_path_too_long', 'permission_denied'];
export function definitiveRejection(failure: CoreFailure | ServiceFailure, command: OwnerCommand): boolean {
  if (!(failure instanceof CoreFailure)) return false;
  // Wire validation (validation.rs validate_wire) runs before any store is
  // opened, so a validation rejection can never have saved the operation.
  if (failure.error.code === 'invalid_argument') return true;
  if (command.command === 'binding_connect' && connectRejections.includes(failure.error.code)) return true;
  if (command.command === 'input_cancel' && ['revision_conflict', 'invalid_transition', 'not_found'].includes(failure.error.code)) return true;
  // Verified replay-first transaction guards in recovery/mod.rs and
  // bindings/mod.rs reject before publication. Recovery's delivery_uncertain
  // denotes missing idle attestation or ineligible retry before mutation.
  // Generic routing/store/host failures can precede replay of an earlier save;
  // their error codes cannot establish that the original operation was unsaved.
  const lifecycle = command.command === 'binding_pause' || command.command === 'binding_resume' || command.command === 'binding_disconnect';
  const history = command.command === 'topic_archive' || command.command === 'topic_restore'
    || command.command === 'session_close' || command.command === 'session_reopen'
    || command.command === 'session_archive' || command.command === 'session_restore';
  // History lifecycle guards and Continue's freshness/copy guards execute
  // inside target Store.transact, after locked exact-operation replay. Generic
  // routing/source IO errors (including binding_mismatch) remain uncertain.
  if (history && ['revision_conflict', 'invalid_transition', 'topic_not_archivable', 'session_not_closable'].includes(failure.error.code)) return true;
  if (command.command === 'topic_continue' && ['preview_stale', 'queue_full', 'invalid_transition', 'incompatible_adapter'].includes(failure.error.code)) return true;
  // A rename of a removed session finds no file, so nothing was saved and nothing can replay.
  if (command.command === 'session_label_set' && failure.error.code === 'not_found') return true;
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
    // binding_connect is project-scoped on the wire (validation.rs requires no session route);
    // the controller still owns its barrier and checks the receipt against its own session.
    const session = command.command === 'binding_connect' ? null : this.route;
    this.publish({ pending: immutable({ session, command: { ...command, op_id: this.operationId() } }), receipt: null, error: null });
    return this.retry();
  }
  async retry(): Promise<boolean> {
    if (this.state.writing || !this.state.pending) return false;
    const request = structuredClone(this.state.pending) as OwnerMutationRequest;
    this.publish({ writing: true, error: null });
    try {
      const receipt = await this.service.executeOwner(request);
      if (!('data' in receipt) || receipt.session_id !== this.route.session_id
          || receipt.operation_id !== request.command.op_id || !Number.isSafeInteger(receipt.revision) || receipt.revision <= 0) {
        throw new ServiceFailure('invalid_response');
      }
      const command = request.command, data = receipt.data;
      const matches = command.command === 'topic_archive' || command.command === 'topic_restore'
        ? data.kind === 'topic_lifecycle' && data.topic_id === command.params.topic_id
          && data.topic_revision === command.params.expected_revision + 1
          && (command.command === 'topic_archive' ? timestamp(data.archived_at) : data.archived_at === null)
        : command.command === 'session_close' || command.command === 'session_reopen'
          ? data.kind === 'session_lifecycle' && receipt.revision === command.params.expected_revision + 1
            && data.state === (command.command === 'session_close' ? 'closed' : 'active')
            && (command.command === 'session_close' ? timestamp(data.closed_at) : data.closed_at === null)
        : command.command === 'session_archive' || command.command === 'session_restore'
          ? data.kind === 'session_lifecycle' && receipt.revision === command.params.expected_revision + 1
            && (command.command === 'session_restore' && command.params.reopen
              ? data.state === 'active' && data.closed_at === null
              : data.state === 'closed' && timestamp(data.closed_at))
            && (command.command === 'session_archive' ? timestamp(data.archived_at) : data.archived_at == null)
        : command.command === 'session_label_set'
          // Core stores the trimmed text and clears a blank field to null.
          ? data.kind === 'session_label' && (data.name ?? null) === (command.params.name?.trim() || null)
            && (data.description ?? null) === (command.params.description?.trim() || null)
        : command.command === 'topic_continue'
          ? data.kind === 'continuation' && validContinuation(data.continuation) && data.continuation.operation_id === command.op_id
            && data.continuation.source_project_id === command.params.source.project_id
            && data.continuation.source_session_id === command.params.source.session_id
            && data.continuation.source_topic_id === command.params.source_topic_id
            && data.continuation.source_revision === command.params.source_revision
            && data.continuation.source_sha256 === command.params.source_sha256
            && data.continuation.summary === command.params.summary
        : command.command === 'binding_connect' ? data.kind === 'binding_connect'
        : command.command === 'input_cancel' ? data.kind === 'input_cancel' && data.input_id === command.params.input_id
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
// The application's controllers per renderer service: owner controls deep in a
// view (the paused warning's Resume) reach the same write barrier as the session bar.
const registered = new WeakMap<RendererService, SessionActionControllers>();
/** Owned by the application, independently of mounted views or open tabs. */
export class SessionActionControllers {
  private readonly controllers = new Map<string, SessionActions>();
  constructor(readonly service: RendererService, private readonly operationId: () => string = () => crypto.randomUUID()) {
    if (!registered.has(service)) registered.set(service, this);
  }
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
/** The session's controller in the application's registry for `service` (created on first use). */
export function sessionActionsFor(service: RendererService, session: SessionStore): SessionActions {
  return (registered.get(service) ?? new SessionActionControllers(service)).forSession(session);
}
export function useSessionActions(actions: SessionActions) {
  return useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
}
