// Projects (frames 1ab, 1p), ported from Ariadne.dc.html:201-223.
import { useEffect, useState, type ReactNode } from 'react';
import type { Immutable } from '../../data/session-store';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import type { DiscoveryController } from '../../data/discovery';
import { CandidateList } from '../../components/navigation/Discovery';
import { RemoveDialog } from '../dialogs/RemoveDialog';
import type { RemoveHandler, RemoveSubject } from '../dialogs/remove';
import { projectCard, projectRemoval, sessionKey } from './model';
import './pages.css';

export interface ProjectsPageProps {
  readonly projects: readonly Immutable<ProjectSummary>[];
  readonly sessions: readonly Immutable<SessionSummary>[];
  readonly snapshots: ReadonlyMap<string, Immutable<Session>>;
  readonly now: number;
  /** First launch: Ariadne found the projects itself (frame 1p). */
  readonly discovered: boolean;
  readonly disabled: boolean;
  readonly discovery?: DiscoveryController;
  readonly onOpen: (projectId: string) => void;
  readonly onRegister: (root: string) => void;
  readonly onRemove: RemoveHandler;
  /** Shown under the grid: loading, empty and catalogue notes. */
  readonly children?: ReactNode;
}

function Discover({ controller, register }: { controller: DiscoveryController; register: (root: string) => void }) {
  useEffect(() => controller.acquire(), [controller]);
  return <section className="pw-discover" aria-label="Discover host sessions"><CandidateList controller={controller} select={candidate => register(candidate.cwd)} /></section>;
}

export function ProjectsPage({ projects, sessions, snapshots, now, discovered, disabled, discovery, onOpen, onRegister, onRemove, children }: ProjectsPageProps) {
  const [removing, setRemoving] = useState<{ id: string; subject: RemoveSubject } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const remove = (project: Immutable<ProjectSummary>, name: string) => {
    const own = sessions.filter(session => session.project_id === project.project_id);
    const counts = projectRemoval(own.flatMap(session => snapshots.get(sessionKey(session)) ?? []));
    setRemoving({ id: project.project_id, subject: { kind: 'project', name, path: project.canonical_root, sessions: own.length, ...counts } });
  };
  return <div className="pw-page pw-projects">
    <div className="pw-page-title">
      <h1 className="pw-page-name">Projects</h1>
      <span className="pw-page-sub">{`${projects.length} folder${projects.length === 1 ? '' : 's'} with claude-code or codex sessions · found automatically`}</span>
    </div>
    {discovered && <div className="pw-discover-note"><i className="ph ph-magnifying-glass" aria-hidden="true" />
      <span>Ariadne found these projects in your claude-code and codex session folders. Open one to see its sessions.</span></div>}
    {projects.length > 0 && <div className="pw-project-grid">
      {projects.map(project => {
        const card = projectCard(project, sessions, now);
        return <div key={card.id} className="pw-project-card" style={{ boxShadow: card.ring }} data-project-id={card.id}
          onClick={() => { if (!disabled) onOpen(card.id); }}>
          <div className="pw-project-head">
            <i className="ph ph-folder-simple pw-project-icon" aria-hidden="true" />
            <button type="button" className="pw-project-remove" title="Remove project" aria-label="Remove project"
              onClick={event => { event.stopPropagation(); remove(project, card.name); }}>
              <i className="ph ph-trash" aria-hidden="true" /></button>
            <button type="button" className="pw-project-open" disabled={disabled} onClick={event => { event.stopPropagation(); onOpen(card.id); }}>
              <span className="pw-project-name">{card.name}</span><span className="pw-project-path">{card.path}</span></button>
          </div>
          <div className="pw-project-facts">
            <span><i className="ph ph-chats-teardrop pw-fact-icon" aria-hidden="true" />{card.sessionsText}</span>
            <span style={{ color: card.runColor }}><span className="pw-dot pw-dot-8" style={{ background: card.runDot, boxShadow: card.runRing }} />{card.runText}</span>
            <span style={{ color: card.waitColor }}><i className="ph-fill ph-question" aria-hidden="true" />{card.waitText}</span>
            <span><i className="ph ph-clock pw-fact-icon" aria-hidden="true" />{card.last}</span>
          </div>
          {card.agents.length > 0 && <div className="pw-project-agents">{card.agents.map(agent => <span key={agent} className="pw-agent-chip">
            <i className="ph ph-terminal-window" aria-hidden="true" />{agent}</span>)}</div>}
        </div>;
      })}
    </div>}
    {/* Not in the handoff: registering and discovery sit under the grid so the frame keeps its layout. */}
    <div className="pw-page-tools">
      <button type="button" className="btn btn-ghost pw-small" disabled={disabled} onClick={() => onRegister('')}>
        <i className="ph ph-plus" aria-hidden="true" />Register project</button>
      {discovery && <button type="button" className="btn btn-ghost pw-small" aria-expanded={discovering} onClick={() => setDiscovering(value => !value)}>
        <i className="ph ph-magnifying-glass" aria-hidden="true" />Discover host sessions</button>}
    </div>
    {children}
    {discovering && discovery && <Discover controller={discovery} register={onRegister} />}
    {removing && <RemoveDialog subject={removing.subject} onCancel={() => setRemoving(null)}
      onConfirm={() => onRemove({ kind: 'project', project_id: removing.id }, removing.subject)} />}
  </div>;
}
