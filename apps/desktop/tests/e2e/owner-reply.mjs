import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '../../../../scripts/run-native-e2e.mjs';
import { snapshot } from './scripted-provider.mjs';

export function replyControlState(itemId) {
  const form = document.querySelector(`[aria-label="Owner input for #${itemId}"]`);
  const editor = form?.querySelector('textarea');
  const send = [...(form?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === 'Send reply');
  return { formPresent: Boolean(form), editorPresent: Boolean(editor), value: editor?.value ?? null,
    editorEnabled: Boolean(editor && !editor.disabled), sendPresent: Boolean(send), sendEnabled: Boolean(send && !send.disabled),
    alerts: [...(form?.querySelectorAll('[role="alert"], .ref-blocked, [role="status"]') ?? [])].map(node => node.textContent.trim()) };
}

export async function sendDetailReply(configuration, text) {
  let stage = 'editor', clickRequested = false;
  try {
    const selector = `[aria-label="Owner input for #${configuration.itemId}"]`;
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
