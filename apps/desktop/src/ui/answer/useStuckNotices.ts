// A notice for an owner message that is still stuck two minutes after it was written (alpha.21 E17, SPEC 11.5). It replaces the
// Tree row's StuckNote and the dock's stuck chip entries: the controls stay in Details (StuckNote); this only says it, once
// per message and case, and offers the one safe next step. Checked every 15 seconds for the selected session.
import { useEffect, useRef } from 'react';
import { useSession, type Immutable } from '../../data/session-store';
import type { Input, Session } from '../../generated/domain/models';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { useSupervisorHealthLookup } from '../../components/bindings/health';
import { connectionOf } from '../shared/connection';
import { targetRemoved } from '../../selectors/removed';
import { stuckInput, type Stuck, type StuckKind } from '../../selectors/waiting/stuck';
import type { OwnerDraftStore } from '../../state/drafts/store';
import { notices, type Notice, type NoticeAction } from '../pages/notices';
import { toasts } from '../shell/toast';
import { clock } from '../shell/model';
import type { OpenTopicInDetails } from '../shell/detailTarget';
import { ALREADY_SENT, editable, editQueued, inEditor, NOT_TAKEN_BACK, TAKEN_BACK_NOT_LOADED, type ReviewOutcome } from './held';
import { agentLabel, sentPhrase, yourSent } from './noticeText';
import { resendPlan } from './StuckNote';

export interface StuckNoticesOptions {
  /** The session on screen; null when none is. Only its messages get notices. */
  readonly session: Immutable<Session> | null;
  /** That session's write barrier: Retry goes through it. */
  readonly actions: SessionActions;
  /** The owner's drafts: Edit takes a queued message back and puts its words in the composer. */
  readonly drafts: OwnerDraftStore;
  /** Opens Details on the item. */
  readonly openItem: (itemId: string) => void;
  /** Opens Details in topic mode. */
  readonly openTopic: OpenTopicInDetails;
}

/** A message is "stuck" after this long. */
export const STUCK_AFTER_MS = 2 * 60_000;
/** How often the age is checked. */
export const STUCK_CHECK_MS = 15_000;
/** Cases that already say why in the Details controls, or that are the owner's own doing: no notice. */
const QUIET: ReadonlySet<StuckKind> = new Set(['held', 'paused', 'blocked', 'behind']);
const LIVE: ReadonlySet<Input['state']> = new Set(['queued', 'in_flight', 'needs_attention']);

/** Why Edit could not take the message back, for the notice. */
function whyNot(outcome: ReviewOutcome): string {
  switch (outcome.kind) {
    case 'already_sent': return ALREADY_SENT;
    case 'not_taken_back': return NOT_TAKEN_BACK;
    case 'taken_back': return TAKEN_BACK_NOT_LOADED;
    default: return 'Your editor is busy saving. Try again in a moment.';
  }
}

export function useStuckNotices({ session, actions, drafts, openItem, openTopic }: StuckNoticesOptions): void {
  const state = useSession(actions.session);
  const operation = useSessionActions(actions);
  const healthOf = useSupervisorHealthLookup(drafts.service);
  const shown = useRef(new Map<string, string>());
  const closed = useRef(new Set<string>());
  const flights = useRef(new Set<string>());
  const hints = useRef(new Map<string, string>());
  const check = useRef<() => void>(() => {});

  check.current = () => {
    const live = new Set<string>();
    const now = Date.now();
    if (session && session.state === 'active') for (const input of Object.values(session.inputs)) {
      if (!input || !LIVE.has(input.state) || input.kind === 'continue' || input.kind === 'removed') continue;
      // Two minutes from the message, or from the owner's last decision on it (Retry sends it again: the clock starts over).
      const created = Math.max(Date.parse(input.created_at), ...input.resolution_history.map(entry => Date.parse(entry.at)).filter(at => !Number.isNaN(at)));
      if (Number.isNaN(created) || now - created < STUCK_AFTER_MS || targetRemoved(session, input.target)) continue;
      const binding = session.bindings[input.binding_id];
      if (!binding || connectionOf(binding, state.presence[binding.id]) !== 'connected') continue;
      const stuck = stuckInput(session, input, state.presence[binding.id] ?? null, healthOf(binding.id, binding.generation));
      if (!stuck || QUIET.has(stuck.kind)) continue;
      const key = `${input.id}:${input.state}`, id = `stuck:${session.id}:${input.id}`;
      if (closed.current.has(key)) continue;
      live.add(id);
      const open = () => { if (input.target.item_id) openItem(input.target.item_id); else openTopic(input.target.topic_id); };
      const show = (hint?: string) => {
        if (hint !== undefined) hints.current.set(input.id, hint);
        const built = build(input, stuck, agentLabel(binding.adapter_id), hints.current.get(input.id));
        const signature = JSON.stringify([built.tone, built.text, built.actions.map(action => [action.label, action.disabled])]);
        if (shown.current.get(id) === signature) return;
        shown.current.set(id, signature);
        notices.push({ id, icon: built.tone === 'problem' ? 'ph ph-warning-circle' : 'ph ph-hourglass-medium', tone: built.tone, text: built.text,
          onDismiss: () => { closed.current.add(key); shown.current.delete(id); }, actions: built.actions });
      };
      const build = (target: Immutable<Input>, why: Stuck, agent: string, hint?: string): { tone: NonNullable<Notice['tone']>; text: string; actions: NoticeAction[] } => {
        const showIt: NoticeAction = { label: 'Show it', run: open };
        if (target.state === 'needs_attention') {
          const retry = resendPlan(actions, target, why);
          return { tone: 'problem', text: `${yourSent(target)}: ${why.text}${retry ? ' Retry sends that same message once.' : ''}${hint ? ` ${hint}` : ''}`,
            actions: [...retry ? [{ label: 'Retry', disabled: retry.disabled || flights.current.has(target.id), run: () => {
              if (flights.current.has(target.id)) return;
              flights.current.add(target.id);
              void retry.run().then(sent => {
                flights.current.delete(target.id);
                if (sent) toasts.show({ text: `Sent your ${sentPhrase(target)} once, at ${clock(Date.now())}.` });
                else show('Couldn’t send it again. Your words are kept; try Retry once more.');
              }, () => { flights.current.delete(target.id); show('Couldn’t send it again. Your words are kept; try Retry once more.'); });
              show();
            } }] : [], showIt] };
        }
        if (target.state === 'in_flight') return { tone: 'warn', text: `${yourSent(target)} hasn’t been picked up after 2 minutes. It’s kept.${hint ? ` ${hint}` : ''}`, actions: [showIt] };
        const text = `${yourSent(target)} hasn’t reached ${agent} after 2 minutes. It’s kept.${hint ? ` ${hint}` : ''}`;
        if (!editable(target.kind)) return { tone: 'warn', text, actions: [showIt] };
        return { tone: 'warn', text, actions: [{ label: 'Edit', disabled: flights.current.has(target.id), run: () => {
          if (flights.current.has(target.id)) return;
          flights.current.add(target.id);
          const latest = actions.session.getSnapshot().snapshot?.session ?? session;
          show();
          void editQueued(drafts, latest, latest.inputs[target.id] ?? target, actions).then(outcome => {
            flights.current.delete(target.id);
            if (inEditor(outcome)) { hints.current.delete(target.id); notices.dismiss(id); shown.current.delete(id); open(); }
            else show(whyNot(outcome));
          }, () => { flights.current.delete(target.id); show('Couldn’t take it back. Your message is kept; try Edit again.'); });
        } }] };
      };
      show();
    }
    for (const id of [...shown.current.keys()]) if (!live.has(id)) { notices.dismiss(id); shown.current.delete(id); }
  };

  useEffect(() => { check.current(); }, [session, state.presence, state.status, operation, healthOf, openItem, openTopic]);
  useEffect(() => {
    const timer = setInterval(() => check.current(), STUCK_CHECK_MS);
    const published = shown.current;
    return () => { clearInterval(timer); for (const id of published.keys()) notices.dismiss(id); published.clear(); };
  }, []);
}
