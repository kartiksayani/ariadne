import type { HeaderText, ShellTheme } from './model';
import { glow, themeToggle } from './model';

export interface ViewTab {
  readonly label: string;
  readonly icon: string;
  readonly title: string;
  readonly on: boolean;
  readonly onSelect?: () => void;
}

export interface HeaderProps {
  readonly text: HeaderText;
  readonly demo?: boolean;
  readonly query: string;
  readonly onQueryChange?: (query: string) => void;
  /** Tree / Graph / Archive; shown only in session tabs. */
  readonly views: readonly ViewTab[] | null;
  readonly railOn: boolean;
  readonly onToggleRail?: () => void;
  readonly theme: ShellTheme;
  readonly onToggleTheme?: () => void;
  /** Disables the controls while navigation writes. */
  readonly disabled?: boolean;
}

export function Header({ text, demo, query, onQueryChange, views, railOn, onToggleRail, theme, onToggleTheme, disabled }: HeaderProps) {
  const toggle = themeToggle(theme);
  return <header className="shell-header">
    <div className="shell-brand"><svg className="shell-brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g transform="translate(12 12)"><path d="M-3.245 9.986A10.5 10.5 0 1 1 3.245 9.986M2.086 -6.42A6.75 6.75 0 1 1 -2.086 -6.42M-1.721 2.457A3 3 0 1 1 1.721 2.457" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><circle cx="0" cy="0" r="1.35" fill="currentColor" /></g></svg><span>Ariadne</span></div>
    <div className="shell-context">
      {demo && <span className="tag tag-accent shell-demo">Demo</span>}
      <span className="shell-session-text">{text.sessionText}</span>
      <span className="shell-connection"><span className="shell-connection-dot" style={{ background: text.connColor, boxShadow: glow(text.connColor) }} />
        <span className="shell-connection-text">{text.connText}</span></span>
    </div>
    <div className="shell-spacer" />
    <label className="shell-search">
      <i className="ph ph-magnifying-glass" aria-hidden="true" />
      <input className="input" data-shell-search="" aria-label="Search questions and outcomes" placeholder="Search questions and outcomes" value={query}
        readOnly={!onQueryChange} disabled={onQueryChange ? disabled : undefined} onChange={event => onQueryChange?.(event.target.value)} />
      <span className="shell-search-key" aria-hidden="true">/</span>
    </label>
    {views && <div className="shell-views" role="group" aria-label="View">
      {views.map(view => <button type="button" key={view.title} title={view.title} aria-pressed={view.on} disabled={view.onSelect ? disabled : undefined}
        className={view.on ? 'shell-view shell-view-on' : 'shell-view'} onClick={view.onSelect}><i className={view.icon} aria-hidden="true" />{view.label}</button>)}
    </div>}
    <button type="button" className="btn btn-secondary btn-icon shell-icon" title="Messages (m)" aria-label="Messages (m)" aria-pressed={railOn}
      style={{ color: railOn ? 'var(--color-accent)' : 'var(--color-text)' }} disabled={onToggleRail ? disabled : undefined} onClick={onToggleRail}>
      <i className="ph ph-chats-teardrop" aria-hidden="true" /></button>
    <button type="button" className="btn btn-secondary btn-icon shell-icon" title={toggle.title} aria-label={toggle.title}
      disabled={onToggleTheme ? disabled : undefined} onClick={onToggleTheme}><i className={toggle.icon} aria-hidden="true" /></button>
  </header>;
}
