import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { AppTransport, route } from '../app/transport';
import { createDesktopService } from '../../../src/data/service';
import { SessionStore } from '../../../src/data/session-store';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { useSubmit, type PendingSubmission } from '../../../src/ui/answer/useSubmit';

afterEach(cleanup);
it.each(['Cancel', 'Queue it'] as const)('one shared lock while stopped-agent dialog is open: %s', async choice => {
  const transport = new AppTransport(), source = transport.sessions.get(route.session_id)!;
  source.bindings[source.active_binding_id!]!.connection_state = 'disconnected';
  const service = createDesktopService(transport), store = new SessionStore(service, route), drafts = new OwnerDraftStore(service);
  await Promise.all([store.refresh(), drafts.load()]);
  const requests: PendingSubmission[] = [];
  const options = { drafts, session: store.getSnapshot().snapshot!.session, current: true, itemId: '2', intent: 'answer' as const,
    onAgentNotRunning: (request: PendingSubmission) => { requests.push(request); } };
  const first = renderHook(() => useSubmit(options)), second = renderHook(() => useSubmit(options));
  await waitFor(() => expect(first.result.current.entry).toBeDefined());
  act(() => first.result.current.write('Kept while the dialog is open'));
  act(() => { first.result.current.sendText('Kept while the dialog is open'); second.result.current.sendText('Duplicate'); });
  expect(requests).toHaveLength(1); expect(second.result.current.locked).toBe(true);
  if (choice === 'Cancel') {
    act(() => requests[0]!.cancel?.());
    expect(await requests[0]!.queue()).toBe(false);
    expect(first.result.current.entry?.draft.text).toBe('Kept while the dialog is open');
    expect(first.result.current.locked).toBe(false);
  } else {
    await act(async () => { await Promise.all([requests[0]!.queue(), requests[0]!.queue()]); });
    expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(1);
  }
  store.close();
});
