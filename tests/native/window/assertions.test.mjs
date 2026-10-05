import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertReleaseArtifacts, assertContinuity, assertGeometry, assertPin, assertRestored, assertQuit } from './assertions.mjs';
import { probeControlSocket } from './run.mjs';

const route = { project_id: 'project', session_id: 'session', item_id: '1.1' };
const record = () => ({
  primary: { pid: 12, exe: '/private/Ariadne.app/Contents/MacOS/ariadne-desktop', birth: 'today', parent: 11 },
  ownership: { pid: 12, socket: { dev: 1, ino: 2 }, lease: { dev: 1, ino: 3 }, leaseHeld: true },
  sessionSha256: 'original',
  preferences: { revision: 5, global: { pinned: false, window: { x: 20, y: 30, width: 1000, height: 700, monitor_id: 'display@0,0' },
    selected_navigation: { kind: 'session', session: route } }, sessions: [{ session: route, tab_open: true, selected_item_id: '1.1' }] },
});

test('physical supplement requires the same proved production artifacts and successful release cleanup', () => {
  const release = { passed: true, ordinaryRuntimeOwned: true, binarySha256: 'app' };
  const routes = { passed: true, helperSha256: 'cli' };
  const cleanup = { pidExited: true, portFree: true, remainingPids: [] };
  assertReleaseArtifacts(release, routes, cleanup, 'app', 'cli');
  assert.throws(() => assertReleaseArtifacts(release, routes, cleanup, 'instrumented-or-stale', 'cli'));
  assert.throws(() => assertReleaseArtifacts(release, routes, cleanup, 'app', 'different-cli'));
  assert.throws(() => assertReleaseArtifacts({ ...release, passed: false }, routes, cleanup, 'app', 'cli'));
  assert.throws(() => assertReleaseArtifacts(release, routes, { ...cleanup, pidExited: false }, 'app', 'cli'));
});

test('close/minimize/Show must retain the same primary, inode ownership, selection and domain bytes', () => {
  const before = record(), after = record();
  after.preferences.revision++;
  assertContinuity(before, after, route);
  for (const mutate of [
    value => { value.primary.birth = 'reused PID'; },
    value => { value.primary.pid++; },
    value => { value.ownership.socket.ino++; },
    value => { value.ownership.lease.ino++; },
    value => { value.sessionSha256 = 'changed'; },
    value => { value.preferences.sessions[0].selected_item_id = '3'; },
    value => { value.preferences.sessions.push(value.preferences.sessions[0]); },
    value => { value.preferences.revision--; },
  ]) {
    const broken = record(); mutate(broken);
    assert.throws(() => assertContinuity(before, broken, route));
  }
});

test('Pin requires canonical persistence, a new revision and retained ownership', () => {
  const before = record(), after = record();
  after.preferences.revision++; after.preferences.global.pinned = true;
  assertPin(before, after, true, route);
  for (const mutate of [
    value => { value.preferences.revision = before.preferences.revision; },
    value => { value.ownership.lease.ino++; },
    value => { value.preferences.sessions[0].selected_item_id = '3'; },
    value => { value.preferences.global.pinned = false; },
  ]) {
    const broken = JSON.parse(JSON.stringify(after)); mutate(broken);
    assert.throws(() => assertPin(before, broken, true, route));
  }
});

test('geometry compares actual outer frame and rejects inner height, missing monitor and nonfinite data', () => {
  const snapshot = record().preferences;
  const rectangle = { x: 20, y: 30, width: 1000, height: 700 };
  assertGeometry(snapshot, rectangle);
  assert.throws(() => assertGeometry(snapshot, { ...rectangle, height: 668 }));
  assert.throws(() => assertGeometry(snapshot, { ...rectangle, x: NaN }));
  const broken = JSON.parse(JSON.stringify(snapshot)); broken.global.window.monitor_id = null;
  assert.throws(() => assertGeometry(broken, rectangle));
});

test('restart must retain committed Pin and moved geometry as well as the route', () => {
  const before = record(), restored = record();
  before.preferences.global.pinned = true; restored.preferences.global.pinned = true;
  const rectangle = { x: 20, y: 30, width: 1000, height: 700 };
  assertRestored(before, restored, rectangle, route);
  restored.preferences.global.window.x = 0;
  assert.throws(() => assertRestored(before, restored, { ...rectangle, x: 0 }, route));
  restored.preferences.global.window.x = 20; restored.preferences.global.pinned = false;
  assert.throws(() => assertRestored(before, restored, rectangle, route));
});

test('Quit proof cannot substitute forced cleanup or process exit for socket and lease release', () => {
  const quit = { pidExited: true, remainingPids: [], socketAbsent: false,
    controlConnection: { connectionAccepted: false, errorCode: 'ECONNREFUSED' }, leaseReleased: true, sessionUnchanged: true };
  assertQuit(quit);
  assertQuit({ ...quit, socketAbsent: true, controlConnection: { connectionAccepted: false, errorCode: 'ENOENT' } });
  for (const key of ['pidExited', 'leaseReleased', 'sessionUnchanged']) {
    assert.throws(() => assertQuit({ ...quit, [key]: false }));
  }
  assert.throws(() => assertQuit({ ...quit, remainingPids: [99] }));
  for (const controlConnection of [undefined, { connectionAccepted: true },
    { connectionAccepted: false }, { connectionAccepted: 'false', errorCode: 'ENOENT' },
    ...['EACCES', 'ETIMEDOUT', 'ECONNRESET', 'ABORT_ERR'].map(errorCode => ({ connectionAccepted: false, errorCode }))]) {
    assert.throws(() => assertQuit({ ...quit, controlConnection }));
  }
});

test('control release probe distinguishes a live Unix listener, stale socket and absent endpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-socket-'));
  const path = join(root, 'control.sock'), stale = join(root, 'stale.sock');
  const server = createServer(socket => socket.destroy());
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(path, resolve);
  });
  assert.deepEqual(await probeControlSocket(path), { connectionAccepted: true });
  // Node unlinks its original pathname on close. Move this owned fixture socket
  // first to retain a genuine stale socket, as Rust shutdown can do.
  await rename(path, stale);
  await new Promise(resolve => server.close(resolve));
  assert.deepEqual(await probeControlSocket(stale), { connectionAccepted: false, errorCode: 'ECONNREFUSED' });
  assert.deepEqual(await probeControlSocket(path), { connectionAccepted: false, errorCode: 'ENOENT' });
});

test('a cancelled control probe cannot be recorded as endpoint release', () => {
  const controller = new globalThis.AbortController();
  controller.abort(new Error('cancelled fixture'));
  assert.throws(() => probeControlSocket('/unused-fixture.sock', controller.signal), /cancelled fixture/);
});
