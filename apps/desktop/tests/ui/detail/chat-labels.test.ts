import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Input, Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { bubbleStatus, detailModel, topicChat } from '../../../src/ui/detail/model';
import { stuckInput } from '../../../src/selectors/waiting/stuck';

const fresh = () => structuredClone(demo) as Session;
const chatOf = (session: Session, itemId: string) => detailModel({ session: immutable(session), itemId, now: Date.parse(session.updated_at), mode: null, later: false, saving: null })!.chat;

describe('chat labels (alpha.21 E12)', () => {
  it('names each bubble: raised, found, updated, explained, You replied, You', () => {
    const session = fresh(), item = session.items['1']!;
    const chat = chatOf(session, '1');
    const label = (id: string) => chat.find(entry => entry.id === id)?.label;
    expect(label(item.created_message_id)).toBe('Agent raised this');
    expect(chat.map(entry => entry.label).every(Boolean)).toBe(true);
    // An agent message that updated the item, and one that only explained.
    const updated = item.updated_message_ids.find(id => id !== item.created_message_id && chat.some(entry => entry.id === id && entry.message.author === 'agent'));
    if (updated) expect(label(updated)).toBe('Agent updated');
    const explained = chat.find(entry => entry.message.author === 'agent' && entry.id !== item.created_message_id && !item.updated_message_ids.includes(entry.id));
    if (explained) expect(explained.label).toBe('Agent explained');
    // The owner's answer reads "You"; their own words read "You replied".
    const answered = session.answers[0]!;
    expect(label(answered.message_id)).toBe('You');
    const reply = chat.find(entry => entry.message.author === 'me' && !session.answers.some(answer => answer.message_id === entry.id));
    if (reply) expect(reply.label).toBe('You replied');
    session.items['1']!.type = 'finding';
    expect(chatOf(session, '1').find(entry => entry.id === item.created_message_id)?.label).toBe('Agent found this');
  });

  it('never prints a message number or a parent label', () => {
    const session = fresh();
    const labels = ['1', '1.1', '2'].flatMap(id => chatOf(session, id).map(entry => entry.label));
    expect(labels.join('|')).not.toMatch(/#\d|Parent raised/u);
  });
});

describe('bubbleStatus (alpha.21 E16)', () => {
  const input = (patch: Partial<Input>): Input => ({ ...structuredClone(Object.values(demo.inputs).find(value => value.kind === 'reply')) as unknown as Input, ...patch });
  const attempt = (patch: Partial<Input['attempts'][number]>) => { const base = structuredClone(Object.values(demo.inputs)[0]!.attempts[0]!) as unknown as Input['attempts'][number]; return { ...base, ...patch }; };
  const status = (value: Input, stuck = null as ReturnType<typeof stuckInput>) => bubbleStatus(immutable(value), stuck);
  const waiting = { kind: 'waiting', text: '', resume: false, retry: false, settle: null } as const;

  it('queued and ready: Sent at · waiting, with Undo; an input kind without words has no Undo', () => {
    expect(status(input({ state: 'queued', kind: 'reply' }), waiting)).toMatchObject({ kind: 'sent', undo: true });
    expect(status(input({ state: 'queued', kind: 'reply' }), null)).toMatchObject({ kind: 'sent', undo: true });
    expect(status(input({ state: 'queued', kind: 'bring' }), waiting)).toBeNull();
  });

  it.each(['held', 'paused', 'blocked', 'behind'] as const)('queued but %s: no status line (StuckNote explains and offers the fix)', kind => {
    expect(status(input({ state: 'queued', kind: 'reply' }), { ...waiting, kind })).toBeNull();
  });

  it('in flight: Sent without Undo until the agent’s turn runs, then Picked up', () => {
    const sent = input({ state: 'in_flight', active_attempt_id: 'a', attempts: [attempt({ id: 'a', acceptance: 'accepted', turn_state: 'unknown', host_turn_id: null, sealed_at: null, result_state: 'pending' })] });
    expect(status(sent)).toMatchObject({ kind: 'sent', undo: false });
    const running = input({ state: 'in_flight', active_attempt_id: 'a', attempts: [attempt({ id: 'a', acceptance: 'accepted', acceptance_observed_at: '2026-10-03T12:00:09.000Z', turn_state: 'running', host_turn_id: 't', sealed_at: null, result_state: 'pending' })] });
    expect(status(running)).toMatchObject({ kind: 'picked_up' });
    expect((status(running) as { at: string }).at).toMatch(/^\d\d:\d\d$/u);
  });

  it('handled: Picked up', () => {
    expect(status(input({ state: 'handled' }))).toMatchObject({ kind: 'picked_up' });
  });

  it('stopped: Not sent + Retry only for a delivery the agent never received', () => {
    const never = input({ state: 'needs_attention', active_attempt_id: 'a', attempts: [attempt({ id: 'a', acceptance: 'rejected', host_turn_id: null, turn_state: 'unknown', sealed_at: null })] });
    const decision = { kind: 'decision', text: 'x', resume: false, retry: true, settle: 'skip' } as const;
    expect(status(never, decision)).toMatchObject({ kind: 'not_sent' });
    // "Not sent" is a claim: an uncertain delivery (the host may have it) or one being checked (a host turn) is StuckNote's to word.
    for (const patch of [{ acceptance: 'uncertain', host_turn_id: null }, { acceptance: 'uncertain', host_turn_id: 't' }] as const) {
      const unsure = input({ state: 'needs_attention', active_attempt_id: 'a', attempts: [attempt({ id: 'a', turn_state: 'unknown', sealed_at: null, ...patch })] });
      expect(status(unsure, decision)).toBeNull();
    }
    const received = input({ state: 'needs_attention', active_attempt_id: 'a', attempts: [attempt({ id: 'a', acceptance: 'accepted', host_turn_id: 't', turn_state: 'completed', result_state: 'missing', sealed_at: null })] });
    expect(status(received, { ...decision, kind: 'answer' })).toBeNull();
    expect(status(never, { ...decision, retry: false })).toBeNull();
  });

  it('settled kinds that have nothing to say stay quiet', () => {
    for (const state of ['cancelled', 'skipped'] as const) expect(status(input({ state }))).toBeNull();
  });
});

describe('topicChat (alpha.21 E5)', () => {
  it('shows a pending topic reply that has no message row yet, after the topic’s messages, with its status', () => {
    const session = fresh(), topicId = Object.keys(session.topics)[0]!;
    const source = Object.values(session.inputs).find(value => value?.state === 'queued' && value.kind !== 'continue')!;
    const pending: Input = { ...structuredClone(source), id: 'pending-topic-input', kind: 'topic_reply', state: 'queued', message_id: 'no-such-message-yet', seq: 99,
      target: { topic_id: topicId, item_id: null }, binding_id: session.active_binding_id!, payload: { ...source.payload, text: '  keep these words ' } };
    session.inputs[pending.id] = pending;
    const entries = topicChat(immutable(session), topicId, Date.parse(session.updated_at));
    const last = entries.at(-1)!;
    expect(last.id).toBe('no-such-message-yet');
    expect(last).toMatchObject({ label: 'You replied', you: { how: 'said', text: '  keep these words ' } });
    expect(last.pending?.input.id).toBe('pending-topic-input');
    expect(entries.filter(entry => entry.label === 'Agent').length).toBe(entries.filter(entry => entry.message.author === 'agent').length);
    expect(entries.every(entry => ['Agent', 'System', 'You replied'].includes(entry.label))).toBe(true);
  });

  it('keeps a cancelled topic reply’s words visible with its not-sent line, and hides one taken back and sent again', () => {
    const session = fresh(), topicId = Object.keys(session.topics)[0]!;
    const base = session.messages[0]!;
    const message = { ...base, id: 'topic-msg', number: 905, item_id: null, topic_id: topicId, author: 'owner' as const, body: 'Words I wrote', input_id: 'topic-in' };
    session.messages.push(message);
    const source = Object.values(session.inputs)[0]!;
    session.inputs['topic-in'] = { ...structuredClone(source), id: 'topic-in', kind: 'topic_reply', state: 'cancelled', cancel_cause: 'owner_edit', message_id: 'topic-msg', seq: 98,
      target: { topic_id: topicId, item_id: null }, payload: { ...source.payload, text: 'Words I wrote' }, attempts: [] };
    const entry = topicChat(immutable(session), topicId, Date.parse(session.updated_at)).find(value => value.id === 'topic-msg')!;
    expect(entry.unsent?.line).toContain('Taken back to edit');
    // A later topic reply resolves the edit: the taken-back one leaves the history.
    session.inputs['topic-next'] = { ...structuredClone(session.inputs['topic-in']!), id: 'topic-next', state: 'queued', cancel_cause: undefined, seq: 99, message_id: 'topic-next-msg', payload: { ...session.inputs['topic-in']!.payload, text: 'Changed words' } };
    expect(topicChat(immutable(session), topicId, Date.parse(session.updated_at)).some(value => value.id === 'topic-msg')).toBe(false);
  });
});
