# Build handoff

Product implementation remains paused until the owner resumes it. The curated
repository is public; preserve existing history, drafts, worktrees and evidence.
Read [PERSONAL_RELEASE](PERSONAL_RELEASE.md), [ROADMAP](ROADMAP.md), applicable
[low-level contracts](LOW_LEVEL_DESIGN.md) and current [ADRs](../adr/README.md).
The pinned scaffold and native smoke are already implemented (P0.1 #11, P0.2 #14).

## Start here

Fetch current main and declare one bounded task's owned paths in an isolated
worktree. Read exact acceptance/spec sections. One implementer works until the
walking slice; an independent reviewer joins when ready. Important architecture
gaps go to the maintainer before dependent work. Routine ownership/spec updates
can ship alongside product code. Use the short workflow in ORCHESTRATOR.

## Thin first slice

Before completing all foundations, build one explicitly bound/manual Claude
session flow using bounded portions of existing domain/store/core/CLI/runtime
and Waiting UI tasks:

1. An agent CLI publishes an item into durable JSON.
2. The real Waiting UI displays it and the owner saves an answer to the queue.
3. The real core/dispatcher crosses a fake-only provider boundary.
4. The agent CLI explicitly commits a reply/result and the UI updates.

Use the real CLI, atomic JSON store, file lock, core and UI. Retain binding
identity/generation, operation deduplication and separate explicit domain result
and matching host-completion semantics; turn completion alone never means a
domain result. Do not substitute an append-only canonical store or PID routing.
Tests fake only the provider and prove persistence, isolation and ordinary failure.

After this automated slice, an early paid/live run in the owner's already-open
Claude session requires explicit owner approval. Pin and record the actual Claude
version used. Do not launch a host or run a live call now. Final five-input Claude
and Codex acceptance remains M7; early transport proof cannot replace it.

Keep the existing ten product packages. Add no package until real code needs it.
Defer full schema-generator and DTO edge-case work until the slice needs it;
preserve paused P0.3a/P0.4a drafts. Assets resume with fonts/licenses and a short
source table. Full Codex, MCP, discovery/liveness, graph, Continue and native
features remain release scope after the first slice, not deleted features.
This sequencing does not mark partial catalogue tasks complete.

## Decisions already made

- Claude Mods submit into an existing original conversation; Codex uses its native
  queue and read-only history on an explicit existing thread. Bounded POCs used
  Claude 2.1.287 and Codex 0.160.0; they are not product acceptance.
- Provider-neutral core/store owns domain behavior; desktop, CLI and MCP stay thin.
  Agents explicitly publish replies/statuses/topics/children/results. Host text
  never creates an automatic domain reply. No transcript scraping.
- Keep one-in-flight FIFO per binding, correct binding/generation, locked atomic
  saves and operation deduplication. Missing result/uncertain delivery remains
  visible and pauses that binding; no automatic resend.
- App quit starts no new delivery and never stops the external host. CLI/MCP may
  still write domain data. Binding queues remain independent.
- Waiting counts track the current unanswered episode. Owner intents do not
  directly mutate agent statuses; messages may target terminal items.
- Keep full conversation/round/provenance history, guarded close/archive,
  Continue preview into another bound session and manual binding fallback.
  Known-provider discovery/liveness and final native/install behaviors remain.
- Handle invalid/stale input, connection loss, save failures and normal quit/reopen.
  Do not deepen exotic recovery or plugin frameworks before the first release.
- MCP/the review tool remain disabled under the current-session waiver. Organization guidance
  was not checked; no organization approval is claimed.

## Per-commit quality policy

The installed hook runs cheap changed-language format/lint/type checks. CI uses
the small map in [Development checks](DEVELOPMENT_CHECKS.md): relevant tests,
>=80% weighted application coverage including untested logic and real native
WebView smoke for application changes, release isolation for sensitive changes
and full/manual milestones. This gate recalibration itself receives full checks.
Do not fake passes or add machine receipts. Independent review stays at exact head.

## Mechanical bootstrap recipe (implementation session)

The scaffold already pins Rust 1.98.1, Node 22.23.2, npm 10.9.8 and Tauri 2.12.1;
use lockfiles and the [platform ledger](evidence/platform-ledger.md). Do not
regenerate a template over this nonempty repository or upgrade unrelated dependencies.
Use the installed native tools documented in [Mac setup](../development/MACOS_TEST_SETUP.md).
Deployment target remains macOS 13.0 on the owner's arm64 reference Mac.

`npm run dev` starts Tauri dev; `npm run check` checks frontend lint/types;
`cargo test --workspace` exercises Rust; `npm run test:native` runs embedded
WebView smoke; `npm run test:e2e` also checks packaged release isolation.
Test services never ship in the release bundle.

## What counts as complete

Final personal release requires durable domain history/store, both adapters,
explicit results/joins and ordinary recovery, supplied UI/native/install behavior,
discovery/manual fallback and five-message live acceptance on both hosts.
Use [Verification](low-level/VERIFICATION.md) to distinguish mock, POC, native and
live proof. Missing access/environment is a concrete blocker, never a passing skip.
The final handoff includes an installable build, version/platform ledger, actual
acceptance evidence, limitations and source commits.
