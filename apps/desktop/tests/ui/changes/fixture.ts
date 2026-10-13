import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Item, ItemChangeRecord, Session } from '../../../src/generated/domain/models';
import type { SessionSeen } from '../../../src/generated/core';
export const baseline = '2026-10-10T00:00:00.000Z', later = '2026-10-10T01:00:00.000Z';
export function changesFixture(updated = 1, replaced = 0, added = 0) {
  const session = structuredClone(demo) as Session, base = session.items['1']!;
  const topic = session.topics[base.topic_id]!;
  const answer = session.answers.find(value => value.item_id === base.id)!;
  const input = session.inputs[answer.input_id]!;
  input.target.item_id = base.id;
  const activity = session.messages.find(message => message.author === 'agent' && message.kind === 'activity')!;
  activity.input_id = answer.input_id;
  const resultAttempt = Object.values(session.inputs).flatMap(value => value?.attempts ?? []).find(attempt => attempt.domain_result)!;
  input.attempts = [structuredClone(resultAttempt)];
  activity.attempt_id = input.attempts[0].id;
  input.attempts[0].domain_result!.explanation = 'Read as: keep the change small.\nPreserve the full explanation.';
  answer.selected_option_id = null; answer.text = 'Keep my exact words.\nAnd my second line.';
  input.payload.selected_option_id = null;
  session.updated_at = later;
  session.answers = [answer]; session.inputs = { [input.id]: input };
  session.messages = [activity, ...session.messages.filter(message => message.id === answer.message_id)];
  session.topics = { [topic.id]: { ...topic, brief: 'The agent’s complete brief.\nKeep both lines.', brief_updated_at: later } };
  session.items = { [base.id]: { ...base, changes: [], status: 'decided', short: null, question: 'Owner decision', created_at: baseline, created_message_id: 'older-creation' } };
  function record(patch: Partial<ItemChangeRecord> = {}): ItemChangeRecord {
    return { revision: 2, at: later, cause_message_id: activity.id, reason: 'The owner chose a smaller change.', before: { note: 'Earlier note.' }, ...patch };
  }
  function add(id: string, label: string, patch: Partial<Item> = {}) {
    const item: Item = { ...structuredClone(base), id, ordinal: Object.keys(session.items).length + 1, parent: null,
      topic_id: topic.id, question: label, short: null, status: 'open', revision: 2, question_revision: 1,
      created_at: baseline, created_message_id: 'older-creation', changes: [record()], note: 'Current note.', replaced_by: null, current_round_id: null, ...patch };
    session.items[id] = item; return item;
  }
  for (let index = 0; index < updated; index++) add(`updated-${index}`, `Updated name ${String.fromCharCode(65 + index)}`);
  for (let index = 0; index < replaced; index++) add(`replaced-${index}`, `Replaced name ${String.fromCharCode(65 + index)}`, { status: 'replaced', replaced_by: base.id, changes: [record({ before: { status: 'open' } })] });
  for (let index = 0; index < added; index++) add(`new-${index}`, `New name ${String.fromCharCode(65 + index)}`, { created_at: later, created_message_id: activity.id, changes: [] });
  const seen: SessionSeen = { session: { project_id: session.project_id, session_id: session.id }, since: baseline, items: [], topics: [] };
  return { session, topic, answer, input, activity, record, add, seen };
}
