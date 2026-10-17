// Register a project (SPEC 5.14): one folder; Ariadne watches it for agent sessions. Pure props in, callbacks out (contract C8).
import { useId, useState, type KeyboardEvent } from 'react';
import type { RegisterProjectDialogProps } from '../pages/page-types';
import { DialogActions, DialogButton, DialogError, DialogFrame, DialogText, DialogTitle } from './DialogFrame';

export function RegisterProjectDialog({ initialPath = '', busy, error, onRegister, onCancel }: RegisterProjectDialogProps) {
  const [path, setPath] = useState(initialPath);
  const id = useId(), hint = useId();
  const valid = path.trim().length > 0 && !busy;
  const register = () => { if (valid) onRegister(path.trim()); };
  const enter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); register(); } };
  return <DialogFrame label="Register a project" onCancel={onCancel}>
    <DialogTitle>Register a project</DialogTitle>
    <DialogText>Ariadne watches this folder and shows each agent session that starts in it. Nothing is sent to an agent, and the folder isn’t changed.</DialogText>
    <div className="dg-field">
      <label className="dg-label" htmlFor={id}>Folder</label>
      <input id={id} className="dg-input" autoFocus value={path} placeholder="~/code/my-project" spellCheck={false} aria-describedby={hint}
        onChange={event => setPath(event.target.value)} onKeyDown={enter} />
      <span className="dg-hint" id={hint}>The project is named after the folder. You can rename it later.</span>
    </div>
    {error && <DialogError>{error}</DialogError>}
    <DialogActions>
      <DialogButton kind="ghost" kbd="esc" onClick={onCancel}>Cancel</DialogButton>
      <DialogButton kind="primary" icon="ph ph-plus" kbd="↵" disabled={!valid} onClick={register}>{busy ? 'Registering…' : 'Register project'}</DialogButton>
    </DialogActions>
  </DialogFrame>;
}
