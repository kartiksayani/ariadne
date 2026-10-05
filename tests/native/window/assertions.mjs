import assert from 'node:assert/strict';
import { packagedRouteSelected, verifyCleanup } from '../../../scripts/check-release-boundary.mjs';

export function assertReleaseArtifacts(release, routes, cleanup, binarySha256, helperSha256) {
  assert.equal(release.passed, true, 'Ordinary release boundary has not passed');
  assert.equal(release.ordinaryRuntimeOwned, true, 'Release did not prove ordinary runtime ownership');
  assert.equal(routes.passed, true, 'Ordinary packaged route supplement has not passed');
  verifyCleanup(cleanup);
  assert.equal(binarySha256, release.binarySha256, 'Window App differs from the proved ordinary release');
  assert.equal(helperSha256, routes.helperSha256, 'Window CLI differs from the proved installed helper');
}

export function assertGeometry(snapshot, rectangle) {
  const geometry = snapshot.global.window;
  assert.ok(geometry, 'Canonical native geometry is absent');
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isFinite(geometry[key]) && Number.isFinite(rectangle[key]), 'Invalid native geometry');
    assert.ok(Math.abs(geometry[key] - rectangle[key]) <= 2, `Saved outer-frame ${key} differs from XCTest`);
  }
  assert.ok(geometry.width > 0 && geometry.height > 0);
  assert.equal(typeof geometry.monitor_id, 'string');
}

export function assertContinuity(before, after, route) {
  assert.deepEqual(after.primary, before.primary, 'Window action replaced the primary process');
  assert.deepEqual(after.ownership, before.ownership, 'Window action replaced socket or lease ownership');
  assert.equal(after.sessionSha256, before.sessionSha256, 'Window action mutated the canonical session');
  assert.ok(packagedRouteSelected(after.preferences, route), 'Window action changed the registered selection');
  assert.ok(after.preferences.revision >= before.preferences.revision, 'Preferences revision regressed');
}

export function assertPin(before, after, expected, route) {
  assertContinuity(before, after, route);
  assert.equal(after.preferences.global.pinned, expected, 'Canonical Pin did not commit');
  assert.ok(after.preferences.revision > before.preferences.revision, 'Pin has no new canonical commit');
  // Visible native checkmarks require independent review of scoped screenshots.
  // Canonical persistence alone does not prove that physical acceptance.
}

export function assertRestored(before, after, rectangle, route) {
  assert.equal(after.sessionSha256, before.sessionSha256, 'Restart mutated the canonical session');
  assert.ok(packagedRouteSelected(after.preferences, route), 'Restart lost the registered selection');
  assert.equal(after.preferences.global.pinned, before.preferences.global.pinned, 'Restart lost the committed Pin');
  assert.deepEqual(after.preferences.global.window, before.preferences.global.window, 'Restart lost the committed geometry');
  assertGeometry(after.preferences, rectangle);
}

export function assertQuit(record) {
  assert.equal(record.pidExited, true, 'Physical Quit did not exit its primary PID');
  assert.deepEqual(record.remainingPids, [], 'A private packaged process survived Quit');
  assert.equal(record.controlConnection?.connectionAccepted, false, 'Quit retained private control admission');
  assert.ok(['ECONNREFUSED', 'ENOENT'].includes(record.controlConnection.errorCode), 'Control release lacks a refused or absent endpoint observation');
  assert.equal(record.leaseReleased, true, 'Quit retained its instance lease');
  assert.equal(record.sessionUnchanged, true, 'Quit mutated the canonical session');
}
