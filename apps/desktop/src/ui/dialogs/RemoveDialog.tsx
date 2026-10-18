// Remove an item and what's below it (10.2) or a topic (10.14), Round 4 copy. The owner's words that go with it are
// quoted with Copy before anything runs (E27, E28); a topic continued in another session can only be archived (E34).
import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import { displayStatus } from '../../selectors/waiting/replied';
import { STATUS, statusColor, statusKey, type StatusKey } from '../shared/status';
import { shortLabel } from '../shared/short';
import { removedSubtree } from '../../selectors/removed';
import type { Pinned } from '../remove/queue';
import { wordsLabel, type FamilyCheck, type WordsEntry, type WordsRead } from '../remove/words';
import { DialogActions, DialogButton, DialogFrame, DialogNote, DialogQuote, DialogText, DialogTitle, DialogWarn } from './DialogFrame';
import { removePlacedCopy, removeSessionCopy, type RemoveSubject, type RemoveTarget } from './remove';
import './remove-dialog.css';

type Placed = Extract<RemoveTarget, { kind: 'item' | 'topic' }>;
export interface TogetherRow { readonly id: string; readonly name: string; readonly depth: number; readonly status: StatusKey }
/** What the owner reviews before a removal: the subject, what goes together, the words, and what the commit compares. */
export interface RemoveReview {
  readonly target: Placed;
  readonly subject: Extract<RemoveSubject, { kind: 'item' | 'topic' }>;
  readonly together: readonly TogetherRow[];
  readonly words: readonly WordsEntry[];
  readonly pinned: Pinned;
  /** An archived topic (removed from the Archive page): it can't be archived instead. */
  readonly archived: boolean;
}

/** "REMOVED TOGETHER": the item and everything below it, indented per level, with their statuses. */
export function togetherRows(session: Immutable<Session>, itemId: string): readonly TogetherRow[] {
  const items = new Map(removedSubtree(session, itemId).map(item => [item.id, item]));
  const rows: TogetherRow[] = [];
  const walk = (item: Immutable<Item>, depth: number) => {
    rows.push({ id: item.id, name: shortLabel(item), depth, status: statusKey[displayStatus(session, item)] });
    [...items.values()].filter(child => child.parent === item.id).sort((a, b) => a.ordinal - b.ordinal).forEach(child => walk(child, depth + 1));
  };
  const root = items.get(itemId);
  if (root) walk(root, 0);
  return rows;
}

/** The family test's state: still reading archived sessions, or its answer. */
export type FamilyState = 'checking' | FamilyCheck;

export function RemoveDialog({ review, family = null, onConfirm, onCancel, onArchiveInstead }: {
  readonly review: RemoveReview;
  /** Topics only: whether removing it would reach other sessions. */
  readonly family?: FamilyState | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onArchiveInstead?: () => void;
}) {
  const { subject, words } = review;
  const copy = removePlacedCopy(subject, { pending: words.filter(entry => entry.kind === 'input' && entry.state !== 'cancelled').length, any: words.length > 0 });
  const topic = subject.kind === 'topic';
  const blocked = topic && family !== null && family !== 'checking' && family.family;
  const checking = topic && family === 'checking';
  const confirm = () => { if (blocked || checking) return; onCancel(); onConfirm(); };
  const named = blocked && family.sessions.length ? family.sessions.map(name => `“${name}”`).join(', ') : null;
  return <DialogFrame label={copy.title} onCancel={onCancel}>
    <DialogTitle>{copy.title}</DialogTitle>
    {blocked
      ? <DialogWarn tone="danger">{named
        ? `“${subject.name}” continues in ${named}. Removing it here removes it there too, and your words in ${family.sessions.length === 1 ? 'that session' : 'those sessions'} can’t be shown here.`
        : `“${subject.name}” may continue in another session that Ariadne can’t check from here. Removing it would remove it there too, and words there can’t be shown here.`}</DialogWarn>
      : <>
        <DialogText>{copy.body}</DialogText>
        {copy.warn && <DialogWarn tone="danger">{copy.warn}</DialogWarn>}
        {!topic && <section className="rm-together" aria-label="Removed together">
          <div className="rm-together-head">Removed together</div>
          <ul>{review.together.map(row => <li key={row.id} style={{ paddingLeft: `${row.depth * 18}px` }}>
            <i className={STATUS[row.status].icon} style={{ color: statusColor(row.status) }} aria-hidden="true" />
            <span className="rm-together-name">{row.name}</span>
            <span className="rm-together-status" data-status={row.status}>{STATUS[row.status].label}</span>
          </li>)}</ul>
        </section>}
        {words.map(entry => <DialogQuote key={entry.key} label={wordsLabel(entry)} text={entry.text} />)}
      </>}
    {topic && !review.archived && <DialogNote icon="ph ph-archive">To keep it out of sight without losing anything, archive it instead.</DialogNote>}
    {checking && <DialogNote icon="ph ph-circle-notch">Checking other sessions…</DialogNote>}
    <DialogActions>
      {topic && !review.archived && onArchiveInstead && <DialogButton kind="ghost" left icon="ph ph-archive" onClick={() => { onCancel(); onArchiveInstead(); }}>Archive instead</DialogButton>}
      <DialogButton kind="ghost" kbd="esc" onClick={onCancel}>Cancel</DialogButton>
      {!blocked && <DialogButton kind="danger" icon="ph ph-trash" disabled={checking} onClick={confirm}>{copy.confirm}</DialogButton>}
    </DialogActions>
  </DialogFrame>;
}

/**
 * The words a session or project removal deletes (E27), read fresh when its dialog opens: null while reading. Each is
 * quoted with Copy; when a session couldn't be read the words can't be shown, so the removal can't go ahead.
 */
export function WholeWords({ read }: { readonly read: WordsRead | null }) {
  if (!read) return <DialogNote icon="ph ph-circle-notch">Reading your words…</DialogNote>;
  if (!read.complete) return <DialogWarn tone="danger">Ariadne couldn’t read every session in it, so your words there can’t be shown. Nothing is removed. Try again in a moment.</DialogWarn>;
  return <>{read.words.map(entry => <DialogQuote key={entry.key} label={wordsLabel(entry)} text={entry.text} />)}</>;
}
/** The removal can go ahead: every session was read and its words are on screen. */
export const wordsShown = (read: WordsRead | null) => !!read?.complete;
/** The warning's words part for `read`: how many haven't reached the agent, and whether any are quoted. */
export const wholeWords = (read: WordsRead | null) => ({ pending: read?.words.filter(entry => entry.kind === 'input' && entry.state !== 'cancelled').length ?? 0, any: !!read?.words.length });

/** Remove an archived session (Archive page): what goes and what stays, every word that goes quoted with Copy (E27). */
export function RemoveSessionDialog({ subject, words, onConfirm, onCancel }: {
  readonly subject: Extract<RemoveSubject, { kind: 'session' }>;
  readonly words: WordsRead | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const copy = removeSessionCopy(subject, wholeWords(words)), ready = wordsShown(words);
  return <DialogFrame label={copy.title} onCancel={onCancel}>
    <DialogTitle>{copy.title}</DialogTitle>
    <DialogText>{copy.body}</DialogText>
    {copy.warn && <DialogWarn tone="danger">{copy.warn}</DialogWarn>}
    <WholeWords read={words} />
    <DialogActions>
      <DialogButton kind="ghost" kbd="esc" autoFocus onClick={onCancel}>Cancel</DialogButton>
      <DialogButton kind="danger" icon="ph ph-trash" disabled={!ready} onClick={() => { if (!ready) return; onCancel(); onConfirm(); }}>{copy.confirm}</DialogButton>
    </DialogActions>
  </DialogFrame>;
}
