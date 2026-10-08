// Header, tab and footer strings of the Paperwhite shell, built from real
// catalogue and session data. The wording follows the handoff README
// (Global chrome) and Ariadne.dc.html; nothing here is a placeholder.

export type ShellTheme = 'light' | 'dark';
export type Colour = 'var(--st-done)' | 'var(--st-open)' | 'var(--st-progress)';

const neutral = (percent: number) => `color-mix(in srgb, var(--color-text) ${percent}%, transparent)`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const pad = (value: number) => String(value).padStart(2, '0');
const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
const daysBefore = (at: number, now: number) => Math.round((startOfDay(new Date(now)) - startOfDay(new Date(at))) / 86_400_000);

/** Host agent names as the handoff writes them. */
export function agentName(adapterId: string): string {
  if (adapterId === 'claude_code_mod') return 'claude-code';
  return adapterId;
}

/** The terminal app of a binding's host location: "iTerm window 1" → "iTerm" (ADR-0085). Null when the host reports none. */
export function hostApp(location: string | null | undefined): string | null {
  return location ? location.replace(/ window \d+$/, '') : null;
}

/** The owner's own name and one-line description of a session (ADR-0091); a session and its catalogue summary both carry them. */
export interface SessionNaming { readonly name?: string | null; readonly description?: string | null }
/** The most characters the owner can type into each field; core refuses more. */
export const SESSION_NAME_MAX = 60, SESSION_DESCRIPTION_MAX = 200;

/** The owner's name for the session, trimmed; null when none is set. */
export const ownerName = (naming: SessionNaming | null | undefined): string | null => naming?.name?.trim() || null;
export const ownerDescription = (naming: SessionNaming | null | undefined): string | null => naming?.description?.trim() || null;

/** `title` is what names the session; `secondary` is the agent line, kept quieter beneath a name. */
export interface SessionLabel { readonly named: boolean; readonly title: string; readonly secondary: string | null; readonly description: string | null }
/** The owner's name leads when one is set, over the agent line ("claude-code · iTerm window 1"). Unnamed, the agent line is the title. */
export function sessionLabel(naming: SessionNaming | null | undefined, agentLine: string): SessionLabel {
  const name = ownerName(naming);
  return { named: name !== null, title: name ?? agentLine, secondary: name === null ? null : agentLine, description: ownerDescription(naming) };
}

/** "claude-code · iTerm window 1", or just the agent when the host reports no location. */
export const agentLine = (agent: string, location: string | null | undefined): string => location ? `${agent} · ${location}` : agent;

/** The words a confirmation uses for a session: the owner's name, else "the claude-code session from today". */
export function sessionPhrase(naming: SessionNaming | null | undefined, agent: string, when: string): string {
  const name = ownerName(naming);
  return name ? `the “${name}” session` : `the ${agent} session from ${when.toLowerCase()}`;
}

/** Local wall-clock time, "15:04". */
export function clock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Day word for a timestamp: "" today, "Yesterday", a weekday this week, else "3 Oct". */
export function dayWord(at: number, now: number): string {
  const days = daysBefore(at, now);
  if (days <= 0) return '';
  if (days === 1) return 'Yesterday';
  const date = new Date(at);
  if (days < 7) return date.toLocaleDateString('en-GB', { weekday: 'short' });
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Session start as the tab sub-label shows it: "Today 14:02", "Yesterday", "3 days ago", "Last week". */
export function sessionWhen(at: number, now: number): string {
  const days = daysBefore(at, now);
  if (days <= 0) return `Today ${clock(at)}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export interface HeaderText { readonly sessionText: string; readonly connText: string; readonly connColor: Colour }

export interface SessionFacts {
  readonly projectName: string;
  readonly createdAt: number;
  readonly messageCount: number;
  /** Agent name, or null when the session has no binding. */
  readonly agent: string | null;
  readonly connection: 'loading' | 'connected' | 'reconnecting' | 'not_running' | 'none';
  /** Where the agent runs ("iTerm"), only when the host reports it. */
  readonly where?: string | null;
  readonly lastMessage?: { readonly number: number; readonly createdAt: number } | null;
}

export type HeaderInput =
  | { readonly kind: 'projects'; readonly projectCount: number; readonly runningAgents: number; readonly projectPath?: string | null }
  | { readonly kind: 'all_sessions'; readonly openTabs: number; readonly openProjects: number }
  | { readonly kind: 'session'; readonly facts: SessionFacts | null; readonly fallbackAgent: string | null };

export function headerText(input: HeaderInput, now: number): HeaderText {
  if (input.kind === 'projects') {
    return { sessionText: input.projectPath ?? plural(input.projectCount, 'project'), connText: `${plural(input.runningAgents, 'agent')} running`,
      connColor: input.runningAgents ? 'var(--st-done)' : 'var(--st-open)' };
  }
  if (input.kind === 'all_sessions') {
    return { sessionText: `${plural(input.openTabs, 'session')} open`, connText: `across ${plural(input.openProjects, 'project')}`, connColor: 'var(--st-open)' };
  }
  const facts = input.facts, agent = facts?.agent ?? input.fallbackAgent;
  if (!facts || facts.connection === 'loading') {
    return { sessionText: 'Opening session…', connText: agent ? `Connecting to ${agent}…` : 'Not connected', connColor: agent ? 'var(--st-progress)' : 'var(--st-open)' };
  }
  const started = sessionWhen(facts.createdAt, now).replace(/^Today /, '');
  const messages = facts.messageCount ? ` · ${facts.messageCount} messages` : '';
  const sessionText = `${facts.projectName} · started ${started}${messages}`;
  // Without a live connection the prototype keeps its default "Session started …" (Ariadne.dc.html:2133 vs 1683).
  const unlinked = `Session started ${started}${messages}`;
  const last = facts.lastMessage;
  if (!agent || facts.connection === 'none') return { sessionText: unlinked, connText: 'Not connected', connColor: 'var(--st-open)' };
  if (facts.connection === 'reconnecting') {
    return { sessionText: unlinked, connText: `Reconnecting to ${agent}… · last synced ${last ? clock(last.createdAt) : '–'}`, connColor: 'var(--st-progress)' };
  }
  if (facts.connection === 'connected') {
    return { sessionText, connText: `Connected · ${agent}${facts.where ? ` in ${facts.where}` : ''}${last ? ` · last message #${last.number} at ${clock(last.createdAt)}` : ''}`,
      connColor: 'var(--st-done)' };
  }
  const day = last ? dayWord(last.createdAt, now).toLowerCase() : '';
  return { sessionText, connText: `${agent} isn’t running${last ? ` · last message ${agent} #${last.number}, ${day ? `${day} ` : ''}${clock(last.createdAt)}` : ''}`,
    connColor: 'var(--st-open)' };
}

export interface TabModel {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly icon: string;
  readonly iconSize: string;
  readonly iconColor: string;
  readonly project: string | null;
  readonly title: string;
  readonly on: boolean;
  readonly closable: boolean;
}

export interface SessionTabFacts {
  readonly id: string;
  readonly project: string;
  readonly agent: string | null;
  readonly where?: string | null;
  /** The owner's name and description; the name leads the tab. */
  readonly naming?: SessionNaming | null;
  readonly createdAt: number | null;
  readonly endedAt: number | null;
  readonly running: boolean;
  readonly on: boolean;
}

/** "Today 14:02 – now", "Yesterday 16:40 – 17:25", "Last week · Tue 15:30 – 16:45". */
export function sessionRange(createdAt: number, endedAt: number | null, running: boolean, now: number): string {
  const start = sessionWhen(createdAt, now), day = daysBefore(createdAt, now);
  const weekday = day >= 7 && day < 14 ? `${new Date(createdAt).toLocaleDateString('en-GB', { weekday: 'short' })} ` : '';
  const head = day === 1 ? `Yesterday ${clock(createdAt)}` : day > 1 ? `${start} · ${weekday}${clock(createdAt)}` : start;
  return `${head} – ${running || endedAt === null ? 'now' : clock(endedAt)}`;
}

export function tabModels(input: { readonly selection: 'projects' | 'all_sessions' | 'session'; readonly sessions: readonly SessionTabFacts[]; readonly projectCount: number },
  now: number): TabModel[] {
  const base = (id: string, on: boolean, extra: Pick<TabModel, 'label' | 'sub' | 'icon' | 'title'>): TabModel => ({
    id, on, iconSize: '14px', iconColor: neutral(72), project: null, closable: false, ...extra });
  return [
    base('projects', input.selection === 'projects', { label: 'Projects', sub: '', icon: 'ph ph-folders', title: 'All projects' }),
    base('all_sessions', input.selection === 'all_sessions', { label: 'All sessions', sub: input.sessions.length ? String(input.sessions.length) : '',
      icon: 'ph ph-squares-four', title: 'Every session in the projects you have open' }),
    ...input.sessions.map(session => {
      const agent = session.agent ?? 'No agent';
      const when = session.createdAt === null ? '' : sessionWhen(session.createdAt, now);
      const range = session.createdAt === null ? '' : sessionRange(session.createdAt, session.endedAt, session.running, now);
      const name = ownerName(session.naming);
      return { id: session.id, on: session.on, label: name ?? agent, sub: when, project: input.projectCount > 1 ? session.project : null,
        icon: session.running ? 'ph-fill ph-circle' : 'ph ph-circle', iconSize: '9px', iconColor: session.running ? 'var(--st-done)' : neutral(55),
        title: [session.project, name, agent, session.where, ownerDescription(session.naming), range, session.running ? 'agent running' : 'agent not running'].filter(Boolean).join(' · '),
        closable: true };
    }),
  ];
}

export interface FooterCounts {
  readonly items: number;
  readonly waiting: number;
  readonly inProgress: number;
  readonly open: number;
  readonly archivedTopics: number;
}

export function footerSummary(counts: FooterCounts | null): string {
  if (!counts) return '';
  return `${counts.items} items · ${counts.waiting} waiting on you · ${counts.inProgress} in progress · ${counts.open} open${counts.archivedTopics ? ` · ${counts.archivedTopics} archived topics` : ''}`;
}

export const footerKeys: readonly { readonly k: string; readonly t: string }[] = [
  { k: '↑↓', t: 'move' }, { k: '←→', t: 'fold' }, { k: 'a', t: 'ack / answer' }, { k: '1–9', t: 'select' }, { k: '⌥1–9', t: 'send choice + note' }, { k: '⌥0', t: 'focus own words' }, { k: '⌘↵', t: 'reply only' }, { k: '↵', t: 'send / details' },
  { k: 'b r d z o', t: 'item actions' }, { k: 'x', t: 'hide / unhide' }, { k: '/', t: 'search' }, { k: 'g', t: 'graph' }, { k: 'm', t: 'messages' }, { k: 'w', t: 'waiting' }, { k: 'esc', t: 'close' },
];

/** Body column widths in CSS pixels. The detail bounds match the saved `detail_width` bounds. */
export const WAITING_WIDTH = 300, WAITING_FOLDED = 44, CENTRE_MIN = 560, RAIL_WIDTH = 240;
export const DETAIL_MIN = 320, DETAIL_MAX = 720, DETAIL_DEFAULT = 400;

export interface BodyLayoutInput {
  /** The body's width; null before it is measured. */
  readonly width: number | null;
  readonly detail: boolean;
  readonly rail: boolean;
  /** The owner's detail width; null for the default. */
  readonly detailWidth?: number | null;
  /** The owner folded the Waiting column. */
  readonly folded?: boolean;
  /** The owner opened the Waiting column although the window is too narrow for it. */
  readonly peek?: boolean;
}

export interface BodyLayout {
  readonly columns: string;
  /** The Waiting column shows as a strip. */
  readonly folded: boolean;
  /** Folded only because the window is too narrow. */
  readonly auto: boolean;
  /** The window is too narrow for the open Waiting column. */
  readonly narrow: boolean;
  readonly detailWidth: number;
  /** The widest the detail panel can be without the body scrolling sideways. */
  readonly detailMax: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Body grid: waiting | centre | [detail] | [rail]. When the open columns do not fit, the Waiting
 * column folds to a strip and the detail panel narrows, so the body never scrolls sideways.
 */
export function bodyLayout({ width, detail, rail, detailWidth, folded = false, peek = false }: BodyLayoutInput): BodyLayout {
  const room = width ?? Number.POSITIVE_INFINITY, railWidth = rail ? RAIL_WIDTH : 0;
  const wanted = clamp(Math.round(detailWidth ?? DETAIL_DEFAULT), DETAIL_MIN, DETAIL_MAX);
  const narrow = room < WAITING_WIDTH + CENTRE_MIN + (detail ? wanted : 0) + railWidth;
  const strip = folded || (narrow && !peek);
  const waiting = strip ? WAITING_FOLDED : WAITING_WIDTH;
  // An owner-opened column in a narrow window squeezes the centre instead of scrolling the body.
  const centreMin = narrow && !strip ? 0 : CENTRE_MIN;
  const detailMax = clamp(Math.floor(room - waiting - centreMin - railWidth), DETAIL_MIN, DETAIL_MAX);
  const shown = Math.min(wanted, detailMax);
  const centre = `minmax(${centreMin ? `${centreMin}px` : '0'},1fr)`;
  return { columns: `${waiting}px ${centre}${detail ? ` ${shown}px` : ''}${rail ? ` ${RAIL_WIDTH}px` : ''}`,
    folded: strip, auto: strip && !folded, narrow, detailWidth: shown, detailMax };
}

export function themeToggle(theme: ShellTheme): { readonly icon: string; readonly title: string; readonly next: ShellTheme } {
  return theme === 'dark' ? { icon: 'ph ph-sun', title: 'Switch to light', next: 'light' } : { icon: 'ph ph-moon', title: 'Switch to dark', next: 'dark' };
}

export function glow(colour: string): string {
  return `0 0 0 3px color-mix(in srgb, ${colour} 22%, transparent)`;
}
