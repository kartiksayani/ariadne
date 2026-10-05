// Self-contained callbacks: WebDriver serializes these into the real WebView.
// Renderer timings only: Tauri's non-writable invoke cannot be intercepted.
export function installSearchTimingObservation() {
  if (window.__ariadneSearchTimingObservation) return { installed: false, reason: 'already_installed' };
  const records = [];
  let active = true, dropped = 0;
  const append = record => {
    if (!active) return false;
    if (records.length === 256) { dropped++; return false; }
    records.push(record); return true;
  };
  const observation = {
    mark(phase) {
      if (phase === 'input' || phase === 'result' || phase === 'frame') {
        append({ kind: 'renderer', phase, time: window.performance.now() });
      }
    },
    take() {
      active = false;
      if (window.__ariadneSearchTimingObservation === observation) delete window.__ariadneSearchTimingObservation;
      return { mode: 'renderer_only', ipcObserved: false, records: records.map(record => ({ ...record })), dropped };
    },
  };
  window.__ariadneSearchTimingObservation = observation;
  return { installed: true, mode: 'renderer_only', ipcObserved: false };
}

export function takeSearchTimingObservation() {
  return window.__ariadneSearchTimingObservation?.take()
    ?? { mode: 'renderer_only', ipcObserved: false, records: [], dropped: 0, reason: 'not_installed' };
}
