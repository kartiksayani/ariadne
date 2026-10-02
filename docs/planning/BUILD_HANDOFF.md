# Build handoff

This document starts the implementation phase. The owner authorized building
the personal release and publication of the curated repository to GitHub.
Preserve the archived planning/POC reference and existing history.
Run live/billable host acceptance only at the explicit M7 milestone.

## Start here

1. Read the latest [decision log](../../DECISIONS.md),
   [low-level design index](LOW_LEVEL_DESIGN.md), and
   [implementation roadmap](ROADMAP.md). The low-level domain, API, queue,
   process, adapter, UI, and setup documents are the implementation authority.
   Read applicable [accepted ADRs](../adr/README.md) and their replacement links.
   Owner requirements remain binding; ADRs and updated canonical contracts must
   agree. Send an architecture gap/conflict to the orchestrator before dependent
   work and commit every resulting decision with its affected implementation.
2. Check `git status --short`. Preserve all existing local edits and untracked
   user data; do not reset or clean the checkout.
3. Start at roadmap **P0.1**. Scaffold the required Tauri 2, Rust, and React +
   TypeScript workspace, lock exact versions that are available in the build
   environment, and write the platform/toolchain ledger. Continue through M0
   to M8 in sequence unless a stated dependency allows independent work.
4. Use [Verification](low-level/VERIFICATION.md) as the acceptance checklist.
   Update evidence status only after saving the corresponding fixture, test
   output, or live proof record.

## Decisions already made

- Release 1 integrates with existing running sessions: Claude Mods and Codex's
  native queue CLI plus read-only daemon history. Their bounded transport
  primitives were live-proven on Claude Code **2.1.287** and Codex **0.160.0**.
  Do not repeat transport architecture research or treat those POCs as product
  acceptance.
- Domain CLI/MCP is where agents explicitly write item replies, statuses,
  topics, children, and per-input results. Host lifecycle text is diagnostic;
  it never creates an automatic reply or tree update.
- The input/result handshake, one-in-flight-per-binding FIFO, day-to-day
  recovery rules, binding identity/generation, multi-writer storage algorithm,
  full item conversation history and bootstrap path are specified. Implement
  these contracts as written. Keep an easy provider-neutral adapter extension
  boundary; public plugin registration and a third executable proof are
  deferred beyond this personal release.
- The desktop app starts delivery while it is alive by servicing Claude Mod claims over
  its private local socket and scheduling Codex/other adapter sends. After app quit it initiates no new delivery; the
  external host session continues. Domain CLI/MCP still reads and mutates data
  while the app is closed. Separate bindings in one project have independent
  queues and can proceed concurrently.
- Reopen and drop controls send typed owner intents as queued inputs. They do
  not write item status or terminal fields; the agent applies a later explicit
  status operation. Owner messages can still target terminal items.
- Waiting counts include only the current unanswered waiting episode. After an
  answer, the item appears in Sent while it remains waiting; a later agent ask
  creates a new episode and can return it to Waiting. Session close requires
  all items terminal, no unresolved inputs, and dispatch paused.
- Managed provider launch, provider permission UI, automatic host transcript
  ingestion, PID-based routing, Channels, and hook-dependent message delivery
  are not release-1 paths. Implement simple read-only discovery/liveness from
  known host metadata where available; report a host limitation when metadata
  is insufficient. Manual binding remains supported and PID alone never
  establishes liveness. Follow PROCESS_AND_PROTOCOLS section 5. If discovery
  appears too complex to implement within that bounded approach, discuss the
  scope before dropping it. Hooks are optional.
- Continue-topic copies provenance into another existing bound session after
  preview; the original remains unchanged. Archive/close require terminal
  items and no outstanding delivery/result. Owner messages may target closed
  items without changing status; agent statuses are explicit domain mutations.
- Organization security guidance was not checked under the owner's explicit
  the review tool waiver. Keep that fact in the evidence/report; do not fetch or claim
  organizational approval.

## Version and environment handling

The product stack is fixed: Tauri 2, Rust, React + TypeScript, and a Rust CLI in
the same workspace. Before scaffolding, inspect the actual repository and Git
status. Run the template generator only in a fresh staging directory outside
the repository; do not run it against this nonempty repo or let it overwrite
existing files. Choose a concrete generator release and package versions before
invocation; never use `@latest`. Integrate scaffold files deliberately into the
existing checkout.

Record exact installed-stable patch versions, generator command/version,
`rustc`/`cargo`/`node`/`npm`/Tauri versions, Cargo/npm resolutions, macOS
version, host Mac architecture, deployment target and packaged test
capabilities in M0's platform ledger. Save the version-command output and exact
lockfiles. Do not leave a “research framework choice” milestone or float
dependencies.

If a required compiler/tool, package download, host version, native permission,
or OS capability is unavailable, record the exact missing prerequisite, the
blocked gate, and the evidence collected so far. Continue independent work only
where the roadmap dependencies allow it. Do not change a settled product or
security contract to hide an environmental blocker.

## Per-commit quality policy

Every code commit must pass all maintained-code lint and test checks, including
functional and E2E checks, and at least 80% overall code coverage.
The repository currently has no production application code, so coverage is
N/A only while no application code exists. The first application code commit,
including scaffold application source, must activate the application gate and
meet the 80% coverage minimum; missing coverage instruments/results fail closed. Keep quality-gate tooling
usable in both planning and application phases. Do not run live/billable host
sessions as per-commit checks; reserve those for M7.

## What counts as complete

The transport POCs are proof of primitives. Completion additionally requires
durable store behavior, domain replies/results, first-party adapter joins and
day-to-day recovery, full mockup/UI behavior, native packaged app checks,
simple setup/install/uninstall, first-pass known-metadata discovery where
supported, and five-message live acceptance on both hosts. Public plugin
registration and a third executable adapter proof are deferred. Use the
evidence labels in the verification ledger; do not call a mock, schema, or POC
result an implemented product feature.

The final handoff includes an installable build, exact version/platform
ledger, passing acceptance evidence or explicit external blockers, README,
known limitations, and source commits. Repository publication is authorized;
keep the reference archive and preserve history.


## Mechanical bootstrap recipe (implementation session)

Run these read-only checks first, recording outputs in the platform ledger:

```sh
rtk proxy rustc --version
rtk proxy cargo --version
rtk proxy node --version
rtk proxy npm --version
rtk proxy xcode-select -p
rtk proxy sw_vers
rtk proxy uname -m
rtk proxy npm view create-tauri-app version
```

Use that last explicit version (not a floating alias) in
`npm exec --package=create-tauri-app@<recorded-version> -- create-tauri-app`.
Generate into a new `/private/tmp/ariadne-scaffold-<uuid>` directory and select
React, TypeScript, npm, bundle identifier `com.ariadne.desktop`. This is the
fixed official template, not a framework evaluation. Copy its frontend into
`apps/desktop`, use `apps/desktop/src-tauri` as the desktop Cargo member and add
core/CLI crates from ARCHITECTURE. Preserve the curated planning files and
archived POC reference; historical POCs need not be restored to main.

Use Vite for the renderer and one root Cargo workspace for the desktop app,
shared libraries, thin CLI and thin MCP binary. Generate the pinned Codex wire
schemas/types using the exact recipe in PROCESS_AND_PROTOCOLS section 6; record
its manifest and make generator drift a build check. Both `ariadne-mcp` and
`ariadne mcp serve` call the same stdio service. Do not put domain decisions in
the Tauri or MCP command handlers.

Set the initial deployment target to macOS13.0, native build architecture
(arm64 on the owner's reference Mac). Record the actual tested OS separately;
Intel/universal distribution is not required for this local release. Pin installed
Rust stable's exact release in rust-toolchain.toml, Node's exact installed supported
LTS release in .node-version, npm in packageManager, and save Cargo.lock and
package-lock.json. Resolve package versions once, then use locked installs.
If the installed Node does not meet the generated template engine range, report
that exact prerequisite; do not silently replace the stack.

Create workspace scripts with these meanings: `npm run dev` runs the desktop
Tauri dev target; `npm run check` runs TS/lint; `npm run test:ui` runs fixture
renderer tests; `cargo test --workspace` runs Rust contracts/store; `npm run
test:native` runs the test-only embedded WDIO build; `make install` builds locked
release app/helper then invokes the simple local installer. Native tests never
run against a release bundle containing test services.

First concrete vertical slice: demo session → tree/detail/waiting rendered from
core → owner input saved → fake adapter submits one explicit reply/result →
result/turn join → item conversation refresh. Then substitute the two proven
host adapters. Avoid building a polished disconnected UI before that slice works.
