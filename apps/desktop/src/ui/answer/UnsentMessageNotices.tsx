import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Immutable, OpenSessions, SessionStore } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { WaitingStore } from '../../selectors/waiting/store';
import { notSent } from '../../selectors/waiting/stuck';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { notices } from '../pages/notices';
import { inItemConversation } from '../../selectors/history';
import { editable, putBackBlocked, putBackCancelled, sendingAgain } from './held';

const noSubscribe = () => () => {};
const noSession = () => null;

/** Recovery for messages with no item conversation. Action notices never expire. */
export function UnsentMessageNotices({ waiting, drafts, opened, selectedStore }: {
  readonly waiting: WaitingStore; readonly drafts: OwnerDraftStore; readonly opened: OpenSessions;
  readonly selectedStore: SessionStore | null;
}) {
  const waitingState = useSyncExternalStore(waiting.subscribe, waiting.getSnapshot);
  const selectedState = useSyncExternalStore(selectedStore?.subscribe ?? noSubscribe, selectedStore?.getSnapshot ?? noSession);
  const draftState = useOwnerDrafts(drafts);
  const finished = useRef(new Set<string>());
  const observed = useRef(new Map<string, Immutable<Session>>());
  const published = useRef(new Set<string>());
  const active = useRef(true);
  useEffect(() => {
    for (const session of [...waitingState.sessions.map(value => value.session), ...(selectedState?.snapshot ? [selectedState.snapshot.session] : [])]) {
      const old = observed.current.get(session.id);
      if (!old || old.revision <= session.revision) observed.current.set(session.id, session);
    }
    const pending = new Set<string>();
    for (const session of observed.current.values()) for (const message of session.messages) {
      const unsent = notSent(session, message);
      if (!unsent || !editable(unsent.input.kind) || inItemConversation(session, message)) continue;
      const id = `unsent:${session.id}:${unsent.input.id}`;
      if (finished.current.has(id)) continue;
      if (unsent.again || sendingAgain(draftState, session, unsent.input)) {
        notices.dismiss(id); continue;
      }
      pending.add(id);
      const blocked = putBackBlocked(session, unsent.input);
      const name = unsent.input.target.item_id ? unsent.input.payload.target_snapshot.item_question ?? unsent.input.payload.target_snapshot.topic_name
        : session.topics[unsent.input.target.topic_id]?.name ?? unsent.input.payload.target_snapshot.topic_name;
      published.current.add(id);
      const show = (hint: string | null = blocked) => {
        if (!active.current || finished.current.has(id)) return;
        notices.push({ id, icon: 'ph ph-chat-text',
        text: `Your unsent message to ${name} was kept${hint ? `. ${hint}` : ''}`,
        onDismiss: () => { finished.current.add(id); },
        actions: [{ label: 'Put back in reply box', disabled: !!blocked, run: () => {
          const store = opened.get({ project_id: session.project_id, session_id: session.id });
          const current = store?.getSnapshot().snapshot?.session ?? observed.current.get(session.id)!;
          const input = current.inputs[unsent.input.id];
          if (!input || input.state !== 'cancelled') return;
          const reason = putBackBlocked(current, input);
          if (reason) { show(reason); return; }
          void putBackCancelled(drafts, current, input).then(outcome => {
            if (outcome.kind === 'moved') { finished.current.add(id); notices.dismiss(id); }
            else show(outcome.kind === 'kept' ? 'Your reply box already has text. Keep it or clear it before putting this message back.'
              : 'Your reply box is busy. Try again when it is ready.');
          }, () => show('Couldn’t put it back. Your message is still kept; try again.'));
        } }],
      });
      };
      show();
    }
    for (const id of published.current) if (!pending.has(id)) notices.dismiss(id);
  }, [waitingState.sessions, selectedState, draftState, drafts, opened]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; for (const id of published.current) notices.dismiss(id); };
  }, []);
  return null;
}
