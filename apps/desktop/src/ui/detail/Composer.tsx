// The owner's composer in Details: one box per draft of the owner's words, labelled by what the words go out as. It serves an
// item (plain or waiting) and, next, a topic. The drafts, the submit lock and the keys belong to the caller; this draws them.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SessionActions } from '../../components/bindings/actions';
import { PausedNote } from '../../components/bindings/DispatchChip';
import { useGrow } from '../answer/useGrow';
import { changedText } from './AnswerSlot';
import { boxText, type WordsKind } from './model';
import type { Words } from './submit';

/** What the composer is for: a plain item, a waiting item (the answer's neighbour), or a topic. */
export type ComposerKind = 'plain' | 'waiting' | 'topic';

const kindName: Readonly<Record<WordsKind, string>> = { reply: 'reply', note: 'note', followup: 'follow-up' };

export interface WordsFieldProps {
  readonly slot: Words;
  /** What the words go out as now. */
  readonly sentAs: WordsKind;
  readonly first: boolean;
  /** Hands the box's textarea to the panel, so a key can focus the draft it names. */
  readonly register: (element: HTMLTextAreaElement | null) => void;
  readonly sendOff: boolean;
  /** The box was opened by a button and holds no words: it can be closed. */
  readonly closable: boolean;
  readonly onEdit: (text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onReview: () => void;
}

/**
 * One draft of the owner's words. It edits its own draft in place and is labelled by what it will be sent as, so the
 * owner sees the kind before sending. Its mount does not depend on the section around it, so typing and focus survive
 * the item changing status.
 */
export function WordsField({ slot, sentAs, first, register, sendOff, closable, onEdit, onKeyDown, onSend, onCancel, onReview }: WordsFieldProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const attach = (element: HTMLTextAreaElement | null) => { ref.current = element; register(element); };
  useGrow(ref, slot.text, !collapsed);
  // A locked draft (an attempt in flight or awaiting a retry) goes out as the kind it was saved with: its label, button and
  // hint name that kind, and it carries no note about a change.
  const kind = slot.locked ? slot.kind : sentAs, text = boxText[kind], noteId = useId();
  const note = slot.kind !== sentAs && !slot.locked;
  return <>
    {slot.changed && <div className="answer-warn" role="alert"><i className="ph ph-warning" aria-hidden="true" /><span>{changedText}</span>
      <button type="button" className="btn btn-secondary answer-warn-action" disabled={slot.locked} onClick={onReview}>Review this question</button></div>}
    <div className={`detail-box${collapsed ? ' detail-box-collapsed' : ''}`}>
      {note && <p className="detail-box-note" id={noteId}>{`This will be sent as a ${kindName[sentAs]}, which fits the item now. You wrote it as a ${kindName[slot.kind]}.`}</p>}
      <div className="detail-composer-row">
        <textarea ref={attach} className="input" rows={1} aria-label={first ? text.label : `${text.label}, another draft`} aria-describedby={note ? noteId : undefined}
          placeholder={text.placeholder} value={slot.text} disabled={slot.locked} onFocus={() => setCollapsed(false)}
          onChange={event => { setCollapsed(false); onEdit(event.target.value); }} onKeyDown={event => { if (event.key === 'Escape') setCollapsed(true); onKeyDown(event); }} />
        <button type="button" className="btn btn-primary" disabled={sendOff} aria-label={first ? text.button : `${text.button}, another draft`} onClick={onSend}>
          <i className="ph ph-paper-plane-right" aria-hidden="true" />{text.button}</button>
        {closable && <button type="button" className="btn btn-ghost detail-cancel" onClick={onCancel}>Cancel</button>}
      </div>
      <span className="detail-box-hint" title={text.hint}>⌘↵ sends · Esc keeps draft</span>
    </div>
  </>;
}

export interface ComposerProps {
  readonly kind: ComposerKind;
  /** Marks the composer for the keyboard and the native tests (`data-owner-input`): the item id, or the topic id. */
  readonly ownerKey: string;
  readonly actions: SessionActions;
  /** What the words go out as now; null when nothing can be sent (read-only), so no box shows. */
  readonly sentAs: WordsKind | null;
  /** The drafts to show, oldest first, or the one empty box. */
  readonly slots: readonly Words[];
  /** The mount key of a draft's box, stable while it gets its first keystroke. */
  readonly slotKey: (slot: Words) => string;
  /** The one submit lock: nothing goes out while this says yes. */
  readonly sendOff: (slot: Words) => boolean;
  readonly closable: boolean;
  /** Hands a box's textarea to the caller, keyed by `slotKey`, or null when it unmounts. */
  readonly register: (key: string, element: HTMLTextAreaElement | null) => void;
  readonly onEdit: (slot: Words, text: string) => void;
  readonly onKeyDown: (slot: Words) => (event: KeyboardEvent<HTMLElement>) => void;
  readonly onSend: (slot: Words) => void;
  readonly onCancel: () => void;
  readonly onReview: (slot: Words) => void;
  /** Above the boxes (a stale-reopen warning). */
  readonly before?: ReactNode;
  /** Below the boxes (the drop editor). */
  readonly children?: ReactNode;
}

/** The owner's boxes, in one place whatever section sits above, so a box keeps its mount (focus, caret) across status changes. */
export function Composer({ kind, ownerKey, actions, sentAs, slots, slotKey, sendOff, closable, register, onEdit, onKeyDown, onSend, onCancel, onReview, before, children }: ComposerProps) {
  return <section className="detail-section detail-open" aria-label="Your message">
    <div className="detail-owner-input" data-owner-input={ownerKey} data-composer={kind}>
      <PausedNote actions={actions} />
      {before}
      {sentAs && slots.map((slot, index) => <WordsField key={slotKey(slot)} slot={slot} sentAs={sentAs} first={index === 0} sendOff={sendOff(slot)}
        register={element => register(slotKey(slot), element)}
        closable={closable} onEdit={value => onEdit(slot, value)} onKeyDown={onKeyDown(slot)} onSend={() => onSend(slot)} onCancel={onCancel}
        onReview={() => onReview(slot)} />)}
      {children}
    </div>
  </section>;
}
