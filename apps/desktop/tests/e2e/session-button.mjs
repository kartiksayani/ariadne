// Finds a session's name button on All sessions. All sessions lists every registered project's sessions, so a session
// not on screen is reached from the switcher's "All sessions" link.
const loadingNotes = ['Loading sessions…', 'Loading registered projects and sessions…'];

/** 'found' when the button is listed, 'settled' when All sessions finished loading without it. */
export function sessionListingState(selector, notes) {
  if (document.querySelector(selector)) return 'found';
  const loading = [...document.querySelectorAll('[role="status"]')].some(node => notes.includes(node.textContent.trim()));
  return !loading && document.querySelector('[role="region"][aria-label="All sessions"]') ? 'settled' : 'loading';
}

const settle = selector => browser.waitUntil(async () => {
  const state = await browser.execute(sessionListingState, selector, loadingNotes);
  return state === 'loading' ? false : state;
}, { timeout: 20000, interval: 100, timeoutMsg: `All sessions did not finish listing sessions while looking for ${selector}` });

async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.click(); }

/** Returns the session's displayed, enabled name button; the caller clicks it. */
export async function openSessionButton(sessionId) {
  const selector = `button[data-session-id="${sessionId}"]`;
  const ready = async () => { const button = await browser.$(selector); await button.waitForDisplayed(); await button.waitForEnabled(); return button; };
  if (await browser.$(selector).isExisting()) return ready();
  await click(await browser.$('button[data-popover-trigger="switcher"]'));
  const allSessions = await browser.$('.swm').$('button=All sessions');
  await click(allSessions);
  if (await settle(selector) === 'found') return ready();
  throw new Error(`All sessions does not list session ${sessionId}`);
}

/** Finds and clicks the session's button, looking again if the list redraws between finding and clicking. */
export async function openSession(sessionId) {
  for (let attempt = 1; ; attempt++) {
    try { await click(await openSessionButton(sessionId)); return; }
    catch (error) { if (attempt === 3) throw error; }
  }
}
