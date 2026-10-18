// Closes Details the way the owner does now the head has no Close ×: "…" then "Close Details ( esc )".
import { fireEvent, screen } from '@testing-library/react';

const more = () => screen.getByRole('button', { name: 'More actions' });
const closeRow = () => screen.getByRole('menuitem', { name: /^Close Details/ });

export function closeDetails() {
  fireEvent.click(more());
  fireEvent.click(closeRow());
}

/** For tests whose own `click` wraps act and awaits the effects. */
export async function closeDetailsWith(click: (element: Element) => Promise<unknown> | unknown) {
  await click(more());
  await click(closeRow());
}
