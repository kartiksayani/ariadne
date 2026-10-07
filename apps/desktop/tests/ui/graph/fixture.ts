import demo from '../../../../../fixtures/domain/demo/session.json';
import type { Item, Session } from '../../../src/generated/domain/models';
import type { SessionPreferences } from '../../../src/generated/core';

export const route = { project_id: demo.project_id, session_id: demo.id };
export const topicA = '00000000-0000-4000-8000-000000000010', topicB = '00000000-0000-4000-8000-000000000011';

/**
 * Delivery decisions: 1 (done) › 1.1 (open) › 1.1.1 (waiting), 1 › 1.2 (in progress); 2 (open); 3 replaced by 2.
 * Continued context: 8 (open).
 */
export function graphSession(): Session {
  const session = structuredClone(demo) as Session, template = session.items['1']!;
  const item = (id: string, parent: string | null, ordinal: number, status: Item['status'], question: string, topic = topicA): Item =>
    ({ ...structuredClone(template), id, parent, ordinal, status, question, topic_id: topic, replaced_by: null, outcome: null });
  session.items = {
    1: { ...item('1', null, 1, 'done', 'Keep the full reply history?'), outcome: template.outcome },
    '1.1': item('1.1', '1', 1, 'open', 'add the receipt lookup test, then rerun'),
    '1.1.1': item('1.1.1', '1.1', 1, 'waiting_on_me', 'Which delivery window: morning or evening?'),
    '1.2': item('1.2', '1', 2, 'in_progress', 'Implement receipt lookup'),
    2: item('2', null, 2, 'open', 'Record retry limits'),
    3: { ...item('3', null, 3, 'replaced', 'Replace the old retry question'), replaced_by: '2' },
    8: item('8', null, 8, 'open', 'Preserve continued context', topicB),
  };
  return session;
}

export function preferences(overrides: Partial<SessionPreferences> = {}): SessionPreferences {
  return { session: route, tab_open: true, tab_order: 0, selected_item_id: null, expanded_item_ids: ['1', '1.1'],
    filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'hidden', scroll: null, ...overrides };
}
