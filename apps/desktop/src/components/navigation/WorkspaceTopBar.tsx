// The top bar with its session: the connection dot and card (SPEC §5.12), where Close, Reopen and Copy ID now live,
// and the line above the Map for a state that changes what I can do.
// The session's lifecycle (C3) is the workspace's one instance (SessionLifecycleOwner), so its confirmation outlives
// the card that opened it and is the same review the Map shows.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { SessionState, SessionStore } from '../../data/session-store';
import type { SessionActionControllers } from '../bindings/actions';
import { TopBar } from '../../ui/topbar/TopBar';
import { ConnectionCard, ConnectionLine } from '../../ui/topbar/ConnectionCard';
import { copyText } from '../../ui/shared/clipboard';
import type { ConnectionCardActions, ConnectionView, TopBarProps } from '../../ui/topbar/model';
import { DispatchDialog, reconnectCommand } from '../../ui/pages/SessionDialogs';
import { useSessionLifecycleFor } from '../../ui/shared/SessionLifecycleOwner';
import { connectionKind, readAt } from '../../ui/shared/connection';
import { agentName, clock } from '../../ui/shell/model';
import { agentProduct } from '../../state/navigation/switcher';

/**
 * Where the session's agent stands, in the words the top bar, card and line share. `unsaved` is set while Ariadne isn't
 * sure the owner's last change was saved (SPEC 12.9): over a live session it is the state itself, over any other it adds
 * its own line under that state's line.
 */
export function connectionView(state: SessionState, unsaved?: { readonly at?: number } | null): ConnectionView {
  const session = state.snapshot?.session;
  const kind = connectionKind(state);
  // Every read is stamped when first seen (even while all is well), so a later failed read can name the last good one.
  const readTime = state.snapshot ? readAt(state.snapshot) : null;
  if (!session) return kind === 'loading' ? { kind } : { kind, ...unsaved ? { unsavedToo: true, ...unsaved.at ? { unsavedAt: clock(unsaved.at) } : {} } : {} };
  const binding = session.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  const agent = binding ? agentProduct(binding.adapter_id) : undefined;
  const where = agent && binding?.host_location ? `${agent} in ${binding.host_location}` : agent;
  const last = session.messages.at(-1);
  const seen = binding ? state.presence[binding.id]?.last_seen_at : null;
  const seenAt = seen ? Date.parse(String(seen)) : NaN;
  const waiting = binding ? Object.values(session.inputs).filter(input => input?.binding_id === binding.id) : [];
  const onItsWay = waiting.filter(input => input?.state === 'in_flight').length, queued = waiting.filter(input => input?.state === 'queued').length;
  const base: ConnectionView = { kind, agent, where, lastMessageAt: last ? clock(Date.parse(last.created_at)) : undefined,
    ...Number.isFinite(seenAt) ? { lastSeenAt: clock(seenAt) } : {},
    ...kind === 'stale' && readTime !== null ? { lastGoodAt: clock(readTime) } : {},
    ...kind === 'live' ? { sending: { onItsWay, queued } } : {} };
  const closed = kind === 'closed' ? { closedAt: session.closed_at ? clock(Date.parse(session.closed_at)) : undefined, ...session.archived_at != null ? { archived: true } : {} } : {};
  const view = { ...base, ...closed };
  if (!unsaved) return view;
  const at = unsaved.at ? { unsavedAt: clock(unsaved.at) } : {};
  return kind === 'live' ? { ...view, kind: 'unsaved', ...at } : { ...view, unsavedToo: true, ...at };
}

type BarProps = Omit<TopBarProps, 'connection' | 'connectionOpen' | 'onConnectionToggle' | 'connectionCard'>;

interface SessionBarProps {
  readonly bar: BarProps; readonly controllers: SessionActionControllers;
  /** Where the line above the Map goes (the session view's slot); absent on a page. */
  readonly line?: HTMLElement | null;
  /** The setup instruction of the last connect receipt and the session it was made for. Without one for the session shown, the line has no Copy instruction. */
  readonly setup?: { readonly sessionId: string; readonly instruction: string } | null;
  /** The workspace's own saved write whose outcome is unknown (the navigation store's pending operation), and the way to check it again. */
  readonly unsaved?: { readonly retry: () => void } | null;
}

const idleSubscribe = () => () => {};
const idleSnapshot = () => null;
/** Copies text; resolves to whether the write landed, so a button says "Copied" only after one did. */
const copied = async (text: string) => { try { await copyText(text); return true; } catch { return false; } };

/**
 * The top bar; with a session (the one shown, or the one a page returns to) it carries that session's connection.
 * One bar stays mounted across session changes, so a control that has focus (the switcher button, the theme button)
 * keeps it; only the per-session state (the card open, the Sending dialog) starts again.
 */
export function WorkspaceTopBar({ bar, store: given, controllers, line, setup, unsaved }: SessionBarProps & { readonly store: SessionStore | null }) {
  const store = bar.variant === 'first-run' ? null : given;
  const actions = useMemo(() => store ? controllers.forSession(store) : null, [controllers, store]);
  const lifecycle = useSessionLifecycleFor(actions);
  const state = useSyncExternalStore(store?.subscribe ?? idleSubscribe, store?.getSnapshot ?? idleSnapshot, store?.getSnapshot ?? idleSnapshot);
  const [open, setOpen] = useState(false), [sending, setSending] = useState(false);
  const [shownFor, setShownFor] = useState(store);
  if (shownFor !== store) { setShownFor(store); setOpen(false); setSending(false); }
  // "Ariadne isn't sure your last change was saved": a lifecycle save or a workspace save whose outcome is unknown. The time
  // is when the bar first sees the report.
  const flagged = !!lifecycle.pending || !!unsaved;
  const [unsavedSince, setUnsavedSince] = useState<number | null>(null);
  useEffect(() => { setUnsavedSince(since => flagged ? since ?? Date.now() : null); }, [flagged]);
  // The same children in the same places either way, so the bar itself is never remounted.
  if (!store || !state || !actions) return <><TopBar {...bar} />{null}{null}{null}</>;
  const session = state.snapshot?.session, view = connectionView(state, flagged ? { at: unsavedSince ?? undefined } : null);
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] ?? null : null;
  // Try again for an unsaved change calls whichever save is pending, each its own way (SPEC 12.9).
  const checkSaved = () => { if (lifecycle.pending) lifecycle.reconcile(); unsaved?.retry(); };
  // Try now = Reconnect of the Sending dialog: the same agent session again. It waits while a save is in flight.
  const tryNow = binding && session ? () => {
    const operation = actions.getSnapshot();
    if (operation.writing || operation.pending) return;
    void actions.execute(reconnectCommand(session, binding), session.revision);
  } : undefined;
  const cardActions: ConnectionCardActions = {
    onCopyId: lifecycle.copySessionId,
    onClose: lifecycle.state === 'active' && !lifecycle.busy ? lifecycle.close : undefined,
    onReopen: lifecycle.state === 'closed' && !lifecycle.busy ? lifecycle.reopen : lifecycle.state === 'archived' && !lifecycle.busy ? lifecycle.restoreSession : undefined,
    onSending: binding && lifecycle.state === 'active' ? () => setSending(true) : undefined,
    onTryAgain: view.kind === 'stale' || view.kind === 'unreadable' ? () => { void store.refresh(); }
      : view.kind === 'reconnect' ? tryNow : view.kind === 'unsaved' ? checkSaved : undefined,
    onTryAgainUnsaved: checkSaved,
    onCopyCommand: () => copied('/ariadne-connect'),
    onCopyInstruction: setup && session && setup.sessionId === session.id ? () => copied(setup.instruction) : undefined,
  };
  return <>
    <TopBar {...bar} connection={view} connectionOpen={open} onConnectionToggle={() => setOpen(value => !value)}
      connectionCard={<ConnectionCard view={view} actions={cardActions} onDismiss={() => setOpen(false)} />} />
    {line && createPortal(<ConnectionLine view={view} actions={cardActions} />, line)}
    {lifecycle.dialog}
    {sending && <DispatchDialog store={store} actions={actions} agent={binding ? agentName(binding.adapter_id) : 'the agent'} onClose={() => setSending(false)} />}
  </>;
}
