// Name a session (SPEC 5.14, dialog 10.10): a name, and an optional line about what the session is for.
// Pure props in, callbacks out (contract C8). Words typed here are never lost to a stray click on the scrim.
import { useId, useState, type KeyboardEvent } from 'react';
import { SESSION_DESCRIPTION_MAX, SESSION_NAME_MAX } from '../shell/model';
import type { NameSessionDialogProps } from '../pages/page-types';
import { DialogActions, DialogButton, DialogError, DialogFrame, DialogText, DialogTitle } from './DialogFrame';

export function NameSessionDialog({ unnamedAs, initialName = '', initialDescription = '', nameMax = SESSION_NAME_MAX, descriptionMax = SESSION_DESCRIPTION_MAX, busy, error, onSave, onCancel }: NameSessionDialogProps) {
  const [name, setName] = useState(initialName), [description, setDescription] = useState(initialDescription);
  const nameId = useId(), descriptionId = useId(), hintId = useId();
  const valid = name.trim().length > 0 && !busy;
  const save = () => { if (valid) onSave({ name: name.trim(), description: description.trim() }); };
  const enter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); save(); } };
  return <DialogFrame label="Name this session" onCancel={onCancel}>
    <DialogTitle>Name this session</DialogTitle>
    <DialogText>Until it has a name it shows as “{unnamedAs}”. The name is used in the switcher, notices and dialogs.</DialogText>
    <div className="dg-field">
      <label className="dg-label" htmlFor={nameId}>Name</label>
      <input id={nameId} className="dg-input" autoFocus value={name} maxLength={nameMax} placeholder="A few words" onChange={event => setName(event.target.value)} onKeyDown={enter}
        onFocus={event => event.currentTarget.select()} />
    </div>
    <div className="dg-field">
      <label className="dg-label" htmlFor={descriptionId}>Description (optional)</label>
      <input id={descriptionId} className="dg-input" value={description} maxLength={descriptionMax} placeholder="What this session is for" aria-describedby={hintId}
        onChange={event => setDescription(event.target.value)} onKeyDown={enter} />
      <span className="dg-hint" id={hintId}>Shown under the name in All sessions.</span>
    </div>
    {error && <DialogError>{error}</DialogError>}
    <DialogActions>
      <DialogButton kind="ghost" kbd="esc" onClick={onCancel}>Cancel</DialogButton>
      <DialogButton kind="primary" kbd="↵" disabled={!valid} onClick={save}>{busy ? 'Saving…' : 'Save name'}</DialogButton>
    </DialogActions>
  </DialogFrame>;
}
