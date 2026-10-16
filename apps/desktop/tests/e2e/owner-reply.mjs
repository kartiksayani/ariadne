import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { snapshot } from './scripted-provider.mjs';

// Only the marked input is active; a retained answer slot can coexist with the docked words box.
const ownerInput = itemId => `.item-detail [data-owner-input="${itemId}"]`;
const dockedEditor = '.item-detail [data-owner-input] .detail-box textarea';
// Scope to the textarea's composer: the answer slot also has a separate Send for the chosen option.
const wordsComposer = '.detail-box, .answer-reply';
const wordsSend = 'button[aria-label^="Send "], button.answer-reply-send';
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 20000, interval: 100, timeoutMsg: message });
async function click(control) { await control.waitForDisplayed(); await control.waitForEnabled(); await control.scrollIntoView({ block: 'center' }); await control.click(); }

/** Rendered text with white space folded: the detail lays multi-line stored text out as one paragraph. */
export const folded = value => value.replace(/\s+/g, ' ').trim();

/**
 * Opens the selected item's words editor: an answer, reply, note or follow-up as the current UI offers.
 * A waiting answer's saved receipt offers "Write another input"; open/in-progress boxes stay docked
 * and empty once they send. `afterSaved`: a previous input has saved on disk and its renderer
 * acknowledgement may still be arriving; await it before choosing the next editor.
 */
export async function openOwnerReply(afterSaved = false) {
  const docked = await browser.$(dockedEditor);
  const answer = await browser.$('.item-detail .detail-answer-slot[data-owner-input]');
  if (!(await docked.isExisting()) && await answer.isExisting()) {
    const another = await answer.$('button=Write another input');
    if (afterSaved || await another.isExisting()) await click(another);
    return;
  }
  // A waiting reply closes when saved; its Add a reply action opens the next queued input.
  if (await browser.$('.item-detail[data-status="waiting"] [aria-label="Reply"] [aria-label="Item actions"] button').isExisting()) {
    await openFollowUp(afterSaved);
    return;
  }
  if (afterSaved) {
    // The Reply box stays docked on an open or in-progress item and empties once its words are saved. A box that is gone is no
    // proof of that: the item may be closed or archived, and pressing Reply there would only time out.
    let missing = false;
    try {
      await wait(async () => {
        const box = await browser.$(dockedEditor);
        missing = !(await box.isExisting());
        return !missing && (await box.getValue()) === '';
      }, 'The sent Reply box did not empty');
    } catch (error) {
      if (missing) throw new Error('The sent Reply box is missing: the item shows no Reply box (closed, archived or changed?), so the helper cannot tell the reply was saved', { cause: error });
      throw error;
    }
  }
  if (!(await browser.$(dockedEditor).isExisting())) {
    // Titles omit the visible key hint and cover finished items' Follow up as well as replies/notes.
    const reply = await browser.$('.item-detail [aria-label="Item actions"] button[title="Reply in your own words"], .item-detail [aria-label="Item actions"] button[title="Add something while the agent works"], .item-detail [aria-label="Item actions"] button[title="Comment, or ask for more"]');
    if (!(await reply.isExisting())) throw new Error('The item shows no Reply box and offers no Reply button (closed, archived or waiting on another input?)');
    await click(reply);
  }
}

/**
 * Opens words behind a held input (owner FIFO). Waiting replies close after saving; open/in-progress
 * boxes stay docked and empty. `afterSaved` awaits that acknowledgement before using the next box.
 * The bigger conversation view (`.item-conversation`) keeps its one reply box docked even on a waiting item, so there
 * a saved reply shows as an empty, enabled box rather than a closed one.
 */
export async function openFollowUp(afterSaved = false) {
  const detail = await browser.$('.item-detail');
  if (await detail.getAttribute('data-status') !== 'waiting') return openOwnerReply(afterSaved);
  if (afterSaved) {
    if ((await detail.getAttribute('class')).split(/\s+/).includes('item-conversation')) {
      let missing = false;
      try {
        await wait(async () => {
          const box = await browser.$(dockedEditor);
          missing = !(await box.isExisting());
          return !missing && (await box.getValue()) === '' && await box.isEnabled();
        }, 'The sent reply box in the conversation view did not empty and re-enable');
      } catch (error) {
        // A box that is gone is not proof of a save: fall through to "Add a reply" below, which fails precisely if it is absent too.
        if (!missing) throw error;
      }
    } else await wait(async () => !(await browser.$('.item-detail [data-owner-input] .detail-box').isExisting()), 'The sent reply box did not close');
  }
  if (!(await browser.$(dockedEditor).isExisting())) {
    // This section holds the one action; its key hint ("r") follows the label.
    const addReply = await browser.$('.item-detail [aria-label="Reply"] [aria-label="Item actions"] button');
    await addReply.waitForDisplayed();
    if (!(await addReply.getText()).includes('Add a reply')) throw new Error('The reply section did not offer "Add a reply"');
    await click(addReply);
  }
}

export function replyControlState(itemId) {
  const form = document.querySelector(`.item-detail [data-owner-input="${itemId}"]`);
  const detail = form?.closest('.item-detail') ?? document.querySelector('.item-detail');
  // A reply box (.detail-box) or the answer cards (.answer: the words box opens from "Write my own answer" or "+ Add a note").
  const editor = form?.querySelector('textarea');
  const composer = editor?.closest('.detail-box, .answer') ?? form?.querySelector('.answer');
  const send = composer?.querySelector('button[aria-label^="Send "], button[data-answer-send]');
  return { formPresent: Boolean(form), editorPresent: Boolean(editor), value: editor?.value ?? null,
    editorEnabled: Boolean(editor && !editor.disabled), sendPresent: Boolean(send),
    sendEnabled: Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'),
    alerts: [...(detail?.querySelectorAll('[role="alert"], .answer-blocked, [role="status"]') ?? [])].map(node => node.textContent.trim()) };
}

export function replyDraftState(configuration, preferences, text) {
  const drafts = preferences.drafts.filter(draft => draft.session.session_id === configuration.sessionId
    && draft.target.item_id === configuration.itemId && ['answer', 'reply', 'note', 'followup'].includes(draft.intent));
  return { revision: preferences.revision, drafts: drafts.filter((draft, index) => draft.text === text || index >= drafts.length - 2)
    .map(draft => ({ opId: draft.op_id, targetRevision: draft.target_revision,
      submissionAttempted: draft.submission_attempted ?? null, textMatchesExpected: draft.text === text })) };
}

/** Freeze the completed publication this next owner input depends on, before opening its draft. */
export function ownerReplyTarget(session, itemId) {
  const item = session.items[itemId];
  if (!item) throw new Error(`No canonical reply target ${itemId}`);
  const previousMessage = session.messages.findLast(message => message.item_id === itemId);
  const agentMessage = session.messages.findLast(message => message.item_id === itemId && message.author === 'agent');
  return { itemId, revision: item.revision, questionRevision: item.question_revision, status: item.status,
    ask: item.ask, previousMessage: previousMessage ? { id: previousMessage.id, body: previousMessage.body, author: previousMessage.author } : null,
    agentMessage: agentMessage ? { id: agentMessage.id, body: agentMessage.body, author: agentMessage.author } : null };
}

/** A visible editor is insufficient: both disk and the selected renderer must show the expected target. */
export async function waitForOwnerReplyTarget(configuration, expected) {
  if (!expected || expected.itemId !== configuration.itemId || !Number.isSafeInteger(expected.revision)) {
    throw new Error('Owner reply requires an explicit canonical target before opening or typing');
  }
  await wait(async () => {
    const saved = await snapshot(configuration), item = saved.items[configuration.itemId];
    if (item?.revision !== expected.revision || item.question_revision !== expected.questionRevision
      || item.status !== expected.status || item.ask !== expected.ask) return false;
    if ([expected.previousMessage, expected.agentMessage].some(expectedMessage => expectedMessage
      && !saved.messages.some(message => message.id === expectedMessage.id && message.item_id === configuration.itemId
        && message.author === expectedMessage.author && message.body === expectedMessage.body))) return false;
    const detail = await browser.$('.item-detail');
    return await detail.getAttribute('data-detail-item-id') === configuration.itemId
      && await detail.getAttribute('data-item-revision') === String(expected.revision);
  }, `Owner reply target ${configuration.itemId} revision ${expected.revision} and expected agent change did not reach disk and detail`);
}

export async function sendDetailReply(configuration, text, expected) {
  let stage = 'target', clickRequested = false;
  try {
    await waitForOwnerReplyTarget(configuration, expected);
    stage = 'editor';
    const selector = ownerInput(configuration.itemId);
    const form = await browser.$(selector);
    await form.waitForExist();
    const composer = await form.$(wordsComposer);
    await composer.waitForExist();
    const editor = await composer.$('textarea');
    await editor.waitForDisplayed(); await editor.waitForEnabled(); await editor.setValue(text);
    const send = await composer.$(wordsSend);
    await send.waitForDisplayed();
    stage = 'readiness';
    await browser.waitUntil(async () => await editor.getValue() === text && await editor.isEnabled() && await send.isEnabled()
      && await send.getAttribute('aria-disabled') !== 'true', {
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
        stage, clickRequested, failure: error.message, expectedText: text, expectedTarget: expected, local,
        canonical: { sessionId: saved.id, revision: saved.revision, itemRevision: saved.items[configuration.itemId]?.revision,
          inputs: Object.values(saved.inputs).sort((a, b) => b.seq - a.seq).slice(0, 6).map(input => ({ id: input.id, seq: input.seq,
            kind: input.kind, state: input.state, textMatchesExpected: input.payload.text === text })) },
        preferences: replyDraftState(configuration, preferences, text),
      });
    } catch (evidenceError) {
      throw new AggregateError([error, evidenceError], `${error.message}; Reply failure evidence could not be retained`, { cause: evidenceError });
    }
    throw error;
  }
}
