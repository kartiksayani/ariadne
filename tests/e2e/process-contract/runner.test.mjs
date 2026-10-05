import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, identity, alive, selector, portFree, listeners, buildEnv, json, digest, observeOwned, stop, runNative, delay, sourceState, releasedLeases, proveQuit, waitForQuitExit } from '../../../scripts/run-native-e2e.mjs';
import { resolvedNames, verifyGraph, mergedConfig, normalBuildFeatures, buildArtifacts, frontendModules, checkRelease, verifyProductionSecurity, verifyCleanup, verifyReferenceIsolation } from '../../../scripts/check-release-boundary.mjs';
import { admissions, completeTurn, startScriptedProvider, thread } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';
import WebSocket from 'ws';
async function assertExited(pid) {
  const end = Date.now() + 1000;
  while (alive(pid) && Date.now() < end) await delay(10);
  assert.ok(!alive(pid), 'Owned descendant did not exit within one second');
}
test('scripted native provider uses an explicit UNIX endpoint, pinned version and exact queue arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-scripted-'));
  const evidence = join(root, 'evidence'); await mkdir(evidence);
  let provider, client;
  try {
    provider = await startScriptedProvider(root, '/unused-actual-cli', evidence, {});
    const config = provider.configuration;
    assert.equal((await command(config.executable, ['--version'])).stdout.trim(), 'codex-cli 0.160.0');
    await assert.rejects(command(config.executable, ['resume', thread]), /failed \(3\)/);
    client = new WebSocket('ws://localhost', { createConnection: () => net.connect(config.socket) });
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const rpc = async (id, method, params) => {
      const result = new Promise(resolve => client.once('message', bytes => resolve(JSON.parse(bytes.toString()))));
      client.send(JSON.stringify({ id, method, params })); return result;
    };
    assert.match((await rpc(1, 'initialize', {})).result.userAgent, /0\.160\.0/);
    const read = await rpc(2, 'thread/read', { threadId: thread });
    assert.equal(read.result.thread.id, thread); assert.equal(read.result.thread.cwd, config.project);
    assert.deepEqual((await rpc(10, 'thread/loaded/list', {})).result.data, [thread, config.discovery.externalSessionId, config.tree.externalSessionId]);
    const unbound = await rpc(11, 'thread/read', { threadId: config.discovery.externalSessionId });
    assert.equal(unbound.result.thread.id, config.discovery.externalSessionId); assert.equal(unbound.result.thread.cwd, config.discovery.projectRoot);
    assert.deepEqual((await rpc(12, 'thread/turns/list', { threadId: config.discovery.externalSessionId })).result.data, []);
    await assert.rejects(readFile(join(config.discovery.projectRoot, '.ariadne/project.json')), { code: 'ENOENT' });
    const treeCandidate = await rpc(13, 'thread/read', { threadId: config.tree.externalSessionId });
    assert.equal(treeCandidate.result.thread.id, config.tree.externalSessionId); assert.equal(treeCandidate.result.thread.cwd, config.tree.projectRoot);
    assert.deepEqual((await rpc(14, 'thread/turns/list', { threadId: config.tree.externalSessionId })).result.data, []);
    await assert.rejects(readFile(join(config.tree.projectRoot, '.ariadne/project.json')), { code: 'ENOENT' });
    assert.deepEqual((await rpc(3, 'thread/turns/list', { threadId: thread })).result.data, []);
    const inputId = '11111111-1111-4111-8111-111111111111', attemptId = '22222222-2222-4222-8222-222222222222';
    const body = { source_input_id: inputId, binding_id: '33333333-3333-4333-8333-333333333333', generation: '44444444-4444-4444-8444-444444444444', saved_input: { text: 'Exact owner input\nComplete second line' } };
    const payload = `[ARIADNE_INPUT:${inputId}:${attemptId}]\n${JSON.stringify(body)}`;
    await command(config.executable, ['queue', '--remote', `unix://${config.socket}`, '--thread', thread, '--message', payload]);
    const [admitted] = await admissions(config); assert.equal(admitted.payload, payload); assert.equal(admitted.attemptId, attemptId);
    await assert.rejects(command(config.executable, ['queue', '--remote', `unix://${config.socket}`, '--thread', config.discovery.externalSessionId, '--message', payload]), /failed \(3\)/);
    await assert.rejects(command(config.executable, ['queue', '--remote', `unix://${config.socket}`, '--thread', config.tree.externalSessionId, '--message', payload]), /failed \(3\)/);
    const turns = (await rpc(4, 'thread/turns/list', { threadId: thread })).result;
    assert.equal(turns.data[0].status, 'inProgress');
    assert.equal(turns.data[0].items[0].content[0].text, payload);
    assert.equal(turns.data[0].items.length, 1, 'Provider transport creates no domain reply or result');
    await assert.rejects(command(config.executable, ['queue', '--remote', `unix://${config.socket}`, '--thread', thread, '--message', payload]), /failed \(3\)/);
    await assert.rejects(completeTurn(config, { ...admitted, generation: inputId }), /exact existing/);
    await assert.rejects(readFile(config.completePath), { code: 'ENOENT' });
    await completeTurn(config, admitted);
    const secondInput = '55555555-5555-4555-8555-555555555555', secondAttempt = '66666666-6666-4666-8666-666666666666';
    const secondPayload = `[ARIADNE_INPUT:${secondInput}:${secondAttempt}]\n${JSON.stringify({ ...body, source_input_id: secondInput })}`;
    await command(config.executable, ['queue', '--remote', `unix://${config.socket}`, '--thread', thread, '--message', secondPayload]);
    const journal = await admissions(config); assert.equal(journal.length, 2); assert.notEqual(journal[0].turnId, journal[1].turnId);
    const after = (await rpc(5, 'thread/turns/list', { threadId: thread, sortDirection: 'desc' })).result.data;
    assert.deepEqual(after.map(turn => turn.id), [journal[1].turnId, journal[0].turnId], 'The newest exact original must precede the prior queue anchor');
    assert.deepEqual(after.map(turn => turn.status), ['inProgress', 'completed']);
    assert.deepEqual(after.map(turn => turn.items[0].content[0].text), [secondPayload, payload]);
    assert.equal(after[0].id, journal[1].turnId, 'Completing the first admission cannot complete the successor');
    assert.deepEqual((await admissions(config)).map(entry => entry.turnId), journal.map(entry => entry.turnId), 'History order cannot rewrite FIFO admissions');
    await assert.rejects(completeTurn(config, admitted), /occurs once/);
  } finally { client?.terminate(); await provider?.stop(); await rm(root, { recursive: true }); }
});
test('selectors are explicit and default runs the complete gate', () => {
  assert.equal(selector([]), 'all');
  for (const name of ['all', 'native', 'process-contract']) assert.equal(selector(['--suite', name]), name);
  for (const args of [['--suite'], ['--suite', 'skip'], ['--skip'], ['--suite', 'native', '--suite', 'all']]) assert.throws(() => selector(args));
});
test('source evidence distinguishes generated untracked files from tracked changes against HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-source-'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']);
    await writeFile(join(root, 'source.txt'), 'committed source\n');
    git(['add', 'source.txt']);
    git(['-c', 'user.name=Source Fixture', '-c', 'user.email=source@example.test', 'commit', '--quiet', '-m', 'Source fixture']);
    const clean = sourceState(root);
    assert.equal(clean.head, git(['rev-parse', 'HEAD']));
    assert.equal(clean.indexTree, git(['rev-parse', 'HEAD^{tree}']));
    assert.equal(clean.dirty, false);
    assert.equal(clean.statusPorcelain, '');
    assert.equal(clean.trackedDiffNameStatus, '');

    await writeFile(join(root, 'generated.txt'), 'generated output\n');
    const untracked = sourceState(root);
    assert.equal(untracked.dirty, true);
    assert.equal(untracked.statusPorcelain, '?? generated.txt');
    assert.equal(untracked.trackedDiffNameStatus, '');

    await writeFile(join(root, 'source.txt'), 'unstaged source overlay\n');
    const unstaged = sourceState(root);
    assert.equal(unstaged.head, clean.head);
    assert.equal(unstaged.indexTree, clean.indexTree);
    assert.equal(unstaged.dirty, true);
    assert.equal(unstaged.statusPorcelain, ' M source.txt\n?? generated.txt');
    assert.equal(unstaged.trackedDiffNameStatus, 'M\tsource.txt');

    git(['add', 'source.txt']);
    const staged = sourceState(root);
    assert.equal(staged.head, clean.head);
    assert.notEqual(staged.indexTree, clean.indexTree);
    assert.equal(staged.dirty, true);
    assert.equal(staged.statusPorcelain, 'M  source.txt\n?? generated.txt');
    assert.equal(staged.trackedDiffNameStatus, 'M\tsource.txt');
  } finally { await rm(root, { recursive: true }); }
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
  await assertExited(Number(result.stdout.trim())); assert.ok(alive(process.pid));
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
    await assertExited(Number(result.stdout.trim()));
  } finally { await rm(root, { recursive: true }); }
});
test('embedded launcher retains backend stderr when the app exits before readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-backend-log-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const configUrl = new URL('../../../apps/desktop/wdio.native.conf.mjs', import.meta.url).href;
  const diagnostic = 'fixture startup panic before embedded WebDriver readiness';
  const appArgs = ['-e', `process.stderr.write(${JSON.stringify(diagnostic + '\n')}, () => process.exit(23))`];
  const fixture = `
    import logger from '@wdio/logger';
    logger.setLogLevelsConfig({}, 'info');
    const { config } = await import(${JSON.stringify(configUrl)});
    const { launcher } = await import('@wdio/tauri-service');
    const options = { ...config.services[0][1], startTimeout: 500 };
    const service = new launcher(options, config.capabilities, config);
    try { await service.onPrepare(config, config.capabilities); }
    catch (error) { console.log(error.message); process.exitCode = 1; }
  `;
  try {
    await assert.rejects(command(process.execPath, ['--input-type=module', '-e', fixture], {
      env: { ...buildEnv(root), ARIADNE_E2E_BINARY: process.execPath, ARIADNE_E2E_ROOT: root,
        ARIADNE_E2E_NONCE: 'fixture', ARIADNE_E2E_PORT: String(port), ARIADNE_E2E_EVIDENCE: root, ARIADNE_E2E_PHASE: 'delivery',
        ARIADNE_E2E_APP_ARGS: JSON.stringify(appArgs) },
      timeout: 10000, log: join(root, 'launcher.log'),
    }), /failed \(1\)/);
    assert.match(await readFile(join(root, 'launcher.log'), 'utf8'), /exited before.*ready \(code=23/);
    const logs = (await readdir(root)).filter(name => /^wdio-.*\.log$/.test(name));
    assert.equal(logs.length, 1);
    assert.match(await readFile(join(root, logs[0]), 'utf8'), new RegExp(diagnostic));
    await portFree(port);
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
      await assertExited(Number(await readFile(pidFile, 'utf8')));
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
test('fresh launch rejects stale nonce and retains separate PID/birth/ancestry evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-relaunch-'));
  let first, second;
  try {
    first = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    const exe = identity(first.pid).exe;
    await json(join(root, 'startup.json'), { pid: first.pid, nonce: 'first' });
    const prior = await observeOwned(root, exe, 'first', process.pid);
    await stop(first); await assertExited(first.pid);
    second = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await json(join(root, 'startup.json'), { pid: second.pid, nonce: 'second' });
    await assert.rejects(observeOwned(root, exe, 'first', process.pid), /nonce/);
    const fresh = await observeOwned(root, exe, 'second', process.pid);
    assert.notEqual(fresh.pid, prior.pid); assert.equal(fresh.birth, identity(second.pid).birth);
    assert.equal(fresh.ancestry.at(-1).pid, process.pid); assert.equal(alive(prior.pid), false);
  } finally { if (first) await stop(first); if (second) await stop(second); await rm(root, { recursive: true }); }
});
test('Quit proof requires actual owned PID exit, free port and released physical leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-quit-')), home = join(root, 'data'), bindingId = 'binding';
  await mkdir(join(home, 'run/leases'), { recursive: true });
  const files = [join(home, 'run/runtime.lock'), join(home, 'run/leases', `${bindingId}.lock`)];
  for (const file of files) await writeFile(file, '');
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  let child;
  try {
    const source = 'import fcntl,sys\nlocks=[open(path,"r+b") for path in sys.argv[1:]]\nfor lock in locks: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint("locked",flush=True)\nsys.stdin.readline()\n';
    child = spawn('python3', ['-c', source, ...files], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const owned = identity(child.pid);
    await assert.rejects(releasedLeases(home, bindingId), /failed/);
    await json(join(root, 'quit-request.json'), { pid: child.pid, nonce: 'wrong' });
    await assert.rejects(proveQuit(root, owned.exe, 'expected', owned, home, bindingId, port), /identity mismatch/);
    assert.ok(alive(child.pid), 'A rejected witness cannot signal the process');
    await json(join(root, 'quit-request.json'), { pid: child.pid, nonce: 'expected' });
    const exit = new Promise(resolve => child.once('close', resolve)); child.stdin.end('\n'); await exit;
    const proof = await proveQuit(root, owned.exe, 'expected', owned, home, bindingId, port);
    assert.equal(proof.pidExited, true); assert.equal(proof.portFree, true); assert.equal(proof.leases.released, true);
    assert.deepEqual(proof.leases.paths, files);
  } finally { if (child && alive(child.pid)) child.kill(); await rm(root, { recursive: true }); }
});
test('Quit wait rejects live identity changes and waits for a same-birth macOS zombie to disappear', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.once("data",()=>process.exit(0))'], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const owned = identity(child.pid);
    await assert.rejects(waitForQuitExit('/different-live-executable', owned), /identity changed/);
    await assert.rejects(waitForQuitExit(owned.exe, { ...owned, birth: 'different birth' }), /identity changed/);
    assert.ok(alive(child.pid), 'Rejected identity checks cannot signal the owned process');
    child.stdin.end('quit');
    // Hold this parent event loop briefly so the genuinely exited child remains
    // observable as a zombie before libuv can reap it.
    const end = Date.now() + 1000;
    let state;
    do {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      state = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    } while (!state.startsWith('Z') && Date.now() < end);
    assert.ok(state.startsWith('Z')); assert.equal(identity(child.pid).exe, '<defunct>');
    assert.equal(identity(child.pid).birth, owned.birth); assert.ok(alive(child.pid));
    await waitForQuitExit(owned.exe, owned); assert.equal(alive(child.pid), false);
  } finally { if (alive(child.pid)) child.kill(); }
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
  const features = { d: [], t: ['custom-protocol'] };
  assert.equal(buildArtifacts(output(events), metadata, features), '/fresh/out');
  assert.throws(() => buildArtifacts(output(events.slice(1)), metadata, features));
  events[1].features = ['e2e']; assert.throws(() => buildArtifacts(output(events), metadata, features));
});
test('real normal/build graph excludes dev-only features and retains strict release feature checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-feature-graph-'));
  try {
    await writeFile(join(root, 'Cargo.toml'), '[workspace]\nmembers=["desktop","tauri"]\nresolver="2"\n');
    for (const name of ['desktop', 'tauri']) {
      await mkdir(join(root, name, 'src'), { recursive: true });
      await writeFile(join(root, name, 'src/lib.rs'), '');
    }
    const manifest = '[package]\nname="ariadne-desktop"\nversion="0.1.0"\nedition="2021"\n[features]\ne2e=[]\n[dependencies]\ntauri={path="../tauri"}\n[dev-dependencies]\ntauri={path="../tauri",features=["test"]}\n';
    await writeFile(join(root, 'desktop/Cargo.toml'), manifest);
    await writeFile(join(root, 'tauri/Cargo.toml'), '[package]\nname="tauri"\nversion="0.1.0"\nedition="2021"\n[features]\ncustom-protocol=[]\ntest=[]\n');
    const cwd = join(root, 'desktop'), flags = ['--no-default-features', '--features', 'tauri/custom-protocol'];
    const metadata = JSON.parse((await command('cargo', ['metadata', '--offline', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin', ...flags], { cwd })).stdout);
    const desktop = metadata.packages.find(pkg => pkg.name === 'ariadne-desktop'), tauri = metadata.packages.find(pkg => pkg.name === 'tauri');
    assert.ok(metadata.resolve.nodes.find(node => node.id === tauri.id).features.includes('test'));
    const tree = async extra => (await command('cargo', ['tree', '--locked', '--offline', '--package', 'ariadne-desktop', '--target', 'aarch64-apple-darwin', ...flags, ...extra, '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}|{f}', '--no-dedupe'], { cwd })).stdout;
    const graph = await tree([]), features = normalBuildFeatures(graph, metadata);
    assert.deepEqual(features[tauri.id], ['custom-protocol']);
    const events = [{ reason: 'build-script-executed', package_id: desktop.id, out_dir: '/fresh/out' }, ...[desktop, tauri].map(pkg => ({ reason: 'compiler-artifact', package_id: pkg.id, features: features[pkg.id], target: { kind: ['lib'] } }))];
    const output = () => events.map(event => JSON.stringify(event)).join('\n');
    assert.equal(buildArtifacts(output(), metadata, features), '/fresh/out');
    events[2].features = ['custom-protocol', 'test'];
    assert.throws(() => buildArtifacts(output(), metadata, features), /Compiler features differ/);
    events[2].features = features[tauri.id];
    await writeFile(join(root, 'desktop/Cargo.toml'), manifest.replace('tauri={path="../tauri"}\n', 'tauri={path="../tauri",features=["test"]}\n'));
    const normalLeak = normalBuildFeatures(await tree([]), metadata);
    assert.ok(normalLeak[tauri.id].includes('test'));
    assert.throws(() => buildArtifacts(output(), metadata, normalLeak), /Compiler features differ/);
    const e2e = normalBuildFeatures(await tree(['--features', 'e2e']), metadata);
    events[1].features = e2e[desktop.id]; events[2].features = e2e[tauri.id];
    assert.throws(() => buildArtifacts(output(), metadata, e2e));
    assert.throws(() => normalBuildFeatures(graph, { ...metadata, packages: [...metadata.packages, { ...tauri, id: 'another-tauri' }] }), /Ambiguous/);
    assert.throws(() => normalBuildFeatures(graph.replace('desktop)', 'desktop|ambiguous)'), metadata), /Malformed/);
    assert.throws(() => normalBuildFeatures(graph.replace('tauri v0.1.0', 'tauri v0.1.01'), metadata), /Missing normal\/build/);
    assert.throws(() => normalBuildFeatures(graph + graph.split('\n').find(line => line.startsWith('tauri v')) + ',unexpected\n', metadata), /Ambiguous normal\/build/);
  } finally { await rm(root, { recursive: true }); }
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
test('reference isolation excludes only test mounts/runtime and allows reusable product primitives', () => {
  const modules = ['/node_modules/react/index.js', '/apps/desktop/src/components/reference/StatusBadge.tsx', '/apps/desktop/src/components/reference/TreeRow.tsx', '/apps/desktop/src/components/reference/AnswerControl.tsx', '/apps/desktop/src/components/reference/MessageExcerpt.tsx'];
  const files = ['index.html', 'assets/main.js', 'fonts/inter-latin.woff2', 'styles/design-tokens.css'];
  verifyReferenceIsolation(modules, files);
  for (const path of ['/tests/ui/reference/gallery.tsx', '/tests/ui/reference/cases.tsx', '/tests/ui/reference/source-runtime/node_modules/react/umd/react.production.min.js', '/node_modules/@babel/standalone/babel.min.js', '/node_modules/@playwright/test/index.js', '/node_modules/playwright-core/lib/index.js', '/designs/Ariadne UI mockups.zip']) assert.throws(() => verifyReferenceIsolation([...modules, path], files), /production modules/);
  for (const path of ['gallery.html', 'source/support.js', 'source/Item Row.dc.html', 'source-runtime/react.js', 'tests/ui/reference/fixture.json', 'Ariadne UI mockups.zip']) assert.throws(() => verifyReferenceIsolation(modules, [...files, path]), /production files/);
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
test('production CSP and minimum macOS reject unsafe template defaults and broadened resources', async () => {
  const config = JSON.parse(await readFile(new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  verifyProductionSecurity(config);
  for (const csp of [null, { ...config.app.security.csp, 'script-src': "'self' 'unsafe-eval'" }, { ...config.app.security.csp, 'img-src': 'https://images.example.test' }]) {
    assert.throws(() => verifyProductionSecurity({ ...config, app: { ...config.app, security: { ...config.app.security, csp } } }), /CSP/);
  }
  assert.throws(() => verifyProductionSecurity({ ...config, app: { ...config.app, security: { ...config.app.security, dangerousDisableAssetCspModification: true } } }), /hashes/);
  assert.throws(() => verifyProductionSecurity({ ...config, bundle: { ...config.bundle, macOS: { minimumSystemVersion: '10.13' } } }));
});
test('release gate rejects a recorded cleanup failure instead of reporting success', () => {
  verifyCleanup({ pidExited: true, portFree: true });
  assert.throws(() => verifyCleanup({ pidExited: false, portFree: true }), /PID did not exit/);
  assert.throws(() => verifyCleanup({ pidExited: true, portFree: false }), /port is not free/);
});
