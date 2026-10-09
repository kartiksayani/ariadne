import { useEffect, useRef, useState } from 'react';
import type { Item } from '../../generated/domain/models';
import { CoreFailure, plainFailure } from '../../data';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { ackTarget } from '../../selectors/ack';
import { STATUS, statusKey } from './status';

export { ackTarget } from '../../selectors/ack';
export const ackTitle = (target: NonNullable<Item['ack_to']>) => `Ack → ${target === 'open' ? 'keep open' : STATUS[statusKey[target]].label}`;

class AckUnavailable extends Error {}
const ackRefusal = 'This item can’t be acknowledged now. Check its current status and any question waiting for you.';
const archivedRefusal = 'This session is archived. Restore it, then reopen it to acknowledge this item.';
const waiting = new WeakMap<SessionActions, { readonly cancelled: () => boolean }>();
export const ackWaiting = (actions: SessionActions) => { const attempt = waiting.get(actions); return !!attempt && !attempt.cancelled(); };
export const ackBlocked = (actions: SessionActions): string | null => {
  const state = actions.getSnapshot();
  if (state.writing) return 'Another change is being saved. Wait for it, then try Ack again.';
  if (state.pending) return 'Ariadne isn’t sure your last change was saved. Check again before trying Ack.';
  return ackWaiting(actions) ? 'Another change is being saved. Wait for it, then try Ack again.' : null;
};

export function ackFailure(failure: unknown): string {
  if (failure instanceof AckUnavailable) return failure.message;
  if (failure instanceof CoreFailure && failure.error.code === 'invalid_transition' && failure.error.message === archivedRefusal) return archivedRefusal;
  return failure instanceof CoreFailure && failure.error.code === 'invalid_transition'
    ? 'This item can’t be acknowledged now. Check its current status and any question waiting for you.'
    : plainFailure(failure, 'Ack could not be saved. Try again.');
}

/** The shared action controller keeps uncertain saves available for exact retry. */
export async function acknowledge(actions: SessionActions, itemId: string, cancelled: () => boolean = () => false): Promise<boolean> {
  const blocked = ackBlocked(actions);
  if (blocked) throw new AckUnavailable(blocked);
  const store = actions.session, proposal = store.getSnapshot().snapshot?.session.items[itemId];
  const attempt = { cancelled };
  waiting.set(actions, attempt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (store.getSnapshot().status !== 'ready' || store.getSnapshot().error) {
      await Promise.race([
        store.refresh(true),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
      ]);
    }
    if (cancelled()) return false;
    const current = store.getSnapshot(), session = current.snapshot?.session, item = session?.items[itemId];
    if (actions.session !== store || current.status !== 'ready' || current.error || !session) throw new AckUnavailable("Ariadne is still loading this session's latest changes. Try again.");
    if (session.archived_at != null) throw new AckUnavailable(archivedRefusal);
    if (!item || !ackTarget(session, item)) throw new AckUnavailable(ackRefusal);
    if (!proposal || item.ack_to !== proposal.ack_to || item.question !== proposal.question || item.ask !== proposal.ask
        || item.outcome !== proposal.outcome || item.why !== proposal.why) throw new AckUnavailable('This item changed. Read its current proposal, then try Ack again.');
    const state = actions.getSnapshot();
    if (state.writing) throw new AckUnavailable('Another change is being saved. Wait for it, then try Ack again.');
    if (state.pending) throw new AckUnavailable('Ariadne isn’t sure your last change was saved. Check again before trying Ack.');
    const saved = await actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: item.id, expected_revision: item.revision } }, session.revision);
    if (!saved && !actions.getSnapshot().error) throw new AckUnavailable('Ack could not be saved. Try again.');
    return saved;
  } finally { clearTimeout(timeout); if (waiting.get(actions) === attempt) waiting.delete(actions); }
}

export function useAck(actions: SessionActions, selectedId: string | null) {
  const state = useSessionActions(actions);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    ++request.current;
    setError(null);
    setLoading(false);
    return () => { ++request.current; };
  }, [actions, selectedId]);
  useEffect(() => {
    if (state.receipt && 'data' in state.receipt && state.receipt.data.kind === 'item_ack') setError(null);
  }, [state.receipt]);
  return {
    busy: loading || state.writing || !!state.pending,
    error,
    run: async (itemId: string) => {
      const blocked = ackBlocked(actions);
      if (blocked) { setError(blocked); return false; }
      const attempted = ++request.current;
      setError(null);
      setLoading(true);
      try {
        const saved = await acknowledge(actions, itemId, () => attempted !== request.current);
        const failure = actions.getSnapshot().error;
        if (attempted === request.current && !saved && failure) setError(ackFailure(failure));
        return saved;
      } catch (failure) {
        if (attempted === request.current) setError(ackFailure(failure));
        return false;
      } finally { if (attempted === request.current) setLoading(false); }
    },
  };
}
