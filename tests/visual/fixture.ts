import { page, projections } from '../../apps/desktop/tests/ui/history/fixtures';
import { HistoryTransport } from '../../apps/desktop/tests/ui/history-actions/fixture';
import { route, secondId } from '../../apps/desktop/tests/ui/app/transport';
import { waitingRows } from '../../apps/desktop/src/selectors/waiting/rows';
import projects from '../../fixtures/domain/projections/projects.json';
import summaries from '../../fixtures/domain/projections/sessions.json';
import type { ProjectSummary, Session, SessionSummary, SummaryCounts } from '../../apps/desktop/src/generated/domain/models';
import type { DesktopDiscoverySnapshot, QueryEnvelope, OwnerMutationRequest, OwnerQueryRequest } from '../../apps/desktop/src/generated/core';
import { ordinaryCases, type OrdinaryCase } from './cases';

export class CaptureTransport extends HistoryTransport {
  constructor(private readonly scenario: OrdinaryCase) { super(); }
  async setConnectionUiOpen() {}
  async discovery(): Promise<DesktopDiscoverySnapshot> {
    return { error: null, candidates: [{ adapter_id: 'codex', endpoint: { kind: 'unix_socket', path: '/tmp/capture-host.sock' },
      external_session_id: 'capture-existing-thread', cwd: projects.items[0].canonical_root, title: 'Discovered existing conversation',
      host_version: 'renderer-fixture', observed_at: this.source.updated_at, freshness: 'fresh', compatibility: 'unknown', availability: 'unknown', loaded: true, binding_id: null, session: null }] };
  }
  private counts(session: Session): SummaryCounts {
    const counts = structuredClone(summaries.items[0].counts) as SummaryCounts;
    for (const status of Object.keys(counts.items_by_status) as (keyof SummaryCounts['items_by_status'])[]) counts.items_by_status[status] = 0;
    for (const item of Object.values(session.items)) if (item && session.topics[item.topic_id]?.archived_at === null) counts.items_by_status[item.status]++;
    counts.waiting_unanswered = waitingRows([{ session, project: projects.items[0] as ProjectSummary, summary: { ...summaries.items[0], title: session.title } as SessionSummary }]).length;
    counts.sent_inputs = { queued: 0, in_flight: 0, needs_attention: 0 };
    for (const input of Object.values(session.inputs)) if (input && input.state in counts.sent_inputs) counts.sent_inputs[input.state as keyof SummaryCounts['sent_inputs']]++;
    counts.archived_topics = Object.values(session.topics).filter(topic => topic?.archived_at !== null).length;
    return counts;
  }
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const request = args.request;
    if ('request' in request && request.request.command === 'session_get' && this.scenario.loading && request.session?.session_id === route.session_id) {
      return new Promise<T>(() => {});
    }
    if ('request' in request && request.request.command === 'item_rounds') {
      this.queries.push(structuredClone(request));
      const session = this.sessions.get(request.session!.session_id)!;
      const itemId = request.request.params.item_id;
      const rounds = this.scenario.id === '1u' && itemId === '1' ? projections(session).rounds.slice(0, 3) : Object.values(session.rounds)
        .flatMap(round => round?.item_id === itemId ? [{
          round: { id: round.id, item_id: round.item_id, opened_message_id: round.opened_message_id, question_revision: round.question_revision,
            origin: round.origin, ordinal: round.ordinal, question_snapshot: round.question_snapshot, ask_snapshot: round.ask_snapshot,
            options_snapshot: round.options_snapshot, closed_at: round.closed_at },
          answers: page(session.answers.filter(answer => answer.item_id === round.item_id && answer.question_revision === round.question_revision), session.revision),
          owner_messages: page(session.messages.filter(message => round.owner_message_ids.includes(message.id)), session.revision),
          agent_messages: page(session.messages.filter(message => round.agent_message_ids.includes(message.id)), session.revision),
          results: page(Object.values(session.inputs).flatMap(input => input && round.result_input_ids.includes(input.id)
            ? input.attempts.flatMap(attempt => attempt.domain_result ? [{ input_id: input.id, attempt_id: attempt.id, result: attempt.domain_result }] : []) : []), session.revision),
          forks: page(round.fork_item_ids.flatMap(id => session.items[id] ? [{ ...request.session!, item_id: id,
            question: session.items[id]!.question, status: session.items[id]!.status }] : []), session.revision),
        }] : []);
      return { api_version: 1, ok: true, data: { kind: name, data: { item_id: itemId, rounds: page(rounds, session.revision) } } } as T;
    }
    if ('request' in request && ['project_list', 'session_list'].includes(request.request.command)) {
      const envelope = await super.invoke<QueryEnvelope>(name, args);
      if (envelope.ok && (envelope.data.kind === 'project_list' || envelope.data.kind === 'session_list')) {
        const counts = this.counts(this.source), other = this.counts(this.target);
        for (const status of Object.keys(counts.items_by_status) as (keyof SummaryCounts['items_by_status'])[]) counts.items_by_status[status] += other.items_by_status[status];
        counts.waiting_unanswered += other.waiting_unanswered; counts.archived_topics += other.archived_topics;
        for (const state of Object.keys(counts.sent_inputs) as (keyof SummaryCounts['sent_inputs'])[]) counts.sent_inputs[state] += other.sent_inputs[state];
        envelope.data.data.counts = counts;
        if (envelope.data.kind === 'project_list') for (const project of envelope.data.data.projects.items) project.counts = counts;
        else {
          for (const summary of envelope.data.data.sessions.items) {
            const session = this.sessions.get(summary.session_id)!;
            summary.state = session.state; summary.counts = this.counts(session);
            const binding = session.bindings[session.active_binding_id!];
            if (summary.active_binding && binding) { summary.active_binding.connection_state = binding.connection_state; summary.active_binding.dispatch_state = binding.dispatch_state; }
          }
          envelope.data.data.active_total = [...this.sessions.values()].filter(session => session.state === 'active').length;
          envelope.data.data.closed_total = [...this.sessions.values()].filter(session => session.state === 'closed').length;
        }
      }
      return envelope as T;
    }
    return super.invoke(name, args);
  }
}

export function createOrdinaryCapture(params: URLSearchParams) {
const scenario: OrdinaryCase = ordinaryCases.find(value => value.id === params.get('frame')) ?? ordinaryCases[0];
const transport = new CaptureTransport(scenario), session = transport.source;
transport.preferences.global.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const view = transport.preferences.sessions[0]; view.tab_open = true; view.selected_item_id = scenario.item ?? null; view.rail = scenario.rail ? 'activity' : 'hidden';
transport.preferences.global.selected_navigation = scenario.navigation === 'projects' ? { kind: 'projects' }
  : scenario.navigation === 'all_sessions' ? { kind: 'all_sessions' }
    : scenario.navigation === 'project' ? { kind: 'project', project_id: route.project_id } : { kind: 'session', session: route };
session.items['2']!.options = [{ id: 'morning', label: 'Morning delivery', consequence: 'Deliver before lunch.', recommended: true },
  { id: 'afternoon', label: 'Afternoon delivery', consequence: 'Deliver after lunch.', recommended: false }];
if (scenario.empty) { session.items = {}; session.topics = {}; session.messages = []; session.rounds = {}; session.answers = []; session.inputs = {}; }
if (scenario.clear) { session.items['2']!.status = 'done'; session.inputs = {}; }
if (scenario.filtered) view.filters.search = 'nonmatching filter';
if (scenario.multiple) { session.items['4']!.status = 'waiting_on_me'; session.items['4']!.waiting_since = session.items['2']!.waiting_since; session.items['4']!.ask = 'Review the retry limits explicitly.'; }
if (scenario.disconnected) session.bindings[session.active_binding_id!]!.connection_state = 'disconnected';
if (scenario.answered) {
  const answer = structuredClone(session.answers[0]), input = structuredClone(Object.values(session.inputs).find(input => input?.state === 'queued')!);
  answer.id = '00000000-0000-4000-8000-000000004001'; answer.item_id = '2'; answer.question_revision = session.items['2']!.question_revision; answer.input_id = input.id;
  input.kind = 'answer'; input.target.item_id = '2'; input.payload.intent = 'answer'; input.payload.selected_option_id = 'afternoon'; input.payload.text = 'Please use the afternoon delivery.';
  input.payload.target_snapshot.item_question = session.items['2']!.question;
  input.payload.target_snapshot.question_revision = session.items['2']!.question_revision; input.payload.target_snapshot.options = structuredClone(session.items['2']!.options);
  session.answers.push(answer); session.inputs[input.id] = input;
}
if (scenario.archived) { session.topics[session.items['8']!.topic_id]!.archived_at = session.updated_at; view.filters.archived = true; }
if (scenario.disconnected) transport.preferences.drafts.push({ op_id: '00000000-0000-4000-8000-000000004002', session: route,
  binding_id: session.active_binding_id!, target: { topic_id: session.items['2']!.topic_id, item_id: '2' }, target_revision: session.items['2']!.revision,
  question_revision: session.items['2']!.question_revision, intent: 'answer', text: 'Keep the afternoon choice and this draft.', selected_option_id: 'afternoon', supersedes_answer_id: null, submission_attempted: false });
if (scenario.navigation === 'project') { transport.target.state = 'closed'; transport.target.closed_at = session.updated_at; }
return { frame: scenario.id, route, secondId, snapshot: session, transport };
}
