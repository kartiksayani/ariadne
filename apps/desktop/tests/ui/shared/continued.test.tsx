import { describe, expect, it } from 'vitest';
import type { SessionSummary, TopicOrigin } from '../../../src/generated/domain/models';
import { continuedLabel } from '../../../src/ui/shared/continued';

const now = new Date(2026, 9, 7, 15, 30).getTime();
const origin: TopicOrigin = { project_id: 'p', session_id: 'old', topic_id: 't', source_revision: 3, continued_at: new Date(now).toISOString() };
const summary = (patch: Partial<SessionSummary>) => ({
  project_id: 'p', session_id: 'old', created_at: new Date(2026, 9, 6, 16, 40).toISOString(), active_binding: { adapter_id: 'codex' }, ...patch,
}) as unknown as SessionSummary;

describe('continuedLabel', () => {
  it('names the origin session by agent and day', () => {
    expect(continuedLabel(origin, [summary({})], now)).toBe('Continued from codex · yesterday');
  });
  it('drops the day for a session from today and the agent when none is bound', () => {
    expect(continuedLabel(origin, [summary({ created_at: new Date(2026, 9, 7, 9, 0).toISOString() })], now)).toBe('Continued from codex');
    expect(continuedLabel(origin, [summary({ active_binding: null })], now)).toBe('Continued from an earlier session · yesterday');
  });
  it('falls back when the catalogue does not know the session', () => {
    expect(continuedLabel(origin, [summary({ session_id: 'other' })], now)).toBe('Continued from an earlier session');
  });
});
