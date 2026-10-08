import { useEffect, useRef, useState } from 'react';
import type { Item } from '../../generated/domain/models';
import { CoreFailure, plainFailure } from '../../data';
import { useSessionActions, type SessionActions } from '../../components/bindings/actions';
import { ackTarget } from '../../selectors/ack';
import { STATUS } from './status';

export { ackTarget } from '../../selectors/ack';
export const ackTitle = (target: NonNullable<Item['ack_to']>) => `Ack: mark ${STATUS[target].label}`;

export function ackFailure(failure: unknown): string {
  return failure instanceof CoreFailure && failure.error.code === 'invalid_transition'
    ? 'This item can’t be acknowledged now. Check its current status and any question waiting for you.'
    : plainFailure(failure, 'Ack could not be saved. Try again.');
}

/** The shared action controller keeps uncertain saves available for exact retry. */
export async function acknowledge(actions: SessionActions, itemId: string): Promise<boolean> {
  const current = actions.session.getSnapshot(), session = current.snapshot?.session, item = session?.items[itemId];
  if (!session || !item || current.status !== 'ready' || !ackTarget(session, item)) return false;
  return actions.execute({ command: 'ack', api_version: 1, op_id: '', params: { item_id: item.id, expected_revision: item.revision } }, session.revision);
}

export function useAck(actions: SessionActions, selectedId: string | null) {
  const state = useSessionActions(actions);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    ++request.current;
    setError(null);
    return () => { ++request.current; };
  }, [actions, selectedId]);
  useEffect(() => {
    if (state.receipt && 'data' in state.receipt && state.receipt.data.kind === 'item_ack') setError(null);
  }, [state.receipt]);
  return {
    busy: state.writing || !!state.pending,
    error,
    run: async (itemId: string) => {
      const attempted = ++request.current;
      setError(null);
      const saved = await acknowledge(actions, itemId);
      const failure = actions.getSnapshot().error;
      if (attempted === request.current && !saved && failure) setError(ackFailure(failure));
      return saved;
    },
  };
}
