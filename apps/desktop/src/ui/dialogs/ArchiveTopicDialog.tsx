// Archive a topic (10.13): always asks. It counts the questions waiting on the owner that leave with it; everything
// else stays, and unsent messages it cancels keep their words ("Put back in reply box" / Copy).
import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import { itemRemoved } from '../../selectors/removed';
import { waitingOnOwner } from '../../selectors/sessionClosed';
import { DialogActions, DialogButton, DialogError, DialogFrame, DialogText, DialogTitle, DialogWarn } from './DialogFrame';

/** Questions waiting on the owner in the topic: they leave Waiting on me with it. */
export const archiveWaiting = (session: Immutable<Session>, topicId: string): number =>
  Object.values(session.items).filter(item => item?.topic_id === topicId && !itemRemoved(session, item.id) && waitingOnOwner(session, item)).length;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function ArchiveTopicDialog({ name, items, waiting, agent, busy, error, onConfirm, onCancel }: {
  readonly name: string; readonly items: number; readonly waiting: number; readonly agent: string;
  readonly busy: boolean; readonly error: string | null; readonly onConfirm: () => void; readonly onCancel: () => void;
}) {
  const title = `Archive the “${name}” topic?`;
  return <DialogFrame label={title} onCancel={onCancel}>
    <DialogTitle>{title}</DialogTitle>
    <DialogText>It leaves the Map, and its questions leave Waiting on me. {items === 1 ? 'Its item and its history stay' : `All ${plural(items, 'item')} and their history stay`},
      and you can restore it any time from Archive. Nothing is sent to {agent}.</DialogText>
    {waiting > 0 && <DialogWarn>{plural(waiting, 'question')} waiting on you {waiting === 1 ? 'goes' : 'go'} with it, unanswered, and {waiting === 1 ? 'comes' : 'come'} back when you restore it.</DialogWarn>}
    {error && <DialogError>{error}</DialogError>}
    <DialogActions>
      <DialogButton kind="ghost" kbd="esc" onClick={onCancel}>Cancel</DialogButton>
      <DialogButton kind="primary" icon="ph ph-archive" disabled={busy} autoFocus onClick={onConfirm}>Archive topic</DialogButton>
    </DialogActions>
  </DialogFrame>;
}
