import type { Binding, PresenceObservation } from '../../generated/domain/models';
import type { Immutable } from '../../data';

export function qualifiedPresence(binding: Immutable<Binding>, observation: Immutable<PresenceObservation> | undefined) {
  const qualified = observation?.generation === binding.generation && observation.freshness === 'fresh'
    && observation.last_seen_at !== null && ['host_poll', 'host_event', 'bridge_heartbeat'].includes(observation.source ?? '');
  return { qualified, idle: qualified && observation.connection_state === 'connected' && observation.execution_state === 'idle',
    busy: qualified && ['running', 'waiting_for_approval'].includes(observation.execution_state),
    label: !observation ? 'Host state unknown' : !qualified ? `Host state ${observation.freshness} · unqualified`
      : `Host ${observation.execution_state.replace(/_/g, ' ')} · fresh ${observation.source?.replace(/_/g, ' ')}` };
}
