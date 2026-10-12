import { describe, expect, it } from 'vitest';
import { footerKeys } from '../../../apps/desktop/src/ui/shell/model';
import { handoffMembers } from '../design/source.mts';
import { footerChrome } from '../design/footer-chrome';

describe('shortcut footer design frames', () => {
  const source = handoffMembers()['Ariadne.dc.html']!;

  it('shows every current shortcut hint in the same order as the app', () => {
    const keys = /keys:\s*\[([^\]]+)\],\s*summary:/.exec(source)?.[1] ?? '';
    const hints = [...keys.matchAll(/\{ k: '([^']+)', t: '([^']+)' \}/g)]
      .map(([, k, t]) => ({ k, t }));
    expect(hints).toEqual(footerKeys);
  });

  it('keeps the same clipping and spacing with a summary after the hints', () => {
    const footer = /<footer[^>]+>[\s\S]+?<\/footer>/.exec(source)?.[0] ?? '';
    expect(footer).toContain('gap:14px; min-width:0; padding:0 14px; overflow:hidden; white-space:nowrap; font-size:11.5px;');
    expect(footer).toContain('gap:5px;');
    expect(footer).toContain('min-width:18px; height:18px; padding:0 4px;');
    expect(footer).toContain('<span style="margin-left:auto;">{{ summary }}</span>');
  });

  it('leaves unrelated design sources untouched', () => {
    const other = '<div>Other page</div>';
    expect(footerChrome(other)).toBe(other);
  });
});
