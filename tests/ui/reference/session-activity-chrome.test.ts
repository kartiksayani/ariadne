import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { inItemConversation } from '../../../apps/desktop/src/ui/detail/SessionActivity';
import { designFixture, prototypeData } from '../design/fixtures';
import { frameIds, frameSpec, type FrameSpec } from '../design/frames';
import { handoffMembers } from '../design/source.mts';
import { sessionActivityChrome } from '../design/session-activity-chrome';

interface Values {
  showTreeActivity: boolean;
  showArchiveActivity: boolean;
  sessionActivityCount: number;
  sessionActivity: { excerpt: string }[];
}
function referenceValues(source: string, spec: FrameSpec): Values {
  const script = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .find(value => value[1]!.includes('class Component extends DCLogic'))![1]!;
  class DCLogic {
    state: Record<string, unknown> = {};
    constructor(readonly props: unknown) {}
    setState(next: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>)) {
      Object.assign(this.state, typeof next === 'function' ? next(this.state) : next);
    }
  }
  const Component = runInNewContext(`${script}\nComponent`, {
    DCLogic, React: { createRef: () => ({ current: null }), createElement: () => null },
    setTimeout: () => 0, clearTimeout: () => {}, document, structuredClone,
  }) as new (props: unknown) => { renderVals(): Values };
  return new Component(spec).renderVals();
}

describe('Session activity reference parity', () => {
  const source = handoffMembers()['Ariadne.dc.html']!, data = prototypeData(source);

  it('matches the app association rules and visibility in every comparable session frame', () => {
    for (const frame of frameIds) {
      const fixture = designFixture(frame, data);
      // App-only M2 frames replace the session data and have no immutable reference card.
      if (fixture.spec.changes) continue;
      const values = referenceValues(source, fixture.spec);
      const session = fixture.route ? fixture.transport.sessions.get(fixture.route.session_id)! : null;
      const messages = session?.messages.filter(message => !inItemConversation(session, message)) ?? [];
      const visible = fixture.route !== null && fixture.spec.state !== 'loading' && messages.length > 0;
      expect(values.showTreeActivity, frame).toBe(visible && fixture.spec.scenario !== 'archive');
      expect(values.showArchiveActivity, frame).toBe(visible && fixture.spec.scenario === 'archive');
      if (!visible) continue;
      expect(values.sessionActivityCount, frame).toBe(messages.length);
      expect(values.sessionActivity.map(message => message.excerpt), frame).toEqual(messages.map(message => message.body));
    }
  });

  it('shows the one default and two review/thread messages above the ancestor region', () => {
    expect(referenceValues(source, frameSpec('1a')).sessionActivityCount).toBe(1);
    expect(referenceValues(source, frameSpec('1t')).sessionActivityCount).toBe(2);
    expect(referenceValues(source, frameSpec('1u')).sessionActivityCount).toBe(2);
    expect(source.indexOf('value="{{ showTreeActivity }}"')).toBeLessThan(source.indexOf('aria-label="Map ancestors"'));
    expect(source).toContain('max-height:30%; margin:0 16px 8px; overflow:auto;');
    expect(source).toContain('padding:8px 12px; font-size:13px;');
    expect(source).toContain('<summary style="cursor:pointer;">Session activity · {{ sessionActivityCount }}</summary>');
    expect(source).not.toMatch(/<details class="session-activity"[^>]*\bopen/);
  });

  it('leaves unrelated source members unchanged', () => {
    const other = '<div>Other page</div>';
    expect(sessionActivityChrome(other)).toBe(other);
  });
});
