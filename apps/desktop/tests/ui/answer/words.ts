// The answer cards' words box, reached the way the owner reaches it: "+ Add a note" on the picked card, else
// "Write my own answer". A free-text question shows its box straight away.
import { act, fireEvent } from '@testing-library/react';

/** The words box of the first answer control in `root`, opened if it is closed. Throws when there is none. */
export function answerWords(root: ParentNode = document): HTMLTextAreaElement {
  const box = () => root.querySelector<HTMLTextAreaElement>('.answer textarea');
  if (!box()) {
    const open = root.querySelector<HTMLButtonElement>('.answer .answer-note-link') ?? root.querySelector<HTMLButtonElement>('.answer [data-answer-own]');
    if (open) act(() => { fireEvent.click(open); });
  }
  const found = box();
  if (!found) throw new Error('No answer words box here.');
  return found;
}
