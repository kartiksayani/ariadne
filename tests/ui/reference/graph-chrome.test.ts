import { describe, expect, it } from 'vitest';
import { handoffMembers } from '../design/source.mts';
import { graphChrome } from '../design/graph-chrome';

describe('graph design frames', () => {
  const source = handoffMembers()['Ariadne.dc.html']!;

  it('shows the compact thread and related keys with their full descriptions', () => {
    expect(source).toContain('aria-label="Thread to the selected item"');
    expect(source).toContain('white-space:nowrap;">Thread</span>');
    expect(source).toContain('aria-label="Related to the selected item"');
    expect(source).toContain('white-space:nowrap;">Related</span>');
    expect(source).toContain('d="M0 3 H22"');
    expect(source).toContain('stroke-dasharray:6 5;');
  });

  it('keeps the legend on one line and lets its note shrink', () => {
    expect(source).toContain('flex-wrap:nowrap; gap:6px 18px; padding:6px 16px 8px 20px;');
    expect(source).toContain('flex-shrink:3; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">One graph per topic');
    for (const label of ['Replaced by', 'Waiting on me', 'Closed']) {
      expect(source).toContain(`white-space:nowrap;">${label}</span></span>`);
    }
    expect(source).toContain('<span style="flex:none; width:18px; height:2px;');
    expect(source).toContain('<span style="flex:none; width:12px; height:12px;');
    expect(source).toContain('onClick="{{ revealSelected }}" disabled="{{ noSel }}" style="flex-shrink:0; white-space:nowrap;');
  });

  it('gives the wrapped card name the same line box and typography as the app', () => {
    expect(source).toContain('<span style="display:flex; font-size:14.5px; font-weight:500; letter-spacing:-0.01em;">{{ gg.name }}</span>');
    expect(source).toContain("fontSize: '14px', lineHeight: 1.5");
    expect(source).toContain('gap:6px 10px; max-width:820px; padding:12px 14px 0;');
  });

  it('leaves unrelated design sources untouched', () => {
    const other = '<div>Other page</div>';
    expect(graphChrome(other)).toBe(other);
  });
});
