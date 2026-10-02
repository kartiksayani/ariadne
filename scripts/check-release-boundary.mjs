import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
export function buildArtifacts(stdout, metadata) {
  const desktop = metadata.packages.find(pkg => pkg.name === 'ariadne-desktop');
  const tauri = metadata.packages.find(pkg => pkg.name === 'tauri');
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const builds = events.filter(event => event.reason === 'build-script-executed' && event.package_id === desktop.id);
  assert.equal(builds.length, 1, 'Missing unique fresh desktop build script');
  for (const pkg of [desktop, tauri]) {
    const artifact = events.find(event => event.reason === 'compiler-artifact' && event.package_id === pkg.id && !event.target.kind.includes('custom-build'));
    assert.ok(artifact, `Missing compiler artifact: ${pkg.name}`);
    const features = metadata.resolve.nodes.find(node => node.id === pkg.id).features;
    assert.deepEqual([...artifact.features].sort(), [...features].sort(), 'Compiler features differ from resolved graph');
  }
  assert.ok(!metadata.resolve.nodes.find(node => node.id === desktop.id).features.includes('e2e'));
  assert.ok(metadata.resolve.nodes.find(node => node.id === tauri.id).features.includes('custom-protocol'));
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
  const build = await command(process.execPath, [cli, 'build', '--ci', '--bundles', 'app', '--', '--locked', '--no-default-features', '--target-dir', target, '--message-format=json-render-diagnostics'], { cwd: desktop, env, log: join(evidence, 'build.log') });
  const out = buildArtifacts(build.stdout, metadata);
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
  const names = resolvedNames(metadata); verifyGraph(names, config, acl, capabilities, modules);
  const binary = join(target, 'release/bundle/macos/Ariadne.app/Contents/MacOS/ariadne-desktop');
  await portFree(port);
  const root = await mkdtemp('/private/tmp/ariadne-release-');
  const child = spawn(binary, [], { env: { ...env, WDIO_EMBEDDED_SERVER: 'true', TAURI_WEBDRIVER_PORT: String(port), ARIADNE_E2E_ROOT: root, ARIADNE_E2E_NONCE: '0'.repeat(64) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', observed, spawnError;
  child.once('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs += value; });
  try {
    for (let count = 0; count < 20; count++) {
      await delay(500); if (spawnError) throw spawnError;
      assert.ok(alive(child.pid), 'Packaged application failed to remain alive');
      observed = identity(child.pid); assert.equal(observed.exe, binary);
      await portFree(port); assert.equal(listeners(port), ''); assert.deepEqual(await readdir(root), []);
    }
    await json(join(evidence, 'assertions.json'), { passed: true, observed, binary, runtimeCommand: [binary], binarySha256: await digest(binary), port, listenerAbsent: true, e2eWritesAbsent: true, observedMilliseconds: 10000, metadata, compilerOutput: out, fingerprint, acl, capabilities, inventory, config });
  } finally {
    await stop(child); await portFree(port); await json(join(evidence, 'cleanup.json'), { pid: child.pid, pidExited: !alive(child.pid), portFree: true, logs });
    await rm(root, { recursive: true });
  }
  console.log(`Release isolation evidence: ${evidence}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkRelease().catch(error => { console.error(error.message); process.exitCode = 1; });
