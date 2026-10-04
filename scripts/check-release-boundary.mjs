import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, stat, cp, copyFile, chmod, symlink, realpath } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { repo, desktop, command, buildEnv, json, digest, toolchain, portFree, listeners, identity, alive, delay, stop } from './run-native-e2e.mjs';
export function resolvedNames(metadata) {
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg.name]));
  return metadata.resolve.nodes.map(node => packages.get(node.id));
}
export function mergedConfig(base, override) {
  if (override === null) return base;
  assert.deepEqual(Object.keys(override), ['bundle'], 'Unexpected compiler config override');
  for (const key of Object.keys(override.bundle)) {
    assert.ok(['active', 'icon'].includes(key), 'Unexpected bundle override');
    assert.deepEqual(override.bundle[key], base.bundle[key], 'Compiler override changed production config');
  }
  return { ...base, bundle: { ...base.bundle, ...override.bundle } };
}
export function verifyCleanup(record) {
  assert.equal(record.pidExited, true, 'Packaged PID did not exit');
  assert.equal(record.portFree, true, 'Packaged driver port is not free');
  assert.deepEqual(record.remainingPids ?? [], [], 'Additional packaged process remains');
}
// The package layout and demo are created by ordinary release CLI commands. No
// test command, renderer bridge or direct preference/session write is involved.
export async function preparePackagedRoutes(cli, bundle, root, applicationData, env) {
  const home = join(root, 'home with spaces');
  const childEnv = { ...env, HOME: home, ARIADNE_HOME: applicationData };
  const versionOutput = (await command(cli, ['--version'], { env: childEnv, timeout: 10000 })).stdout.trim();
  const version = /^ariadne (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(versionOutput)?.[1];
  assert.ok(version, 'Release helper did not report its package version');
  const packageRoot = join(home, '.local/share/ariadne'), versionRoot = join(packageRoot, 'versions', version);
  const application = join(versionRoot, 'Ariadne with spaces.app'), installedCli = join(versionRoot, 'bin/ariadne');
  await mkdir(dirname(installedCli), { recursive: true });
  await cp(bundle, application, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  await copyFile(cli, installedCli); await chmod(installedCli, 0o755);
  await json(join(versionRoot, 'install.json'), { schema_version: 1, version, app_path: application });
  await symlink(join('versions', version), join(packageRoot, 'current'));
  const project = join(root, 'project with spaces'); await mkdir(project);
  const demo = JSON.parse((await command(installedCli, ['demo', '--root', project, '--json'], { env: childEnv, timeout: 10000 })).stdout);
  assert.equal(demo.ok, true, 'Actual installed CLI did not publish the canonical demo');
  const sessionPath = join(project, '.ariadne/sessions', `${demo.data.session_id}.json`), before = await readFile(sessionPath);
  const session = JSON.parse(before);
  assert.equal(session.project_id, demo.data.project_id); assert.equal(session.id, demo.data.session_id);
  for (const item of ['1.1', '3']) assert.ok(session.items[item], 'Canonical route item is absent');
  const coldRoute = { ...demo.data, item_id: '1.1' }, secondRoute = { ...demo.data, item_id: '3' };
  return { home, env: childEnv, application: await realpath(application), cli: installedCli,
    binary: await realpath(join(application, 'Contents/MacOS/ariadne-desktop')), sessionPath, before,
    preferencesPath: join(applicationData, 'ui.json'), coldRoute, secondRoute };
}
export function packagedRouteSelected(snapshot, route) {
  const selection = snapshot?.global?.selected_navigation;
  if (selection?.kind !== 'session' || selection.session?.project_id !== route.project_id || selection.session?.session_id !== route.session_id) return false;
  const views = snapshot.sessions?.filter(view => view.session?.project_id === route.project_id && view.session?.session_id === route.session_id);
  return views?.length === 1 && views[0].tab_open === true && views[0].selected_item_id === route.item_id;
}
function retainPackagedProcess(child, observed) {
  assert.ok(alive(child.pid), 'Original packaged process exited during route delivery');
  assert.deepEqual(identity(child.pid), observed, 'Original packaged process identity changed');
}
async function waitForPackagedRoute(fixture, route, child, observed) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    retainPackagedProcess(child, observed);
    let record;
    try { record = JSON.parse(await readFile(fixture.preferencesPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (packagedRouteSelected(record?.snapshot, route)) return record.snapshot;
    await delay(50);
  }
  throw new Error('Packaged renderer did not persist the requested registered item route');
}
export async function packagedOwnership(applicationData, child, observed, previous) {
  retainPackagedProcess(child, observed);
  const socket = join(applicationData, 'run/control.sock'), lease = join(applicationData, 'run/runtime.lock');
  const socketStat = await stat(socket), leaseStat = await stat(lease);
  assert.ok(socketStat.isSocket(), 'Ordinary production control socket is absent');
  const files = (await command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-Fpn', socket, lease], { timeout: 10000 })).stdout.split('\n');
  assert.ok(files.includes(`p${child.pid}`) && files.some(line => line.startsWith(`n${socket}`)) && files.includes(`n${lease}`), 'Original packaged PID does not own its private control socket and instance lease');
  const probe = 'import fcntl,sys\nwith open(sys.argv[1],"r+b") as lock:\n try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\n except BlockingIOError: sys.exit(0)\n raise RuntimeError("Live packaged instance lease was available")\n';
  await command('python3', ['-c', probe, lease], { timeout: 10000 });
  const ownership = { pid: child.pid, socket: { path: socket, dev: socketStat.dev, ino: socketStat.ino }, lease: { path: lease, dev: leaseStat.dev, ino: leaseStat.ino }, leaseHeld: true };
  if (previous) assert.deepEqual(ownership, previous, 'Second launch replaced the primary control ownership');
  return ownership;
}
export function packagedPids(binary) {
  // Scope the OS query to this private copied executable. Do not read global
  // command lines or select another installation by process name.
  try {
    return execFileSync('/usr/sbin/lsof', ['-nP', '-Fp', binary], { encoding: 'utf8', timeout: 10000 })
      .split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
  } catch (error) { if (error.status === 1) return []; throw error; }
}
async function convergePackagedInstance(binary, child, observed) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    retainPackagedProcess(child, observed);
    const pids = packagedPids(binary);
    if (pids.length === 1 && pids[0] === child.pid) return pids;
    await delay(50);
  }
  throw new Error('Packaged second launch did not converge to the original process');
}
export function verifyProductionSecurity(config) {
  assert.deepEqual(config.app.security.csp, {
    'default-src': "'self'", 'script-src': "'self'", 'style-src': "'self'",
    'font-src': "'self'", 'img-src': "'self'", 'connect-src': 'ipc: http://ipc.localhost',
    'object-src': "'none'", 'base-uri': "'none'", 'form-action': "'none'", 'frame-src': "'none'",
  }, 'Production CSP must confine resources to bundled content and required IPC');
  assert.ok(!config.app.security.dangerousDisableAssetCspModification, 'Bundled CSP hashes/nonces must remain enabled');
  assert.equal(config.bundle.macOS.minimumSystemVersion, '13.0');
}
export function normalBuildFeatures(stdout, metadata) {
  const records = stdout.trim().split('\n').map(line => {
    const fields = line.split('|');
    assert.equal(fields.length, 2, 'Malformed normal/build dependency graph entry');
    return fields;
  });
  const features = {};
  for (const name of ['ariadne-desktop', 'tauri']) {
    const packages = metadata.packages.filter(pkg => pkg.name === name);
    assert.equal(packages.length, 1, `Ambiguous dependency package: ${name}`);
    const pkg = packages[0];
    assert.ok(pkg.source === null || pkg.source?.startsWith('registry+'), 'Unsupported dependency package identity');
    const label = `${pkg.name} v${pkg.version}${pkg.source === null ? ` (${dirname(pkg.manifest_path)})` : ''}`;
    const matches = records.filter(([identity]) => identity === label);
    assert.ok(matches.length > 0, `Missing normal/build dependency package: ${name}`);
    const expected = matches[0][1].split(',').filter(Boolean).sort();
    for (const [, value] of matches) assert.deepEqual(value.split(',').filter(Boolean).sort(), expected, 'Ambiguous normal/build dependency features');
    features[pkg.id] = expected;
  }
  return features;
}
export function buildArtifacts(stdout, metadata, normalFeatures) {
  const desktop = metadata.packages.find(pkg => pkg.name === 'ariadne-desktop');
  const tauri = metadata.packages.find(pkg => pkg.name === 'tauri');
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const builds = events.filter(event => event.reason === 'build-script-executed' && event.package_id === desktop.id);
  assert.equal(builds.length, 1, 'Missing unique fresh desktop build script');
  for (const pkg of [desktop, tauri]) {
    const artifact = events.find(event => event.reason === 'compiler-artifact' && event.package_id === pkg.id && !event.target.kind.includes('custom-build'));
    assert.ok(artifact, `Missing compiler artifact: ${pkg.name}`);
    const features = normalFeatures[pkg.id];
    assert.ok(Array.isArray(features), `Missing normal/build features: ${pkg.name}`);
    assert.deepEqual([...artifact.features].sort(), [...features].sort(), 'Compiler features differ from resolved graph');
  }
  assert.ok(!normalFeatures[desktop.id].includes('e2e'));
  assert.ok(normalFeatures[tauri.id].includes('custom-protocol'));
  return builds[0].out_dir;
}
export async function frontendModules(inventory, output, started) {
  assert.equal(inventory.output, output, 'Wrong frontend output');
  assert.ok(inventory.generatedAt >= started && inventory.chunks.length > 0, 'Stale frontend inventory');
  for (const chunk of inventory.chunks) {
    assert.ok(resolve(output, chunk.file).startsWith(output + '/'), 'Unsafe chunk path');
    const file = join(output, chunk.file);
    assert.ok((await stat(file)).mtimeMs >= started, 'Stale frontend chunk');
    assert.equal(await digest(file), chunk.sha256, 'Frontend artifact differs from module inventory');
  }
  return inventory.chunks.flatMap(chunk => chunk.modules);
}
export function verifyReferenceIsolation(modules, files) {
  const testModule = /(?:^|\/)tests\/ui\/reference\/|\/node_modules\/(?:@babel\/standalone\/|@playwright\/|playwright(?:-core)?\/)|Ariadne UI mockups\.zip/;
  assert.ok(!modules.some(name => testModule.test(name)), 'Reference fixtures or source runtime entered production modules');
  const testFile = /(?:^|\/)(?:tests\/ui\/reference\/|source-runtime\/|support\.js$|gallery\.(?:html|tsx)$)|\.dc\.html$|Ariadne UI mockups\.zip/;
  assert.ok(!files.some(name => testFile.test(name)), 'Reference mount or prototype source entered production files');
}
export function verifyGraph(names, config, acl, capabilities, modules) {
  assert.ok(!names.some(name => name === 'tauri-plugin-wdio' || name === 'tauri-plugin-wdio-webdriver'));
  assert.equal(config.app.withGlobalTauri, false);
  assert.deepEqual(config.app.security.capabilities, ['default']);
  assert.ok(!config.build?.features?.length, 'Unexpected production build features');
  assert.ok(!Object.keys(acl).some(key => key.startsWith('wdio')));
  assert.ok(!JSON.stringify(capabilities).includes('wdio:'));
  assert.ok(!JSON.stringify(capabilities).includes('wdio-webdriver:'));
  assert.ok(modules.length > 0 && modules.some(name => name.includes('react')));
  assert.ok(!modules.some(name => name.includes('@wdio') || name.includes('tauri-plugin')));
}
export async function checkRelease() {
  if (process.platform !== 'darwin') throw new Error('Packaged boundary requires macOS');
  const port = Number(process.env.ARIADNE_E2E_PORT || '4445'); await portFree(port);
  const target = join(repo, 'target/release-boundary'), evidence = join(repo, 'coverage/release-boundary', randomUUID());
  await rm(target, { recursive: true, force: true }); await rm(join(repo, 'target/desktop-dist'), { recursive: true, force: true });
  await rm(join(repo, 'target/desktop-modules.json'), { force: true }); await mkdir(evidence, { recursive: true });
  const env = buildEnv(target), cli = join(repo, 'node_modules/@tauri-apps/cli/tauri.js');
  await json(join(evidence, 'run.json'), { toolchain: toolchain(), buildCommand: [process.execPath, cli, 'build', '--ci', '--bundles', 'app', '--', '--locked', '--no-default-features', '--target-dir', target, '--message-format=json-render-diagnostics'], cwd: desktop });
  const source = join(desktop, 'src-tauri'), started = Date.now();
  const metadata = JSON.parse((await command('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin', '--no-default-features', '--features', 'tauri/custom-protocol'], { cwd: source, env })).stdout);
  // Metadata includes dev-feature unions. Resolver 2's normal/build graph is the
  // feature set used by this ordinary release build, with the same target/flags.
  const featureGraph = await command('cargo', ['tree', '--locked', '--offline', '--package', 'ariadne-desktop', '--target', 'aarch64-apple-darwin', '--no-default-features', '--features', 'tauri/custom-protocol', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}|{f}', '--no-dedupe'], { cwd: source, env, log: join(evidence, 'normal-build-features.txt') });
  const normalFeatures = normalBuildFeatures(featureGraph.stdout, metadata);
  const build = await command(process.execPath, [cli, 'build', '--ci', '--bundles', 'app', '--', '--locked', '--no-default-features', '--target-dir', target, '--message-format=json-render-diagnostics'], { cwd: desktop, env, log: join(evidence, 'build.log') });
  const out = buildArtifacts(build.stdout, metadata, normalFeatures);
  assert.ok(out.startsWith(join(target, 'release/build/')), 'Unexpected compiler output');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const inputs = await readdir(source);
  assert.ok(!inputs.some(name => /^tauri\.(macos|linux|windows)\.conf\./.test(name) || ['Tauri.toml', 'tauri.conf.json5'].includes(name)), 'Unexpected production config source');
  const base = await readJson(join(source, 'tauri.conf.json'));
  const fingerprint = await readJson(join(target, 'release/.fingerprint', basename(dirname(out)), 'run-build-script-build-script-build.json'));
  const recorded = fingerprint.local.filter(entry => entry.RerunIfEnvChanged?.var === 'TAURI_CONFIG');
  assert.equal(recorded.length, 1, 'Missing compiler configuration evidence');
  const value = recorded[0].RerunIfEnvChanged.val;
  const config = mergedConfig(base, value === null ? null : JSON.parse(value));
  const acl = await readJson(join(out, 'acl-manifests.json')), capabilities = await readJson(join(out, 'capabilities.json'));
  assert.deepEqual(Object.keys(capabilities), ['default']);
  assert.deepEqual(capabilities.default.permissions, ['core:default']);
  assert.equal(config.build.frontendDist, '../../../target/desktop-dist');
  const inventory = await readJson(join(repo, 'target/desktop-modules.json'));
  const modules = await frontendModules(inventory, join(repo, 'target/desktop-dist'), started);
  verifyReferenceIsolation(modules, await readdir(join(repo, 'target/desktop-dist'), { recursive: true }));
  const names = resolvedNames(metadata); verifyGraph(names, config, acl, capabilities, modules); verifyProductionSecurity(config);
  const bundle = join(target, 'release/bundle/macos/Ariadne.app'), builtBinary = join(bundle, 'Contents/MacOS/ariadne-desktop');
  // Same normal release helper build used by personal package verification.
  await command('cargo', ['build', '--release', '--locked', '--no-default-features', '-p', 'ariadne-cli', '-p', 'ariadne-mcp'], { env, log: join(evidence, 'helpers-build.log') });
  await command(process.execPath, ['--test', 'tests/e2e/process-contract/packaged-route.test.mjs'], {
    env: { ...env, ARIADNE_FIXTURE_TEST_CLI: join(target, 'release/ariadne') }, log: join(evidence, 'route-fixture.log'),
  });
  await portFree(port);
  const minimumSystemVersion = (await command('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', join(bundle, 'Contents/Info.plist')])).stdout.trim();
  assert.equal(minimumSystemVersion, '13.0', 'Packaged minimum macOS differs from deployment target');
  const root = await mkdtemp('/private/tmp/ariadne-release-');
  const applicationData = await mkdtemp('/private/tmp/ariadne-release-data-');
  const routeRoot = await mkdtemp('/private/tmp/ariadne-route-');
  let logs = '', child, fixture, observed, spawnError, failure, cleanupError;
  try {
    fixture = await preparePackagedRoutes(join(target, 'release/ariadne'), bundle, routeRoot, applicationData, env);
    const { binary } = fixture, runtimeCommand = [binary, '--ariadne-route', JSON.stringify(fixture.coldRoute)];
    await assert.rejects(stat(fixture.preferencesPath), { code: 'ENOENT' }, 'Fresh packaged preferences must not contain a preseeded selection');
    assert.equal(await digest(binary), await digest(builtBinary), 'Private package differs from the ordinary compiled application');
    assert.equal(await digest(fixture.cli), await digest(join(target, 'release/ariadne')), 'Installed helper differs from the ordinary release CLI');
    child = spawn(runtimeCommand[0], runtimeCommand.slice(1), { env: { ...fixture.env, WDIO_EMBEDDED_SERVER: 'true', TAURI_WEBDRIVER_PORT: String(port), ARIADNE_E2E_ROOT: root, ARIADNE_E2E_NONCE: '0'.repeat(64) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs += value; });
    for (let count = 0; count < 20; count++) {
      await delay(500); if (spawnError) throw spawnError;
      assert.ok(alive(child.pid), 'Packaged application failed to remain alive');
      observed = identity(child.pid); assert.equal(observed.exe, binary);
      await portFree(port); assert.equal(listeners(port), ''); assert.deepEqual(await readdir(root), []);
    }
    const cold = await waitForPackagedRoute(fixture, fixture.coldRoute, child, observed);
    const ownership = await packagedOwnership(applicationData, child, observed);
    assert.deepEqual(await readFile(fixture.sessionPath), fixture.before, 'Cold route mutated the canonical demo');
    const cliArgs = ['open', '--project', fixture.secondRoute.project_id, '--session', fixture.secondRoute.session_id, '--item', fixture.secondRoute.item_id];
    await command(fixture.cli, cliArgs, { env: fixture.env, timeout: 20000, log: join(evidence, 'open.log') });
    const second = await waitForPackagedRoute(fixture, fixture.secondRoute, child, observed);
    assert.ok(second.revision > cold.revision, 'Second instance did not publish a new registered selection');
    const remainingPids = await convergePackagedInstance(binary, child, observed);
    await packagedOwnership(applicationData, child, observed, ownership);
    assert.deepEqual(await readFile(fixture.sessionPath), fixture.before, 'CLI second-instance route mutated the canonical demo');
    await portFree(port); assert.equal(listeners(port), ''); assert.deepEqual(await readdir(root), []);
    await json(join(evidence, 'routes.json'), { passed: true, coldRoute: fixture.coldRoute, coldPreferences: cold, secondRoute: fixture.secondRoute,
      secondPreferences: second, cliCommand: [fixture.cli, ...cliArgs], helperSha256: await digest(fixture.cli), packagePath: fixture.application,
      primary: observed, remainingPids, ownership, demoSessionPath: fixture.sessionPath, demoSha256: await digest(fixture.sessionPath), demoUnchanged: true,
      scope: 'Ordinary packaged cold route and CLI second-instance registered reveal; OS hide/tray/Pin/Quit/wake are not exercised.' });
    await json(join(evidence, 'assertions.json'), { passed: true, observed, binary, builtBinary, applicationData, ordinaryRuntimeOwned: true, runtimeCommand, minimumSystemVersion, binarySha256: await digest(binary), port, listenerAbsent: true, e2eWritesAbsent: true, observedMilliseconds: 10000, metadata, normalFeatures, compilerOutput: out, fingerprint, acl, capabilities, inventory, config });
  } catch (error) { failure = error; }
  finally {
    let portReleased = false, remainingPids = [];
    try {
      if (observed && alive(child.pid)) assert.deepEqual(identity(child.pid), observed, 'Packaged process identity changed');
      if (child) await stop(child);
      if (fixture) remainingPids = packagedPids(fixture.binary);
      assert.deepEqual(remainingPids, [], 'Additional packaged process remains; preserve its private roots and do not signal an unowned PID');
      await portFree(port); portReleased = true;
    } catch (error) { cleanupError = error; }
    const cleanup = { pid: child?.pid, pidExited: !child || !alive(child.pid), remainingPids, portFree: portReleased, exitCode: child?.exitCode, signal: child?.signalCode, logs, error: cleanupError?.message, failure: failure?.message };
    await json(join(evidence, 'cleanup.json'), cleanup);
    if (!cleanupError) {
      verifyCleanup(cleanup); assert.deepEqual(await readdir(root), []);
      await rm(root, { recursive: true }); await rm(applicationData, { recursive: true }); await rm(routeRoot, { recursive: true });
    }
  }
  if (cleanupError) throw cleanupError;
  if (failure) throw failure;
  console.log(`Release isolation evidence: ${evidence}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkRelease().catch(error => { console.error(error.message); process.exitCode = 1; });
