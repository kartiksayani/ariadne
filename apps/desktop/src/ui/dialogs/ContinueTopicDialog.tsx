// Two-step Continue (SPEC 10.7, 10.8, E26). Step 1 asks which session takes the topic over (ContinuePicker); step 2 reviews the
// summary, which is editable and is exactly the text that Send hands over. Both are one flow in ContinueTopicHost, so Back works.
// The preview and its checks are those of the former Continue topic dialog: both sessions are refreshed,
// `topic_continue_preview` is validated against the source snapshot, and Send runs `topic_continue` with the reviewed
// source and target revisions. Never send twice: an uncertain Send freezes the summary and the target; Check again retries it.
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { immutable, plainFailure, ServiceFailure, useSession, type Immutable } from '../../data';
import type { ContinuePreview, SessionRef } from '../../generated/core';
import type { ProjectSummary, Session, SessionSummary } from '../../generated/domain/models';
import { useNavigation, type NavigationStore } from '../../state/navigation/store';
import { useSessionActions, type SessionActionControllers } from '../../components/bindings/actions';
import { sameRoute } from '../../components/history-actions/selectors';
import { clockTime } from '../changes/clock';
import { agentName, ownerDescription, ownerName } from '../shell/model';
import { DialogActions, DialogButton, DialogError, DialogFrame, DialogText, DialogTitle } from './DialogFrame';
import './continue.css';

export interface ContinueRequest {
  /** The session that holds the topic. */
  readonly source: SessionRef;
  readonly topicId: string;
  /** The session that continues it. Without one, the flow starts at the picker. */
  readonly target?: SessionRef;
  /** Runs once after this request's topic was sent, before the host's onSent. */
  readonly onSent?: (target: SessionRef) => void;
}

let current: ContinueRequest | null = null;
const listeners = new Set<() => void>();
const publish = (next: ContinueRequest | null) => { current = next; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;

/** Opens Continue for `topicId` of `source`: at the picker, or at the summary when `target` is given. */
export function openContinueTopic(request: ContinueRequest): void { publish(request); }

/** A session that can take a topic over. */
export interface ContinueTarget { readonly route: SessionRef; readonly label: string; readonly detail: string }

/** An agent as the owner reads it in this dialog (SPEC 10.7, 10.8): "Claude Code", "Codex". */
const agentLabel = (adapterId: string): string => adapterId === 'claude_code_mod' ? 'Claude Code' : adapterId === 'codex' ? 'Codex' : agentName(adapterId);

/** The sessions a topic of `source` can continue in: the other active sessions, those of its own project first. */
export function continueTargets(source: SessionRef, sessions: readonly Immutable<SessionSummary>[], projects: readonly Immutable<ProjectSummary>[] = []): ContinueTarget[] {
  const own = (session: Immutable<SessionSummary>) => session.project_id === source.project_id;
  const where = (session: Immutable<SessionSummary>) => own(session) ? 'this project'
    : projects.find(project => project.project_id === session.project_id)?.project?.display_name ?? 'another project';
  return sessions.filter(session => session.archived_at == null && session.state === 'active' && !sameRoute(session, source))
    .sort((a, b) => Number(own(b)) - Number(own(a)))
    .map(session => {
      const binding = session.active_binding;
      const agent = binding ? agentLabel(binding.adapter_id) : 'No agent connected';
      const running = binding?.connection_state === 'connected' ? 'running' : 'not running, so the summary queues';
      return { route: { project_id: session.project_id, session_id: session.session_id }, label: ownerName(session) ?? session.title,
        detail: [binding ? `${agent} · ${running}` : agent, ownerDescription(session), where(session)].filter(Boolean).join(' · ') };
    });
}

/** Step 1 (SPEC 10.7): asks which session picks the topic up. Nothing is sent from here. */
export function ContinuePicker({ topicName, targets, unlisted, onPick, onCancel }: {
  readonly topicName: string; readonly targets: readonly ContinueTarget[];
  /** A closed or archived session that can't take a topic, named in the note under the list. */
  readonly unlisted?: string;
  readonly onPick: (target: SessionRef) => void; readonly onCancel: () => void;
}) {
  const id = useId(), title = `Continue “${topicName}” in another session`;
  return <DialogFrame label={title} onCancel={onCancel}>
    <DialogTitle>{title}</DialogTitle>
    <DialogText>Choose the session that picks this topic up. You review the summary before anything is sent.</DialogText>
    {targets.length
      ? <div className="dg-continue-targets" role="group" aria-label="Sessions">
        {targets.map((target, index) => <button key={`${target.route.project_id}/${target.route.session_id}`} type="button"
          className="dg-continue-option" aria-labelledby={`${id}-${index}`} aria-describedby={`${id}-${index}-detail`}
          onClick={() => onPick(target.route)}>
          <span id={`${id}-${index}`} className="dg-continue-option-label"><i className="ph ph-arrow-bend-down-right" aria-hidden="true" />{target.label}</span>
          <span id={`${id}-${index}-detail`} className="dg-continue-option-desc">{target.detail}</span></button>)}
      </div>
      : <DialogText>No other open session can take this topic.</DialogText>}
    {unlisted && <div className="dg-hint dg-continue-note"><i className="ph ph-info" aria-hidden="true" />{`Closed and archived sessions can’t take a topic, so “${unlisted}” isn’t listed.`}</div>}
    <DialogActions><DialogButton kind="ghost" kbd="esc" onClick={onCancel}>Cancel</DialogButton></DialogActions>
  </DialogFrame>;
}

interface Prepared { readonly preview: Immutable<ContinuePreview>; readonly source: Immutable<Session>; readonly targetRevision: number }
const agentOf = (session: Immutable<Session> | undefined) => {
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  return binding ? agentLabel(binding.adapter_id) : 'the agent';
};
const blockedWords: Record<string, string> = {
  source_archived: 'the source session is archived; restore it before continuing',
  target_closed: 'that session is closed',
  binding_unknown: 'Ariadne can’t tell which agent is connected',
  binding_ambiguous: 'more than one agent is connected',
  binding_invalid: 'its agent connection needs attention',
  target_unavailable: 'that session isn’t available',
};
const blockedText = (reasons: readonly string[], agent: string) => reasons.includes('same_session')
  ? 'This topic is already in this session. Restore it from the archive instead.'
  : `${agent} can’t take this topic now: ${reasons.map(reason => blockedWords[reason] ?? 'something changed').join(', ')}.`;

const topicKey = (source: SessionRef, topicId: string) => `${source.project_id}/${source.session_id}/${topicId}`;
const summaryKey = (source: SessionRef, topicId: string, target: SessionRef) => `${topicKey(source, topicId)}/${target.project_id}/${target.session_id}`;
/** The owner's edited summary per (session, topic, target): Esc, Back and a closed dialog keep it until it is sent. */
const summaryDrafts = new Map<string, string>();
/** A Send whose result is uncertain: reopening the topic goes straight back to it, on the same target. */
const uncertainTargets = new Map<string, SessionRef>();

/** Step 2 (SPEC 10.8): the editable summary. Send hands over exactly the text in the box. */
function ContinueReview({ request, target, navigation, actions, summaries, onBack, onSent, onClose }: {
  readonly request: ContinueRequest; readonly target: SessionRef; readonly navigation: NavigationStore; readonly actions: SessionActionControllers;
  readonly summaries: readonly Immutable<SessionSummary>[];
  readonly onBack: () => void; readonly onSent?: (target: SessionRef) => void; readonly onClose: () => void;
}) {
  const sourceStore = useMemo(() => navigation.opened.open(request.source), [navigation, request.source]);
  const targetStore = useMemo(() => navigation.opened.open(target), [navigation, target]);
  const sourceState = useSession(sourceStore), targetState = useSession(targetStore);
  const targetActions = actions.forSession(targetStore), operation = useSessionActions(targetActions);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const key = summaryKey(request.source, request.topicId, target), topic = topicKey(request.source, request.topicId);
  const [edited, setEdited] = useState<string | null>(() => summaryDrafts.get(key) ?? null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setPrepared(null);
    void (async () => {
      await Promise.all([targetStore.refresh(), sourceStore.refresh()]);
      const route = sourceStore.getSnapshot().route;
      const preview = await navigation.service.query({ session: null, request: { command: 'topic_continue_preview', params: {
        source: structuredClone(route), source_topic_id: request.topicId, target: structuredClone(target),
      } } });
      const read = await navigation.service.query({ session: structuredClone(route), request: { command: 'session_get', params: {} } });
      const source = read.session, current = targetStore.getSnapshot();
      if (!sameRoute(preview.source, route) || !sameRoute(preview.target, target)
          || preview.source_topic_id !== request.topicId || source.id !== preview.source.session_id || source.project_id !== preview.source.project_id
          || source.revision !== preview.source_revision || !source.topics[request.topicId]
          || !current.snapshot || current.status !== 'ready' || current.error
          || preview.mapping.some(mapping => source.items[mapping.source_item_id]?.topic_id !== request.topicId)) {
        throw new ServiceFailure('invalid_response');
      }
      if (!cancelled) setPrepared({ preview: immutable(preview), source: immutable(source), targetRevision: current.snapshot.session.revision });
    })().catch((failure: unknown) => { if (!cancelled) setError(plainFailure(failure, 'The summary could not be prepared. Try again.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [navigation, sourceStore, targetStore, request, target, attempt]);
  const preview = prepared?.preview;
  const source = prepared?.source ?? sourceState.snapshot?.session;
  const sourceTopic = source?.topics[request.topicId];
  const agent = agentOf(targetState.snapshot?.session);
  const summary = summaries.find(value => sameRoute(value, target));
  const targetName = (summary ? ownerName(summary) ?? summary.title : null) ?? targetState.snapshot?.session.title ?? 'that session';
  const pendingContinue = operation.pending?.command.command === 'topic_continue' ? operation.pending.command : null;
  // An uncertain Send keeps its exact words and its target: the summary shows what was sent, not what is in the draft.
  const value = pendingContinue ? pendingContinue.params.summary : edited ?? preview?.summary ?? '';
  useEffect(() => {
    if (pendingContinue) uncertainTargets.set(topic, target);
    else if (uncertainTargets.has(topic) && !operation.writing && sentAt === null) uncertainTargets.delete(topic);
  }, [pendingContinue, topic, target, operation.writing, sentAt]);
  const stale = !!prepared && !pendingContinue && (sourceState.snapshot?.session.revision !== preview?.source_revision
    || targetState.snapshot?.session.revision !== prepared.targetRevision);
  const blocked = loading || !prepared || preview?.readiness.kind !== 'ready' || stale || operation.writing || !!operation.pending
    || sourceState.status !== 'ready' || !!sourceState.error || targetState.status !== 'ready' || !!targetState.error;
  const disabled = blocked || !value.trim();
  const writing = operation.writing;
  const close = () => { if (!writing) onClose(); };
  const done = (when: Date) => { summaryDrafts.delete(key); uncertainTargets.delete(topic); setSentAt(clockTime(when)); onSent?.(target); };
  const send = async () => {
    if (disabled || !prepared || prepared.preview.readiness.kind !== 'ready') return;
    const reviewed = prepared.preview;
    if (await targetActions.execute({ command: 'topic_continue', api_version: 1, op_id: '', params: {
      source: structuredClone(reviewed.source), source_topic_id: reviewed.source_topic_id, source_revision: reviewed.source_revision,
      source_sha256: reviewed.source_sha256, target: structuredClone(reviewed.target), target_binding_id: prepared.preview.readiness.binding_id,
      summary: value,
    } }, prepared.targetRevision)) done(new Date());
  };
  const title = `Continue “${sourceTopic?.name ?? 'this topic'}” in “${targetName}”`;
  const sentLine = `✓ Sent once at ${sentAt}. ${agent} in “${targetName}” ${preview?.readiness.kind === 'ready' && !preview.readiness.host_available
    ? 'will pick the topic up when it runs' : 'is picking the topic up'}.`;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
  };
  return <DialogFrame label={title} width={560} onCancel={close}>
    <div className="dg-continue" onKeyDown={keys}>
      <DialogTitle>{title}</DialogTitle>
      <DialogText>{`${agent} in “${targetName}” gets this summary as one message, then picks the topic up. Edit it first if you like.`}</DialogText>
      <div className="dg-field">
        <label className="dg-label" htmlFor="dg-continue-summary">Summary</label>
        {loading && !pendingContinue
          ? <div className="dg-continue-status" role="status">Preparing the summary…</div>
          : <textarea id="dg-continue-summary" className="dg-input dg-textarea" rows={7} aria-label="Summary" data-summary={preview?.summary}
            value={value} readOnly={!!pendingContinue || writing || sentAt !== null} onChange={event => { setEdited(event.target.value); summaryDrafts.set(key, event.target.value); }} />}
      </div>
      {error && <DialogError>{error}</DialogError>}
      {preview?.readiness.kind === 'blocked' && <DialogError>{blockedText(preview.readiness.reasons, agent)}</DialogError>}
      {preview?.readiness.kind === 'ready' && !preview.readiness.host_available && sentAt === null
        && <div className="dg-continue-status">{`${agent} isn’t running, so the summary waits until it runs again.`}</div>}
      {stale && <DialogError>The topic or this session changed. Prepare the summary again before sending.</DialogError>}
      {operation.error && <div style={{ display: 'contents' }} data-operation-id={operation.pending?.command.op_id}><DialogError>{`${plainFailure(operation.error)} ${operation.pending
        ? 'Ariadne isn’t sure the summary was sent. Check again before sending it a second time.' : 'Nothing was sent.'}`}</DialogError></div>}
      {sentAt === null && !writing && <div className="dg-hint dg-continue-note"><i className="ph ph-info" aria-hidden="true" />{`The topic stays here too, marked “Continued in ${targetName}”.`}</div>}
      {writing && <div className="dg-continue-status" role="status">{`Sending to ${agent}…`}</div>}
      {sentAt !== null && <div className="dg-continue-sent" role="status">{sentLine}</div>}
      <DialogActions>
        {sentAt !== null ? <DialogButton kind="primary" autoFocus onClick={onClose}>Done</DialogButton> : <>
          <span className="dg-continue-back"><DialogButton kind="ghost" disabled={writing || !!operation.pending} onClick={onBack}>← Back</DialogButton></span>
          {(stale || error) && !operation.pending && <DialogButton kind="ghost" disabled={loading || writing} onClick={() => setAttempt(count => count + 1)}>Prepare again</DialogButton>}
          <DialogButton kind="ghost" kbd="esc" disabled={writing} onClick={close}>Cancel</DialogButton>
          {operation.pending && !writing
            ? <DialogButton kind="primary" onClick={() => {
              void targetActions.retry().then(saved => { if (saved) done(new Date()); });
            }}>Check again</DialogButton>
            : <DialogButton kind="primary" icon="ph ph-paper-plane-right" kbd="⌘↵" disabled={disabled} onClick={() => { void send(); }}>{writing ? 'Sending…' : 'Send summary'}</DialogButton>}
        </>}
      </DialogActions>
    </div>
  </DialogFrame>;
}

/** The whole flow: the picker, then the review; Back returns to the picker unless a Send is uncertain. */
function ContinueFlow({ request, navigation, actions, onSent, onClose }: {
  readonly request: ContinueRequest; readonly navigation: NavigationStore; readonly actions: SessionActionControllers;
  readonly onSent?: (target: SessionRef) => void; readonly onClose: () => void;
}) {
  const catalogue = useNavigation(navigation);
  const summaries = catalogue.sessions?.sessions.items ?? [], projects = catalogue.projects?.projects.items ?? [];
  // A topic with an uncertain Send reopens on that target: another target would send it twice.
  const [target, setTarget] = useState<SessionRef | null>(() => uncertainTargets.get(topicKey(request.source, request.topicId)) ?? request.target ?? null);
  const sourceState = useSession(useMemo(() => navigation.opened.open(request.source), [navigation, request.source]));
  if (target) return <ContinueReview key={`${target.project_id}/${target.session_id}`} request={request} target={target} navigation={navigation} actions={actions}
    summaries={summaries} onBack={() => setTarget(null)} onSent={onSent} onClose={onClose} />;
  const unlisted = summaries.find(session => !sameRoute(session, request.source) && (session.archived_at != null || session.state !== 'active'));
  return <ContinuePicker topicName={sourceState.snapshot?.session.topics[request.topicId]?.name ?? 'this topic'} targets={continueTargets(request.source, summaries, projects)}
    unlisted={unlisted ? ownerName(unlisted) ?? unlisted.title : undefined} onPick={setTarget} onCancel={onClose} />;
}

/** Mount once in the app; shows the flow while a request is open. */
export function ContinueTopicHost({ navigation, actions, onSent }: {
  readonly navigation: NavigationStore; readonly actions: SessionActionControllers; readonly onSent?: (target: SessionRef) => void;
}) {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The request belongs to this host: an app that goes away takes an open flow with it.
  useEffect(() => () => { if (current) publish(null); }, []);
  if (!request) return null;
  return <ContinueFlow key={JSON.stringify([request.source, request.topicId, request.target])} request={request} navigation={navigation} actions={actions}
    onSent={target => { request.onSent?.(target); onSent?.(target); }}
    onClose={() => { if (current === request) publish(null); }} />;
}
