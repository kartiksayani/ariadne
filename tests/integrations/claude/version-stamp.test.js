import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One version is stamped in every place that carries it. The app, its helper, the plugin manifest and the descriptor
// the installer renders must agree exactly, or Ariadne refuses the plugin ("doesn't match"); the lockfiles must agree
// too, or `--locked` builds and `npm ci` fail on the release runner.
const read = path => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
const json = path => JSON.parse(read(path));

describe('the per-alpha version stamp', () => {
  const version = /^version = "([^"]+)"$/m.exec(/\[workspace\.package\][^[]*/.exec(read('Cargo.toml'))[0])[1];

  it('is an alpha version of the form 0.1.0-alpha.N', () => {
    expect(version).toMatch(/^0\.1\.0-alpha\.\d+$/);
  });
  it('is the same in the app config, the desktop package and the plugin manifest', () => {
    expect(json('apps/desktop/src-tauri/tauri.conf.json').version).toBe(version);
    expect(json('apps/desktop/package.json').version).toBe(version);
    expect(json('integrations/claude/plugin/.claude-plugin/plugin.json').version).toBe(version);
  });
  it('is the same in both lockfiles', () => {
    expect(json('package-lock.json').packages['apps/desktop'].version).toBe(version);
    const lock = read('Cargo.lock');
    const ours = [...lock.matchAll(/\[\[package\]\]\nname = "(ariadne-[^"]+)"\nversion = "([^"]+)"/g)];
    expect(ours.length).toBeGreaterThanOrEqual(11);
    expect(ours.filter(([, , stamped]) => stamped !== version).map(([, name]) => name)).toEqual([]);
  });
});
