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
export async function runNative() {
  if (process.platform !== 'darwin') throw new Error('Native E2E requires a logged-in macOS GUI session');
  const port = Number(process.env.ARIADNE_E2E_PORT || '4445'); await portFree(port);
  const run = randomUUID(), evidence = join(repo, 'coverage/native-e2e', run);
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp('/private/tmp/ariadne-e2e-'); await chmod(root, 0o700);
  const nonce = randomBytes(32).toString('hex');
  const binary = join(repo, 'target/native-e2e/debug/ariadne-desktop');
  let failure, owned;
  try {
    const buildCommand = [process.execPath, join(repo, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--debug', '--features', 'e2e', '--no-bundle', '--config', 'src-tauri/tauri.e2e.conf.json', '--', '--locked'];
    const runtimeCommand = [process.execPath, join(repo, 'node_modules/@wdio/cli/bin/wdio.js'), 'run', 'wdio.native.conf.mjs'];
    const details = { root, port, nonce, binary, toolchain: toolchain(), buildCommand, runtimeCommand, cwd: desktop };
    await json(join(evidence, 'run.json'), details);
    await command(buildCommand[0], buildCommand.slice(1), { cwd: desktop, env: buildEnv(join(repo, 'target/native-e2e'), true), log: join(evidence, 'build.log') });
    await json(join(evidence, 'run.json'), { ...details, binarySha256: await digest(binary) });
    const env = { ...buildEnv(join(repo, 'target/native-e2e')), ARIADNE_E2E_ROOT: root, ARIADNE_E2E_NONCE: nonce, ARIADNE_E2E_BINARY: binary, ARIADNE_E2E_PORT: String(port), ARIADNE_E2E_EVIDENCE: evidence };
    let launcher;
    const execution = command(runtimeCommand[0], runtimeCommand.slice(1), { cwd: desktop, env, timeout: 180000, log: join(evidence, 'wdio.log'), onStart: child => {
      launcher = child; writeFileSync(join(root, 'launcher.json'), JSON.stringify({ pid: child.pid }));
    } });
    const controller = new globalThis.AbortController();
    execution.then(() => controller.abort(new Error('WDIO exited before startup observation')), error => controller.abort(error));
    try {
      owned = await observeOwned(root, binary, nonce, launcher.pid, 60000, controller.signal);
      await json(join(evidence, 'observed.json'), owned); await execution;
    }
    catch (error) { await stop(launcher); await execution.catch(() => {}); throw error; }
  } catch (error) { failure = error; }
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
