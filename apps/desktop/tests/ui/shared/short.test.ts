import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Item, Topic } from '../../../src/generated/domain/models';
import { shortLabel } from '../../../src/ui/shared/short';

const item = demo.items['1'] as Item, topic = Object.values(demo.topics)[0] as Topic;

describe('shortLabel', () => {
  it('uses the generated short label when it is set', () => {
    expect(shortLabel({ ...item, short: '  Reply history ' })).toBe('Reply history');
    expect(shortLabel({ ...topic, short: 'Delivery' })).toBe('Delivery');
  });
  it('falls back to the question or name cut at a word boundary near 24 characters', () => {
    expect(shortLabel({ ...item, short: '  ', question: 'Keep the full reply history?' })).toBe('Keep the full reply…');
    expect(shortLabel({ ...item, short: null, question: 'Short question?' })).toBe('Short question?');
    expect(shortLabel({ ...item, question: 'Averyveryverylongsingleword that keeps going' })).toBe('Averyveryverylongsinglew…');
    expect(shortLabel({ ...topic, short: undefined, name: 'Delivery decisions' })).toBe('Delivery decisions');
  });
});
