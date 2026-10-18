import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { topicChat } from '../../../src/ui/detail/model';

const session = () => structuredClone(demo) as unknown as Session;

describe('topicChat', () => {
  it('lists a topic’s own messages, oldest first, and not its items’ messages', () => {
    const value = session();
    const topicId = Object.keys(value.topics)[0]!;
    const base = value.messages[0]!;
    value.messages.push(
      { ...base, id: 'topic-2', number: 902, item_id: null, topic_id: topicId, author: 'owner', body: 'About the topic' },
      { ...base, id: 'topic-1', number: 901, item_id: null, topic_id: topicId, author: 'agent', body: 'Topic started' },
    );
    const entries = topicChat(immutable(value), topicId, Date.parse(value.updated_at));
    const own = new Set(value.messages.filter(message => message.item_id === null && message.topic_id === topicId).map(message => message.id));
    expect(entries.map(entry => entry.id).sort()).toEqual([...own].sort());
    expect(entries.map(entry => entry.id).slice(-2)).toEqual(['topic-1', 'topic-2']);
    expect(entries.length).toBeLessThan(value.messages.length);
    expect(entries.at(-2)!.you).toBeNull();
    expect(entries.at(-1)!.you).toEqual({ how: 'said', text: 'About the topic', note: '' });
    expect(topicChat(immutable(value), 'no-such-topic', 0)).toEqual([]);
  });
});
