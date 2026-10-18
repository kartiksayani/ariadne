import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { OpenSessions, useSession } from '../../../src/data/session-store';
import type { OwnerDraft } from '../../../src/generated/core';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { notices } from '../../../src/ui/pages/notices';
import { useRecoveredNotices } from '../../../src/ui/answer/useRecoveredNotices';
import { AppTransport, route } from '../app/transport';

const opened: OpenSessions[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(sessions => sessions.closeAll()); notices.clear(); vi.restoreAllMocks(); });

const draftOf = (transport: AppTransport, patch: Partial<OwnerDraft> = {}): OwnerDraft => {
  const session = transport.sessions.get(route.session_id)!, item = session.items['2']!;
  return { submission_attempted: false, op_id: '00000000-0000-4000-8000-0000000000d1', session: route, binding_id: session.active_binding_id!,
    target: { topic_id: item.topic_id, item_id: item.id }, intent: 'reply', text: '  my words\nsecond line ', selected_option_id: null,
    target_revision: item.revision, question_revision: item.question_revision, supersedes_answer_id: null, ...patch };
};
async function setup(drafts: (transport: AppTransport) => OwnerDraft[], selected = true) {
  const transport = new AppTransport();
  transport.preferences.drafts = drafts(transport);
  const service = createDesktopService(transport), sessions = new OpenSessions(service);
  opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const owner = new OwnerDraftStore(service); await owner.load();
  const openItem = vi.fn(), openTopic = vi.fn();
  function Harness({ on }: { readonly on: boolean }) {
    const current = useSession(store);
    useRecoveredNotices({ session: on ? current.snapshot?.session ?? null : null, drafts: owner, openItem, openTopic });
    return null;
  }
  const view = render(<Harness on={selected} />);
  return { transport, owner, openItem, openTopic, view, Harness, store };
}
const shown = () => notices.getSnapshot().filter(notice => notice.id.startsWith('recovered:'));

describe('recovered words (alpha.21 E18)', () => {
  it('marks only drafts that loaded with words and no send attempt', async () => {
    const { owner } = await setup(transport => [draftOf(transport), draftOf(transport, { op_id: '00000000-0000-4000-8000-0000000000d2', intent: 'note', text: '   ' }),
      draftOf(transport, { op_id: '00000000-0000-4000-8000-0000000000d3', intent: 'note', submission_attempted: true, text: 'sent once' })]);
    const entries = owner.getSnapshot().entries;
    expect(entries['00000000-0000-4000-8000-0000000000d1']!.origin).toBe('recovered');
    expect(entries['00000000-0000-4000-8000-0000000000d2']!.origin).toBeUndefined();
    expect(entries['00000000-0000-4000-8000-0000000000d3']!.origin).toBeUndefined();
    expect(entries['00000000-0000-4000-8000-0000000000d3']!.uncertain).toBe(true);
  });

  it('says so once, with Show it, and Nothing was sent', async () => {
    const { openItem, transport } = await setup(value => [draftOf(value)]);
    await waitFor(() => expect(shown()).toHaveLength(1));
    const notice = shown()[0]!, question = transport.sessions.get(route.session_id)!.items['2']!.question;
    expect(notice.text).toBe(`Ariadne restarted. Your unsent reply about “${question.length > 40 ? `${question.slice(0, 38).trimEnd()}…` : question}” is back in Details’ composer, as you left it. Nothing was sent.`);
    expect(notice.actions?.map(action => action.label)).toEqual(['Show it']);
    act(() => notice.actions![0]!.run());
    expect(openItem).toHaveBeenCalledWith('2');
  });

  it('words an answer as an answer and a topic reply as a reply about the topic', async () => {
    const { openTopic } = await setup(transport => {
      const session = transport.sessions.get(route.session_id)!, topic = Object.values(session.topics)[0]!;
      return [draftOf(transport, { intent: 'answer' }), draftOf(transport, { op_id: '00000000-0000-4000-8000-0000000000d4', intent: 'topic_reply',
        target: { topic_id: topic.id, item_id: null }, question_revision: null })];
    });
    await waitFor(() => expect(shown()).toHaveLength(2));
    expect(shown().some(notice => /Your unsent answer on “/u.test(notice.text))).toBe(true);
    const topic = shown().find(notice => /Your unsent reply about “/u.test(notice.text))!;
    act(() => topic.actions![0]!.run());
    expect(openTopic).toHaveBeenCalled();
  });

  it('waits for the draft’s session to be the one on screen, then tells once', async () => {
    const { view, Harness } = await setup(value => [draftOf(value)], false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(shown()).toHaveLength(0);
    view.rerender(<Harness on />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    const notice = shown()[0]!;
    act(() => { notice.onDismiss?.(); notices.dismiss(notice.id); });
    view.rerender(<Harness on={false} />); view.rerender(<Harness on />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(shown()).toHaveLength(0);
  });

  it('drops the notice and the mark when the owner edits the words', async () => {
    const { owner } = await setup(value => [draftOf(value)]);
    await waitFor(() => expect(shown()).toHaveLength(1));
    await act(async () => { await owner.editSaved('00000000-0000-4000-8000-0000000000d1', { text: 'changed my mind' }); });
    expect(owner.getSnapshot().entries['00000000-0000-4000-8000-0000000000d1']!.origin).toBeUndefined();
    await waitFor(() => expect(shown()).toHaveLength(0));
  });

  it('keeps the mark when an edit changes nothing', async () => {
    const { owner } = await setup(value => [draftOf(value)]);
    await act(async () => { await owner.editSaved('00000000-0000-4000-8000-0000000000d1', { text: '  my words\nsecond line ' }); });
    expect(owner.getSnapshot().entries['00000000-0000-4000-8000-0000000000d1']!.origin).toBe('recovered');
  });

  it('clears the mark when the owner sends the words', async () => {
    const { owner } = await setup(value => [draftOf(value)]);
    await waitFor(() => expect(shown()).toHaveLength(1));
    await act(async () => { await owner.submit('00000000-0000-4000-8000-0000000000d1'); });
    expect(owner.getSnapshot().entries['00000000-0000-4000-8000-0000000000d1']!.origin).toBeUndefined();
    await waitFor(() => expect(shown()).toHaveLength(0));
  });

  it('has no notice for a draft whose item is gone', async () => {
    await setup(value => [draftOf(value, { target: { topic_id: draftOf(value).target.topic_id, item_id: 'no-such-item' } })]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(shown()).toHaveLength(0);
  });
});
