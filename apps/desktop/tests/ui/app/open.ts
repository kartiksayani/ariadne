import { fireEvent, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

const enabled = (selector: string) => waitFor(() => {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull(); expect(button?.disabled).toBe(false); return button!;
});

/**
 * Finds a session's "Open in a tab" button. All sessions lists only projects
 * with open tabs (frame 1z), so the session is reached from its project page
 * when it is not listed where the app currently is.
 */
export async function sessionButton(route: { readonly project_id: string; readonly session_id: string }) {
  const selector = `button[data-session-id="${route.session_id}"]`;
  if (!document.querySelector(selector)) {
    fireEvent.click(await enabled('[data-shell-tab="projects"]'));
    fireEvent.click(await enabled(`[data-project-id="${route.project_id}"] .pw-project-open`));
  }
  return enabled(selector);
}
