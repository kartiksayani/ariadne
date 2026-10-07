// The agent connection as the handoff draws it (Ariadne.dc.html:928 `conn`,
// connMap 2112-2118, runOf 1605-1613): connected, reconnecting or not running.
// The binding's stored connection state is the base; a host presence
// observation for the binding's generation refines it. A fresh observation
// outranks the stored state, except a disconnected binding. One that went stale (the Claude mod heartbeats
// every 30 s; 90 s without one is stale) means Ariadne lost the host while the
// binding is still connected: the handoff's "Reconnecting" state, in which
// sending waits and the owner's choice is kept.
import type { Immutable } from '../../data/session-store';
import type { ConnectionState, PresenceObservation } from '../../generated/domain/models';

export type Connection = 'connected' | 'reconnecting' | 'not_running' | 'none';

interface BindingLike { readonly generation: string; readonly connection_state: ConnectionState; readonly presence?: Immutable<PresenceObservation> | null }

export function connectionOf(binding: BindingLike | null | undefined, presence?: Immutable<PresenceObservation> | null): Connection {
  if (!binding) return 'none';
  // A disconnected binding stays disconnected whatever its last host observation said.
  if (binding.connection_state === 'disconnected') return 'not_running';
  const observed = presence ?? binding.presence ?? null;
  const own = observed && observed.generation === binding.generation ? observed : null;
  const state = own?.freshness === 'fresh' ? own.connection_state : binding.connection_state;
  if (state === 'reconnecting') return 'reconnecting';
  if (state !== 'connected') return 'not_running';
  return own?.freshness === 'stale' ? 'reconnecting' : 'connected';
}

/** The handoff's run state: an agent being reconnected still runs (scenario "reconnecting" keeps `running`). */
export const agentRunning = (connection: Connection): boolean => connection === 'connected' || connection === 'reconnecting';

/** The answer box's note while reconnecting (Ariadne.dc.html:1405). */
export const reconnectingNote = (agent: string): string => `Reconnecting to ${agent}. Your choice is kept; sending resumes when the connection is back.`;
