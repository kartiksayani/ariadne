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
