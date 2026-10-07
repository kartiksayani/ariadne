// The answer control's place in the detail panel. WP2 builds the shared
// Answer Control (ui/answer/AnswerControl.tsx); until it lands this slot shows
// the legacy owner input in answer mode. `answer` is the full-mode props the
// shared control takes, computed by the detail model.
import { OwnerInput, type OwnerFocusRequest } from '../../components/inputs/OwnerInput';
import type { SessionStore } from '../../data/session-store';
import type { OwnerDraftStore } from '../../state/drafts/store';
import type { AnswerModel } from './model';

export interface AnswerSlotProps {
  readonly drafts: OwnerDraftStore;
  readonly store: SessionStore;
  readonly itemId: string;
  readonly answer: AnswerModel;
  readonly focusRequest?: OwnerFocusRequest;
  readonly onFocusRequestConsumed?: (token: number) => void;
  /** Esc in the control: leave it and return focus to the workspace. */
  readonly onEscape: () => void;
}

// The legacy input states its own blocked reason, so `answer` is unused here.
export function AnswerSlot({ drafts, store, itemId, focusRequest, onFocusRequestConsumed, onEscape }: AnswerSlotProps) {
  return <div className="detail-answer-slot">
    <OwnerInput drafts={drafts} session={store} itemId={itemId} initialIntent="answer"
      focusRequest={focusRequest?.intent === 'answer' ? focusRequest : undefined} onFocusRequestConsumed={onFocusRequestConsumed} onEscape={onEscape} />
  </div>;
}
