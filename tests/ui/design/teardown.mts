import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo } from './source.mts';

/** Gathers each frame's result into coverage/design/report.json. */
export default function teardown(): void {
  const directory = resolve(repo, 'coverage/design/frames');
  const frames = Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map(name => [name.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(directory, name), 'utf8'))]));
  if (Object.keys(frames).length) writeFileSync(resolve(repo, 'coverage/design/report.json'), `${JSON.stringify({ frames }, null, 2)}\n`);
}
