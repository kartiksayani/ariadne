import { describe, expect, it } from 'vitest';
import demo from '../../../../../fixtures/domain/demo/session.json';
import type { SessionPreferences } from '../../../src/generated/core';
import type { ItemStatus, Session } from '../../../src/generated/domain/models';
import { immutable } from '../../../src/data';
import { oldestWaiting, treeModel, type ItemRow, type TopicRow } from '../../../src/ui/tree/model';
import { sessionGraph } from '../../../src/ui/graph/model';
import { graphSession, preferences } from '../graph/fixture';

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
function view(session: Session, statuses: ItemStatus[] = []): SessionPreferences {
  return { session: { project_id: session.project_id, session_id: session.id }, tab_open: true, selected_item_id: null,
    tab_order: 0, expanded_item_ids: [], filters: { search: '', statuses, owners: [], topic_id: null, archived: false, hide_later: false },
    rail: 'waiting', scroll: null };
}
/** Item 2 waits on the owner; the owner's reply to it is queued. */
function replied(): Session {
  const session = structuredClone(demo) as Session, input = session.inputs[id('76')]!;
  input.target = { ...input.target, item_id: '2' }; input.kind = 'reply';
  return session;
}
const model = (session: Session, statuses: ItemStatus[] = []) => treeModel({ session: immutable(session), view: view(session, statuses),
  search: '', later: new Set(), collapsedTopics: new Set(), selectedId: null, revealId: null, temporaryExpanded: [], presence: null,
  summaries: [], now: Date.parse(session.created_at) });
const row = (tree: ReturnType<typeof model>, itemId: string) => tree.rows.find((value): value is ItemRow => value.kind === 'item' && value.item.id === itemId);
const topic = (tree: ReturnType<typeof model>) => tree.rows.find((value): value is TopicRow => value.kind === 'topic' && value.topic.id === id('10'))!;

describe('an archived topic in the tree counts', () => {
  it('leaves Waiting on me while archived and comes back on restore; its items keep their status', () => {
    const session = structuredClone(demo) as Session, waitingTopic = session.topics[session.items['2']!.topic_id]!;
    const before = model(session);
    expect(before.counts.waiting).toBeGreaterThan(0); expect(oldestWaiting(immutable(session))?.id).toBe('2');
    waitingTopic.archived_at = session.updated_at;
    const archived = model(session);
    expect(archived.counts.waiting).toBe(0); expect(oldestWaiting(immutable(session))).toBeNull();
    expect(session.items['2']!.status).toBe('waiting_on_me');
    waitingTopic.archived_at = null;
    expect(model(session).counts).toEqual(before.counts); expect(oldestWaiting(immutable(session))?.id).toBe('2');
  });
});

describe('Waiting on agent in the tree and graph', () => {
  it('badges a replied item Waiting on agent and moves it out of the Waiting on me counts', () => {
    const before = model(structuredClone(demo) as Session), after = model(replied());
    expect(row(before, '2')!.badge).toBe('Waiting on me');
    expect(row(after, '2')).toMatchObject({ status: 'waiting_on_agent', badge: 'Waiting on agent' });
    expect(after.counts.waiting).toBe(before.counts.waiting - 1);
    expect(topic(before).counts.map(count => count.text)).toContain('1 waiting on you');
    const texts = topic(after).counts.map(count => count.text);
    expect(texts).toContain('1 waiting on agent'); expect(texts.some(text => text.includes('waiting on you'))).toBe(false);
  });
  it('filters a replied item with In progress, never with Waiting on me', () => {
    expect(row(model(replied(), ['waiting_on_me']), '2')).toBeUndefined();
    expect(row(model(replied(), ['in_progress']), '2')?.status).toBe('waiting_on_agent');
  });
  it('shows the graph node as Waiting on agent with its topic count', () => {
    const session = graphSession(), input = session.inputs[id('76')]!;
    input.target = { ...input.target, item_id: '1.1.1' }; input.kind = 'reply';
    const graph = sessionGraph({ session: immutable(session), view: preferences({ expanded_item_ids: ['1', '1.1'] }), later: new Set(), selectedId: null, tight: false });
    expect(graph.nodes.get('1.1.1')!.status).toBe('agent');
    expect(graph.topics[0].counts).toBe('1 waiting on agent · 2 open · 1 in progress · 2 closed');
  });
});
