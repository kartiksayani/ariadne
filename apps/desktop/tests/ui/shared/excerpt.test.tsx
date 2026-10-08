import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../src/generated/domain/models';
import { earlierAgent, excerptView } from '../../../src/ui/shared/excerpt';

const project = '00000000-0000-4000-8000-0000000000a1', other = '00000000-0000-4000-8000-0000000000a2';
const summary = (session_id: string, connected: boolean, extra: Record<string, unknown> = {}) => ({
  project_id: project, session_id, state: 'active', active_binding: { adapter_id: 'codex', connection_state: connected ? 'connected' : 'disconnected' }, ...extra,
}) as unknown as SessionSummary;
const route = { project_id: project, session_id: '00000000-0000-4000-8000-000000000001' };

describe('earlier session message numbers', () => {
  it('names the agent only while this session is idle and another of its project runs', () => {
    const live = summary('00000000-0000-4000-8000-000000000002', true, { active_binding: { adapter_id: 'claude_code_mod', connection_state: 'connected' } });
    expect(earlierAgent(route, [summary(route.session_id, false), live])).toBe('codex');
    // Its own agent running, nothing running elsewhere, or the running one in another project: plain numbers.
    expect(earlierAgent(route, [summary(route.session_id, true), live])).toBeNull();
    expect(earlierAgent(route, [summary(route.session_id, false)])).toBeNull();
    expect(earlierAgent(route, [summary(route.session_id, false), summary(live.session_id, true, { project_id: other })])).toBeNull();
    expect(earlierAgent(route, [summary(route.session_id, false, { active_binding: null }), live])).toBeNull();
    expect(earlierAgent(route, [summary(route.session_id, false), summary(live.session_id, true, { state: 'closed' })])).toBeNull();
  });
  it('prefixes the number with that agent', () => {
    const message = { number: 19, author: 'agent', body: 'Delete it?', created_at: '2026-10-06T17:18:00Z' } as Parameters<typeof excerptView>[0];
    expect(excerptView(message, Date.parse('2026-10-07T12:00:00Z')).number).toBe('#19');
    expect(excerptView(message, Date.parse('2026-10-07T12:00:00Z'), 'codex').number).toBe('codex #19');
  });
});
