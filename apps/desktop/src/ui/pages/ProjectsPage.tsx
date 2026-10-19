// The Projects page (SPEC 5.14): a card per registered folder with its sessions; Register a project and Discover
// sessions behind the page's "…", Remove project behind each card's.
import { useEffect, useState, type ReactNode } from 'react';
import type { Immutable } from '../../data/session-store';
import type { SessionRef } from '../../generated/core';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import type { DiscoveryController } from '../../data/discovery';
import { CandidateList } from '../../components/navigation/Discovery';
import { Dialog } from '../dialogs/Dialog';
import { RemoveProjectDialog } from '../dialogs/RemoveProjectDialog';
import type { RemoveHandler, RemoveSubject } from '../dialogs/remove';
import type { WholeTarget, WordsRead } from '../remove/words';
import { projectName, projectRemoval, sessionKey } from './model';
import { ProjectsCards } from './ProjectsCards';
import type { PageBack } from './page-types';
import { projectCardData } from '../../components/navigation/pageData';
import './pages.css';

export interface ProjectsPageProps {
  readonly projects: readonly Immutable<ProjectSummary>[];
  readonly sessions: readonly Immutable<SessionSummary>[];
  readonly snapshots: ReadonlyMap<string, Immutable<Session>>;
  readonly now: number;
  readonly currentSession?: SessionRef | null;
  readonly back?: PageBack;
  /** While navigation saves, opening, registering and removing wait. */
  readonly disabled?: boolean;
  /** Opening a project or a session waits only for a Refresh or the first load, not for an owner write; it queues behind the write. */
  readonly navigationDisabled?: boolean;
  readonly discovery?: DiscoveryController;
  readonly onOpen: (projectId: string) => void;
  readonly onOpenSession: (route: SessionRef) => void;
  readonly onRegister: (root: string) => void;
  readonly onRemove: RemoveHandler;
  /** The words a project removal deletes, read fresh from every session of it (E27). */
  readonly onReadWords: (target: WholeTarget) => Promise<WordsRead>;
  /** Under the cards: loading, empty and catalogue notes. */
  readonly children?: ReactNode;
}

function Discover({ controller, register, sessions }: { controller: DiscoveryController; register: (root: string) => void; sessions: readonly Immutable<SessionSummary>[] }) {
  useEffect(() => controller.acquire(), [controller]);
  return <section className="pw-discover" aria-label="Discover host sessions"><CandidateList controller={controller} sessions={sessions} select={candidate => register(candidate.cwd)} /></section>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function ProjectsPage({ projects, sessions, snapshots, now, currentSession, back, disabled = false, navigationDisabled = disabled, discovery, onOpen, onOpenSession, onRegister, onRemove, onReadWords, children }: ProjectsPageProps) {
  const unless = <A extends unknown[]>(run: (...args: A) => void) => (...args: A) => { if (!disabled) run(...args); };
  const unlessNavigating = <A extends unknown[]>(run: (...args: A) => void) => (...args: A) => { if (!navigationDisabled) run(...args); };
  const [removing, setRemoving] = useState<{ id: string; subject: Extract<RemoveSubject, { kind: 'project' }>; words: WordsRead | null } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const cards = projects.map(project => projectCardData(project, sessions, now, currentSession));
  const waiting = cards.reduce((sum, card) => sum + card.waiting, 0);
  const remove = (id: string) => {
    const project = projects.find(value => value.project_id === id);
    if (!project) return;
    const own = sessions.filter(session => session.project_id === id);
    const counts = projectRemoval(own.flatMap(session => snapshots.get(sessionKey(session)) ?? []));
    const subject = { kind: 'project', name: projectName(project), path: project.canonical_root, sessions: own.length, ...counts } as const;
    setRemoving({ id, subject, words: null });
    // Core deletes every session of the project: their words are read fresh and quoted before Remove can run (E27).
    void onReadWords({ kind: 'project', project_id: id }).then(words => { setRemoving(current => current?.subject === subject ? { ...current, words } : current); });
  };
  return <>
    <ProjectsCards<SessionRef> back={back} sub={`${plural(projects.length, 'project')} · ${plural(waiting, 'question')} waiting on you`} projects={cards}
      onOpenProject={unlessNavigating(card => onOpen(card.id))} onOpenSession={unlessNavigating((_card, session) => onOpenSession(session.route))}
      onRegister={unless(() => onRegister(''))} onDiscover={unless(() => { if (discovery) setDiscovering(true); })} onRemoveProject={unless(card => remove(card.id))} />
    {children}
    {discovering && discovery && <Dialog label="Discover sessions" width={620} onCancel={() => setDiscovering(false)}>
      <div className="dialog-title">Discover sessions</div><Discover controller={discovery} register={root => { setDiscovering(false); onRegister(root); }} sessions={sessions} />
      <div className="dialog-actions"><button type="button" className="btn btn-ghost" onClick={() => setDiscovering(false)}>Done</button></div>
    </Dialog>}
    {removing && <RemoveProjectDialog name={removing.subject.name} path={removing.subject.path} sessionCount={removing.subject.sessions} waitingCount={removing.subject.waiting} words={removing.words}
      onCancel={() => setRemoving(null)} onRemove={() => { const { id, subject } = removing; setRemoving(null); onRemove({ kind: 'project', project_id: id }, subject); }} />}
  </>;
}
