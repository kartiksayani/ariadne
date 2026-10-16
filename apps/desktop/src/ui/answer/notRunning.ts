// Answers always stay with the session and binding that asked the question.
import { openAgentNotRunning } from '../dialogs/AgentNotRunning';
import type { PendingSubmission } from './useSubmit';

export function agentNotRunning() {
  return async (submission: PendingSubmission): Promise<void> => {
    const choice = await openAgentNotRunning({ item: submission.route, question: submission.question });
    if (choice.kind === 'queue') await submission.queue();
    else submission.cancel?.();
  };
}
