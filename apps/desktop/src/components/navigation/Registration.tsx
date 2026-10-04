import { useState, type FormEvent } from 'react';
import type { EndpointRef, ProjectSummary, SessionSummary } from '../../generated/domain/models';
import type { Immutable } from '../../data/session-store';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
import { CoreFailure } from '../../data/service';
import type { AdapterChoice } from './NavigationWorkspace';
import { ReferenceDialog } from '../reference/ReferenceDialog';

function RegistrationFailure({ store }: { store: NavigationStore }) {
  const state = useNavigation(store);
  if (!state.error) return null;
  return <div className="nav-banner" role="alert"><p>{state.error.message}</p>
    {state.error instanceof CoreFailure && <p>{state.error.error.hint}</p>}
    {state.pendingOperationId && <button type="button" className="ref-button ref-secondary" disabled={state.writing}
      onClick={() => { void store.retryMutation(); }}>Reconcile operation</button>}
  </div>;
}

export function RegisterProject({ store, disabled, close }: { store: NavigationStore; disabled: boolean; close: () => void }) {
  const [root, setRoot] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); if (await store.register(root)) close(); };
  return <ReferenceDialog title="Register project" onCancel={close} width={520} actions={null}><div className="nav-registration">
    <p>Choose the existing local project root.</p>
    <RegistrationFailure store={store} />
    <form onSubmit={event => { void submit(event); }}><fieldset disabled={disabled}><label>Project root<input required value={root} onChange={event => setRoot(event.target.value)} placeholder="/path/to/project" /></label>
      <div className="nav-dialog-actions"><button type="button" className="ref-button ref-secondary" onClick={close}>Cancel</button>
        <button type="submit" className="ref-button ref-primary">Register project</button></div></fieldset></form>
  </div></ReferenceDialog>;
}

export function BindSession({ store, project, sessions, adapters, disabled, close }: { store: NavigationStore; project: Immutable<ProjectSummary>;
  sessions: readonly Immutable<SessionSummary>[]; adapters: readonly AdapterChoice[]; disabled: boolean; close: () => void }) {
  const [adapterId, setAdapterId] = useState(adapters[0]?.adapter_id ?? '');
  const [externalId, setExternalId] = useState('');
  const [kind, setKind] = useState<EndpointRef['kind']>('unix_socket');
  const [endpoint, setEndpoint] = useState('');
  const [existingSession, setExistingSession] = useState('');
  const [sessionChoice, setSessionChoice] = useState<'new' | 'existing'>('new');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const adapter = adapters.find(choice => choice.adapter_id === adapterId);
    if (!adapter) return;
    if (await store.bind({ project_id: project.project_id, adapter_id: adapter.adapter_id, external_session_id: externalId,
      endpoint: kind === 'unix_socket' ? { kind, path: endpoint } : { kind, name: endpoint }, configuration: structuredClone(adapter.configuration),
      existing_session_id: sessionChoice === 'existing' ? existingSession : null })) close();
  };
  return <ReferenceDialog title="Connect existing session" onCancel={close} width={520} actions={null}><div className="nav-registration">
    <p>{project.project?.display_name ?? 'Unavailable project'} · {project.canonical_root}</p>
    <p>Choose an existing host session explicitly. The backend verifies its identity and capabilities before connecting.</p>
    <RegistrationFailure store={store} />
    <form onSubmit={event => { void submit(event); }}><fieldset disabled={disabled}>
      <label>Adapter<select tabIndex={0} required value={adapterId} onChange={event => setAdapterId(event.target.value)}>{adapters.map(adapter => <option key={adapter.adapter_id} value={adapter.adapter_id}>{adapter.label}</option>)}</select></label>
      <label>External session ID<input required value={externalId} onChange={event => setExternalId(event.target.value)} /></label>
      <label>Endpoint<select tabIndex={0} value={kind} onChange={event => setKind(event.target.value as EndpointRef['kind'])}><option value="unix_socket">Unix socket</option><option value="local_bridge">Local bridge</option></select></label>
      <label>{kind === 'unix_socket' ? 'Socket path' : 'Bridge name'}<input required value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
      <fieldset className="nav-session-choice"><legend>Ariadne session</legend>
        <label><input type="radio" name="session-choice" checked={sessionChoice === 'new'} onChange={() => setSessionChoice('new')} />New Ariadne session</label>
        <label><input type="radio" name="session-choice" checked={sessionChoice === 'existing'} onChange={() => setSessionChoice('existing')} />Attach to an existing Ariadne session</label>
      </fieldset>
      {sessionChoice === 'existing' && <><label>Registered Ariadne session<select tabIndex={0} required value={existingSession} onChange={event => setExistingSession(event.target.value)}><option value="">Choose a session</option>
        {sessions.map(session => <option key={session.session_id} value={session.session_id}>{session.title} · {session.state}</option>)}</select></label>
        <p>Ariadne keeps this session’s topics, items and history. Follow the saved setup instruction to attach this host conversation.</p></>}
      <div className="nav-dialog-actions"><button type="button" className="ref-button ref-secondary" onClick={close}>Cancel</button>
        <button type="submit" className="ref-button ref-primary">Connect existing session</button></div>
    </fieldset></form>
  </div></ReferenceDialog>;
}
