// Saving the owner's name and description of a session (ADR-0091); the Name dialog (ui/dialogs/NameSessionDialog) asks.
import { plainFailure } from '../../data';
import type { SessionActions } from '../../components/bindings/actions';

/** Saves the name and description through the session's write barrier; the owner's error in plain words, or null when saved. */
export async function saveSessionLabel(actions: SessionActions, revision: number, name: string, description: string): Promise<string | null> {
  const saved = await actions.execute({ command: 'session_label_set', api_version: 1, op_id: '',
    params: { name: name.trim() || null, description: description.trim() || null } }, revision);
  if (saved) return null;
  const error = actions.getSnapshot().error;
  return plainFailure(error, 'The name could not be saved. Try again.');
}
