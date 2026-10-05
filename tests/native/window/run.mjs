// Bounded production Mac2 supplement. No build, test bridge, DOM execution,
// permission grant, notification action or external provider is composed here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { preparePackagedRoutes, packagedOwnership, packagedPids, packagedRouteSelected } from '../../../scripts/check-release-boundary.mjs';
import { repo, command, json, digest, portFree, identity, alive, delay, stop, waitForQuitExit, sourceState } from '../../../scripts/run-native-e2e.mjs';
import { assertReleaseArtifacts, assertContinuity, assertGeometry, assertPin, assertRestored, assertQuit } from './assertions.mjs';
import { withCancellation } from './cancellation.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const CLOSE = "//XCUIElementTypeButton[@identifier='_XCUI:CloseWindow']";
const MINIMIZE = "//XCUIElementTypeButton[@identifier='_XCUI:MinimizeWindow']";
const TRAY = "//XCUIElementTypeMenuBarItem[.//XCUIElementTypeMenuItem[@title='Show Ariadne']]";
const menu = title => `//XCUIElementTypeMenuItem[@title='${title}']`;

async function until(check, label, timeout = 20000, signal) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await check();
    signal?.throwIfAborted();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`${label} did not complete before its deadline`);
}

function mac2Client(trace, signal) {
  let session;
  async function request(method, path, payload, cleanup = false) {
    const response = await globalThis.fetch(`http://127.0.0.1:4723${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: cleanup ? globalThis.AbortSignal.timeout(30000) : globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30000)]),
    });
    const result = await response.json();
    trace.push({ method, path, request: payload, response: result });
    assert.ok(response.ok && !result.value?.error, `Mac2 command failed: ${JSON.stringify(result)}`);
    return result.value;
  }
  const scoped = (method, path, payload) => request(method, `/session/${session}${path}`, payload);
  const elements = xpath => scoped('POST', '/elements', { using: 'xpath', value: xpath });
  async function unique(xpath) {
    const found = await elements(xpath);
    assert.equal(found.length, 1, `Expected one genuine AX element for ${xpath}; inspect retained source`);
    return found[0][ELEMENT];
  }
  const click = elementId => scoped('POST', '/execute/sync', { script: 'macos: click', args: [{ elementId }] });
  return {
    async attach(fixture, bundleId) {
      const value = await request('POST', '/session', { capabilities: { alwaysMatch: {
        platformName: 'mac', 'appium:automationName': 'mac2',
        'appium:webDriverAgentMacUrl': 'http://127.0.0.1:10100',
        'appium:bundleId': bundleId, 'appium:appPath': fixture.application,
        'appium:noReset': true, 'appium:skipAppKill': true, 'appium:newCommandTimeout': 120,
      }, firstMatch: [{}] } });
      session = value.sessionId;
      assert.ok(session, 'Mac2 returned no session');
    },
    async detach() { if (session) { await request('DELETE', `/session/${session}`, undefined, true); session = undefined; } },
    source: () => scoped('GET', '/source'),
    unique, click,
    async closeVisible() {
      const found = await elements(CLOSE);
      assert.ok(found.length <= 1, 'Multiple native windows are not this bounded fixture');
      return found.length === 1 && await scoped('GET', `/element/${found[0][ELEMENT]}/attribute/hittable`) === 'true';
    },
    async rectangle() { return scoped('GET', `/element/${await unique('//XCUIElementTypeWindow')}/rect`); },
    async moveTitle() {
      const title = await unique("//XCUIElementTypeWindow/XCUIElementTypeStaticText[@value='Ariadne' or @title='Ariadne']");
      assert.equal(await scoped('GET', `/element/${title}/attribute/hittable`), 'true', 'Native title is not hittable');
      const rect = await scoped('GET', `/element/${title}/rect`);
      const startX = rect.x + rect.width / 2, startY = rect.y + rect.height / 2;
      return scoped('POST', '/execute/sync', { script: 'macos: clickAndDrag', args: [{ duration: 0.2, startX, startY, endX: startX + 16, endY: startY + 16 }] });
    },
    async openTray() { await click(await unique(TRAY)); },
    async choose(title) { await click(await unique(menu(title))); },
    async pinSelected() {
      const selected = await scoped('GET', `/element/${await unique(menu('Pin'))}/selected`);
      assert.equal(typeof selected, 'boolean', 'Mac2 has no genuine Pin check-state observation');
      return selected;
    },
  };
}

export const checkPhysicalWindow = options => withCancellation(signal => runPhysicalWindow(options, signal));

async function runPhysicalWindow({ bundle, cli, tools, releaseEvidence }, signal) {
  assert.equal(process.platform, 'darwin', 'Physical window acceptance requires macOS');
  for (const path of [bundle, cli, tools, releaseEvidence]) assert.ok(path && resolve(path) === path, 'Use explicit absolute fixture/tool/evidence paths');
  for (const port of [4723, 10100]) await portFree(port);
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const release = await readJson(join(releaseEvidence, 'assertions.json'));
  const routes = await readJson(join(releaseEvidence, 'routes.json'));
  const cleanup = await readJson(join(releaseEvidence, 'cleanup.json'));
  const buildRun = await readJson(join(releaseEvidence, 'run.json'));
  assertReleaseArtifacts(release, routes, cleanup, await digest(join(bundle, 'Contents/MacOS/ariadne-desktop')), await digest(cli));
  const evidence = join(repo, 'coverage/native-window', randomUUID());
  const root = await mkdtemp('/private/tmp/ariadne-window-');
  const data = await mkdtemp('/private/tmp/ariadne-window-data-');
  const trace = [], services = [], launches = [];
  const client = mac2Client(trace, signal);
  const wait = (check, label, timeout) => until(check, label, timeout, signal);
  let fixture, child, primary, ownership, failure, cleanupFailure;
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/private/tmp' };
  function launch(binary, args, environment, label, collection) {
    signal.throwIfAborted();
    const processChild = spawn(binary, args, { env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const owned = { child: processChild, label, logs: '', error: undefined };
    processChild.once('error', error => { owned.error = error; });
    for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', chunk => { owned.logs += chunk; });
    collection.push(owned);
    return processChild;
  }
  async function ready(port, processChild) {
    await wait(async () => {
      assert.ok(alive(processChild.pid), `Owned service ${port} exited`);
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${port}/status`, { signal: globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(1000)]) });
        return response.ok && (await response.json()).value;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SyntaxError) throw error;
        return false;
      }
    }, `Service ${port} readiness`, 60000);
  }
  async function snapshot() {
    signal.throwIfAborted();
    const preferences = JSON.parse(await readFile(fixture.preferencesPath, 'utf8')).snapshot;
    assert.ok(packagedRouteSelected(preferences, fixture.coldRoute), 'Canonical registered selection was lost');
    return { primary: identity(child.pid), ownership: await packagedOwnership(data, child, primary, ownership),
      preferences, sessionSha256: await digest(fixture.sessionPath) };
  }
  async function capture(label) {
    await writeFile(join(evidence, `${label}.xml`), await client.source());
    const observed = await snapshot();
    await json(join(evidence, `${label}.json`), observed);
    return observed;
  }
  async function launchApplication(args) {
    child = launch(fixture.binary, args, fixture.env, `application-${launches.length + 1}`, launches);
    await wait(async () => {
      assert.ok(alive(child.pid), 'Private production App exited during startup');
      try {
        const socket = await stat(join(data, 'run/control.sock'));
        assert.ok(socket.isSocket(), 'Private control path is not a socket');
        return packagedRouteSelected(JSON.parse(await readFile(fixture.preferencesPath, 'utf8')).snapshot, fixture.coldRoute);
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }, 'Ordinary production route');
    primary = identity(child.pid);
    assert.equal(primary.exe, fixture.binary);
    ownership = await packagedOwnership(data, child, primary);
    assert.deepEqual(packagedPids(fixture.binary), [child.pid], 'Mac2 fixture has additional private application processes');
  }
  async function quit(label) {
    await client.openTray(); await client.choose('Quit Ariadne');
    await waitForQuitExit(fixture.binary, primary);
    const lease = join(data, 'run/runtime.lock');
    await command('python3', ['-c', 'import fcntl,sys\nwith open(sys.argv[1],"r+b") as lock: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\n', lease], { timeout: 10000 });
    let socketAbsent = false;
    try { await stat(join(data, 'run/control.sock')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; socketAbsent = true; }
    const result = { primary, pidExited: !alive(primary.pid), remainingPids: packagedPids(fixture.binary),
      socketAbsent, leaseReleased: true, sessionUnchanged: (await readFile(fixture.sessionPath)).equals(fixture.before) };
    assertQuit(result); await json(join(evidence, `${label}.json`), result);
    await client.detach();
  }
  try {
    signal.throwIfAborted();
    fixture = await preparePackagedRoutes(cli, bundle, root, data, env);
    signal.throwIfAborted();
    const bundleId = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(fixture.application, 'Contents/Info.plist')])).stdout.trim();
    const project = join(tools, 'node_modules/appium-mac2-driver/WebDriverAgentMac/WebDriverAgentMac.xcodeproj');
    const wdaArgs = ['test-without-building', '-project', project, '-scheme', 'WebDriverAgentRunner', '-derivedDataPath', join(tools, 'wda-derived-data'),
      '-destination', 'platform=macOS', '-parallel-testing-enabled', 'NO', 'COMPILER_INDEX_STORE_ENABLE=NO'];
    const wda = launch('/usr/bin/xcodebuild', wdaArgs, { ...process.env, USE_HOST: '127.0.0.1', USE_PORT: '10100' }, 'wda', services);
    await json(join(evidence, 'run.json'), { source: sourceState(), bundle, cli, tools, root, data, bundleId, releaseEvidence, compiledSource: buildRun.toolchain?.source,
      binarySha256: await digest(fixture.binary), helperSha256: await digest(fixture.cli), wdaCommand: ['/usr/bin/xcodebuild', ...wdaArgs],
      unproved: ['Physical monitor disconnect/clamping', 'Genuine system sleep/wake', 'Dock reopen', 'Native always-on-top overlap', 'Quit during active external host turn', 'Any new OS authorization'] });
    await ready(10100, wda);
    const appium = launch(join(tools, 'appium-local'), ['--address', '127.0.0.1', '--port', '4723', '--use-drivers', 'mac2', '--log-no-colors'], process.env, 'appium', services);
    await ready(4723, appium);
    await launchApplication(['--ariadne-route', JSON.stringify(fixture.coldRoute)]);
    await client.attach(fixture, bundleId);
    // Attach must preserve the independently launched process, not silently replace it.
    await writeFile(join(evidence, 'initial-hierarchy.xml'), await client.source());
    const originalFrame = await client.rectangle();
    await client.moveTitle();
    const movedFrame = await client.rectangle();
    assert.ok(Math.abs(movedFrame.x - originalFrame.x) > 2 || Math.abs(movedFrame.y - originalFrame.y) > 2, 'XCTest title drag did not move the native window');
    await wait(async () => {
      const saved = (await snapshot()).preferences.global.window;
      return saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]) && Math.abs(saved[key] - movedFrame[key]) <= 2);
    }, 'Canonical moved geometry');
    const initial = await capture('initial');
    assert.deepEqual(initial.primary, primary);
    assert.equal(initial.preferences.global.pinned, false, 'Fresh private fixture was already pinned');
    assert.ok(await client.closeVisible(), 'Initial native close control is not hittable');
    assertGeometry(initial.preferences, await client.rectangle());
    for (const [label, control] of [['close', CLOSE], ['minimize', MINIMIZE]]) {
      await client.click(await client.unique(control));
      await wait(async () => !(await client.closeVisible()), `${label} removes the hittable window`);
      const hidden = await capture(label); assertContinuity(initial, hidden, fixture.coldRoute);
      await client.openTray(); await client.choose('Show Ariadne');
      await wait(() => client.closeVisible(), `Show after ${label}`);
      const shown = await capture(`show-after-${label}`); assertContinuity(hidden, shown, fixture.coldRoute);
      assertGeometry(shown.preferences, await client.rectangle());
    }
    const beforePin = await snapshot();
    await client.openTray(); assert.equal(await client.pinSelected(), false);
    await client.choose('Pin');
    await wait(async () => (await snapshot()).preferences.global.pinned === true, 'Canonical Pin commit');
    await client.openTray();
    const pinned = await capture('pinned'); pinned.menuSelected = await client.pinSelected();
    assertPin(beforePin, pinned, true, fixture.coldRoute);
    // Dismiss this inspected menu through the actual Show action before reopening Quit.
    await client.choose('Show Ariadne');
    await quit('quit-pinned');
    await launchApplication([]); await client.attach(fixture, bundleId);
    await wait(async () => {
      if (!(await client.closeVisible())) return false;
      const frame = await client.rectangle(), saved = pinned.preferences.global.window;
      return ['x', 'y', 'width', 'height'].every(key => Math.abs(frame[key] - saved[key]) <= 2);
    }, 'Restored native window geometry');
    const restored = await capture('restart');
    assertRestored(pinned, restored, await client.rectangle(), fixture.coldRoute);
    await client.openTray(); assert.equal(await client.pinSelected(), true);
    await client.choose('Show Ariadne');
    await quit('quit-restarted');
  } catch (error) {
    failure = error;
    try { await writeFile(join(evidence, 'failure.xml'), await client.source()); } catch { /* Session may not exist. */ }
    await json(join(evidence, 'failure.json'), { message: error.message });
  } finally {
    const cleanupErrors = [];
    try { await client.detach(); } catch (error) { cleanupErrors.push(error.message); }
    for (const owned of [...launches, ...services].reverse()) {
      try { await stop(owned.child); } catch (error) { cleanupErrors.push(`${owned.label}: ${error.message}`); }
      await writeFile(join(evidence, `${owned.label}.log`), owned.logs);
      if (owned.error) cleanupErrors.push(`${owned.label}: ${owned.error.message}`);
    }
    for (const port of [4723, 10100]) {
      try { await portFree(port); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (fixture && packagedPids(fixture.binary).length) cleanupErrors.push('Additional private App remains; preserved roots, no unowned signal');
    await json(join(evidence, 'command-trace.json'), trace);
    await json(join(evidence, 'cleanup.json'), { cleanupErrors, fixtureRoot: root, applicationData: data, rootsRetained: true,
      forcedCleanupIsNotQuitProof: true, launchPids: launches.map(owned => owned.child.pid), servicePids: services.map(owned => owned.child.pid) });
    if (cleanupErrors.length) cleanupFailure = new Error(`Owned cleanup failed: ${cleanupErrors.join('; ')}`);
  }
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
  signal.throwIfAborted();
  await json(join(evidence, 'result.json'), { passed: true,
    scope: 'Actual XCTest title drag/close/minimize, tray Show/Pin/Quit, canonical route/geometry/Pin persistence, production PID/socket/lease ownership and orderly restart.',
    heldExternalTurnProved: false, physicalMonitorChangeProved: false, genuineWakeProved: false, dockReopenProved: false, alwaysOnTopOverlapProved: false });
  console.log(`Physical window evidence: ${evidence}`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { bundle: { type: 'string' }, cli: { type: 'string' }, tools: { type: 'string' }, 'release-evidence': { type: 'string' } } });
  checkPhysicalWindow({ ...values, releaseEvidence: values['release-evidence'] }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
