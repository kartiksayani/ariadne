import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installSearchTimingObservation, takeSearchTimingObservation } from '../../../apps/desktop/tests/e2e/search-timing-observation.mjs';

function webview(invoke) {
  let time = 0;
  const internals = {};
  Object.defineProperty(internals, 'invoke', { value: invoke });
  const window = { __TAURI_INTERNALS__: internals, performance: { now: () => ++time } };
  const context = vm.createContext({ window });
  const execute = callback => vm.runInContext(`(${callback.toString()})()`, context);
  return { window, execute, take: () => JSON.parse(JSON.stringify(execute(takeSearchTimingObservation))) };
}

test('serialized renderer observer preserves the real non-writable invoke and call behavior', async () => {
  const payload = { body: 'Never retain this payload' }, result = { saved: true }, promise = Promise.resolve(result), calls = [];
  function original(...args) { calls.push({ receiver: this, args }); return promise; }
  const view = webview(original);
  const descriptor = Object.getOwnPropertyDescriptor(view.window.__TAURI_INTERNALS__, 'invoke');
  assert.equal(view.execute(installSearchTimingObservation).installed, true);
  view.window.__ariadneSearchTimingObservation.mark('input');
  const returned = view.window.__TAURI_INTERNALS__.invoke('preferences_patch', payload, { option: true });
  assert.equal(returned, promise); assert.equal(await returned, result);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, view.window.__TAURI_INTERNALS__);
  assert.deepEqual(calls[0].args, ['preferences_patch', payload, { option: true }]);
  view.window.__ariadneSearchTimingObservation.mark('result');
  view.window.__ariadneSearchTimingObservation.mark('frame');
  const observed = view.take();
  assert.deepEqual(observed, { mode: 'renderer_only', ipcObserved: false, records: [
    { kind: 'renderer', phase: 'input', time: 1 },
    { kind: 'renderer', phase: 'result', time: 2 }, { kind: 'renderer', phase: 'frame', time: 3 },
  ], dropped: 0 });
  assert.deepEqual(Object.getOwnPropertyDescriptor(view.window.__TAURI_INTERNALS__, 'invoke'), descriptor);
  assert.equal(view.window.__TAURI_INTERNALS__.invoke, original);
  assert.equal(view.window.__ariadneSearchTimingObservation, undefined);
});

test('rejected promises and synchronous exceptions retain exact original errors', async () => {
  const error = new Error('Original failure'), promise = Promise.reject(error);
  const view = webview(() => promise); view.execute(installSearchTimingObservation);
  assert.equal(view.window.__TAURI_INTERNALS__.invoke('preferences_get'), promise);
  await assert.rejects(promise, failure => failure === error);
  assert.deepEqual(view.take().records, []);
  const synchronous = webview(() => { throw error; }); synchronous.execute(installSearchTimingObservation);
  assert.throws(() => synchronous.window.__TAURI_INTERNALS__.invoke('preferences_patch'), failure => failure === error);
  assert.deepEqual(synchronous.take().records, []);
});

test('renderer phase allowlist and cap bound records', () => {
  const view = webview(undefined); view.execute(installSearchTimingObservation);
  const observer = view.window.__ariadneSearchTimingObservation;
  observer.mark('unrecognized');
  for (let n = 0; n < 300; n++) observer.mark('input');
  const observed = view.take();
  assert.equal(observed.records.length, 256); assert.equal(observed.dropped, 44);
  assert.ok(observed.records.every(record => record.kind === 'renderer' && record.phase === 'input'));
});

test('collection disables retained marks and returns independent records', () => {
  const view = webview(undefined); view.execute(installSearchTimingObservation);
  const observer = view.window.__ariadneSearchTimingObservation;
  observer.mark('result');
  const first = observer.take(); first.records[0].phase = 'changed copy';
  observer.mark('frame');
  const second = observer.take();
  assert.equal(second.records.length, 1); assert.equal(second.records[0].phase, 'result');
  assert.equal(view.window.__ariadneSearchTimingObservation, undefined);
});

test('renderer observation needs no Tauri and duplicate installation preserves its owner', () => {
  const view = webview(undefined); delete view.window.__TAURI_INTERNALS__;
  assert.equal(view.take().reason, 'not_installed');
  assert.equal(view.execute(installSearchTimingObservation).installed, true);
  const owner = view.window.__ariadneSearchTimingObservation;
  assert.equal(view.execute(installSearchTimingObservation).reason, 'already_installed');
  assert.equal(view.window.__ariadneSearchTimingObservation, owner);
  const replacement = {}; view.window.__ariadneSearchTimingObservation = replacement;
  assert.equal(owner.take().ipcObserved, false);
  assert.equal(view.window.__ariadneSearchTimingObservation, replacement);
});
