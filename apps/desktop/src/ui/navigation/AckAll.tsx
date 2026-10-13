import { useState, useSyncExternalStore } from 'react';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import type { Immutable } from '../../data/session-store';
import type { Item } from '../../generated/domain/models';
import { Dialog } from '../dialogs/Dialog';
import { ackAllFor } from './ackAllController';
import './navigation.css';

export function AckAll({ actions, topicId, topicName, items, disabled = false }: {
  readonly actions: SessionActions;
  readonly topicId: string;
  readonly topicName: string;
  readonly items: readonly Immutable<Item>[];
  readonly disabled?: boolean;
}) {
  const sessionState = useSyncExternalStore(actions.session.subscribe, actions.session.getSnapshot, actions.session.getSnapshot);
  const actionState = useSessionActions(actions);
  const controller = ackAllFor(actions), state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [reviewed, setReviewed] = useState<readonly Immutable<Item>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = ['holding', 'saving', 'failed'].includes(state.phase);
  const confirm = () => {
    if (!reviewed) return;
    if (controller.confirm(topicId, topicName, reviewed)) { setReviewed(null); setError(null); }
    else setError('These results changed or another save is pending. Cancel and review the current results before trying again.');
  };
  return <>
    {!!items.length && <button type="button" className="tree-topic-ack-all" title="Ack read-only findings and explanations in this topic"
      disabled={disabled || busy || actionState.writing || !!actionState.pending || sessionState.status !== 'ready' || !!sessionState.error}
      onClick={() => { setReviewed(items); setError(null); }}>Ack all ({items.length})</button>}
    {state.topicId === topicId && state.phase === 'holding' && <button type="button" className="btn btn-ghost" onClick={() => controller.undo()}>Undo Ack all</button>}
    {state.topicId === topicId && state.phase === 'failed' && <span className="ack-all-progress" role="status">{state.completed} saved · {state.remaining} to finish</span>}
    {reviewed && <Dialog label={`Acknowledge results in ${topicName}`} width={460} onCancel={() => setReviewed(null)} onConfirm={confirm}>
      <h2>Ack {reviewed.length} results in “{topicName}”?</h2>
      <p>Only read-only findings and explanations are included. Questions and decisions keep their own controls.</p>
      <p>You have 5 seconds to Undo before these acknowledgements are saved.</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="btn btn-ghost" onClick={() => setReviewed(null)}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={confirm}>Ack all</button></div>
    </Dialog>}
  </>;
}
