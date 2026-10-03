import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import source from '../../../docs/planning/evidence/design-assets/source.json';
import assets from '../../../docs/planning/evidence/design-assets/assets.json';
import manifest from '../../../docs/planning/assets/design-manifest.json';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(resolve(repo, path));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// The standard ZIP reader inspects the immutable fixture, never application input.
const members = JSON.parse(execFileSync('python3', ['-c', `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    members = {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
    print(json.dumps({name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                            'text': data.decode('utf-8')} for name, data in members.items()}))
`, resolve(repo, source.archive.path)], { encoding: 'utf8' })) as Record<string, { bytes: number; sha256: string; text: string }>;
const rows = (heading: string, next: string) => read('docs/planning/DESIGN_TRACEABILITY.md').toString()
  .split(heading)[1].split(next)[0].split('\n').filter(line => line.startsWith('| '))
  .slice(2).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
const percent = (value: string) => Number((Number(value) * 100).toFixed(4));
const cssValue = (value: string) => value
  .replace(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g,
    (_match, red, green, blue, alpha) => `rgb(${red} ${green} ${blue} / ${percent(alpha)}%)`)
  .replace(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g,
    (_match, lightness, chroma, hue) => `oklch(${percent(lightness)}% ${chroma} ${hue}deg)`);

describe('immutable design source and offline assets', () => {
  it('verifies the ZIP, all sixteen members and unchanged prompt', () => {
    expect(digest(read(source.archive.path))).toBe('f17152968502d592ba604f03fab97dab678265d90f763b8e575bda1dd9445e98');
    expect(digest(read(source.archive.path))).toBe(source.archive.sha256);
    expect(read(source.archive.path).length).toBe(source.archive.bytes);
    expect(digest(read(source.prompt.path))).toBe(source.prompt.sha256);
    expect(source.member_manifest).toBe('docs/planning/assets/design-manifest.json');
    expect(manifest.source_archive.sha256).toBe(source.archive.sha256);
    expect(Object.keys(members).sort()).toEqual(manifest.members.map(member => member.path).sort());
    expect(manifest.members).toHaveLength(16);
    for (const member of manifest.members) {
      expect(members[member.path].sha256).toBe(member.sha256);
      expect(members[member.path].bytes).toBe(member.uncompressed_bytes);
    }
  });

  it('maps every board frame and canonical component variant to the actual source', () => {
    const board = members[source.board_member].text;
    const ids = [...board.matchAll(/class="dv-opt" id="([^"]+)"/g)].map(match => match[1]);
    expect(source.frames).toHaveLength(30);
    expect(source.frames.map(frame => frame.id).sort()).toEqual(ids.sort());
    const families = source.components.map(component => component.family);
    for (const frame of source.frames) {
      const line = board.split('\n')[frame.line - 1];
      expect(line).toContain(`id="${frame.id}"`);
      const attributes = Object.fromEntries([...line.split('<dc-import')[1].split('>')[0]
        .matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
      expect(attributes).toEqual(frame.props);
      expect(frame.member).toBe(`design_handoff_ariadne/${frame.props.name}.dc.html`);
      expect(members[frame.member]).toBeDefined();
      expect(frame.families.length).toBeGreaterThan(0);
      for (const family of frame.families) expect(families).toContain(family);
    }
    const canonical = rows('## Component-state mapping', '## Acceptance checks');
    expect(source.components).toHaveLength(9);
    expect(families).toEqual(canonical.map(row => row[0]));
    expect(new Set(source.frames.flatMap(frame => frame.families))).toEqual(new Set(families));
    for (const component of source.components) {
      expect(members[component.member]).toBeDefined();
      expect([component.family, component.states, component.reference])
        .toEqual(canonical.find(row => row[0] === component.family)?.slice(0, 3));
    }
    expect(source.qualifications['1c']).toContain('no default recommendation');
    expect(source.qualifications['1p']).toContain('explicit owner');
    expect(source.qualifications['1ad']).toContain('never guesses ownership');
  });

  it('ports the complete Nocturne tokens and both actual Ariadne theme roles', () => {
    const css = read('apps/desktop/public/styles/design-tokens.css').toString();
    expect(source.tokens).toHaveLength(88);
    expect([...css.matchAll(/--[\w-]+\s*:/g)]).toHaveLength(88);
    for (const token of source.tokens) {
      const line = members[token.member].text.split('\n')[token.line - 1];
      const value = token.scope === 'base'
        ? line.match(new RegExp(`${token.name}\\s*:\\s*([^;]+);`))?.[1].trim()
        : line.match(new RegExp(`'${token.name}'\\s*:\\s*'([^']+)'`))?.[1];
      expect(value).toBe(token.value);
      const block = token.scope === 'light' ? css.split('[data-theme="light"]')[1] : css.split('[data-theme="light"]')[0];
      expect(block).toContain(`${token.name}: ${cssValue(token.value)};`);
    }
    for (const ramp of ['neutral', 'accent', 'accent-2']) {
      for (let step = 100; step <= 900; step += 100) expect(source.tokens.some(token => token.name === `--color-${ramp}-${step}`)).toBe(true);
    }
  });

  it('pins all bundled bytes, font weights/subsets and license notices', () => {
    const publicPath = 'apps/desktop/public/';
    const files = ['fonts', 'icons', 'licenses', 'styles'].flatMap(folder => readdirSync(resolve(repo, publicPath, folder)).map(file => `${publicPath}${folder}/${file}`));
    expect(files.sort()).toEqual(assets.files.map(file => file.path).sort());
    for (const file of assets.files) {
      expect(read(file.path).length).toBe(file.bytes);
      expect(digest(read(file.path))).toBe(file.sha256);
      if (file.path.endsWith('.woff2')) {
        expect(read(file.path).subarray(0, 4).toString()).toBe('wOF2');
        expect(read(`${publicPath}licenses/${file.license}`)).toBeDefined();
      }
    }
    expect(read(`${publicPath}licenses/Inter-OFL.txt`).toString()).toContain('Copyright 2020 The Inter Project Authors');
    expect(read(`${publicPath}licenses/Inter-OFL.txt`).toString()).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(read(`${publicPath}licenses/Phosphor-MIT.txt`).toString()).toContain('Copyright (c) 2020-2021 Phosphor Icons');
    const fonts = read(`${publicPath}fonts/inter.css`).toString();
    const blocks = [...fonts.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
    expect(blocks).toHaveLength(14);
    expect(new Set(assets.inter_faces.map(face => face.weight))).toEqual(new Set([400, 500]));
    for (const face of assets.inter_faces) expect(blocks.some(block => block.includes(`font-weight: ${face.weight};`) && block.includes(`./${face.file}`) && block.includes(`unicode-range: ${face.unicode_range};`))).toBe(true);
  });

  it('retains all used regular/fill glyph mappings, including the regular spiral', () => {
    const css = read('apps/desktop/public/icons/phosphor.css').toString();
    const mappings = [...css.matchAll(/\.(ph|ph-fill)\.(ph-[\w-]+)::before\s*\{\s*content:\s*"\\([\da-f]+)";/g)];
    expect(mappings).toHaveLength(59);
    expect(assets.glyphs).toHaveLength(59);
    const sourceText = Object.values(members).map(member => member.text).join('\n');
    for (const glyph of assets.glyphs) {
      const weight = glyph.weight === 'fill' ? 'ph-fill' : 'ph';
      expect(sourceText).toContain(`${weight} ${glyph.class}`);
      expect(mappings.some(match => match[1] === weight && match[2] === glyph.class && match[3].toUpperCase() === glyph.unicode.slice(2))).toBe(true);
    }
    expect(assets.glyphs.find(glyph => glyph.class === 'ph-spiral' && glyph.weight === 'regular')?.unicode).toBe('U+E9FA');
    for (const file of assets.files.filter(file => file.path.endsWith('.css'))) {
      const text = read(file.path).toString();
      expect(text).not.toMatch(/@import|https?:|data:/);
      for (const match of text.matchAll(/url\("?([^)"]+)"?\)/g)) expect(match[1]).toMatch(/^\.\/[\w.-]+\.woff2$/);
    }
  });

  it('serves each local resource through Vite with the recorded digest', async () => {
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
        expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(file.sha256);
      }
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally { await vite.close(); }
    }
  });
});
