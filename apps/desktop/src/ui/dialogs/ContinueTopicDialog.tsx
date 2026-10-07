// "Continue in this session" (frame 1y), ported from Ariadne.dc.html:509-520 and
// projectVals 1743-1760. The preview and its checks are those of the former
// Continue topic dialog: both sessions are refreshed, `topic_continue_preview`
// is validated against the source snapshot, and Send runs `topic_continue`
// with the reviewed source and target revisions.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { immutable, ServiceFailure, useSession, type Immutable } from '../../data';
import type { ContinuePreview, SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import type { NavigationStore } from '../../state/navigation/store';
import { useSessionActions, type SessionActionControllers } from '../../components/bindings/actions';
import { sameRoute } from '../../components/history-actions/selectors';
import { continueGroups } from '../pages/model';
import { agentName } from '../shell/model';
import { Dialog } from './Dialog';

export interface ContinueRequest {
  /** The session that holds the topic. */
  readonly source: SessionRef;
  readonly topicId: string;
  /** The session that continues it. */
  readonly target: SessionRef;
}

let current: ContinueRequest | null = null;
const listeners = new Set<() => void>();
const publish = (next: ContinueRequest | null) => { current = next; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;

/** Opens the Continue dialog for `topicId` of `source` in `target`. */
export function openContinueTopic(request: ContinueRequest): void { publish(request); }

interface Prepared { readonly preview: Immutable<ContinuePreview>; readonly source: Immutable<Session>; readonly targetRevision: number }
const agentOf = (session: Immutable<Session> | undefined) => {
  const binding = session?.active_binding_id ? session.bindings[session.active_binding_id] : null;
  return binding ? agentName(binding.adapter_id) : 'the agent';
};
const blockedText = (reasons: readonly string[], agent: string) => reasons.includes('same_session')
  ? 'This topic is already in this session. Restore it from the archive instead.'
  : `${agent} can’t take this topic now: ${reasons.map(reason => reason.replace(/_/g, ' ')).join(', ')}.`;

function ContinueTopicDialog({ request, navigation, actions, onSent, onClose }: {
  readonly request: ContinueRequest; readonly navigation: NavigationStore; readonly actions: SessionActionControllers;
  readonly onSent?: (target: SessionRef) => void; readonly onClose: () => void;
}) {
  const sourceStore = useMemo(() => navigation.opened.open(request.source), [navigation, request.source]);
  const targetStore = useMemo(() => navigation.opened.open(request.target), [navigation, request.target]);
  const sourceState = useSession(sourceStore), targetState = useSession(targetStore);
  const targetActions = actions.forSession(targetStore), operation = useSessionActions(targetActions);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setPrepared(null);
    void (async () => {
      await Promise.all([targetStore.refresh(), sourceStore.refresh()]);
      const route = sourceStore.getSnapshot().route;
      const preview = await navigation.service.query({ session: null, request: { command: 'topic_continue_preview', params: {
        source: structuredClone(route), source_topic_id: request.topicId, target: structuredClone(request.target),
      } } });
      const read = await navigation.service.query({ session: structuredClone(route), request: { command: 'session_get', params: {} } });
      const source = read.session, target = targetStore.getSnapshot();
      if (!sameRoute(preview.source, route) || !sameRoute(preview.target, request.target)
          || preview.source_topic_id !== request.topicId || source.id !== preview.source.session_id || source.project_id !== preview.source.project_id
          || source.revision !== preview.source_revision || !source.topics[request.topicId]
          || !target.snapshot || target.status !== 'ready' || target.error
          || preview.mapping.some(mapping => source.items[mapping.source_item_id]?.topic_id !== request.topicId)) {
        throw new ServiceFailure('invalid_response');
      }
      if (!cancelled) setPrepared({ preview: immutable(preview), source: immutable(source), targetRevision: target.snapshot.session.revision });
    })().catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'The summary could not be prepared.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [navigation, sourceStore, targetStore, request, attempt]);
  const preview = prepared?.preview;
  const source = prepared?.source ?? sourceState.snapshot?.session;
  const topic = source?.topics[request.topicId];
  const agent = agentOf(targetState.snapshot?.session), fromAgent = agentOf(source);
  const stale = !!prepared && (sourceState.snapshot?.session.revision !== preview?.source_revision
    || targetState.snapshot?.session.revision !== prepared.targetRevision);
  const disabled = loading || !prepared || preview?.readiness.kind !== 'ready' || stale || operation.writing || !!operation.pending
    || sourceState.status !== 'ready' || !!sourceState.error || targetState.status !== 'ready' || !!targetState.error;
  const close = () => { if (!operation.writing) onClose(); };
  const send = async () => {
    if (disabled || !prepared || prepared.preview.readiness.kind !== 'ready') return;
    const value = prepared.preview;
    if (await targetActions.execute({ command: 'topic_continue', api_version: 1, op_id: '', params: {
      source: structuredClone(value.source), source_topic_id: value.source_topic_id, source_revision: value.source_revision,
      source_sha256: value.source_sha256, target: structuredClone(value.target), target_binding_id: prepared.preview.readiness.binding_id,
      summary: value.summary,
    } }, prepared.targetRevision)) { onClose(); onSent?.(request.target); }
  };
  const title = `Continue “${topic?.name ?? 'this topic'}” in this session`;
  return <Dialog label={title} width={580} onCancel={close} onConfirm={() => { void send(); }}>
    <div className="dialog-title">{title}</div>
    <div className="pw-dialog-lead">{`Ariadne sends ${agent} this summary so it can pick up where ${fromAgent} left off. Item references stay the same, and new items join this topic.`}</div>
    <div className="pw-continue-summary" aria-label="Summary">
      {loading && <div className="pw-continue-status" role="status">Preparing the summary…</div>}
      {error && <div className="pw-dialog-error" role="alert">{error}</div>}
      {prepared && preview && continueGroups(prepared.source, preview).map(group => <div key={group.title} className="pw-continue-group">
        <div className="pw-continue-group-title" style={{ color: group.color }}><i className={group.icon} aria-hidden="true" />{group.title}</div>
        {group.lines.map(line => <div key={line.id} className="pw-continue-line"><code>{line.id}</code><span>{line.text}</span></div>)}
      </div>)}
      {preview?.readiness.kind === 'blocked' && <div className="pw-dialog-error" role="alert">{blockedText(preview.readiness.reasons, agent)}</div>}
      {preview?.readiness.kind === 'ready' && !preview.readiness.host_available
        && <div className="pw-continue-status">{`${agent} isn’t running, so the summary waits until it runs again.`}</div>}
    </div>
    {stale && <div className="pw-dialog-error" role="alert">The topic or this session changed. Prepare the summary again before sending.</div>}
    {operation.error && <div className="pw-dialog-error" role="alert">{operation.error.message} {operation.pending
      ? 'Completion is unknown. Reconcile the saved action before sending again.' : 'Nothing was sent.'}</div>}
    <div className="dialog-actions">
      {(stale || error) && !operation.pending && <button type="button" className="btn btn-ghost" disabled={loading || operation.writing}
        onClick={() => setAttempt(value => value + 1)}>Prepare again</button>}
      <button type="button" className="btn btn-ghost" disabled={operation.writing} onClick={close}>Cancel</button>
      {operation.pending
        ? <button type="button" className="btn btn-primary" disabled={operation.writing} onClick={() => {
          void targetActions.retry().then(saved => { if (saved) { onClose(); onSent?.(request.target); } });
        }}>Reconcile saved action</button>
        : <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { void send(); }}>
          <i className="ph ph-paper-plane-right" aria-hidden="true" />{`Send to ${agent}`}</button>}
    </div>
  </Dialog>;
}

/** Mount once in the app; shows the dialog while a request is open. */
export function ContinueTopicHost({ navigation, actions, onSent }: {
  readonly navigation: NavigationStore; readonly actions: SessionActionControllers; readonly onSent?: (target: SessionRef) => void;
}) {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!request) return null;
  return <ContinueTopicDialog key={JSON.stringify(request)} request={request} navigation={navigation} actions={actions} onSent={onSent}
    onClose={() => { if (current === request) publish(null); }} />;
}
