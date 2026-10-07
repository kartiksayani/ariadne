// Frame -> application state for the design fidelity harness. The data is the
// prototype's own: prototypeData() evaluates the data block of the immutable
// handoff (Ariadne.dc.html lines 529-822, TOPICS through SESSIONS), so nothing
// here is a hand copy. designFixture() turns one frame's scenario into domain
// sessions, catalogue summaries and preferences behind the real DesktopApp.
import demo from '../../../fixtures/domain/demo/session.json';
import { AppTransport, assertOwnerWire } from '../../../apps/desktop/tests/ui/app/transport';
import type { OwnerMutationRequest, OwnerQueryRequest, SessionPreferences, SessionRef } from '../../../apps/desktop/src/generated/core';
import type { Binding, Item, ItemStatus, Message, Page, ProjectSummary, Session, SessionSummary, SummaryCounts, Topic } from '../../../apps/desktop/src/generated/domain/models';
import { designNow, frameSpec, type FrameSpec } from './frames';

export interface ProtoOption { readonly id: string; readonly label: string; readonly consequence: string; readonly rec?: boolean }
export interface ProtoLink { readonly kind: 'pr' | 'file' | 'doc'; readonly label: string; readonly meta?: string }
export interface ProtoItem {
  id: string; topic: string; parent: string | null; short: string; type: Item['type'];
  status: 'open' | 'waiting' | 'progress' | 'decided' | 'done' | 'dropped' | 'replaced'; owner: string;
  q: string; outcome: string; why: string; note?: string; ask?: string; replacedBy?: string;
  created: number; updated: number[]; links: ProtoLink[]; options?: ProtoOption[];
}
export interface ProtoTopic { readonly id: string; readonly name: string; readonly short: string; readonly project?: string; readonly archived?: boolean }
export interface ProtoMessage { readonly number: number; readonly author: 'me' | 'agent'; readonly time: string; readonly excerpt: string; readonly session?: string; readonly day?: string }
export interface ProtoProject { readonly id: string; readonly name: string; readonly path: string; readonly last: string }
export interface ProtoSession {
  readonly id: string; readonly project: string; readonly agent: string; readonly where: string; readonly when: string;
  readonly range: string; readonly running: boolean; readonly status: 'active' | 'closed'; readonly msgs?: number;
}
export interface ProtoReply { readonly progress: string; readonly status: ProtoItem['status']; readonly outcome: string; readonly reply: string }
export interface PrototypeData {
  readonly TOPICS: ProtoTopic[]; readonly ITEMS: ProtoItem[]; readonly DEMO: Record<string, ProtoReply[]>; readonly MSGS: ProtoMessage[];
  readonly EARLIER_TOPICS: ProtoTopic[]; readonly EARLIER_MSGS: ProtoMessage[]; readonly EARLIER_ITEMS: ProtoItem[];
  readonly ARCHIVED_TOPICS: ProtoTopic[]; readonly ARCHIVED_ITEMS: ProtoItem[]; readonly PROJECTS: ProtoProject[];
  readonly PROJECT_SESSIONS: ProtoSession[]; readonly SESSION_BASE: Record<string, number>; readonly OTHER_TOPICS: ProtoTopic[];
  readonly OTHER_ITEMS: ProtoItem[]; readonly CHARGE_MSGS: ProtoMessage[]; readonly TOPIC_SESSIONS: Record<string, string[]>;
}
const dataNames = ['TOPICS', 'ITEMS', 'DEMO', 'MSGS', 'EARLIER_TOPICS', 'EARLIER_MSGS', 'EARLIER_ITEMS', 'ARCHIVED_TOPICS', 'ARCHIVED_ITEMS',
  'PROJECTS', 'PROJECT_SESSIONS', 'SESSION_BASE', 'OTHER_TOPICS', 'OTHER_ITEMS', 'CHARGE_MSGS', 'TOPIC_SESSIONS'] as const;

/** Evaluates the prototype's data constants from the text of Ariadne.dc.html. */
export function prototypeData(html: string): PrototypeData {
  const start = html.indexOf('const TOPICS = ['), end = html.indexOf('const CLOSED = ');
  if (start < 0 || end < start) throw new Error('Ariadne.dc.html no longer holds the prototype data block');
  // The block is plain data and arrow helpers from the immutable handoff archive.
  return new Function(`${html.slice(start, end)}\nreturn { ${dataNames.join(', ')} };`)() as PrototypeData;
}

// The prototype's day: Wednesday 7 Oct 2026 in UTC; its clock starts at 15:06 (Ariadne.dc.html:915).
const day0 = designNow - designNow % 86_400_000;
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const at = (daysAgo: number, hhmm: string) => new Date(day0 - daysAgo * 86_400_000 + minutes(hhmm) * 60_000).toISOString();
const fmt = (clock: number) => `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
const uuid = (kind: 'a' | 'b' | 'c' | 'd' | 'e' | 'f', n: number) => `00000000-0000-4000-8000-${kind}${String(n).padStart(11, '0')}`;
const page = <T,>(items: T[], revision = 1): Page<T> => ({ items, next_cursor: null, snapshot_revision: revision });
const statusOf: Record<ProtoItem['status'], ItemStatus> = { open: 'open', waiting: 'waiting_on_me', progress: 'in_progress', decided: 'decided', done: 'done', dropped: 'dropped', replaced: 'replaced' };
const closedStatus = new Set(['decided', 'done', 'dropped', 'replaced']);
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Today 14:02 – now", "3 days ago · 10:15 – 11:02", "Last week · Tue 15:30 – 16:45" -> start and end. */
function sessionTimes(range: string): { created: string; ended: string | null } {
  const [, start, end] = range.match(/(\d\d:\d\d) – (\d\d:\d\d|now)$/)!;
  const daysAgo = range.startsWith('Today') ? 0 : range.startsWith('Yesterday') ? 1 : range.startsWith('Last week')
    ? 7 + new Date(day0).getUTCDay() - weekdays.indexOf(range.match(/· (\w{3}) /)![1]) : Number(range.match(/^(\d+) days ago/)![1]);
  return { created: at(daysAgo, start), ended: end === 'now' ? null : at(daysAgo, end) };
}

/** The prototype scenario's world (Ariadne.dc.html:904-970). */
function scenarioWorld(spec: FrameSpec, data: PrototypeData) {
  const project = spec.scenario !== 'default', blank = spec.state === 'empty' || spec.state === 'loading';
  const topics = project ? [...data.EARLIER_TOPICS, ...data.TOPICS, ...data.ARCHIVED_TOPICS, ...data.OTHER_TOPICS] : data.TOPICS;
  const items: ProtoItem[] = blank ? [] : structuredClone(project ? [...data.EARLIER_ITEMS, ...data.ITEMS, ...data.ARCHIVED_ITEMS, ...data.OTHER_ITEMS] : data.ITEMS);
  const msgs: ProtoMessage[] = blank ? [] : structuredClone(project ? [...data.EARLIER_MSGS, ...data.CHARGE_MSGS, ...data.MSGS] : data.MSGS);
  let clock = 15 * 60 + 6;
  if (spec.state === 'clear') {
    items.filter(item => item.status === 'waiting').sort((a, b) => a.created - b.created).forEach(item => {
      const choice = item.options!.findIndex(option => option.rec), reply = data.DEMO[item.id][choice], n = msgs.length + 1;
      msgs.push({ number: n, author: 'me', time: fmt(++clock), excerpt: item.options![choice].label });
      msgs.push({ number: n + 1, author: 'agent', time: fmt(++clock), excerpt: reply.reply });
      item.status = reply.status; item.outcome = reply.outcome; item.updated.push(n, n + 1);
    });
  }
  const sessions = project ? data.PROJECT_SESSIONS : [data.PROJECT_SESSIONS[0]];
  const projects = project ? data.PROJECTS : [data.PROJECTS[0]];
  // The prototype keeps the archive per project ("kept for every session",
  // Ariadne.dc.html:1766); the domain archives per session, so archived topics
  // sit in the session whose archive the frame shows.
  const sessionOf = (topic: ProtoTopic) => topic.archived ? 's2' : (data.TOPIC_SESSIONS[topic.id] ?? ['s2']).at(-1)!;
  const selectedTopic = items.find(item => item.id === spec.selected)?.topic;
  const autoTab = selectedTopic && project ? sessionOf(topics.find(topic => topic.id === selectedTopic)!) : null;
  const tab = ({ sessions: 'all', session: 's1', projects: 'home', projectpage: 'home' } as Record<string, string>)[spec.scenario] ?? (autoTab && autoTab !== 's2' ? autoTab : 's2');
  const openTabs = ({ sessions: ['s2', 's1', 'c1'], projects: ['s2', 's1', 'c1'], projectpage: ['s2', 's1'], session: ['s2', 's1'], project: ['s2', 's1'],
    archive: ['s2', 's1'] } as Record<string, string[]>)[spec.scenario] ?? ['s2'];
  return { topics, items, msgs, sessions, projects, sessionOf, tab, openTabs, now: new Date(designNow).toISOString() };
}

const counts = (sessions: readonly Session[]): SummaryCounts => {
  const value: SummaryCounts = { items_by_status: { open: 0, waiting_on_me: 0, in_progress: 0, decided: 0, done: 0, dropped: 0, replaced: 0 },
    waiting_unanswered: 0, sent_inputs: { queued: 0, in_flight: 0, needs_attention: 0 }, archived_topics: 0, completeness: 'complete', unavailable_session_ids: [] };
  for (const session of sessions) {
    for (const item of Object.values(session.items)) {
      if (!item || session.topics[item.topic_id]?.archived_at !== null) continue;
      value.items_by_status[item.status]++;
      if (item.status === 'waiting_on_me') value.waiting_unanswered++;
    }
    value.archived_topics += Object.values(session.topics).filter(topic => topic && topic.archived_at !== null).length;
  }
  return value;
};

export interface DesignFixture {
  readonly spec: FrameSpec;
  /** The session tab the frame shows, or null for Projects and All sessions. */
  readonly route: SessionRef | null;
  readonly transport: DesignTransport;
}

/** Builds the frame's application state; throws "fixture not written" for frames without one. */
export function designFixture(frame: string, data: PrototypeData): DesignFixture {
  const spec = frameSpec(frame), world = scenarioWorld(spec, data);
  const projectIds = new Map(world.projects.map((project, index) => [project.id, uuid('a', index + 1)]));
  const refs = new Map(world.sessions.map((session, index) => [session.id, { project_id: projectIds.get(session.project)!, session_id: uuid('b', index + 1) }]));
  const messageIds = new Map(world.msgs.map(message => [message.number, uuid('d', message.number)]));
  const messageTimes = new Map(world.msgs.map(message => [message.number, at(message.day === 'Yesterday' ? 1 : 0, message.time)]));
  const sessions = world.sessions.map((proto, index): Session => {
    const ref = refs.get(proto.id)!, times = sessionTimes(proto.range), bindingId = uuid('e', index + 1);
    const binding: Binding = { ...structuredClone(demo.bindings['00000000-0000-4000-8000-000000000020']) as Binding, id: bindingId,
      adapter_id: proto.agent === 'claude-code' ? 'claude_code_mod' : proto.agent, external_session_id: `${proto.id}-thread`, generation: uuid('f', index + 1),
      created_at: times.created, dispatch_state: proto.running ? 'enabled' : 'disconnected', connection_state: proto.running ? 'connected' : 'disconnected',
      active_input_id: null, issued_through_message_number: 0 };
    const topics = world.topics.filter(topic => world.sessionOf(topic) === proto.id);
    const topicIds = new Map(topics.map(topic => [topic.id, uuid('c', world.topics.indexOf(topic) + 1)]));
    const protoItems = world.items.filter(item => topicIds.has(item.topic));
    const protoMessages = world.msgs.filter(message => (message.session ?? 's2') === proto.id);
    const touched = (number: number) => protoItems.filter(item => item.created === number || item.updated.includes(number)).map(item => item.id);
    const messages = protoMessages.map((message): Message => {
      const items = touched(message.number), first = protoItems.find(item => item.id === items[0]);
      return { id: messageIds.get(message.number)!, number: message.number - (data.SESSION_BASE[proto.id] ?? 0),
        author: message.author === 'me' ? 'owner' : 'agent', kind: message.author === 'me' ? 'owner_input' : 'reply', body: message.excerpt,
        created_at: messageTimes.get(message.number)!, item_id: message.author === 'me' ? items[0] ?? null : null, topic_id: first ? topicIds.get(first.topic)! : null,
        items_touched: items, binding_id: bindingId, input_id: null, attempt_id: null, host_turn_id: null, round_id: null, origin: null };
    });
    const items = Object.fromEntries(protoItems.map((proto): [string, Item] => {
      const siblings = protoItems.filter(item => item.parent === proto.parent && item.topic === proto.topic);
      const created = messageTimes.get(proto.created) ?? times.created, status = statusOf[proto.status];
      return [proto.id, { id: proto.id, ordinal: siblings.indexOf(proto) + 1, topic_id: topicIds.get(proto.topic)!, parent: proto.parent, question: proto.q,
        type: proto.type, status, owner: proto.owner === 'me' ? { kind: 'me' } : proto.owner === 'agent' ? { kind: 'agent', binding_id: bindingId } : { kind: 'other', name: proto.owner },
        revision: 1 + proto.updated.length, question_revision: 1, next_child: protoItems.filter(item => item.parent === proto.id).length + 1,
        ask: proto.ask || null, note: proto.note || null,
        options: (proto.options ?? []).map(option => ({ id: option.id, label: option.label, consequence: option.consequence, recommended: !!option.rec })),
        // ItemLinkTarget has no display meta; the label is the path or PR it names.
        links: proto.links.map(link => ({ kind: link.kind, label: link.label, target: link.label })),
        outcome: proto.outcome || null, why: proto.why || null, replaced_by: proto.replacedBy ?? null,
        created_at: created, updated_at: messageTimes.get(proto.updated.at(-1) ?? -1) ?? created,
        created_message_id: messageIds.get(proto.created) ?? uuid('d', 0), updated_message_ids: proto.updated.flatMap(number => messageIds.get(number) ?? []),
        status_history: [], waiting_since: status === 'waiting_on_me' ? created : null, recipient_binding_id: status === 'waiting_on_me' ? bindingId : null,
        current_round_id: null, source_round_id: null, origin: null }];
    }));
    return { schema_version: 1, id: ref.session_id, project_id: ref.project_id, title: `${proto.agent} · ${proto.when}`, state: proto.status,
      created_at: times.created, updated_at: messages.at(-1)?.created_at ?? times.ended ?? times.created, revision: 1,
      closed_at: proto.status === 'closed' ? times.ended ?? times.created : null,
      counters: { next_root: protoItems.filter(item => item.parent === null).length + 1, next_topic_order: topics.length + 1,
        next_message: Math.max(0, ...messages.map(message => message.number)) + 1, next_input: 1, next_answer: 1 },
      active_binding_id: bindingId,
      topics: Object.fromEntries(topics.map((topic, order): [string, Topic] => [topicIds.get(topic.id)!, { id: topicIds.get(topic.id)!, name: topic.name,
        order: order + 1, revision: 1, created_at: times.created, archived_at: topic.archived ? times.created : null, origin: null }])),
      items, messages, rounds: {}, answers: [], bindings: { [bindingId]: binding }, inputs: {}, operation_receipts: {}, continuations: {} };
  });
  const summaries = sessions.map((session, index): SessionSummary => {
    const binding = session.bindings[session.active_binding_id!]!, running = world.sessions[index].running;
    return { project_id: session.project_id, session_id: session.id, title: session.title, state: session.state, revision: session.revision,
      created_at: session.created_at, updated_at: session.updated_at, closed_at: session.closed_at, counts: counts([session]),
      topic_count: Object.keys(session.topics).length,
      active_binding: { id: binding.id, adapter_id: binding.adapter_id, external_session_id: binding.external_session_id, generation: binding.generation,
        dispatch_state: binding.dispatch_state, owner_paused: false, pause_reason: null, connection_state: binding.connection_state,
        presence: running ? { instance_id: uuid('f', 100 + index), generation: binding.generation, connection_state: 'connected', execution_state: 'running',
          last_seen_at: world.now, source: 'host_event', process_identity: null, freshness: 'fresh' } : null } };
  });
  const projects = world.projects.map((project): ProjectSummary => ({ project_id: projectIds.get(project.id)!,
    project: { schema_version: 1, id: projectIds.get(project.id)!, display_name: project.name }, canonical_root: project.path, availability: 'available',
    counts: counts(sessions.filter(session => session.project_id === projectIds.get(project.id))) }));
  const route = refs.get(world.tab) ?? null;
  const expanded = (session: Session) => {
    const ids = new Set<string>(), items = Object.values(session.items).filter(item => !!item);
    const descendants = (id: string): Item[] => items.filter(item => item.parent === id).flatMap(item => [item, ...descendants(item.id)]);
    for (const item of items) {
      const below = descendants(item.id);
      if (below.length && !(closedStatus.has(item.status) && below.every(value => closedStatus.has(value.status)))) ids.add(item.id);
    }
    for (const id of [spec.selected, spec.answering]) for (let parent = id && session.items[id]?.parent; parent; parent = session.items[parent]?.parent) ids.add(parent);
    return [...ids];
  };
  const transport = new DesignTransport(sessions, projects, summaries, spec.state === 'loading' ? route : null);
  transport.preferences.global = { theme: spec.theme, window: null, pinned: false, notification_watermark: null,
    selected_navigation: spec.scenario === 'sessions' ? { kind: 'all_sessions' } : spec.scenario === 'projects' ? { kind: 'projects' }
      : spec.scenario === 'projectpage' ? { kind: 'project', project_id: projectIds.get('payments')! } : { kind: 'session', session: route! } };
  transport.preferences.sessions = world.openTabs.map((id, order): SessionPreferences => {
    const session = sessions.find(value => value.id === refs.get(id)!.session_id)!, current = id === world.tab;
    return { session: refs.get(id)!, tab_open: true, tab_order: order, selected_item_id: current ? spec.selected ?? null : null, expanded_item_ids: expanded(session),
      filters: { search: '', statuses: [], owners: [], topic_id: null, archived: current && spec.scenario === 'archive', hide_later: false },
      rail: current && spec.rail ? 'activity' : 'hidden', scroll: null };
  });
  return { spec, route, transport };
}

/** Serves the frame's sessions and catalogue; preference writes go to AppTransport. */
export class DesignTransport extends AppTransport {
  constructor(sessions: readonly Session[], private readonly projects: readonly ProjectSummary[], private readonly summaries: readonly SessionSummary[],
    private readonly hang: SessionRef | null) {
    super();
    this.sessions.clear();
    for (const session of sessions) this.sessions.set(session.id, session);
  }
  override async invoke<T>(name: string, args: { request: OwnerQueryRequest | OwnerMutationRequest }): Promise<T> {
    const { request } = args;
    if ('command' in request) return super.invoke(name, args);
    assertOwnerWire(request);
    this.queries.push(structuredClone(request));
    // The loading frame: the session read never completes.
    if (request.request.command === 'session_get' && request.session?.session_id === this.hang?.session_id) return new Promise<T>(() => {});
    return { api_version: 1, ok: true, data: { kind: name, data: structuredClone(this.answer(request)) } } as T;
  }
  private answer(request: OwnerQueryRequest): unknown {
    const query = request.request;
    if (query.command === 'preferences_get') return this.preferences;
    if (query.command === 'project_list') return { projects: page([...this.projects]), counts: counts([...this.sessions.values()]) };
    if (query.command === 'session_list') {
      const listed = this.summaries.filter(summary => (query.params.project_id === null || summary.project_id === query.params.project_id)
        && (query.params.state === null || summary.state === query.params.state));
      return { sessions: page(listed), counts: counts(listed.map(summary => this.sessions.get(summary.session_id)!)),
        active_total: listed.filter(summary => summary.state === 'active').length, closed_total: listed.filter(summary => summary.state === 'closed').length };
    }
    const session = this.sessions.get(request.session!.session_id)!;
    if (query.command === 'session_get') return { session, freshness: 'fresh' };
    if (query.command === 'reveal_item') return { ...request.session, item_id: query.params.item_id };
    if (query.command === 'item_messages') {
      const item = session.items[query.params.item_id];
      return { item_id: query.params.item_id, messages: page(session.messages.filter(message => message.item_id === query.params.item_id
        || message.items_touched.includes(query.params.item_id)), session.revision),
      timeline_context: { parent_item_id: item?.parent ?? null, created_message: session.messages.find(message => message.id === item?.created_message_id) ?? null, source_round_id: null } };
    }
    if (query.command === 'item_rounds') return { item_id: query.params.item_id, rounds: page([], session.revision) };
    if (query.command === 'session_read') {
      const selection = query.params.selection;
      if (selection.view === 'messages') return { view: 'messages', page: page(session.messages, session.revision) };
      if (selection.view === 'topics') return { view: 'topics', page: page(Object.values(session.topics).filter(topic => !!topic), session.revision) };
      if (selection.view === 'inputs') return { view: 'inputs', page: page([], session.revision) };
      const items = Object.values(session.items).filter(item => !!item && (selection.filters.item_id === null || item.id === selection.filters.item_id));
      return { view: 'items', page: page(items.map(value => {
        const item: Partial<Item> = { ...value }; Reflect.deleteProperty(item, 'status_history'); Reflect.deleteProperty(item, 'updated_message_ids');
        return { item, updated_messages: page(session.messages.filter(message => value!.updated_message_ids.includes(message.id)), session.revision),
          status_history: page([], session.revision) };
      }), session.revision) };
    }
    throw new Error(`Unexpected query ${query.command}`);
  }
}
