# Licensed assets and the Paperwhite design source

The design source is the v2 handoff `designs/Ariadne-UI-mockups-v2.zip`
(15 members). [assets.json](assets.json) pins its SHA-256 and size, every
bundled binary's SHA-256 and size, provider URLs and licences, the four
JetBrains Mono faces and all 62 Phosphor weight/glyph mappings the handoff uses.
The v1 Nocturne archive, its frame map (`source.json`) and its assembled gallery
(`gallery.json`) are retired; P8.3 replaces them.

## Tokens

`apps/desktop/public/styles/design-tokens.css` holds:

| Block | Source |
|---|---|
| `:root, [data-theme="dark"]` | `:root` of `_ds/paperwhite/styles.css`, verbatim, then `THEMES.dark` of `Ariadne.dc.html` |
| `[data-theme="light"]` | `THEMES.light` of `Ariadne.dc.html`, verbatim |

Values keep the handoff's notation so they compare byte for byte. The dark roles
add `--a-lift` and `--a-danger`. `apps/desktop/public/styles/paperwhite.css`
ports the component classes of `_ds/paperwhite/styles.css` (`.btn*`, `.input`,
`.elev-*`, `.tag*`, `.dialog*`) with the same values, plus the keycap/label helpers
that `Ariadne.dc.html` repeats inline.

## Fonts and icons

| Asset | Source | Licence |
|---|---|---|
| JetBrains Mono 400/500, latin and latin-ext | `@fontsource/jetbrains-mono@5.3.0` tarball, `files/*.woff2` unmodified | SIL OFL 1.1, `licenses/JetBrainsMono-OFL.txt` |
| Phosphor regular and fill | `@phosphor-icons/web@2.1.1` | MIT, `licenses/Phosphor-MIT.txt` |

`public/fonts/jetbrains-mono.css` declares the four faces with `font-display: swap`.
`--font-body` and `--font-heading` are `"JetBrains Mono", ui-monospace, Menlo, monospace`.
The handoff also requests weight 600 from Google Fonts; the app bundles 400/500 only,
and the design harness serves the same bundle to both sides.
The Ariadne mark is the regular `ph ph-spiral`, U+E9FA.
Bundled CSS uses local URLs only. No prototype scripts or remote imports ship.

## Checks

`npm run test:ui -- --project reference` verifies the archive digest, that the
token file contains the Paperwhite `:root` and both THEMES role sets, the
bundled hashes, faces and licences, the glyph set against the archive, and that
Vite serves every resource unchanged.
`npm run test:design` (`tests/ui/design/`) renders each board frame from the
archive and the app from `fixtures.ts`, and compares them pixel by pixel.

## P0.4b reusable presentation components

`apps/desktop/src/components/reference/` ports StatusBadge (seven source statuses,
pill/text/icon), TreeRow (nesting, focus, selection, search/context/touched,
collapsed summary, Later/Explained, replacement, delivery and inline editor),
AnswerControl (full/compact options, recommendation, selection, optional text,
warning/blocked/saving/error/delivery labels), and MessageExcerpt (rail/timeline,
owner/agent, created/updated/origin, hover/highlight). Props are controlled
presentation inputs; product routes, service contracts and application workflows
remain unchanged. Message-follow/latest controls belong to the consuming rail.

Release semantics qualify the prototype: recommendations never select an answer;
number keys select without sending; a selected option and optional text, or text
alone, form one submission. Escape retains the parent-owned draft. A Replaced
row filters reopening while allowing Follow up. Answer delivery labels remain
separate from item status. The text hint describes combined submission accurately;
it does not retain the prototype's “reply instead of option” behavior.
Plain Enter activates the focused button, selecting an option or activating its
explicit Send control. Only Cmd+Enter in the focused valid text input submits via
the editor shortcut; container/other-control key events do not send a prior choice.

The packaged release gate checks the fresh module graph and emitted file names
for fixture mounts, archived prototypes and harness dependencies
(`tests/ui/reference/`, `tests/ui/design/`, both archives). Its focused regression
proves those fail while reusable production component imports and bundled
fonts/tokens remain allowed.
