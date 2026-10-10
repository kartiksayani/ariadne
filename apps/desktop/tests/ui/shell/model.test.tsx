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
    expect(bodyLayout({ width: null, detail: false, rail: false }).columns).toBe('300px minmax(560px,1fr)');
    expect(bodyLayout({ width: 1600, detail: true, rail: true }).columns).toBe('300px minmax(560px,1fr) 400px 240px');
    expect(themeToggle('dark')).toEqual({ icon: 'ph ph-sun', title: 'Switch to light', next: 'light' });
    expect(themeToggle('light')).toEqual({ icon: 'ph ph-moon', title: 'Switch to dark', next: 'dark' });
    expect(glow('var(--st-done)')).toBe('0 0 0 3px color-mix(in srgb, var(--st-done) 22%, transparent)');
  });

  it('sizes the detail panel to the owner width inside its bounds', () => {
    expect(bodyLayout({ width: 1600, detail: true, rail: false, detailWidth: 520 }).columns).toBe('300px minmax(560px,1fr) 520px');
    expect(bodyLayout({ width: 4000, detail: true, rail: false, detailWidth: 5000 }).detailWidth).toBe(DETAIL_MAX);
    expect(bodyLayout({ width: 2400, detail: true, rail: false, detailWidth: 10 }).detailWidth).toBe(DETAIL_MIN);
    // The resize limit leaves a usable tree even when the owner widens the panel.
    expect(bodyLayout({ width: 1500, detail: true, rail: false }).detailMax).toBe(1500 - 300 - 380);
  });

  it('fits wide saved detail widths to the window while preserving the Waiting and rail rules', () => {
    const saved = { detail: true, rail: false, detailWidth: 2000 };
    expect(bodyLayout({ ...saved, width: 3000 })).toMatchObject({ detailWidth: 2000, folded: false, narrow: false,
      columns: '300px minmax(560px,1fr) 2000px' });
    expect(bodyLayout({ ...saved, width: 2000 })).toMatchObject({ detailWidth: 1576, detailMax: 1576, folded: true, auto: true,
      columns: '44px minmax(380px,1fr) 1576px' });
    expect(bodyLayout({ ...saved, width: 1200 })).toMatchObject({ detailWidth: 776, folded: true,
      columns: '44px minmax(380px,1fr) 776px' });
    expect(bodyLayout({ ...saved, width: 2000, rail: true })).toMatchObject({ detailWidth: 1336,
      columns: '44px minmax(380px,1fr) 1336px 240px' });
    expect(bodyLayout({ ...saved, width: 2000, rail: true, peek: true })).toMatchObject({ detailWidth: 1080, folded: false,
      columns: '300px minmax(380px,1fr) 1080px 240px' });
    expect(bodyLayout({ ...saved, width: 3000, folded: true })).toMatchObject({ detailWidth: 2000, folded: true, auto: false });
    for (const detailWidth of [320, 400, 520, 720]) {
      expect(bodyLayout({ width: 2000, detail: true, rail: false, detailWidth })).toMatchObject({ detailWidth, folded: false });
    }
  });

  it.each([false, true])('shrinks a wide pane before the tree when Waiting opens (rail: %s)', rail => {
    const saved = { detail: true, detailWidth: 2000, rail, peek: true };
    for (const width of [1400, 1600, 2000]) {
      const layout = bodyLayout({ ...saved, width });
      const available = width - 300 - 380 - (rail ? 240 : 0);
      expect(layout).toMatchObject({ detailWidth: available, detailMax: available, folded: false,
        columns: `300px minmax(380px,1fr) ${available}px${rail ? ' 240px' : ''}` });
    }
    expect(bodyLayout({ ...saved, width: 3400 })).toMatchObject({ detailWidth: 2000, narrow: false,
      columns: `300px minmax(560px,1fr) 2000px${rail ? ' 240px' : ''}` });
  });

  it.each([undefined, 320, 400, 2000])('keeps the tree usable with Waiting and the rail open at the minimum window width (detail width: %s)', detailWidth => {
    const layout = bodyLayout({ width: 1300, detail: true, rail: true, detailWidth, peek: true });
    const shown = detailWidth === 320 ? 320 : 380;
    expect(layout).toMatchObject({ folded: false, narrow: true, detailWidth: shown, detailMax: 380,
      columns: `300px minmax(380px,1fr) ${shown}px 240px` });
    expect(300 + 380 + shown + 240).toBeLessThanOrEqual(1300);
  });

  it('can squeeze the centre when Waiting opens without a detail pane', () => {
    expect(bodyLayout({ width: 1000, detail: false, rail: true, peek: true })).toMatchObject({ folded: false, narrow: true,
      columns: '300px minmax(0,1fr) 240px' });
  });

  it('lets a widened detail panel use most of a 1400px window while keeping the default layout unchanged', () => {
    const window = { width: 1400, detail: true, rail: false };
    expect(bodyLayout(window)).toMatchObject({ folded: false, narrow: false, detailMax: 720,
      columns: '300px minmax(560px,1fr) 400px' });
    expect(bodyLayout({ ...window, detailWidth: 540 }).columns).toBe('300px minmax(560px,1fr) 540px');
    expect(bodyLayout({ ...window, detailWidth: 541 })).toMatchObject({ folded: true, auto: true,
      columns: '44px minmax(560px,1fr) 541px' });
    expect(bodyLayout({ ...window, detailWidth: 900 }).columns).toBe('44px minmax(456px,1fr) 900px');
    expect(bodyLayout({ ...window, detailWidth: 2400 })).toMatchObject({ detailWidth: 976, detailMax: 976,
      columns: '44px minmax(380px,1fr) 976px' });
    expect(bodyLayout({ ...window, detailWidth: 2400, rail: true }).columns).toBe('44px minmax(380px,1fr) 736px 240px');
    expect(bodyLayout({ ...window, width: 1260 })).toMatchObject({ folded: false, narrow: false });
    expect(bodyLayout({ ...window, width: 1259 })).toMatchObject({ folded: true, narrow: true });
    expect(bodyLayout({ ...window, width: 950 }).columns).toBe('44px minmax(560px,1fr) 346px');
    expect(bodyLayout({ ...window, detail: false, folded: true }).columns).toBe('44px minmax(560px,1fr)');
  });

  it('folds the Waiting column and narrows the detail panel so the body never scrolls sideways', () => {
    const total = (columns: string) => columns.split(' ').filter(part => part.endsWith('px') && !part.startsWith('minmax')).map(parseFloat)
      .reduce((sum, value) => sum + value, 0) + Number(columns.match(/minmax\((\d+)px/)![1]);
    // 1300 px with detail and rail open: 300 + 560 + 400 + 240 would overflow.
    const tight = bodyLayout({ width: 1300, detail: true, rail: true });
    expect(tight).toMatchObject({ folded: true, auto: true, narrow: true });
    expect(tight.columns).toBe(`44px minmax(560px,1fr) 400px 240px`);
    expect(total(tight.columns)).toBeLessThanOrEqual(1300);
    // An owner-wide detail panel narrows to fit.
    const wide = bodyLayout({ width: 1300, detail: true, rail: true, detailWidth: 700 });
    expect(wide.detailWidth).toBe(1300 - 44 - 380 - 240);
    expect(total(wide.columns)).toBeLessThanOrEqual(1300);
    // The owner can still open it; the panel shrinks to preserve a usable tree.
    const peek = bodyLayout({ width: 1300, detail: true, rail: true, peek: true });
    expect(peek).toMatchObject({ folded: false, narrow: true });
    expect(peek.columns).toBe('300px minmax(380px,1fr) 380px 240px');
    // The owner's own fold holds at any width and is not "auto".
    expect(bodyLayout({ width: 2000, detail: false, rail: false, folded: true })).toMatchObject({ folded: true, auto: false, columns: '44px minmax(560px,1fr)' });
    expect(bodyLayout({ width: 1300, detail: true, rail: false }).folded).toBe(false);
  });
});
