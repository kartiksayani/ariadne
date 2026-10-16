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
import { archivedSessions, archivedTopic, conversations, items as worldItems, longText, others, projects, Q1, Q2, sessions as worldSessions, topicName, topicShort,
  type WItem } from './final-world';

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
      q: long?.q ?? changed.q, outcome: long?.o ?? changed.o ?? '', why: changed.why ?? '', ...(item.ask ? { ask: item.ask } : {}), created, updated, links: [],
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

/** The app's state for one final-board state at one size: sessions and items from the world, the drafts typed in. */
export function finalFixture(state: Pick<FinalState, 'id' | 'app'>, variant: Variant): DesignFixture {
  const spec = finalSpec(state, variant), fixture = buildFixture(spec, worldData(state.app));
  // The board draws at the default text size (SPEC §1: --text-scale 0.8); the handoff harness pins 100%.
  fixture.transport.preferences.global.text_scale = 80;
  // First run has no projects, so nothing of the pages' world applies.
  if (state.app.chrome?.page && state.app.chrome.page !== 'first') pageWorld(fixture, state.app);
  const drafts = state.app.drafts ?? [];
  if (!fixture.route) return fixture;
  const route = fixture.route, session = fixture.transport.sessions.get(route.session_id)!;
  fixture.transport.preferences.drafts = drafts.map((draft, at): OwnerDraft => {
    const item = session.items[draft.item];
    if (!item) throw new Error(`final ${state.id}: draft on an item that is not in the session: ${draft.item}`);
    return { op_id: uuid(100 + at), session: route, binding_id: session.active_binding_id!, target: { topic_id: item.topic_id, item_id: item.id }, intent: 'answer',
      text: draft.own ?? draft.note ?? '', selected_option_id: draft.pick === undefined ? null : item.options[draft.pick]?.id ?? null,
      target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null };
  });
  return fixture;
}
