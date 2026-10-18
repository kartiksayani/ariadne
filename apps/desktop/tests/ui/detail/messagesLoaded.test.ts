// A divider worked out before an item's messages have arrived is not final, so the app keeps it only once they are all there.
import { describe, expect, it } from 'vitest';
import { immutable } from '../../../src/data';
import { messagesLoaded } from '../../../src/ui/detail/conversationSeen';
import { sessionFixture } from '../history/fixtures';

describe('messagesLoaded', () => {
  it.each([
    ['all of the item\'s messages are there', () => {}, '2', true],
    ['the item\'s last reply is not there yet', (value: ReturnType<typeof sessionFixture>) => { value.messages = value.messages.filter(message => !message.id.endsWith('0115')); }, '2', false],
    ['the item\'s opening message is not there yet', (value: ReturnType<typeof sessionFixture>) => { value.messages = value.messages.filter(message => !message.id.endsWith('0101')); }, '2', false],
    ['no messages are there', (value: ReturnType<typeof sessionFixture>) => { value.messages = []; }, '2', false],
    ['the item is not in the session', () => {}, 'nope', false],
  ])('%s', (_name, patch, itemId, loaded) => {
    const value = sessionFixture(); patch(value);
    expect(messagesLoaded(immutable(value), itemId)).toBe(loaded);
  });
});
