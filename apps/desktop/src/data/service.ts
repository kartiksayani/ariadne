import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  CoreError, ItemRoute, MutationEnvelope, MutationReceipt, OpenRoute,
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
  invoke<T>(command: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T>;
  listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void): Promise<Unsubscribe>;
}
const tauriTransport: DesktopTransport = {
  invoke: (command, args) => invoke(command, args),
  listen: (event, receive) => listen<HintPayloads[typeof event]>(event, (message) => receive(message.payload)),
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
