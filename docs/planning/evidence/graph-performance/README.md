# Graph viewport evidence (P5.2 / V27)

The fixture renders the actual `SessionTopicGraph`, existing deterministic layout,
registered reveal routes and session store with a scripted desktop transport.
It contains 2,000 items in twenty ordered trees of 100 items. The replacement
from `1.1` to `20.99` crosses the initial viewport with both endpoints off screen.
No provider or external network is used.

## Reproduce and retained measurements

```sh
npm run test:ui -- apps/desktop/tests/ui/graph-culling
npm run test:design -- --project graph-2000
```

The browser project runs once at 1000×700 in the existing reference capture
command. Relevant pushed-head CI provisions the pinned Chromium package and runs
it; the existing `quality-evidence-<run>-<attempt>-static` artifact retains:

- `coverage/graph-performance/measurements.json`: actual source commit, browser
  version, platform, viewport, initial rendered node/edge counts, layout/index
  time, query p95 at 25/50/100/200% zoom, React Profiler mount/update durations,
  and thirty batches of eight wheel events timed through two animation frames.
- `coverage/graph-performance/graph-2000.png`: actual component screenshot.
- The existing Playwright report/trace and an attached measurement JSON.

Profiler samples measure rendering work. Navigation-to-settled and wheel-to-settled
times also include module loading/frame waits; they are reported separately and
must not be interpreted as rendering cost. This development-browser fixture is
not a packaged build benchmark. The browser test guards against more than 199
initial node elements, a mount above 1,000 ms, or an update above 250 ms; these are
broad regression limits, not a claimed native frame-rate guarantee.

## Correctness and acceptance limits

Focused unit tests compare the indexed results with brute-force intersection
over the complete layout at four zoom levels and cell boundaries. They prove
deduplication, the 300-node threshold, retained selected/focused nodes, crossing
edges, frame coalescing, no relayout during pan/zoom, centering before remote
selection focus, full-bounds Fit, and tree/graph search counts and ancestry.
The browser test exercises the same component with actual SVG focus, pointer
capture, wheel events, shared selection and the accessible tree fallback.

Passing component tests and browser measurements establish the implemented
renderer mechanism. Full P5.2/V27 acceptance remains pending the assembled App
route and real Tauri/core/store/native WebView join at the original dependencies.
No manual macOS or packaged-native performance qualification is claimed.
