// Self-contained callbacks: WebDriver serializes these into the real WebView.
// Record timings only; production requests, promises and payloads stay intact.
export function installSearchTimingObservation() {
  if (window.__ariadneSearchTimingObservation) return { installed: false, reason: 'already_installed' };
  const internals = window.__TAURI_INTERNALS__, original = internals?.invoke;
  if (typeof original !== 'function') return { installed: false, reason: 'invoke_unavailable' };
  const commands = new Set(['preferences_patch', 'preferences_get', 'project_list', 'session_list', 'session_get']);
  const records = [];
  let active = true, dropped = 0;
  const append = record => {
    if (!active) return false;
    if (records.length === 256) { dropped++; return false; }
    records.push(record); return true;
  };
  function observedInvoke(command, ...args) {
    if (!active || !commands.has(command)) return Reflect.apply(original, this, [command, ...args]);
    const record = { kind: 'ipc', command, start: window.performance.now(), end: null };
    if (!append(record)) return Reflect.apply(original, this, [command, ...args]);
    const finish = () => { if (active) record.end = window.performance.now(); };
    let result;
    try { result = Reflect.apply(original, this, [command, ...args]); }
    catch (error) { finish(); throw error; }
    result.then(finish, finish);
    return result;
  }
  const observation = {
    mark(phase) {
      if (phase === 'input' || phase === 'result' || phase === 'frame') {
        append({ kind: 'renderer', phase, time: window.performance.now() });
      }
    },
    take() {
      active = false;
      const restored = internals.invoke === observedInvoke;
      if (restored) internals.invoke = original;
      if (window.__ariadneSearchTimingObservation === observation) delete window.__ariadneSearchTimingObservation;
      return { records: records.map(record => ({ ...record })), dropped, restored };
    },
  };
  internals.invoke = observedInvoke;
  window.__ariadneSearchTimingObservation = observation;
  return { installed: true };
}

export function takeSearchTimingObservation() {
  return window.__ariadneSearchTimingObservation?.take()
    ?? { records: [], dropped: 0, restored: false, reason: 'not_installed' };
}
