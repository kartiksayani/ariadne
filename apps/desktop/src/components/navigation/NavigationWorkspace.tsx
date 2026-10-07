import { useEffect, useState, type ReactNode } from 'react';
import type { AdapterConfig, ProjectSummary, SessionSummary, SummaryCounts } from '../../generated/domain/models';
import type { NavigationSelection, SessionPreferences, SessionRef } from '../../generated/core';
import { CoreFailure } from '../../data/service';
import { useSession, type Immutable, type SessionStore } from '../../data/session-store';
import { NavigationStore, useNavigation, type NavigationState } from '../../state/navigation/store';
import { ProjectCard, SessionCard } from '../reference/ProjectSessionCard';
import { GlobalWaitingPanel, type GlobalWaitingPanelProps } from '../reference/GlobalWaitingPanel';
import { RegisterProject, BindSession } from './Registration';
import { DiscoverProjects } from './Discovery';
import type { DiscoveryController } from '../../data/discovery';
import { Shell } from '../../ui/shell/Shell';
import type { HeaderProps } from '../../ui/shell/Header';
import { agentName, footerSummary, headerText, tabModels, type HeaderInput, type SessionFacts } from '../../ui/shell/model';
import '../../styles/navigation.css';

export interface AdapterChoice { readonly adapter_id: string; readonly label: string; readonly configuration: AdapterConfig;
  /** Socket path prefilled in the connect dialog for this adapter, when the app knows one. */
  readonly default_socket_path?: string }
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
  /** Header controls owned by the composition: search, views, rail and theme. */
  readonly chrome?: Omit<HeaderProps, 'text' | 'disabled'>;
  /** Facts for the selected session tab's header; null while it opens. */
  readonly session?: SessionFacts | null;
  readonly onCloseDetail?: () => void;
  readonly onRemove?: () => void;
  /** Clock for relative times; tests pin it. */
  readonly now?: () => number;
  readonly adapterChoices: readonly AdapterChoice[];
  readonly renderSession: (view: OpenedSessionView) => ReactNode;
}
const text = 'var(--color-text)';
const muted = 'color-mix(in srgb, var(--color-text) 62%, transparent)';
const accent = 'var(--color-accent)';
const key = (route: SessionRef) => JSON.stringify([route.project_id, route.session_id]);
const projectName = (project: Immutable<ProjectSummary>) => project.project?.display_name ?? 'Unavailable project';
const partial = (counts: Immutable<SummaryCounts>) => counts.completeness === 'partial';
const running = (session: Immutable<SessionSummary>) => session.state === 'active' && session.active_binding?.connection_state === 'connected';
const defaultChrome: Omit<HeaderProps, 'text' | 'disabled'> ={ query: '', views: null, railOn: false, theme: 'dark' };

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

/** Saved binding-connect receipt: what to give the host, plus capabilities the owner cannot rely on. */
function SetupCard({ setup, adapterId }: { setup: NonNullable<NavigationState['setup']>; adapterId: string | null }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return undefined;
    const timer = setTimeout(() => setCopied('idle'), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (setup.data.kind !== 'binding_connect') return null;
  const instruction = setup.data.setup_instruction;
  const unavailable = Object.entries(setup.data.capabilities)
    .filter(([, value]) => typeof value === 'object' && !value.supported).map(([name]) => name.replace(/_/g, ' '));
  const copy = () => {
    try {
      void navigator.clipboard.writeText(instruction).then(() => setCopied('copied'), () => setCopied('failed'));
    } catch {
      setCopied('failed');
    }
  };
  return <section className="nav-banner" aria-label="Session setup"><h2>Session connected</h2>
    <p>Connecting sent nothing to the model. {adapterId === 'codex'
      ? 'Paste this setup instruction into the selected Codex thread once per binding so the agent has the Ariadne rules. Installation also adds an Ariadne skill for Codex unless its link was skipped.'
      : adapterId === 'claude_code_mod'
        ? 'Run /ariadne-connect in the selected Claude conversation. Nothing to paste: the Mod reports the binding and the installed Ariadne skill holds the rules.'
        : 'Paste this setup instruction into the selected host conversation once per binding so the agent has the Ariadne rules.'}</p>
    {adapterId !== 'claude_code_mod' && <>
      <button type="button" className="ref-button ref-secondary" onClick={copy}>Copy instruction</button>
      <span role="status" className="nav-copied">{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : ''}</span>
      <pre>{instruction}</pre></>}
    <p>Session {setup.session_id}</p>
    {unavailable.length > 0 && <p>Unavailable capabilities: {unavailable.join(', ')}.</p>}
  </section>;
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

export function NavigationWorkspace({ store, discovery, waiting, waitingContent, detail, railContent, chrome, session, onCloseDetail, onRemove, now = Date.now, adapterChoices, renderSession }: NavigationWorkspaceProps) {
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
  const openViews: readonly Immutable<SessionPreferences>[] = state.preferences?.sessions.filter(view => view.tab_open)
    .sort((a, b) => a.tab_order - b.tab_order || key(a.session).localeCompare(key(b.session))) ?? [];
  const projectNameOf = (projectId: string) => { const project = projects.find(value => value.project_id === projectId); return project ? projectName(project) : 'Unavailable project'; };
  const at = now();
  const tabs = tabModels({ selection: selection.kind === 'project' ? 'projects' : selection.kind, projectCount: projects.length,
    sessions: openViews.map(view => {
      const summary = sessions.find(value => key(value) === key(view.session));
      return { id: key(view.session), project: projectNameOf(view.session.project_id), agent: summary?.active_binding ? agentName(summary.active_binding.adapter_id) : null,
        createdAt: summary ? Date.parse(summary.created_at) : null, endedAt: summary ? Date.parse(summary.closed_at ?? summary.updated_at) : null, running: summary ? running(summary) : false,
        on: selection.kind === 'session' && key(selection.session) === key(view.session) };
    }) }, at);
  const selectTab = (id: string) => {
    if (id === 'projects' || id === 'all_sessions') { select({ kind: id }); return; }
    const view = openViews.find(value => key(value.session) === id);
    if (view) select({ kind: 'session', session: view.session });
  };
  const closeTab = (id: string) => { const view = openViews.find(value => key(value.session) === id); if (view) void store.closeTab(view.session); };
  const headerInput: HeaderInput = selection.kind === 'all_sessions'
    ? { kind: 'all_sessions', openTabs: openViews.length, openProjects: new Set(openViews.map(view => view.session.project_id)).size }
    : selection.kind === 'session' ? { kind: 'session', facts: session ?? null, fallbackAgent: selectedSession?.active_binding ? agentName(selectedSession.active_binding.adapter_id) : null }
      : { kind: 'projects', projectCount: projects.length, runningAgents: sessions.filter(running).length, projectPath: selectedProject?.canonical_root ?? null };
  const global = state.projects?.counts;
  const showSessions = selection.kind === 'all_sessions' || selection.kind === 'project';
  const groups = selection.kind === 'project' ? selectedProject ? [selectedProject] : [] : projects;
  const sessionCard = (session: Immutable<SessionSummary>) => <SessionCard key={key(session)} title={session.title}
    meta={`${session.active_binding?.adapter_id ?? 'No binding'} · updated ${session.updated_at} · ${countsText(session.counts)}`}
    titleColor={text} background="var(--color-surface)" run={bindingLabel(session)} runColor={muted} runDot="currentColor" runRing="none"
    topics={[]} actions={[{ label: 'Open', icon: 'ph ph-arrow-square-out', kind: 'secondary',
      disabled, sessionId: session.session_id, onClick: () => select({ kind: 'session', session: { project_id: session.project_id, session_id: session.session_id } }) }]} />;
  const counts = selection.kind === 'projects' ? state.projects?.counts : matchingSessions?.counts;
  // The connect card sits directly under the project header; other views keep it at the end.
  const setupCard = state.setup?.data.kind === 'binding_connect' ? <SetupCard setup={state.setup} adapterId={state.setupAdapterId} /> : null;
  const setupInGroup = selection.kind === 'project' && groups.length === 1;
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
        {setupInGroup && setupCard}
        {project.availability === 'unavailable' && <p className="nav-banner">This registered project is unavailable. Check local access and refresh.</p>}
        <h3>Active</h3>{sessions.filter(session => session.project_id === project.project_id && session.state === 'active').map(sessionCard)}
        <h3>Closed</h3>{sessions.filter(session => session.project_id === project.project_id && session.state === 'closed').map(sessionCard)}
      </section>)}
    </>}
    {!setupInGroup && setupCard}
  </div>;
  return <Shell header={{ ...defaultChrome,...chrome, text: headerText(headerInput, at), disabled }}
    tabs={{ tabs, disabled, onSelect: selectTab, onClose: closeTab }}
    body={{ waiting: waitingContent ?? <GlobalWaitingPanel {...(waiting ?? { count: '—', emptyText: 'Reading registered sessions…', waiting: [], sent: [] })} />,
      center, detail, rail: railContent, onCloseDetail, onRemove }}
    summary={footerSummary(global ? { items: Object.values(global.items_by_status).reduce((sum, count) => sum + count, 0), waiting: global.waiting_unanswered,
      inProgress: global.items_by_status.in_progress, open: global.items_by_status.open, archivedTopics: global.archived_topics } : null)} overlay={registering
      ? <RegisterProject store={store} initialRoot={registrationRoot} disabled={mutationDisabled} close={() => setRegistering(false)} />
      : binding ? <BindSession store={store} project={binding} sessions={sessions.filter(session => session.project_id === binding.project_id)}
        adapters={adapterChoices} discovery={discovery} disabled={mutationDisabled} close={() => setBinding(null)} /> : undefined} />;
}
