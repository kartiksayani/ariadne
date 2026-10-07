import { ConfirmDialog } from './ConfirmDialog';
import { removeCopy, type RemoveSubject } from './remove';

/** The danger confirmation for one Remove trigger; Confirm runs `onConfirm` and closes. */
export function RemoveDialog({ subject, onConfirm, onCancel }: { readonly subject: RemoveSubject; readonly onConfirm: () => void; readonly onCancel: () => void }) {
  const copy = removeCopy(subject);
  return <ConfirmDialog danger title={copy.title} body={copy.body} warn={copy.warn || undefined} confirmLabel={copy.confirm}
    onCancel={onCancel} onConfirm={() => { onCancel(); onConfirm(); }} />;
}
