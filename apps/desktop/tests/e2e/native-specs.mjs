// `--spec <name>` support for scripts/run-native-e2e.mjs: run only some acceptance blocks of native-smoke.spec.mjs.
// A name is the file stem of the block's spec (tree.spec.mjs -> tree). Each list is closed under the `dependencies`
// the spec declares for its blocks; the process-contract suite keeps both in step with native-smoke.spec.mjs.
export const NATIVE_SPECS = {
  discovery: ['runDiscoveryAcceptance'],
  tree: ['runTreeAcceptance', 'restoreTreeAcceptance'],
  history: ['runTreeAcceptance', 'runHistoryAcceptance', 'restoreHistoryAcceptance'],
  'history-actions': ['runDiscoveryAcceptance', 'runHistoryActionsAcceptance'],
  accessibility: ['runAccessibilityAcceptance'],
  remove: ['runDiscoveryAcceptance', 'runHistoryActionsAcceptance', 'runRemoveAcceptance'],
  graph: ['runTreeAcceptance', 'restoreTreeAcceptance', 'runGraphAcceptance'],
  recovery: ['runRecoveryAcceptance'],
};
// Blocks the spec runs after the app restarts. Everything else runs in the first (delivery) launch.
export const RESTORATION_BLOCKS = new Set([
  'restoreTreeAcceptance', 'runGraphAcceptance', 'restoreHistoryAcceptance', 'runRecoveryAcceptance',
]);

// The block names for one or more `--spec` names, in a stable order without repeats.
export function blocksForSpecs(names) {
  const blocks = new Set();
  for (const name of names) {
    if (!Object.hasOwn(NATIVE_SPECS, name)) throw new Error(`Unknown native spec "${name}"; use one of: ${Object.keys(NATIVE_SPECS).join(', ')}`);
    for (const block of NATIVE_SPECS[name]) blocks.add(block);
  }
  return [...blocks];
}

// What the spec reads from ARIADNE_E2E_BLOCKS: null runs every block, otherwise the listed block names.
export function selectedBlocks(value) {
  if (!value) return null;
  const known = new Set(Object.values(NATIVE_SPECS).flat());
  const names = value.split(',').filter(Boolean);
  const unknown = names.filter(name => !known.has(name));
  if (!names.length || unknown.length) throw new Error(`Unknown native acceptance blocks: ${unknown.join(', ') || value}`);
  return new Set(names);
}
