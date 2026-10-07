import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '../../../src/generated/core';
import type { NotRunningChoice } from '../../../src/ui/dialogs/AgentNotRunning';
import type { ContinueRequest } from '../../../src/ui/dialogs/ContinueTopicDialog';
import type { PendingSubmission } from '../../../src/ui/answer/useSubmit';

const dialog = vi.hoisted(() => ({ choice: null as NotRunningChoice | null, asked: [] as unknown[], continued: [] as ContinueRequest[] }));
vi.mock('../../../src/ui/dialogs/AgentNotRunning', () => ({
  openAgentNotRunning: (submission: unknown) => { dialog.asked.push(submission); return Promise.resolve(dialog.choice); },
}));
vi.mock('../../../src/ui/dialogs/ContinueTopicDialog', () => ({ openContinueTopic: (request: ContinueRequest) => { dialog.continued.push(request); } }));

const { agentNotRunning, carryAnswer } = await import('../../../src/ui/answer/notRunning');
const { notices } = await import('../../../src/ui/pages/notices');

const source = { project_id: 'p', session_id: 'old' }, live = { project_id: 'p', session_id: 'live' };
const option = (id: string, label: string) => ({ id, label, consequence: null, recommended: false });
const sessions: Record<string, unknown> = {
  old: { id: 'old', project_id: 'p', items: { '3.1': { id: '3.1', topic_id: 't1', options: [option('a', 'Keep it'), option('b', 'Drop it')] } } },
  live: { id: 'live', project_id: 'p', active_binding_id: 'b', bindings: { b: { adapter_id: 'claude_code_mod' } }, items: {
    '1': { id: '1', topic_id: 't9', options: [], origin: null },
    '2.1': { id: '2.1', topic_id: 't9', options: [option('x', 'Keep it'), option('y', 'Drop it')], origin: { project_id: 'p', session_id: 'old', topic_id: 't1', entity_id: '3.1', source_revision: 4 } },
  } },
};
const refreshed: string[] = [];
const navigation = { opened: { open: (route: SessionRef) => ({
  refresh: () => { refreshed.push(route.session_id); return Promise.resolve(); },
  getSnapshot: () => ({ snapshot: { session: sessions[route.session_id] } }),
}) } };

function fakeDrafts(held: { op_id: string; text: string; selected_option_id: string | null } | null) {
  const edits: [string, unknown][] = [], begun: [string, string][] = [], submitted: string[] = [];
  return { edits, begun, submitted, store: {
    find: (route: SessionRef) => route.session_id === 'old' && held ? { draft: held } : undefined,
    begin: (session: { id: string }, itemId: string) => { begun.push([session.id, itemId]); return 'new-op'; },
    edit: (id: string, change: unknown) => { edits.push([id, change]); },
    submit: (id: string) => { submitted.push(id); return Promise.resolve(true); },
  } };
}
const submission = (queue = vi.fn(() => Promise.resolve(true)), change: PendingSubmission['change'] = { text: '', selected_option_id: 'b' }): PendingSubmission => ({
  route: { ...source, item_id: '3.1' }, intent: 'answer', question: 'Keep the retry?', label: 'Drop it', agent: 'codex', change, queue,
});
const deps = (drafts: ReturnType<typeof fakeDrafts>, reveal = vi.fn()) =>
  ({ navigation: navigation as never, drafts: drafts.store as never, reveal });

describe('Send while the agent is not running', () => {
  beforeEach(() => { dialog.asked = []; dialog.continued = []; refreshed.length = 0; notices.clear(); });

  it('asks with the question, then queues for the stopped agent', async () => {
    dialog.choice = { kind: 'queue' };
    const queue = vi.fn(() => Promise.resolve(true));
    await agentNotRunning(deps(fakeDrafts(null)))(submission(queue));
    expect(dialog.asked).toEqual([{ item: { ...source, item_id: '3.1' }, question: 'Keep the retry?' }]);
    expect(queue).toHaveBeenCalledOnce();
    expect(dialog.continued).toEqual([]);
  });

  it('does nothing on cancel', async () => {
    dialog.choice = { kind: 'cancel' };
    const queue = vi.fn(() => Promise.resolve(true)), drafts = fakeDrafts(null);
    await agentNotRunning(deps(drafts))(submission(queue));
    expect(queue).not.toHaveBeenCalled();
    expect(dialog.continued).toEqual([]);
    expect(drafts.submitted).toEqual([]);
  });

  it('continues the topic in the live session, then sends the answer to the copied item', async () => {
    dialog.choice = { kind: 'send_live', session: live };
    const drafts = fakeDrafts({ op_id: 'held', text: '', selected_option_id: 'b' }), reveal = vi.fn();
    await agentNotRunning(deps(drafts, reveal))(submission());
    expect(dialog.continued).toHaveLength(1);
    expect(dialog.continued[0]).toMatchObject({ source, topicId: 't1', target: live });
    dialog.continued[0].onSent?.(live);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith({ ...live, item_id: '2.1' }));
    expect(refreshed).toEqual(['live']);
    expect(drafts.begun).toEqual([['live', '2.1']]);
    expect(drafts.edits).toEqual([['new-op', { text: '', selected_option_id: 'y' }], ['held', { text: '', selected_option_id: null }]]);
    expect(drafts.submitted).toEqual(['new-op']);
  });

  it('carries a written answer, and reports no copy when the topic was not continued', async () => {
    const drafts = fakeDrafts({ op_id: 'held', text: 'Only on 5xx', selected_option_id: null });
    const written = submission(undefined, { text: 'Only on 5xx', selected_option_id: null });
    expect(await carryAnswer(navigation as never, drafts.store as never, written, live)).toEqual({ ...live, item_id: '2.1' });
    expect(drafts.edits[0]).toEqual(['new-op', { text: 'Only on 5xx', selected_option_id: null }]);
    const other = { ...submission(), route: { ...source, item_id: '9' } };
    expect(await carryAnswer(navigation as never, fakeDrafts(null).store as never, other, live)).toBeNull();
    expect(notices.getSnapshot()).toEqual([]);
  });

  it('says so when the copy was made but nothing could be sent', async () => {
    const drafts = fakeDrafts(null), store = { ...drafts.store, begin: () => null };
    expect(await carryAnswer(navigation as never, store as never, submission(), live)).toEqual({ ...live, item_id: '2.1' });
    expect(notices.getSnapshot().map(notice => [notice.text, notice.dismissible])).toEqual([['Copied to the claude-code session; nothing sent — answer it there.', true]]);
    expect(drafts.submitted).toEqual([]);
  });
});
