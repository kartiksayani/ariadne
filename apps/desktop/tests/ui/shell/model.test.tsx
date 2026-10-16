import { describe, expect, it } from 'vitest';
import {
  agentName, bodyLayout, clock, DETAIL_MAX, DETAIL_MIN, dayWord, footerSummary, glow, headerText, hostApp, sessionRange, sessionWhen, tabModels, themeToggle, type SessionFacts,
} from '../../../src/ui/shell/model';

const now = new Date(2026, 9, 7, 15, 30).getTime();
const at = (daysAgo: number, hours: number, minutes: number) => new Date(2026, 9, 7 - daysAgo, hours, minutes).getTime();
const facts = (patch: Partial<SessionFacts> = {}): SessionFacts => ({
  projectName: 'search-service', createdAt: at(0, 14, 2), messageCount: 128, agent: 'claude-code', connection: 'connected',
  lastMessage: { number: 128, createdAt: at(0, 15, 4) }, ...patch,
});

describe('shell model', () => {
  it('names agents and formats times as the handoff writes them', () => {
    expect(agentName('claude_code_mod')).toBe('claude-code');
    expect(agentName('codex')).toBe('codex');
    expect(hostApp('iTerm window 1')).toBe('iTerm');
    expect(hostApp('VS Code')).toBe('VS Code');
    expect(hostApp(null)).toBeNull();
    expect(hostApp(undefined)).toBeNull();
    expect(clock(at(0, 9, 5))).toBe('09:05');
    expect(dayWord(at(0, 9, 5), now)).toBe('');
    expect(dayWord(at(1, 9, 5), now)).toBe('Yesterday');
    expect(dayWord(at(3, 9, 5), now)).toBe(new Date(at(3, 9, 5)).toLocaleDateString('en-GB', { weekday: 'short' }));
    expect(dayWord(at(9, 9, 5), now)).toBe(new Date(at(9, 9, 5)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    expect(sessionWhen(at(0, 14, 2), now)).toBe('Today 14:02');
    expect(sessionWhen(at(1, 14, 2), now)).toBe('Yesterday');
    expect(sessionWhen(at(3, 14, 2), now)).toBe('3 days ago');
    expect(sessionWhen(at(8, 14, 2), now)).toBe('Last week');
    expect(sessionWhen(at(20, 14, 2), now)).toBe(new Date(at(20, 14, 2)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
    expect(sessionRange(at(0, 14, 2), null, true, now)).toBe('Today 14:02 – now');
    expect(sessionRange(at(1, 16, 40), at(1, 17, 25), false, now)).toBe('Yesterday 16:40 – 17:25');
    expect(sessionRange(at(3, 10, 0), at(3, 11, 0), false, now)).toBe('3 days ago · 10:00 – 11:00');
  });

  it('builds the Projects and All sessions header lines', () => {
    expect(headerText({ kind: 'projects', projectCount: 3, runningAgents: 2 }, now))
      .toEqual({ sessionText: '3 projects', connText: '2 agents running', connColor: 'var(--st-done)' });
    expect(headerText({ kind: 'projects', projectCount: 1, runningAgents: 0, projectPath: '~/code/search' }, now))
      .toEqual({ sessionText: '~/code/search', connText: '0 agents running', connColor: 'var(--st-open)' });
    expect(headerText({ kind: 'all_sessions', openTabs: 1, openProjects: 2 }, now))
      .toEqual({ sessionText: '1 session open', connText: 'across 2 projects', connColor: 'var(--st-open)' });
  });

  it('builds every session connection state', () => {
    const session = (value: SessionFacts | null, fallbackAgent: string | null = null) => headerText({ kind: 'session', facts: value, fallbackAgent }, now);
    expect(session(null, 'claude-code')).toEqual({ sessionText: 'Opening session…', connText: 'Connecting to claude-code…', connColor: 'var(--st-progress)' });
    expect(session(facts({ connection: 'loading', agent: null }))).toEqual({ sessionText: 'Opening session…', connText: 'Not connected', connColor: 'var(--st-open)' });
    expect(session(facts())).toEqual({ sessionText: 'search-service · started 14:02 · 128 messages',
      connText: 'Connected · claude-code · last message #128 at 15:04', connColor: 'var(--st-done)' });
    expect(session(facts({ where: 'iTerm', lastMessage: null })).connText).toBe('Connected · claude-code in iTerm');
    expect(session(facts({ connection: 'reconnecting' }))).toMatchObject({ connText: 'Reconnecting to claude-code… · last synced 15:04', connColor: 'var(--st-progress)' });
    expect(session(facts({ connection: 'reconnecting', lastMessage: null })).connText).toBe('Reconnecting to claude-code… · last synced –');
    expect(session(facts({ connection: 'not_running', createdAt: at(1, 16, 40), messageCount: 0, lastMessage: { number: 42, createdAt: at(1, 17, 25) } })))
      .toEqual({ sessionText: 'search-service · started Yesterday', connText: 'claude-code isn’t running · last message claude-code #42, yesterday 17:25', connColor: 'var(--st-open)' });
    expect(session(facts({ connection: 'not_running', lastMessage: null })).connText).toBe('claude-code isn’t running');
    expect(session(facts({ connection: 'not_running', lastMessage: { number: 3, createdAt: at(0, 15, 0) } })).connText)
      .toBe('claude-code isn’t running · last message claude-code #3, 15:00');
    expect(session(facts({ connection: 'none' })).connText).toBe('Not connected');
    expect(session(facts({ agent: null })).connText).toBe('Not connected');
  });

  it('builds the tab strip with project prefixes only across several projects', () => {
    const sessions = [
      { id: 'a', project: 'search', agent: 'claude-code', createdAt: at(0, 14, 2), endedAt: null, running: true, on: true },
      { id: 'b', project: 'sync', agent: null, where: 'iTerm', createdAt: null, endedAt: null, running: false, on: false },
    ];
    const [projects, all, first, second] = tabModels({ selection: 'session', sessions, projectCount: 2 }, now);
    expect(projects).toMatchObject({ id: 'projects', label: 'Projects', sub: '', title: 'All projects', on: false, closable: false });
    expect(all).toMatchObject({ id: 'all_sessions', label: 'All sessions', sub: '2', icon: 'ph ph-squares-four' });
    expect(first).toMatchObject({ label: 'claude-code', sub: 'Today 14:02', project: 'search', icon: 'ph-fill ph-circle', iconColor: 'var(--st-done)',
      title: 'search · claude-code · Today 14:02 – now · agent running', on: true, closable: true });
    expect(second).toMatchObject({ label: 'No agent', sub: '', icon: 'ph ph-circle', title: 'sync · No agent · iTerm · agent not running' });
    const single = tabModels({ selection: 'all_sessions', sessions: [], projectCount: 1 }, now);
    expect(single.map(tab => [tab.id, tab.on, tab.sub])).toEqual([['projects', false, ''], ['all_sessions', true, '']]);
    expect(tabModels({ selection: 'session', sessions: sessions.slice(0, 1), projectCount: 1 }, now)[2].project).toBeNull();
  });

  it('builds the footer, body grid, theme toggle and status glow', () => {
    expect(footerSummary(null)).toBe('');
    expect(footerSummary({ items: 10, waiting: 3, inProgress: 2, open: 4, archivedTopics: 0 })).toBe('10 items · 3 waiting on you · 2 in progress · 4 open');
    expect(footerSummary({ items: 10, waiting: 3, inProgress: 2, open: 4, archivedTopics: 1 })).toContain(' · 1 archived topics');
    expect(bodyLayout({ width: null, detail: false }).columns).toBe('minmax(0px,1fr)');
    expect(bodyLayout({ width: 1600, detail: true }).columns).toBe('minmax(560px,1fr) 400px');
    expect(themeToggle('dark')).toEqual({ icon: 'ph ph-sun', title: 'Switch to light', next: 'light' });
    expect(themeToggle('light')).toEqual({ icon: 'ph ph-moon', title: 'Switch to dark', next: 'dark' });
    expect(glow('var(--st-done)')).toBe('0 0 0 3px color-mix(in srgb, var(--st-done) 22%, transparent)');
  });

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
    expect(bodyLayout({ width: 600, detail: true, detailWidth: 2000 })).toEqual({
      detailWidth: 320, detailMax: 320, columns: 'minmax(280px,1fr) 320px',
    });
    expect(bodyLayout({ width: 300, detail: true }).columns).toBe('minmax(0px,1fr) 320px');
  });
});
