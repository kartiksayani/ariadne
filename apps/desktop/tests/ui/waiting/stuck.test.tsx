import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Input, PresenceObservation, Session } from '../../../src/generated/domain/models';
import type { SupervisorHealth } from '../../../src/data/service';
import { immutable } from '../../../src/data';
import { displayStatus, ownerReplied } from '../../../src/selectors/waiting/replied';
import { counted, heldInput, notSent, stuckInput, withdrawn } from '../../../src/selectors/waiting/stuck';
import { detailModel } from '../../../src/ui/detail/model';

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
const seed = () => structuredClone(demo) as Session;
/** An owner reply to item 2 (waiting on me, question revision 1) in `state`. */
function reply(session: Session, state: Input['state'], revision = 1): Input {
  const input = session.inputs[id('76')]!;
  input.target = { ...input.target, item_id: '2' }; input.state = state; input.kind = 'reply';
  input.payload.target_snapshot.question_revision = revision;
  return input;
}

describe('a message deleted before it was sent', () => {
  it('leaves the history only when it was cancelled with no delivery attempt', () => {
    const session = seed(), input = session.inputs[id('76')]!, message = session.messages.find(value => value.input_id === input.id)!;
    expect(withdrawn(immutable(session), immutable(message))).toBe(false);
    input.state = 'cancelled';
    expect(withdrawn(immutable(session), immutable(message))).toBe(true);
    // One that reached the agent stays in the history even once cancelled.
    input.attempts = structuredClone(session.inputs[id('72')]!.attempts);
    expect(withdrawn(immutable(session), immutable(message))).toBe(false);
    // Agent messages are never hidden.
    const agent = session.messages.find(value => value.author === 'agent')!;
    expect(withdrawn(immutable(session), immutable({ ...agent, input_id: input.id }))).toBe(false);
  });
});

describe('a message that archive or close cancelled before it was sent', () => {
  const setup = (cause: Input['cancel_cause']) => {
    const session = seed(), input = session.inputs[id('76')]!, message = session.messages.find(value => value.input_id === input.id)!;
    input.state = 'cancelled'; input.cancel_cause = cause;
    return { session: immutable(session), message: immutable(message) };
  };
  it.each([['topic_archived', 'Not sent: cancelled when you archived this topic'], ['session_closed', 'Not sent: cancelled when you closed this session']] as const)(
    'stays in the history with its reason when %s', (cause, line) => {
      const { session, message } = setup(cause);
      expect(withdrawn(session, message)).toBe(false);
      expect(notSent(session, message)?.line).toBe(line);
    });
  it.each([['owner'], [undefined]] as const)('is left out as the owner’s own cancel when the cause is %s', cause => {
    const { session, message } = setup(cause);
    expect(withdrawn(session, message)).toBe(true);
    expect(notSent(session, message)).toBeNull();
  });
  it('is not marked not sent once it reached the agent or while it is still queued', () => {
    const { session, message } = setup('topic_archived');
    const sent = structuredClone(session) as unknown as Session; sent.inputs[id('76')]!.attempts = structuredClone(sent.inputs[id('72')]!.attempts);
    expect(notSent(immutable(sent), message)).toBeNull();
    const queued = structuredClone(session) as unknown as Session; queued.inputs[id('76')]!.state = 'queued';
    expect(notSent(immutable(queued), message)).toBeNull();
  });
  it('never counts as the owner’s message, though it stays in the history; a live one counts', () => {
    const { session, message } = setup('topic_archived');
    expect(counted(session, message)).toBe(false);
    // Still on its way: counts.
    const queued = structuredClone(session) as unknown as Session; queued.inputs[id('76')]!.state = 'queued';
    expect(counted(immutable(queued), message)).toBe(true);
    // Deleted by the owner: not counted either.
    expect(counted(setup('owner').session, setup('owner').message)).toBe(false);
  });
  it.each(['owner', 'owner_edit', 'topic_archived', 'session_closed', undefined] as const)(
    'does not count once cancelled with earlier attempts either, as core reads it: cause %s', cause => {
      const { session, message } = setup(cause), plain = structuredClone(session) as unknown as Session;
      plain.inputs[id('76')]!.attempts = structuredClone(plain.inputs[id('72')]!.attempts);
      expect(counted(immutable(plain), message)).toBe(false);
    });
  it('does not count as an answer: the item still waits on the owner', () => {
    const session = seed(); reply(session, 'cancelled').cancel_cause = 'topic_archived';
    expect(ownerReplied(immutable(session), immutable(session.items['2']!))).toBe(false);
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_me');
  });
  describe('once the same words went out again', () => {
    const resend = (change: (later: Input) => void) => {
      const { session, message } = setup('topic_archived'), plain = structuredClone(session) as unknown as Session, original = plain.inputs[id('76')]!;
      const later = structuredClone(original); later.id = id('99'); later.seq = original.seq + 100; later.state = 'queued'; later.cancel_cause = undefined; change(later);
      plain.inputs[later.id] = later;
      return notSent(immutable(plain), message);
    };
    it('says so, so Put back has nothing left to do', () => {
      expect(notSent(setup('topic_archived').session, setup('topic_archived').message)?.again).toBe(false);
      expect(resend(() => {})?.again).toBe(true);
    });
    it('ignores a later message with other words, one that was cancelled too, or one to another item', () => {
      expect(resend(later => { later.payload.text = 'Something else'; })?.again).toBe(false);
      expect(resend(later => { later.state = 'cancelled'; later.cancel_cause = 'topic_archived'; })?.again).toBe(false);
      expect(resend(later => { later.target = { ...later.target, item_id: '2' }; })?.again).toBe(false);
    });
  });
});

describe('a message taken back to edit', () => {
  const setup = () => {
    const session = seed(), input = session.inputs[id('76')]!, message = session.messages.find(value => value.input_id === input.id)!;
    input.state = 'cancelled'; input.cancel_cause = 'owner_edit';
    return { session, input, message: immutable(message) };
  };
  it('stays in the history as Taken back to edit, with Put back', () => {
    const { session, message } = setup();
    expect(withdrawn(immutable(session), message)).toBe(false);
    expect(notSent(immutable(session), message)).toMatchObject({ line: 'Taken back to edit', again: false });
  });
  it('still reads Taken back to edit when it was re-queued after earlier attempts; it does not count', () => {
    const { session, input, message } = setup();
    input.attempts = structuredClone(session.inputs[id('72')]!.attempts);
    expect(withdrawn(immutable(session), message)).toBe(false);
    expect(notSent(immutable(session), message)).toMatchObject({ line: 'Taken back to edit', again: false });
    expect(counted(immutable(session), message)).toBe(false);
    // Sent again: it leaves the history like one with no attempts.
    const later = structuredClone(input); later.id = id('99'); later.seq = input.seq + 100; later.state = 'queued'; later.cancel_cause = undefined; later.attempts = [];
    session.inputs[later.id] = later;
    expect(withdrawn(immutable(session), message)).toBe(true);
    expect(notSent(immutable(session), message)).toBeNull();
  });
  it('leaves the history once a later message that is not cancelled carries the same words', () => {
    const { session, input, message } = setup();
    const later = structuredClone(input); later.id = id('99'); later.seq = input.seq + 100; later.state = 'queued'; later.cancel_cause = undefined;
    session.inputs[later.id] = later;
    expect(withdrawn(immutable(session), message)).toBe(true);
    expect(notSent(immutable(session), message)).toBeNull();
    // A later one that was cancelled too does not count as sent again.
    later.state = 'cancelled'; later.cancel_cause = 'owner_edit';
    expect(withdrawn(immutable(session), message)).toBe(false);
    expect(notSent(immutable(session), message)?.line).toBe('Taken back to edit');
  });
  it('never counts as an answer, shown or hidden: the item still waits on the owner', () => {
    const { session, message } = setup();
    expect(counted(immutable(session), message)).toBe(false);
    const answered = seed(); reply(answered, 'cancelled').cancel_cause = 'owner_edit';
    expect(ownerReplied(immutable(answered), immutable(answered.items['2']!))).toBe(false);
    expect(displayStatus(immutable(answered), immutable(answered.items['2']!))).toBe('waiting_on_me');
    const later = structuredClone(session.inputs[id('76')]!); later.id = id('99'); later.seq += 100; later.state = 'queued'; later.cancel_cause = undefined;
    session.inputs[later.id] = later;
    expect(counted(immutable(session), message)).toBe(false);
  });
});

describe('Waiting on agent', () => {
  it('reads Waiting on me until the owner replies to the current question', () => {
    const session = seed();
    expect(ownerReplied(immutable(session), immutable(session.items['2']!))).toBe(false);
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_me');
  });
  // The same cases are pinned in Rust (crates/ariadne-core/src/queries/counts.rs) so every count agrees.
  it.each(['answer', 'reply', 'note', 'drop'] as const)('a queued or in-flight %s to the current question makes it Waiting on agent', kind => {
    for (const state of ['queued', 'in_flight'] as const) {
      const session = seed(); reply(session, state).kind = kind;
      expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_agent');
    }
  });
  it.each(['needs_attention', 'cancelled', 'skipped'] as const)('a %s reply still waits on the owner', state => {
    const session = seed(); reply(session, state);
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_me');
  });
  it('a standing answer whose delivery failed waits on the owner; a superseded one does not count', () => {
    const session = seed(), input = reply(session, 'handled');
    session.answers.push({ ...session.answers[0], id: id('89'), item_id: '2', input_id: input.id, question_revision: 1, supersedes_answer_id: null });
    input.state = 'needs_attention';
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_me');
    input.state = 'queued'; input.answer_id = id('89');
    session.answers.push({ ...session.answers[0], id: id('90'), item_id: '2', input_id: id('92'), question_revision: 1, supersedes_answer_id: id('89') });
    // answer 89 is superseded by 90, whose input is unknown to the session: answer 90 stands.
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_agent');
    session.inputs[id('92')] = { ...input, id: id('92'), state: 'cancelled', answer_id: id('90') };
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_me');
  });
  it('a reply written for an older question, or one that was cancelled, leaves it waiting on the owner', () => {
    const older = seed(); reply(older, 'queued'); older.items['2']!.question_revision = 2;
    expect(displayStatus(immutable(older), immutable(older.items['2']!))).toBe('waiting_on_me');
    const cancelled = seed(); reply(cancelled, 'cancelled');
    expect(displayStatus(immutable(cancelled), immutable(cancelled.items['2']!))).toBe('waiting_on_me');
  });
  it('a standing answer to the current question waits on the agent until it acts', () => {
    const session = seed(), input = reply(session, 'handled');
    session.answers.push({ ...session.answers[0], id: id('89'), item_id: '2', input_id: input.id, question_revision: 1, supersedes_answer_id: null });
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_agent');
    // The agent asks again (a new question revision): the owner's turn again.
    session.items['2']!.question_revision = 2;
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_me');
  });
  it('never changes an item that is not waiting on the owner', () => {
    const session = seed(); reply(session, 'queued'); session.items['2']!.status = 'in_progress';
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('in_progress');
  });
});

describe('stuck inputs explain themselves', () => {
  // Input 76 (queued drop on item 4) sits behind 72 (in flight) on the active binding.
  const stuck = (session: Session, presence: PresenceObservation | null = null) =>
    stuckInput(immutable(session), immutable(session.inputs[id('76')]!), presence ? immutable(presence) : null);
  const first = () => { const session = seed(); session.inputs[id('72')]!.state = 'handled'; return session; };

  it('has nothing to explain while the message is on its way, but still offers Cancel', () => {
    const session = seed();
    expect(stuckInput(immutable(session), immutable(session.inputs[id('72')]!)))
      .toMatchObject({ kind: 'sent', text: '', resume: false, retry: false, settle: null });
  });
  it('has nothing to say about a settled message', () => {
    const session = seed(); session.inputs[id('72')]!.state = 'handled';
    expect(stuckInput(immutable(session), immutable(session.inputs[id('72')]!))).toBeNull();
  });
  it('names the message it is queued behind', () => {
    expect(stuck(seed())).toMatchObject({ kind: 'behind', text: 'Queued behind your message on “Implement receipt lookup”', resume: false, retry: false });
  });
  it('says the agent has not picked it up, or is busy, from fresh presence only', () => {
    const session = first(), binding = session.bindings[session.active_binding_id!]!;
    expect(stuck(session)).toMatchObject({ kind: 'waiting', text: 'demo.local hasn’t picked it up yet' });
    const running: PresenceObservation = { instance_id: id('99'), generation: binding.generation, connection_state: 'connected', execution_state: 'running',
      last_seen_at: '2026-10-03T12:01:00.000Z', source: null, process_identity: null, freshness: 'fresh' };
    expect(stuck(session, running)).toMatchObject({ kind: 'busy', text: 'Waiting for demo.local to finish what it’s doing' });
    expect(stuck(session, { ...running, freshness: 'stale' })?.kind).toBe('waiting');
  });
  it('says sending is paused with Resume, and names a blocker without it', () => {
    const paused = first(); paused.bindings[paused.active_binding_id!]!.owner_paused = true;
    expect(stuck(paused)).toMatchObject({ kind: 'paused', text: 'Sending is paused — it goes out when you resume', resume: true });
    const blocked = first(); blocked.bindings[blocked.active_binding_id!]!.pause_reason = 'uncertain';
    expect(stuck(blocked)?.kind).toBe('blocked'); expect(stuck(blocked)?.text).toMatch(/^Not sending: /); expect(stuck(blocked)?.resume).toBe(false);
  });
  it('says why the supervisor is not sending, from its own binding generation only, in every view', () => {
    const session = first(), binding = session.bindings[session.active_binding_id!]!, at = Date.now();
    const health: SupervisorHealth = { binding_id: binding.id, generation: binding.generation, state: 'backing_off', reason: 'codex exited',
      retry_in_seconds: 4, updated_at: new Date(at).toISOString() };
    const input = immutable(session.inputs[id('76')]!);
    expect(stuckInput(immutable(session), input, null, health)).toMatchObject({ kind: 'blocked', text: 'Not sending: codex exited · retrying in 4s' });
    expect(stuckInput(immutable(session), input, null, { ...health, generation: id('96') })?.kind).toBe('waiting');
    // The detail tracker passes the health on (the Waiting Sent rows are pinned in waiting.test.tsx).
    const detail = detailModel({ session: immutable(session), itemId: '4', now: at, mode: null, later: false, saving: null, health });
    expect(detail?.outbox.at(-1)?.stuck?.kind).toBe('blocked');
  });
  it('holds a message written for an older question, and lets later ones past it', () => {
    const session = seed(); session.items['4']!.question_revision = 2;
    expect(heldInput(immutable(session), immutable(session.inputs[id('76')]!))).toBe(true);
    expect(stuck(session)).toMatchObject({ kind: 'held', text: 'The question changed — review and send again' });
    // 77 (topic continuation) is behind 72 in flight, never behind the held 76.
    session.inputs[id('72')]!.state = 'handled';
    expect(stuckInput(immutable(session), immutable(session.inputs[id('77')]!))?.kind).toBe('waiting');
  });
  it('follows a message that a rebind moved to the new binding', () => {
    const session = first(), old = session.bindings[session.active_binding_id!]!;
    session.bindings[id('95')] = { ...structuredClone(old), id: id('95'), generation: id('96') };
    session.active_binding_id = id('95');
    const moved = reply(session, 'queued'); moved.binding_id = id('95');
    expect(displayStatus(immutable(session), immutable(session.items['2']!))).toBe('waiting_on_agent');
    expect(stuckInput(immutable(session), immutable(moved))).toMatchObject({ kind: 'waiting', text: 'demo.local hasn’t picked it up yet' });
    // The detail tracker finds the moved message by its item, not its binding, and the item still reads Waiting on agent.
    const detail = detailModel({ session: immutable(session), itemId: '2', now: Date.parse('2026-10-03T12:00:00.000Z'), mode: null, later: false, saving: null });
    expect(detail?.display).toBe('agent');
    expect(detail?.outbox.at(-1)?.input.id).toBe(moved.id);
    // Paused on the new binding: the moved message says so.
    session.bindings[id('95')]!.owner_paused = true;
    expect(stuckInput(immutable(session), immutable(moved))?.kind).toBe('paused');
  });
  it('says a stopped delivery couldn’t be delivered, with Retry and Mark as done; Mark as handled once the agent saved its answer', () => {
    const session = seed(), input = session.inputs[id('74')]!;
    expect(stuckInput(immutable(session), immutable(input))).toMatchObject({ kind: 'decision',
      text: 'Couldn’t deliver “Followup request for item 7. Preserve…”. Ariadne isn’t sure it reached demo.local.', retry: true, settle: 'skip' });
    input.attempts[0]!.result_state = 'committed';
    expect(stuckInput(immutable(session), immutable(input))).toMatchObject({ kind: 'decision',
      text: 'demo.local saved its answer, but the message wasn’t marked handled.', retry: false, settle: 'accept_result' });
    // No current attempt to decide on: no one-click answer.
    input.active_attempt_id = null;
    expect(stuckInput(immutable(session), immutable(input))).toMatchObject({ retry: false, settle: null });
  });
  describe('on a waiting item with a stopped delivery and a later message behind it', () => {
    // Item 2 waits on the owner. A (reply) stopped; B (answer) is queued behind it.
    const behind = () => {
      const session = seed(), stopped = reply(session, 'needs_attention'), queued = structuredClone(stopped);
      stopped.attempts = structuredClone(session.inputs[id('74')]!.attempts); stopped.active_attempt_id = stopped.attempts[0]!.id;
      queued.id = id('f5'); queued.seq = Math.max(...Object.values(session.inputs).map(value => value?.seq ?? 0)) + 1;
      queued.kind = 'answer'; queued.state = 'queued'; queued.attempts = []; queued.active_attempt_id = null; queued.payload.text = 'Behind the stopped one';
      session.inputs[queued.id] = queued;
      const model = () => detailModel({ session: immutable(session), itemId: '2', now: Date.parse('2026-10-03T12:00:00.000Z'), mode: null, later: false, saving: null });
      return { session, stopped, queued, model };
    };
    it('keeps the answer box closed while B waits behind the stopped delivery', () => {
      const { model, stopped, queued } = behind();
      expect(model()?.answer).toBeNull();
      expect(model()?.outbox.map(pending => pending.stuck?.kind)).toEqual(['decision', 'blocked']);
      expect(model()?.outbox.map(pending => pending.input.id)).toEqual([stopped.id, queued.id]);
    });
    it('shows B’s question-changed note and opens the answer box while A still shows its decision', () => {
      const { session, model, stopped, queued } = behind();
      session.items['2']!.question_revision = 2; queued.payload.target_snapshot.question_revision = 1;
      const detail = model();
      expect(detail?.outbox.find(pending => pending.input.id === queued.id)?.stuck).toMatchObject({ kind: 'held', text: 'The question changed — review and send again' });
      expect(detail?.outbox.find(pending => pending.input.id === stopped.id)?.stuck).toMatchObject({ kind: 'decision', retry: true, settle: 'skip' });
      // The newer question is the owner's to answer: the held message does not hold the answer box.
      expect(detail?.answer).not.toBeNull();
    });
  });
  it('keeps the decision in the detail panel when a later message is queued behind the stopped delivery on the same item', () => {
    const session = seed(), stopped = session.inputs[id('74')]!, successor = structuredClone(stopped);
    successor.id = id('f4'); successor.seq = Math.max(...Object.values(session.inputs).map(value => value?.seq ?? 0)) + 1;
    successor.state = 'queued'; successor.attempts = []; successor.active_attempt_id = null;
    session.inputs[successor.id] = successor;
    const detail = detailModel({ session: immutable(session), itemId: '7', now: Date.parse('2026-10-03T12:00:00.000Z'), mode: null, later: false, saving: null });
    // Each unsettled message is a pending bubble of its own; the stopped one keeps its Retry / Mark as done.
    expect(detail?.outbox.map(pending => pending.input.id)).toEqual([stopped.id, successor.id]);
    expect(detail?.outbox.find(pending => pending.input.id === stopped.id)?.stuck).toMatchObject({ kind: 'decision', retry: true, settle: 'skip' });
    // The delivery the panel follows is the stopped one's (it needs a decision), not the newest message: its fix is shown,
    // so no delivery line runs over it. Even a newer message already on its way (another connection) does not take it over.
    expect(detail?.delivery).toBeNull();
    successor.state = 'in_flight';
    const flying = detailModel({ session: immutable(session), itemId: '7', now: Date.parse('2026-10-03T12:00:00.000Z'), mode: null, later: false, saving: null });
    expect(flying?.outbox.map(pending => pending.input.id)).toEqual([stopped.id, successor.id]);
    expect(flying?.delivery).toBeNull();
  });
});

describe('an owner message still in flight once its round has the result', () => {
  const at = Date.parse('2026-10-03T12:00:00.000Z');
  /** Item 2's only round already holds the agent's result; the owner's reply to it is `state`. */
  const setup = (state: Input['state']) => {
    const session = seed(), input = reply(session, state), round = Object.values(session.rounds).find(value => value?.item_id === '2')!;
    const message = session.messages.find(value => value.id === input.message_id)!;
    message.item_id = '2'; message.input_id = input.id;
    round.owner_message_ids = [input.message_id]; round.result_input_ids = [];
    return { session, input, round, model: () => detailModel({ session: immutable(session), itemId: '2', now: at, mode: null, later: false, saving: null }) };
  };
  it('stays in its round, between the ask and the result, and not again as a pending bubble', () => {
    const { model, input } = setup('in_flight');
    const round = model()!.rounds[0]!;
    expect(round.result).not.toBe('');
    expect(round.you).toMatchObject({ chosen: false, text: expect.any(String) });
    expect(model()!.outbox.map(pending => pending.input.id)).not.toContain(input.id);
  });
  it('still ends the conversation as a pending bubble while it has not reached the agent', () => {
    const { model, input } = setup('queued');
    expect(model()!.rounds[0]!.you).toBeNull();
    expect(model()!.outbox.map(pending => pending.input.id)).toContain(input.id);
  });
  it('is a pending bubble when its round has no result yet', () => {
    const { model, input, session, round } = setup('in_flight');
    round.agent_message_ids = []; session.messages.filter(value => value.author === 'agent' && value.item_id === '2').forEach(value => { value.item_id = '1'; });
    expect(model()!.rounds[0]!.result).toBe('');
    expect(model()!.rounds[0]!.you).toBeNull();
    expect(model()!.outbox.map(pending => pending.input.id)).toContain(input.id);
  });
});
