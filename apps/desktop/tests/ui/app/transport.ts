import demo from '../../../../../fixtures/domain/demo/session.json';
import projectsFixture from '../../../../../fixtures/domain/projections/projects.json';
import sessionsFixture from '../../../../../fixtures/domain/projections/sessions.json';
import type { OwnerMutationRequest, OwnerQueryRequest, PreferencesSnapshot, SessionPreferences } from '../../../src/generated/core';
import type { ItemReadProjection, Page, ProjectSummary, Session, SessionSummary, SummaryCounts } from '../../../src/generated/domain/models';
import type { DesktopTransport, HintPayloads } from '../../../src/data/service';

export const secondId = '00000000-0000-4000-8000-000000000003';
const page = <T,>(items: T[], revision: number): Page<T> => ({ items, next_cursor: null, snapshot_revision: revision });
export const route = { project_id: demo.project_id, session_id: demo.id };
const queriesWithSession = ['session_get', 'session_read', 'item_messages', 'item_rounds', 'reveal_item'];
const mutationsWithoutSession = ['project_register', 'binding_connect', 'preferences_patch'];
/**
 * Mirrors OwnerQueryRequest/OwnerMutationRequest::validate_wire in
 * crates/ariadne-core/src/service/validation.rs: a session route must be present
 * exactly for the commands that declare one. The real command rejects violations
 * with invalid_argument, so fakes must too. Keep the lists in sync with that file.
 */
export function assertOwnerWire(request: OwnerQueryRequest | OwnerMutationRequest): void {
  const reject = (): never => { throw Object.assign(new Error('invalid_argument: owner request session route mismatch'), { code: 'invalid_argument' }); };
  if ('command' in request) {
    if (mutationsWithoutSession.includes(request.command.command) === (request.session != null)) reject();
    if (request.command.command === 'topic_continue' && JSON.stringify(request.session) !== JSON.stringify(request.command.params.target)) reject();
  } else if (queriesWithSession.includes(request.request.command) !== (request.session != null)) reject();
}
export class AppTransport implements DesktopTransport {
  readonly sessions = new Map<string, Session>();
  readonly mutations: OwnerMutationRequest[] = [];
  readonly queries: OwnerQueryRequest[] = [];
  readonly listeners = new Map<keyof HintPayloads, Set<(hint: never) => void>>();
  failNext: string | null = null;
  readonly preferences: PreferencesSnapshot = {
    schema_version: 1, revision: 1,
    global: { theme: 'system', selected_navigation: { kind: 'all_sessions' }, window: null, pinned: false, notification_watermark: null },
    sessions: [], drafts: [], later: [],
  };
  constructor() {
    const first = structuredClone(demo) as Session;
    first.title = 'Payments review';
    const second = structuredClone(first); second.id = secondId; second.title = 'Separate session';
    second.inputs = {}; second.items = {}; second.topics = {}; second.operation_receipts = {}; second.messages = []; second.answers = []; second.rounds = {};
    this.sessions.set(first.id, first); this.sessions.set(second.id, second);
    this.preferences.sessions = [{ ...this.view(), tab_open: false }];
  }
  view(sessionId = demo.id): SessionPreferences {
    return { session: { ...route, session_id: sessionId }, tab_open: true, selected_item_id: null, tab_order: 0, expanded_item_ids: ['1', '2', '3'],
      filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'hidden', scroll: null };
  }
  async listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void) {
    const set = this.listeners.get(event) ?? new Set(); set.add(receive as (hint: never) => void); this.listeners.set(event, set);
    return () => { set.delete(receive as (hint: never) => void); };
  }
  emit<E extends keyof HintPayloads>(event: E, hint: HintPayloads[E]) { this.listeners.get(event)?.forEach(callback => callback(hint as never)); }
  async invoke<T>(name: string, { request }: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    assertOwnerWire(request);
    if ('command' in request) {
      this.mutations.push(structuredClone(request));
      if (name === this.failNext) { this.failNext = null; throw new Error('Lost response'); }
      const command = request.command;
      if (command.command === 'preferences_patch') {
        for (const entry of command.params.entries) {
          if (entry.kind === 'set_global') this.preferences.global = structuredClone(entry.preferences);
          if (entry.kind === 'set_session_view') {
            this.preferences.sessions = this.preferences.sessions.filter(view => view.session.session_id !== entry.preferences.session.session_id);
            this.preferences.sessions.push(structuredClone(entry.preferences));
          }
          if (entry.kind === 'set_later') {
            this.preferences.later = this.preferences.later.filter(item => item.item_id !== entry.item.item_id || item.session_id !== entry.item.session_id);
            if (entry.later) this.preferences.later.push(structuredClone(entry.item));
          }
          if (entry.kind === 'upsert_draft') {
            this.preferences.drafts = this.preferences.drafts.filter(draft => draft.op_id !== entry.draft.op_id);
            this.preferences.drafts.push(structuredClone(entry.draft));
          }
          if (entry.kind === 'delete_draft') this.preferences.drafts = this.preferences.drafts.filter(draft => draft.op_id !== entry.operation_id);
        }
        ++this.preferences.revision;
        return { api_version: 1, ok: true, data: { operation_id: command.op_id, preferences_revision: this.preferences.revision } } as T;
      }
      const session = this.sessions.get(request.session!.session_id)!;
      const binding = session.bindings[session.active_binding_id!]!;
      if (command.command === 'binding_pause') {
        binding.owner_paused = true; binding.dispatch_state = 'paused'; ++session.revision;
        return { api_version: 1, ok: true, data: { operation_id: command.op_id, session_id: session.id, revision: session.revision,
          data: { kind: 'binding_state', binding_id: binding.id, generation: binding.generation, owner_paused: true,
            dispatch_state: 'paused', pause_reason: binding.pause_reason, connection_state: binding.connection_state } } } as T;
      }
      if (command.command === 'input_submit') {
        const input = structuredClone(Object.values(session.inputs).find(input => input?.state === 'queued')!);
        const message = structuredClone(session.messages.find(message => message.kind === 'owner_input')!);
        message.id = crypto.randomUUID(); message.number = Math.max(...session.messages.map(value => value.number)) + 1; message.body = command.params.text;
        message.item_id = command.params.target.item_id; message.topic_id = command.params.target.topic_id;
        input.id = crypto.randomUUID(); input.seq = Math.max(...Object.values(session.inputs).map(value => value?.seq ?? 0)) + 1; input.kind = command.params.kind;
        input.message_id = message.id; input.target = structuredClone(command.params.target); input.payload.intent = command.params.kind; input.payload.text = command.params.text;
        input.payload.target_snapshot.item_question = session.items[message.item_id!]!.question;
        session.messages.push(message); session.inputs[input.id] = input; ++session.revision;
        this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
        return { api_version: 1, ok: true, data: { operation_id: command.op_id, session_id: session.id, revision: session.revision,
          data: { kind: 'input_submit', input_id: input.id, input_seq: input.seq, message_id: message.id, message_number: message.number } } } as T;
      }
      throw new Error(`Unexpected mutation ${name}`);
    }
    this.queries.push(structuredClone(request));
    const data = this.query(request);
    return { api_version: 1, ok: true, data: { kind: name, data: structuredClone(data) } } as T;
  }
  private query(request: OwnerQueryRequest): unknown {
    const query = request.request;
    const counts = structuredClone(sessionsFixture.items[0].counts) as SummaryCounts;
    if (query.command === 'preferences_get') return this.preferences;
    if (query.command === 'project_list') {
      const project = structuredClone(projectsFixture.items[0]) as ProjectSummary;
      return { projects: page([project], 1), counts };
    }
    if (query.command === 'session_list') return { sessions: page([...this.sessions.values()].map(session => ({
      ...structuredClone(sessionsFixture.items[0]), session_id: session.id, title: session.title, revision: session.revision,
    })) as SessionSummary[], 1), counts, active_total: this.sessions.size, closed_total: 0 };
    const session = this.sessions.get(request.session!.session_id)!;
    if (query.command === 'session_get') return { session, freshness: 'fresh' };
    if (query.command === 'reveal_item') return { ...request.session, item_id: query.params.item_id };
    if (query.command === 'item_messages') return { item_id: query.params.item_id, messages: page(session.messages.filter(message => message.item_id === query.params.item_id), session.revision),
      timeline_context: { parent_item_id: null, created_message: null, source_round_id: null } };
    if (query.command === 'item_rounds') return { item_id: query.params.item_id, rounds: page([], session.revision) };
    if (query.command === 'session_read') {
      if (query.params.selection.view === 'messages') return { view: 'messages', page: page(session.messages, session.revision) };
      if (query.params.selection.view === 'items') {
        const item = { ...session.items[query.params.selection.filters.item_id ?? '1']! };
        Reflect.deleteProperty(item, 'status_history'); Reflect.deleteProperty(item, 'updated_message_ids');
        const projection: ItemReadProjection = { item, updated_messages: page([], session.revision), status_history: page([], session.revision) };
        return { view: 'items', page: page([projection], session.revision) };
      }
    }
    throw new Error(`Unexpected query ${query.command}`);
  }
}
