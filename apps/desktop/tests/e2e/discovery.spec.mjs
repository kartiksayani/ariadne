import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshot, admissions } from './scripted-provider.mjs';

// Invoked once inside the existing delivery phase, before its native Quit.
// Discovery uses a distinct empty project/thread; it cannot change the FIFO fixture.
export async function runDiscoveryAcceptance(configuration) {
  const { projectRoot, externalSessionId, socketPath } = configuration.discovery;
  const projectPath = join(projectRoot, '.ariadne/project.json');
  const sessionsPath = join(projectRoot, '.ariadne/sessions');
  const original = await snapshot(configuration);
  const queuedBefore = await admissions(configuration);
  const demoBefore = await readFile(configuration.demo.sessionPath);
  assert.equal(queuedBefore.length, 5);
  await assert.rejects(stat(projectPath), { code: 'ENOENT' });

  const projects = await browser.$('button=Projects');
  await projects.waitForEnabled(); await projects.click();
  const discover = await browser.$('button=Discover host sessions');
  await discover.waitForDisplayed(); await discover.click();
  const candidate = await browser.$(`[data-discovery-id="${externalSessionId}"]`);
  await candidate.waitForDisplayed({ timeout: 20000 });
  assert.ok((await candidate.getText()).includes('fresh'));
  assert.ok((await candidate.getText()).includes('daemon loaded'));
  await assert.rejects(stat(projectPath), { code: 'ENOENT' });
  const registerCandidate = await candidate.$('button=Register this project');
  await registerCandidate.waitForEnabled(); await registerCandidate.click();
  const registerDialog = await browser.$('[role="dialog"][aria-label="Register project"]');
  assert.equal(await registerDialog.$('input').getValue(), projectRoot);
  await assert.rejects(stat(projectPath), { code: 'ENOENT' });
  await registerDialog.$('button=Register project').click();
  await browser.waitUntil(async () => {
    try { return JSON.parse(await readFile(projectPath, 'utf8')).id !== undefined; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, { timeout: 15000, timeoutMsg: 'Explicit Register did not persist the discovered project' });
  const metadata = JSON.parse(await readFile(projectPath, 'utf8'));
  const connect = await browser.$('.nav-group-heading button=Connect existing session');
  await connect.waitForDisplayed(); await connect.waitForEnabled(); await connect.click();
  const dialog = await browser.$('[role="dialog"][aria-label="Connect existing session"]');
  const chosen = await dialog.$(`[data-discovery-id="${externalSessionId}"] button=Use host session`);
  await chosen.waitForEnabled(); await chosen.click();
  assert.equal(await dialog.$('label*=External session ID').$('input').getValue(), externalSessionId);
  assert.equal(await dialog.$('label*=Socket path').$('input').getValue(), socketPath);
  const beforeConnect = await readdir(sessionsPath).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.deepEqual(beforeConnect.filter(name => name.endsWith('.json')), []);
  await dialog.$('button=Connect existing session').click();
  let connected;
  await browser.waitUntil(async () => {
    const files = await readdir(sessionsPath).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const names = files.filter(name => name.endsWith('.json'));
    if (names.length !== 1) return false;
    connected = JSON.parse(await readFile(join(sessionsPath, names[0]), 'utf8'));
    return connected.active_binding_id !== null;
  }, { timeout: 20000, timeoutMsg: 'Explicit Connect did not persist the exact selected host identity' });
  assert.equal(connected.project_id, metadata.id);
  const binding = connected.bindings[connected.active_binding_id];
  assert.equal(binding.adapter_id, 'codex'); assert.equal(binding.external_session_id, externalSessionId);
  assert.deepEqual(binding.endpoint, { kind: 'unix_socket', path: socketPath });
  assert.equal(Object.keys(connected.inputs).length, 0);
  const after = await snapshot(configuration);
  assert.equal(after.active_binding_id, original.active_binding_id);
  assert.equal(after.bindings[configuration.bindingId].generation, configuration.generation);
  assert.deepEqual(Object.keys(after.inputs), Object.keys(original.inputs));
  assert.deepEqual(await admissions(configuration), queuedBefore);
  assert.deepEqual(await readFile(configuration.demo.sessionPath), demoBefore);
  await writeFile(join(process.env.ARIADNE_E2E_EVIDENCE, 'discovery-acceptance.json'), JSON.stringify({
    metadata, connected, candidateIdentity: { adapter_id: 'codex', external_session_id: externalSessionId, endpoint: binding.endpoint },
    originalBindingId: configuration.bindingId, originalGeneration: configuration.generation,
    beforeExplicitRegisterAbsent: true, beforeExplicitConnectEmpty: true, unchangedAdmissions: queuedBefore.length, demoUnchanged: true,
  }, null, 2));
}
