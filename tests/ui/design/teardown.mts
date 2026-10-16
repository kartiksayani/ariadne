import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo } from './source.mts';

/** Gathers each frame's result into one report: coverage/design/report.json (handoff frames) and coverage/design/final/report.json (final-board frames). */
function gather(directory: string, report: string): void {
  const frames = Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map(name => [name.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(directory, name), 'utf8'))]));
  if (Object.keys(frames).length) writeFileSync(report, `${JSON.stringify({ frames }, null, 2)}\n`);
}

export default function teardown(): void {
  gather(resolve(repo, 'coverage/design/frames'), resolve(repo, 'coverage/design/report.json'));
  gather(resolve(repo, 'coverage/design/final/frames'), resolve(repo, 'coverage/design/final/report.json'));
}
