import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Immutable, OpenSessions, SessionStore } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { WaitingStore } from '../../selectors/waiting/store';
import { notSent } from '../../selectors/waiting/stuck';
import { useOwnerDrafts, type OwnerDraftStore } from '../../state/drafts/store';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
import { notices } from '../pages/notices';
import { inItemConversation } from '../../selectors/history';
import { copyText } from '../shared/clipboard';
import { ALREADY_SENT, NOT_TAKEN_BACK, TAKEN_BACK_NOT_LOADED, editable, putBackBlocked, putBackCancelled, sendingAgain } from './held';

const noSubscribe = () => () => {};
const noSession = () => null;

/** Recovery for messages with no item conversation. Action notices never expire. */
export function UnsentMessageNotices({ waiting, drafts, opened, selectedStore, navigation }: {
  readonly waiting: WaitingStore; readonly drafts: OwnerDraftStore; readonly opened: OpenSessions;
  readonly selectedStore: SessionStore | null;
  readonly navigation: NavigationStore;
}) {
  const waitingState = useSyncExternalStore(waiting.subscribe, waiting.getSnapshot);
  const selectedState = useSyncExternalStore(selectedStore?.subscribe ?? noSubscribe, selectedStore?.getSnapshot ?? noSession);
  const draftState = useOwnerDrafts(drafts);
  const navigationState = useNavigation(navigation);
  const finished = useRef(new Set<string>());
  const flights = useRef(new Set<string>());
  const restored = useRef(new Set<string>());
  const hints = useRef(new Map<string, string>());
  const observed = useRef(new Map<string, Immutable<Session>>());
  const published = useRef(new Set<string>());
  const active = useRef(true);
  useEffect(() => {
    // Saved dismissals must be known before any recovery notice is published.
    if (!navigationState.preferences) return;
    const resolved = new Set(navigationState.preferences.resolved_unsent_input_ids ?? []);
    for (const session of [...waitingState.sessions.map(value => value.session), ...(selectedState?.snapshot ? [selectedState.snapshot.session] : [])]) {
      const old = observed.current.get(session.id);
      if (!old || old.revision <= session.revision) observed.current.set(session.id, session);
    }
    const pending = new Set<string>();
    for (const session of observed.current.values()) for (const message of session.messages) {
      const unsent = notSent(session, message);
      if (!unsent || !['topic_archived', 'session_closed', 'agent_removed'].includes(unsent.input.cancel_cause ?? '')
        || !editable(unsent.input.kind) || inItemConversation(session, message)) continue;
      const id = `unsent:${session.id}:${unsent.input.id}`;
      const inputId = unsent.input.id;
      if (finished.current.has(inputId) || resolved.has(inputId)) continue;
      if (unsent.again || sendingAgain(draftState, session, unsent.input)) {
        notices.dismiss(id); continue;
      }
      pending.add(id);
      const name = unsent.input.target.item_id ? unsent.input.payload.target_snapshot.item_question ?? unsent.input.payload.target_snapshot.topic_name
        : session.topics[unsent.input.target.topic_id]?.name ?? unsent.input.payload.target_snapshot.topic_name;
      published.current.add(id);
      const show = (hint?: string) => {
        if (hint) hints.current.set(inputId, hint);
        if (!active.current || finished.current.has(inputId)) return;
        const blocked = putBackBlocked(observed.current.get(session.id) ?? session, unsent.input);
        const storedHint = hints.current.get(inputId);
        const detail = [blocked, storedHint !== blocked ? storedHint : null].filter(Boolean).join(' ');
        const firstLine = unsent.input.payload.text.split(/\r?\n/u)[0].trim();
        const quote = firstLine.length > 72 ? `${firstLine.slice(0, 70).trimEnd()}…` : firstLine;
        notices.push({ id, icon: 'ph ph-chat-text',
        text: `Your unsent message to ${name} was kept${quote ? `: “${quote}”` : ''}${detail ? `. ${detail}` : ''}`,
        dismissible: !flights.current.has(inputId),
        onDismiss: () => { void resolve(false); },
        actions: [{ label: 'Put back in reply box', disabled: !!blocked || flights.current.has(inputId), run: () => {
          if (flights.current.has(inputId)) return;
          if (restored.current.has(inputId)) { void resolve(true); return; }
          const store = opened.get({ project_id: session.project_id, session_id: session.id });
          const current = store?.getSnapshot().snapshot?.session ?? observed.current.get(session.id)!;
          const input = current.inputs[unsent.input.id];
          if (!input || input.state !== 'cancelled') return;
          const reason = putBackBlocked(current, input);
          if (reason) { show(reason); return; }
          flights.current.add(inputId); show();
          void putBackCancelled(drafts, current, input).then(outcome => {
            flights.current.delete(inputId);
            if (outcome.kind === 'moved') { restored.current.add(inputId); void resolve(true); }
            else show(outcome.kind === 'kept' ? 'Your reply box already has text. Keep it or clear it before putting this message back.'
              : outcome.kind === 'already_sent' ? ALREADY_SENT : outcome.kind === 'not_taken_back' ? NOT_TAKEN_BACK
                : outcome.kind === 'taken_back' ? TAKEN_BACK_NOT_LOADED : 'Your reply box is busy. Try again when it is ready.');
          }, () => { flights.current.delete(inputId); show('Couldn’t put it back. Your message is still kept; try again.'); });
        } }, { label: 'Copy', run: () => {
          void copyText(unsent.input.payload.text).then(() => show('Copied.'),
            () => show('Couldn’t copy your message. Try Copy again.'));
        } }],
      });
      };
      const resolve = async (moved: boolean) => {
        if (flights.current.has(inputId)) return;
        flights.current.add(inputId);
        show(moved ? 'Your message is in the reply box. Saving recovery…' : 'Saving dismissal…');
        try {
          if (!await navigation.resolveUnsentInput(inputId)) throw new Error('Recovery save unconfirmed');
          finished.current.add(inputId);
          notices.dismiss(id);
          if (moved && active.current) notices.push({ icon: 'ph ph-check', text: 'Put back. Open “Reply to topic” on its topic to send it.' });
        } catch {
          hints.current.set(inputId, moved ? 'Your message is in the reply box, but recovery couldn’t be saved. Try “Put back in reply box” again to save it.'
            : 'Couldn’t save the dismissal. Your message is still kept; dismiss it again to retry.');
        } finally {
          flights.current.delete(inputId);
          show();
        }
      };
      show();
    }
    for (const id of published.current) if (!pending.has(id)) notices.dismiss(id);
  }, [waitingState.sessions, selectedState, draftState, drafts, opened, navigation, navigationState.preferences]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; for (const id of published.current) notices.dismiss(id); };
  }, []);
  return null;
}
