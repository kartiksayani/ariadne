// Node-side access to the immutable final-board archive (designs/Ariadne-final-board.zip): the Claude Design
// board that release 1 and later are built against. Everything in the archive is untrusted data. It is only
// unzipped (the standard ZIP reader, never an interpreter run from inside it) and served to a browser page that
// renders it; nothing in it runs in Node.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { repo } from './source.mts';

export const finalArchive = resolve(repo, 'designs/Ariadne-final-board.zip');
export const finalPrefix = 'ariadne-final-board/';
/** Where the archive is unzipped for serving: coverage/design/final-source/. */
export const finalRoot = resolve(repo, 'coverage/design/final-source');
export const finalServed = resolve(finalRoot, finalPrefix);
/** The page the loader renders one board state in. It is harness code, written next to the unzipped board, not part of the archive. */
export const hostName = 'Frame Host.dc.html';

/**
 * The host page: the board's own `only` mechanism (the one its check page uses) renders exactly one state, in
 * one theme and size, at its natural scale. The state comes from the query: ?part=Window&sid=b-wait&th=light&vi=0
 * (vi 0 = 1280 x 800, 1 = 900 x 650). The board's id is on the frame it draws: [data-theme].
 */
export const hostPage = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="ariadne-ds/styles.css">
  <style>html, body { margin: 0; background: oklch(0.9 0.006 80); overflow: hidden; } *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }</style>
</helmet>
<div style="width: max-content;"><dc-import name="Ariadne Final Board" embed="{{ true }}" only="{{ only }}" hint-size="900px,650px"></dc-import></div>
</x-dc>
<script type="text/x-dc" data-dc-script>
class Component extends DCLogic {
  state = (() => {
    const q = new URLSearchParams(location.search);
    return { only: { part: q.get('part') || 'Window', sid: q.get('sid') || 'b-wait', th: q.get('th') === 'dark' ? 'dark' : 'light', vi: q.get('vi') === '1' ? 1 : 0 } };
  })();
  renderVals() { return { only: this.state.only }; }
}
</script>
</body>
</html>
`;

/** Text members of the archive, keyed without the ariadne-final-board/ prefix. */
export function finalMembers(): Record<string, string> {
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({name.removeprefix(sys.argv[2]): archive.read(name).decode('utf-8') for name in archive.namelist() if not name.endswith('/')}))
`, finalArchive, finalPrefix], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as Record<string, string>;
}

/** Unzips the archive into coverage/design/final-source/, replacing any earlier copy, and writes the host page beside the board. */
export function unzipFinal(): void {
  execFileSync('python3', ['-I', '-c', `
import shutil, sys, zipfile
shutil.rmtree(sys.argv[2], ignore_errors=True)
with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
`, finalArchive, finalRoot]);
  mkdirSync(finalServed, { recursive: true });
  writeFileSync(resolve(finalServed, hostName), hostPage);
}

// The archive carries the dc runtime (support.js) but not what it loads: React, ReactDOM and Babel come from a CDN
// with SRI hashes, and the board's fonts (Phosphor, JetBrains Mono) are named in ariadne-ds/fonts/fonts.css without
// their files. The runtime is served offline from the same pinned packages as the v2 harness (hash-checked against
// support.js) and the fonts from the app's own public/ copies, which are the same families.
const requireRuntime = createRequire(resolve(repo, 'tests/ui/design/runtime/package.json'));
const runtimeFile = (name: string, file: string) => readFileSync(resolve(dirname(requireRuntime.resolve(`${name}/package.json`)), file));
export const runtime: Record<string, Buffer> = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': runtimeFile('react', 'umd/react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': runtimeFile('react-dom', 'umd/react-dom.production.min.js'),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': runtimeFile('@babel/standalone', 'babel.min.js'),
};
const publicDir = resolve(repo, 'apps/desktop/public');
/**
 * The six font files ariadne-ds/fonts/fonts.css names, and where the app keeps them: the only names the route serves, each
 * with the SHA-384 of its bytes (pinned like the runtime scripts above). A request names a file by its base name alone.
 */
export const fontPins: Readonly<Record<string, { readonly folder: string; readonly sha384: string }>> = {
  'jetbrains-mono-latin-400-normal.woff2': { folder: 'fonts', sha384: 'sha384-/4dCc3INKaFZBsZMku6bd44i8Gr1uXW1GYvdcNjsbHXHh2nGnk9G4RAhHf8hx3GT' },
  'jetbrains-mono-latin-500-normal.woff2': { folder: 'fonts', sha384: 'sha384-3iyOQaeJXnQxIW20oqgpGwfOVKUBAjMsLqvIIwa7iIJ+b/4hcIy0H8MDF8CKlE2b' },
  'jetbrains-mono-latin-ext-400-normal.woff2': { folder: 'fonts', sha384: 'sha384-E1WjAekX0jixTGufYdFaoed7qOtaE1fF43ZvIs2C2D1IGhT8T2cjgEQ2Dd+1IjdS' },
  'jetbrains-mono-latin-ext-500-normal.woff2': { folder: 'fonts', sha384: 'sha384-2eXrjTEbp46k5ZofMwh/Ha5g9R5He1spdzkNjlg+aLo//cSNdlRDy6PORrrNhb/7' },
  'Phosphor-Fill.woff2': { folder: 'icons', sha384: 'sha384-2OXNCWFbm32rM41wUHyURyGC/RgegH0wT0OvZNqWWDxiKhwkm+PiUkn8ejkf2nCJ' },
  'Phosphor.woff2': { folder: 'icons', sha384: 'sha384-m+KpvLpX1Z9u15CUi7ufA3tQoODb7pNrYUWh5CDi1bej2N/yEq9p/GApOosSDfPQ' }
};
const sha384 = (bytes: Buffer) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

/**
 * The bytes of a pinned font, or undefined for any name that is not one of them. Only the base names of `fontPins` are
 * accepted (no `/`, no `..`), the resolved path must stay inside the app's font folder, and the bytes must match their pin.
 */
export function fontFile(name: string): Buffer | undefined {
  const pin = Object.prototype.hasOwnProperty.call(fontPins, name) && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..') ? fontPins[name] : undefined;
  if (!pin) return undefined;
  const folder = resolve(publicDir, pin.folder), file = resolve(folder, name);
  if (!file.startsWith(folder + sep) || !existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (sha384(bytes) !== pin.sha384) throw new Error(`font ${name} does not match its pinned hash: the app's copy changed`);
  return bytes;
}
const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.md': 'text/markdown' };

/** The runtime's hashes in the archive's support.js, against the bytes served: a mismatch means the runtime moved on. */
export function runtimeHashes(support: string): { url: string; expected: string | undefined; actual: string }[] {
  return Object.entries(runtime).map(([url, bytes]) => {
    const name = url.includes('react-dom') ? 'REACT_DOM' : url.includes('babel') ? 'BABEL' : 'REACT';
    return { url, expected: support.match(new RegExp(`var ${name}_SRI = "([^"]+)"`))?.[1], actual: sha384(bytes) };
  });
}

/**
 * Serves the unzipped board at /final/ (and the fonts it names) offline; every other origin is blocked and
 * recorded in `denied`. `/final/<file>` is looked up under coverage/design/final-source/ariadne-final-board/.
 */
export async function routeFinal(context: BrowserContext, origin: string, denied: string[]): Promise<void> {
  await context.route('**/*', async request => {
    const url = request.request().url();
    if (runtime[url]) return request.fulfill({ body: runtime[url], contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } });
    const parsed = new URL(url);
    if (parsed.origin !== origin) { denied.push(url); return request.abort('blockedbyclient'); }
    if (!parsed.pathname.startsWith('/final/')) return request.continue();
    const path = decodeURIComponent(parsed.pathname.slice('/final/'.length));
    const file = resolve(finalServed, path);
    if (file.startsWith(finalServed + sep) && existsSync(file)) return request.fulfill({ body: readFileSync(file), contentType: contentTypes[extname(file)] ?? 'application/octet-stream' });
    try {
      const font = path.startsWith('ariadne-ds/fonts/') ? fontFile(path.slice('ariadne-ds/fonts/'.length)) : undefined;
      if (font) return request.fulfill({ body: font, contentType: 'font/woff2' });
    } catch (error) {
      denied.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return request.fulfill({ status: 500, body: '' });
    }
    return request.fulfill({ status: 404, body: '' });
  });
}
