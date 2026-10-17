import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Input, ItemStatus, Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { displayStatus, ownerReplied } from '../../../src/selectors/waiting/replied';

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
function replied() {
  const session = structuredClone(demo) as Session, input = session.inputs[id('76')]!;
  input.target.item_id = '2'; input.kind = 'reply';
  return { session, input, item: session.items['2']! };
}
const shown = (session: Session) => displayStatus(immutable(session), immutable(session.items['2']!));
function attempted(session: Session, input: Input) {
  const attempt = structuredClone(session.inputs[id('72')]!.attempts[0]!);
  attempt.turn_state = 'unknown'; attempt.host_turn_id = null; attempt.error = null;
  input.state = 'in_flight'; input.attempts = [attempt]; input.active_attempt_id = attempt.id;
  return attempt;
}

describe('sent and queued item status', () => {
  it.each(['connected', 'disconnected', 'unknown'] as const)('shows a saved unattempted reply as Queued while %s', connection => {
    const { session, input } = replied();
    session.bindings[input.binding_id]!.connection_state = connection;
    expect(shown(session)).toBe('queued');
    expect(session.items['2']!.status).toBe('waiting_on_me');
  });
  it.each(['paused', 'disabled', 'busy'] as const)('keeps an unattempted %s binding reply Queued', reason => {
    const { session, input } = replied(), binding = session.bindings[input.binding_id]!;
    if (reason === 'paused') binding.owner_paused = true;
    if (reason === 'disabled') binding.dispatch_state = 'disconnected';
    if (reason === 'busy') binding.active_input_id = id('72');
    expect(shown(session)).toBe('queued');
  });
  it.each(['prepared', 'accepted'] as const)('shows an exact %s active attempt as Sent', acceptance => {
    const { session, input } = replied();
    attempted(session, input).acceptance = acceptance;
    expect(shown(session)).toBe('sent');
  });
  it.each(['running', 'completed'] as const)('shows a received %s attempt as Sent', turn => {
    const { session, input } = replied(), attempt = attempted(session, input);
    attempt.turn_state = turn; attempt.host_turn_id = 'matching-turn';
    expect(shown(session)).toBe('sent');
  });
  it('does not infer Sent from a stale, sealed or uncertain attempt', () => {
    const { session, input } = replied(), attempt = attempted(session, input);
    input.active_attempt_id = id('99');
    expect(shown(session)).toBe('queued');
    input.active_attempt_id = attempt.id; attempt.sealed_at = session.updated_at;
    expect(shown(session)).toBe('queued');
    attempt.sealed_at = null; attempt.acceptance = 'uncertain';
    expect(shown(session)).toBe('queued');
  });
  it('keeps a standing handled answer Sent until the item itself advances', () => {
    const { session, input, item } = replied(); input.state = 'handled';
    session.answers.push({ ...session.answers[0]!, id: id('99'), item_id: item.id, input_id: input.id,
      question_revision: item.question_revision, supersedes_answer_id: null });
    expect(shown(session)).toBe('sent');
    item.status = 'in_progress';
    expect(shown(session)).toBe('in_progress');
  });
  it.each(['open', 'in_progress', 'decided', 'done', 'dropped', 'replaced'] satisfies ItemStatus[])(
    'preserves canonical %s even with a queued answer', status => {
      const { session, item } = replied(); item.status = status;
      expect(shown(session)).toBe(status);
    });
  it.each(['owner', 'owner_edit', 'topic_archived', 'session_closed', undefined] as const)(
    'returns a cancelled reply with cause %s to the owner', cause => {
      const { session, input } = replied(); attempted(session, input);
      input.state = 'cancelled'; input.cancel_cause = cause;
      expect(shown(session)).toBe('waiting_on_me');
      expect(ownerReplied(immutable(session), immutable(session.items['2']!))).toBe(false);
    });
  it.each(['skipped', 'needs_attention'] as const)('returns a %s reply to the owner', state => {
    const { session, input } = replied(); input.state = state;
    expect(shown(session)).toBe('waiting_on_me');
  });
  it('ignores withdrawn and superseded answers and replies to older questions', () => {
    const { session, input, item } = replied(); item.question_revision++;
    expect(shown(session)).toBe('waiting_on_me');
    item.question_revision--; input.answer_id = id('98');
    session.answers.push({ ...session.answers[0]!, id: id('99'), item_id: item.id, input_id: id('97'),
      question_revision: item.question_revision, supersedes_answer_id: id('98') });
    session.inputs[id('97')] = { ...structuredClone(input), id: id('97'), answer_id: id('99'), state: 'cancelled' };
    expect(shown(session)).toBe('waiting_on_me');
  });
});
