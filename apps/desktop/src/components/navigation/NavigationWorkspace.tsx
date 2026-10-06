import { useEffect, useState, type ReactNode } from 'react';
import type { AdapterConfig, ProjectSummary, SessionSummary, SummaryCounts } from '../../generated/domain/models';
import type { NavigationSelection, SessionPreferences, SessionRef } from '../../generated/core';
import { CoreFailure } from '../../data/service';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import { NavigationStore, useNavigation, type NavigationState } from '../../state/navigation/store';
import { ProjectCard, SessionCard } from '../reference/ProjectSessionCard';
import { ReferenceWorkspace, type ReferenceWorkspaceProps } from '../reference/ReferenceWorkspace';
import type { GlobalWaitingPanelProps } from '../reference/GlobalWaitingPanel';
import { RegisterProject, BindSession } from './Registration';
import { DiscoverProjects } from './Discovery';
import type { DiscoveryController } from '../../data/discovery';
import '../../styles/navigation.css';

export interface AdapterChoice { readonly adapter_id: string; readonly label: string; readonly configuration: AdapterConfig }
export interface OpenedSessionView {
  readonly store: SessionStore;
  readonly preferences: Immutable<SessionPreferences> | null;
  readonly temporaryExpandedItemIds: readonly string[];
  readonly missingItemBanner: string | null;
}
export interface NavigationWorkspaceProps {
  readonly store: NavigationStore;
  readonly discovery?: DiscoveryController;
  readonly waiting?: GlobalWaitingPanelProps;
  readonly waitingContent?: ReactNode;
  readonly detail?: ReactNode;
  readonly railContent?: ReactNode;
  readonly chrome?: Pick<ReferenceWorkspaceProps['header'], 'query' | 'views' | 'railColor' | 'themeIcon' | 'themeTitle'>;
  readonly context?: { readonly session: string; readonly binding: string };
  readonly onQueryChange?: (query: string) => void;
  readonly onToggleRail?: () => void;
  readonly onThemeChange?: () => void;
  readonly onCloseDetail?: () => void;
  readonly adapterChoices: readonly AdapterChoice[];
  readonly renderSession: (view: OpenedSessionView) => ReactNode;
}
const text = 'var(--color-text)';
const muted = 'color-mix(in srgb, var(--color-text) 62%, transparent)';
const accent = 'var(--color-accent)';
const key = (route: SessionRef) => JSON.stringify([route.project_id, route.session_id]);
const projectName = (project: Immutable<ProjectSummary>) => project.project?.display_name ?? 'Unavailable project';
const partial = (counts: Immutable<SummaryCounts>) => counts.completeness === 'partial';

export function bindingLabel(session: Immutable<SessionSummary>): string {
  if (session.state === 'closed') return 'Closed';
  const binding = session.active_binding;
  if (!binding) return 'Unbound';
  if (binding.owner_paused) return 'Bound · owner paused';
  if (binding.dispatch_state === 'recovery_required') return 'Bound · recovery required';
  if (binding.connection_state === 'disconnected') return 'Bound · host unavailable';
  const presence = binding.presence;
  if (!presence || presence.generation !== binding.generation || presence.freshness !== 'fresh'
      || presence.connection_state !== 'connected') return 'Bound · execution unknown';
  if (presence.execution_state === 'running') return 'Bound · running';
  if (presence.execution_state === 'waiting_for_approval') return 'Bound · waiting for approval';
  if (presence.execution_state === 'idle') return 'Bound · idle';
  return 'Bound · execution unknown';
}

function countsText(counts: Immutable<SummaryCounts>): string {
  return `${counts.waiting_unanswered} waiting · ${counts.sent_inputs.queued} queued · ${counts.sent_inputs.in_flight} in flight · ${counts.sent_inputs.needs_attention} need attention${partial(counts) ? ' · incomplete' : ''}`;
}

function SelectedSession({ navigation, renderSession }: { navigation: NavigationStore; renderSession: NavigationWorkspaceProps['renderSession'] }) {
  const state = useNavigation(navigation);
  const selected = state.preferences?.global.selected_navigation;
  const store = navigation.selectedSession();
  if (!store || selected?.kind !== 'session') return null;
  return <SessionView key={key(selected.session)} navigation={state} store={store} renderSession={renderSession} />;
}
function SessionView({ navigation, store, renderSession }: { navigation: NavigationState; store: SessionStore; renderSession: NavigationWorkspaceProps['renderSession'] }) {
  const session = useSession(store);
  const preferences = navigation.preferences?.sessions.find(view => key(view.session) === key(session.route)) ?? null;
  const reveal = navigation.reveal;
  const matchingReveal = reveal?.store === store ? reveal : null;
  return <>
    {session.status === 'loading' && <p role="status">Loading session…</p>}
    {session.error && <p role="alert">{session.error.message}</p>}
    {session.snapshot?.session.state === 'closed' && <p className="nav-banner">Closed session · opening this tab does not resume dispatch.</p>}
    {matchingReveal?.kind === 'missing_item' && <p className="nav-banner" role="status">{matchingReveal.banner}</p>}
    {renderSession({ store, preferences, temporaryExpandedItemIds: matchingReveal?.kind === 'item' ? matchingReveal.temporaryExpandedItemIds : [],
      missingItemBanner: matchingReveal?.kind === 'missing_item' ? matchingReveal.banner : null })}
  </>;
}

export function NavigationWorkspace({ store, discovery, waiting, waitingContent, detail, railContent, chrome, context, onQueryChange, onToggleRail, onThemeChange, onCloseDetail, adapterChoices, renderSession }: NavigationWorkspaceProps) {
  const state = useNavigation(store);
  const [registering, setRegistering] = useState(false);
  const [registrationRoot, setRegistrationRoot] = useState('');
  const [binding, setBinding] = useState<Immutable<ProjectSummary> | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  // The composition that owns this injected store disposes it. A view mount
  // must not permanently stop a shared store during React's effect replay.
  useEffect(() => { void store.start(); }, [store]);
  const selection: Immutable<NavigationSelection> = state.preferences?.global.selected_navigation ?? { kind: 'projects' };
  const projects = state.projects?.projects.items ?? [];
  const projectId = selection.kind === 'project' ? selection.project_id : null;
  const matchingSessions = state.sessionProjectId === projectId ? state.sessions : null;
  const sessions = matchingSessions?.sessions.items ?? [];
  const selectedProject = selection.kind === 'project' ? projects.find(project => project.project_id === selection.project_id) : null;
  const selectedSession = selection.kind === 'session' ? sessions.find(session => key(session) === key(selection.session)) : null;
  const mutationDisabled = refreshPending || state.writing || state.pendingOperationId !== null;
  const disabled = mutationDisabled || !state.preferences;
  const refresh = async () => {
    if (refreshPending) return;
    setRefreshPending(true);
    try { await store.refresh(); }
    finally { setRefreshPending(false); }
  };
  const select = (next: NavigationSelection) => { void store.navigate(next); };
  const tab = (id: string, label: string, selected: boolean, onSelect: () => void,
    session?: Immutable<SessionPreferences>): ReferenceWorkspaceProps['tabs'][number] => ({
    id, title: label, label, sub: '', icon: session ? 'ph ph-terminal-window' : 'ph ph-folders', iconSize: '15px',
    iconColor: selected ? accent : muted, color: selected ? text : muted, background: selected ? 'var(--color-surface)' : 'transparent',
    bar: selected ? accent : 'transparent', closable: !!session, selected, disabled, onSelect,
    onClose: session ? () => { void store.closeTab(session.session); } : undefined,
  });
  const tabs = [tab('projects', 'Projects', selection.kind === 'projects' || selection.kind === 'project', () => select({ kind: 'projects' })),
    tab('all_sessions', 'All sessions', selection.kind === 'all_sessions', () => select({ kind: 'all_sessions' })),
    ...(state.preferences?.sessions.filter(view => view.tab_open).sort((a, b) => a.tab_order - b.tab_order || key(a.session).localeCompare(key(b.session))) ?? []).map(view => {
      const session = sessions.find(session => key(session) === key(view.session));
      return tab(key(view.session), session?.title ?? `Session ${view.session.session_id}`, selection.kind === 'session' && key(selection.session) === key(view.session),
        () => select({ kind: 'session', session: view.session }), view);
    })];
  const showSessions = selection.kind === 'all_sessions' || selection.kind === 'project';
  const groups = selection.kind === 'project' ? selectedProject ? [selectedProject] : [] : projects;
  const sessionCard = (session: Immutable<SessionSummary>) => <SessionCard key={key(session)} title={session.title}
    meta={`${session.active_binding?.adapter_id ?? 'No binding'} · updated ${session.updated_at} · ${countsText(session.counts)}`}
    titleColor={text} background="var(--color-surface)" run={bindingLabel(session)} runColor={muted} runDot="currentColor" runRing="none"
    topics={[]} actions={[{ label: 'Open', icon: 'ph ph-arrow-square-out', kind: 'secondary',
      disabled, sessionId: session.session_id, onClick: () => select({ kind: 'session', session: { project_id: session.project_id, session_id: session.session_id } }) }]} />;
  const counts = selection.kind === 'projects' ? state.projects?.counts : matchingSessions?.counts;
  const center = <div className={`nav-content${selection.kind === 'session' ? ' nav-session-content' : ''}`}>
    {state.error && <div className="nav-banner" role="alert"><p>{state.error.message}</p>
      {state.error instanceof CoreFailure && <p>{state.error.error.hint}</p>}
      {state.pendingOperationId ? <><p>Completion is unknown. Reconcile operation {state.pendingOperationId} with its original request.</p>
        <button type="button" className="ref-button ref-secondary" disabled={state.writing} onClick={() => { void store.retryMutation(); }}>Reconcile operation</button></>
        : <button type="button" className="ref-button ref-secondary" disabled={mutationDisabled} onClick={() => { void refresh(); }}>{refreshPending ? 'Refreshing…' : 'Refresh'}</button>}
    </div>}
    {state.status === 'loading' && <p role="status">Loading registered projects and sessions…</p>}
    {state.status === 'stale' && <p className="nav-banner" role="status">Showing the last complete catalogue. Refresh failed.</p>}
    {counts && partial(counts) && <div className="nav-banner" role="status">Counts are incomplete. Unavailable sessions: {counts.unavailable_session_ids.join(', ') || 'not individually identified'}.</div>}
    {selection.kind === 'session' ? <SelectedSession navigation={store} renderSession={renderSession} /> : <>
      <div className="ref-page-heading"><div><h1>{selection.kind === 'projects' ? 'Projects' : selection.kind === 'all_sessions' ? 'All sessions' : selectedProject ? projectName(selectedProject) : 'Unavailable project'}</h1>
        <p>{selection.kind === 'projects' ? 'Register a local root, then explicitly connect an existing host session.' : selection.kind === 'project' ? selectedProject?.canonical_root : 'Registered sessions, grouped by project.'}</p></div>
        <button type="button" className="ref-button ref-secondary" disabled={mutationDisabled} onClick={() => { setRegistrationRoot(''); setRegistering(true); }}>Register project</button>
      </div>
      {counts && <p className="nav-counts">{countsText(counts)}</p>}
      {discovery && <DiscoverProjects controller={discovery} visible={selection.kind === 'projects'} register={root => { setRegistrationRoot(root); setRegistering(true); }} />}
      {showSessions && matchingSessions && <p className="nav-counts">{matchingSessions.active_total} active · {matchingSessions.closed_total} closed</p>}
      {showSessions && !matchingSessions && <p role="status">{state.error ? 'Sessions are unavailable for this view.' : 'Loading sessions…'}</p>}
      {selection.kind === 'projects' && <div className="ref-project-grid">{projects.map(project => <ProjectCard key={project.project_id}
        name={projectName(project)} path={project.canonical_root} sessionsText={`${Object.values(project.counts.items_by_status).reduce((sum, count) => sum + count, 0)} items`}
        runText={project.availability === 'available' ? 'Registered' : 'Unavailable'} runColor={muted} runDot="currentColor" runRing="none"
        waitText={`${project.counts.waiting_unanswered} waiting`} waitColor={accent} last="Registered root" agents={[]} ring="none"
        incomplete={partial(project.counts)} disabled={disabled} onOpen={() => select({ kind: 'project', project_id: project.project_id })} />)}</div>}
      {state.status === 'ready' && projects.length === 0 && <p className="nav-empty">No registered projects. Register a project to connect an existing session.</p>}
      {showSessions && groups.map(project => <section className="ref-session-group" key={project.project_id} aria-label={projectName(project)}>
        <div className="nav-group-heading"><div><h2>{projectName(project)}</h2><p>{project.canonical_root}</p></div>
          {selection.kind === 'project' && <button type="button" className="ref-button ref-primary" disabled={disabled || project.availability !== 'available' || adapterChoices.length === 0} onClick={() => setBinding(project)}>Connect existing session</button>}</div>
        {project.availability === 'unavailable' && <p className="nav-banner">This registered project is unavailable. Check local access and refresh.</p>}
        <h3>Active</h3>{sessions.filter(session => session.project_id === project.project_id && session.state === 'active').map(sessionCard)}
        <h3>Closed</h3>{sessions.filter(session => session.project_id === project.project_id && session.state === 'closed').map(sessionCard)}
      </section>)}
    </>}
    {state.setup?.data.kind === 'binding_connect' && <section className="nav-banner" aria-label="Session setup"><h2>Session connected</h2>
      <p>Connecting sent nothing to the model. {state.setupAdapterId === 'codex'
        ? 'Paste this setup instruction into the selected Codex thread once per binding so the agent has the Ariadne rules. Installation also adds an Ariadne skill for Codex unless its link was skipped.'
        : state.setupAdapterId === 'claude_code_mod'
          ? 'Run /ariadne-connect in the selected Claude conversation. Nothing to paste: the Mod reports the binding and the installed Ariadne skill holds the rules.'
          : 'Paste this setup instruction into the selected host conversation once per binding so the agent has the Ariadne rules.'}</p>
      {state.setupAdapterId !== 'claude_code_mod' && <pre>{state.setup.data.setup_instruction}</pre>}<p>Session {state.setup.session_id}</p>
      <ul>{Object.entries(state.setup.data.capabilities).filter(([, value]) => typeof value === 'object').map(([name, value]) =>
        typeof value === 'object' && <li key={name}>{name.replace(/_/g, ' ')}: {value.supported ? 'supported' : 'unavailable'}{value.conditions.length > 0 && ` · ${value.conditions.join('; ')}`}</li>)}</ul>
    </section>}
  </div>;
  return <ReferenceWorkspace header={{ session: context?.session ?? selectedSession?.title ?? (selection.kind === 'session' ? `Session ${selection.session.session_id}` : selectedProject ? projectName(selectedProject) : 'Projects'),
    binding: context?.binding ?? (selectedSession ? bindingLabel(selectedSession) : 'Registered navigation'), bindingColor: muted, bindingGlow: 'none',
    query: '', views: [], railColor: muted, themeIcon: 'ph ph-moon', themeTitle: 'Theme', ...chrome }} tabs={tabs} waiting={waiting ?? { count: '—', emptyText: 'Reading registered sessions…', waiting: [], sent: [] }} waitingContent={waitingContent} detail={detail} railContent={railContent}
    onQueryChange={onQueryChange} onToggleRail={onToggleRail} onThemeChange={onThemeChange} onCloseDetail={onCloseDetail} chromeDisabled={disabled}
    center={center} summary={counts ? countsText(counts) : 'Catalogue unavailable'} overlay={registering
      ? <RegisterProject store={store} initialRoot={registrationRoot} disabled={mutationDisabled} close={() => setRegistering(false)} />
      : binding ? <BindSession store={store} project={binding} sessions={sessions.filter(session => session.project_id === binding.project_id)}
        adapters={adapterChoices} discovery={discovery} disabled={mutationDisabled} close={() => setBinding(null)} /> : undefined} />;
}
