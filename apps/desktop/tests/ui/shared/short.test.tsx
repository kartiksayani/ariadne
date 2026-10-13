import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Item, Topic } from '../../../src/generated/domain/models';
import { itemLabels, shortLabel } from '../../../src/ui/shared/short';

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

describe('itemLabels', () => {
  it('keeps distinct short labels and deduplicates repeated targets', () => {
    const first = { ...item, id: 'first', short: 'Cache lookup' }, second = { ...item, id: 'second', short: 'Receipt lookup' };
    expect([...itemLabels([first, second, first])]).toEqual([['first', 'Cache lookup'], ['second', 'Receipt lookup']]);
  });
  it('puts distinguishing question words before colliding authored and fallback labels', () => {
    const first = { ...item, id: 'first', short: 'Cache lookup', question: 'Cache lookup for receipts?' };
    const second = { ...item, id: 'second', short: 'Cache lookup', question: 'Cache lookup for invoices?' };
    expect([...itemLabels([first, second]).values()]).toEqual(['receipts · Cache lookup', 'invoices · Cache lookup']);
    const oldFirst = { ...first, short: null, question: 'Should we keep the cache for receipts?' };
    const oldSecond = { ...second, short: null, question: 'Should we keep the cache for invoices?' };
    expect(shortLabel(oldFirst)).toBe(shortLabel(oldSecond));
    const labels = [...itemLabels([oldFirst, oldSecond]).values()];
    expect(labels).toEqual([`receipts · ${shortLabel(oldFirst)}`, `invoices · ${shortLabel(oldSecond)}`]);
    expect(labels[0]!.slice(0, 34)).not.toBe(labels[1]!.slice(0, 34));
  });
  it('adds topic names when full questions collide and leaves exact same-topic duplicates truthful', () => {
    const first = { ...item, id: 'first', short: 'Cache', topic_id: 'receipts', question: 'Keep the cache?' };
    const second = { ...first, id: 'second', topic_id: 'invoices' };
    const topics = { receipts: { ...topic, id: 'receipts', name: 'Receipt delivery' }, invoices: { ...topic, id: 'invoices', name: 'Invoice delivery' } };
    expect([...itemLabels([first, second], topics).values()]).toEqual(['Receipt delivery · Cache', 'Invoice delivery · Cache']);
    expect([...itemLabels([first, { ...second, topic_id: 'receipts' }], topics).values()]).toEqual(['Keep the cache? · Receipt delivery', 'Keep the cache? · Receipt delivery']);
    expect([...itemLabels([first, second]).values()]).toEqual([first.question, second.question]);
  });
  it('uses enough distinguishing words for three questions sharing a long opening in one topic', () => {
    const make = (id: string, suffix: string) => ({ ...item, id, short: 'Count cache reads', question: `Should we count cache reads using ${suffix} for this rollout?` });
    const labels = [...itemLabels([make('first', 'Redis local'), make('second', 'Redis remote'), make('third', 'Postgres remote')]).values()];
    expect(labels).toEqual(['Redis local · Count cache reads', 'Redis remote · Count cache reads', 'Postgres · Count cache reads']);
    expect(new Set(labels.map(label => label.slice(0, 34))).size).toBe(3);
  });
  it('puts distinguishing words from long topic names before their shared prefix can be truncated', () => {
    const first = { ...item, id: 'first', short: 'Cache reads', topic_id: 'redis' }, second = { ...item, id: 'second', short: 'Cache reads', topic_id: 'postgres' };
    const topics = {
      redis: { ...topic, id: 'redis', name: 'Delivery decisions for merchant settlement in Redis' },
      postgres: { ...topic, id: 'postgres', name: 'Delivery decisions for merchant settlement in Postgres' },
    };
    expect(topics.redis.name.slice(0, 34)).toBe(topics.postgres.name.slice(0, 34));
    const labels = [...itemLabels([first, second], topics).values()];
    expect(labels).toEqual(['Redis · Cache reads', 'Postgres · Cache reads']);
    expect(new Set(labels.map(label => label.slice(0, 34))).size).toBe(2);
  });
  it('moves distinguishing words ahead of a long prefix shared by only a subgroup', () => {
    const questions = ['Use shared merchant settlement cache configuration Redis', 'Use shared merchant settlement cache configuration Postgres', 'Use local'];
    const items = questions.map((question, index) => ({ ...item, id: String(index), short: 'Cache', question }));
    const labels = [...itemLabels(items).values()];
    expect(labels).toEqual(['Redis · Cache', 'Postgres · Cache', 'local · Cache']);
    expect(new Set(labels.map(label => label.slice(0, 34))).size).toBe(3);
  });
  it('distinguishes 2000 questions with one shared prefix using their own words', () => {
    const words = Array.from({ length: 2000 }, (_, index) => [676, 26, 1].map(place => String.fromCharCode(97 + Math.floor(index / place) % 26)).join(''));
    const items = words.map(word => ({ ...item, id: word, short: 'Count cache reads', question: `Should we count cache reads using ${word} for this rollout?` }));
    const labels = itemLabels(items);
    expect(labels.size).toBe(2000);
    expect(new Set(labels.values()).size).toBe(2000);
    expect([...labels.values()]).toEqual(words.map(word => `${word} · Count cache reads`));
  });
});
