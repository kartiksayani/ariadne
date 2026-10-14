import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDesignServer } from './server.mts';
import { repo, unzipHandoff } from './source.mts';

/**
 * Unzips the handoff into coverage/design/source/ once, before any worker serves it, then runs the
 * gallery's cold Vite transform and dependency optimisation once, so both workers start on a warm cache.
 */
export default async function setup(): Promise<void> {
  rmSync(resolve(repo, 'coverage/design/frames'), { recursive: true, force: true });
  mkdirSync(resolve(repo, 'coverage/design/frames'), { recursive: true });
  unzipHandoff();
  const { server } = await startDesignServer();
  await server.close();
}
