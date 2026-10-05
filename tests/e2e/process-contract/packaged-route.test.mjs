import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { preparePackagedRoutes, packagedRouteSelected, packagedOwnership, packagedPids, verifyCleanup } from '../../../scripts/check-release-boundary.mjs';
import { command, digest, identity, stop } from '../../../scripts/run-native-e2e.mjs';

const route = { project_id: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002', item_id: '1.1' };
function selected() {
  const session = { project_id: route.project_id, session_id: route.session_id };
  return { global: { selected_navigation: { kind: 'session', session } }, sessions: [{ session: { ...session }, tab_open: true, selected_item_id: route.item_id }] };
}
test('packaged route evidence requires the exact selected registered session and item', () => {
  assert.equal(packagedRouteSelected(selected(), route), true);
  for (const change of [
    value => { value.global.selected_navigation = { kind: 'projects' }; },
    value => { value.global.selected_navigation.session.project_id = 'another-project'; },
    value => { value.global.selected_navigation.session.session_id = 'another-session'; },
    value => { value.sessions[0].session.project_id = 'another-project'; },
    value => { value.sessions[0].session.session_id = 'another-session'; },
    value => { value.sessions[0].selected_item_id = '3'; },
    value => { value.sessions[0].tab_open = false; },
    value => { value.sessions = []; },
    value => { value.sessions.push(globalThis.structuredClone(value.sessions[0])); },
  ]) {
    const value = selected(); change(value);
    assert.equal(packagedRouteSelected(value, route), false);
  }
  assert.equal(packagedRouteSelected(undefined, route), false);
  assert.throws(() => verifyCleanup({ pidExited: true, portFree: true, remainingPids: [12345] }), /Additional packaged process remains/);
});

const cli = process.env.ARIADNE_FIXTURE_TEST_CLI;
test('private spaced package uses the actual CLI demo, helper version and scoped installation', { skip: !cli }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ariadne-packaged-fixture-')));
  const ownerHome = process.env.HOME;
  try {
    const bundle = join(root, 'built.app'), applicationData = join(root, 'data');
    const sourceBinary = join(bundle, 'Contents/MacOS/ariadne-desktop');
    await mkdir(dirname(sourceBinary), { recursive: true }); await mkdir(applicationData, { mode: 0o700 });
    // This file exercises package copying only. It is never launched, and this
    // cheap test does not claim native bundle or route-delivery acceptance.
    await writeFile(sourceBinary, 'fixture-only bundle bytes\n', { mode: 0o755 });
    const fixture = await preparePackagedRoutes(cli, bundle, root, applicationData, process.env);
    assert.equal(process.env.HOME, ownerHome, 'Owner HOME was modified');
    assert.equal(fixture.env.HOME, fixture.home); assert.equal(fixture.env.ARIADNE_HOME, applicationData);
    assert.ok(fixture.application.includes('home with spaces') && fixture.application.endsWith('Ariadne with spaces.app'));
    assert.equal(await digest(fixture.cli), await digest(cli));
    assert.equal(await digest(fixture.binary), await digest(sourceBinary));
    const packageRoot = join(fixture.home, '.local/share/ariadne');
    const version = (await command(fixture.cli, ['--version'], { env: fixture.env, timeout: 10000 })).stdout.trim().split(' ')[1];
    assert.equal(await readlink(join(packageRoot, 'current')), join('versions', version));
    const manifestPath = join(packageRoot, 'versions', version, 'install.json');
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), { schema_version: 1, version, app_path: fixture.application });
    const session = JSON.parse(fixture.before);
    assert.equal(session.title, 'Canonical domain v1 demo');
    assert.equal(session.id, route.session_id); assert.equal(session.project_id, route.project_id);
    assert.deepEqual(fixture.coldRoute, route); assert.equal(fixture.secondRoute.item_id, '3');
    assert.ok(Object.values(session.bindings).every(binding => binding.connection_state === 'disconnected' && binding.dispatch_state === 'disconnected'));
    await assert.rejects(readFile(fixture.preferencesPath), { code: 'ENOENT' }, 'Fixture must not manufacture renderer route evidence');
    // Real installed CLI validates the route before any macOS launch. A private
    // package cannot authorize an unrelated project or write the demo session.
    await assert.rejects(command(fixture.cli, ['open', '--project', '00000000-0000-4000-8000-000000000099', '--session', route.session_id, '--item', route.item_id], {
      env: fixture.env, timeout: 10000,
    }), /(?:NotFound|PermissionDenied):/);
    assert.deepEqual(await readFile(fixture.sessionPath), fixture.before);
    await assert.rejects(readFile(fixture.preferencesPath), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('packaged ownership guard checks real private socket, physical lease and process identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ariadne-packaged-owner-')));
  const run = join(root, 'run'); await mkdir(run);
  const source = 'import fcntl,os,signal,socket,sys,time\nroot=sys.argv[1]\nlock=open(os.path.join(root,"runtime.lock"),"w+b")\nfcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\ncontrol=socket.socket(socket.AF_UNIX)\ncontrol.bind(os.path.join(root,"control.sock"))\ncontrol.listen(1)\ndef release(_signum,_frame):\n fcntl.flock(lock,fcntl.LOCK_UN)\n print("released",flush=True)\nsignal.signal(signal.SIGUSR1,release)\nprint("ready",flush=True)\nwhile True: time.sleep(1)\n';
  const child = spawn('python3', ['-u', '-c', source, run], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const ready = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Private ownership fixture did not start')), 3000);
      child.stdout.once('data', value => { clearTimeout(deadline); resolve(value.toString().trim()); });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', code => { clearTimeout(deadline); reject(new Error(`Private ownership fixture exited (${code})`)); });
    });
    assert.equal(ready, 'ready');
    const observed = identity(child.pid), before = await packagedOwnership(root, child, observed);
    assert.equal(before.pid, child.pid); assert.equal(before.leaseHeld, true);
    assert.deepEqual(packagedPids(before.lease.path), [child.pid], 'OS query must select only this private opened file');
    assert.deepEqual(await packagedOwnership(root, child, observed, before), before);
    await assert.rejects(packagedOwnership(root, child, { ...observed, birth: 'different process birth' }), /identity changed/);
    await assert.rejects(packagedOwnership(root, child, observed, { ...before, socket: { ...before.socket, ino: before.socket.ino + 1 } }), /replaced the primary control ownership/);
    // A socket's existence alone is insufficient: releasing the actual instance
    // lease while the process remains alive must fail this proof.
    const released = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Private lease release did not complete')), 3000);
      child.stdout.once('data', value => { clearTimeout(deadline); resolve(value.toString().trim()); });
    });
    process.kill(child.pid, 'SIGUSR1'); assert.equal(await released, 'released');
    await assert.rejects(packagedOwnership(root, child, observed, before), /Live packaged instance lease was available/);
    await stop(child, 1000);
    assert.deepEqual(packagedPids(before.lease.path), []);
    await assert.rejects(packagedOwnership(root, child, observed), /process exited/);
  } finally { await stop(child, 1000); await rm(root, { recursive: true }); }
});
