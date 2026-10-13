import { afterEach, expect, it } from 'vitest';
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
  const eligible = ackAllItems(store.getSnapshot().snapshot!.session, topicId).length;
  const element = <TopicRow row={row} focused actions={[]} prompt={null} remember={() => {}}
    onFocus={() => {}} onKeyDown={() => {}} onToggle={() => {}} ackAllCount={eligible}
    ackAll={<AckAll actions={actions} topicId={topicId} topicName={row.topic.name} />} />;
  return { element, eligible };
}

it('replaces the full to-ack count with Ack all when every result is eligible', async () => {
  const { element } = await topic(['finding', 'explanation']); render(element);
  expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
  expect(screen.queryByText(/to ack/)).toBeNull();
  expect(screen.getByText('2 open')).toBeTruthy();
});

it('shows the bulk count alongside the individual question and decision count', async () => {
  const { element, eligible } = await topic(['finding', 'explanation', 'question', 'decision']); render(element);
  expect(eligible).toBe(2);
  expect(screen.getByRole('button', { name: 'Ack all (2)' })).toBeTruthy();
  expect(screen.getByText('2 to ack one by one')).toBeTruthy();
  expect(screen.queryByText('4 to ack')).toBeNull();
});

it.each([['question'], ['decision'], ['question', 'decision']] as const)(
  'preserves the plain count when %j leaves the mounted AckAll component empty', async (...types) => {
    const { element, eligible } = await topic(types); render(element);
    expect(eligible).toBe(0);
    expect(screen.queryByRole('button', { name: /^Ack all/ })).toBeNull();
    expect(screen.getByText(`${types.length} to ack`)).toBeTruthy();
    expect(screen.queryByText(/one by one/)).toBeNull();
  });

it('renders no acknowledgment count when no items need Ack', async () => {
  const { element } = await topic([]); render(element);
  expect(screen.queryByRole('button', { name: /^Ack all/ })).toBeNull();
  expect(screen.queryByText(/to ack/)).toBeNull();
});
