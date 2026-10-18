import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionStore } from '../../../src/data/session-store';
import { createDesktopService } from '../../../src/data/service';
import { SessionActions } from '../../../src/components/bindings/actions';
import type { Item } from '../../../src/generated/domain/models';
import { AckAll } from '../../../src/ui/navigation/AckAll';
import { ackAllItems } from '../../../src/ui/navigation/ackAllController';
import { TopicRow } from '../../../src/ui/tree/TopicRow';
import { topicCounts, type TopicRow as Row } from '../../../src/ui/tree/model';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from '../app/transport';
import { shimTree } from './shimTree';

const stores: SessionStore[] = [];
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.close()); notices.clear(); });

async function topic(types: readonly Item['type'][]) {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  Object.values(session.items).forEach(item => { if (item) item.ack_to = null; });
  const topicId = session.items['1']!.topic_id;
  for (const [index, type] of types.entries()) {
    const item = session.items[['1', '1.1', '2', '3'][index]!]!;
    Object.assign(item, { topic_id: topicId, type, status: 'open', ask: null, ack_to: 'done' });
  }
  const service = createDesktopService(transport), store = new SessionStore(service, route);
  stores.push(store); await store.refresh();
  const actions = new SessionActions(service, store);
  const row: Row = { kind: 'topic', key: topicId, topic: session.topics[topicId]!, depth: 0,
    expanded: true, first: true, guides: [], earlier: false, chip: null, allClosed: false, delivery: null,
    counts: topicCounts(types.map(() => 'open'), types.length) };
  const items = ackAllItems(store.getSnapshot().snapshot!.session, topicId), eligible = items.length;
  const element = <TopicRow row={row} focused actions={[]} prompt={null} remember={() => {}}
    onFocus={() => {}} onKeyDown={() => {}} onToggle={() => {}}
    ackAll={<AckAll actions={actions} topicId={topicId} topicName={row.topic.name} items={items} />} />;
  return { element, eligible };
}

it('keeps the to-ack count beside Ack all when every result is eligible (SPEC 4.1)', async () => {
  const { element } = await topic(['finding', 'explanation']); render(element);
  expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
  expect(screen.getByText('2 to ack')).toBeTruthy();
  expect(screen.getByText('2 open')).toBeTruthy();
});

it('shows the bulk count beside the whole to-ack count, never rewriting it', async () => {
  const { element, eligible } = await topic(['finding', 'explanation', 'question', 'decision']); render(element);
  expect(eligible).toBe(2);
  expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
  expect(screen.getByText('4 to ack')).toBeTruthy();
  expect(screen.queryByText(/one by one/)).toBeNull();
});

it.each([['question'], ['decision'], ['question', 'decision']] as const)(
  'preserves the plain count when %j leaves the mounted AckAll component empty', async (...types) => {
    const { element, eligible } = await topic(types); render(element);
    expect(eligible).toBe(0);
    expect(screen.queryByRole('button', { name: /^Ack all/ })).toBeNull();
    expect(screen.getByText(`${types.length} to ack`)).toBeTruthy();
    expect(screen.queryByText(/one by one/)).toBeNull();
  });

describe('the band\'s to-ack count while single Acks are held (D11)', () => {
  const countsOf = (ackHeld?: ReadonlySet<string>) => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    Object.values(session.items).forEach(item => { if (item) item.ack_to = null; });
    for (const id of ['1', '1.1', '2']) Object.assign(session.items[id]!, { type: 'finding', status: 'open', ask: null, ack_to: 'done', topic_id: session.items['1']!.topic_id });
    const view = transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
    const rows = shimTree({ session, view, search: '', later: new Set<string>(), collapsedTopics: new Set<string>(), selectedId: null,
      revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.now(), ackHeld }).rows;
    return (rows.find(row => row.kind === 'topic' && row.key === session.items['1']!.topic_id) as Row).counts.map(count => count.text);
  };
  it('counts every item that can be acked when nothing is held', () => {
    expect(countsOf()).toContain('3 to ack');
  });
  it('leaves out an item whose Ack is held, and the count goes with the last one', () => {
    expect(countsOf(new Set(['1.1']))).toContain('2 to ack');
    expect(countsOf(new Set(['1', '1.1']))).toContain('1 to ack');
    expect(countsOf(new Set(['1', '1.1', '2'])).some(text => text.endsWith('to ack'))).toBe(false);
  });
  it('ignores a held id that is not in the topic', () => {
    expect(countsOf(new Set(['8']))).toContain('3 to ack');
  });
});

it('renders no acknowledgment count when no items need Ack', async () => {
  const { element } = await topic([]); render(element);
  expect(screen.queryByRole('button', { name: /^Ack all/ })).toBeNull();
  expect(screen.queryByText(/to ack/)).toBeNull();
});
