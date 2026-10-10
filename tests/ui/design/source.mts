// Node-side access to the immutable v2 handoff archive. The standard ZIP reader
// inspects the committed archive only, never application input.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionChrome } from './session-chrome';
import { graphChrome } from './graph-chrome';
import { footerChrome } from './footer-chrome';
import { itemRowChrome, topicRowChrome } from './row-chrome';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const archive = resolve(repo, 'designs/Ariadne-UI-mockups-v2.zip');
export const prefix = 'design_handoff_ariadne/';
/** Where the archive is unzipped for serving: coverage/design/source/. */
export const sourceRoot = resolve(repo, 'coverage/design/source');

/** Text members of the archive, keyed without the design_handoff_ariadne/ prefix. */
export function handoffMembers(): Record<string, string> {
  const members = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({name.removeprefix(sys.argv[2]): archive.read(name).decode('utf-8') for name in archive.namelist() if not name.endswith('/')}))
`, archive, prefix], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as Record<string, string>;
  members['Ariadne.dc.html'] = footerChrome(graphChrome(topicRowChrome(sessionChrome(members['Ariadne.dc.html']!))));
  members['Item Row.dc.html'] = itemRowChrome(members['Item Row.dc.html']!);
  return members;
}

/** Unzips the archive into coverage/design/source/, replacing any earlier copy. */
export function unzipHandoff(): void {
  execFileSync('python3', ['-c', `
import shutil, sys, zipfile
shutil.rmtree(sys.argv[2], ignore_errors=True)
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
`, archive, sourceRoot]);
  const members = handoffMembers();
  for (const name of ['Ariadne.dc.html', 'Item Row.dc.html']) writeFileSync(resolve(sourceRoot, prefix, name), members[name]!);
}
