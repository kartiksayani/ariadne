// The line above the topic box says what the box can do: with no agent connected a box exists only when a draft was saved.
import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { topicReplyReason } from '../../../src/ui/answer/useTopicReply';
import { sessionFixture } from '../history/fixtures';

const session = (patch: (value: ReturnType<typeof sessionFixture>) => void = () => {}) => {
  const value = sessionFixture(); patch(value);
  return { value: immutable(value), topic: Object.keys(value.topics)[0]! };
};

describe('topicReplyReason', () => {
  it.each([
    ['no agent connected, no box', (value: ReturnType<typeof sessionFixture>) => { value.active_binding_id = null; }, false, 'You can write here once an agent is connected.'],
    ['no agent connected, a saved draft shows in a box', (value: ReturnType<typeof sessionFixture>) => { value.active_binding_id = null; },
      true, 'The agent isn’t running, so a reply can’t go out yet. Whatever you type here is kept.'],
    ['a closed session, a box', (value: ReturnType<typeof sessionFixture>) => { value.state = 'closed'; }, true, 'The agent isn’t running, so a reply can’t go out yet. Whatever you type here is kept.'],
    ['a closed session, drafts still loading', (value: ReturnType<typeof sessionFixture>) => { value.state = 'closed'; }, false, 'The agent isn’t running, so a reply can’t go out yet.'],
    ['an agent running', () => {}, true, null],
  ])('%s', (_name, patch, boxShown, words) => {
    const { value, topic } = session(patch);
    expect(topicReplyReason(value, topic, 'the agent', boxShown)).toBe(words);
  });
});
