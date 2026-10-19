// One row action of a page (Close, Reopen or Rename a session) through the session's lifecycle (C3): mounted while it
// runs, it asks in the lifecycle's own review (or the Name dialog) and reports done when that closes.
import { useEffect, useRef, useState } from 'react';
import type { SessionActions } from '../../components/bindings/actions';
import { useSessionLifecycleFor } from '../shared/SessionLifecycleOwner';
import { NameSessionDialog } from '../dialogs/NameSessionDialog';
import { notices } from './notices';

export type RowAct = 'close' | 'reopen' | 'rename';
export interface SessionRowActionProps {
  readonly actions: SessionActions;
  readonly act: RowAct;
  /** Rename: the session's current words, and what it shows as until named. */
  readonly naming?: { readonly name: string; readonly description: string; readonly unnamedAs: string };
  readonly onDone: () => void;
}

export function SessionRowAction({ actions, act, naming, onDone }: SessionRowActionProps) {
  const lifecycle = useSessionLifecycleFor(actions);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | undefined>();
  const start = useRef(act === 'close' ? lifecycle.close : act === 'reopen' ? lifecycle.reopen : null);
  const done = useRef(onDone); done.current = onDone;
  useEffect(() => { start.current?.(); }, []);
  // The review closed (confirmed or cancelled): the action is over.
  const open = lifecycle.reviewing, shown = useRef(false);
  useEffect(() => { if (open) shown.current = true; else if (shown.current) done.current(); }, [open]);
  // It could not start (still loading, or another change is saving): say so instead of waiting silently. The lifecycle may be
  // shared with the top bar, so an error it already held when this action began is not this action's: only a later one is.
  const began = useRef(lifecycle.errorCount);
  useEffect(() => {
    if (act === 'rename' || !lifecycle.error || lifecycle.errorCount === began.current || open) return;
    notices.push({ id: `session-row-action:${actions.session.getSnapshot().route.session_id}`, icon: 'ph ph-warning-circle', iconColor: 'var(--a-danger)', text: lifecycle.error });
    done.current();
  }, [act, lifecycle.error, lifecycle.errorCount, open, actions]);
  if (act === 'rename' && naming) return <NameSessionDialog unnamedAs={naming.unnamedAs} initialName={naming.name} initialDescription={naming.description}
    busy={saving} error={error} onCancel={() => { if (!saving) done.current(); }} onSave={({ name, description }) => {
      // Nothing changed: close without a write (no session_label_set, no new revision).
      if (name === naming.name.trim() && description === naming.description.trim()) { done.current(); return; }
      setSaving(true); setError(undefined);
      void lifecycle.rename(name, description).then(failure => { setSaving(false); if (failure === null) done.current(); else setError(failure); });
    }} />;
  return <>{lifecycle.dialog}</>;
}
