import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const desktop = join(repo, 'apps/desktop');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
export function sourceState(cwd = repo) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();
  const statusPorcelain = git(['status', '--porcelain']);
  return {
    head: git(['rev-parse', 'HEAD']),
    indexTree: git(['write-tree']),
    dirty: Boolean(statusPorcelain.trim()),
    statusPorcelain,
    trackedDiffNameStatus: git(['diff', '--name-status', 'HEAD', '--']),
  };
}
export function toolchain() {
  const versions = [
    ['rustc', ['--version']], ['cargo', ['--version']],
    ['cargo', ['llvm-cov', '--version']], ['npm', ['--version']],
    ['/usr/bin/sw_vers', []], ['/usr/bin/uname', ['-m']],
    ['/usr/bin/xcode-select', ['-p']], ['/usr/bin/xcodebuild', ['-version']],
    ['/usr/bin/xcrun', ['--show-sdk-version']], ['/usr/bin/xcrun', ['--show-sdk-path']],
  ];
  return { node: process.version,
    versions: versions.map(([binary, args]) => ({ binary, args, output: execFileSync(binary, args, { encoding: 'utf8' }).trim() })),
    source: sourceState() };
}
export async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}
export function selector(args) {
  if (!args.length) return 'all';
  if (args.length !== 2 || args[0] !== '--suite' || !['all', 'native', 'process-contract'].includes(args[1])) throw new Error('Use --suite all|native|process-contract');
  return args[1];
}
export async function portFree(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid driver port');
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} occupied; choose ARIADNE_E2E_PORT=<free-port>`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
export function listeners(port) {
  try { return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }); }
  catch (error) { if (error.status === 1) return ''; throw error; }
}
export function identity(pid) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid PID');
  const exe = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  const birth = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  const parent = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
  if (!exe || !birth || !parent) throw new Error('Process unavailable');
  return { pid, exe, birth, parent };
}
export function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
export function groupAlive(pid) { try { process.kill(-pid, 0); return true; } catch { return false; } }
export async function observeOwned(root, binary, nonce, launcher, timeout = 60000, signal) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (signal?.aborted) throw signal.reason;
    let startup;
    try { startup = JSON.parse(await readFile(join(root, 'startup.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(50); continue; }
    if (startup.nonce !== nonce) throw new Error('Startup nonce mismatch');
    const observed = identity(startup.pid), ancestry = [observed];
    if (observed.exe !== binary) throw new Error('Startup executable mismatch');
    let current = observed;
    while (current.parent > 1 && ancestry.length < 32) {
      current = identity(current.parent); ancestry.push(current);
      if (current.pid === launcher) {
        const proof = { ...observed, ancestry };
        await json(join(root, 'observed.json'), proof); return proof;
      }
    }
    throw new Error('Startup PID is outside the owned launcher ancestry');
  }
  throw new Error('Startup witness deadline');
}
export async function activateOwned(root, binary, nonce) {
  const owned = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'));
  const launcher = JSON.parse(await readFile(join(root, 'launcher.json'), 'utf8'));
  const current = identity(owned.pid);
  if (owned.exe !== binary || current.exe !== binary || current.birth !== owned.birth) {
    throw new Error('Refusing to activate changed native process identity');
  }
  // Recheck the startup nonce and actual ancestry against the owned launcher;
  // a saved PID alone cannot authorize affecting another macOS application.
  const verified = await observeOwned(root, binary, nonce, launcher.pid, 1000);
  if (verified.pid !== owned.pid || verified.birth !== owned.birth) throw new Error('Native activation witness identity mismatch');
  const source = `function run(args) {
    ObjC.import('AppKit');
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
    app.unhide;
    if (!app.activateWithOptions(2)) throw new Error('Owned native application activation failed');
  }`;
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source, String(owned.pid)], { encoding: 'utf8', timeout: 5000 });
}
export async function releasedLeases(home, bindingId) {
  const paths = [join(home, 'run/runtime.lock'), join(home, 'run/leases', `${bindingId}.lock`)];
  const source = 'import fcntl,sys\nfor path in sys.argv[1:]:\n with open(path,"r+b") as lock:\n  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\n';
  await command('python3', ['-c', source, ...paths], { timeout: 10000 });
  return { paths, released: true };
}
export async function proveQuit(root, binary, nonce, owned, home, bindingId, port) {
  const request = JSON.parse(await readFile(join(root, 'quit-request.json'), 'utf8'));
  if (request.nonce !== nonce || request.pid !== owned.pid) throw new Error('Quit witness identity mismatch');
  await waitForQuitExit(binary, owned);
  await portFree(port);
  return { request, pidExited: true, portFree: true, leases: await releasedLeases(home, bindingId) };
}
export function isSameBirthZombie(owned, current, state) {
  return current.pid === owned.pid && current.birth === owned.birth && state?.startsWith('Z') === true;
}
export async function waitForQuitExit(binary, owned) {
  const end = Date.now() + 10000;
  while (alive(owned.pid) && Date.now() < end) {
    let current;
    try { current = identity(owned.pid); }
    catch (error) { if (!alive(owned.pid)) break; throw error; }
    if (current.exe !== binary || current.birth !== owned.birth) {
      if (!alive(owned.pid)) break;
      let state;
      if (current.birth === owned.birth) {
        try { state = execFileSync('/bin/ps', ['-p', String(owned.pid), '-o', 'stat='], { encoding: 'utf8' }).trim(); }
        catch (error) { if (!alive(owned.pid)) break; throw error; }
      }
      // macOS temporarily retains the same exited process until its parent
      // reaps it. A zombie is not sufficient Quit proof: keep waiting for
      // actual disappearance, and reject every live or reused identity.
      if (!isSameBirthZombie(owned, current, state)) throw new Error(`Quit PID identity changed: ${JSON.stringify({ owned, current, state })}`);
    }
    await delay(25);
  }
  if (alive(owned.pid)) throw new Error('Requested native Quit did not exit before WDIO teardown');
}
export async function stop(child, grace = 10000) {
  if (!Number.isInteger(child.pid) || child.pid < 2) return;
  if (!groupAlive(child.pid) && !alive(child.pid)) return;
  try { process.kill(-child.pid, 'SIGINT'); } catch { /* Already exited. */ }
  const end = Date.now() + grace;
  while (groupAlive(child.pid) && Date.now() < end) await delay(50);
  if (groupAlive(child.pid)) {
    process.kill(-child.pid, 'SIGKILL');
    const killed = Date.now() + 1000;
    while (groupAlive(child.pid) && Date.now() < killed) await delay(50);
  }
  if (groupAlive(child.pid)) throw new Error('Owned process group did not exit');
  const reaped = Date.now() + 1000;
  while (alive(child.pid) && Date.now() < reaped) await delay(10);
  if (alive(child.pid)) throw new Error('Owned launcher PID did not exit');
}
export async function command(binary, args, { cwd = repo, env = process.env, timeout = 900000, log, onStart } = {}) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stdout = '', expired = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => { expired = true; void stop(child).catch(() => {}); }, timeout);
  const interrupted = () => { expired = true; void stop(child).catch(() => {}); };
  process.on('SIGINT', interrupted);
  try {
    onStart?.(child);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    if (log) { await mkdir(dirname(log), { recursive: true }); await writeFile(log, output); }
    if (code !== 0 || expired) throw new Error(`${binary} failed (${expired ? 'deadline/interruption' : code}); ${log || output}`);
    return { pid: child.pid, output, stdout };
  } finally { clearTimeout(timer); process.off('SIGINT', interrupted); await stop(child); }
}
export function buildEnv(target, e2e = false) {
  const env = { ...process.env, CARGO_TARGET_DIR: target, MACOSX_DEPLOYMENT_TARGET: '13.0', CARGO_BUILD_JOBS: '2', CARGO_INCREMENTAL: '0' };
  for (const key of Object.keys(env)) {
    if (/^(ARIADNE_E2E_|CARGO_FEATURE_|CARGO_ENCODED_RUSTFLAGS$|RUSTFLAGS$|TAURI_CONFIG$|TAURI_WEBDRIVER_PORT$|WDIO_EMBEDDED_SERVER$|VITE_ARIADNE_E2E$)/.test(key)) delete env[key];
  }
  if (e2e) env.VITE_ARIADNE_E2E = '1';
  return env;
}
export function nativeBuildEnv(target, e2e = false) {
  // Match shipped Rust optimization without disabling dev assertions or E2E
  // isolation. This override belongs only to the two native acceptance builds.
  return { ...buildEnv(target, e2e), CARGO_PROFILE_DEV_OPT_LEVEL: '1', CARGO_PROFILE_DEV_DEBUG_ASSERTIONS: 'true' };
}
export async function runNative() {
  if (process.platform !== 'darwin') throw new Error('Native E2E requires a logged-in macOS GUI session');
  const port = Number(process.env.ARIADNE_E2E_PORT || '4445'); await portFree(port);
  const run = randomUUID(), evidence = join(repo, 'coverage/native-e2e', run);
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp('/private/tmp/ariadne-e2e-'); await chmod(root, 0o700);
  const nonce = randomBytes(32).toString('hex');
  const binary = join(repo, 'target/native-e2e/debug/bundle/macos/Ariadne.app/Contents/MacOS/ariadne-desktop');
  let failure, owned, provider;
  try {
    const buildCommand = [process.execPath, join(repo, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--debug', '--features', 'e2e', '--bundles', 'app', '--config', 'src-tauri/tauri.e2e.conf.json', '--', '--locked'];
    const runtimeCommand = [process.execPath, join(repo, 'node_modules/@wdio/cli/bin/wdio.js'), 'run', 'wdio.native.conf.mjs'];
    const nativeEnv = nativeBuildEnv(join(repo, 'target/native-e2e'), true), cliEnv = nativeBuildEnv(join(repo, 'target/native-e2e'));
    const cliBuildCommand = ['cargo', 'build', '-p', 'ariadne-cli', '--locked'];
    const nativeProfile = { profile: 'dev', optLevel: Number(nativeEnv.CARGO_PROFILE_DEV_OPT_LEVEL),
      debugAssertions: nativeEnv.CARGO_PROFILE_DEV_DEBUG_ASSERTIONS === 'true', artifactDirectory: 'debug' };
    const details = { root, port, nonce, binary, toolchain: toolchain(), buildCommand, cliBuildCommand, nativeProfile, runtimeCommand, cwd: desktop };
    await json(join(evidence, 'run.json'), details);
    await command(buildCommand[0], buildCommand.slice(1), { cwd: desktop, env: nativeEnv, log: join(evidence, 'build.log') });
    await command(cliBuildCommand[0], cliBuildCommand.slice(1), { env: cliEnv, log: join(evidence, 'cli-build.log') });
    await command(process.execPath, ['--test', 'tests/e2e/process-contract/fixture-cli.test.mjs'], {
      env: { ...process.env, ARIADNE_FIXTURE_TEST_CLI: join(repo, 'target/native-e2e/debug/ariadne') }, log: join(evidence, 'fixture-cli.log'),
    });
    await command(process.execPath, ['--test', 'tests/e2e/tree/fixture.test.mjs', 'tests/e2e/process-contract/search-timing-observation.test.mjs'], {
      env: { ...process.env, ARIADNE_TREE_TEST_CLI: join(repo, 'target/native-e2e/debug/ariadne') }, log: join(evidence, 'tree-fixture.log'),
    });
    await json(join(evidence, 'run.json'), { ...details, binarySha256: await digest(binary) });
    const env = { ...buildEnv(join(repo, 'target/native-e2e')), ARIADNE_HOME: join(root, 'data'), ARIADNE_E2E_ROOT: root, ARIADNE_E2E_NONCE: nonce, ARIADNE_E2E_BINARY: binary, ARIADNE_E2E_PORT: String(port), ARIADNE_E2E_EVIDENCE: evidence };
    provider = await (await import('../apps/desktop/tests/e2e/scripted-provider.mjs')).startScriptedProvider(root, join(repo, 'target/native-e2e/debug/ariadne'), evidence, env);
    env.ARIADNE_E2E_APP_ARGS = JSON.stringify(provider.configuration.appArgs);
    for (const phase of ['delivery', 'restoration']) {
      const phaseEvidence = join(evidence, phase), phaseNonce = phase === 'delivery' ? nonce : randomBytes(32).toString('hex');
      await mkdir(phaseEvidence);
      if (phase === 'restoration') {
        if (owned && alive(owned.pid)) throw new Error('First native PID is still alive');
        await portFree(port);
        for (const name of ['startup.json', 'observed.json', 'launcher.json', 'quit-request.json']) await rm(join(root, name), { force: true });
      }
      const phaseEnv = { ...env, ARIADNE_E2E_PHASE: phase, ARIADNE_E2E_NONCE: phaseNonce, ARIADNE_E2E_EVIDENCE: phaseEvidence,
        ARIADNE_E2E_PRIOR_EVIDENCE: join(evidence, 'delivery') };
      await json(join(phaseEvidence, 'launch.json'), { nonce: phaseNonce, phase, priorPid: owned?.pid, binary, port });
      let launcher;
      const execution = command(runtimeCommand[0], runtimeCommand.slice(1), { cwd: desktop, env: phaseEnv, timeout: 300000, log: join(phaseEvidence, 'wdio.log'), onStart: child => {
        launcher = child; writeFileSync(join(root, 'launcher.json'), JSON.stringify({ pid: child.pid }));
      } });
      const controller = new globalThis.AbortController();
      execution.then(() => controller.abort(new Error('WDIO exited before startup observation')), error => controller.abort(error));
      try {
        const previous = owned;
        owned = await observeOwned(root, binary, phaseNonce, launcher.pid, 60000, controller.signal);
        if (previous && owned.pid === previous.pid) throw new Error('Relaunch reused the first native PID');
        await json(join(phaseEvidence, 'observed.json'), owned); await execution;
        const quit = JSON.parse(await readFile(join(phaseEvidence, 'quit.json'), 'utf8'));
        if (!quit.pidExited || !quit.leases?.released || quit.request.pid !== owned.pid || quit.request.nonce !== phaseNonce) throw new Error('Missing independently verified native Quit before teardown');
        await portFree(port);
      } catch (error) { await stop(launcher); await execution.catch(() => {}); throw error; }
    }
  } catch (error) { failure = error; }
  try { await provider?.stop(); } catch (error) { failure ||= error; }
  try {
      if (owned && alive(owned.pid)) {
        const current = identity(owned.pid);
        if (current.exe !== owned.exe || current.birth !== owned.birth || current.exe !== binary) throw new Error('Refusing to stop changed process identity');
        process.kill(owned.pid, 'SIGTERM');
        const end = Date.now() + 10000;
        while (alive(owned.pid) && Date.now() < end) await delay(50);
      }
      if (owned && alive(owned.pid)) throw new Error('Native PID did not exit');
      await portFree(port);
      await json(join(evidence, 'cleanup.json'), { pid: owned?.pid, pidExited: !owned || !alive(owned.pid), portFree: true, failure: failure?.message });
      await rm(root, { recursive: true });
  } catch (error) { failure ||= error; await json(join(evidence, 'cleanup-error.json'), { error: error.message, root }); }
  if (failure) throw failure;
  console.log(`Native evidence: ${evidence}`);
}
async function main() {
  const suite = selector(process.argv.slice(2));
  if (suite === 'process-contract') return command(process.execPath, ['--test', 'tests/e2e/process-contract/runner.test.mjs']);
  await runNative();
  if (suite === 'all') await (await import('./check-release-boundary.mjs')).checkRelease();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
