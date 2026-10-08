// The quiet line under an owner message that was cancelled before it went out:
// taken back to edit ("Taken back to edit"), or by archiving a topic or closing
// the session. It says why it was not sent and offers "Put back in reply box",
// which loads its text into the item's (or the topic's) editor by the same safe
// rule as Edit (an existing draft is never overwritten; selectors/waiting/stuck
// `notSent`, held.ts `putBackCancelled`). Shown by every place that shows the
// line: the item's timeline and the message rail. The button goes once the same
// words were sent again.
import { useState } from 'react';
import { ReviewResult } from './StuckNote';
import type { ReviewOutcome } from './held';

export interface NotSentLineProps {
  /** "Taken back to edit", or "Not sent: cancelled when you archived this topic". */
  readonly line: string;
  /** Null when the text can't be put back (now, or at all); the line then says why when `restoreHint` is set. */
  readonly onPutBack: (() => Promise<ReviewOutcome>) | null;
  /** Why it can't be put back yet: restore the topic or reopen the session first. Null when nothing blocks it. */
  readonly restoreHint?: string | null;
  /** The owner already sent these same words again: the line says so, with no button. */
  readonly again?: boolean;
}

/** Where the words went, in the owner's terms. */
const putBackText = (outcome: ReviewOutcome) => outcome.kind !== 'moved' ? null
  : outcome.intent === 'topic_reply' ? 'Put back. Open “Reply to topic” on its topic to send it.'
    : outcome.intent === 'answer' ? 'Put back in the answer box.' : 'Put back in the reply box.';

export function NotSentLine({ line, onPutBack, restoreHint = null, again = false }: NotSentLineProps) {
  const [state, setState] = useState<{ readonly running: boolean; readonly outcome: ReviewOutcome | null }>({ running: false, outcome: null });
  const run = () => {
    if (!onPutBack || state.running) return;
    setState({ running: true, outcome: null });
    void onPutBack().then(outcome => setState({ running: false, outcome }), () => setState({ running: false, outcome: { kind: 'unavailable' } }));
  };
  const button = !!onPutBack && !again;
  // Once sent again, what put-back said is out of date.
  const outcome = again ? null : state.outcome, moved = outcome && putBackText(outcome);
  return <div className="excerpt-unsent">
    <span className="excerpt-note">{again ? `${line}. You sent it again.` : restoreHint ? `${line}. ${restoreHint}` : line}</span>
    {button && <button type="button" className="btn btn-ghost dispatch-action" disabled={state.running}
      title="Put your message back in the reply box. It won’t be sent until you send it." onClick={run}>Put back in reply box</button>}
    {moved && <span className="excerpt-note" role="status">{moved}</span>}
    {outcome && <ReviewResult outcome={outcome} />}
  </div>;
}
