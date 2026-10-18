// A final-board state's AppFixture (final-frames.ts) -> the application state behind the real DesktopApp, built on
// the handoff harness (fixtures.ts buildFixture) from the board's mock world (final-world.ts). Sessions, items,
// questions and drafts come from the state's spec; what the app cannot yet be put in by data (the board's new
// chrome: a folded Details, the connection lines, the switcher) is reached by the spec's `act` steps, which the
// builder who turns `pending` off writes against the new app.
import type { OwnerDraft } from '../../../apps/desktop/src/generated/core';
import type { ProjectSummary, SessionSummary } from '../../../apps/desktop/src/generated/domain/models';
import { buildFixture, type DesignFixture, type PrototypeData, type ProtoItem, type ProtoMessage, type ProtoSession, type ProtoTopic } from './fixtures';
import type { FrameSpec, Scenario } from './frames';
import { finalNow, variants, type AppFixture, type FinalState, type Variant } from './final-frames';
import type { Item, ItemChangeBefore, ItemChangeRecord, ItemOption } from '../../../apps/desktop/src/generated/domain/models';
import { archivedSessions, archivedTopic, becauseRecords, brief, changeRecords, conversations, createdAfter, createdBefore, items as worldItems, longAbsenceSince, longText, markSets, others,
  projects, Q1, Q2, q2Body, relations, seenAt, sessions as worldSessions, topicName, topicShort, viewed, type WChange, type WItem } from './final-world';

const statusOf = { decided: 'decided', done: 'done', in_progress: 'progress', open: 'open', waiting_on_me: 'waiting', replaced: 'replaced' } as const;
const typeOf = (item: WItem): ProtoItem['type'] => item.kind === 'task' ? 'task' : item.kind === 'finding' ? 'finding' : item.kind === 'explanation' ? 'explanation'
  : item.s === 'decided' ? 'decision' : item.q.endsWith('?') ? 'question' : 'task';
const uuid = (n: number) => `00000000-0000-4000-8000-f${String(n).padStart(11, '0')}`;

interface Flat { readonly item: WItem; readonly parent: string | null }
function flatten(nodes: readonly WItem[], parent: string | null, keep: (item: WItem) => boolean, out: Flat[] = []): Flat[] {
  for (const item of nodes) { if (!keep(item)) continue; out.push({ item, parent }); flatten(item.kids ?? [], item.k, keep, out); }
  return out;
}

/** The prototype-shaped world of one state: the topic's items and messages, the other sessions' waiting questions, the projects and sessions. */
function worldData(app: AppFixture): PrototypeData {
  const edit = app.items?.edit ?? {};
  const flat = flatten(worldItems, null, item => !item.afterAnswer || !!app.items?.afterAnswer);
  // Messages in time order; an item's first message creates it, the rest update it.
  const raw: { time: string; order: number; who: 'agent' | 'me'; text: string; item: string }[] = [];
  flat.forEach(({ item }, index) => {
    const lines = conversations[item.k] ?? [{ who: 'agent' as const, time: item.raised ?? `20:${String(10 + (index % 40)).padStart(2, '0')}`, text: item.q }];
    lines.forEach(line => raw.push({ ...line, order: raw.length, item: item.k }));
  });
  raw.sort((a, b) => a.time.localeCompare(b.time) || a.order - b.order);
  const numbers = new Map(raw.map((line, at) => [line, at + 1]));
  const MSGS: ProtoMessage[] = raw.map(line => ({ number: numbers.get(line)!, author: line.who, time: line.time, excerpt: line.text }));
  const numbersOf = (key: string) => raw.filter(line => line.item === key).map(line => numbers.get(line)!);
  const ITEMS: ProtoItem[] = flat.map(({ item, parent }): ProtoItem => {
    const changed = { ...item, ...edit[item.k] }, [created = 0, ...updated] = numbersOf(item.k);
    const long = app.items?.longText ? (longText as Record<string, { q?: string; o?: string }>)[item.k] : undefined;
    return { id: item.k, topic: 't1', parent, short: item.short, type: typeOf(item), status: statusOf[changed.s], owner: changed.s === 'waiting_on_me' ? 'me' : 'agent',
      q: long?.q ?? changed.q, outcome: long?.o ?? changed.o ?? '', why: changed.why ?? '', ...(item.ask ? { ask: item.ask } : {}),
      // The second question's long body (SPEC 5.2, 2.3): the dock draws it between the question and the options.
      ...(item.k === Q2 ? { note: q2Body.join('\n\n') } : {}), created, updated, links: [],
      ...(item.options ? { options: item.options.map((option, at) => ({ id: `option-${at + 1}`, label: option.label, consequence: option.consequence, ...(option.recommended ? { rec: true } : {}) })) } : {}),
      ...(changed.s === 'waiting_on_me' ? { waitingSince: created } : {}) };
  });
  // Questions waiting in the other sessions: one topic each, numbered apart from this session's messages.
  const TOPICS: ProtoTopic[] = [{ id: 't1', name: topicName, short: topicShort }];
  const OTHER_TOPICS: ProtoTopic[] = [{ id: 't2', name: 'Migration review', short: 'migration' }, { id: 't3', name: 'Editor tests', short: 'editor tests' }];
  const OTHER_ITEMS: ProtoItem[] = [], SYNC_MSGS: ProtoMessage[] = [], SESSION_BASE: Record<string, number> = { s1: 1000, s3: 2000 };
  others.forEach((other, at) => {
    const number = SESSION_BASE[other.session]! + at + 1;
    const edited = app.questions?.othersSent ? 'open' : 'waiting';
    SYNC_MSGS.push({ number, author: 'agent', time: other.raised, excerpt: other.q, session: other.session });
    OTHER_ITEMS.push({ id: other.k, topic: other.session === 's1' ? 't2' : 't3', parent: null, short: other.short, type: 'question', status: edited, owner: 'me', q: other.q, outcome: '', why: '',
      created: number, updated: [], links: [], waitingSince: number, options: other.options.map((option, index) => ({ id: `option-${index + 1}`, label: option.label, consequence: option.consequence, ...(option.recommended ? { rec: true } : {}) })) });
  });
  const connection = app.sessions?.connection;
  const running = (id: string, value: boolean) => id === (app.sessions?.current ?? 's2') && (connection === 'none' || connection === 'off' || connection === 'closed') ? false : value;
  const PROJECT_SESSIONS: ProtoSession[] = worldSessions.map(session => ({ id: session.id, project: session.project, agent: session.agent, where: session.where, when: session.range, range: session.range,
    running: running(session.id, session.running), status: session.id === (app.sessions?.current ?? 's2') && connection === 'closed' ? 'closed' : session.status, msgs: 4,
    ...(app.sessions?.unnamed && session.id === 's2' ? {} : { name: session.name }) }));
  const first = app.chrome?.page === 'first';
  return { TOPICS, ITEMS, DEMO: {}, MSGS, EARLIER_TOPICS: [], EARLIER_MSGS: [], EARLIER_ITEMS: [], ARCHIVED_TOPICS: [], ARCHIVED_ITEMS: [],
    PROJECTS: first ? [] : projects.map(project => ({ id: project.id, name: project.name, path: project.path, last: project.last })), PROJECT_SESSIONS: first ? [] : PROJECT_SESSIONS, SESSION_BASE,
    OTHER_TOPICS, OTHER_ITEMS, SYNC_MSGS, TOPIC_SESSIONS: { t1: ['s2'], t2: ['s1'], t3: ['s3'] },
    REVIEW_TOPIC: TOPICS[0]!, REVIEW_ITEMS: [], REVIEW_MSGS: [], THREAD_MSGS: [], THREAD_PATCH: {}, THREAD_KIDS: [] };
}

const pageScenario: Readonly<Record<NonNullable<NonNullable<AppFixture['chrome']>['page']>, Scenario>> = {
  // The Archive page opens from the Map (its state's `act`); the handoff's 'archive' scenario is a session's archived-topic view.
  projects: 'projects', sessions: 'sessions', archive: 'project', first: 'first', 'project-empty': 'projectpage'
};

/** The harness spec of the state: what the old gallery reads (selection, view, clock) from the AppFixture. */
export function finalSpec(state: Pick<FinalState, 'id' | 'app'>, variant: Variant): FrameSpec {
  const { app } = state, { theme, width, height } = variants[variant], view = app.view ?? {};
  const page = app.chrome?.page;
  const picked = (key: string) => app.drafts?.find(draft => draft.item === key)?.pick ?? 0;
  const submissions = [...(app.questions?.sent ?? []).map(item => ({ item, choice: picked(item), stage: 'received' as const })),
    ...(app.questions?.failed ?? []).map(item => ({ item, choice: picked(item), stage: 'failed' as const }))];
  const folded = ['h1', ...(app.items?.hidden ?? [])];
  // Board screen 2 lights the open dock question's Map row without Details. In the app the dock never selects in the
  // Map (a selection opens Details and takes its question out of the dock), so that row is not selected.
  const lit = view.dock === 'open' && (view.selected === Q1 || view.selected === Q2);
  const selected = lit ? undefined : view.selected ?? undefined;
  return { id: `final-${state.id}`, width, height, theme, scenario: page ? pageScenario[page] : 'project',
    state: app.items?.empty ? 'empty' : app.sessions?.connection === 'loading' ? 'loading' : 'ready',
    ...(selected ? { selected } : {}), ...(selected && (view.details ?? 'open') !== 'folded' ? { detail: true } : {}), ...(view.mode === 'graph' ? { view: 'graph' as const } : {}),
    foldedItems: folded, now: finalNow, submissions, ...(page === 'project-empty' ? { projectPage: 'site' } : {}),
    ...(app.sessions?.connection === 'reconnecting' ? { reconnecting: true } : {}) };
}

/** The board's clock day at `hhmm` (UTC, as the app context runs). */
const today = (hhmm: string) => new Date(Date.UTC(2026, 9, 7, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)))).toISOString();

/**
 * What the pages read that the handoff world has no field for (SPEC 14.1–14.3, 15.2): the current session is the one a
 * page returns to (the newest-opened view), each project's last activity, rate limits' queued message, and the
 * Archive's three sessions and one topic.
 */
function pageWorld(fixture: DesignFixture, app: AppFixture): void {
  const transport = fixture.transport;
  // DesignTransport keeps the catalogue it answers session_list and project_list from; the pages read it as is.
  const { summaries, projects: listedProjects } = transport as unknown as { readonly summaries: SessionSummary[]; readonly projects: readonly ProjectSummary[] };
  const summaryOf = (name: string) => summaries.find(summary => summary.title === name);
  const projectOf = (id: string) => listedProjects.find(project => project.project?.display_name === projects.find(value => value.id === id)?.name)!;
  const currentName = worldSessions.find(session => session.id === (app.sessions?.current ?? 's2'))?.name;
  const current = currentName ? summaryOf(currentName) : undefined, views = transport.preferences.sessions;
  if (current && views.some(view => view.session.session_id === current.session_id)) {
    const newest = Math.max(...views.map(view => view.tab_order)) + 1;
    transport.preferences.sessions = views.map(view => view.session.session_id === current.session_id ? { ...view, tab_order: newest } : view);
  }
  for (const project of projects) {
    if (!/^\d\d:\d\d$/.test(project.last)) continue;
    const id = projectOf(project.id).project_id;
    const newest = summaries.filter(summary => summary.project_id === id && summary.archived_at == null)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
    if (newest) newest.updated_at = today(project.last);
  }
  const queued = summaryOf(worldSessions.find(session => session.status_line.endsWith('queued'))!.name);
  if (queued) queued.counts = { ...queued.counts, sent_inputs: { ...queued.counts.sent_inputs, queued: 1 } };
  // The archived sessions: closed, archived, their counts carried on the summary (no items load from them).
  archivedSessions.forEach((archived, at) => {
    const source = summaries.find(summary => summary.active_binding?.adapter_id === (archived.agent === 'codex' ? 'codex' : 'claude_code_mod')) ?? summaries[0]!;
    const sessionId = `00000000-0000-4000-8000-a${String(900 + at).padStart(11, '0')}`, projectId = projectOf(archived.project).project_id;
    const session = structuredClone(transport.sessions.get(source.session_id)!);
    Object.assign(session, { id: sessionId, project_id: projectId, title: archived.name, state: 'closed', closed_at: archived.archived, archived_at: archived.archived,
      created_at: archived.archived, updated_at: archived.archived, items: {}, topics: {}, messages: [], answers: [], rounds: {}, inputs: {}, operation_receipts: {} });
    transport.sessions.set(sessionId, session);
    const none = { open: 0, waiting_on_me: 0, in_progress: 0, decided: 0, done: 0, dropped: 0, replaced: 0 };
    summaries.push({ ...structuredClone(source), session_id: sessionId, project_id: projectId, title: archived.name, state: 'closed', closed_at: archived.archived,
      archived_at: archived.archived, created_at: archived.archived, updated_at: archived.archived, topic_count: archived.topics,
      counts: { ...source.counts, items_by_status: { ...none, done: archived.items }, waiting_unanswered: 0, sent_inputs: { queued: 0, in_flight: 0, needs_attention: 0 } },
      active_binding: source.active_binding && { ...source.active_binding, presence: null } });
  });
  // The archived topic: a topic of its session with its items, archived today.
  const owner = summaryOf(worldSessions.find(session => session.id === archivedTopic.session)!.name), session = owner && transport.sessions.get(owner.session_id);
  const done = session && Object.values(session.items).find(item => item?.status === 'done');
  if (owner && session && done) {
    const topicId = `00000000-0000-4000-8000-a${String(990).padStart(11, '0')}`;
    session.topics[topicId] = { id: topicId, name: archivedTopic.name, short: archivedTopic.short, order: Object.keys(session.topics).length + 1, revision: 1,
      created_at: session.created_at, archived_at: today(archivedTopic.archived), origin: null };
    for (let n = 1; n <= archivedTopic.items; n++) {
      const id = String(900 + n);
      session.items[id] = { ...structuredClone(done), id, topic_id: topicId, parent: null };
    }
    owner.topic_count += 1;
    owner.counts = { ...owner.counts, archived_topics: owner.counts.archived_topics + 1 };
  }
}

/**
 * The reading state of the alpha.20 Map (`AppFixture.map`): findings to ack, related and dependent items, the topic brief, the owner's
 * recent trail, the saved filter and focus, and, for `marks`, a seen baseline at 20:40 with the change records behind each Changed row.
 * - An item is New when it was created after the baseline and is not in the baseline's list; it is Changed when a record that is not a
 *   reword is newer than the baseline and than the revision the list holds. So the baseline lists every item at its current revision,
 *   leaves the New ones out, and holds each Changed one a revision back.
 * - Records are written whole (revision, time, the fields' "before" values) and move the item's revision up by their number.
 */
function mapWorld(fixture: DesignFixture, app: AppFixture): void {
  const map = app.map, route = fixture.route;
  if (!map || !route) return;
  const transport = fixture.transport, session = transport.sessions.get(route.session_id)!;
  const itemOf = (id: string): Item | undefined => session.items[id] ?? undefined;
  // A finding or explanation the owner has not acked: open, with the status it moves to once acked.
  for (const { item } of flatten(worldItems, null, () => true)) {
    const found = itemOf(item.k);
    if (item.ack && found) Object.assign(found, { status: 'open', ack_to: 'done' });
  }
  for (const [from, to, kind] of relations) {
    const found = itemOf(from);
    if (found) found[kind] = [...found[kind] ?? [], to];
  }
  const topic = Object.values(session.topics).find(value => value?.name === topicName);
  if (topic) Object.assign(topic, { brief: brief.text, brief_updated_at: today(brief.at) });
  if (map.marks) {
    const options = (list: readonly { label: string; consequence: string; recommended?: boolean }[]): ItemOption[] =>
      list.map((option, at) => ({ id: `option-${at + 1}`, label: option.label, consequence: option.consequence, recommended: !!option.recommended }));
    const before = ({ options: list, ...rest }: WChange['before']): ItemChangeBefore => ({ ...rest, ...(list ? { options: options(list) } : {}) });
    for (const item of Object.values(session.items)) {
      if (!item) continue;
      const wanted: readonly WChange[] = [...changeRecords[item.id] ?? [], ...map.marks === 'because' ? becauseRecords[item.id] ?? [] : []];
      if (wanted.length) {
        const first = item.revision;
        item.changes = wanted.map((record, at): ItemChangeRecord => ({ revision: first + at + 1, at: today(record.at), cause_message_id: item.created_message_id,
          ...(record.reason ? { reason: record.reason } : {}), ...(record.wording ? { wording_only: true } : {}), before: before(record.before) }));
        item.revision = first + wanted.length;
      }
      const early = createdBefore[item.id] ?? createdAfter[item.id];
      if (early) item.created_at = today(early);
    }
    const marks = markSets[map.marks], seen = new Set(map.seen ?? []);
    const isNew = (id: string) => (marks.new as readonly string[]).includes(id) && !seen.has(id);
    const isChanged = (id: string) => (marks.changed as readonly string[]).includes(id) && !seen.has(id);
    transport.preferences.seen = [{ session: { project_id: route.project_id, session_id: route.session_id },
      since: map.marks === 'long' ? longAbsenceSince : today(seenAt), topics: [],
      items: Object.values(session.items).flatMap(item => !item || isNew(item.id) ? [] : [{ item_id: item.id, revision: isChanged(item.id) ? Math.max(1, item.revision - 1) : item.revision }]) }];
  }
  transport.preferences.sessions = transport.preferences.sessions.map(view => view.session.session_id !== route.session_id ? view : {
    ...view, recent_items: viewed.map(([item_id, at]) => ({ item_id, action: 'viewed' as const, visited_at: today(at) })),
    ...(map.focus ? { focused_item_id: map.focus } : {}),
    filters: { ...view.filters, ...(map.filter ? { statuses: [...map.filter] } : {}) } });
}

/**
 * The bin (10.1, 10.11, 11.3): the agent removed each `binned` item, and what is below it, at 21:19. Each removal leaves the receipt notice
 * 11.3 reads, and the owner's unsent message on the item that it cancelled (its words stay in the bin).
 */
function binWorld(fixture: DesignFixture, app: AppFixture, id: string): void {
  const binned = app.items?.binned ?? [], route = fixture.route;
  if (!binned.length || !route) return;
  const session = fixture.transport.sessions.get(route.session_id)!, binding = session.bindings[session.active_binding_id!]!, removedAt = today('21:19');
  const under = (root: string, itemId: string): boolean => {
    for (let at: string | null = itemId; at; at = session.items[at]?.parent ?? null) if (at === root) return true;
    return false;
  };
  binned.forEach((entry, at) => {
    const item = session.items[entry.item];
    if (!item) throw new Error(`final ${id}: binned item that is not in the session: ${entry.item}`);
    const messageId = uuid(200 + at * 4), inputId = uuid(201 + at * 4), operationId = uuid(202 + at * 4);
    item.removed_at = removedAt; item.removed_by = { binding_id: binding.id, message_id: messageId };
    if (entry.words) {
      session.inputs[inputId] = { id: inputId, seq: session.counters.next_input++, binding_id: binding.id, kind: 'reply',
        target: { topic_id: item.topic_id, item_id: item.id }, message_id: uuid(203 + at * 4), answer_id: null, created_at: today('21:12'), expected_question_revision: null,
        payload: { text: entry.words, intent: 'reply', selected_option_id: null,
          target_snapshot: { topic_name: session.topics[item.topic_id]!.name, item_question: item.question, question_revision: item.question_revision, ask: null, options: [] },
          context: { message_ids: [], item_ids: [item.id], round_id: null, continuation_operation_id: null } },
        state: 'cancelled', cancel_cause: 'agent_removed', attempts: [], active_attempt_id: null, resolution_history: [] };
    }
    session.operation_receipts[operationId] = [{ operation_id: operationId, actor_scope: { kind: 'agent', binding_id: binding.id }, command_digest: 'a'.repeat(64),
      result: { operation_id: operationId, session_id: session.id, revision: session.revision, data: { kind: 'apply',
        agent_removals: [{ topic_id: item.topic_id, item_id: item.id, message_id: messageId, item_ids: Object.keys(session.items).filter(key => under(item.id, key)),
          waiting_questions: 0, cancelled_input_ids: entry.words ? [inputId] : [] }],
        allocated_refs: {}, messages: [], item_revisions: {}, topic_revisions: {}, input_result_state: null, queue_join_state: null } } }];
  });
}

/** The app's state for one final-board state at one size: sessions and items from the world, the drafts typed in. */
export function finalFixture(state: Pick<FinalState, 'id' | 'app'>, variant: Variant): DesignFixture {
  const spec = finalSpec(state, variant), fixture = buildFixture(spec, worldData(state.app));
  // The board draws at the default text size (SPEC §1: --text-scale 0.8); the handoff harness pins 100%.
  fixture.transport.preferences.global.text_scale = 80;
  // 12.7: the open session's file can't be read from the start, so there is no read at all; 12.8 loses it after a good read (`drive`).
  fixture.transport.unreadable = fixture.route;
  if (state.app.sessions?.connection === 'unreadable') fixture.transport.failReads = true;
  // First run has no projects, so nothing of the pages' world applies.
  if (state.app.chrome?.page && state.app.chrome.page !== 'first') pageWorld(fixture, state.app);
  const drafts = state.app.drafts ?? [];
  if (!fixture.route) return fixture;
  const route = fixture.route, session = fixture.transport.sessions.get(route.session_id)!;
  // 12.2: no agent is connected to this session at all (the binding is gone), not merely stopped.
  if (state.app.sessions?.connection === 'none') session.active_binding_id = null;
  // The board's agent is running and waiting for me: idle, so an answer sent now reads "Sent at", not queued behind a turn.
  fixture.transport.idle(route.session_id);
  mapWorld(fixture, state.app);
  binWorld(fixture, state.app, state.id);
  // "Later" is the owner's own mark (a preference), not a status of the item.
  fixture.transport.preferences.later = (state.app.items?.later ?? []).map(item => {
    if (!session.items[item]) throw new Error(`final ${state.id}: later on an item that is not in the session: ${item}`);
    return { ...route, item_id: item };
  });
  fixture.transport.preferences.drafts = drafts.map((draft, at): OwnerDraft => {
    // A draft on a question in another session (2.7's picked option in the other-sessions list) lives with that session.
    const owner = session.items[draft.item] ? session : [...fixture.transport.sessions.values()].find(value => value.items[draft.item]);
    const item = owner?.items[draft.item];
    if (!owner || !item) throw new Error(`final ${state.id}: draft on an item that is in no session: ${draft.item}`);
    return { op_id: uuid(100 + at), session: { project_id: owner.project_id, session_id: owner.id }, binding_id: owner.active_binding_id!, target: { topic_id: item.topic_id, item_id: item.id },
      // Words typed in the Details composer go out as what fits the item (a note on one in progress, a reply on an open or waiting one).
      intent: draft.reply === undefined ? 'answer' : item.status === 'in_progress' ? 'note' : item.status === 'waiting_on_me' || item.status === 'open' ? 'reply' : 'followup',
      text: draft.reply ?? draft.own ?? draft.note ?? '', selected_option_id: draft.pick === undefined ? null : item.options[draft.pick]?.id ?? null,
      target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null };
  });
  return fixture;
}
