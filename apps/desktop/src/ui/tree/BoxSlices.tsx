// A row's slices of the tinted boxes around it. Absolutely positioned and painted behind the row's content, so a box
// opening or closing at a row never changes its height (tree-rows.css `.tree-box`).
import type { CSSProperties } from 'react';
import type { Box } from './boxes';
import { BRANCH_HUES } from './branch';

/** What a row sets so its slices, strip and thread take its branch's tint: `--depth`, `--branch-h` and `--branch-c`. */
export function branchStyle(branch: number | null, depth: number): CSSProperties {
  const hue = branch === null ? undefined : BRANCH_HUES[branch];
  return { '--depth': depth, ...(hue ? { '--branch-h': hue.hue, '--branch-c': hue.chroma } : {}) } as CSSProperties;
}

export function Boxes({ boxes }: { boxes: readonly Box[] }) {
  return <>{boxes.map(box => <span key={box.k} aria-hidden="true" className="tree-box" data-step={Math.min(box.k, 5)}
    data-first={box.first || undefined} data-last={box.last || undefined} style={{ '--k': box.k, '--outer': box.outer } as CSSProperties} />)}</>;
}
