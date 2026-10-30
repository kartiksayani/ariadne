// The 40px top bar of the redesign (SPEC 2.1): mark, session switcher, connection, search, Tree/Graph, filter, Recent,
// Archive, text size, theme, help. Pure props in, callbacks out (contract C8). Narrow windows keep the five controls
// that matter and move the rest behind "…".
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { themeToggle } from '../shell/model';
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, type TextSize } from '../shell/textScale';
import { Keycap, WaitPill, menuKeys, useFocusFirst, usePopover } from '../parts/parts';
import { WaitingHereChip } from '../pages/WaitingHereChip';
import { connectionBadge } from './connection';
import type { SearchView, TopBarProps } from './model';
import './topbar.css';

function Mark() {
  return <svg className="tb-mark" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g transform="translate(12 12)"><path d="M-3.245 9.986A10.5 10.5 0 1 1 3.245 9.986M2.086 -6.42A6.75 6.75 0 1 1 -2.086 -6.42M-1.721 2.457A3 3 0 1 1 1.721 2.457" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><circle cx="0" cy="0" r="1.35" fill="currentColor" /></g></svg>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function Search({ search, narrow, disabled }: { readonly search: SearchView; readonly narrow: boolean; readonly disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const wasActive = useRef(search.active);
  useEffect(() => {
    if (search.active && !wasActive.current) input.current?.focus();
    wasActive.current = search.active;
  }, [search.active]);
  if (!search.active) {
    if (narrow) return <button type="button" className="p-iconbtn tb-icon" title="Search ( / )" aria-label="Search the Map" disabled={disabled} onClick={search.onOpen}><i className="ph ph-magnifying-glass" aria-hidden="true" /></button>;
    return <button type="button" className="tb-search" title="Search questions, outcomes and notes ( / )" aria-label="Search the Map" disabled={disabled} onClick={search.onOpen}>
      <i className="ph ph-magnifying-glass" aria-hidden="true" /><span className="tb-search-hint">Search the Map</span><Keycap>/</Keycap>
    </button>;
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      const step = event.shiftKey ? search.onPrev : search.onNext;
      if (step) { event.preventDefault(); event.stopPropagation(); step(); }
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); search.onClear(); }
  };
  return <div className={narrow ? 'tb-search tb-search-on tb-search-narrow' : 'tb-search tb-search-on'} role="search">
    <i className="ph ph-magnifying-glass tb-search-icon" aria-hidden="true" />
    <input ref={input} className="tb-search-input" value={search.query} aria-label="Search the Map" placeholder="Search the Map" spellCheck={false}
      disabled={disabled} onChange={event => search.onQuery(event.target.value)} onKeyDown={keys} />
    {search.count && <span className="tb-search-count" role="status">{search.count}</span>}
    {search.onPrev && <button type="button" className="tb-search-btn" title="Previous match ( ⇧↵ )" aria-label="Previous match" onClick={search.onPrev}><i className="ph ph-caret-up" aria-hidden="true" /></button>}
    {search.onNext && <button type="button" className="tb-search-btn" title="Next match ( ↵ )" aria-label="Next match" onClick={search.onNext}><i className="ph ph-caret-down" aria-hidden="true" /></button>}
    <button type="button" className="tb-search-btn tb-search-x" title="Clear the search ( esc )" aria-label="Clear the search" disabled={disabled} onClick={search.onClear}><i className="ph ph-x" aria-hidden="true" /></button>
    {search.note && <div className="tb-search-note" role="status">
      <i className="ph ph-dots-three" aria-hidden="true" /><span className="tb-note-text">{search.note.text}</span>
      <button type="button" className="tb-note-action" onClick={search.note.onAction}>{search.note.action}</button>
    </div>}
  </div>;
}

/** The Aa button and its sizes. Same sizes and wording as the earlier text size control. */
function SizeMenu({ size, onChange, disabled }: { readonly size: TextSize; readonly onChange: (size: TextSize) => void; readonly disabled?: boolean }) {
  const [open, setOpen] = useState(false), [keyboard, setKeyboard] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const close = (restore: boolean) => { setOpen(false); if (restore) button.current?.focus(); };
  usePopover(open, close, root);
  useFocusFirst(menu, open && keyboard);
  return <div className="tb-anchor" ref={root}>
    <button type="button" ref={button} className="p-iconbtn tb-icon tb-aa" aria-label="Text size" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} title="Text size (⌘− smaller, ⌘+ or ⌘= larger, ⌘0 default)" data-active={open || undefined}
      onClick={event => { setKeyboard(event.detail === 0); setOpen(value => !value); }}>Aa</button>
    {open && <div ref={menu} id={id} role="menu" aria-label="Text size" className="tb-pop tb-sizes" onKeyDown={event => menuKeys(event, close)}>
      {TEXT_SIZES.map(value => <button type="button" role="menuitemradio" aria-checked={value === size} key={value} className="tb-size"
        onClick={() => { onChange(value); close(true); }}>
        <i className={value === size ? 'ph ph-check' : 'ph'} aria-hidden="true" />{value}%{value === DEFAULT_TEXT_SIZE ? ' (default)' : ''}
      </button>)}
    </div>}
  </div>;
}

/** Narrow windows: the four controls the narrow bar leaves out. */
function MoreMenu({ props, withArchive }: { readonly props: TopBarProps; readonly withArchive: boolean }) {
  const [open, setOpen] = useState(false), [keyboard, setKeyboard] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const close = (restore: boolean) => { setOpen(false); if (restore) button.current?.focus(); };
  usePopover(open, close, root);
  useFocusFirst(menu, open && keyboard);
  const toggle = themeToggle(props.theme);
  const pick = (run: () => void) => () => { close(false); run(); };
  return <div className="tb-anchor" ref={root}>
    <button type="button" ref={button} className="p-iconbtn tb-icon" title="Archive, text size, theme, help" aria-label="More: archive, text size, theme, help" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} disabled={props.disabled} data-active={open || props.help.open || undefined}
      onClick={event => { setKeyboard(event.detail === 0); setOpen(value => !value); }}><i className="ph ph-dots-three" aria-hidden="true" /></button>
    {open && <div ref={menu} id={id} role="menu" aria-label="Archive, text size, theme, help" className="tb-pop tb-more" onKeyDown={event => menuKeys(event, close)}>
      {withArchive && <button type="button" role="menuitem" className="tb-more-row" onClick={pick(props.archive.onOpen)}><i className="ph ph-archive" aria-hidden="true" />Archive</button>}
      <button type="button" role="menuitem" className="tb-more-row" onClick={pick(props.onToggleTheme)}><i className={toggle.icon} aria-hidden="true" />{toggle.title}</button>
      <button type="button" role="menuitem" className="tb-more-row" onClick={pick(props.help.onToggle)}><i className="tb-more-q" aria-hidden="true">?</i>Help: keys and markers<Keycap>?</Keycap></button>
      <div className="tb-more-label" id={`${id}-size`}>Text size</div>
      <div className="tb-more-sizes" role="group" aria-labelledby={`${id}-size`}>
        {TEXT_SIZES.map(value => <button type="button" role="menuitemradio" aria-checked={value === props.textSize} key={value} className="tb-size tb-size-chip"
          onClick={() => { props.onTextSizeChange(value); close(true); }}>{value}%</button>)}
      </div>
    </div>}
  </div>;
}

export function TopBar(props: TopBarProps) {
  const { narrow, variant = 'session', disabled } = props;
  const first = variant === 'first-run';
  const badge = !first && props.connection ? connectionBadge(props.connection, narrow) : null;
  const toggle = themeToggle(props.theme);
  const filterWords = props.filter.count > 0 ? `Filter by status, ${props.filter.count} ${props.filter.count === 1 ? 'status' : 'statuses'} picked` : 'Filter by status';
  return <header className={narrow ? 'tb tb-narrow' : 'tb'}>
    <Mark />
    {first
      ? <span className="tb-btn tb-switch tb-switch-static"><span className="tb-name tb-name-quiet">No projects yet</span></span>
      : <button type="button" className="tb-btn tb-switch" data-popover-trigger="switcher" title="Switch session or project ( ⌘O )" data-active={props.switcherOpen || undefined}
        aria-haspopup="dialog" aria-expanded={props.switcherOpen} disabled={props.switcherDisabled ?? disabled} onClick={props.onSwitcherToggle}
        aria-label={`Switch session or project. ${props.project && !narrow ? `${props.project} / ` : ''}${props.sessionName}${props.otherWaiting > 0 ? `, ${plural(props.otherWaiting, 'question')} waiting in other sessions` : ''}`}>
        {!narrow && props.project && <><span className="tb-proj">{props.project}</span><span className="tb-slash">/</span></>}
        <span className="tb-name">{props.sessionName}</span>
        {props.otherWaiting > 0 && <WaitPill count={props.otherWaiting} label={`${plural(props.otherWaiting, 'question')} waiting on you in other sessions`} />}
        <i className="ph ph-caret-down tb-caret" aria-hidden="true" />
      </button>}
    {badge && <span className="tb-anchor">
      <button type="button" className="tb-btn tb-conn" data-popover-trigger="connection" title={badge.title} data-active={props.connectionOpen || undefined} aria-haspopup="dialog"
        aria-expanded={props.connectionOpen ?? false} aria-label={`${badge.label}. ${badge.title}`} disabled={disabled} onClick={props.onConnectionToggle}>
        {badge.dot && <span className={badge.dot.ring ? 'tb-dot tb-dot-ring' : 'tb-dot'} style={badge.dot.color ? { background: badge.dot.color } : undefined} aria-hidden="true" />}
        {badge.icon && <i className={`${badge.icon.name}${badge.icon.spin ? ' p-spin' : ''} tb-conn-icon`} style={{ color: badge.icon.color }} aria-hidden="true" />}
        {badge.showLabel && <span className="tb-conn-label">{badge.label}</span>}
      </button>
      {props.connectionOpen && props.connectionCard}
    </span>}
    {variant === 'page' && (props.waitingHere ?? 0) > 0 && <WaitingHereChip count={props.waitingHere!} narrow={narrow} onGo={() => props.onWaitingHere?.()} />}
    <span className="tb-spacer" />
    {!first && <>
      <Search search={props.search} narrow={narrow} disabled={disabled} />
      <div className="tb-seg" role="group" aria-label="View">
        <button type="button" className="tb-seg-btn" aria-pressed={props.view === 'tree'} title="Tree ( g )" aria-label="Tree" disabled={disabled} onClick={() => props.onView('tree')}>
          <i className="ph ph-tree-view" aria-hidden="true" />{!narrow && <span>Tree</span>}</button>
        <button type="button" className="tb-seg-btn" aria-pressed={props.view === 'graph'} title="Graph ( g )" aria-label="Graph" disabled={disabled} onClick={() => props.onView('graph')}>
          <i className="ph ph-graph" aria-hidden="true" />{!narrow && <span>Graph</span>}</button>
      </div>
      <button type="button" className="p-iconbtn tb-icon tb-filter" title="Filter by status ( f )" aria-label={filterWords} aria-pressed={props.filter.active} data-active={props.filter.active || undefined}
        disabled={disabled} onClick={props.filter.onToggle}>
        <i className="ph ph-funnel" aria-hidden="true" />{props.filter.count > 0 && <span className="tb-badge" aria-hidden="true">{props.filter.count}</span>}
      </button>
      <button type="button" className="p-iconbtn tb-icon" data-popover-trigger="recent" title="Recent ( ⌘E )" aria-label="Recent" aria-haspopup="dialog" aria-expanded={props.recent.active} aria-pressed={props.recent.active} data-active={props.recent.active || undefined}
        disabled={disabled} onClick={props.recent.onToggle}><i className="ph ph-clock-counter-clockwise" aria-hidden="true" /></button>
    </>}
    {!narrow && <>
      {!first && <button type="button" className="p-iconbtn tb-icon" title="Archive" aria-label="Archive" aria-pressed={props.archive.active} data-active={props.archive.active || undefined}
        disabled={disabled} onClick={props.archive.onOpen}><i className="ph ph-archive" aria-hidden="true" /></button>}
      <span className="tb-div" aria-hidden="true" />
      <SizeMenu size={props.textSize} onChange={props.onTextSizeChange} disabled={disabled} />
      <button type="button" className="p-iconbtn tb-icon" title={toggle.title} aria-label={toggle.title} disabled={disabled} onClick={props.onToggleTheme}><i className={toggle.icon} aria-hidden="true" /></button>
      <button type="button" className="p-iconbtn tb-icon tb-help" data-popover-trigger="help" title="Help: keys and markers ( ? )" aria-label="Help: keys and markers" aria-haspopup="dialog" aria-expanded={props.help.open}
        data-active={props.help.open || undefined} disabled={disabled} onClick={props.help.onToggle}>?</button>
    </>}
    {narrow && <MoreMenu props={props} withArchive={!first} />}
  </header>;
}
