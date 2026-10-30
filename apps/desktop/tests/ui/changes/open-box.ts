import { fireEvent, within } from '@testing-library/react';

/** The change box's head button: caret, title and the changed field names (its name starts with the title). */
export const boxToggle = (box: HTMLElement) => within(box).getByRole('button', { name: /^Changed (at|since you looked)/u });

/** The change box starts collapsed; open it for a test that reads its rows. Clicks only when it is closed, so the helper is safe to repeat. */
export function openBox(box: HTMLElement): HTMLElement {
  if (boxToggle(box).getAttribute('aria-expanded') === 'false') fireEvent.click(boxToggle(box));
  return box;
}
