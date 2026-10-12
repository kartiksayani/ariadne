import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const blockFailureSummary = results => results.filter(result => result.status !== 'passed')
  .map(result => `${result.name}: ${result.status}: ${result.error.message.split('\n')[0]}`).join('\n');

// This file is published only after the fatal phase/shutdown steps succeed.
// Deadlines, interruption and unrelated WDIO failures still abort the journey.
export async function completedBlockResults(evidence, failure) {
  if (failure && (failure.exitCode !== 1 || failure.expired)) throw failure;
  let results;
  try { results = JSON.parse(await readFile(join(evidence, 'block-results.json'), 'utf8')); }
  catch (error) { throw failure ?? error; }
  if (failure && !results.some(result => result.status !== 'passed')) throw failure;
  return results;
}

// Only acceptance actions are caught. Foundations run directly, and finish runs
// the fatal shutdown proof before publishing a completed phase's results.
export function acceptanceBlocks({ evidence, reset, capture, priorResults = [] }) {
  const results = [], known = new Map(priorResults.map(result => [result.name, result]));
  let needsReset = false;
  return {
    results,
    async run(name, action, dependencies = []) {
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
      await shutdown();
      await writeFile(join(evidence, 'block-results.json'), JSON.stringify(results, null, 2));
      const summary = blockFailureSummary(results);
      if (summary) throw new Error(`Native acceptance blocks failed:\n${summary}`);
    },
  };
}
