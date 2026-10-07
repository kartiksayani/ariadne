// What Send does when the session's agent isn't running (handoff 1ad,
// Ariadne.dc.html:1691-1705). The owner queues the answer for that agent, or
// sends it to a running session in the same project: that session continues
// the topic (the reviewed Continue dialog, frame 1y), then the answer goes to
// the copied item there.
import type { ItemRoute, SessionRef } from '../../generated/core';
import type { OwnerDraftStore } from '../../state/drafts/store';
import type { NavigationStore } from '../../state/navigation/store';
import { openAgentNotRunning } from '../dialogs/AgentNotRunning';
import { openContinueTopic } from '../dialogs/ContinueTopicDialog';
import type { PendingSubmission } from './useSubmit';

export interface NotRunningDeps {
  readonly navigation: NavigationStore;
  readonly drafts: OwnerDraftStore;
  /** Shows the item that received the answer. */
  readonly reveal: (route: ItemRoute) => void;
}

/** The `onAgentNotRunning` handler for every answer control. */
export function agentNotRunning({ navigation, drafts, reveal }: NotRunningDeps) {
  return async (submission: PendingSubmission): Promise<void> => {
    const choice = await openAgentNotRunning({ item: submission.route, question: submission.question });
    if (choice.kind === 'queue') { await submission.queue(); return; }
    if (choice.kind !== 'send_live') return;
    const { project_id, session_id, item_id } = submission.route, source = { project_id, session_id };
    const item = navigation.opened.open(source).getSnapshot().snapshot?.session.items[item_id];
    if (!item) return;
    openContinueTopic({ source, topicId: item.topic_id, target: choice.session, onSent: target => {
      void carryAnswer(navigation, drafts, submission, target).then(route => { if (route) reveal(route); });
    } });
  };
}

/** Sends the held answer to the copy of its item in `target`; returns that item, or null when no copy exists. */
export async function carryAnswer(navigation: NavigationStore, drafts: OwnerDraftStore, submission: PendingSubmission, target: SessionRef): Promise<ItemRoute | null> {
  const { project_id, session_id, item_id } = submission.route, source = { project_id, session_id };
  const store = navigation.opened.open(target);
  await store.refresh();
  const session = store.getSnapshot().snapshot?.session;
  const copy = session ? Object.values(session.items).find(value => {
    const origin = value?.origin;
    return origin?.project_id === project_id && origin.session_id === session_id && origin.entity_id === item_id;
  }) : undefined;
  if (!session || !copy) return null;
  const route = { ...target, item_id: copy.id };
  const held = drafts.find(source, item_id, submission.intent), id = drafts.begin(session, copy.id, submission.intent);
  if (!held || !id) return route;
  const picked = held.draft.selected_option_id
    ? navigation.opened.open(source).getSnapshot().snapshot?.session.items[item_id]?.options.find(option => option.id === held.draft.selected_option_id) : undefined;
  const option = picked ? copy.options.find(value => value.id === picked.id) ?? copy.options.find(value => value.label === picked.label) : undefined;
  drafts.edit(id, { text: held.draft.text, selected_option_id: option?.id ?? null });
  // The original stays unsent in the old session; clear it so it is not sent twice.
  if (await drafts.submit(id)) drafts.edit(held.draft.op_id, { text: '', selected_option_id: null });
  return route;
}
