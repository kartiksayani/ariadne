import type { SessionSeen } from '../../../apps/desktop/src/generated/core';
import type { Attempt, Item, Session } from '../../../apps/desktop/src/generated/domain/models';

const id = (n: number) => `00000000-0000-4000-8000-f${String(950 + n).padStart(11, '0')}`;
const old = '2026-10-03T14:00:00.000Z', at = '2026-10-07T15:02:00.000Z';
export const ownerWords = 'Keep retries quiet while offline.\nTell me when my saved changes are safe.';
export const interpretation = 'Read as: Keep saved changes safe and explain recovery without repeated alerts.';
/** The "notes" frame: item bodies written as Markdown (a list, bold, a link, a soft line break) and one of them changed. */
export const notesAfter = '**From:** the support queue\nOwner: the platform team\n\n- first check, see [the ticket](https://example.com/ticket/7)\n- second check\n\n1. reproduce it\n2. write the test';
export const notesBefore = '**From:** the old queue\nOwner: nobody yet\n\n- a single check, see [the old ticket](https://example.com/ticket/3)\n\n1. look into it';
export const changeNames = ['Recovery policy', 'Retry schedule', 'Saved receipt', 'Offline wording', 'Old retry policy', 'Wake-up check', 'Clock change check', 'Recovery note'];

/** Nineteen decided names for the long brief frame; some are long enough to need a line of their own on a narrow Map. */
export const longDecided = ['Backoff curve', 'Jitter range', 'Offline banner', 'Queue limit', 'Receipt format', 'Retry cap', 'Sync window',
  'Wake-up policy', 'Clock skew rule', 'Resume order', 'Idle timeout', 'Conflict wording', 'Quiet hours',
  'Large payload handling during a flaky connection', 'Telemetry opt-in', 'Disk-full behaviour', 'Cancel semantics for half-sent changes',
  'Battery saver mode', 'Error vocabulary'];

/** Fixed, app-only M2 data: five existing changes, three new items, and one waiting question. */
export function addChangesFixture(session: Session, mode: 'typed' | 'choice' | 'away' | 'long' | 'notes'): SessionSeen {
  const template = session.items['3.1']!;
  const topic = session.topics[template.topic_id]!;
  const binding = session.bindings[session.active_binding_id!]!;
  const inputId = id(1), ownerId = id(2), agentId = id(3), attemptId = id(4), answerId = id(5), roundId = id(6);
  const option = { id: 'quiet', label: 'Keep retries quiet', consequence: 'Saved changes resume when the connection returns.', recommended: true };
  topic.name = 'Reliable retries'; topic.short = 'Reliable retries'; topic.created_at = old;
  topic.brief = 'Saved changes survive a dropped connection. Recovery now resumes once and tells you when the work is safe.';
  topic.brief_updated_at = at;
  session.topics = { [topic.id]: topic };
  session.items = Object.fromEntries([...changeNames, 'Recovery question'].map((name, index): [string, Item] => {
    const itemId = `3.${index + 1}`, fresh = index >= 5 && index < 8, replaced = index === 4, waiting = index === 8;
    return [itemId, { ...structuredClone(template), id: itemId, ordinal: index + 1, parent: null, next_child: 1,
      question: name, short: name, status: replaced ? 'replaced' : waiting ? 'waiting_on_me' : index === 0 ? 'decided' : 'open',
      revision: fresh || waiting ? 1 : index === 0 ? 3 : 2, note: 'Resume safely after an interruption.',
      ask: waiting ? 'Should recovery wait until you reconnect?' : null, options: waiting ? [option] : [],
      outcome: index === 0 ? 'Keep retries quiet and resume saved changes once.' : null,
      why: 'Keep interruptions recoverable.', replaced_by: replaced ? '3.1' : null,
      created_at: fresh ? at : old, updated_at: fresh || !waiting ? at : old,
      created_message_id: fresh ? agentId : id(7), updated_message_ids: !fresh && !waiting ? [agentId] : [],
      waiting_since: waiting ? old : null, recipient_binding_id: waiting ? binding.id : null,
      current_round_id: index === 0 ? roundId : waiting ? id(10) : null, source_round_id: null, status_history: [],
      changes: fresh || waiting ? [] : [
        ...(index === 0 ? [{ revision: 2, at: '2026-10-03T14:30:00.000Z', cause_message_id: id(7),
          wording_only: true, reason: 'Make the recovery label easier to read.', before: { question: 'A safe recovery' } }] : []),
        { revision: index === 0 ? 3 : 2, at, cause_message_id: agentId, reason: 'Your answer keeps saved changes safe while the connection is unavailable.',
          before: replaced ? { status: 'open' } : { note: 'Retry immediately after every interruption.' } },
      ],
    }];
  }));
  if (mode === 'notes') {
    // "Retry schedule" (open) carries the changed Markdown note; "Recovery question" waits, so its note shows in the dock.
    const retry = session.items['3.2']!;
    retry.note = notesAfter;
    retry.changes = [
      { revision: 1, at: '2026-10-03T14:30:00.000Z', cause_message_id: id(7), reason: 'First draft of the schedule.', before: { note: 'Earlier draft.\n\n1. one\n2. two' } },
      { revision: 2, at, cause_message_id: agentId, reason: 'Linked the **ticket** and trimmed the rest.', before: { note: notesBefore } },
    ];
    // "Saved receipt" carries the same change for the popover, which lists the other items (the selected one has its box).
    const receipt = session.items['3.3']!;
    receipt.note = notesAfter;
    receipt.changes = [{ revision: 2, at, cause_message_id: agentId, reason: 'Linked the **ticket** and trimmed the rest.', before: { note: notesBefore } }];
    session.items['3.9']!.note = notesAfter;
  }
  if (mode === 'long') {
    // A topic that has settled a lot: the brief's Decided list holds many short and a few long names.
    for (const [index, name] of longDecided.entries()) {
      const itemId = `3.${index + 10}`;
      session.items[itemId] = { ...structuredClone(template), id: itemId, ordinal: index + 10, parent: null, next_child: 1,
        question: name, short: name, status: 'decided', revision: 1, note: 'Settled earlier.', ask: null, options: [],
        outcome: 'Settled.', why: 'Keep interruptions recoverable.', replaced_by: null, created_at: old, updated_at: old,
        created_message_id: id(7), updated_message_ids: [], waiting_since: null, recipient_binding_id: null,
        current_round_id: null, source_round_id: null, status_history: [], changes: [] };
    }
  }
  session.messages = [
    { id: id(7), number: 1, author: 'agent', kind: 'activity', body: 'Choose how recovery should behave.', created_at: old,
      item_id: '3.1', topic_id: topic.id, items_touched: ['3.1'], binding_id: binding.id, input_id: null, attempt_id: null, host_turn_id: null, round_id: roundId, origin: null },
    { id: ownerId, number: 2, author: 'owner', kind: 'owner_input', body: mode === 'choice' ? option.label : ownerWords,
      created_at: '2026-10-07T15:01:00.000Z', item_id: '3.1', topic_id: topic.id, items_touched: ['3.1'], binding_id: binding.id,
      input_id: inputId, attempt_id: attemptId, host_turn_id: null, round_id: roundId, origin: null },
    { id: agentId, number: 3, author: 'agent', kind: 'activity', body: 'Recovery now follows your preference.', created_at: at,
      item_id: '3.1', topic_id: topic.id, items_touched: changeNames.map((_, index) => `3.${index + 1}`), binding_id: binding.id,
      input_id: inputId, attempt_id: attemptId, host_turn_id: 'design-changes', round_id: roundId, origin: null },
  ];
  const attempt: Attempt = { id: attemptId, purpose: 'work', repair_for_attempt_id: null, claim_request_id: id(8), binding_generation: binding.generation,
    prepared_at: at, formatted_payload: ownerWords, payload_sha256: '0'.repeat(64), wire_marker: `[ARIADNE_INPUT:${inputId}:${attemptId}]`,
    acceptance: 'accepted', acceptance_receipt: null, acceptance_observed_at: at, host_turn_id: 'design-changes', turn_state: 'completed',
    turn_observed_at: at, domain_result: { operation_id: id(9), outcome: 'answered', explanation: mode === 'choice' ? 'Applied your choice.' : interpretation,
      reply_message_ids: [agentId], followup_item_ids: [], handled_through_message_number: 2, committed_revision: 4, committed_at: at },
    result_state: 'committed', sealed_at: at, error: null, reconciliation_checkpoint: null };
  session.inputs = { [inputId]: { id: inputId, seq: 1, binding_id: binding.id, kind: 'answer', target: { topic_id: topic.id, item_id: '3.1' },
    message_id: ownerId, answer_id: answerId, created_at: session.messages[1].created_at, expected_question_revision: 1,
    payload: { text: mode === 'choice' ? '' : ownerWords, intent: 'answer', selected_option_id: mode === 'choice' ? option.id : null,
      target_snapshot: { topic_name: topic.name, item_question: 'Recovery policy', question_revision: 1, ask: 'How should recovery behave?', options: [option] },
      context: { message_ids: [], item_ids: ['3.1'], round_id: roundId, continuation_operation_id: null } },
    state: 'handled', attempts: [attempt], active_attempt_id: attemptId, resolution_history: [] } };
  session.answers = [{ id: answerId, seq: 1, item_id: '3.1', question_revision: 1, question_snapshot: 'Recovery policy', ask_snapshot: 'How should recovery behave?',
    options_snapshot: [option], selected_option_id: mode === 'choice' ? option.id : null, text: mode === 'choice' ? '' : ownerWords,
    message_id: ownerId, input_id: inputId, supersedes_answer_id: null, created_at: session.messages[1].created_at }];
  session.rounds = { [roundId]: { id: roundId, item_id: '3.1', ordinal: 1, opened_message_id: id(7), question_snapshot: 'Recovery policy',
    ask_snapshot: 'How should recovery behave?', options_snapshot: [option], question_revision: 1, owner_message_ids: [ownerId], agent_message_ids: [agentId],
    result_input_ids: [inputId], fork_item_ids: [], closed_at: at, origin: null },
    [id(10)]: { id: id(10), item_id: '3.9', ordinal: 1, opened_message_id: id(7), question_snapshot: 'Recovery question',
      ask_snapshot: 'Should recovery wait until you reconnect?', options_snapshot: [option], question_revision: 1,
      owner_message_ids: [], agent_message_ids: [], result_input_ids: [], fork_item_ids: [], closed_at: null, origin: null } };
  session.revision = 4; session.updated_at = at;
  binding.active_input_id = null;
  session.counters = { next_root: 4, next_topic_order: 2, next_message: 4, next_input: 2, next_answer: 2 };
  return { session: { project_id: session.project_id, session_id: session.id },
    since: mode === 'away' ? '2026-10-04T15:00:00.000Z' : '2026-10-07T15:00:00.000Z', items: [], topics: [] };
}
