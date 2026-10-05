import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  CoreError, DesktopDiscoverySnapshot, ItemRoute, MutationEnvelope, MutationReceipt, OpenRoute,
  OwnerMutationRequest, OwnerQueryRequest, PresenceChangedHint, QueryEnvelope,
  QueryRequest, QueryResult, SessionChangedHint,
} from '../generated/core';

export type QueryCommand = QueryRequest['command'];
export type QueryData<C extends QueryCommand> = Extract<QueryResult, { kind: C }>['data'];
export type QueryCall<C extends QueryCommand> = OwnerQueryRequest & {
  request: Extract<QueryRequest, { command: C }>;
};
export type Unsubscribe = () => void;
export interface HintPayloads {
  'ariadne://session_changed': SessionChangedHint;
  'ariadne://presence_changed': PresenceChangedHint;
  'ariadne://route': OpenRoute;
}
export interface RendererService {
  discovery(): Promise<DesktopDiscoverySnapshot>;
  setConnectionUiOpen(open: boolean): Promise<void>;
  query<C extends QueryCommand>(request: QueryCall<C>): Promise<QueryData<C>>;
  executeOwner(request: OwnerMutationRequest): Promise<MutationReceipt>;
  subscribe<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void): Promise<Unsubscribe>;
}

export class CoreFailure extends Error {
  constructor(readonly error: CoreError) {
    super(error.message);
    this.name = 'CoreFailure';
  }
}
export class ServiceFailure extends Error {
  constructor(readonly reason: 'transport' | 'invalid_response') {
    super(reason === 'transport' ? 'Desktop service is unavailable.' : 'Desktop service returned an invalid response.');
    this.name = 'ServiceFailure';
  }
}

// Transport injection is for tests and other real entrypoints; ordinary desktop
// calls always use Tauri. There is no scripted production fallback.
export interface DesktopTransport {
  discovery?(): Promise<DesktopDiscoverySnapshot>;
  setConnectionUiOpen?(open: boolean): Promise<void>;
  invoke<T>(command: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T>;
  listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void): Promise<Unsubscribe>;
}
const tauriTransport: DesktopTransport = {
  discovery: () => invoke('discovery_snapshot'),
  setConnectionUiOpen: open => invoke('discovery_ui_open', { request: { open } }),
  invoke: (command, args) => invoke(command, args),
  async listen(event, receive) {
    const unsubscribe = await listen<HintPayloads[typeof event]>(event, (message) => receive(message.payload));
    if (event === 'ariadne://route') {
      try {
        await invoke('route_ready');
      } catch (error: unknown) {
        unsubscribe();
        throw error;
      }
    }
    return unsubscribe;
  },
};

function validEnvelope(envelope: QueryEnvelope | MutationEnvelope): void {
  if (!envelope || envelope.api_version !== 1 || typeof envelope.ok !== 'boolean') {
    throw new ServiceFailure('invalid_response');
  }
  if (!envelope.ok) {
    const error = envelope.error;
    if (!error || typeof error.message !== 'string' || typeof error.hint !== 'string'
        || typeof error.code !== 'string' || typeof error.retryable !== 'boolean'
        || !Array.isArray(error.field_errors) || (error.code === 'delivery_uncertain' && error.retryable)) {
      throw new ServiceFailure('invalid_response');
    }
    throw new CoreFailure(error);
  }
}
function sameRoute(left: ItemRoute, right: ItemRoute): boolean {
  return left.project_id === right.project_id && left.session_id === right.session_id && left.item_id === right.item_id;
}

export function createDesktopService(transport: DesktopTransport = tauriTransport): RendererService {
  async function call<T>(command: string, request: OwnerQueryRequest | OwnerMutationRequest): Promise<T> {
    try {
      return await transport.invoke<T>(command, { request });
    } catch {
      // Never expose arbitrary native errors or stderr in product flows.
      throw new ServiceFailure('transport');
    }
  }
  return {
    async discovery() {
      let snapshot: DesktopDiscoverySnapshot;
      try {
        if (!transport.discovery) throw new Error('Discovery unavailable');
        snapshot = await transport.discovery();
      } catch { throw new ServiceFailure('transport'); }
      validateDiscovery(snapshot);
      return snapshot;
    },
    async setConnectionUiOpen(open) {
      try {
        if (!transport.setConnectionUiOpen) throw new Error('Discovery unavailable');
        await transport.setConnectionUiOpen(open);
      } catch { throw new ServiceFailure('transport'); }
    },
    async query<C extends QueryCommand>(request: QueryCall<C>): Promise<QueryData<C>> {
      const envelope = await call<QueryEnvelope>(request.request.command, request);
      validEnvelope(envelope);
      if (!envelope.ok || !envelope.data || envelope.data.kind !== request.request.command) {
        throw new ServiceFailure('invalid_response');
      }
      const result = envelope.data;
      const query: QueryRequest = request.request;
      if (result.kind === 'session_get' && (!result.data?.session || !request.session
          || result.data.session.id !== request.session.session_id
          || result.data.session.project_id !== request.session.project_id)) {
        throw new ServiceFailure('invalid_response');
      }
      if (result.kind === 'reveal_item' && query.command === 'reveal_item'
          && (!request.session || !result.data || !sameRoute(result.data, {
            ...request.session, item_id: query.params.item_id,
          }))) {
        throw new ServiceFailure('invalid_response');
      }
      // Native validates the complete canonical result before emitting it. This
      // assertion relates the checked discriminant to TypeScript's generic C.
      return result.data as QueryData<C>;
    },
    async executeOwner(request) {
      const envelope = await call<MutationEnvelope>(request.command.command, request);
      validEnvelope(envelope);
      if (!envelope.ok || !envelope.data || envelope.data.operation_id !== request.command.op_id) {
        throw new ServiceFailure('invalid_response');
      }
      if ('session_id' in envelope.data) {
        const expectedSession = request.session?.session_id
          ?? (request.command.command === 'binding_connect' ? request.command.params.existing_session_id : null);
        if ((expectedSession !== null && expectedSession !== undefined && envelope.data.session_id !== expectedSession)
            || (!request.session && request.command.command !== 'binding_connect')) {
          throw new ServiceFailure('invalid_response');
        }
      }
      return envelope.data;
    },
    async subscribe(event, receive) {
      try {
        return await transport.listen(event, receive);
      } catch {
        throw new ServiceFailure('transport');
      }
    },
  };
}

export function validateDiscovery(snapshot: DesktopDiscoverySnapshot): void {
  const invalid = () => { throw new ServiceFailure('invalid_response'); };
  if (!snapshot || !Array.isArray(snapshot.candidates) || snapshot.candidates.length > 256
      || new TextEncoder().encode(JSON.stringify(snapshot)).length > 1024 * 1024) invalid();
  const identities = new Set<string>();
  const bounded = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0') && new TextEncoder().encode(value).length <= 4096;
  const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  for (const candidate of snapshot.candidates) {
    if (!candidate || !bounded(candidate.adapter_id) || !bounded(candidate.external_session_id) || !bounded(candidate.cwd)
        || !bounded(candidate.host_version) || !candidate.endpoint
        || !(candidate.endpoint.kind === 'unix_socket' ? bounded(candidate.endpoint.path) : candidate.endpoint.kind === 'local_bridge' && bounded(candidate.endpoint.name))
        || (candidate.title !== null && (typeof candidate.title !== 'string' || candidate.title.includes('\0') || new TextEncoder().encode(candidate.title).length > 4096))
        || !['fresh', 'stale', 'historical', 'unknown'].includes(candidate.freshness)
        || !['compatible', 'untested', 'incompatible', 'unknown'].includes(candidate.compatibility)
        || !['available', 'unavailable', 'unknown'].includes(candidate.availability)
        || typeof candidate.loaded !== 'boolean' || typeof candidate.observed_at !== 'string' || !Number.isFinite(Date.parse(candidate.observed_at))
        || (candidate.binding_id !== null && !uuid(candidate.binding_id))
        || (candidate.session !== null && (!candidate.session || !uuid(candidate.session.project_id) || !uuid(candidate.session.session_id)))
        || ((candidate.binding_id === null) !== (candidate.session === null))) invalid();
    const identity = JSON.stringify([candidate.adapter_id, candidate.endpoint.kind,
      candidate.endpoint.kind === 'unix_socket' ? candidate.endpoint.path : candidate.endpoint.name, candidate.external_session_id]);
    if (identities.has(identity)) invalid();
    identities.add(identity);
  }
  if (snapshot.error !== null && (!snapshot.error || typeof snapshot.error.message !== 'string' || typeof snapshot.error.hint !== 'string')) invalid();
}
