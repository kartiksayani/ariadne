// The Projects page (SPEC 5.14): one card per project with its sessions, a "…" for the page (Register a project, Discover
// sessions) and one per card (Remove project). Pure props in, callbacks out (contract C8).
import { useRef, useState } from 'react';
import { PopMenu, RunDot, WaitPill, usePopover, type PopItem } from '../parts/parts';
import { PageColumn, PageHead } from './PageHead';
import type { PageSession, ProjectCardData, ProjectsCardsProps } from './page-types';
import './projects.css';

/** How many session rows a card shows at once; this is the height of every card (projects.css `.pj-sessions`). Keep the two in step. */
const VISIBLE_SESSIONS = 5;

const plural =(count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Which "…" is open: the page's, or a project's. */
type Open = { readonly kind: 'page' } | { readonly kind: 'project'; readonly id: string } | null;

function SessionRow<R>({ session, onOpen }: { readonly session: PageSession<R>; readonly onOpen: () => void }) {
  return <button type="button" className="pj-sess" data-testid="project-session" onClick={onOpen}>
    <RunDot run={session.run} />
    <span className={session.run === 'closed' ? 'pj-sess-name pj-sess-closed' : 'pj-sess-name'}>{session.name}</span>
    <span className="pj-sess-meta">{session.run === 'closed' ? 'closed' : session.agent}</span>
    {session.waiting > 0 && <span className="pj-sess-wait" role="img" aria-label={`${plural(session.waiting, 'question')} waiting on you`}><i className="ph-fill ph-question" aria-hidden="true" />{session.waiting}</span>}
  </button>;
}

export function ProjectsCards<R>({ back, sub, projects, onOpenProject, onOpenSession, onRegister, onDiscover, onRemoveProject }: ProjectsCardsProps<R>) {
  const [open, setOpen] = useState<Open>(null), [keyboard, setKeyboard] = useState(false);
  const menu = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>());
  const key = (value: Open) => value === null ? '' : value.kind === 'page' ? 'page' : value.id;
  const close = (restore: boolean) => {
    const was = open;
    setOpen(null);
    if (restore && was) buttons.current.get(key(was))?.focus();
  };
  usePopover(open !== null, close, menu, '[data-popover-trigger="pages-menu"]');
  const toggle = (value: Exclude<Open, null>, event: { readonly detail: number }) => {
    setKeyboard(event.detail === 0);
    setOpen(current => current !== null && key(current) === key(value) ? null : value);
  };
  const pageItems: PopItem[] = [
    { key: 'register', icon: 'ph ph-plus', label: 'Register a project…', sub: 'Pick a folder; Ariadne watches it for agent sessions', onSelect: onRegister },
    { key: 'discover', icon: 'ph ph-magnifying-glass', label: 'Discover sessions', sub: 'Look again for agent sessions in every project folder', onSelect: onDiscover },
  ];
  return <PageColumn label="Projects">
    <PageHead back={back} title="Projects" sub={sub}>
      <span className="pp-menu-anchor">
        <button type="button" className="pp-more" data-popover-trigger="pages-menu" title="Register a project, discover sessions" aria-label="Register a project, discover sessions" aria-haspopup="menu"
          aria-expanded={open?.kind === 'page'} data-active={open?.kind === 'page' || undefined} ref={element => { if (element) buttons.current.set('page', element); else buttons.current.delete('page'); }}
          onClick={event => toggle({ kind: 'page' }, event)}><i className="ph ph-dots-three" aria-hidden="true" /></button>
        {open?.kind === 'page' && <PopMenu menuRef={menu} items={pageItems} label="Projects" className="pp-menu" focusFirst={keyboard} onClose={close} />}
      </span>
    </PageHead>
    <div className="pj-grid">
      {projects.map((project: ProjectCardData<R>) => {
        const mine = open?.kind === 'project' && open.id === project.id;
        return <article key={project.id} className={project.current ? 'pj-card pj-current' : 'pj-card'} data-testid="project-card"
          onClick={event => { if (event.target instanceof Element && !event.target.closest('button, [role="menu"]')) onOpenProject(project); }}>
          <div className="pj-top">
            <i className="ph ph-folder-simple pj-folder" aria-hidden="true" />
            <div className="pj-id">
              <button type="button" className="pj-name" onClick={() => onOpenProject(project)}>{project.name}</button>
              <span className="pj-path">{project.path}</span>
            </div>
            {project.current && <span className="pp-tag">Current</span>}
            {project.waiting > 0 && <WaitPill count={project.waiting} label={`${plural(project.waiting, 'question')} waiting on you`} />}
            <span className="pj-more-anchor">
              <button type="button" className="pj-more" data-popover-trigger="pages-menu" title="Remove project" aria-label={`More for ${project.name}: remove project`} aria-haspopup="menu" aria-expanded={mine}
                data-active={mine || undefined} ref={element => { if (element) buttons.current.set(project.id, element); else buttons.current.delete(project.id); }}
                onClick={event => toggle({ kind: 'project', id: project.id }, event)}><i className="ph ph-dots-three" aria-hidden="true" /></button>
              {mine && <PopMenu menuRef={menu} className="pj-menu" label={`${project.name} menu`} focusFirst={keyboard} onClose={close}
                items={[{ key: 'remove', icon: 'ph ph-trash', label: 'Remove project…', sub: 'Ariadne forgets it; its files aren’t touched', danger: true, onSelect: () => onRemoveProject(project) }]} />}
            </span>
          </div>
          {/* The list shows five rows; a longer one scrolls inside the card, newest first as the caller ordered it. */}
          <div className="pj-sessions" data-testid="project-sessions" data-scrolls={project.sessions.length > VISIBLE_SESSIONS || undefined}>
            {project.sessions.map((session, index) => <SessionRow key={`${index}:${session.name}`} session={session} onOpen={() => onOpenSession(project, session)} />)}
            {project.sessions.length === 0 && project.emptyText && <div className="pj-none">{project.emptyText}</div>}
          </div>
          <div className="pj-foot" data-testid="project-footer" title={project.footer}>{project.footer}</div>
        </article>;
      })}
    </div>
    <p className="pp-foot">A project appears when an agent session starts in its folder. Removing a project from Ariadne never touches its files.</p>
  </PageColumn>;
}
