// The owner's words a removal would delete (E27), and whether a topic has a continuation family (E34). One definition
// for every remove, the bin's Empty, their quotes and their tests (contract §5.8). Core's remove purges every input
// targeted at the removed items or topics, whatever its state (`history_actions/remove.rs` `purge`), and drafts on them
// can't be sent any more; so each one is quoted with Copy before the command runs.
import type { RendererService } from '../../data/service';
import { immutable, type Immutable } from '../../data/session-store';
import type { Input, InputKind, InputState, QueryCursor, Session, Topic } from '../../generated/domain/models';
import type { SessionListResult, SessionRef } from '../../generated/core';
import type { DraftState } from '../../state/drafts/store';
import type { WaitingState } from '../../selectors/waiting/store';
import { shortLabel } from '../shared/short';
import { removedSubtree } from '../../selectors/removed';

/** What a removal deletes: these items (and their inputs and drafts) and these whole topics. */
export interface WordsScope { readonly items: ReadonlySet<string>; readonly topics: ReadonlySet<string> }
/** An item and everything below it. */
export const itemScope = (session: Immutable<Session>, itemId: string): WordsScope =>
  ({ items: new Set(removedSubtree(session, itemId).map(item => item.id)), topics: new Set() });
/** A whole topic. */
export const topicScope = (topicId: string): WordsScope => ({ items: new Set(), topics: new Set([topicId]) });
/** A whole session: core's session and project removes delete every input in it, whatever its target (E27). */
export const sessionScope = (session: Immutable<Session>): WordsScope => ({ items: new Set(Object.keys(session.items)),
  topics: new Set([...Object.keys(session.topics), ...Object.values(session.inputs).flatMap(input => input ? [input.target.topic_id] : [])]) });

export interface WordsEntry {
  readonly kind: 'input' | 'draft';
  /** `input:<id>` or `draft:<op_id>`; stable across recomputes, so a pinned review can tell a new entry. */
  readonly key: string;
  /** The item's short name, or the topic's. */
  readonly about: string;
  /** The words exactly as written; for a choice or a request with no words, what it asked for. */
  readonly text: string;
  readonly intent: InputKind;
  /** An input's state; a draft has none. */
  readonly state?: InputState;
}

/** Inputs that haven't settled: queued (held ones too), on their way, or needing a decision. */
const PENDING: ReadonlySet<InputState> = new Set(['queued', 'in_flight', 'needs_attention']);
const REQUEST: Partial<Record<InputKind, string>> = { bring: 'Bring it up', reopen: 'Back to Open', drop: 'Drop it' };
const topicName = (topic: Immutable<Topic>) => topic.short?.trim() || topic.name;
const inScope = (target: { readonly topic_id: string; readonly item_id: string | null }, scope: WordsScope) =>
  scope.topics.has(target.topic_id) || !!target.item_id && scope.items.has(target.item_id);

function aboutOf(session: Immutable<Session>, target: { readonly topic_id: string; readonly item_id: string | null }, fallback?: Immutable<Input>): string {
  const item = target.item_id ? session.items[target.item_id] : null;
  if (item) return shortLabel(item);
  const topic = session.topics[target.topic_id];
  if (!target.item_id && topic) return topicName(topic);
  const snapshot = fallback?.payload.target_snapshot;
  return snapshot?.item_question ?? snapshot?.topic_name ?? (topic ? topicName(topic) : 'this work');
}

function inputText(input: Immutable<Input>): string {
  if (input.payload.text.trim()) return input.payload.text;
  const option = input.payload.selected_option_id ? input.payload.target_snapshot.options.find(value => value.id === input.payload.selected_option_id) : null;
  return option?.label ?? REQUEST[input.kind] ?? '';
}

/**
 * The words inventory of `scope` (E27): pending inputs (queued, held, in flight, needing attention), retained cancelled
 * inputs that carry words, and every non-empty item and topic draft. Inputs come in send order, then drafts.
 */
export function wordsInScope(session: Immutable<Session>, drafts: Pick<DraftState, 'entries'>, scope: WordsScope): readonly WordsEntry[] {
  const inputs = Object.values(session.inputs).filter((input): input is Immutable<Input> => !!input && input.kind !== 'removed'
    && inScope(input.target, scope) && (PENDING.has(input.state) || input.state === 'cancelled' && !!input.payload.text.trim()))
    .sort((a, b) => a.seq - b.seq);
  const words: WordsEntry[] = inputs.map(input => ({ kind: 'input', key: `input:${input.id}`, about: aboutOf(session, input.target, input),
    text: inputText(input), intent: input.kind, state: input.state }));
  for (const entry of Object.values(drafts.entries)) {
    const draft = entry?.draft;
    if (!draft || draft.session.project_id !== session.project_id || draft.session.session_id !== session.id) continue;
    if (!draft.text.trim() || !inScope(draft.target, scope)) continue;
    // A saved draft is the input already listed above.
    const saved = entry.receipt?.data.kind === 'input_submit' ? entry.receipt.data.input_id : null;
    if (saved && session.inputs[saved]) continue;
    words.push({ kind: 'draft', key: `draft:${draft.op_id}`, about: aboutOf(session, draft.target), text: draft.text, intent: draft.intent });
  }
  return words;
}

/** Keys in `now` that `pinned` didn't have: words that appeared after the owner reviewed the removal. */
export const newWords = (pinned: readonly WordsEntry[], now: readonly WordsEntry[]): readonly WordsEntry[] => {
  const seen = new Set(pinned.map(entry => entry.key));
  return now.filter(entry => !seen.has(entry.key));
};

/** The quote's label: "Your cancelled message, about “x”", "Your reply about “x”, not sent yet", "Your draft about “x”". */
export function wordsLabel(entry: WordsEntry): string {
  const noun = entry.intent === 'answer' ? 'answer' : entry.intent === 'note' ? 'note' : entry.intent === 'followup' ? 'follow-up'
    : entry.intent === 'continue' ? 'summary' : REQUEST[entry.intent] ? 'request' : 'reply';
  if (entry.kind === 'draft') return `Your unsent ${noun}, about “${entry.about}”`;
  if (entry.state === 'cancelled') return `Your cancelled ${noun === 'reply' ? 'message' : noun}, about “${entry.about}”`;
  return `Your ${noun} about “${entry.about}”, not picked up yet`;
}

/**
 * Archived sessions' snapshots, read when a Remove-topic or Empty dialog opens: the waiting reader skips them, and core's
 * family walk includes them. `complete` is false when any read failed or the reads took longer than `ms`.
 */
export interface ArchivedRead { readonly sessions: readonly Immutable<Session>[]; readonly complete: boolean }
const INCOMPLETE: ArchivedRead = { sessions: [], complete: false };

/** Every session the catalogue lists (of one project, or all) that `keep` keeps; null when the catalogue is incomplete. */
async function listRoutes(service: RendererService, projectId: string | null, keep: (archived: boolean) => boolean): Promise<SessionRef[] | null> {
  const routes: SessionRef[] = [];
  let cursor: QueryCursor | null = null;
  for (let pages = 0; pages < 1000; pages++) {
    const page: SessionListResult = await service.query({ session: null, request: { command: 'session_list', params: { project_id: projectId, state: null, cursor, limit: 100 } } });
    if (page.counts.completeness !== 'complete' || page.counts.unavailable_session_ids.length) return null;
    for (const summary of page.sessions.items) if (keep(summary.archived_at != null)) routes.push({ project_id: summary.project_id, session_id: summary.session_id });
    cursor = page.sessions.next_cursor;
    if (!cursor) return routes;
  }
  return null;
}

/** Each session read fresh, within `ms`; incomplete when the list is missing, any read fails, or time runs out. */
async function readRoutes(service: RendererService, routes: () => Promise<readonly SessionRef[] | null>, ms: number): Promise<ArchivedRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ArchivedRead>(resolve => { timer = setTimeout(() => resolve(INCOMPLETE), ms); });
  const read = (async (): Promise<ArchivedRead> => {
    const list = await routes();
    if (!list) return INCOMPLETE;
    const sessions: Immutable<Session>[] = [];
    for (const route of list) {
      const result = await service.query({ session: route, request: { command: 'session_get', params: {} } });
      if (result.session.id !== route.session_id) return INCOMPLETE;
      sessions.push(immutable(result.session));
    }
    return { sessions, complete: true };
  })().catch((): ArchivedRead => INCOMPLETE);
  try { return await Promise.race([read, timeout]); } finally { clearTimeout(timer); }
}

export function readArchived(service: RendererService, ms = 5000): Promise<ArchivedRead> {
  return readRoutes(service, () => listRoutes(service, null, archived => archived), ms);
}

/** What a session or project removal deletes: core purges every input in its sessions (E27). */
export type WholeTarget = { readonly kind: 'session'; readonly session: SessionRef } | { readonly kind: 'project'; readonly project_id: string };
/** The words a session or project removal deletes; `complete` is false when any of its sessions couldn't be read. */
export interface WordsRead { readonly words: readonly WordsEntry[]; readonly complete: boolean }
/**
 * The words inventory of a whole session, or of every session of a project (archived ones too), each read fresh when the
 * dialog opens. The drafts are read after the sessions, so a draft saved meanwhile is listed once.
 */
export async function readWords(service: RendererService, drafts: () => Pick<DraftState, 'entries'>, target: WholeTarget, ms = 5000): Promise<WordsRead> {
  const read = await readRoutes(service, async () => target.kind === 'session' ? [target.session] : listRoutes(service, target.project_id, () => true), ms);
  if (!read.complete) return { words: [], complete: false };
  const entries = drafts();
  return { words: read.sessions.flatMap(session => wordsInScope(session, entries, sessionScope(session))), complete: true };
}

/** Whether removing `topic` would reach other sessions, and the names of those the app can see. */
export interface FamilyCheck { readonly family: boolean; readonly sessions: readonly string[] }
const sessionName = (session: Immutable<Session>) => session.name?.trim() || session.title;

/**
 * E34: a topic has a continuation family when it was continued from somewhere (`origin`), when any session the app
 * holds has a copy of it (a topic whose `origin.topic_id` is this one), or when that can't be known: the waiting reader
 * isn't ready (loading, stale or unavailable) or kept a read error, a project or session can't be read, or the archived
 * sessions weren't all read (`archived` null while
 * checking). Core removes the whole family, and words in other sessions can't be shown here.
 */
export function hasFamily(topic: Immutable<Topic>, sessions: readonly Immutable<Session>[], waiting: WaitingState, archived: ArchivedRead | null): FamilyCheck {
  const known = new Map<string, Immutable<Session>>();
  for (const session of [...waiting.sessions.map(entry => entry.session), ...sessions, ...archived?.sessions ?? []]) known.set(session.id, session);
  // Walk links both ways from this topic over every session the app can see, as core does.
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => { links.set(a, [...links.get(a) ?? [], b]); links.set(b, [...links.get(b) ?? [], a]); };
  const owner = new Map<string, string>();
  for (const session of known.values()) for (const value of Object.values(session.topics)) {
    if (!value) continue;
    owner.set(value.id, session.id);
    if (value.origin) { link(value.id, value.origin.topic_id); if (!owner.has(value.origin.topic_id)) owner.set(value.origin.topic_id, value.origin.session_id); }
  }
  if (topic.origin) link(topic.id, topic.origin.topic_id);
  const seen = new Set([topic.id]), pending = [topic.id];
  while (pending.length) for (const next of links.get(pending.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); pending.push(next); }
  const home = owner.get(topic.id);
  const names = [...new Set([...seen].map(id => owner.get(id)).filter((id): id is string => !!id && id !== home)
    .map(id => known.get(id)).filter((session): session is Immutable<Session> => !!session).map(sessionName))];
  const counts = waiting.counts;
  // A stale capture or a kept read error means a session may be missing from `waiting.sessions` (the reader drops one it
  // can't read and has no earlier copy of), so its copies can't be seen.
  const unknown = waiting.status !== 'ready' || waiting.error != null || waiting.unavailableProjects.length > 0
    || !counts || counts.completeness !== 'complete' || counts.unavailable_session_ids.length > 0 || !archived?.complete;
  return { family: seen.size > 1 || unknown, sessions: names };
}
