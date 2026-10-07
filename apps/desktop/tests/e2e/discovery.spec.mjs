import assert from 'node:assert/strict';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshot, admissions } from './scripted-provider.mjs';

export async function waitForRegistrationCompletion(dialog, persisted, options) {
  // Core persistence can precede the receipt and awaited catalogue refresh.
  // The submitted form closes only when that ordinary UI operation completes.
  await browser.waitUntil(async () => await persisted() && !await dialog.isExisting(), options);
}

export async function waitForDiscoveredCandidate(candidate) {
  try {
    await candidate.waitForDisplayed({ timeout: 20000 });
  } catch (failure) {
    const evidence = process.env.ARIADNE_E2E_EVIDENCE;
    if (evidence) {
      const facts = { assertion: 'discovery-candidate-visible', capture_errors: [] };
      try {
        facts.view = await browser.execute(() => {
          const section = document.querySelector('section[aria-label="Discover host sessions"]');
          const texts = selector => [...(section?.querySelectorAll(selector) ?? [])]
            .slice(0, 16).map(element => element.textContent.slice(0, 4096));
          return {
            navigation_heading: document.querySelector('h1.pw-page-name')?.textContent.slice(0, 4096) ?? null,
            section_present: section !== null, section_hidden: section?.hidden ?? null,
            expanded: section?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
            status: texts('[role="status"]'), alerts: texts('[role="alert"]'),
            candidate_ids: [...(section?.querySelectorAll('[data-discovery-id]') ?? [])]
              .slice(0, 256).map(element => element.getAttribute('data-discovery-id').slice(0, 4096)),
          };
        });
      } catch { facts.capture_errors.push('view'); }
      try { await browser.saveScreenshot(join(evidence, 'discovery-failure.png')); }
      catch { facts.capture_errors.push('screenshot'); }
      try { await writeFile(join(evidence, 'discovery-failure.json'), JSON.stringify(facts, null, 2)); }
      catch { /* Evidence failure cannot replace the original native assertion. */ }
    }
    throw failure;
  }
}

// Invoked once inside the existing delivery phase, before its native Quit.
// Discovery uses a distinct empty project/thread; it cannot change the FIFO fixture.
export async function runDiscoveryAcceptance(configuration) {
  const { projectRoot, externalSessionId, socketPath } = configuration.discovery;
  // ADR-0082: the store lives at <data root>/projects/<project-id>; the project
  // id is only known once the registry maps this root, and the root itself must
  // never receive a store.
  const home = process.env.ARIADNE_HOME;
  const registeredId = async () => {
    try {
      const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'));
      const root = await realpath(projectRoot);
      return registry.projects.find(project => project.root === root)?.project_id;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const projectPath = async () => join(home, 'projects', await registeredId(), 'project.json');
  const sessionsPath = async () => join(home, 'projects', await registeredId(), 'sessions');
  const original = await snapshot(configuration);
  const queuedBefore = await admissions(configuration);
  const demoBefore = await readFile(configuration.demo.sessionPath);
  assert.equal(queuedBefore.length, 5);
  assert.equal(await registeredId(), undefined);
  await assert.rejects(stat(join(projectRoot, '.ariadne')), { code: 'ENOENT' });

  const projects = await browser.$('button=Projects');
  await projects.waitForEnabled(); await projects.click();
  const discover = await browser.$('button=Discover host sessions');
  await discover.waitForDisplayed(); await discover.click();
  const candidate = await browser.$(`[data-discovery-id="${externalSessionId}"]`);
  await waitForDiscoveredCandidate(candidate);
  assert.ok((await candidate.getText()).includes('fresh'));
  assert.ok((await candidate.getText()).includes('daemon loaded'));
  assert.equal(await registeredId(), undefined);
  await assert.rejects(stat(join(projectRoot, '.ariadne')), { code: 'ENOENT' });
  const registerCandidate = await candidate.$('button=Register this project');
  await registerCandidate.waitForEnabled(); await registerCandidate.click();
  const registerDialog = await browser.$('[role="dialog"][aria-label="Register project"]');
  assert.equal(await registerDialog.$('input').getValue(), projectRoot);
  assert.equal(await registeredId(), undefined);
  await assert.rejects(stat(join(projectRoot, '.ariadne')), { code: 'ENOENT' });
  await registerDialog.$('button=Register project').click();
  await waitForRegistrationCompletion(registerDialog, async () => {
    try { return JSON.parse(await readFile(await projectPath(), 'utf8')).id !== undefined; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, { timeout: 15000, timeoutMsg: 'Explicit Register did not persist the discovered project and dismiss its completed form' });
  const metadata = JSON.parse(await readFile(await projectPath(), 'utf8'));
  await assert.rejects(stat(join(projectRoot, '.ariadne')), { code: 'ENOENT' });
  const connect = await browser.$('.pw-group-head').$('button=Connect existing session');
  await connect.waitForDisplayed(); await connect.waitForEnabled(); await connect.click();
  const dialog = await browser.$('[role="dialog"][aria-label="Connect existing session"]');
  const chosen = await dialog.$(`[data-discovery-id="${externalSessionId}"]`).$('button=Use host session');
  await chosen.waitForEnabled(); await chosen.click();
  assert.equal(await dialog.$('label*=External session ID').$('input').getValue(), externalSessionId);
  assert.equal(await dialog.$('label*=Socket path').$('input').getValue(), socketPath);
  const sessionsDir = await sessionsPath();
  const beforeConnect = await readdir(sessionsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.deepEqual(beforeConnect.filter(name => name.endsWith('.json')), []);
  await dialog.$('button=Connect existing session').click();
  let connected;
  await waitForRegistrationCompletion(dialog, async () => {
    const files = await readdir(sessionsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const names = files.filter(name => name.endsWith('.json'));
    if (names.length !== 1) return false;
    connected = JSON.parse(await readFile(join(sessionsDir, names[0]), 'utf8'));
    return connected.active_binding_id !== null;
  }, { timeout: 20000, timeoutMsg: 'Explicit Connect did not persist the exact selected host identity and dismiss its completed form' });
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
