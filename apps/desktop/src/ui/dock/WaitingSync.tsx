// What the Waiting column did without being seen: it kept the cross-session capture running, reconciled every
// captured session's attempted drafts (so a send whose result was unknown confirms from any session), and announced
// new questions to screen readers. It now runs once in the workspace, whether or not the dock is on screen.
import { useEffect } from 'react';
import { useWaiting, type WaitingStore } from '../../selectors/waiting/store';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { QueueAnnouncements } from '../../components/accessibility/QueueAnnouncements';

export function WaitingSync({ waiting, drafts }: { readonly waiting: WaitingStore; readonly drafts: OwnerDraftStore }) {
  const state = useWaiting(waiting), draftState = useOwnerDrafts(drafts);
  useEffect(() => { void waiting.start(); }, [waiting]);
  useEffect(() => { if (!drafts.getSnapshot().ready) void drafts.load(); }, [drafts]);
  useEffect(() => {
    if (!draftState.ready) return;
    for (const { session } of state.sessions) {
      const latest = waiting.sessionState({ project_id: session.project_id, session_id: session.id })?.snapshot?.session ?? session;
      void drafts.reconcile(latest);
    }
  }, [drafts, waiting, state, draftState.ready, draftState.entries]);
  return <QueueAnnouncements state={state} />;
}
