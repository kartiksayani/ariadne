// Standalone ordinary-release supplement. The desktop operator supplies the
// existing Mac2/WDA runtime; this entrypoint never builds or launches that runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { preparePackagedRoutes, packagedOwnership, packagedPids, packagedRouteSelected, verifyCleanup } from '../../../scripts/check-release-boundary.mjs';
import { repo, command, json, digest, portFree, identity, alive, delay, stop, waitForQuitExit, sourceState } from '../../../scripts/run-native-e2e.mjs';
import { startScriptedProvider, journeySeedRequest, snapshot, cliRequest, admissions } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import { notificationClient, named, literal } from './mac2.mjs';
import { GENERIC, arrivalRequest, assertClick, assertDeniedAnswer } from './assertions.mjs';

const CENTER = { bundleId: 'com.apple.notificationcenterui' };
const CLOSE = "//XCUIElementTypeButton[@identifier='_XCUI:CloseWindow']";
const detail = "//*[@label='Item detail' or @title='Item detail']";
const attributed = `.//XCUIElementTypeStaticText[@title='Ariadne' or @value='Ariadne' or @label='Ariadne']`;
const body = `.//XCUIElementTypeStaticText[@title=${literal(GENERIC)} or @value=${literal(GENERIC)} or @label=${literal(GENERIC)}]`;
// Require the same smallest native card to contain both app attribution and
// generic body. Another application's text can never authorize this click.
const notificationBody = `//XCUIElementTypeOther[${attributed} and ${body}][not(.//XCUIElementTypeOther[${attributed} and ${body}])]${named('StaticText', GENERIC).slice(1)}`;
const permissionAlert = "//XCUIElementTypeAlert[.//XCUIElementTypeStaticText[contains(@title,'Ariadne') or contains(@value,'Ariadne') or contains(@label,'Ariadne')]]";
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export function validateOptions({ bundle, cli, releaseEvidence, permission }) {
  for (const path of [bundle, cli, releaseEvidence]) assert.ok(path && resolve(path) === path, 'Use explicit absolute package/helper/release evidence paths');
  assert.ok(['allow', 'deny', 'existing'].includes(permission), 'Choose --permission allow|deny|existing explicitly after owner approval');
}

export async function checkNotifications(options) {
  validateOptions(options);
  assert.equal(process.platform, 'darwin', 'Physical notification acceptance requires macOS');
  const controller = new globalThis.AbortController();
  const interrupt = () => controller.abort(new Error('Notification acceptance interrupted'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try { return await run(options, controller.signal); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

async function run({ bundle, cli, releaseEvidence, permission }, signal) {
  const release = await readJson(join(releaseEvidence, 'assertions.json'));
  const routes = await readJson(join(releaseEvidence, 'routes.json'));
  assert.equal(release.passed, true); assert.equal(release.ordinaryRuntimeOwned, true); assert.equal(routes.passed, true);
  verifyCleanup(await readJson(join(releaseEvidence, 'cleanup.json')));
  assert.equal(await digest(join(bundle, 'Contents/MacOS/ariadne-desktop')), release.binarySha256, 'App differs from proved ordinary release');
  assert.equal(await digest(cli), routes.helperSha256, 'CLI differs from proved installed helper');
  for (const port of [4723, 10100]) {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/status`, { signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(5000)]) });
    assert.ok(response.ok, `The desktop operator must start the existing native runtime on ${port}`);
  }
  await portFree(4445);
  const root = await mkdtemp('/private/tmp/ariadne-notifications-');
  const data = join(root, 'data'), evidence = join(repo, 'coverage/native-notifications', randomUUID());
  const trace = [], client = notificationClient(trace, signal), observations = [];
  let fixture, provider, child, primary, ownership, failure, logs = '', spawnError;
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/private/tmp' };
  async function wait(check, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (child) { assert.ok(alive(child.pid), 'Owned packaged process exited unexpectedly'); if (primary) assert.deepEqual(identity(child.pid), primary); }
      const value = await check(); signal.throwIfAborted(); if (value) return value;
      await delay(100);
    }
    throw new Error(`${label} did not complete before its deadline`);
  }
  const preferences = async () => (await readJson(fixture.preferencesPath)).snapshot;
  async function capture(label) { await writeFile(join(evidence, `${label}.xml`), await client.source()); }
  async function captureTarget(label, xpath) {
    const targets = await client.elements(xpath), observed = [];
    for (const target of targets) {
      const id = target['element-6066-11e4-a52e-4f735466cecf'];
      observed.push({ id, title: await client.attribute(id, 'title'), value: await client.attribute(id, 'value'),
        label: await client.attribute(id, 'label'), hittable: await client.attribute(id, 'hittable') });
    }
    await json(join(evidence, `${label}.json`), observed);
  }
  async function visible() {
    const controls = await client.elements(CLOSE);
    assert.ok(controls.length <= 1, 'Private fixture unexpectedly has multiple native windows');
    return controls.length === 1 && await client.attribute(controls[0]['element-6066-11e4-a52e-4f735466cecf'], 'hittable') === 'true';
  }
  async function current(configuration, route) {
    const item = await client.elements(`${detail}${named('StaticText', `Item ${route.item_id}`).slice(1)}`);
    const question = await client.elements(`${detail}${named('StaticText', configuration.question).slice(1)}`);
    return { primary: identity(child.pid), ownership: await packagedOwnership(data, child, primary, ownership),
      preferences: await preferences(), sessionSha256: await digest(configuration.sessionPath), visible: await visible(),
      detailItem: item.length === 1 ? `Item ${route.item_id}` : undefined, questionVisible: question.length > 0 };
  }
  async function notification() {
    await client.activate(CENTER);
    await wait(async () => (await client.elements(notificationBody)).length === 1, 'One genuine generic Ariadne notification');
    // Never retain the system-wide Notification Center tree or unrelated cards.
    await captureTarget(`notification-${observations.length}`, notificationBody);
  }
  async function clickNotification(configuration, label, showFirst = false) {
    const route = { project_id: configuration.projectId, session_id: configuration.sessionId, item_id: configuration.itemId };
    await notification();
    if (showFirst) {
      await client.activate({ path: fixture.application });
      await wait(visible, 'Foreground native window before notification click');
      assert.equal(await client.appState(fixture.application), 4, 'Packaged App was not foreground before the click');
      await capture('foreground-before-click');
      // Physically open the menu-bar clock's Notification Center panel, rather
      // than invoking the Rust callback or starting another App instance.
      await client.activate({ bundleId: 'com.apple.controlcenter' });
      await client.click("//*[@identifier='com.apple.controlcenter.clock']");
      await notification();
    }
    const before = { primary, ownership, sessionSha256: await digest(configuration.sessionPath) };
    await client.click(notificationBody);
    // Observe focus restoration before switching the driver's AUT back to the
    // App. Driver activation itself must not stand in for notification behavior.
    await wait(async () => await client.appState(fixture.application) === 4, 'Actual notification focus restoration');
    await client.activate({ path: fixture.application });
    await wait(async () => {
      const observed = await current(configuration, route);
      return packagedRouteSelected(observed.preferences, route) && observed.visible && observed.detailItem && observed.questionVisible;
    }, `${label} notification current detail`);
    const after = await current(configuration, route); assertClick(before, after, route);
    await capture(`${label}-detail`); observations.push({ label, route, before, after });
    await json(join(evidence, `${label}.json`), observations.at(-1));
  }
  async function seed(configuration) {
    // Reuse the existing provider's real connection and question operations.
    // Its full smoke seed also publishes a second fixed-ID demo; the private
    // packaged layout already registered that demo, so do not duplicate it.
    const registered = await cliRequest(fixture.cli, ['project', 'register', '--json-stdin'], {
      session: null, command: { command: 'project_register', api_version: 1, op_id: randomUUID(), params: { canonical_root: configuration.project } },
    }, fixture.env);
    assert.equal(registered.code, 0, registered.output);
    const connected = await cliRequest(fixture.cli, ['binding', 'connect', '--json-stdin'], {
      session: null, command: { command: 'binding_connect', api_version: 1, op_id: randomUUID(), params: {
        project_id: registered.value.data.project_id, adapter_id: 'codex', external_session_id: configuration.thread,
        endpoint: { kind: 'unix_socket', path: configuration.socket }, configuration: { namespace: 'codex', values: {} }, existing_session_id: null,
      } },
    }, fixture.env);
    assert.equal(connected.code, 0, connected.output);
    const receipt = connected.value.data, binding = receipt.data;
    const question = journeySeedRequest(binding.binding_id);
    Object.assign(configuration, { projectId: registered.value.data.project_id, sessionId: receipt.session_id,
      bindingId: binding.binding_id, generation: binding.generation, sessionPath: join(configuration.project, '.ariadne/sessions', `${receipt.session_id}.json`),
      itemId: '1', question: question.question, ask: question.ask, options: question.options });
    const published = await cliRequest(fixture.cli, ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin', '--json'], question.request, fixture.env);
    assert.equal(published.code, 0, published.output);
    return { connected: connected.value, published: published.value, request: question.request };
  }
  try {
    await json(join(evidence, 'run.json'), { source: sourceState(), bundle, cli, releaseEvidence, root, data, permission,
      unproved: ['Cold notification launch with isolated HOME', 'Already-answered click', 'Burst grouping', 'Tray count parity'] });
    fixture = await preparePackagedRoutes(cli, bundle, root, data, env);
    provider = await startScriptedProvider(root, fixture.cli, evidence);
    const appArgs = ['--ariadne-route', JSON.stringify(fixture.coldRoute), ...provider.configuration.appArgs];
    signal.throwIfAborted();
    child = spawn(fixture.binary, appArgs, { env: fixture.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk; });
    await wait(async () => {
      if (spawnError) throw spawnError;
      try { const saved = await preferences(); return packagedRouteSelected(saved, fixture.coldRoute) && saved.global.notification_watermark; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }, 'Ordinary release route and genuine initial watermark');
    primary = identity(child.pid); assert.equal(primary.exe, fixture.binary);
    ownership = await packagedOwnership(data, child, primary);
    assert.deepEqual(packagedPids(fixture.binary), [child.pid]);
    const bundleId = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(fixture.application, 'Contents/Info.plist')])).stdout.trim();
    await client.attach(fixture, bundleId);
    await capture('initial');
    assert.equal((await preferences()).global.notification_preview ?? false, false, 'Private fixture previews must default off');
    if (permission !== 'existing') {
      await client.tray('Enable notifications…');
      await client.activate(CENTER);
      await wait(async () => (await client.elements(permissionAlert)).length === 1, 'Genuine Ariadne authorization prompt; existing permission is never reset');
      await captureTarget('permission-before', permissionAlert);
      await client.click(`${permissionAlert}${named('Button', permission === 'allow' ? 'Allow' : 'Don’t Allow').slice(1)}`);
      await wait(async () => (await client.elements(permissionAlert)).length === 0, 'Explicit authorization prompt completion');
      await client.activate({ path: fixture.application });
    }
    await client.click(CLOSE); await wait(async () => !await visible(), 'Hidden owned App before new waiting arrival');
    const setup = await seed(provider.configuration);
    await json(join(evidence, 'seed.json'), setup);
    if (permission === 'deny') {
      await client.activate({ path: fixture.application }); await client.tray('Show Ariadne');
      await wait(async () => (await client.elements(named('Button', 'Use the native window'))).length === 1, 'Denied-permission editable Waiting choice');
      await client.click(named('Button', 'Use the native window'));
      const text = `Denied notification answer ${randomUUID()}`;
      await client.type(named('TextView', 'Reply in your own words'), text);
      await client.click(named('Button', 'Send'));
      await wait(async () => (await admissions(provider.configuration)).length === 1, 'Denied-permission ordinary host admission');
      const saved = await snapshot(provider.configuration), queued = await admissions(provider.configuration);
      assertDeniedAnswer(saved, text, provider.configuration, queued);
      await capture('denied-answer'); await json(join(evidence, 'denied-answer.json'), { saved, queued, text });
    } else {
      await clickNotification(provider.configuration, 'hidden');
      await client.click(CLOSE); await wait(async () => !await visible(), 'Hidden App before foreground-case arrival');
      const request = arrivalRequest(provider.configuration.bindingId, randomUUID());
      const result = await cliRequest(fixture.cli, ['apply', '--binding', provider.configuration.bindingId, '--generation', provider.configuration.generation, '--json-stdin', '--json'], request, fixture.env);
      assert.equal(result.code, 0, result.output);
      const saved = await snapshot(provider.configuration), question = request.operations[1].question;
      const matches = Object.values(saved.items).filter(item => item.question === question); assert.equal(matches.length, 1);
      const second = { ...provider.configuration, itemId: matches[0].id, question };
      await json(join(evidence, 'foreground-arrival.json'), { request, receipt: result.value });
      await clickNotification(second, 'foreground', true);
    }
    await client.tray('Quit Ariadne');
    await waitForQuitExit(fixture.binary, primary); await portFree(4445);
    const quit = { pidExited: !alive(primary.pid), portFree: true, remainingPids: packagedPids(fixture.binary) };
    verifyCleanup(quit); await json(join(evidence, 'quit.json'), quit);
  } catch (error) {
    failure = error;
    // Failure can occur with Notification Center as AUT; retain only fixture
    // targets, avoiding unrelated system notifications or permission prompts.
    try { await captureTarget('failure-targets', notificationBody); } catch { /* Attachment may be unavailable. */ }
    await json(join(evidence, 'failure.json'), { message: error.message });
  } finally {
    const errors = [];
    try { await client.detach(); } catch (error) { errors.push(error.message); }
    if (child) { try { await stop(child); } catch (error) { errors.push(error.message); } }
    try { await provider?.stop(); } catch (error) { errors.push(error.message); }
    await writeFile(join(evidence, 'application.log'), logs);
    await json(join(evidence, 'command-trace.json'), trace);
    if (fixture && packagedPids(fixture.binary).length) errors.push('Private App remains; unowned processes were not signalled');
    await json(join(evidence, 'cleanup.json'), { errors, rootsRetained: true, root, data, pid: child?.pid, forcedCleanupIsNotQuitProof: true });
    if (errors.length) failure = new Error(`Notification cleanup failed: ${errors.join('; ')}; original: ${failure?.message ?? 'none'}`);
  }
  if (failure) throw failure;
  signal.throwIfAborted();
  await json(join(evidence, 'result.json'), { passed: true, permission,
    hiddenClickProved: permission !== 'deny', foregroundClickProved: permission !== 'deny', deniedAnswerProved: permission === 'deny',
    coldClickProved: false, alreadyAnsweredClickProved: false, p62Complete: false });
  console.log(`Physical notification evidence: ${evidence}`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { bundle: { type: 'string' }, cli: { type: 'string' }, 'release-evidence': { type: 'string' }, permission: { type: 'string' } } });
  checkNotifications({ ...values, releaseEvidence: values['release-evidence'] }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
