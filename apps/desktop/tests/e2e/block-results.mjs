import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const blockFailureSummary = results => results.filter(result => result.status !== 'passed')
  .map(result => `${result.name}: ${result.status}: ${result.error.message.split('\n')[0]}`).join('\n');

// Results include fatal lifecycle failures so publication never converts failed
// shutdown/recovery into an acceptance-only WDIO failure.
export async function completedBlockResults(evidence, failure) {
  if (failure && (failure.exitCode !== 1 || failure.expired)) throw failure;
  let results;
  try { results = JSON.parse(await readFile(join(evidence, 'block-results.json'), 'utf8')); }
  catch (error) { throw failure ?? error; }
  if (results.some(result => result.status === 'fatal')) throw failure ?? new Error(`Native acceptance lifecycle failed:\n${blockFailureSummary(results)}`);
  if (failure && !results.some(result => result.status !== 'passed')) throw failure;
  return results;
}

// Foundations run directly. Acceptance errors are retained; finish recovers any
// pending UI state, attempts shutdown and publishes all results even on failure.
// `only` (a Set of block names, or null for all) runs just those blocks; the others are neither run nor recorded.
// A selected block still needs its declared dependencies recorded, so `only` must be closed under them.
export function acceptanceBlocks({ evidence, reset, capture, priorResults = [], only = null }) {
  const results = [], known = new Map(priorResults.map(result => [result.name, result]));
  let needsReset = false;
  return {
    results,
    async run(name, action, dependencies = []) {
      if (only && !only.has(name)) return;
      const required = dependencies.map(dependency => {
        if (!known.has(dependency)) throw new Error(`Missing acceptance dependency: ${dependency}`);
        return known.get(dependency);
      });
      const blocked = required.find(result => result.status !== 'passed');
      if (blocked) {
        const dependency = blocked.error.dependency ?? blocked.name;
        const result = { name, status: 'skipped', ms: 0, error: { message: `skipped because ${dependency} failed`, stack: null, dependency } };
        results.push(result); known.set(name, result); return;
      }
      const started = Date.now();
      let error = null;
      try {
        if (needsReset) { await reset(); needsReset = false; }
        await action();
      } catch (failure) {
        error = { message: String(failure?.message ?? failure), stack: failure?.stack ?? null };
        needsReset = true;
        try { await capture(name, failure, started); } catch { /* Evidence must not mask the block failure. */ }
      }
      const result = { name, status: error ? 'failed' : 'passed', ms: Date.now() - started, error };
      results.push(result); known.set(name, result);
    },
    async finish(shutdown) {
      const failures = results.filter(result => result.status !== 'passed').map(result =>
        Object.assign(new Error(result.error.message), { stack: result.error.stack }));
      const lifecycle = async (name, action) => {
        const started = Date.now();
        try { await action(); }
        catch (failure) {
          failures.push(failure);
          results.push({ name, status: 'fatal', ms: Date.now() - started,
            error: { message: String(failure?.message ?? failure), stack: failure?.stack ?? null } });
        }
      };
      try {
        if (needsReset) await lifecycle('acceptance-ui-reset', async () => { await reset(); needsReset = false; });
        await lifecycle('shutdown', shutdown);
      } finally {
        await writeFile(join(evidence, 'block-results.json'), JSON.stringify(results, null, 2));
      }
      const summary = blockFailureSummary(results);
      if (summary) throw new AggregateError(failures, `Native acceptance blocks failed:\n${summary}`);
    },
  };
}
