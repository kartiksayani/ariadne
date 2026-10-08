// Rename a session: the owner's own name and a short description, edited in place.
// Enter or Save saves, Esc or Cancel leaves everything as it was (ADR-0091).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { plainFailure } from '../../data';
import type { SessionActions } from '../../components/bindings/actions';
import { SESSION_DESCRIPTION_MAX, SESSION_NAME_MAX, type SessionNaming } from '../shell/model';
import './rename.css';

/** Saves the name and description through the session's write barrier; the owner's error in plain words, or null when saved. */
export async function saveSessionLabel(actions: SessionActions, revision: number, name: string, description: string): Promise<string | null> {
  const saved = await actions.execute({ command: 'session_label_set', api_version: 1, op_id: '',
    params: { name: name.trim() || null, description: description.trim() || null } }, revision);
  if (saved) return null;
  const error = actions.getSnapshot().error;
  return plainFailure(error, 'The name could not be saved. Try again.');
}

export interface SessionRenameProps {
  readonly naming: SessionNaming;
  /** Resolves to an error message in plain words, or null once saved. */
  readonly onSave: (name: string, description: string) => Promise<string | null>;
  readonly onCancel: () => void;
  /** The bar keeps one line; the card stacks the fields. */
  readonly layout: 'card' | 'bar';
}

export function SessionRename({ naming, onSave, onCancel, layout }: SessionRenameProps) {
  const [name, setName] = useState(naming.name ?? ''), [description, setDescription] = useState(naming.description ?? '');
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    // Like a dialog, give focus back to what opened the fields once they close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    first.current?.focus(); first.current?.select();
    return () => { if (opener?.isConnected && opener !== document.body) opener.focus(); };
  }, []);
  const save = async () => {
    if (saving || done.current) return;
    // Nothing changed: nothing to save.
    if (name.trim() === (naming.name ?? '').trim() && description.trim() === (naming.description ?? '').trim()) { done.current = true; onCancel(); return; }
    setSaving(true); setError(null);
    const failed = await onSave(name, description);
    setSaving(false);
    if (failed === null) done.current = true; else setError(failed);
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // The window's shortcuts must not see typing here.
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!saving) { done.current = true; onCancel(); } }
    // Enter in a field saves. On a button it does what the button says (Cancel cancels, Save saves): left to the button's own click.
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void save(); }
  };
  return <div className="pw-rename" data-layout={layout} role="group" aria-label="Rename session" onKeyDown={keys} onClick={event => event.stopPropagation()}>
    <input ref={first} className="input pw-rename-name" aria-label="Session name" placeholder="Name this session" maxLength={SESSION_NAME_MAX}
      value={name} disabled={saving} onChange={event => setName(event.target.value)} />
    <input className="input pw-rename-description" aria-label="Session description" placeholder="What is this session for? (optional)" maxLength={SESSION_DESCRIPTION_MAX}
      value={description} disabled={saving} onChange={event => setDescription(event.target.value)} />
    <span className="pw-rename-buttons">
      <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void save(); }}><i className="ph ph-check" aria-hidden="true" />Save</button>
      <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => { done.current = true; onCancel(); }}>Cancel</button>
    </span>
    {error && <p className="detail-error pw-rename-error" role="alert">{error}</p>}
  </div>;
}

/** The "Rename" button of a card or the session bar: a pencil and the word. */
export function RenameButton({ onClick, disabled, className = 'btn btn-ghost' }: { readonly onClick: () => void; readonly disabled?: boolean; readonly className?: string }) {
  return <button type="button" className={className} disabled={disabled} title="Give this session a name you will recognise" onClick={onClick}>
    <i className="ph ph-pencil-simple" aria-hidden="true" />Rename</button>;
}
