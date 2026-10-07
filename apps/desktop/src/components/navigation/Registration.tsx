import { useEffect, useState, type FormEvent } from 'react';
import type { EndpointRef, ProjectSummary, SessionSummary } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
import { CoreFailure } from '../../data/service';
import type { AdapterChoice } from './NavigationWorkspace';
import { Dialog } from '../../ui/dialogs/Dialog';
import { candidateIdentity, useDiscovery, type DiscoveryController } from '../../data/discovery';
import { CandidateList } from './Discovery';

function RegistrationFailure({ store }: { store: NavigationStore }) {
  const state = useNavigation(store);
  if (!state.error) return null;
  return <div className="nav-banner" role="alert"><p>{state.error.message}</p>
    {state.error instanceof CoreFailure && <p>{state.error.error.hint}</p>}
    {state.pendingOperationId && <button type="button" className="btn btn-secondary" disabled={state.writing}
      onClick={() => { void store.retryMutation(); }}>Reconcile operation</button>}
  </div>;
}

export function RegisterProject({ store, disabled, close, initialRoot = '' }: { store: NavigationStore; disabled: boolean; close: () => void; initialRoot?: string }) {
  const [root, setRoot] = useState(initialRoot);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await store.register(root)) close(); };
  return <Dialog label="Register project" width={520} onCancel={close}><div className="dialog-title">Register project</div><div className="nav-registration">
    <p>Choose the existing local project root.</p>
    <RegistrationFailure store={store} />
    <form onSubmit={event => { void submit(event); }}><fieldset disabled={disabled}><label>Project root<input required value={root} onChange={event => setRoot(event.target.value)} placeholder="/path/to/project" /></label>
      <div className="nav-dialog-actions"><button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
        <button type="submit" className="btn btn-primary">Register project</button></div></fieldset></form>
  </div></Dialog>;
}

export function BindSession({ store, project, sessions, adapters, disabled, close, discovery }: { store: NavigationStore; project: Immutable<ProjectSummary>;
  sessions: readonly Immutable<SessionSummary>[]; adapters: readonly AdapterChoice[]; disabled: boolean; close: () => void; discovery?: DiscoveryController }) {
  const [adapterId, setAdapterId] = useState(adapters[0]?.adapter_id ?? '');
  const [externalId, setExternalId] = useState('');
  const [kind, setKind] = useState<EndpointRef['kind']>('unix_socket');
  const defaultSocket = (id: string) => adapters.find(choice => choice.adapter_id === id)?.default_socket_path ?? '';
  const [endpoint, setEndpoint] = useState(() => defaultSocket(adapters[0]?.adapter_id ?? ''));
  const [existingSession, setExistingSession] = useState('');
  const [sessionChoice, setSessionChoice] = useState<'new' | 'existing'>('new');
  const [selected, setSelected] = useState<string | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const discoveryState = useDiscovery(discovery);
  useEffect(() => discovery?.acquire(), [discovery]);
  const candidate = discoveryState.snapshot?.candidates.find(value => candidateIdentity(value) === selected && value.cwd === project.canonical_root);
  const noLongerFresh = selected !== null && (!candidate || candidate.freshness !== 'fresh' || discoveryState.error !== null);
  useEffect(() => { if (noLongerFresh) setInvalidated(true); }, [noLongerFresh]);
  const invalidSelection = selected !== null && (invalidated || noLongerFresh);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (invalidSelection || disabled) return;
    const adapter = adapters.find(choice => choice.adapter_id === adapterId);
    if (!adapter) return;
    if (await store.bind({ project_id: project.project_id, adapter_id: adapter.adapter_id, external_session_id: externalId,
      endpoint: kind === 'unix_socket' ? { kind, path: endpoint } : { kind, name: endpoint }, configuration: structuredClone(adapter.configuration),
      existing_session_id: sessionChoice === 'existing' ? existingSession : null })) close();
  };
  return <Dialog label="Connect existing session" width={520} onCancel={close}><div className="dialog-title">Connect existing session</div><div className="nav-registration">
    <p>{project.project?.display_name ?? 'Unavailable project'} · {project.canonical_root}</p>
    <p>Choose an existing host session explicitly. The backend verifies its identity and capabilities before connecting.</p>
    {discovery && <CandidateList controller={discovery} root={project.canonical_root} selected={selected} select={candidate => {
      setSelected(candidateIdentity(candidate)); setInvalidated(false); setAdapterId(candidate.adapter_id); setExternalId(candidate.external_session_id);
      setKind(candidate.endpoint.kind); setEndpoint(candidate.endpoint.kind === 'unix_socket' ? candidate.endpoint.path : candidate.endpoint.name);
    }} />}
    {invalidSelection && <p role="alert">Selected host session is no longer fresh or present. Choose it again after refresh, or edit the manual fields.</p>}
    <p>Manual connection remains available. For Codex, use the configured app-server socket and an existing thread ID.</p>
    <RegistrationFailure store={store} />
    <form onSubmit={event => { void submit(event); }}><fieldset disabled={disabled}>
      <label>Adapter<select tabIndex={0} required value={adapterId} onChange={event => {
        const next = event.target.value;
        setSelected(null); setAdapterId(next);
        // Replace only an untouched field: empty or still the previous adapter's default.
        if (kind === 'unix_socket') setEndpoint(current => current === '' || current === defaultSocket(adapterId) ? defaultSocket(next) : current);
      }}>{adapters.map(adapter => <option key={adapter.adapter_id} value={adapter.adapter_id}>{adapter.label}</option>)}</select></label>
      <label>External session ID<input required value={externalId} onChange={event => { setSelected(null); setExternalId(event.target.value); }} /></label>
      <label>Endpoint<select tabIndex={0} value={kind} onChange={event => { setSelected(null); setKind(event.target.value as EndpointRef['kind']); }}><option value="unix_socket">Unix socket</option><option value="local_bridge">Local bridge</option></select></label>
      <label>{kind === 'unix_socket' ? 'Socket path' : 'Bridge name'}<input required value={endpoint} onChange={event => { setSelected(null); setEndpoint(event.target.value); }} /></label>
      <fieldset className="nav-session-choice"><legend>Ariadne session</legend>
        <label><input type="radio" name="session-choice" checked={sessionChoice === 'new'} onChange={() => setSessionChoice('new')} />New Ariadne session</label>
        <label><input type="radio" name="session-choice" checked={sessionChoice === 'existing'} onChange={() => setSessionChoice('existing')} />Attach to an existing Ariadne session</label>
      </fieldset>
      {sessionChoice === 'existing' && <><label>Registered Ariadne session<select tabIndex={0} required value={existingSession} onChange={event => setExistingSession(event.target.value)}><option value="">Choose a session</option>
        {sessions.map(session => <option key={session.session_id} value={session.session_id}>{session.title} · {session.state}</option>)}</select></label>
        <p>Ariadne keeps this session’s topics, items and history. Follow the saved setup instruction to attach this host conversation.</p></>}
      <div className="nav-dialog-actions"><button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={invalidSelection}>Connect existing session</button></div>
    </fieldset></form>
  </div></Dialog>;
}
