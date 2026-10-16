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
