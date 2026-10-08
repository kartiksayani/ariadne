import type { ContinuePreview, MutationEnvelope, OwnerMutationRequest, OwnerQueryRequest } from '../../../src/generated/core';
import type { SavedReceiptData } from '../../../src/generated/domain/models';
import { AppTransport, assertOwnerWire, route, secondId } from '../app/transport';

export class HistoryTransport extends AppTransport {
  replies: (MutationEnvelope | Error | Promise<MutationEnvelope>)[] = [];
  blocked = false;
  get source() { return this.sessions.get(route.session_id)!; }
  get target() { return this.sessions.get(secondId)!; }
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const { request } = args;
    assertOwnerWire(request);
    if (!('command' in request)) {
      if (request.request.command !== 'topic_continue_preview') return super.invoke(name, args);
      this.queries.push(structuredClone(request));
      const params = request.request.params;
      const preview: ContinuePreview = { ...params, source_revision: this.source.revision, source_sha256: 'a'.repeat(64),
        summary: 'Approved full snapshot. Keep copied source provenance.',
        mapping: Object.values(this.source.items).filter(item => item?.topic_id === params.source_topic_id).map(item => ({ source_item_id: item!.id, action: { kind: 'copy' } })),
        readiness: this.blocked ? { kind: 'blocked', reasons: ['binding_unknown'] } : { kind: 'ready', binding_id: this.target.active_binding_id!, generation: this.target.bindings[this.target.active_binding_id!]!.generation, host_available: false },
      };
      return { api_version: 1, ok: true, data: { kind: name, data: preview } } as T;
    }
    if (!['topic_archive', 'topic_restore', 'session_close', 'session_reopen', 'topic_continue', 'session_label_set'].includes(name)) return super.invoke(name, args);
    this.mutations.push(structuredClone(request));
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply) return await reply as T;
    const command = request.command, session = this.sessions.get(request.session!.session_id)!;
    let data: SavedReceiptData;
    if (command.command === 'topic_archive' || command.command === 'topic_restore') {
      const topic = session.topics[command.params.topic_id]!;
      topic.archived_at = command.command === 'topic_archive' ? session.updated_at : null; ++topic.revision;
      // Core's archive cancels the topic's unsettled inputs and lists them; items keep their status. Restore leaves them cancelled.
      const cancelled = command.command === 'topic_archive' ? Object.values(session.inputs)
        .filter(input => input && input.target.topic_id === topic.id && ['queued', 'in_flight', 'needs_attention'].includes(input.state))
        .map(input => { input!.state = 'cancelled'; return input!.id; }) : [];
      data = { kind: 'topic_lifecycle', topic_id: topic.id, topic_revision: topic.revision, archived_at: topic.archived_at,
        ...cancelled.length ? { cancelled_input_ids: cancelled } : {} };
    } else if (command.command === 'session_close' || command.command === 'session_reopen') {
      session.state = command.command === 'session_close' ? 'closed' : 'active';
      session.closed_at = session.state === 'closed' ? session.updated_at : null;
      // Core's close cancels every unsettled input and lists them (`cancelled_input_ids`, not yet in the generated type).
      const cancelled = command.command === 'session_close' ? Object.values(session.inputs)
        .filter(input => input && ['queued', 'in_flight', 'needs_attention'].includes(input.state))
        .map(input => { input!.state = 'cancelled'; return input!.id; }) : [];
      data = { kind: 'session_lifecycle', state: session.state, closed_at: session.closed_at,
        ...cancelled.length ? { cancelled_input_ids: cancelled } : {} } as SavedReceiptData;
    } else if (command.command === 'session_label_set') {
      // Core stores the trimmed text and clears a blank field (history_actions/label.rs).
      const name = command.params.name?.trim() || undefined, description = command.params.description?.trim() || undefined;
      session.name = name; session.description = description;
      data = { kind: 'session_label', name: name ?? null, description: description ?? null };
    } else if (command.command === 'topic_continue') {
      data = { kind: 'continuation', continuation: {
        operation_id: command.op_id, source_project_id: command.params.source.project_id, source_session_id: command.params.source.session_id,
        source_topic_id: command.params.source_topic_id, source_revision: command.params.source_revision, source_sha256: command.params.source_sha256,
        target_topic_id: '00000000-0000-4000-8000-000000001111', target_input_id: '00000000-0000-4000-8000-000000001112',
        item_id_map: {}, message_id_map: {}, round_id_map: {}, answer_id_map: {}, summary: command.params.summary, confirmed_at: session.updated_at,
      } };
    } else throw new Error('Unexpected history command');
    ++session.revision;
    return { api_version: 1, ok: true, data: { operation_id: command.op_id, session_id: session.id, revision: session.revision, data } } as T;
  }
}
