import { describe, expect, it } from 'vitest';
import {
  agentName, bodyLayout, clock, DETAIL_MAX, DETAIL_MIN, dayWord, hostApp, sessionWhen, sessionLabel, sessionPhrase, ownerName, ownerDescription, themeToggle,
} from '../../../src/ui/shell/model';

const now = new Date(2026, 9, 7, 15, 30).getTime();
const at = (daysAgo: number, hours: number, minutes: number) => new Date(2026, 9, 7 - daysAgo, hours, minutes).getTime();
describe('shell model', () => {
  it('names agents and formats times as the handoff writes them', () => {
    expect(agentName('claude_code_mod')).toBe('Claude Code');
    expect(agentName('codex')).toBe('Codex');
    expect(agentName('some-other-adapter')).toBe('some-other-adapter');
    expect(hostApp('iTerm window 1')).toBe('iTerm');
    expect(hostApp('VS Code')).toBe('VS Code');
    expect(hostApp(null)).toBeNull();
    expect(hostApp(undefined)).toBeNull();
    expect(clock(at(0, 9, 5))).toBe('09:05');
    expect(dayWord(at(0, 9, 5), now)).toBe('');
    expect(dayWord(at(1, 9, 5), now)).toBe('Yesterday');
    expect(dayWord(at(3, 9, 5), now)).toBe(new Date(at(3, 9, 5)).toLocaleDateString('en-GB', { weekday: 'short' }));
    // The board writes "28 Sep"; newer ICU writes "28 Sept" for en-GB, so the expected words use the board's three letters.
    expect(dayWord(at(9, 9, 5), now)).toBe(new Date(at(9, 9, 5)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep'));
    expect(sessionWhen(at(0, 14, 2), now)).toBe('Today 14:02');
    expect(sessionWhen(at(1, 14, 2), now)).toBe('Yesterday');
    expect(sessionWhen(at(3, 14, 2), now)).toBe('3 days ago');
    expect(sessionWhen(at(8, 14, 2), now)).toBe('Last week');
    expect(sessionWhen(at(20, 14, 2), now)).toBe(new Date(at(20, 14, 2)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep'));
  });

  it('uses the owner name and description when set, with agent fallbacks for unnamed sessions', () => {
    expect(ownerName({ name: '  Cache review  ' })).toBe('Cache review');
    expect(ownerName({ name: '  ' })).toBeNull();
    expect(ownerDescription({ description: '  Review cache lifetime. ' })).toBe('Review cache lifetime.');
    expect(ownerDescription(undefined)).toBeNull();
    expect(sessionLabel({ name: 'Cache review', description: 'Review TTL' }, 'claude-code · iTerm')).toEqual({
      named: true, title: 'Cache review', secondary: 'claude-code · iTerm', description: 'Review TTL',
    });
    expect(sessionLabel(null, 'codex')).toEqual({ named: false, title: 'codex', secondary: null, description: null });
    expect(sessionPhrase({ name: 'Cache review' }, 'codex', 'Today')).toBe('the “Cache review” session');
    expect(sessionPhrase(null, 'codex', 'Yesterday')).toBe('the codex session from yesterday');
  });

  it('builds the body grid and theme toggle', () => {
    expect(bodyLayout({ width: null, detail: false }).columns).toBe('minmax(0px,1fr)');
    expect(bodyLayout({ width: 1600, detail: true }).columns).toBe('minmax(560px,1fr) 400px');
    expect(themeToggle('dark')).toEqual({ icon: 'ph ph-sun', title: 'Switch to light', next: 'light' });
    expect(themeToggle('light')).toEqual({ icon: 'ph ph-moon', title: 'Switch to dark', next: 'dark' });  });

  it('sizes the detail panel to the owner width inside its bounds', () => {
    expect(bodyLayout({ width: 1600, detail: true, detailWidth: 520 }).columns).toBe('minmax(560px,1fr) 520px');
    expect(bodyLayout({ width: 4000, detail: true, detailWidth: 5000 }).detailWidth).toBe(DETAIL_MAX);
    expect(bodyLayout({ width: 2400, detail: true, detailWidth: 10 }).detailWidth).toBe(DETAIL_MIN);
    // The resize limit leaves a usable tree even when the owner widens the panel.
    expect(bodyLayout({ width: 1500, detail: true }).detailMax).toBe(1500 - 380);
  });

  it.each([
    { width: 3000, detailWidth: 2000, detailMax: 2400, minimum: 560 },
    { width: 2000, detailWidth: 1620, detailMax: 1620, minimum: 380 },
    { width: 1200, detailWidth: 820, detailMax: 820, minimum: 380 },
    { width: 900, detailWidth: 520, detailMax: 520, minimum: 380 },
  ])('fits the saved pane to $width pixels while keeping room for the Map', ({ width, detailWidth, detailMax, minimum }) => {
    expect(bodyLayout({ width, detail: true, detailWidth: 2000 })).toEqual({
      detailWidth, detailMax, columns: `minmax(${minimum}px,1fr) ${detailWidth}px`,
    });
    expect(minimum + detailWidth).toBeLessThanOrEqual(width);
  });

  it('retains the same two columns as Details widens, with no Waiting width or fold transition', () => {
    for (const detailWidth of [320, 400, 540, 541, 720, 900, 1020]) {
      const minimum = Math.min(560, 1400 - detailWidth);
      expect(bodyLayout({ width: 1400, detail: true, detailWidth })).toEqual({
        detailWidth, detailMax: 1020, columns: `minmax(${minimum}px,1fr) ${detailWidth}px`,
      });
    }
    expect(bodyLayout({ width: 1400, detail: true, detailWidth: 2400 })).toEqual({
      detailWidth: 1020, detailMax: 1020, columns: 'minmax(380px,1fr) 1020px',
    });
  });

  it.each([null, 200, 700, 1200, 3000])('gives the Map the full body with no Details at width %s', width => {
    expect(bodyLayout({ width, detail: false }).columns).toBe('minmax(0px,1fr)');
  });

  it('uses the pane minimum in a very narrow window without inventing a third column', () => {
    // The pane minimum is the narrow Details minimum, 280 (C9, state/details/column.ts); 320 is only the least saved width.
    expect(bodyLayout({ width: 600, detail: true, detailWidth: 2000 })).toEqual({
      detailWidth: 280, detailMax: 280, columns: 'minmax(320px,1fr) 280px',
    });
    expect(bodyLayout({ width: 300, detail: true }).columns).toBe('minmax(20px,1fr) 280px');
  });
});
