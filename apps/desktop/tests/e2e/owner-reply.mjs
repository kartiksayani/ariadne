import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { snapshot } from './scripted-provider.mjs';

// The detail's owner input for one item: the answer slot of a waiting item, else the open Reply box.
// Both write in a textarea and send with "Send reply".
const ownerInput = itemId => `[data-owner-input="${itemId}"]`;
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.scrollIntoView({ block: 'center' }); await control.click(); }

/** Rendered text with white space folded: the detail lays multi-line stored text out as one paragraph. */
export const folded = value => value.replace(/\s+/g, ' ').trim();

/**
 * Opens the selected item's reply editor. A waiting item answers in its answer slot, whose saved
 * receipt offers "Write another input"; an open item replies in its Reply box, which is always docked
 * and empties once it sends. `afterSaved`: a previous reply has saved on disk and its renderer
 * acknowledgement may still be arriving; await it before choosing the next editor.
 */
export async function openOwnerReply(afterSaved = false) {
  if (await browser.$('.item-detail .detail-answer-slot').isExisting()) {
    const another = await browser.$('.item-detail .detail-answer-slot').$('button=Write another input');
    if (afterSaved || await another.isExisting()) await click(another);
    return;
  }
  if (afterSaved) {
    // The Reply box stays docked on an open or in-progress item and empties once its words are saved. A box that is gone is no
    // proof of that: the item may be closed or archived, and pressing Reply there would only time out.
    let missing = false;
    try {
      await wait(async () => {
        const box = await browser.$('.item-detail .detail-box textarea');
        missing = !(await box.isExisting());
        return !missing && (await box.getValue()) === '';
      }, 'The sent Reply box did not empty');
    } catch (error) {
      if (missing) throw new Error('The sent Reply box is missing: the item shows no Reply box (closed, archived or changed?), so the helper cannot tell the reply was saved', { cause: error });
      throw error;
    }
  }
  if (!(await browser.$('.item-detail .detail-box textarea').isExisting())) {
    // Item actions carry their key hint ("Reply r"), so the button matches by contained text.
    const reply = await browser.$('[aria-label="Item actions"]').$('button*=Reply');
    if (!(await reply.isExisting())) throw new Error('The item shows no Reply box and offers no Reply button (closed, archived or waiting on another input?)');
    await click(reply);
  }
}

/**
 * Opens the extra Reply box of a waiting item whose answer is in flight: the answer slot is gone,
 * and the reply queues behind the held input (owner FIFO). `afterSaved`: a previous reply saved on
 * disk; its box closes before the next one opens.
 */
export async function openFollowUp(afterSaved = false) {
  if (afterSaved) await wait(async () => !(await browser.$('.item-detail .detail-box').isExisting()), 'The sent reply box did not close');
  if (!(await browser.$('.item-detail .detail-box textarea').isExisting())) {
    // This section holds the one action; its key hint ("r") follows the label.
    const addReply = await browser.$('.item-detail [aria-label="Reply"] [aria-label="Item actions"] button');
    await addReply.waitForDisplayed();
    if (!(await addReply.getText()).includes('Add a reply')) throw new Error('The reply section did not offer "Add a reply"');
    await click(addReply);
  }
}

export function replyControlState(itemId) {
  const form = document.querySelector(`[data-owner-input="${itemId}"]`);
  const editor = form?.querySelector('textarea');
  const send = [...(form?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Send reply');
  return { formPresent: Boolean(form), editorPresent: Boolean(editor), value: editor?.value ?? null,
    editorEnabled: Boolean(editor && !editor.disabled), sendPresent: Boolean(send), sendEnabled: Boolean(send && !send.disabled),
    alerts: [...(form?.querySelectorAll('[role="alert"], .answer-blocked, [role="status"]') ?? [])].map(node => node.textContent.trim()) };
}

export async function sendDetailReply(configuration, text) {
  let stage = 'editor', clickRequested = false;
  try {
    const selector = ownerInput(configuration.itemId);
    const editor = await browser.$(`${selector} textarea`);
    await editor.waitForDisplayed(); await editor.waitForEnabled(); await editor.setValue(text);
    const send = await (await browser.$(selector)).$('button=Send reply');
    await send.waitForDisplayed();
    stage = 'readiness';
    await browser.waitUntil(async () => await editor.getValue() === text && await editor.isEnabled() && await send.isEnabled(), {
      timeout: 20000, interval: 100, timeoutMsg: 'Detail Reply text and enabled Send were not ready for one click',
    });
    stage = 'click'; clickRequested = true; await send.click();
    stage = 'persistence';
    await browser.waitUntil(async () => Object.values((await snapshot(configuration)).inputs).some(input => input.payload.text === text), {
      timeout: 20000, interval: 100, timeoutMsg: 'Visible detail Reply did not save the exact owner text',
    });
  } catch (error) {
    try {
      const local = await browser.execute(replyControlState, configuration.itemId);
      const saved = await snapshot(configuration);
      const preferences = JSON.parse(await readFile(join(process.env.ARIADNE_HOME, 'ui.json'), 'utf8')).snapshot;
      await json(join(process.env.ARIADNE_E2E_EVIDENCE, 'reply-failure.json'), {
        stage, clickRequested, failure: error.message, expectedText: text, local,
        canonical: { sessionId: saved.id, revision: saved.revision, itemRevision: saved.items[configuration.itemId]?.revision,
          inputs: Object.values(saved.inputs).sort((a, b) => b.seq - a.seq).slice(0, 6).map(input => ({ id: input.id, seq: input.seq,
            kind: input.kind, state: input.state, textMatchesExpected: input.payload.text === text })) },
        preferences: { revision: preferences.revision, drafts: preferences.drafts.filter(draft => draft.session.session_id === configuration.sessionId
          && draft.target.item_id === configuration.itemId && draft.intent === 'reply').slice(-2).map(draft => ({ opId: draft.op_id,
          targetRevision: draft.target_revision, submissionAttempted: draft.submission_attempted, textMatchesExpected: draft.text === text })) },
      });
    } catch (evidenceError) {
      throw new AggregateError([error, evidenceError], `${error.message}; Reply failure evidence could not be retained`, { cause: evidenceError });
    }
    throw error;
  }
}
