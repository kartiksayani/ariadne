import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { packagedRouteSelected } from '../../../scripts/check-release-boundary.mjs';

export const GENERIC = 'A question is waiting for your answer.';
export function arrivalRequest(bindingId, label) {
  return { op_id: randomUUID(), source_input_id: null, attempt_id: null,
    expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', input_result: null,
    operations: [
      { op: 'topic.add', ref: 'notification_topic', name: `Notification ${label}` },
      { op: 'item.add', ref: 'notification_item', topic: { ref: 'notification_topic' }, parent: null,
        question: `Private notification content ${label}`, type: 'task', status: 'open', owner: { kind: 'me' },
        ask: null, options: null, note: null, links: null, outcome: null, why: null, replaced_by: null, source_round_id: null },
      { op: 'item.ask', item: { ref: 'notification_item' }, ask: `Answer the saved notification question ${label}.`,
        options: [], recipient_binding_id: bindingId },
    ] };
}
export function assertClick(before, after, route) {
  assert.deepEqual(after.primary, before.primary, 'Notification replaced the privately launched process');
  assert.deepEqual(after.ownership, before.ownership, 'Notification replaced runtime socket or lease ownership');
  assert.ok(packagedRouteSelected(after.preferences, route), 'Notification did not select the exact registered current item');
  assert.equal(after.sessionSha256, before.sessionSha256, 'Notification click mutated canonical session state');
  assert.equal(after.visible, true, 'Notification click did not restore a hittable native window');
  assert.equal(after.detailItem, `Item ${route.item_id}`, 'Notification click retained a different item detail');
  assert.ok(after.questionVisible, 'Notification click did not expose the current complete question');
}
export function assertDeniedAnswer(session, text, configuration, queued) {
  const inputs = Object.values(session.inputs).filter(input => input.payload.text === text);
  assert.equal(inputs.length, 1, 'Denied-permission Waiting action did not persist exactly once');
  const input = inputs[0];
  assert.equal(input.kind, 'answer'); assert.equal(input.target.item_id, configuration.itemId);
  const answers = session.answers.filter(answer => answer.id === input.answer_id);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].question_revision, session.items[configuration.itemId].question_revision);
  assert.equal(answers[0].selected_option_id, configuration.options[0].id);
  assert.equal(answers[0].text, text);
  assert.equal(queued.length, 1, 'Permission denial blocked ordinary saved host delivery');
  assert.equal(queued[0].inputId, input.id);
  assert.equal(queued[0].payload, input.attempts[0].formatted_payload);
}
