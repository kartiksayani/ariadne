import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installSearchTimingObservation, takeSearchTimingObservation } from '../../../apps/desktop/tests/e2e/search-timing-observation.mjs';

function webview(invoke) {
  let time = 0;
  const window = { __TAURI_INTERNALS__: { invoke }, performance: { now: () => ++time } };
  const context = vm.createContext({ window });
  const execute = callback => vm.runInContext(`(${callback.toString()})()`, context);
  return { window, execute, take: () => JSON.parse(JSON.stringify(execute(takeSearchTimingObservation))) };
}

test('serialized observer calls original once with identical this, arguments, promise and result', async () => {
  const payload = { body: 'Never retain this payload' }, result = { saved: true }, promise = Promise.resolve(result), calls = [];
  function original(...args) { calls.push({ receiver: this, args }); return promise; }
  const view = webview(original);
  assert.equal(view.execute(installSearchTimingObservation).installed, true);
  view.window.__ariadneSearchTimingObservation.mark('input');
  const returned = view.window.__TAURI_INTERNALS__.invoke('preferences_patch', payload, { option: true });
  assert.equal(returned, promise); assert.equal(await returned, result);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, view.window.__TAURI_INTERNALS__);
  assert.deepEqual(calls[0].args, ['preferences_patch', payload, { option: true }]);
  view.window.__ariadneSearchTimingObservation.mark('result');
  view.window.__ariadneSearchTimingObservation.mark('frame');
  const observed = view.take();
  assert.deepEqual(observed, { records: [
    { kind: 'renderer', phase: 'input', time: 1 }, { kind: 'ipc', command: 'preferences_patch', start: 2, end: 3 },
    { kind: 'renderer', phase: 'result', time: 4 }, { kind: 'renderer', phase: 'frame', time: 5 },
  ], dropped: 0, restored: true });
  assert.equal(view.window.__TAURI_INTERNALS__.invoke, original);
  assert.equal(view.window.__ariadneSearchTimingObservation, undefined);
});

test('rejected promises and synchronous exceptions retain exact original errors', async () => {
  const error = new Error('Original failure'), promise = Promise.reject(error);
  const view = webview(() => promise); view.execute(installSearchTimingObservation);
  assert.equal(view.window.__TAURI_INTERNALS__.invoke('preferences_get'), promise);
  await assert.rejects(promise, failure => failure === error);
  assert.equal(view.take().records[0].end, 2);
  const synchronous = webview(() => { throw error; }); synchronous.execute(installSearchTimingObservation);
  assert.throws(() => synchronous.window.__TAURI_INTERNALS__.invoke('preferences_patch'), failure => failure === error);
  assert.equal(synchronous.take().records[0].end, 2);
});

test('allowlist and record cap bound observations without suppressing original calls', async () => {
  let calls = 0;
  const view = webview(() => { calls++; return Promise.resolve(null); }); view.execute(installSearchTimingObservation);
  await view.window.__TAURI_INTERNALS__.invoke('unobserved_command', { body: 'Private payload' });
  view.window.__ariadneSearchTimingObservation.mark('unrecognized');
  for (let n = 0; n < 300; n++) await view.window.__TAURI_INTERNALS__.invoke('session_get');
  const observed = view.take();
  assert.equal(calls, 301); assert.equal(observed.records.length, 256); assert.equal(observed.dropped, 44);
  assert.ok(observed.records.every(record => record.command === 'session_get' && record.end !== null));
});

test('restore preserves a later invoke owner and pending completions cannot change collected records', async () => {
  let complete;
  const promise = new Promise(resolve => { complete = resolve; });
  const view = webview(() => promise); view.execute(installSearchTimingObservation);
  view.window.__TAURI_INTERNALS__.invoke('preferences_patch');
  const replacement = () => Promise.resolve('New owner'); view.window.__TAURI_INTERNALS__.invoke = replacement;
  const observed = view.take(); assert.equal(observed.restored, false); assert.equal(observed.records[0].end, null);
  assert.equal(view.window.__TAURI_INTERNALS__.invoke, replacement);
  complete(); await promise;
  assert.equal(observed.records[0].end, null);
});

test('missing invoke and duplicate installation return visible diagnostics', () => {
  const view = webview(undefined);
  assert.equal(view.execute(installSearchTimingObservation).reason, 'invoke_unavailable');
  assert.equal(view.take().reason, 'not_installed');
  view.window.__TAURI_INTERNALS__.invoke = () => Promise.resolve(null);
  assert.equal(view.execute(installSearchTimingObservation).installed, true);
  assert.equal(view.execute(installSearchTimingObservation).reason, 'already_installed');
  assert.equal(view.take().restored, true);
});
