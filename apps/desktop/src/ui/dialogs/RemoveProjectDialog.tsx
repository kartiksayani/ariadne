// Remove a project from Ariadne (SPEC 5.14): says what goes (its sessions and Maps, any waiting questions) and what does
// not (the folder, running agents). Cancel has focus; Enter never removes. Pure props in, callbacks out (contract C8).
import type { RemoveProjectDialogProps } from '../pages/page-types';
import { DialogActions, DialogButton, DialogError, DialogFrame, DialogText, DialogTitle, DialogWarn } from './DialogFrame';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function RemoveProjectDialog({ name, path, sessionCount, waitingCount, busy, error, onRemove, onCancel }: RemoveProjectDialogProps) {
  const forgets = sessionCount > 0 ? `its ${plural(sessionCount, 'session')} and their Maps` : 'it';
  return <DialogFrame label={`Remove “${name}” from Ariadne?`} onCancel={onCancel} cancelOnScrim>
    <DialogTitle>Remove “{name}” from Ariadne?</DialogTitle>
    <DialogText>Ariadne stops watching {path} and forgets {forgets}. The folder and its files aren’t touched, and running agents keep running. A session that connects there later brings the project back.</DialogText>
    {waitingCount > 0 && <DialogWarn>{plural(waitingCount, 'question')} waiting on you in it {waitingCount === 1 ? 'goes' : 'go'} too, unanswered.</DialogWarn>}
    {error && <DialogError>{error}</DialogError>}
    <DialogActions>
      <DialogButton kind="ghost" kbd="esc" autoFocus onClick={onCancel}>Cancel</DialogButton>
      <DialogButton kind="danger" icon="ph ph-trash" disabled={busy} onClick={onRemove}>{busy ? 'Removing…' : 'Remove project'}</DialogButton>
    </DialogActions>
  </DialogFrame>;
}
