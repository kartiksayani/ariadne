import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo, unzipHandoff } from './source.mts';

/** Unzips the handoff into coverage/design/source/ once, before any worker serves it. */
export default function setup(): void {
  rmSync(resolve(repo, 'coverage/design/frames'), { recursive: true, force: true });
  mkdirSync(resolve(repo, 'coverage/design/frames'), { recursive: true });
  unzipHandoff();
}
