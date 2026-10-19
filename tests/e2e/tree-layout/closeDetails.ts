import { expect, type Page } from '@playwright/test';

/**
 * Closes Details the way the owner does now the head has no Close ×: "…" in the Details head, then "Close Details ( esc )".
 * With `required` the head must be there; without it, a window with no Details open is left alone.
 */
export async function closeDetails(page: Page, required = false) {
  const more = page.getByRole('button', { name: 'More actions', exact: true });
  if (required) await expect(more).toBeVisible();
  else if (!(await more.count())) return;
  await more.click();
  await page.getByRole('menuitem', { name: /^Close Details/ }).click();
}
