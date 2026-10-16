// The session and project switcher (SPEC 5.13): type to find, this project first, a run dot per session, and the waiting
// questions of other sessions named under their row. Pure props in, callbacks out (contract C8). Mount it in the
// window's overlay layer; it sits under the switcher button (top 38, left 30).
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Keycap, RunDot, WaitPill, usePopover, useRestoreFocus } from '../parts/parts';
import type { PageName, SwitcherMenuProps, SwitcherProject, SwitcherSession } from './model';
import './switcher.css';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A project whose name matches shows all its sessions; otherwise only the sessions whose name matches. This project stays first. */
export function findIn<R>(projects: readonly SwitcherProject<R>[], query: string): Array<{ project: SwitcherProject<R>; sessions: readonly SwitcherSession<R>[] }> {
  const q = query.trim().toLowerCase();
  const ordered = [...projects].sort((a, b) => Number(!!b.current) - Number(!!a.current));
  return ordered.flatMap(project => {
    const whole = !q || project.name.toLowerCase().includes(q);
    const sessions = whole ? project.sessions : project.sessions.filter(session => session.name.toLowerCase().includes(q));
    return sessions.length ? [{ project, sessions }] : [];
  });
}

const LINKS: ReadonlyArray<{ page: PageName; icon: string; label: string }> = [
  { page: 'projects', icon: 'ph ph-folders', label: 'Projects' },
  { page: 'sessions', icon: 'ph ph-list', label: 'All sessions' },
  { page: 'archive', icon: 'ph ph-archive', label: 'Archive' },
];

function metaOf<R>(session: SwitcherSession<R>): string {
  const state = session.closed ? `closed${session.closedWhen ? ` ${session.closedWhen}` : ''}` : session.running ? 'running' : 'not running';
  return session.agent ? `${session.agent} · ${state}` : state;
}

/** Something Enter can open: a session, or one of its waiting questions. */
interface Target<R> { readonly project: SwitcherProject<R>; readonly session: SwitcherSession<R>; readonly itemId?: string }

export function SwitcherMenu<R>({ projects, initialQuery = '', onOpenSession, onOpenPage, onClose }: SwitcherMenuProps<R>) {
  const [query, setQuery] = useState(initialQuery),[cursor, setCursor] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null), list = useId();
  usePopover(true, () => onClose(), panel, '[data-popover-trigger="switcher"]');
  useRestoreFocus(panel);
  const groups = useMemo(() => findIn(projects, query), [projects, query]);
  const targets: Array<Target<R>> = groups.flatMap(({ project, sessions }) => sessions.flatMap(session => [{ project, session },
    ...(session.current ? [] : session.waiting.map(question => ({ project, session, itemId: question.itemId })))]));
  // While typing, the first match is highlighted and Enter opens it. With nothing typed, nothing is until an arrow key is pressed.
  const at = !targets.length ? -1 : cursor !== null ? Math.min(cursor, targets.length - 1) : query.trim() ? 0 : -1;
  const open = (target: Target<R>) => { onClose(); onOpenSession(target.session, target.project.id, target.itemId); };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const down = event.key === 'ArrowDown', count = targets.length;
      if (count) setCursor(at < 0 ? (down ? 0 : count - 1) : (at + (down ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter' && at >= 0) {
      event.preventDefault();
      open(targets[at]!);
    }
  };
  let counter = -1;
  const next = () => ++counter;
  return <div ref={panel} className="swm" role="dialog" aria-label="Switch session or project">
    <div className="swm-find">
      <i className="ph ph-magnifying-glass" aria-hidden="true" />
      <input className="swm-input" autoFocus value={query} placeholder="Find a session or project" aria-label="Find a session or project" role="combobox" aria-expanded="true" aria-controls={list}
        aria-activedescendant={at >= 0 ? `${list}-${at}` : undefined} spellCheck={false} onChange={event => { setQuery(event.target.value); setCursor(null); }} onKeyDown={keys} />
      <Keycap size="md">⌘O</Keycap>
    </div>
    <div id={list} role="listbox" aria-label="Sessions" className="swm-list">
      {groups.map(({ project, sessions }) => <div key={project.id} role="group" aria-label={project.name} className="swm-group">
        <div className="swm-head"><i className="ph ph-folder-simple" aria-hidden="true" />{project.name}{project.current ? ' · this project' : ''}</div>
        {sessions.map((session, row) => {
          const mine = next(), target: Target<R> = { project, session };
          return <div key={`${row}:${session.name}`} className={session.current ? 'swm-row swm-current' : 'swm-row'}>
            <button type="button" role="option" id={`${list}-${mine}`} aria-selected={session.current ?? false} tabIndex={-1} data-cursor={mine === at ? '' : undefined} className="swm-main" onClick={() => open(target)}>
              <RunDot run={session.closed ? 'closed' : session.running ? 'live' : 'off'} />
              <span className={session.closed ? 'swm-name swm-name-closed' : 'swm-name'}>{session.name}</span>
              <span className="swm-meta">{metaOf(session)}</span>
              {session.waiting.length > 0 && <WaitPill count={session.waiting.length} label={`${plural(session.waiting.length, 'question')} waiting on you`} />}
              {session.current && <i className="ph ph-check swm-here" title="This session" role="img" aria-label="This session" />}
            </button>
            {!session.current && session.waiting.map(question => {
              const at2 = next();
              return <button type="button" role="option" id={`${list}-${at2}`} aria-selected={false} tabIndex={-1} key={question.itemId} data-cursor={at2 === at ? '' : undefined} className="swm-q"
                onClick={() => open({ project, session, itemId: question.itemId })}>
                <i className="ph-fill ph-question" aria-hidden="true" /><span className="swm-q-title">{question.title}</span>{question.since && <span className="swm-q-since">{question.since}</span>}
              </button>;
            })}
          </div>;
        })}
      </div>)}
      {!targets.length && <div className="swm-empty" role="status">No session or project matches “{query.trim()}”.</div>}
    </div>
    <div className="swm-rule" />
    <div className="swm-links">
      {LINKS.map(link => <button type="button" key={link.page} className="swm-link" onClick={() => { onClose(); onOpenPage(link.page); }}><i className={link.icon} aria-hidden="true" />{link.label}</button>)}
    </div>
    <div className="swm-note">Switching keeps your drafts where they are.</div>
  </div>;
}
