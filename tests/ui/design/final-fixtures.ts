// A final-board state's AppFixture (final-frames.ts) -> the application state behind the real DesktopApp, built on
// the handoff harness (fixtures.ts buildFixture) from the board's mock world (final-world.ts). Sessions, items,
// questions and drafts come from the state's spec; what the app cannot yet be put in by data (the board's new
// chrome: a folded Details, the connection lines, the switcher) is reached by the spec's `act` steps, which the
// builder who turns `pending` off writes against the new app.
import type { OwnerDraft } from '../../../apps/desktop/src/generated/core';
import { buildFixture, type DesignFixture, type PrototypeData, type ProtoItem, type ProtoMessage, type ProtoSession, type ProtoTopic } from './fixtures';
import type { FrameSpec, Scenario } from './frames';
import { finalNow, variants, type AppFixture, type FinalState, type Variant } from './final-frames';
import { conversations, items as worldItems, longText, others, projects, Q1, Q2, sessions as worldSessions, topicName, topicShort, type WItem } from './final-world';

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
  projects: 'projects', sessions: 'sessions', archive: 'archive', first: 'first', 'project-empty': 'projectpage'
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

/** The app's state for one final-board state at one size: sessions and items from the world, the drafts typed in. */
export function finalFixture(state: Pick<FinalState, 'id' | 'app'>, variant: Variant): DesignFixture {
  const spec = finalSpec(state, variant), fixture = buildFixture(spec, worldData(state.app));
  const drafts = state.app.drafts ?? [];
  if (!fixture.route) return fixture;
  const current = fixture.transport.sessions.get(fixture.route.session_id)!;
  fixture.transport.preferences.drafts = drafts.map((draft, at): OwnerDraft => {
    // A draft on a question in another session (2.7's picked option in the other-sessions list) lives with that session.
    const session = current.items[draft.item] ? current : [...fixture.transport.sessions.values()].find(value => value.items[draft.item]);
    const item = session?.items[draft.item];
    if (!session || !item) throw new Error(`final ${state.id}: draft on an item that is in no session: ${draft.item}`);
    const route = { project_id: session.project_id, session_id: session.id };
    return { op_id: uuid(100 + at), session: route, binding_id: session.active_binding_id!, target: { topic_id: item.topic_id, item_id: item.id }, intent: 'answer',
      text: draft.own ?? draft.note ?? '', selected_option_id: draft.pick === undefined ? null : item.options[draft.pick]?.id ?? null,
      target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null };
  });
  return fixture;
}
