import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import assets from '../../../docs/planning/evidence/design-assets/assets.json';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(resolve(repo, path));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// The standard ZIP reader inspects the immutable handoff, never application input.
const members = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps({name: archive.read(name).decode('utf-8') for name in archive.namelist() if not name.endswith('/')}))
`, resolve(repo, assets.design.path)], { encoding: 'utf8' })) as Record<string, string>;
const tokens = read('apps/desktop/public/styles/design-tokens.css').toString();
const [darkBlock, lightBlock] = tokens.split('[data-theme="light"]');
const theme = (name: 'dark' | 'light') => {
  const block = members[assets.design.themes_member].split('const THEMES = {')[1].split(`${name}: {`)[1].split('}')[0];
  return [...block.matchAll(/'(--[\w-]+)': '([^']+)'/g)].map(match => [match[1], match[2]] as const);
};

describe('Paperwhite design source and offline assets', () => {
  it('verifies the v2 handoff archive', () => {
    expect(digest(read(assets.design.path))).toBe(assets.design.sha256);
    expect(read(assets.design.path).length).toBe(assets.design.bytes);
    expect(Object.keys(members)).toHaveLength(assets.design.members);
  });

  it('ports the Paperwhite :root verbatim and both THEMES role sets', () => {
    const root = members[assets.design.tokens_member].split(':root {\n')[1].split('\n}\n')[0];
    expect(darkBlock).toContain(`:root,\n[data-theme="dark"] {\n${root}\n`);
    const dark = theme('dark'), light = theme('light');
    expect(dark.map(([name]) => name)).toEqual(expect.arrayContaining(['--a-danger', '--a-lift', '--st-done']));
    for (const [name, value] of dark) expect(darkBlock).toContain(`  ${name}: ${value};\n`);
    for (const [name, value] of light) expect(lightBlock).toContain(`  ${name}: ${value};\n`);
    expect(darkBlock).toContain('color-scheme: dark;');
    expect(lightBlock).toContain('color-scheme: light;');
    expect([...lightBlock.matchAll(/--[\w-]+:/g)]).toHaveLength(light.length);
  });

  it('pins all bundled bytes, JetBrains Mono faces and license notices', () => {
    const publicPath = 'apps/desktop/public/';
    const files = ['fonts', 'icons', 'licenses', 'styles'].flatMap(folder => readdirSync(resolve(repo, publicPath, folder)).map(file => `${publicPath}${folder}/${file}`));
    expect(files.sort()).toEqual(assets.files.map(file => file.path).sort());
    for (const file of assets.files) {
      if (file.path.endsWith('.css')) continue;
      expect(read(file.path).length).toBe(file.bytes);
      expect(digest(read(file.path))).toBe(file.sha256);
      if (file.path.endsWith('.woff2')) {
        expect(read(file.path).subarray(0, 4).toString()).toBe('wOF2');
        expect(read(`${publicPath}licenses/${file.license}`)).toBeDefined();
      }
    }
    expect(read(`${publicPath}licenses/JetBrainsMono-OFL.txt`).toString()).toContain('The JetBrains Mono Project Authors');
    expect(read(`${publicPath}licenses/JetBrainsMono-OFL.txt`).toString()).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(read(`${publicPath}licenses/Phosphor-MIT.txt`).toString()).toContain('Copyright (c) 2020-2021 Phosphor Icons');
    const fonts = read(`${publicPath}fonts/jetbrains-mono.css`).toString();
    const blocks = [...fonts.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
    expect(blocks).toHaveLength(assets.jetbrains_faces.length);
    expect(new Set(assets.jetbrains_faces.map(face => face.weight))).toEqual(new Set(assets.sources.jetbrains_mono.weights));
    for (const face of assets.jetbrains_faces) {
      expect(blocks.some(block => block.includes('font-family: "JetBrains Mono";') && block.includes(`font-weight: ${face.weight};`)
        && block.includes('font-display: swap;') && block.includes(`./${face.file}`))).toBe(true);
    }
    for (const token of ['--font-body', '--font-heading']) expect(darkBlock).toContain(`${token}: "JetBrains Mono", ui-monospace, Menlo, monospace;`);
  });

  it('maps every Phosphor glyph the handoff uses, including the regular spiral', () => {
    const css = read('apps/desktop/public/icons/phosphor.css').toString();
    const mappings = [...css.matchAll(/\.(ph|ph-fill)\.(ph-[\w-]+)::before\s*\{\s*content:\s*"\\([\da-f]+)";/g)];
    // The handoff's glyphs, then the few the app uses beyond it (listed as app_glyphs).
    expect(mappings).toHaveLength(assets.glyphs.length + assets.app_glyphs.length);
    for (const glyph of assets.app_glyphs) {
      expect(mappings.some(match => match[1] === 'ph' && match[2] === glyph.class && match[3].toUpperCase() === glyph.unicode.slice(2))).toBe(true);
    }
    const sourceText = Object.values(members).join('\n');
    const used = new Set([...sourceText.matchAll(/\b(ph-fill|ph) (ph-[a-z-]+)/g)].map(match => `${match[1]} ${match[2]}`));
    expect(new Set(assets.glyphs.map(glyph => `${glyph.weight === 'fill' ? 'ph-fill' : 'ph'} ${glyph.class}`))).toEqual(used);
    for (const glyph of assets.glyphs) {
      const weight = glyph.weight === 'fill' ? 'ph-fill' : 'ph';
      expect(mappings.some(match => match[1] === weight && match[2] === glyph.class && match[3].toUpperCase() === glyph.unicode.slice(2))).toBe(true);
    }
    expect(assets.glyphs.find(glyph => glyph.class === 'ph-spiral' && glyph.weight === 'regular')?.unicode).toBe('U+E9FA');
    for (const file of assets.files.filter(file => file.path.endsWith('.css'))) {
      const text = read(file.path).toString();
      expect(text).not.toMatch(/@import|https?:|data:/);
      for (const match of text.matchAll(/url\("?([^)"]+)"?\)/g)) expect(match[1]).toMatch(/^\.\/[\w.-]+\.woff2$/);
    }
  });

  it('serves each local resource through Vite unchanged', async () => {
    const vite = await createViteServer({ configFile: false, root: resolve(repo, 'apps/desktop'), logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
    const server = createServer(vite.middlewares);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing local server address');
      for (const file of assets.files) {
        const response = await fetch(`http://127.0.0.1:${address.port}/${file.path.replace('apps/desktop/public/', '')}`);
        expect(response.status).toBe(200);
        expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(read(file.path)));
      }
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally { await vite.close(); }
    }
  });
});
