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

## P0.4 assembled controlled gallery

[gallery.json](gallery.json) links all 30 unchanged source frames to actual
rendered case IDs, reusable families and named CI evidence attachments. The 27
application references use `gallery.html?frame=<id>&theme=dark|light`; 1j/1k
remain component-sheet mappings to the original 54 cases and 1s remains an
implementer-diagram mapping to status/round history. None becomes a product route.
The fixture JSON contains typed presentation values projected from the original
`Ariadne.dc.html` constructor/`renderVals`, with exact board props and no mounted
source logic, timers or agent behavior. Repeated top-level values share JSON
fragments. Its digest is pinned in the gallery map; the ZIP/prompt/source inventory
remain unchanged.

Reusable additions include BackAndForthRound (ask, option/free-text reply, result,
message range and forks), explicit-coordinate graph nodes/parent/replacement
edges, ProjectCard/SessionCard, GlobalWaitingPanel/Sent, ArchiveCard,
ContinueTopic/GuardDialog and ReferenceWorkspace. The shell composes the existing
rows/answers/message excerpts with independently scrollable panels, the 48/38/30px
chrome and 300/560/400/240px panel contract. Detail and rail close explicitly.
Owner intents, eligibility/count projections, graph layout/viewport behavior,
services, routing and persisted product workflows remain later modules.

Canonical release geometry wins over the prototype: Waiting stays outside the
horizontally scrolling center/detail/rail at 1000x700. Every assembled capture
checks those dimensions and scrolls the center region to prove Waiting remains
pinned. Graph fixtures supply the original explicit coordinates only; the source
84px leaf and 208/216px depth algorithm is not copied. P5.1 implements the
prescribed 94px leaf/254px depth layout. Extra source states record exact `expand`
and `query` props for replacement edges and filtered contextual nodes.

The existing source renderer/interception and pinned Chromium capture machinery
also renders assembled references in all four size/theme projects. Each claimed
comparison retains independently rendered source **and** application region PNGs,
geometry/browser/props provenance, real diffs on mismatch, and full unmasked
source/application viewport PNGs. Each matching occurrence is compared, including
all rounds/cards/graphs, rather than only the first occurrence. Whole-frame parity
is not claimed. `assembled-regions.ts` names precise crop selectors and excluded
text/behavior; the unchanged 1px geometry/0.5% pixel/0.2 raster tolerances remain.
No new masks hide discrepancies.

Continue compares its unchanged grouped summary. The original lead claims item
references stay the same and items join the shared topic; the release lead names
source/target and new local IDs with immutable provenance for topics, items,
messages, rounds and answers, leaving source unchanged. Both exact strings and
send labels are recorded in the region map, outside that crop. The footer uses
Cmd+Enter send and Enter details; recommendations remain unselected. These release
semantics are independently tested rather than hidden by image masks.

Guarded archive, dispatch pause/confirmed close and target-write failure have no
supplied matching frame. Their source-style controlled dialogs get honest
application-only captures, geometry checks and interaction/focus proof. Ask-only
round and paused-follow/latest are component states with the same qualification.
Frame 1ad's source reroute dialog shades its entire workspace; both unmasked whole
images are retained, with no falsely matching crop. Its release fixture preserves
the disconnected existing session and exposes no cross-agent reroute prompt.
These qualifications apply existing DESIGN/UI contracts and change no architecture.

The focused renderer tests verify ordered three-round/two-fork history, explicit
graph geometry and keyboard reveal, older/generic Sent rows alongside a new ask,
unbound/incomplete cards, blockers/confirmed pause, explicit Continue/error copy,
dialog focus trap/return, closeable panels and all actual frame mounts. CI retains
the existing measured application coverage, native WebView and release-isolation
gates. Local work runs cheap renderer/type/lint/hook checks only; capture/native/
build/coverage results must come from the pushed-head CI artifacts.

Reconnect frame `1o` forwards the matching Waiting answer’s blocked state into
the detail editor. `frame:1o/reconnect-choice` explicitly retains the prior
nonrecommended “No, keep both” choice, and `frame:1o/reconnect-draft` retains a
nonempty text draft. These are controlled application states with no supplied
matching frame, captured independently without claiming source parity. Actual
user interactions verify option Send, text Send and Cmd+Enter cannot submit
during reconnect; the choice and draft remain visible. This proves presentation
blocking and retention, with backend persistence outside this gallery’s scope.

Whole-component comparison uses a shared integer raster origin because equivalent
regions can inherit different fractional document positions from the canonical
release composition and prototype. Original unmasked whole-frame **and region**
source/app PNGs remain attached. Separately labelled `normalized-source` and
`normalized-app` PNGs compare the existing DOM region at `(0,0)`, preserving
measured width/height, content and inherited fonts/styles without reparenting or
cloning. Provenance records original/normalized boxes and temporary style changes;
assertions check unchanged dimensions and reliable style restoration. Transparent
regions preserve their own independently resolved solid ancestor backdrop.
The current round’s own 7% accent layer stays unchanged over a temporary inert
backing with its actual solid ancestor color, recorded and removed in `finally`.
Gradients/images, partially transparent ancestor layers or opacity fail with a
diagnostic instead of being flattened. Masks and thresholds remain unchanged.
These whole-component images do not prove that the original viewport shows every
pixel; original images retain clipping, and release shell/pinned/overflow checks
run on the unmodified DOM. This addresses CI-observed fractional raster differences
and graph canvases taller than the small viewport’s available body region.
