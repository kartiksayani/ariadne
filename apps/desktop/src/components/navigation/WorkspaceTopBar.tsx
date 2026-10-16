// The top bar with its session: the connection dot and card (SPEC §5.12), where Close, Reopen and Copy ID now live,
// and the line above the Map for a state that changes what I can do.
// The session's lifecycle (C3) is the workspace's one instance (SessionLifecycleOwner), so its confirmation outlives
// the card that opened it and is the same review the Map shows.
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession, type SessionState, type SessionStore } from '../../data/session-store';
import type { SessionActionControllers } from '../bindings/actions';
import { TopBar } from '../../ui/topbar/TopBar';
import { ConnectionCard, ConnectionLine } from '../../ui/topbar/ConnectionCard';
import { copyText } from '../../ui/shared/clipboard';
import type { ConnectionCardActions, ConnectionView, TopBarProps } from '../../ui/topbar/model';
import { DispatchDialog } from '../../ui/pages/SessionDialogs';
import { useSessionLifecycleFor } from '../../ui/shared/SessionLifecycleOwner';
import { connectionOf } from '../../ui/shared/connection';
import { agentName, clock } from '../../ui/shell/model';
import { agentProduct } from '../../state/navigation/switcher';

/** Where the session's agent stands, in the words the top bar, card and line share. */
export function connectionView(state: SessionState): ConnectionView {
  const session = state.snapshot?.session;
  if (!session) return { kind: state.status === 'loading' ? 'loading' : 'unreadable' };
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const agent = binding ? agentProduct(binding.adapter_id) : undefined;
  const where = agent && binding?.host_location ? `${agent} in ${binding.host_location}` : agent;
  const last = session.messages.at(-1);
  const base = { agent, where, lastMessageAt: last ? clock(Date.parse(last.created_at)) : undefined };
  if (session.archived_at != null || session.state === 'closed') return { ...base, kind: 'closed', closedAt: session.closed_at ? clock(Date.parse(session.closed_at)) : undefined };
  if (state.status === 'stale' || state.snapshot?.freshness === 'stale') return { ...base, kind: 'stale' };
  if (state.status === 'inaccessible') return { ...base, kind: 'unreadable' };
  const connection = connectionOf(binding, binding ? state.presence[binding.id] : null);
  return { ...base, kind: connection === 'connected' ? 'live' : connection === 'reconnecting' ? 'reconnect' : connection === 'not_running' ? 'off' : 'none' };
}

type BarProps = Omit<TopBarProps, 'connection' | 'connectionOpen' | 'onConnectionToggle' | 'connectionCard'>;

interface SessionBarProps {
  readonly bar: BarProps; readonly controllers: SessionActionControllers;
  /** Where the line above the Map goes (the session view's slot); absent on a page. */
  readonly line?: HTMLElement | null;
}

function SessionTopBar({ bar, store, controllers, line }: SessionBarProps & { readonly store: SessionStore }) {
  const actions = useMemo(() => controllers.forSession(store), [controllers, store]);
  const lifecycle = useSessionLifecycleFor(actions);
  const state = useSession(store), session = state.snapshot?.session;
  const [open, setOpen] = useState(false), [sending, setSending] = useState(false);
  const view = connectionView(state);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const cardActions: ConnectionCardActions = {
    onCopyId: lifecycle.copySessionId,
    onClose: lifecycle.state === 'active' && !lifecycle.busy ? lifecycle.close : undefined,
    onReopen: lifecycle.state === 'closed' && !lifecycle.busy ? lifecycle.reopen : lifecycle.state === 'archived' && !lifecycle.busy ? lifecycle.restoreSession : undefined,
    onSending: binding && lifecycle.state === 'active' ? () => setSending(true) : undefined,
    onTryAgain: view.kind === 'stale' || view.kind === 'unreadable' ? () => { void store.refresh(); } : undefined,
    onCopyCommand: () => { void copyText('/ariadne-connect').catch(() => {}); },
  };
  return <>
    <TopBar {...bar} connection={view} connectionOpen={open} onConnectionToggle={() => setOpen(value => !value)}
      connectionCard={<ConnectionCard view={view} actions={cardActions} onDismiss={() => setOpen(false)} />} />
    {line && createPortal(<ConnectionLine view={view} actions={cardActions} />, line)}
    {lifecycle.dialog}
    {sending && <DispatchDialog store={store} actions={actions} agent={binding ? agentName(binding.adapter_id) : 'the agent'} onClose={() => setSending(false)} />}
  </>;
}

/** The top bar; with a session (the one shown, or the one a page returns to) it carries that session's connection. */
export function WorkspaceTopBar({ bar, store, controllers, line }: SessionBarProps & { readonly store: SessionStore | null }) {
  if (!store || bar.variant === 'first-run') return <TopBar {...bar} />;
  const route = store.getSnapshot().route;
  return <SessionTopBar key={`${route.project_id}/${route.session_id}`} bar={bar} store={store} controllers={controllers} line={line} />;
}
