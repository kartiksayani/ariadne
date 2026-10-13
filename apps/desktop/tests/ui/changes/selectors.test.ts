import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionSeen } from '../../../src/generated/core';
import type { Answer, Item, ItemChangeBefore, ItemChangeRecord, Message, Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data/session-store';
import { changeCard } from '../../../src/selectors/changes/card';
import { changeTreeOrder, isChangedSinceRead, isNewToOwner, nextUnseen } from '../../../src/selectors/changes/seen';
import { briefLists, sinceYouWereHere } from '../../../src/selectors/changes/topic';

const baseline = '2026-10-10T00:00:00.000Z', later = '2026-10-10T01:00:00.000Z', latest = '2026-10-10T02:00:00.000Z';
function fixture() {
  const session = structuredClone(demo) as Session;
  const base = session.items['1']!, topic = session.topics[base.topic_id]!;
  session.items = {}; session.topics = { [topic.id]: { ...topic, brief: 'Current topic context.', brief_updated_at: baseline } };
  session.messages = []; session.answers = []; session.inputs = {}; session.rounds = {}; session.state = 'active'; session.archived_at = null;
  const seen: SessionSeen = { session: { project_id: session.project_id, session_id: session.id }, since: baseline, items: [], topics: [] };
  function item(id: string, patch: Partial<Item> = {}): Item {
    const value: Item = { ...structuredClone(base), id, ordinal: Number(id.split('.').at(-1)), topic_id: topic.id,
      parent: null, question: `Complete sentence for ${id}.`, status: 'open', revision: 5, question_revision: 2,
      changes: [], created_at: baseline, updated_at: latest, created_message_id: 'creation', replaced_by: null, why: null,
      current_round_id: null, options: [], ...patch };
    session.items[id] = value;
    return value;
  }
  function batch(id: string, inputId = 'input', patch: Partial<Message> = {}): Message {
    const value: Message = { id, number: session.messages.length + 1, author: 'agent', kind: 'activity', body: 'Batch activity.',
      created_at: later, item_id: null, topic_id: topic.id, items_touched: [], binding_id: session.active_binding_id,
      input_id: inputId, attempt_id: null, host_turn_id: null, round_id: null, origin: null, ...patch };
    session.messages.push(value);
    return value;
  }
  function record(before: ItemChangeBefore, patch: Partial<ItemChangeRecord> = {}): ItemChangeRecord {
    return { revision: 3, at: later, cause_message_id: 'batch', before, ...patch };
  }
  function answer(patch: Partial<Answer> = {}): Answer {
    const value: Answer = { id: 'answer', seq: 1, item_id: '1', question_revision: 2, question_snapshot: 'Which approach should we use?',
      ask_snapshot: 'Choose an approach.', options_snapshot: [], selected_option_id: null, text: 'Use the smaller change.',
      message_id: 'owner', input_id: 'input', supersedes_answer_id: null, created_at: baseline, ...patch };
    session.answers.push(value);
    return value;
  }
  return { session, seen, topic, item, batch, record, answer };
}

describe('owner read flags', () => {
  it('marks only creations after the session baseline that have never been seen', () => {
    const value = fixture(), fresh = value.item('1', { created_at: later });
    expect(isNewToOwner(fresh, value.seen)).toBe(true);
    expect(isNewToOwner(value.item('2'), value.seen)).toBe(false);
    value.seen.items.push({ item_id: fresh.id, revision: 1 });
    expect(isNewToOwner(fresh, value.seen)).toBe(false);
    expect(isNewToOwner(fresh, null)).toBe(false);
    expect(isNewToOwner(fresh, undefined)).toBe(false);
  });
  it('uses the implicit baseline or explicit read revision plus a later meaningful record, never just a larger item revision', () => {
    const value = fixture(), item = value.item('1', { changes: [value.record({ note: null })] });
    expect(isChangedSinceRead(item, value.seen)).toBe(true);
    value.seen.items.push({ item_id: item.id, revision: 2 });
    expect(isChangedSinceRead(item, value.seen)).toBe(true);
    value.seen.items[0].revision = 3;
    expect(isChangedSinceRead(item, value.seen)).toBe(false);
    item.changes = [];
    expect(isChangedSinceRead(item, value.seen)).toBe(false);
    expect(isChangedSinceRead(item, null)).toBe(false);
  });
  it('suppresses old upgrade records and wording-only edits even when their revisions are newer', () => {
    const value = fixture(), item = value.item('1');
    value.seen.items.push({ item_id: item.id, revision: 1 });
    item.changes = [value.record({ question: 'Old words.' }, { at: baseline }),
      value.record({ note: 'Same meaning.' }, { revision: 4, wording_only: true })];
    expect(isChangedSinceRead(item, value.seen)).toBe(false);
    item.changes.push(value.record({ outcome: null }, { revision: 5, at: latest }));
    expect(isChangedSinceRead(item, value.seen)).toBe(true);
  });
});

describe('input change cards', () => {
  it('joins multiple agent activity batches and groups updates, replacements, creations and rewordings with reasons', () => {
    const value = fixture(); value.batch('batch'); value.batch('second'); value.batch('other', 'unrelated');
    value.batch('reply', 'input', { kind: 'reply' }); value.batch('system', 'input', { author: 'system' });
    value.item('1', { question: 'The current sentence.', note: 'Current note.', changes: [
      value.record({ question: 'The initial sentence.', note: null }, { reason: 'Use the settled approach.' }),
      value.record({ question: 'The intermediate sentence.' }, { revision: 4, cause_message_id: 'second', reason: 'Refine the approach.' }),
      value.record({ question: 'The latest batch sentence.' }, { revision: 5, cause_message_id: 'other' }),
    ] });
    value.item('2', { status: 'replaced', replaced_by: '3', why: 'A smaller proposal covers the same work.',
      changes: [value.record({ status: 'open' }, { reason: 'Use the replacement.' })] });
    value.item('3', { created_message_id: 'second', created_at: later });
    value.item('4', { changes: [value.record({ question: 'Same idea, older words.' }, { wording_only: true, reason: 'Clarify the phrasing.' })] });
    value.item('5', { changes: [value.record({ question: 'Unrelated edit.' }, { cause_message_id: 'other' })] });
    value.item('6', { created_message_id: 'reply' }); value.item('7', { created_message_id: 'system' });
    const frozen = immutable(value.session), before = JSON.stringify(frozen), card = changeCard(frozen, 'input');
    expect(card.total).toBe(3);
    expect(card.groups.updated.map(row => row.item.id)).toEqual(['1']);
    expect(card.groups.replaced.map(row => row.item.id)).toEqual(['2']);
    expect(card.groups.new.map(row => row.item.id)).toEqual(['3']);
    expect(card.groups.reworded.map(row => row.item.id)).toEqual(['4']);
    expect(card.groups.updated[0]).toMatchObject({ sentence: 'The current sentence.', reasons: ['Use the settled approach.', 'Refine the approach.'],
      fields: [{ field: 'question', before: 'The initial sentence.', current: 'The current sentence.' }, { field: 'note', before: null, current: 'Current note.' }] });
    expect(card.groups.replaced[0].replacement?.question).toBe('Complete sentence for 3.');
    expect(card.groups.replaced[0].why).toBe('A smaller proposal covers the same work.');
    expect(card.batches.map(batch => [batch.message.id, batch.reasons])).toEqual([
      ['batch', ['Batch activity.', 'Use the settled approach.', 'Use the replacement.', 'Clarify the phrasing.']], ['second', ['Batch activity.', 'Refine the approach.']],
    ]);
    expect(card.groups.updated[0]).not.toHaveProperty('itemNumber');
    expect(JSON.stringify(frozen)).toBe(before);
  });
  it('keeps meaningful edits and rewordings in separate groups without increasing the meaningful item count', () => {
    const value = fixture(); value.batch('batch');
    value.item('1', { changes: [value.record({ outcome: null }), value.record({ question: 'Previous words.' }, { revision: 4, wording_only: true })] });
    const card = changeCard(value.session, 'input');
    expect(card.total).toBe(1);
    expect(card.groups.updated[0].fields.map(field => field.field)).toEqual(['outcome']);
    expect(card.groups.reworded[0].fields.map(field => field.field)).toEqual(['question']);
  });
  it('preserves a free text answer and chooses option labels from the answer snapshot', () => {
    const value = fixture(); value.answer();
    expect(changeCard(value.session, 'input').answer).toEqual({ question: 'Which approach should we use?', text: 'Use the smaller change.', selectedOption: null });
    value.session.answers[0].options_snapshot = [{ id: 'small', label: 'Original option label.', consequence: 'Original consequence.', recommended: true }];
    value.session.answers[0].selected_option_id = 'small';
    value.item('1', { options: [{ id: 'small', label: 'Changed option label.', consequence: 'New consequence.', recommended: false }] });
    expect(changeCard(value.session, 'input').answer?.selectedOption).toEqual(value.session.answers[0].options_snapshot[0]);
    value.session.answers[0].selected_option_id = 'missing';
    expect(changeCard(value.session, 'input').answer?.selectedOption).toBeNull();
    expect(changeCard(value.session, 'unrelated').answer).toBeNull();
  });
  it('compares every changed field with its current value, keeping absent nullable fields empty', () => {
    const value = fixture(); value.batch('batch');
    const item = value.item('1', { question: 'Current words.', type: 'decision', status: 'decided', note: 'Current note.', ask: null,
      short: undefined, options: [], outcome: 'Current outcome.', why: 'Current reason.', links: [], related: undefined, affects: ['2'], depends_on: [] });
    item.changes = [value.record({ question: 'Old words.', short: 'Old short.', type: 'task', status: 'open', note: null, ask: 'Old ask.',
      options: [{ id: 'old', label: 'Old option.', consequence: '', recommended: false }], outcome: null, why: null,
      links: [{ kind: 'doc', label: 'Previous link.', target: 'https://example.test' }], related: ['3'], affects: null, depends_on: ['4'] })];
    const fields = changeCard(value.session, 'input').groups.updated[0].fields;
    expect(fields).toHaveLength(13);
    for (const field of fields) expect(field.current).toEqual(item[field.field] ?? null);
    expect(fields.find(field => field.field === 'short')?.current).toBeNull();
  });
  it('reads free-text replies from the input payload when they do not create an answer record', () => {
    const value = fixture();
    value.session.inputs.input = { id: 'input', seq: 1, binding_id: value.session.active_binding_id!, kind: 'reply',
      target: { topic_id: value.topic.id, item_id: '1' }, message_id: 'owner', answer_id: null, created_at: baseline,
      expected_question_revision: null, state: 'handled', attempts: [], active_attempt_id: null, resolution_history: [],
      payload: { text: 'Keep the proposal small.', intent: 'reply', selected_option_id: 'small',
        target_snapshot: { topic_name: 'Topic context.', item_question: 'Original proposal sentence.', question_revision: 1, ask: null,
          options: [{ id: 'small', label: 'Original option.', consequence: 'Preserve the current behavior.', recommended: true }] },
        context: { message_ids: [], item_ids: [], round_id: null, continuation_operation_id: null } } };
    expect(changeCard(value.session, 'input').answer).toMatchObject({ question: 'Original proposal sentence.',
      text: 'Keep the proposal small.', selectedOption: { label: 'Original option.' } });
    value.session.inputs.input.payload.target_snapshot.item_question = null;
    expect(changeCard(value.session, 'input').answer?.question).toBe('Topic context.');
  });
  it('shows creations once and ignores removed subtrees while retaining dangling replacement history', () => {
    const value = fixture(); value.batch('batch');
    value.item('1', { created_message_id: 'batch', changes: [value.record({ note: null })] });
    value.item('2', { removed_at: later });
    value.item('2.1', { parent: '2', created_message_id: 'batch' });
    value.item('3', { status: 'replaced', replaced_by: 'missing', changes: [value.record({ status: 'open' })] });
    value.item('4', { status: 'replaced', replaced_by: '2', changes: [value.record({ status: 'open' })] });
    const card = changeCard(value.session, 'input');
    expect(card.groups.new.map(row => row.item.id)).toEqual(['1']);
    expect(card.groups.updated).toHaveLength(0);
    expect(card.groups.replaced.every(row => row.replacement === null)).toBe(true);
    expect(card.total).toBe(3);
  });
  it('classifies an earlier status batch accurately when a later input replaced the item', () => {
    const value = fixture(); value.batch('batch'); value.batch('other', 'later-input');
    value.item('1', { status: 'replaced', changes: [value.record({ status: 'open' }), value.record({ status: 'done' }, { revision: 4, cause_message_id: 'other' })] });
    expect(changeCard(value.session, 'input').groups.updated).toHaveLength(1);
    expect(changeCard(value.session, 'later-input').groups.replaced).toHaveLength(1);
  });
  it('returns an empty card for old stores with no change records or matching creation activity', () => {
    const value = fixture(); value.item('1', { changes: undefined });
    expect(changeCard(value.session, 'input')).toMatchObject({ total: 0, answer: null, batches: [], groups: { updated: [], replaced: [], new: [], reworded: [] } });
  });
});

describe('topic catch-up summaries', () => {
  it('uses topic catch-up instead of item reads and excludes wording-only records', () => {
    const value = fixture();
    value.seen.topics.push({ topic_id: value.topic.id, at: later });
    value.seen.items.push({ item_id: '1', revision: 5 });
    value.session.topics[value.topic.id]!.brief_updated_at = latest;
    value.item('1', { changes: [value.record({ note: 'Before catch-up.' }), value.record({ outcome: null }, { revision: 4, at: latest })] });
    value.item('2', { created_at: latest });
    value.item('3', { changes: [value.record({ question: 'Same meaning.' }, { at: latest, wording_only: true })] });
    const result = sinceYouWereHere(value.session, value.topic.id, value.seen, Date.parse(latest));
    expect(result.baseline).toBe(later); expect(result.briefChanged).toBe(true); expect(result.changeCount).toBe(2);
    expect(result.groups.updated.map(row => row.item.id)).toEqual(['1']);
    expect(result.groups.new.map(row => row.item.id)).toEqual(['2']);
    expect(result.groups.reworded).toHaveLength(0); expect(result.longAbsence).toBe(false);
  });
  it('falls back to the upgrade baseline and suppresses all old history when no seen state exists', () => {
    const value = fixture();
    value.item('1', { created_at: later, changes: [value.record({ outcome: null })] });
    expect(sinceYouWereHere(value.session, value.topic.id, value.seen).baseline).toBe(baseline);
    const absent = sinceYouWereHere(value.session, value.topic.id, undefined);
    expect(absent).toMatchObject({ baseline: null, changeCount: 0, briefChanged: false, longAbsence: false });
    expect(absent.groups.new).toHaveLength(0); expect(absent.groups.updated).toHaveLength(0);
    value.session.topics[value.topic.id]!.brief_updated_at = baseline;
    expect(sinceYouWereHere(value.session, value.topic.id, value.seen).briefChanged).toBe(false);
  });
  it('recognizes a cleared brief and stays scoped to the chosen topic and active subtree', () => {
    const value = fixture();
    value.session.topics[value.topic.id]!.brief = null; value.session.topics[value.topic.id]!.brief_updated_at = later;
    value.session.topics.other = { ...value.topic, id: 'other', order: 2 };
    value.item('1', { topic_id: 'other', created_at: later });
    value.item('2', { removed_at: later }); value.item('2.1', { parent: '2', created_at: later });
    const result = sinceYouWereHere(value.session, value.topic.id, value.seen, Date.parse(latest));
    expect(result.briefChanged).toBe(true); expect(result.changeCount).toBe(0);
  });
  it('uses a strict two-day boundary for long absence', () => {
    const value = fixture(), twoDays = Date.parse(baseline) + 2 * 24 * 60 * 60 * 1000;
    expect(sinceYouWereHere(value.session, value.topic.id, value.seen, twoDays).longAbsence).toBe(false);
    expect(sinceYouWereHere(value.session, value.topic.id, value.seen, twoDays + 1).longAbsence).toBe(true);
  });
  it('counts meaningful records and creations, including multiple batches on one item, at the thirty-change boundary', () => {
    const value = fixture();
    for (let id = 1; id <= 9; id++) value.item(String(id), { created_at: later,
      changes: [value.record({ note: null }), value.record({ outcome: null }, { revision: 4 }), value.record({ question: 'Wording.' }, { revision: 5, wording_only: true })] });
    value.item('10', { changes: [value.record({ note: null }), value.record({ outcome: null }, { revision: 4 })] });
    expect(sinceYouWereHere(value.session, value.topic.id, value.seen, Date.parse(latest))).toMatchObject({ changeCount: 29, longAbsence: false });
    value.session.items['10']!.created_at = later;
    expect(sinceYouWereHere(value.session, value.topic.id, value.seen, Date.parse(latest))).toMatchObject({ changeCount: 30, longAbsence: true });
  });
});

describe('next unseen navigation', () => {
  it('walks full topic and numeric sibling preorder after the selected item without wrapping', () => {
    const value = fixture();
    value.session.topics.other = { ...value.topic, id: 'other', order: 2 };
    value.item('10', { ordinal: 10, created_at: later }); value.item('2', { created_at: later });
    value.item('2.10', { ordinal: 10, parent: '2', created_at: later }); value.item('2.2', { parent: '2', created_at: later });
    value.item('1', { topic_id: 'other', created_at: later });
    expect(changeTreeOrder(value.session)).toEqual(['2', '2.2', '2.10', '10', '1']);
    expect(nextUnseen(value.session, value.seen)?.id).toBe('2');
    expect(nextUnseen(value.session, value.seen, undefined, '2.2')?.id).toBe('2.10');
    expect(nextUnseen(value.session, value.seen, undefined, '1')).toBeNull();
  });
  it('supports the caller tree order and skips read, wording-only, archived, removed and stale rows', () => {
    const value = fixture();
    value.item('1', { created_at: later }); value.seen.items.push({ item_id: '1', revision: 5 });
    value.item('2', { changes: [value.record({ question: 'Wording.' }, { wording_only: true })] });
    value.seen.items.push({ item_id: '2', revision: 1 });
    value.item('3', { changes: [value.record({ outcome: null })] }); value.seen.items.push({ item_id: '3', revision: 1 });
    value.item('4', { created_at: later }); value.item('5', { removed_at: later, created_at: later });
    value.session.topics.archived = { ...value.topic, id: 'archived', order: 2, archived_at: later };
    value.item('6', { topic_id: 'archived', created_at: later });
    expect(nextUnseen(value.session, value.seen, ['missing', '1', '2', '5', '6', '4', '3'])?.id).toBe('4');
    expect(nextUnseen(value.session, value.seen, ['4', '3'], '4')?.id).toBe('3');
    expect(nextUnseen(value.session, undefined)).toBeNull();
  });
});

describe('topic brief lists', () => {
  it('projects Your turn, Decided and Replaced with current sentences, replacement and why', () => {
    const value = fixture();
    value.item('10', { status: 'waiting_on_me' }); value.item('2', { status: 'waiting_on_me' });
    value.item('3', { status: 'decided', outcome: 'Current decision.' });
    value.item('4', { status: 'replaced', replaced_by: '5', why: 'One proposal covers both.' }); value.item('5');
    value.item('6', { status: 'waiting_on_me', removed_at: later });
    const lists = briefLists(immutable(value.session), value.topic.id);
    expect(lists.yourTurn.map(row => row.item.id)).toEqual(['2', '10']);
    expect(lists.decided.map(row => row.sentence)).toEqual(['Complete sentence for 3.']);
    expect(lists.replaced[0]).toMatchObject({ sentence: 'Complete sentence for 4.', why: 'One proposal covers both.', replacement: { id: '5' } });
  });
  it('excludes answered questions and questions in closed or archived sessions without changing status', () => {
    const value = fixture(), item = value.item('1', { status: 'waiting_on_me' });
    value.answer();
    expect(briefLists(value.session, value.topic.id).yourTurn).toHaveLength(0);
    value.session.answers = [];
    expect(briefLists(value.session, value.topic.id).yourTurn).toHaveLength(1);
    value.session.state = 'closed';
    expect(briefLists(value.session, value.topic.id).yourTurn).toHaveLength(0);
    value.session.state = 'active'; value.session.archived_at = later;
    expect(briefLists(value.session, value.topic.id).yourTurn).toHaveLength(0);
    expect(item.status).toBe('waiting_on_me');
  });
});
