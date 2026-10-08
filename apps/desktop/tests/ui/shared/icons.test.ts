import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

describe('bundled icons', () => {
  const css = readFileSync(join(desktop, 'public/icons/phosphor.css'), 'utf8');
  const bundled = new Set([...css.matchAll(/\.(ph|ph-fill)\.(ph-[a-z0-9-]+)::before\s*\{\s*content:\s*"\\[0-9a-f]+";/g)].map(match => `${match[1]} ${match[2]}`));
  const used = new Map<string, string>();
  for (const file of sources(join(desktop, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\b(ph-fill|ph) (ph-[a-z0-9-]+)/g)) used.set(`${match[1]} ${match[2]}`, file);
  }

  it('finds the icons the app draws', () => {
    expect(used.size).toBeGreaterThan(40);
    expect(used.has('ph ph-pause')).toBe(true);
    expect(used.has('ph-fill ph-star')).toBe(true);
  });

  it('draws every icon the app uses: each ph-* class has a glyph in the bundled phosphor.css', () => {
    const missing = [...used.keys()].filter(key => !bundled.has(key));
    expect(missing).toEqual([]);
  });

  it('bundles the icons the app lacked before', () => {
    for (const name of ['pause', 'pause-circle', 'play', 'pencil-simple', 'plugs', 'plugs-connected', 'tree-structure', 'info', 'link']) {
      expect(bundled.has(`ph ph-${name}`)).toBe(true);
    }
  });
});
