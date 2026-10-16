import { beforeEach, expect, it, vi } from 'vitest';
import type { NotRunningChoice } from '../../../src/ui/dialogs/AgentNotRunning';
import { agentNotRunning } from '../../../src/ui/answer/notRunning';
const dialog = vi.hoisted(() => ({ choice: { kind: 'cancel' } as NotRunningChoice, asked: vi.fn() }));
vi.mock('../../../src/ui/dialogs/AgentNotRunning', () => ({ openAgentNotRunning: (submission: unknown) => { dialog.asked(submission); return Promise.resolve(dialog.choice); } }));
beforeEach(() => dialog.asked.mockClear());
it.each(['queue', 'cancel'] as const)('stopped agent: %s never routes elsewhere', async kind => {
  dialog.choice = { kind }; const queue = vi.fn(() => Promise.resolve(true));
  const route = { project_id: 'project', session_id: 'session', item_id: '2' };
  await agentNotRunning()({ route, question: 'Keep it?', intent: 'answer', label: 'Keep', agent: 'agent', change: { text: 'Kept words', selected_option_id: null }, queue });
  expect(dialog.asked).toHaveBeenCalledWith({ item: route, question: 'Keep it?' });
  expect(queue).toHaveBeenCalledTimes(kind === 'queue' ? 1 : 0);
});
