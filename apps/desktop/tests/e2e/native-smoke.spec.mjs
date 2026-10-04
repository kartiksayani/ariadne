import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { identity, listeners, json } from '../../../../scripts/run-native-e2e.mjs';
import { seedJourney, snapshot } from './scripted-provider.mjs';

const root = process.env.ARIADNE_E2E_ROOT;
const nonce = process.env.ARIADNE_E2E_NONCE;
const evidence = process.env.ARIADNE_E2E_EVIDENCE;
const receiptPath = join(root, 'smoke/receipt.json');
describe('native WebView, typed invoke and independently observed Rust file', () => {
  it('writes before acknowledgement, matches native PID and rejects without writing', async () => {
    const witness = JSON.parse(await readFile(join(root, 'startup.json'), 'utf8'));
    assert.equal(witness.nonce, nonce);
    const observed = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
    assert.equal(identity(witness.pid).exe, process.env.ARIADNE_E2E_BINARY);
    assert.equal(identity(witness.pid).birth, observed.birth);
    const launcher = JSON.parse(await readFile(join(root, 'launcher.json'), 'utf8'));
    assert.equal(observed.ancestry.at(-1).pid, launcher.pid);
    const sockets = listeners(Number(process.env.ARIADNE_E2E_PORT));
    assert.ok(sockets.includes(`p${witness.pid}\n`));
    const addresses = sockets.split('\n').filter(line => line.startsWith('n'));
    assert.ok(addresses.length > 0 && addresses.every(line => /^n(127\.0\.0\.1|\[::1\]):/.test(line)), 'Driver must bind only loopback');
    await assert.rejects(stat(receiptPath), { code: 'ENOENT' });
    const configuration = JSON.parse(await readFile(join(root, 'journey.json'), 'utf8'));
    const setup = await seedJourney(configuration);
    await browser.refresh();
    const sessionButton = await browser.$(`[data-session-id="${configuration.sessionId}"]`);
    await sessionButton.waitForDisplayed(); await sessionButton.click();
    const item = await browser.$(`[data-item-id="${configuration.itemId}"]`);
    await item.waitForDisplayed(); await item.click();
    const replyButton = await browser.$('[aria-label="Owner actions"] button=Reply');
    await replyButton.click();
    const editor = await browser.$('[aria-label="Owner input for #1"] textarea');
    const ownerText = `native-owner-${nonce}`;
    await editor.setValue(ownerText);
    await browser.$('button=Send reply').click();
    await browser.waitUntil(async () => {
      const session = await snapshot(configuration);
      return session.messages.some(message => message.author === 'owner' && message.body === ownerText)
        && Object.values(session.inputs).some(input => input.attempts.length > 0);
    }, { timeout: 20000, timeoutMsg: 'Actual owner Send did not persist and reach native provider queue' });
    const admitted = await snapshot(configuration);
    const ownerMessage = admitted.messages.find(message => message.author === 'owner' && message.body === ownerText);
    const input = admitted.inputs[ownerMessage.input_id];
    assert.equal(input.binding_id, configuration.bindingId);
    const queued = JSON.parse(await readFile(configuration.queuedPath, 'utf8'));
    assert.equal(queued.payload, input.attempts.at(-1).formatted_payload);
    assert.equal(input.attempts.at(-1).binding_generation, configuration.generation);
    await browser.waitUntil(async () => (await browser.$('body').getText()).includes('Sent'));
    await browser.saveScreenshot(join(evidence, 'native-sent.png'));
    const reply = `native-explicit-reply-${nonce}`;
    await writeFile(`${configuration.completePath}.tmp`, JSON.stringify({ reply }));
    await rename(`${configuration.completePath}.tmp`, configuration.completePath);
    await browser.waitUntil(async () => {
      const session = await snapshot(configuration);
      return session.inputs[input.id].state === 'handled'
        && session.messages.some(message => message.author === 'agent' && message.body === reply);
    }, { timeout: 20000, timeoutMsg: 'Explicit CLI result and matching host completion did not join' });
    await browser.waitUntil(async () => (await browser.$('body').getText()).includes(reply));
    await browser.saveScreenshot(join(evidence, 'native-webview.png'));
    const committed = await snapshot(configuration);
    const savedReceipt = Object.values(committed.operation_receipts).flat().find(receipt => receipt.result.data.kind === 'input_submit' && receipt.result.data.input_id === input.id);
    assert.ok(savedReceipt, 'Owner acknowledgement correlates with a real canonical saved receipt');
    assert.equal(committed.bindings[configuration.bindingId].generation, configuration.generation);
    // Retain the real typed diagnostic invoke/file/nonce proof without adding a
    // product debug form. Owner input above uses ordinary visible controls.
    const invokePing = request => browser.execute(async request => {
      try { return { ok: true, data: await window.__TAURI_INTERNALS__.invoke('native_ping', { request }) }; }
      catch (error) { return { ok: false, error }; }
    }, request);
    const payload = `native-domain-${Date.now()}`;
    const displayed = (await invokePing({ nonce, payload })).data;
    const bytes = await readFile(receiptPath), disk = JSON.parse(bytes);
    assert.deepEqual(displayed, disk);
    assert.equal(disk.nonce, nonce); assert.equal(disk.payload, payload); assert.equal(disk.pid, witness.pid);
    assert.match(disk.receipt_id, /^ping-\d+-\d+$/);
    const rejected = await invokePing({ nonce: nonce === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64), payload });
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'nonce_mismatch');
    await json(join(evidence, 'domain-journey.json'), { setup, configuration, ownerMessage, input: committed.inputs[input.id], savedReceipt, queued, reply, finalSession: committed });
    assert.deepEqual(await readFile(receiptPath), bytes);
    assert.deepEqual(await readdir(join(root, 'smoke')), ['receipt.json']);
    await json(join(evidence, 'assertions.json'), { passed: true, witness, observed, sockets, displayed, disk, receiptAbsentBeforeClick: true, wrongNonceRejected: true, receiptUnchangedAfterRejection: true, elementActions: 'Ordinary WKWebView session/item/owner Reply and Send controls; diagnostic ping invokes real IPC separately' });
  });
});
