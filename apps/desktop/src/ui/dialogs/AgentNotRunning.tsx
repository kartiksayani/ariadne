// "Agent isn't running" (frame 1ad), ported from Ariadne.dc.html:485-496 and
// the askRun copy at 1691-1705. Whoever sends an answer to a session whose agent
// is not running calls openAgentNotRunning() and acts on the owner's choice.
import { useSyncExternalStore } from 'react';
import { useSession, type Immutable } from '../../data/session-store';
import type { ItemRoute, SessionRef } from '../../generated/core';
import type { SessionSummary } from '../../generated/domain/models';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
import { agentName, sessionWhen } from '../shell/model';
import { Dialog } from './Dialog';

export interface NotRunningSubmission {
  /** The item the answer is for. */
  readonly item: ItemRoute;
  /** The item's question, quoted in the dialog. */
  readonly question: string;
}
export type NotRunningChoice =
  | { readonly kind: 'send_live'; readonly session: SessionRef }
  | { readonly kind: 'queue' }
  | { readonly kind: 'cancel' };

interface Request { readonly submission: NotRunningSubmission; readonly resolve: (choice: NotRunningChoice) => void }
let current: Request | null = null;
const listeners = new Set<() => void>();
const publish = (next: Request | null) => { current = next; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;

/** Asks the owner what to do with a submission for a session whose agent isn't running. A newer request cancels an open one. */
export function openAgentNotRunning(submission: NotRunningSubmission): Promise<NotRunningChoice> {
  current?.resolve({ kind: 'cancel' });
  return new Promise(resolve => publish({ submission, resolve }));
}

function settle(request: Request, choice: NotRunningChoice) {
  if (current === request) publish(null);
  request.resolve(choice);
}

const running = (session: Immutable<SessionSummary>) => session.state === 'active' && session.active_binding?.connection_state === 'connected';

function NotRunningDialog({ request, navigation, now }: { readonly request: Request; readonly navigation: NavigationStore; readonly now: () => number }) {
  const state = useNavigation(navigation);
  const route = request.submission.item;
  const store = navigation.opened.open({ project_id: route.project_id, session_id: route.session_id });
  const session = useSession(store).snapshot?.session;
  const sessions = state.sessions?.sessions.items ?? [];
  const summary = sessions.find(value => value.project_id === route.project_id && value.session_id === route.session_id);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  const agent = summary?.active_binding ? agentName(summary.active_binding.adapter_id) : binding ? agentName(binding.adapter_id) : 'The agent';
  const created = summary?.created_at ?? session?.created_at;
  const when = created ? sessionWhen(Date.parse(created), now()).toLowerCase() : 'earlier';
  const project = state.projects?.projects.items.find(value => value.project_id === route.project_id)?.project?.display_name ?? 'this project';
  const live = sessions.find(value => value.project_id === route.project_id && value.session_id !== route.session_id && running(value));
  const liveAgent = live?.active_binding ? agentName(live.active_binding.adapter_id) : null;
  const cancel = () => settle(request, { kind: 'cancel' });
  const options = [
    live && liveAgent ? { key: 'live', label: `Send it to ${liveAgent} now`, icon: 'ph ph-paper-plane-right', className: 'btn btn-primary', color: 'var(--a-acc-text)',
      desc: `The running ${liveAgent} session in ${project} picks up this topic with its context, then gets your answer.`,
      choose: () => settle(request, { kind: 'send_live', session: { project_id: live.project_id, session_id: live.session_id } }) } : null,
    { key: 'queue', label: `Queue it for ${agent}`, icon: 'ph ph-hourglass-medium', className: 'btn btn-secondary', color: 'var(--color-text)',
      desc: 'Delivered when that session’s agent is running again. It shows as Queued until then.', choose: () => settle(request, { kind: 'queue' }) },
  ].filter((option): option is NonNullable<typeof option> => !!option);
  const title = `${agent} isn’t running for this session`;
  return <Dialog label={title} width={520} onCancel={cancel}>
    <div className="dialog-title">{title}</div>
    <div className="pw-dialog-body">{`Your answer to “${request.submission.question}” belongs to the ${agent} session from ${when}. Choose what happens to it this time.`}</div>
    <div className="pw-dialog-options">
      {options.map(option => <button key={option.key} type="button" className={`${option.className} pw-dialog-option`} onClick={option.choose}>
        <span className="pw-dialog-option-label" style={{ color: option.color }}><i className={option.icon} aria-hidden="true" />{option.label}</span>
        <span className="pw-dialog-option-desc">{option.desc}</span></button>)}
    </div>
    <div className="dialog-actions"><button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button></div>
  </Dialog>;
}

/** Mount once in the app; shows the dialog while a request is open. */
export function AgentNotRunningHost({ navigation, now = Date.now }: { readonly navigation: NavigationStore; readonly now?: () => number }) {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot);
  return request ? <NotRunningDialog key={JSON.stringify(request.submission.item)} request={request} navigation={navigation} now={now} /> : null;
}
