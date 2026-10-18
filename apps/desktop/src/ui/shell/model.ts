// Session words, times and body widths of the shell, built from real catalogue and session data.

export type ShellTheme = 'light' | 'dark';

const pad = (value: number) => String(value).padStart(2, '0');
const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
const daysBefore = (at: number, now: number) => Math.round((startOfDay(new Date(now)) - startOfDay(new Date(at))) / 86_400_000);

/** The product name of a host agent as the board writes it: "Claude Code", "Codex". An adapter id it does not know is shown as it is. */
export function agentName(adapterId: string): string {
  if (adapterId === 'claude_code_mod') return 'Claude Code';
  if (adapterId === 'codex') return 'Codex';
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
/** The owner's name leads when one is set, over the agent line ("Claude Code · iTerm window 1"). Unnamed, the agent line is the title. */
export function sessionLabel(naming: SessionNaming | null | undefined, agentLine: string): SessionLabel {
  const name = ownerName(naming);
  return { named: name !== null, title: name ?? agentLine, secondary: name === null ? null : agentLine, description: ownerDescription(naming) };
}

/** "Claude Code · iTerm window 1", or just the agent when the host reports no location. */
export const agentLine = (agent: string, location: string | null | undefined): string => location ? `${agent} · ${location}` : agent;

/** The words a confirmation uses for a session: the owner's name, else "the Claude Code session from today". */
export function sessionPhrase(naming: SessionNaming | null | undefined, agent: string, when: string): string {
  const name = ownerName(naming);
  return name ? `the “${name}” session` : `the ${agent} session from ${when.toLowerCase()}`;
}

/** Local wall-clock time, "15:04". */
export function clock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Oct", "12 Sep": the board's short date. Fixed words: en-GB in newer ICU writes "Sept". */
export function shortDate(at: number): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Day word for a timestamp: "" today, "Yesterday", a weekday this week, else "3 Oct". */
export function dayWord(at: number, now: number): string {
  const days = daysBefore(at, now);
  if (days <= 0) return '';
  if (days === 1) return 'Yesterday';
  const date = new Date(at);
  if (days < 7) return date.toLocaleDateString('en-GB', { weekday: 'short' });
  return shortDate(at);
}

/** Session start as the tab sub-label shows it: "Today 14:02", "Yesterday", "3 days ago", "Last week". */
export function sessionWhen(at: number, now: number): string {
  const days = daysBefore(at, now);
  if (days <= 0) return `Today ${clock(at)}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  return shortDate(at);
}

/** Body column widths in CSS pixels. The detail bounds match the saved `detail_width` bounds. */
export const CENTRE_MIN = 560;
/** The narrowest the side column can show (a narrow window, state/details/column.ts); core saves a width of 320 to 2400. */
export const DETAIL_MIN = 280, DETAIL_MAX = 2400, DETAIL_DEFAULT = 400;
const CENTRE_RESIZE_MIN = 380;
export interface BodyLayoutInput {
  readonly width: number | null;
  readonly detail: boolean;
  readonly detailWidth?: number | null;
}
export interface BodyLayout {
  readonly columns: string;
  readonly detailWidth: number;
  readonly detailMax: number;
}
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Map | Details; the dock floats outside the grid. */
export function bodyLayout({ width, detail, detailWidth }: BodyLayoutInput): BodyLayout {
  const room = width ?? Number.POSITIVE_INFINITY;
  const wanted = clamp(Math.round(detailWidth ?? DETAIL_DEFAULT), DETAIL_MIN, DETAIL_MAX);
  const detailMax = clamp(Math.floor(room - CENTRE_RESIZE_MIN), DETAIL_MIN, DETAIL_MAX);
  const shown = Math.min(wanted, detailMax);
  const minimum = detail ? Math.min(CENTRE_MIN, Math.max(0, room - shown)) : 0;
  return { columns: `minmax(${minimum}px,1fr)${detail ? ` ${shown}px` : ''}`, detailWidth: shown, detailMax };
}

export function themeToggle(theme: ShellTheme): { readonly icon: string; readonly title: string; readonly next: ShellTheme } {
  return theme === 'dark' ? { icon: 'ph ph-sun', title: 'Switch to light', next: 'light' } : { icon: 'ph ph-moon', title: 'Switch to dark', next: 'dark' };
}
