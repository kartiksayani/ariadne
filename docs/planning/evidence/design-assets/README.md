# Licensed assets and source reference components

[source.json](source.json) maps every one of the 30 immutable board frames to its
source member, board line, exact import props and component families. Its nine
component records preserve the complete variant/state mapping from
[DESIGN_TRACEABILITY](../../DESIGN_TRACEABILITY.md). Sheets 1j/1k and diagram 1s
remain references. Frame 1c does not authorize default answer selection; 1p and
1ad do not authorize guessed binding or cross-agent rerouting.

The original ZIP and DESIGN_PROMPT digests are pinned. The existing
[design manifest](../../assets/design-manifest.json) supplies all sixteen member
digests, sizes and reference roles; this inventory does not duplicate it.
Source tokens record all 51 Nocturne root declarations and the 16 dark/21 light
roles in `Ariadne.dc.html:812–851`. Repeated sheet/diagram declarations remain in
their immutable source members. The source README's **Design tokens** and
**Components** sections retain dimensions, type, focus and outline-button rules:
Inter 400/500; 20/18/15px heading/page/question; 11px medium section labels with
0.07em tracking; 24px tree indentation; 22px status badges; 190×66px graph nodes;
4/6/8/14px keycap/badge/card/dialog radii; 2px accent focus; 45% disabled opacity.

[assets.json](assets.json) pins each bundled file's SHA-256 and size, provider
URLs, licenses, fourteen Inter faces and all 59 used weight/glyph mappings.
The seven unmodified Inter subsets come from the source's Google Fonts request,
v20 WOFF2 with internal version `4.001;git-66647c0bb`, source commit
`66647c0bbbe41a850d79d9c76fb13add3378940f`, under SIL OFL 1.1.
The unversioned, user-agent-sensitive CSS request is qualified by the saved
response digest and explicit v20 font URLs. This is not an assumed Inter v4.1
release. Phosphor comes from official `@phosphor-icons/web@2.1.1` under MIT;
the distribution archive digest and registry integrity are recorded. Its source
treatment uses 55 regular mappings and four fill mappings (57 distinct names).
The Ariadne mark is the regular `ph ph-spiral`, U+E9FA, in the bundled font.
Every status keeps the source shape: regular circle/circle-half/check-circle/
x-circle/arrow-circle-right, filled question for Waiting and filled check-circle
for Done; labels remain required when components are implemented.

Bundled CSS uses local URLs and only Inter 400/500. License copies retain all
copyright/permission text; CRLF/CR becomes LF and trailing ASCII spaces/tabs are
trimmed. Both upstream and bundled digests are recorded. The original downloads,
licenses and probe evidence remain unchanged at
`/private/tmp/ariadne-p04a-assets-em8a3mt3`; its manifest digest is
`74c041c5761898e190585aa5c989c23223cdeaa7c32421366fe2d3d95e0e3259`.
The paused `.worktrees/P0.4a` draft remains untouched.

`/styles/design-tokens.css` ports exact source token values, with standard modern
RGB/OKLCH syntax. It defaults to the source dark palette
and supports explicit `data-theme="dark"`/`"light"` scopes. It is an unloaded
asset for later consumers; theme preference/System handling remains later UI.
Consumers can load `/fonts/inter.css`, `/icons/phosphor.css` and the tokens locally.
No prototype scripts, timers, fixture behavior or remote imports are shipped.

`npm run test:ui -- --project reference` verifies actual archive/member/prompt
bytes, complete mappings, source token values, bundled hashes/licenses, face and
glyph mappings, and every resource through a temporary loopback Vite server.
The root reference tests are included in the desktop TypeScript check. Default
UI/coverage runs still include the desktop scaffold tests. No native build was
needed for asset extraction.
Organization security guidance was not checked under the explicit session waiver.

## P0.4b reusable presentation components

`apps/desktop/src/components/reference/` ports StatusBadge (seven source statuses,
pill/text/icon), TreeRow (nesting, focus, selection, search/context/touched,
collapsed summary, Later/Explained, replacement, delivery and inline editor),
AnswerControl (full/compact options, recommendation, selection, optional text,
warning/blocked/saving/error/delivery labels), and MessageExcerpt (rail/timeline,
owner/agent, created/updated/origin, hover/highlight). Component CSS preserves
source dimensions, font weights, shapes and theme roles. Props are controlled
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

`tests/ui/reference/gallery.html`, `gallery.tsx` and `cases.tsx` mount fixtures only
through the dedicated test server. The native/application entry does not import
them. The private source-runtime workspace locks React/ReactDOM 18.3.1 and Babel
standalone 7.29.0, exactly as immutable `support.js` requests, alongside application
React 19. Their UMD SHA-384 bytes must match the archive's original SRI values.
The runtime and original component/Nocturne files are read from the ZIP unchanged;
exact CDN URLs are intercepted locally, font/icon requests use bundled licensed
bytes, and all other external requests fail the capture. Theme roles come from
the existing member/line source evidence. Nothing falls back to the network.

`npm run capture:reference` compares 54 deterministic component cases at actual
1600×960 and 1000×700 Chromium viewports, each dark/light: 216 source/app region
pairs. The narrower viewport also narrows the fixture region. Geometry may differ
by at most 1px; the pixel comparator allows 0.5% differing pixels with threshold
0.2 for rasterization. Both independently rendered PNGs and source/browser/input/
geometry provenance are attached to the report. Playwright emits real diff PNGs
on mismatches. Each expected PNG is freshly rendered source, never an application
golden. The qualified free-text region compares the actual textarea separately;
the corrected submission hint is verified by product behavior tests.
Two selected-answer cases qualify only the exact shortcut hint text: the full
hint removes “Enter sends”; the compact hint changes it to “Enter activates the
focused button”. Comparison screenshots hide that text alone, retaining its
layout and all controls. Complete unmasked source/app PNGs and before-mask geometry
remain attached, and provenance records the exact original/release strings.
Keyboard tests independently assert the app's Cmd+Enter copy and ordinary button
activation. Browser captures also Tab to the TreeRow and clickable MessageExcerpt
roots and verify actual focus plus their 2px focus-visible outline.

Playwright 1.63.0 pins its Chromium revision. Provision it explicitly with
`PLAYWRIGHT_BROWSERS_PATH="$PWD/target/reference-browser" node node_modules/playwright/cli.js install chromium`
before captures; missing browsers fail. CI uses that task directory, never the
global cache, and uploads `coverage/reference/` with existing quality evidence.
The HTML reporter uses an absolute repository `coverage/reference/report` path,
so its app/source PNG attachments and provenance are included in that upload.
No captures, production/native builds or full coverage runs are performed locally
under the owner's current execution preference.

The packaged release gate checks the fresh module graph and emitted file names
for fixture mounts, archived prototypes and capture dependencies. Its focused
regression proves those fail while reusable production component imports and
bundled fonts/tokens remain allowed. Existing packaged/native checks provide
release evidence in CI; test-only mounts are not application routes.
