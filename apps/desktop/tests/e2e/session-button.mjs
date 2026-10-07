// Finds a session's "Open in a tab" / "Go to tab" button. All sessions lists
// only the projects with open tabs (handoff frame 1z), so a session in any other
// project is reached from its project page through Projects.
const loadingNotes = ['Loading sessions…', 'Loading registered projects and sessions…'];

/** 'found' when the button is listed, 'settled' when the page finished loading without it. */
export function sessionListingState(selector, notes) {
  if (document.querySelector(selector)) return 'found';
  const loading = [...document.querySelectorAll('[role="status"]')].some(node => notes.includes(node.textContent.trim()));
  return !loading && document.querySelector('.pw-session-lists, .pw-projects') ? 'settled' : 'loading';
}

const settle = selector => browser.waitUntil(async () => {
  const state = await browser.execute(sessionListingState, selector, loadingNotes);
  return state === 'loading' ? false : state;
}, { timeout: 20000, interval: 100, timeoutMsg: `The page did not finish listing sessions while looking for ${selector}` });

async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.click(); }

/** Returns the session's displayed, enabled card button; the caller clicks it. */
export async function openSessionButton(sessionId) {
  const selector = `button[data-session-id="${sessionId}"]`;
  const ready = async () => { const button = await browser.$(selector); await button.waitForDisplayed(); await button.waitForEnabled(); return button; };
  if (await settle(selector) === 'found') return ready();
  await click(await browser.$('button[data-shell-tab="projects"]'));
  await (await browser.$('.pw-project-open')).waitForDisplayed();
  const count = (await browser.$$('.pw-project-open')).length;
  for (let index = 0; index < count; index++) {
    if (index > 0) await click(await browser.$('button[data-shell-tab="projects"]'));
    await (await browser.$('.pw-project-open')).waitForDisplayed();
    await click((await browser.$$('.pw-project-open'))[index]);
    await (await browser.$('.pw-session-lists')).waitForDisplayed();
    if (await settle(selector) === 'found') return ready();
  }
  throw new Error(`No project page lists session ${sessionId}`);
}
