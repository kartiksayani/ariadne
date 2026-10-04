import demo from '../../../../../fixtures/domain/demo/session.json';
import type { QueryEnvelope, QueryResult, SessionReadResult } from '../../../src/generated/core';
import type { ItemReadProjection, Message, Page, QueryCursor, RoundProjection, Session } from '../../../src/generated/domain/models';
import { createDesktopService, type DesktopTransport, type HintPayloads } from '../../../src/data/service';
import { OpenSessions } from '../../../src/data/session-store';
import { RegisteredRoutes } from '../../../src/data/routes';

export const sessionFixture = () => structuredClone(demo) as Session;
export const route = { project_id: demo.project_id, session_id: demo.id };
const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
export const page = <T,>(items: T[], revision = 21, next_cursor: QueryCursor | null = null): Page<T> => ({ items, snapshot_revision: revision, next_cursor });
export const cursor = (view: QueryCursor['view'], number = 1, revision = 21): QueryCursor => ({
  schema: 1, view, revision, filter_digest: 'a'.repeat(64), after: { kind: 'history', index: number },
});
export function projections(session: Session) {
  const item = session.items['1']!;
  const base = Object.values(session.rounds).find(round => round?.item_id === '1')!;
  const owner = session.messages.find(message => message.kind === 'owner_input' && message.item_id === '1')!;
  const reply = session.messages.find(message => message.kind === 'reply' && message.item_id === '1')!;
  const answer = session.answers.find(answer => answer.item_id === '1')!;
  const result = Object.values(session.inputs).flatMap(input => input?.attempts ?? []).find(attempt => attempt.domain_result)?.domain_result;
  if (!result) throw new Error('Canonical demo result is missing');
  const rounds: RoundProjection[] = Array.from({ length: 5 }, (_, index) => ({
    round: { id: id(500 + index), item_id: base.item_id, opened_message_id: base.opened_message_id,
      question_revision: base.question_revision, origin: base.origin, ordinal: index + 1,
      question_snapshot: `Round ${index + 1} exact question`, ask_snapshot: `Ask ${index + 1}\nKeep the full explanation.`,
      options_snapshot: answer.options_snapshot, closed_at: index === 4 ? null : base.closed_at },
    answers: page([{ ...answer, id: id(600 + index), seq: index + 1, message_id: id(700 + index),
      text: `Owner explanation ${index + 1}  \n exact bytes`, selected_option_id: index === 1 ? null : answer.selected_option_id }], session.revision),
    owner_messages: page([{ ...owner, id: id(700 + index), round_id: id(500 + index), body: `Owner explanation ${index + 1}  \n exact bytes` }], session.revision),
    agent_messages: page([{ ...reply, id: id(800 + index), round_id: id(500 + index), number: 30 + index, body: `Complete reply ${index + 1}\n${'full text '.repeat(index === 0 ? 6000 : 2)}` }], session.revision),
    results: page([{ input_id: id(900 + index), attempt_id: id(1000 + index),
      result: { ...result, explanation: `Explicit result ${index + 1}\nFull explanation.` } }], session.revision),
    forks: page(index < 2 ? [{ ...route, item_id: index === 0 ? '1.1' : '2', question: `Fork question ${index + 1}`, status: 'open' }] : [], session.revision),
  }));
  const snapshot = { ...item };
  Reflect.deleteProperty(snapshot, 'updated_message_ids'); Reflect.deleteProperty(snapshot, 'status_history');
  const read: ItemReadProjection = { item: snapshot, updated_messages: page(session.messages.filter(message => item.updated_message_ids.includes(message.id)), session.revision),
    status_history: page(item.status_history, session.revision) };
  return { rounds, read, conversation: {
    item_id: item.id, messages: page(session.messages.filter(message => message.item_id === item.id && (message.kind === 'owner_input' || message.kind === 'reply')), session.revision),
    timeline_context: { parent_item_id: item.parent, created_message: session.messages.find(message => message.id === item.created_message_id) ?? null, source_round_id: item.source_round_id },
  } };
}
export type ReadRequest = Parameters<DesktopTransport['invoke']>[1]['request'];
export class HistoryTransport implements DesktopTransport {
  session = sessionFixture();
  calls: ReadRequest[] = [];
  listeners = new Map<keyof HintPayloads, (hint: never) => void>();
  override: ((request: ReadRequest) => QueryResult | Promise<QueryResult> | undefined) | null = null;
  async invoke<T>(_name: string, args: { request: ReadRequest }): Promise<T> {
    this.calls.push(structuredClone(args.request));
    const altered = await this.override?.(args.request);
    const result = altered ?? this.response(args.request);
    return { api_version: 1, ok: true, data: structuredClone(result) } satisfies QueryEnvelope as T;
  }
  async listen<E extends keyof HintPayloads>(event: E, receive: (hint: HintPayloads[E]) => void) {
    this.listeners.set(event, receive as (hint: never) => void);
    return () => { this.listeners.delete(event); };
  }
  response(request: ReadRequest): QueryResult {
    if (!('request' in request)) throw new Error('No owner commands in read-only history fixture');
    const query = request.request, values = projections(this.session);
    if (query.command === 'session_get') return { kind: 'session_get', data: { session: this.session, freshness: 'fresh' } };
    if (query.command === 'reveal_item') return { kind: 'reveal_item', data: { ...route, item_id: query.params.item_id } };
    if (query.command === 'item_messages') return { kind: 'item_messages', data: { ...values.conversation, item_id: query.params.item_id } };
    if (query.command === 'item_rounds') {
      const index = query.params.cursor?.after?.kind === 'history' ? query.params.cursor.after.index : 0;
      return { kind: 'item_rounds', data: { item_id: query.params.item_id, rounds: page(values.rounds.slice(index, index + 1), this.session.revision,
        index < 4 ? cursor('item_rounds', index + 1, this.session.revision) : null) } };
    }
    if (query.command === 'session_read') {
      let data: SessionReadResult;
      if (query.params.selection.view === 'messages') data = { view: 'messages', page: page(this.session.messages, this.session.revision) };
      else if (query.params.selection.view === 'items') data = { view: 'items', page: page([{ ...values.read, item: { ...values.read.item, id: query.params.selection.filters.item_id ?? '1' } }], this.session.revision) };
      else throw new Error('Unexpected history view');
      return { kind: 'session_read', data };
    }
    throw new Error('Unexpected history command');
  }
}
export function setup() {
  const transport = new HistoryTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
  const store = sessions.open(route), routes = new RegisteredRoutes(service, sessions);
  return { transport, service, sessions, store, routes };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
export function extraMessage(session: Session, number: number): Message {
  return { ...session.messages[0], id: id(1100 + number), number, body: `New exact message ${number}` };
}
