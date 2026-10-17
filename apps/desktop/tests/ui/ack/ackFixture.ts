// A session with two results to ack ('1' a finding, '1.1' an explanation) behind a transport that saves Acks one at a time.
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { SessionActions } from '../../../src/components/bindings/actions';
import type { MutationReceipt, OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import { ackHoldFor } from '../../../src/ui/shared/ack';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';

export const stores: SessionStore[] = [];

export class AckTransport extends AppTransport {
  gate: Promise<void> | null = null;
  refuse = false;
  inFlight = 0;
  maxInFlight = 0;
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const request = args.request;
    if (!('command' in request) || request.command.command !== 'ack') return super.invoke(name, args);
    this.mutations.push(structuredClone(request));
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await this.gate;
      if (this.refuse) return { api_version: 1, ok: false, error: {
        code: 'invalid_transition', message: 'Ack predicate no longer holds.', hint: 'Reload item state.', retryable: false, field_errors: [],
      } } as T;
      const command = request.command, session = this.sessions.get(request.session!.session_id)!, item = session.items[command.params.item_id]!;
      const status = item.ack_to!;
      item.status = status; item.ack_to = null; item.revision++; session.revision++;
      if (['decided', 'done', 'dropped'].includes(status)) { item.outcome ??= 'Acknowledged by the owner.'; item.why ??= 'The owner read this item.'; }
      const receipt: MutationReceipt = { operation_id: command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status, message_id: crypto.randomUUID() } };
      return { api_version: 1, ok: true, data: receipt } as T;
    } finally { --this.inFlight; }
  }
}

export async function ready() {
  const transport = new AckTransport(), session = transport.sessions.get(route.session_id)!;
  Object.values(session.items).forEach(item => { if (item) item.ack_to = null; });
  for (const [id, type] of [['1', 'finding'], ['1.1', 'explanation']] as const) {
    Object.assign(session.items[id]!, { type, status: 'open', ack_to: 'done', ask: null, question: `Result ${id}`, outcome: null, why: null });
  }
  const service = createDesktopService(transport), store = new SessionStore(service, route);
  stores.push(store); await store.refresh();
  const actions = new SessionActions(service, store), topicId = session.items['1']!.topic_id;
  return { transport, service, session, store, actions, topicId, hold: ackHoldFor(route.session_id, actions) };
}
export type Ready = Awaited<ReturnType<typeof ready>>;
export const acks = (transport: AppTransport) => transport.mutations.filter(value => value.command.command === 'ack');
export const acked = (transport: AppTransport) => acks(transport).map(value => value.command.command === 'ack' && value.command.params.item_id);
export const itemOf = (r: Ready, id = '1') => r.store.getSnapshot().snapshot!.session.items[id]!;
export const noticeTexts = () => notices.getSnapshot().map(notice => notice.text);
/** Changes the server's item, then lets the session store read it. */
export async function change(r: Ready, edit: (item: NonNullable<Ready['session']['items'][string]>) => void, id = '1') {
  const item = r.session.items[id]!;
  edit(item); item.revision++; r.session.revision++;
  await r.store.refresh(true);
}
