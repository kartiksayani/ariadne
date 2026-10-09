import type { Immutable } from '../../data';
import type { Session } from '../../generated/domain/models';
import type { SessionActions } from '../../components/bindings/actions';

export const savingError = 'Another change is being saved. Wait for it, then try again.';
export const pendingError = 'Ariadne isn’t sure your last change was saved. Check again before making another change.';
export const loadingError = "Ariadne is still loading this session's latest changes. Try again.";
interface Attempt { readonly cancelled: boolean; readonly cancellation: Promise<boolean> }
type Ready = { readonly ok: true; readonly session: Immutable<Session> } | { readonly ok: false; readonly error: string | null };

/** Wait through a saved action's presence refresh, then capture current revisions.
 * Each barrier wait and stale refresh has its own bounded time to finish. */
export function waitForLifecycleReady(actions: SessionActions, attempt?: Attempt, forceRefresh = false): Ready | Promise<Ready> {
  const current = actions.session.getSnapshot(), operation = actions.getSnapshot();
  if (!forceRefresh && !attempt?.cancelled && !operation.writing && !operation.pending
      && current.status === 'ready' && !current.error && current.snapshot) return { ok: true, session: current.snapshot.session };
  return wait(actions, attempt, forceRefresh);
}

async function wait(actions: SessionActions, attempt: Attempt | undefined, forceRefresh: boolean): Promise<Ready> {
  const store = actions.session;
  const bounded = async (work: Promise<boolean>) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const stalled = new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 5000); });
      return await Promise.race([work, stalled, ...(attempt ? [attempt.cancellation] : [])]);
    } finally { clearTimeout(timeout); }
  };
  const barrier = async () => {
    if (!actions.getSnapshot().writing) return true;
    let unsubscribe: (() => void) | undefined;
    try {
      return await bounded(new Promise<boolean>(resolve => {
        unsubscribe = actions.subscribe(() => { if (!actions.getSnapshot().writing) resolve(true); });
        if (!actions.getSnapshot().writing) resolve(true);
      }));
    } finally { unsubscribe?.(); }
  };
  const failed = (error: string): Ready => ({ ok: false, error: attempt?.cancelled ? null : error });
  if (!await barrier()) return failed(savingError);
  if (attempt?.cancelled) return { ok: false, error: null };
  if (actions.getSnapshot().pending) return failed(pendingError);
  if (forceRefresh || store.getSnapshot().status !== 'ready' || store.getSnapshot().error) {
    if (!await bounded(store.refresh(true).then(() => true, () => false))) return failed(loadingError);
  }
  if (attempt?.cancelled) return { ok: false, error: null };
  if (!await barrier()) return failed(savingError);
  if (attempt?.cancelled) return { ok: false, error: null };
  const current = store.getSnapshot();
  if (actions.session !== store || current.status !== 'ready' || current.error || !current.snapshot) return failed(loadingError);
  if (actions.getSnapshot().writing) return failed(savingError);
  if (actions.getSnapshot().pending) return failed(pendingError);
  return { ok: true, session: current.snapshot.session };
}
