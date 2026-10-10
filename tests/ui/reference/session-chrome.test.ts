import { describe, expect, it } from 'vitest';
import { handoffMembers } from '../design/source.mts';
import { sessionChrome } from '../design/session-chrome';

describe('alpha.13 session design frames', () => {
  const source = handoffMembers()['Ariadne.dc.html']!;

  it('shows a single-line session bar with only the topic count and more button', () => {
    expect(source).toContain('flex-wrap:nowrap; gap:6px 12px; margin:10px 16px 0;');
    expect(source).toContain('title="{{ sb.title }}"');
    expect(source).toContain('meta: `${curTopics');
    expect(source).not.toContain('meta: `${curS.range}');
    expect(source).toContain('aria-label="Session actions"');
    expect(source).toContain('ph ph-dots-three');
    expect(source).toContain('position:relative; flex:none;');
    expect(source).toContain("run: curS.running ? 'Sending' : 'Disconnected'");
    expect(source).toContain('aria-label="Pause"');
    expect(source).toContain('width:20px; height:18px; padding:0;');
  });

  it('keeps the dispatch change scoped to the session bar', () => {
    expect(source).toContain("run: run ? 'Agent running' : 'Agent not running'");
    expect(source).toContain('sb.canPause');
    expect(source).not.toContain('onClick="{{ closeThisSession }}"');
  });

  it('replaces the chips and topic dropdown with the active-aware filter icon', () => {
    expect(source).not.toContain('<sc-for list="{{ statusChips }}"');
    expect(source).not.toContain('All topics');
    expect(source).toContain('aria-label="Filter"');
    expect(source).toContain('color:{{ filterColor }}');
    expect(source).toContain('display:{{ filterDot }}');
    expect(source).toContain("filterDot: s.fStatus === 'all' ? 'none' : 'block'");
  });

  it('leaves unrelated design sources untouched', () => {
    const other = '<div>Other page</div>';
    expect(sessionChrome(other)).toBe(other);
  });
});
