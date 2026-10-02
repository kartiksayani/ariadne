# Verification and implementation evidence

This is the acceptance ledger for the design. **C01's basic Claude two-turn transport passed a live test on 2 October 2026.** See the [recorded exchange and evidence](../evidence/CLAUDE_STREAM_SMOKE.md). Application tests and the remaining managed-provider/native proofs are pending. Schema inspection alone cannot establish running behavior or subscription billing.

## 1. Evidence already obtained during planning

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| BUILD_PROMPT, DESIGN_PROMPT, supplied ZIP/source/screenshots | Required domain/UI/install behavior and visual baseline | Working app |
| Claude2.1.287 version/help + published SDK0.3.287 declarations | Candidate flags, input/output type shapes and correlation fields | Raw CLI permission bridge and persistent-session behavior on this machine |
| Claude2.1.287 live two-turn subprocess smoke test | Same-process/same-session input, replay/result UUID correlation, streamed text, remembered context, clean EOF exit | MCP tree tools, permissions, durable queue, new-process resume, production configuration |
| Codex0.159.3 locally generated JSON Schema in isolated temp home | Exact installed request/response field names | Effective configuration precedence, live approval behavior or idempotent input replay |
| Official Tauri/macOS docs | Selected framework APIs and need for packaged native checks | Notification click routing in the built bundle |
| Local Markdown/link/JSON example checks | Structural design consistency | Domain/protocol implementation correctness |

The implementation must vendor the relevant redacted protocol fixtures/schema excerpts with provenance (CLI/package version, generation command, capture date, SHA-256). Do not depend on temporary planning paths such as `/tmp/ariadne-codex-schema-01593` surviving into implementation.

## 2. Compatibility proofs that gate dependent implementation

Each proof has a small scratch harness and a written record. Use owner-approved provider access only during implementation; a few harmless fixed prompts suffice. No uncontrolled retry loops, benchmarks or paid evaluation campaigns. A schema fixture does not count as a live proof.

| ID | Exercise and observable pass criteria | If it fails |
| --- | --- | --- |
| C01 | **Passed, basic transport, Claude2.1.287:** send input UUID A, observe initialization/session ID, correlated replay/response and success result; keep stdin open; send B only afterward; same session accepts it. [Evidence](../evidence/CLAUDE_STREAM_SMOKE.md); tools/MCP/hooks disabled | Re-run in the integrated configuration during M0; a smoke pass does not cover C03/C04 |
| C02 | Queue A/B/C outside host; prove three distinct ordered turns and no coalescing; answer an MCP question from UI only; finish independent work before input drain | Scheduler contract is mandatory; do not use host internal queue/coalescing or revert to next-terminal-message pickup |
| C03 | Permission tool receives actual host payload; Allow once permits exactly requested harmless operation; Deny/timeout/Cancel/disconnect do not execute it; ordinary Ariadne tools do not recurse through permission prompts; pending approval remains blocking beyond two minutes with auto-background disabled and expires at the local ten-minute deadline | Correct current raw-CLI contract; if unsupported, evaluate SDK sidecar as a named architecture change with auth/packaging impact |
| C04 | Strict managed MCP inventory, existing CLI login, settings overlay, generated rules, default permissions and managed-hook no-op work together; init confirms readiness; failed permission-server startup preserves honest first-input state; disallowed extra MCP remains inactive; conflicting answer-injection hooks block launch; settings digest changes require review | Block unsupported configuration; do not weaken policy, use bare mode blindly or collect credentials |
| C05 | Stop, stdin EOF, parent app death, worker SIGKILL, child tools and resume: cleanup/evidence is accurate and same recorded session resumes without automatic duplicate input | Implement reliable owned cleanup; otherwise project remains recovery_required and cannot start another writer |
| N01 | Codex initialize/initialized, thread/start/resume, turn/start accept, deltas, completed/interrupted, three ordered inputs | Fix adapter against pinned generated schema; no terminal scraping fallback |
| N02 | Spawn-only MCP overrides and canonical rules load; only allowed server inventory; normal login/configured provider stays CLI-owned; `account/read` sanitized if used | Fix supported launch config or block conflicting profile; do not invent per-thread config behavior |
| N03 | Command/file offered allow-once/deny/cancel; experimental native grouped response, duplicate/replayed multi-question request, preserved partial drafts, nonblocking resolution/expiry; exact opaque request IDs | Keep ordinary questions via domain MCP; unsupported native controls must fail clearly, never hang |
| N04 | Crash around turn/start response; thread/read evidence distinguishes known consumed input from unresolved input; no assumed dedupe by clientUserMessageId | Keep uncertain UI and explicit resend choice; do not promise exactly-once work |
| M01 | Packaged native notification permission/denial, foreground/hidden/cold-click route, changed/already-answered item | Fix single native delegate bridge; notification routing remains required |
| M02 | Packaged single instance, CLI open path with spaces, tray task count/permission indicator, pin and monitor changes | Fix native routing/window lifecycle before polish |
| M03 | Test-only WebdriverIO works and is absent from release | Use mocked React suite plus explicit packaged manual native checklist permitted by prompt |

M0 can use minimal UI/fixture storage for these proofs. It is not a requirement to build the full domain store first. M1–M3 replace temporary harnesses with production services, preserving proof fixtures. Record pass/fail, exact CLI/build/OS versions, inputs, expected outputs, redacted observations and chosen resolution. A pending proof is not a passed milestone.

## 3. Deterministic scenario matrix

| ID | Scenario | Required assertions | Milestone |
| --- | --- | --- | --- |
| D01 | Atomic two-child batch (Open + Waiting) | One message/revision; IDs4.1/4.2; parent allocation/backlinks; invalid child rejects entire batch | M1/M2 |
| D02 | Duplicate op/same vs different body | Same IDs/result for same digest; operation_reused for different body | M1 |
| D03 | Concurrent writers, same/different items | No lost unrelated updates; same-item conflict explicit; counters unique | M1 |
| D04 | Answer vs changed question/close/correction | Draft conflict only for changed question; no terminal close over newer unhandled answer | M1/M3 |
| D05 | External terminal answer delivery | Non-destructive fetch/ack, no worker launch, manual-pickup label | M2/M7 |
| D06 | Input P1/P2/A3 and fetch during P1 | Exactly FIFO turns; fetch cannot expose future A3; no auto-coalescing | M1/M3/M7 |
| D07 | Receipt before result | UI says Received; next input waits for result | M3 |
| D08 | Stop with queue and then new answer | All saved; no silent restart; explicit Resume preserves order | M3/M7 |
| D09 | Native request while P2 queued | Response returns into current turn; P2 does not starve/replace request; expiry preserves owner text | M3/M7 |
| D10 | Permission replay/stale epoch | Old allow never grants a new request; duplicate click idempotent | M1/M3/M7 |
| D11 | Worker SIGKILL then free lease | Stale active-run evidence blocks duplicate writer until reconciled | M3 |
| D12 | Unicode frame split/malformed JSON/oversize frame/escaped read size | Correct incremental parse; bounded memory; explicit protocol error; accepted answers fit full fetch and growing item collections paginate | M0/M1/M3/M7 |
| D13 | UI cannot drain activity | Lifecycle/results persist; transient gap shown; no provider pipe deadlock | M3/M4 |
| D14 | App watcher lost / reordered revisions | Reconcile recovers; no stale snapshot replacing new one; drafts/focus retained | M3 |
| D15 | Full disk /19MiB threshold/20MiB hard cap mid-turn | No claimed successful save; control reserve or explicit store failure; queue pauses | M1/M3 |
| D16 | Missing/duplicate/moved project root | Correct index identity handling; no home scan or silent root merge | M1/M4 |
| D17 | Corrupt/future schema/migration interrupted | No overwrite/reset; backup/damaged bytes preserved; repair explicit | M1 |
| D18 | Setup crash, repeat, foreign/edited files | Owned-only rollback/uninstall, idempotence, unrelated edits survive | M7 |
| D19 | Draft edits while child/tool updates arrive | No focus/scroll/text loss; stale question requires review | M3/M4 |
| D20 | Graph/tree/filter/reveal consistency | Same selected item, ancestors visible, global waiting unaffected | M4/M5 |
| D21 | Notification bursts/reopen/already-answered click | Deduplicated episode alerts, no backlog replay, current detail opens | M6 |
| D22 | Release offline / provider error | History/demo/save work; inference error pauses honestly; no app network/listener/telemetry | M8 |
| D23 | Rejection retry vs possibly executed failure | Proven rejection retries same ID/seq with new attempt; failure blocks later inputs until explicit resolution; skip never fabricates success/ack; Resume alone cannot bypass failure | M1/M3/M7 |

Inject store failures before temp write, after temp fsync, after backup rename, after live rename and before directory sync. Use actual separate processes for lock tests. Inject runtime failures before prepare, after prepare, after write, after acceptance, after MCP receipt and after result commit. Fake provider fixtures cover these cheaply; live providers cover semantics that fixtures cannot establish.

## 4. Requirement ownership

| Requirement | Design owner | Implementation evidence |
| --- | --- | --- |
| Versioned concurrent JSON/session, recovery | DOMAIN_AND_STORAGE §§2–6 | D01–D04, D15–D17 |
| Cheap CLI + shared agent rules | API_AND_MCP §§1,3,5 | CLI subprocess suite and generated-rule parity |
| Owner sends N messages | QUEUES_AND_RECOVERY §§2–4 | C02/N01/D06–D08 |
| Agent expands tree with Open/Waiting children | API_AND_MCP §4 | D01 + live MCP tool call |
| Automatic answer-to-agent path | PROCESS_AND_PROTOCOLS + QUEUES_AND_RECOVERY | C01–C05/N01–N04 |
| Tree/waiting/detail/answer/timeline | UI_AND_NATIVE §§1–3,5–7 | D19/D20, supplied reference comparison |
| Graph/search/filter/keyboard/themes | UI_AND_NATIVE §§3–4,7 | Component E2E and screenshot matrix |
| Tray/notification/open/pin | UI_AND_NATIVE §8 | M01/M02/D21 |
| Reversible project/global setup, both external integrations | SETUP_AND_DELIVERY §§3–5 | D05/D18 and real scratch-host scripts |
| Canonical demo | Existing PRODUCT normalization + core operations | Fixture matches example hierarchy/status language; no provider launch |
| One-command local install/uninstall | SETUP_AND_DELIVERY §6 | Clean checkout packaged install record |
| Local data/no telemetry/no unwanted settings writes | SETUP_AND_DELIVERY §§1–5,7; UI_AND_NATIVE §9 | Release permission/bundle/settings/network observation |

## 5. Milestone implementation outputs

These supplement existing ROADMAP task IDs rather than create an unrelated second backlog.

| Milestone | Concrete new artifacts required |
| --- | --- |
| M0 | Workspace/toolchain lockfiles; platform-proofs ledger; tested provider schema/type snapshots; minimal protocol/native harnesses; version capability table |
| M1 | Rust entities/command enums + generated schema/TS; transaction/OS lock layer; runtime/input/request state commands; deterministic demo and fault fixtures |
| M2 | CLI parsing/help/errors; rmcp server/tool schemas; canonical rules + generated artifacts; two-child tool example tested through stdio |
| M3 | Worker protocol + Claude adapter; FIFO scheduler; watcher/snapshot bridge; minimum tree/answer/composer/permission/recovery UI |
| M4 | Complete selectors/components/drafts; native-question mapping; queue controls; accessible state gallery and reference screenshots |
| M5 | Deterministic graph algorithm + performance measurements |
| M6 | Native bridge/tray/routes/window settings + packaged checklist |
| M7 | Codex adapter parity; setup planner/journal/rollback; optional external hooks; real-host acceptance evidence |
| M8 | Locked build/install scripts/manifests; release checks; user README; local commits and final evidence report |

## 6. Completion language

Use **design specified** for decisions written here. Use **schema inspected** for protocol fields examined without running a session. Use **proved on version X** only after the corresponding executable proof passes. Use **implemented** only after production code exists and its gate passes. The final release still requires both Claude and Codex, packaged native behavior, supplied visual fidelity, repeatable tests and installation.

The planning deliverable is complete when every flow has a specified owner, input/output contract, persistence/ordering rule, error/recovery behavior and assigned proof. It is not a claim that all upstream capabilities have already been executed, and an implementation must not fill a failing integration gap by silently weakening the user interaction contract.
