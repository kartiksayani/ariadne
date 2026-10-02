import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, identity, alive, selector, portFree, listeners, buildEnv, json, digest, observeOwned, stop, runNative } from '../../../scripts/run-native-e2e.mjs';
import { resolvedNames, verifyGraph, mergedConfig, buildArtifacts, frontendModules, checkRelease } from '../../../scripts/check-release-boundary.mjs';
test('selectors are explicit and default runs the complete gate', () => {
  assert.equal(selector([]), 'all');
  for (const name of ['all', 'native', 'process-contract']) assert.equal(selector(['--suite', name]), name);
  for (const args of [['--suite'], ['--suite', 'skip'], ['--skip'], ['--suite', 'native', '--suite', 'all']]) assert.throws(() => selector(args));
});
test('private command cwd, exact arguments, logs and native identity are real', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-process-'));
  try {
    const log = join(root, 'command.log'), arg = 'literal $() `not a shell`';
    const result = await command(process.execPath, ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}))', arg], { cwd: root, log });
    const record = JSON.parse(result.output); assert.equal(record.arg, arg); assert.equal(record.cwd, await realpath(root));
    assert.equal(await readFile(log, 'utf8'), result.output); assert.ok(!alive(result.pid));
    assert.equal(identity(process.pid).pid, process.pid);
    assert.throws(() => identity(1));
    await json(join(root, 'nested/proof.json'), { ok: true }); assert.equal((await readdir(join(root, 'nested'))).length, 1);
    assert.match(await digest(log), /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true }); }
});
test('nonzero and unavailable commands fail, timeout stops only its spawned process', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(7)']), /failed \(7\)/);
  await assert.rejects(command('/definitely-missing-ariadne-command', []), /ENOENT/);
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /deadline/);
  assert.ok(alive(process.pid));
});
test('leader exit does not leave its native descendant behind', async () => {
  const source = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); child.unref(); console.log(child.pid)';
  const result = await command(process.execPath, ['-e', source]);
  assert.ok(!alive(Number(result.stdout.trim()))); assert.ok(alive(process.pid));
});
test('launcher failure before bridge/witness readiness aborts observation and cleans descendants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-startup-failure-'));
  const controller = new globalThis.AbortController();
  let launcher;
  try {
    const source = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); child.unref(); console.log(child.pid)';
    const execution = command(process.execPath, ['-e', source], { onStart: child => { launcher = child; } });
    execution.then(() => controller.abort(new Error('launcher exited before readiness')), error => controller.abort(error));
    await assert.rejects(observeOwned(root, process.execPath, 'nonce', launcher.pid, 1000, controller.signal), /exited before readiness/);
    const result = await execution;
    assert.ok(!alive(Number(result.stdout.trim())));
  } finally { await rm(root, { recursive: true }); }
});
test('SIGINT and deadline clean owned descendants while preserving the test parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-signal-'));
  const runner = new URL('../../../scripts/run-native-e2e.mjs', import.meta.url).href;
  try {
    for (const interrupt of [false, true]) {
      const pidFile = join(root, String(interrupt));
      const source = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000)`;
      const fixture = `import {command} from ${JSON.stringify(runner)}; ${interrupt ? 'setTimeout(()=>process.kill(process.pid,"SIGINT"),200);' : ''} try { await command(process.execPath,['-e',${JSON.stringify(source)},${JSON.stringify(pidFile)}],{timeout:300}); } catch(error) { console.log(error.message); }`;
      const result = await command(process.execPath, ['--input-type=module', '-e', fixture]);
      assert.match(result.stdout, /deadline\/interruption/);
      assert.ok(!alive(Number(await readFile(pidFile, 'utf8'))));
    }
    assert.ok(alive(process.pid));
  } finally { await rm(root, { recursive: true }); }
});
test('runner observes startup ancestry before any UI bridge assertion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-observe-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  try {
    const exe = identity(child.pid).exe;
    await json(join(root, 'startup.json'), { pid: child.pid, nonce: 'nonce' });
    const proof = await observeOwned(root, exe, 'nonce', process.pid);
    assert.equal(proof.ancestry.at(-1).pid, process.pid);
    assert.equal(JSON.parse(await readFile(join(root, 'observed.json'))).pid, child.pid);
    await assert.rejects(observeOwned(root, exe, 'wrong', process.pid), /nonce/);
    await assert.rejects(observeOwned(root, '/wrong/executable', 'nonce', process.pid), /executable/);
    await assert.rejects(observeOwned(root, exe, 'nonce', 999999), /ancestry/);
    await rm(join(root, 'startup.json'));
    await assert.rejects(observeOwned(root, exe, 'nonce', process.pid, 50), /deadline/);
  } finally { await stop(child); await rm(root, { recursive: true }); }
});
test('occupied loopback port fails without touching listener, invalid ports fail', async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { await assert.rejects(portFree(port), /occupied/); assert.match(listeners(port), new RegExp(`:${port}`)); assert.ok(server.listening); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await portFree(port);
  for (const value of [0, 65536, NaN, 4.5]) await assert.rejects(portFree(value), /Invalid/);
});
test('production environment removes test switches without mutating owner environment', () => {
  process.env.ARIADNE_E2E_NONCE = 'fixture'; process.env.TAURI_WEBDRIVER_PORT = '4445'; process.env.VITE_ARIADNE_E2E = '1'; process.env.TAURI_CONFIG = '{"app":{"withGlobalTauri":true}}';
  try {
    const env = buildEnv('/private/tmp/target'); assert.equal(env.ARIADNE_E2E_NONCE, undefined); assert.equal(env.TAURI_WEBDRIVER_PORT, undefined); assert.equal(env.VITE_ARIADNE_E2E, undefined); assert.equal(env.TAURI_CONFIG, undefined);
    assert.equal(env.MACOSX_DEPLOYMENT_TARGET, '13.0'); assert.equal(buildEnv('/private/tmp/target', true).VITE_ARIADNE_E2E, '1'); assert.equal(process.env.ARIADNE_E2E_NONCE, 'fixture');
  } finally { delete process.env.ARIADNE_E2E_NONCE; delete process.env.TAURI_WEBDRIVER_PORT; delete process.env.VITE_ARIADNE_E2E; delete process.env.TAURI_CONFIG; }
});
test('compiler config and artifact evidence rejects unexpected inherited inputs and feature mismatch', () => {
  const base = { bundle: { active: true, icon: ['icons/icon.icns'] } };
  assert.deepEqual(mergedConfig(base, { bundle: { active: true } }), base);
  assert.deepEqual(mergedConfig(base, null), base);
  assert.throws(() => mergedConfig(base, { app: { security: { capabilities: [{ permissions: ['wdio:default'] }] } } }));
  assert.throws(() => mergedConfig(base, { bundle: { active: false } }));
  const metadata = { packages: [{ id: 'd', name: 'ariadne-desktop' }, { id: 't', name: 'tauri' }], resolve: { nodes: [{ id: 'd', features: [] }, { id: 't', features: ['custom-protocol'] }] } };
  const events = [{ reason: 'build-script-executed', package_id: 'd', out_dir: '/fresh/out' }, ...metadata.resolve.nodes.map(node => ({ reason: 'compiler-artifact', package_id: node.id, features: node.features, target: { kind: ['lib'] } }))];
  const output = value => value.map(event => JSON.stringify(event)).join('\n');
  assert.equal(buildArtifacts(output(events), metadata), '/fresh/out');
  assert.throws(() => buildArtifacts(output(events.slice(1)), metadata));
  events[1].features = ['e2e']; assert.throws(() => buildArtifacts(output(events), metadata));
});
test('frontend evidence must be fresh, match emitted chunk bytes and stay within production output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-graph-')), started = Date.now() - 1000;
  try {
    await writeFile(join(root, 'app.js'), 'real chunk');
    const graph = { output: root, generatedAt: Date.now(), chunks: [{ file: 'app.js', sha256: await digest(join(root, 'app.js')), modules: ['react/index.js'] }] };
    assert.deepEqual(await frontendModules(graph, root, started), ['react/index.js']);
    await assert.rejects(frontendModules({ ...graph, generatedAt: 0 }, root, started), /Stale/);
    await assert.rejects(frontendModules(graph, root + '/different', started), /Wrong/);
    graph.chunks[0].sha256 = 'bad'; await assert.rejects(frontendModules(graph, root, started), /differs/);
    graph.chunks[0].file = '../escape.js'; await assert.rejects(frontendModules(graph, root, started), /Unsafe/);
  } finally { await rm(root, { recursive: true }); }
});
test('release proof rejects activated dependencies, inline permissions, globals and actual WDIO modules', () => {
  const config = { app: { withGlobalTauri: false, security: { capabilities: ['default'] } } };
  const modules = ['/node_modules/react/index.js', '/src/main.tsx'];
  assert.deepEqual(resolvedNames({ packages: [{ id: '1', name: 'tauri' }, { id: '2', name: 'inactive' }], resolve: { nodes: [{ id: '1' }] } }), ['tauri']);
  verifyGraph(['tauri'], config, { core: {} }, { default: { permissions: ['core:default'] } }, modules);
  for (const name of ['tauri-plugin-wdio', 'tauri-plugin-wdio-webdriver']) assert.throws(() => verifyGraph([name], config, {}, {}, modules));
  assert.throws(() => verifyGraph([], { app: { ...config.app, withGlobalTauri: true } }, {}, {}, modules));
  assert.throws(() => verifyGraph([], { app: { ...config.app, security: { capabilities: [{ permissions: ['wdio:default'] }] } } }, {}, {}, modules));
  assert.throws(() => verifyGraph([], config, { wdio: {} }, {}, modules));
  assert.throws(() => verifyGraph([], config, {}, { test: { permissions: ['wdio-webdriver:default'] } }, modules));
  assert.throws(() => verifyGraph([], config, {}, {}, [...modules, '/node_modules/@wdio/tauri-plugin/index.js']));
  assert.throws(() => verifyGraph([], config, {}, {}, []));
});
test('invalid or occupied preflight allocates no native root and leaves unrelated listener alive', async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = process.env.ARIADNE_E2E_PORT;
  const ownedRoots = async () => (await readdir('/private/tmp')).filter(name => /^ariadne-(e2e|release)-/.test(name)).sort();
  const before = await ownedRoots();
  try {
    for (const value of ['0', String(server.address().port)]) {
      process.env.ARIADNE_E2E_PORT = value;
      for (const gate of [runNative, checkRelease]) await assert.rejects(gate(), /Invalid|occupied/);
      assert.deepEqual(await ownedRoots(), before); assert.ok(server.listening && alive(process.pid));
    }
  } finally {
    if (original === undefined) delete process.env.ARIADNE_E2E_PORT; else process.env.ARIADNE_E2E_PORT = original;
    await new Promise(resolve => server.close(resolve));
  }
});
