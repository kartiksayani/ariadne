import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Chip } from '../../../src/ui/pages/SessionLists';
import type { Immutable } from '../../../src/data/session-store';
import type { Session } from '../../../src/generated/domain/models';
import { projectRemoval, sessionRemoval, topicChips } from '../../../src/ui/pages/model';
import demo from '../../../../../fixtures/domain/demo/session.json';

const topic = (id: string, order: number, name: string, short: string | null) =>
  ({ id, name, short, order, revision: 1, created_at: 0, archived_at: null, origin: null });

afterEach(cleanup);

describe('session card topic chips', () => {
  it.each(['closed', 'archived'] as const)('excludes %s waiting questions from topic, session and project counts', state => {
    const session = structuredClone(demo) as Session;
    session.state = 'closed';
    if (state === 'archived') session.archived_at = session.updated_at;
    expect(topicChips(session, new Set()).every(chip => !chip.counts.includes('waiting'))).toBe(true);
    expect(sessionRemoval(session, new Set()).waiting).toBe(0);
    expect(projectRemoval([session]).waiting).toBe(0);
    expect(session.items['2']!.status).toBe('waiting_on_me');
  });
  it('label each topic with its short label, cutting a long name without one', () => {
    const session = { id: 's', items: {}, topics: {
      a: topic('a', 1, "Reviewer's comments on the SDK cache PR (#226)", 'SDK cache PR'),
      b: topic('b', 2, 'Unreadable entries in the shared cache after a deploy', null),
      c: topic('c', 3, 'Cache key prefix', null),
    } } as unknown as Immutable<Session>;
    expect(topicChips(session, new Set()).map(chip => chip.name)).toEqual(['SDK cache PR', 'Unreadable entries in…', 'Cache key prefix']);
  });
  it('carry the full topic name for the tooltip', () => {
    const session = { id: 's', items: {}, topics: {
      a: topic('a', 1, "Reviewer's comments on the SDK cache PR (#226)", 'SDK cache PR'),
    } } as unknown as Immutable<Session>;
    expect(topicChips(session, new Set()).map(chip => chip.full)).toEqual(["Reviewer's comments on the SDK cache PR (#226)"]);
  });
  it('counts Queued and Sent replies separately while cancelled replies need the owner again', () => {
    const session = structuredClone(demo) as Session, item = session.items['2']!;
    const queued = session.inputs['00000000-0000-4000-8000-000000000076']!;
    const attempt = structuredClone(session.inputs['00000000-0000-4000-8000-000000000072']!.attempts[0]!);
    session.topics = { [item.topic_id]: session.topics[item.topic_id]! };
    session.items = { 2: item, 3: { ...structuredClone(item), id: '3' } };
    session.inputs = { [queued.id]: queued }; session.answers = [];
    queued.target.item_id = item.id; queued.kind = 'reply';
    queued.payload.target_snapshot.question_revision = item.question_revision;
    expect(topicChips(session, new Set())[0]!.counts).toBe('1 waiting · 1 queued');
    queued.state = 'in_flight'; queued.active_attempt_id = attempt.id; queued.attempts = [attempt];
    expect(topicChips(session, new Set())[0]!.counts).toBe('1 waiting · 1 sent');
    // A cancelled reply needs the owner again.
    queued.state = 'cancelled';
    expect(topicChips(session, new Set())[0]!.counts).toBe('2 waiting');
  });
  it('show the full name as the chip tooltip on the session cards', () => {
    render(<Chip chip={{ id: 'a', name: 'SDK cache PR', full: "Reviewer's comments on the SDK cache PR (#226)", counts: '', icon: 'ph', color: 'red' }} />);
    expect(screen.getByTitle("Reviewer's comments on the SDK cache PR (#226)").textContent).toBe('SDK cache PR');
  });
});
