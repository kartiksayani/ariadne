import { describe, expect, it } from 'vitest';
import type { PresenceObservation } from '../../../src/generated/domain/models';
import { agentRunning, connectionOf, reconnectingNote } from '../../../src/ui/shared/connection';

const binding = (connection_state: 'connected' | 'disconnected' | 'reconnecting' | 'unknown', presence: PresenceObservation | null = null) =>
  ({ generation: 'g1', connection_state, presence });
const observation = (update: Partial<PresenceObservation>): PresenceObservation => ({ instance_id: 'i', generation: 'g1', connection_state: 'connected',
  execution_state: 'idle', last_seen_at: '2026-10-07T15:00:00Z', source: 'bridge_heartbeat', process_identity: null, freshness: 'fresh', ...update } as PresenceObservation);

describe('connectionOf', () => {
  it('reads the stored binding state without an observation', () => {
    expect(connectionOf(null)).toBe('none');
    expect(connectionOf(binding('connected'))).toBe('connected');
    expect(connectionOf(binding('reconnecting'))).toBe('reconnecting');
    expect(connectionOf(binding('unknown'))).toBe('not_running');
    expect(connectionOf(binding('disconnected'), observation({}))).toBe('not_running');
  });
  it('lets a fresh observation of the same generation outrank the stored state', () => {
    expect(connectionOf(binding('unknown'), observation({}))).toBe('connected');
    expect(connectionOf(binding('connected'), observation({ connection_state: 'disconnected' }))).toBe('not_running');
    expect(connectionOf(binding('connected', observation({ connection_state: 'reconnecting' })))).toBe('reconnecting');
    expect(connectionOf(binding('unknown'), observation({ generation: 'g0' }))).toBe('not_running');
  });
  it('reads a stale host of a connected binding as reconnecting, still running', () => {
    const stale = connectionOf(binding('connected'), observation({ freshness: 'stale', connection_state: 'unknown' }));
    expect(stale).toBe('reconnecting');
    expect(agentRunning(stale)).toBe(true);
    expect(agentRunning('not_running')).toBe(false);
    expect(connectionOf(binding('connected'), observation({ freshness: 'unknown' }))).toBe('connected');
    expect(reconnectingNote('codex')).toBe('Reconnecting to codex. Your choice is kept; sending resumes when the connection is back.');
  });
});
