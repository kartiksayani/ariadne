import { expect, it } from 'vitest';
import { AppTransport, route } from '../app/transport';
import { createDesktopService } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { dockQuestions } from '../../../src/ui/dock/AnswerDock';

it('a receipt locks only the question it answered; a later question on that item enters the dock', async () => {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const drafts = new OwnerDraftStore(createDesktopService(transport)); await drafts.load();
  const id = drafts.begin(session, '2', 'answer')!;
  await drafts.editSaved(id, { text: 'The first answer stays in history.' });
  expect(await drafts.submit(id)).toBe(true);
  expect(dockQuestions(session, drafts).some(question => question.itemId === '2')).toBe(false);
  const item = session.items['2']!;
  item.question_revision++; item.revision++; item.question = 'A new question on the same item';
  expect(dockQuestions(session, drafts).find(question => question.itemId === '2')?.question).toBe(item.question);
  expect(drafts.getSnapshot().entries[id]?.sent?.text).toBe('The first answer stays in history.');
});

it('orders the dock oldest first, ties by item number, and leaves out a question the removal queue hides', async () => {
  const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
  const drafts = new OwnerDraftStore(createDesktopService(transport)); await drafts.load();
  // A second waiting question, numbered so that text order and number order differ (10 after 2).
  session.items['10'] = { ...structuredClone(session.items['2']!), id: '10', question: 'A second waiting question' };
  const waiting = dockQuestions(session, drafts).map(question => question.itemId);
  expect(waiting).toEqual(['2', '10']);
  const [first, second] = waiting as [string, string];
  session.items[first]!.waiting_since = '2026-10-05T03:00:00.000Z';
  session.items[second]!.waiting_since = '2026-10-05T01:00:00.000Z';
  expect(dockQuestions(session, drafts).map(question => question.itemId).slice(0, 2)).toEqual([second, first]);
  for (const itemId of waiting) session.items[itemId]!.waiting_since = '2026-10-05T01:00:00.000Z';
  expect(dockQuestions(session, drafts).map(question => question.itemId))
    .toEqual([...waiting].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  expect(dockQuestions(session, drafts, itemId => itemId === first).map(question => question.itemId)).not.toContain(first);
});
