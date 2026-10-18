// The words inventory (E27) and the continuation-family test (E34), contract §5.8: one definition for every remove, the
// bin's Empty, their quotes and their tests. Never lose typed text: every entry a removal would delete is listed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Immutable } from '../../../src/data/session-store';
import type { RendererService } from '../../../src/data/service';
import type { Input, Session, Topic } from '../../../src/generated/domain/models';
import type { DraftEntry } from '../../../src/state/drafts/store';
import type { WaitingState } from '../../../src/selectors/waiting/store';
import { hasFamily, itemScope, newWords, readArchived, topicScope, wordsInScope, wordsLabel, type ArchivedRead } from '../../../src/ui/remove/words';

const session = demo as unknown as Immutable<Session>;
const T10 = '00000000-0000-4000-8000-000000000010', T11 = '00000000-0000-4000-8000-000000000011';
const input = (n: number) => `00000000-0000-4000-8000-0000000000${n}`;
const noDrafts = { entries: {} };
const keys = (scope: Parameters<typeof wordsInScope>[2], drafts: Parameters<typeof wordsInScope>[1] = noDrafts, at = session) =>
  wordsInScope(at, drafts, scope).map(entry => entry.key);

let ops = 0;
function draft(text: string, target: { topic_id: string; item_id: string | null }, extra: Partial<DraftEntry> = {}, sessionId = session.id): DraftEntry {
  const op_id = `00000000-0000-4000-8000-00000000d${String(++ops).padStart(3, '0')}`;
  return { draft: { op_id, session: { project_id: session.project_id, session_id: sessionId }, binding_id: 'b', target, intent: target.item_id ? 'reply' : 'topic_reply',
    text, selected_option_id: null, target_revision: 1, question_revision: null, supersedes_answer_id: null },
  saving: false, uncertain: false, error: null, receipt: null, rejected: false, ...extra } as unknown as DraftEntry;
}
const drafts = (...list: DraftEntry[]) => ({ entries: Object.fromEntries(list.map(entry => [entry.draft.op_id, entry])) });
function withInput(id: string, change: Partial<Immutable<Input>>): Immutable<Session> {
  return { ...session, inputs: { ...session.inputs, [id]: { ...session.inputs[id]!, ...change } } } as Immutable<Session>;
}

describe('wordsInScope', () => {
  // Each row: scope → the entries a removal would delete, in send order (inputs) then drafts.
  it.each([
    ['a leaf with a retained cancelled answer', () => itemScope(session, '1.1'), []],
    ['a parent: its cancelled answer with words; a handled one is gone already', () => itemScope(session, '1'), [`input:${input(78)}`]],
    ['in flight', () => itemScope(session, '3'), [`input:${input(72)}`]],
    ['needs attention', () => itemScope(session, '7'), [`input:${input(74)}`]],
    ['cancelled note and queued request on one item', () => itemScope(session, '4'), [`input:${input(73)}`, `input:${input(76)}`]],
    ['skipped and handled inputs are settled', () => itemScope(session, '6'), []],
    ['a whole topic, in send order', () => topicScope(T10), [72, 73, 74, 76, 78].map(n => `input:${input(n)}`)],
    ['a queued continue summary on a copied topic', () => topicScope(T11), [`input:${input(77)}`]],
  ] as const)('%s', (_, scope, expected) => {
    expect(keys(scope())).toEqual(expected);
  });

  it('quotes the exact words, the topic or item name, and the state', () => {
    const [entry] = wordsInScope(session, noDrafts, itemScope(session, '1'));
    expect(entry).toMatchObject({ kind: 'input', text: session.inputs[input(78)]!.payload.text, intent: 'answer', state: 'cancelled' });
    expect(entry!.about).toBeTruthy();
    expect(wordsLabel(entry!)).toBe(`Your cancelled answer, about “${entry!.about}”`);
  });

  it('leaves out a cancelled input with no words and the removed-notice kind', () => {
    const blank = withInput(input(78), { payload: { ...session.inputs[input(78)]!.payload, text: '  ' } });
    expect(keys(itemScope(blank, '1'), noDrafts, blank)).toEqual([]);
    const notice = withInput(input(76), { kind: 'removed' });
    expect(keys(itemScope(notice, '4'), noDrafts, notice)).toEqual([`input:${input(73)}`]);
  });

  it('names what a pending choice or request asked for when it carries no words', () => {
    const base = session.inputs[input(76)]!;
    const request = withInput(input(76), { payload: { ...base.payload, text: '' } });
    expect(wordsInScope(request, noDrafts, itemScope(request, '4')).at(-1)!.text).toBe('Drop it');
    const option = { id: 'keep', label: 'Keep it', consequence: '', recommended: false };
    const choice = withInput(input(76), { kind: 'answer', payload: { ...base.payload, text: '', selected_option_id: 'keep', target_snapshot: { ...base.payload.target_snapshot, options: [option] } } });
    expect(wordsInScope(choice, noDrafts, itemScope(choice, '4')).at(-1)!.text).toBe('Keep it');
  });

  it('lists every non-empty draft in scope, and only those', () => {
    const below = draft('half a thought\n  kept as typed', { topic_id: T10, item_id: '1.1' });
    const empty = draft('   ', { topic_id: T10, item_id: '1.1' });
    const elsewhere = draft('other session', { topic_id: T10, item_id: '1.1' }, {}, '00000000-0000-4000-8000-0000000000ff');
    const topicReply = draft('about the whole topic', { topic_id: T10, item_id: null });
    const otherItem = draft('on item 8', { topic_id: T10, item_id: '8' });
    const all = drafts(below, empty, elsewhere, topicReply, otherItem);
    const item = wordsInScope(session, all, itemScope(session, '1'));
    expect(item.map(entry => entry.key)).toEqual([`input:${input(78)}`, `draft:${below.draft.op_id}`]);
    expect(item[1]).toMatchObject({ kind: 'draft', text: 'half a thought\n  kept as typed', intent: 'reply' });
    expect(wordsLabel(item[1]!)).toMatch(/^Your unsent reply, about “/);
    // A topic reply goes with its topic, not with an item in it.
    expect(keys(topicScope(T10), all)).toEqual([...[72, 73, 74, 76, 78].map(n => `input:${input(n)}`),
      `draft:${below.draft.op_id}`, `draft:${topicReply.draft.op_id}`, `draft:${otherItem.draft.op_id}`]);
  });

  it('does not list a saved draft twice: its input is already there', () => {
    const saved = draft('Correction', { topic_id: T10, item_id: '1' }, { receipt: { data: { kind: 'input_submit', input_id: input(78) } } } as unknown as Partial<DraftEntry>);
    expect(keys(itemScope(session, '1'), drafts(saved))).toEqual([`input:${input(78)}`]);
    const lost = draft('Correction', { topic_id: T10, item_id: '1' }, { receipt: { data: { kind: 'input_submit', input_id: input(99) } } } as unknown as Partial<DraftEntry>);
    expect(keys(itemScope(session, '1'), drafts(lost))).toEqual([`input:${input(78)}`, `draft:${lost.draft.op_id}`]);
  });

  it('newWords names what appeared after the review', () => {
    const before = wordsInScope(session, noDrafts, itemScope(session, '1'));
    const typed = draft('new words', { topic_id: T10, item_id: '1.1' });
    const after = wordsInScope(session, drafts(typed), itemScope(session, '1'));
    expect(newWords(before, after).map(entry => entry.key)).toEqual([`draft:${typed.draft.op_id}`]);
    expect(newWords(after, before)).toEqual([]);
  });
});

const counts = { completeness: 'complete', unavailable_session_ids: [] };
function waiting(sessions: readonly Immutable<Session>[] = [session], change: Partial<WaitingState> = {}): WaitingState {
  return { status: 'ready', counts, waiting: [], sent: [], sessions: sessions.map(value => ({ session: value })), unavailableProjects: [], error: null, ...change } as unknown as WaitingState;
}
const read = (sessions: readonly Immutable<Session>[] = [], complete = true): ArchivedRead => ({ sessions, complete });
const topic = (id: string) => session.topics[id] as Immutable<Topic>;
function copyOf(topicId: string, name: string, id = '00000000-0000-4000-8000-0000000000c1'): Immutable<Session> {
  const copy = { ...topic(topicId), id: `${id}-topic`, origin: { project_id: session.project_id, session_id: session.id, topic_id: topicId, source_revision: 1, continued_at: 1 } };
  return { ...session, id, name, topics: { [copy.id]: copy } } as unknown as Immutable<Session>;
}

describe('hasFamily', () => {
  it('a topic with no copies anywhere, every session read: no family', () => {
    expect(hasFamily(topic(T10), [], waiting(), read())).toEqual({ family: false, sessions: [] });
  });

  // Each row: what the app can see → whether Remove is blocked.
  it.each([
    ['a copy, continued from elsewhere (origin)', () => hasFamily(topic(T11), [], waiting(), read()), true],
    ['a source with a copy in an open session', () => hasFamily(topic(T10), [], waiting([session, copyOf(T10, 'schema review')]), read()), true],
    ['a source with a copy in an archived session', () => hasFamily(topic(T10), [], waiting(), read([copyOf(T10, 'old pass')])), true],
    ['a source with a copy in a session the caller holds', () => hasFamily(topic(T10), [copyOf(T10, 'held')], waiting(), read()), true],
    ['archived sessions still being checked', () => hasFamily(topic(T10), [], waiting(), null), true],
    ['an archived read that failed or timed out', () => hasFamily(topic(T10), [], waiting(), read([], false)), true],
    ['the waiting reader still loading', () => hasFamily(topic(T10), [], waiting([session], { status: 'loading' }), read()), true],
    ['the waiting reader unavailable', () => hasFamily(topic(T10), [], waiting([session], { status: 'unavailable' }), read()), true],
    ['a project that can’t be read', () => hasFamily(topic(T10), [], waiting([session], { unavailableProjects: [{}] } as unknown as Partial<WaitingState>), read()), true],
    ['a session that can’t be read', () => hasFamily(topic(T10), [], waiting([session], { counts: { completeness: 'complete', unavailable_session_ids: ['x'] } } as unknown as Partial<WaitingState>), read()), true],
    ['a partial catalogue', () => hasFamily(topic(T10), [], waiting([session], { counts: { completeness: 'partial', unavailable_session_ids: [] } } as unknown as Partial<WaitingState>), read()), true],
    ['no catalogue yet', () => hasFamily(topic(T10), [], waiting([session], { counts: null }), read()), true],
  ] as const)('%s → blocked', (_, check, family) => {
    expect(check().family).toBe(family);
  });

  it('names the sessions it knows, never this one', () => {
    expect(hasFamily(topic(T10), [], waiting([session, copyOf(T10, 'schema review')]), read([copyOf(T10, 'old pass', '00000000-0000-4000-8000-0000000000c3')])).sessions)
      .toEqual(['schema review', 'old pass']);
    // The source of a copy isn't held here: the family is known, its name isn't.
    expect(hasFamily(topic(T11), [], waiting(), read())).toEqual({ family: true, sessions: [] });
  });
});

describe('readArchived', () => {
  afterEach(() => { vi.useRealTimers(); });
  const summary = (id: string, archived: boolean) => ({ project_id: session.project_id, session_id: id, archived_at: archived ? 1 : null });
  function service(get: (id: string) => Promise<unknown>, list = [summary(session.id, false), summary('a1', true)], listCounts = counts) {
    return { query: vi.fn(async ({ request, session: route }: { request: { command: string }; session: { session_id: string } | null }) => {
      if (request.command === 'session_list') return { sessions: { items: list, next_cursor: null, snapshot_revision: 1 }, counts: listCounts };
      return get(route!.session_id);
    }) } as unknown as RendererService;
  }

  it('reads only the archived sessions', async () => {
    const archived = { ...session, id: 'a1' };
    const result = await readArchived(service(async () => ({ session: archived })));
    expect(result.complete).toBe(true);
    expect(result.sessions.map(value => value.id)).toEqual(['a1']);
  });

  it.each([
    ['a failed read', service(async () => { throw new Error('denied'); })],
    ['a different session back', service(async () => ({ session: { ...session, id: 'other' } }))],
    ['a catalogue with unreadable sessions', service(async () => ({ session }), undefined, { completeness: 'partial', unavailable_session_ids: [] })],
  ])('is incomplete after %s', async (_, reader) => {
    expect((await readArchived(reader)).complete).toBe(false);
  });

  it('is incomplete after 5 seconds without an answer', async () => {
    vi.useFakeTimers();
    const pending = readArchived(service(() => new Promise(() => undefined)));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ sessions: [], complete: false });
  });
});
