import { useEffect, useState } from 'react';
import { immutable, ServiceFailure, useSession, type Immutable } from '../../data';
import type { ContinuePreview, ItemRoute, SessionRef } from '../../generated/core';
import type { Session } from '../../generated/domain/models';
import { SessionActions, useSessionActions } from '../bindings/actions';
import { ReferenceDialog } from '../reference/ReferenceDialog';
import { continueGroups, sameRoute } from './selectors';

export interface ContinueTarget { route: SessionRef; label: string }
interface Prepared { preview: Immutable<ContinuePreview>; source: Immutable<Session>; targetRevision: number }
function TargetPreview({ sourceActions, topicId, target, actions, revealItem, onCancel }: {
  sourceActions: SessionActions; topicId: string; target: ContinueTarget; actions: SessionActions;
  revealItem: (route: ItemRoute) => void; onCancel: () => void;
}) {
  const sourceState = useSession(sourceActions.session), targetState = useSession(actions.session), operation = useSessionActions(actions);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setPrepared(null);
    void (async () => {
      await Promise.all([actions.session.refresh(), sourceActions.session.refresh()]);
      const preview = await sourceActions.service.query({ session: target.route, request: { command: 'topic_continue_preview', params: {
        source: structuredClone(sourceState.route), source_topic_id: topicId, target: target.route,
      } } });
      const snapshot = await sourceActions.service.query({ session: structuredClone(sourceState.route), request: { command: 'session_get', params: {} } });
      const source = snapshot.session, targetSnapshot = actions.session.getSnapshot();
      if (!sameRoute(preview.source, sourceState.route) || !sameRoute(preview.target, target.route)
          || preview.source_topic_id !== topicId || source.id !== preview.source.session_id || source.project_id !== preview.source.project_id
          || source.revision !== preview.source_revision || !source.topics[topicId]
          || !targetSnapshot.snapshot || targetSnapshot.status !== 'ready' || targetSnapshot.error
          || preview.mapping.some(mapping => source.items[mapping.source_item_id]?.topic_id !== topicId)) {
        throw new ServiceFailure('invalid_response');
      }
      if (!cancelled) setPrepared({ preview: immutable(preview), source: immutable(source), targetRevision: targetSnapshot.snapshot.session.revision });
    })().catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'The continuation preview could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [actions, sourceActions, sourceState.route, target, topicId, attempt]);
  const preview = prepared?.preview;
  const stale = !!prepared && (sourceState.snapshot?.session.revision !== preview?.source_revision
    || targetState.snapshot?.session.revision !== prepared.targetRevision);
  const pending = operation.pending?.command.command === 'topic_continue' ? operation.pending.command : null;
  const disabled = loading || !prepared || preview?.readiness.kind !== 'ready' || stale || operation.writing || !!operation.pending
    || sourceState.status !== 'ready' || !!sourceState.error || targetState.status !== 'ready' || !!targetState.error;
  const send = async () => {
    if (disabled || !prepared || prepared.preview.readiness.kind !== 'ready') return;
    const value = prepared.preview, bindingId = prepared.preview.readiness.binding_id;
    if (await actions.execute({ command: 'topic_continue', api_version: 1, op_id: '', params: {
      source: structuredClone(value.source), source_topic_id: value.source_topic_id, source_revision: value.source_revision,
      source_sha256: value.source_sha256, target: structuredClone(value.target), target_binding_id: bindingId,
      summary: value.summary,
    } }, prepared.targetRevision)) onCancel();
  };
  return <ReferenceDialog title="Continue topic" onCancel={() => { if (!operation.writing) onCancel(); }} actions={<>
    <button type="button" className="ref-button ref-secondary" disabled={operation.writing} onClick={onCancel}>Cancel</button>
    {operation.pending ? <button type="button" className="ref-button ref-primary" disabled={operation.writing} onClick={() => {
      void actions.retry().then(saved => { if (saved) onCancel(); });
    }}>Reconcile saved action</button> : <button type="button" className="ref-button ref-primary" disabled={disabled} onClick={() => { void send(); }}>Send to {target.label}</button>}
  </>}>
    <div className="history-action-dialog">
      <p>From {prepared?.source.title ?? sourceState.snapshot?.session.title} to {target.label}.</p>
      <p>Project {sourceState.route.project_id} / session {sourceState.route.session_id} → project {target.route.project_id} / session {target.route.session_id}.</p>
      <p>Copy full saved topic, item, message, round and answer history with new target IDs and immutable source provenance. Send queues one handoff. The source stays unchanged.</p>
      {loading && <p role="status">Loading continuation preview…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && <>
        <p>Source revision {preview.source_revision} · snapshot <code>{preview.source_sha256}</code></p>
        {preview.readiness.kind === 'blocked' ? <p role="alert">Target unavailable: {preview.readiness.reasons.map(reason => reason.replace(/_/g, ' ')).join(', ')}.</p>
          : <p>Selected binding <code>{preview.readiness.binding_id}</code>. {preview.readiness.host_available ? 'Handoff will be queued.' : 'Host unavailable. Handoff will be saved as queued; no host is launched.'}</p>}
        {continueGroups(prepared!.source, preview).map(group => <section key={group.title} aria-label={`${group.title} items`}><strong>{group.title} ({group.items.length})</strong>
          {group.items.map(({ item, action }) => <div key={item.id}>
            <button type="button" className="ref-button ref-secondary" onClick={() => revealItem({ ...structuredClone(preview.source), item_id: item.id })}>Item {item.id}</button>
            <span>{item.question} · {item.status}</span>{item.outcome && <p>{item.outcome}</p>}
            {action.kind === 'imported_drop' && <p>Imported as Dropped: {action.outcome} {action.why} Source replacement {action.external_replacement_id} remains historical provenance.</p>}
          </div>)}</section>)}
        <details><summary>Approved handoff summary</summary><p>{preview.summary}</p></details>
      </>}
      {stale && <p role="alert">Source or target changed. Prepare a new preview before sending.</p>}
      {operation.error && <p role="alert">{operation.error.message} {operation.pending ? 'Completion is unknown. Reconcile the original action before preparing another Send.' : 'Source unchanged. Prepare a new preview, then send explicitly.'}</p>}
      {pending && <p data-operation-id={pending.op_id}>Pending handoff from session {pending.params.source.session_id}, revision {pending.params.source_revision}, to session {pending.params.target.session_id}. Its approved summary and operation ID are retained.</p>}
      {!operation.pending && !operation.writing && <button type="button" className="ref-button ref-secondary" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Prepare new preview</button>}
    </div>
  </ReferenceDialog>;
}
export function ContinueDialog({ actions, topicId, targets, actionsForTarget, revealItem, onCancel }: {
  actions: SessionActions; topicId: string; targets: readonly ContinueTarget[]; actionsForTarget: (route: SessionRef) => SessionActions;
  revealItem: (route: ItemRoute) => void; onCancel: () => void;
}) {
  const [selected, setSelected] = useState<ContinueTarget | null>(null);
  const source = actions.session.getSnapshot().route;
  const choices = targets.filter(target => !sameRoute(source, target.route));
  return selected ? <TargetPreview sourceActions={actions} topicId={topicId} target={selected} actions={actionsForTarget(selected.route)} revealItem={revealItem} onCancel={onCancel} />
    : <ReferenceDialog title="Choose continuation target" onCancel={onCancel} actions={<button type="button" className="ref-button ref-secondary" onClick={onCancel}>Cancel</button>}>
      <div className="history-action-dialog"><p>Choose an existing Ariadne session. The preview checks its active state and explicitly selected binding.</p>
        {choices.length === 0 && <p>No other registered sessions are available.</p>}
        {choices.map(target => <button key={JSON.stringify(target.route)} type="button" className="ref-button ref-secondary" onClick={() => setSelected(target)}>{target.label}</button>)}
      </div>
    </ReferenceDialog>;
}
