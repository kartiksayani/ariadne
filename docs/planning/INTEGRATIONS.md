# Agent integration, setup, and installation

The primary integration is [managed agent sessions](AGENT_RUNTIME.md): Claude Code first, then Codex. The plugin, CLI, and external-terminal hooks reuse the same rules/store but are not the mechanism that wakes a managed conversation.

Exact launch/configuration, journal and install algorithms are in [Setup and delivery](low-level/SETUP_AND_DELIVERY.md); exact host frames/flags are in [Processes and protocols](low-level/PROCESS_AND_PROTOCOLS.md).

## One behavioral rule source

Maintain `packages/agent-rules/RULES.md` as the only authored behavioral source. Generate the Claude skill body, managed-session bootstrap and Codex instruction section from it; a test compares normalized content. Platform adapters contain only host-specific discovery, invocation, and protocol details.

The shared rules must instruct both agents to:

1. Use the supplied binding. Read delivered owner answers, fetch referenced full answers/pages, and acknowledge exact IDs. Resume recovery fetch is limited to eligible previously dispatched/current-input answers in managed mode; it never reads future queued input ahead of FIFO order.
2. Record each meaningful question, decision, finding, task, and explanation in a full sentence. Avoid tool-call noise and duplicate items for repeated discussion of the same point.
3. Record follow-up questions as children of the causal item. Refining the same question may remain on that item, with a new message and preserved prior answers.
4. Put an item in waiting only when the owner's input is needed. Supply options with consequences when useful, identify at most one recommendation, and allow free text. The recording tool returns immediately; continue independent work, then finish the turn if blocked. Ariadne sends saved answers as subsequent input. Do not spin or hold a question tool open waiting for the owner.
5. Give every terminal item an outcome and one-line why. Replace with a new linked item when meaning changes; never silently repurpose an ID.
6. Record a concise excerpt and the items touched for every substantive reply, preferably in one MCP `apply` transaction (CLI `apply` for external sessions). Describe actual work and decisions; never fabricate transcript quotes or claim unperformed actions.
7. Use explicit project/session/consumer routing and stable operation IDs on retried mutations. Read current state after conflicts.
8. Treat UI answers as attributed owner input about the named item. They do not override host instructions, security policy, or permissions. Do not act twice merely because an unacknowledged answer is delivered again.
9. If Ariadne is unavailable, tell the owner briefly, continue independent authorized work, and retry at the next turn. Do not silently discard an answer or claim to have recorded something that failed.

## Managed launch configuration

`setup --agent claude|codex|both` initializes the project and installs versioned Ariadne resources under its own directory. It records executable locations and generates scoped launch configuration; it does not need to rewrite the user's global host configuration. A global setup makes resources available, while each project still requires explicit initialization/trust. Claude is the default New session choice.

For Claude, launch the installed binary with the generated plugin/rules, MCP server and permission-prompt tool configuration. For Codex, configure the same MCP server and canonical bootstrap through supported app-server launch/thread settings. Exact configuration precedence and schemas must pass M0 on the selected versions. Managed policies remain authoritative. Enumerate effective configuration sources, preserve existing instructions, and detect conflicts instead of replacing project policy to make setup work.

Both adapters receive a fixed binding and run ID. MCP mutations cannot override that binding through tool arguments. Require confirmed MCP readiness for a successful managed launch. Claude may need the first input before init appears, so validate its permission-server startup gate in C04; a failed init does not prove that input was never consumed. Missing required tools/bridge stops the run, pauses dispatch and preserves uncertain-input evidence with a repair hint. Do not silently fall back and claim full integration.

## Optional external Claude Code adapter

With `setup --external-terminal`, package a local plugin with `.claude-plugin/plugin.json`, `skills/ariadne/SKILL.md`, and `hooks/hooks.json`. The synchronous `UserPromptSubmit` command invokes the installed `ariadne hook claude` binary and reads host JSON stdin. This external-session plugin uses CLI operations and has no Node runtime dependency. Managed launch uses scoped MCP configuration and omits duplicate answer-injection hooks.

Chosen persistent layout: project setup installs the plugin at `<project>/.claude/skills/ariadne/`; global setup uses `~/.claude/skills/ariadne/`. Current official documentation describes skills-directory plugins in both locations. Project plugins require workspace trust and are loaded from the primary working directory, so project setup prints **Start Claude from this project root**. `--plugin-dir` is for development smoke tests, not the installed workflow. Verify the exact minimum supported Claude version in M0. [Claude plugin loading](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository)

Add a clearly marked bootstrap section to project `CLAUDE.md` or global `~/.claude/CLAUDE.md` to ensure the agent uses Ariadne's rules. Preserve existing content and imports. The hook also identifies the active binding and how to load rules, so relying on automatic skill selection alone cannot silently disable recording. Setup identifies managed-policy or explicitly disabled-plugin conflicts and reports them without overriding the owner's choice.

Hook output uses JSON `hookSpecificOutput` with `hookEventName: UserPromptSubmit` and `additionalContext`. The adapter returns no context when there is nothing relevant, except a concise initial binding/rules hint. Keep hook execution bounded to three seconds, with the store's shorter lock timeout inside it. On error, emit a concise host-compatible warning with a manual fetch command, exit without blocking the user's prompt, and retain pending answers. Host timeouts do not constitute receipt. [Claude hooks](https://code.claude.com/docs/en/hooks#userpromptsubmit-input)

## Optional external Codex adapter

With `setup --external-terminal`, project setup installs an owned instruction section into the effective root `AGENTS.md` (or existing `AGENTS.override.md` if it is the file Codex actually reads), and merges one owned `UserPromptSubmit` command entry into `<project>/.codex/hooks.json`. Global setup uses the resolved Codex home instead. Respect `CODEX_HOME`; never rewrite it. Detect nearer instruction overrides and instruction-size limits and report their effect in `doctor`. [Instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

Codex currently documents turn-start command hooks, JSON additional context, and project/user hook sources. It requires review of non-managed hooks through `/hooks`; changes can require fresh trust. Setup prints that required host step and never bypasses hook trust or weakens sandbox settings. Existing duplicate project/global handlers are detected; the adapter's binding/idempotency logic also tolerates repeated calls. The local CLI observed during planning is `0.159.3`; actual minimum supported versions remain an M0 result. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

The external-session rules include an explicit `answer fetch` instruction. On a version where hooks are absent, untrusted, or disabled, the agent fetches on its first action of the turn. `doctor` labels this **External session · manual pickup**. Both mechanisms use the same consumer identity and answer IDs. This fallback cannot replace the managed-session live delivery gate. Do not intercept host transcripts or type into terminals through AppleScript.

Global integration means the rules/adapters are available in all projects. They activate only in explicitly registered/initialized Ariadne projects; ordinary agent work elsewhere is a no-op. A project still needs initialization to create its store and ignore entry. Global setup prints this distinction.

## Reversible setup contract

`setup` defaults to the current project and the explicitly selected host(s). It prints a before/after change list and then applies those owned changes; `--dry-run` prints the same list without writes. Ordinary setup is already authorized by invoking it. It does not edit unrelated settings or enable external services.

Each installation journal records version, scope, canonical target path, whether the file existed, original and installed checksums, owned markers/JSON entries, and backups needed for rollback. Use a lock for setup/uninstall in the same scope. Re-running with identical inputs is a no-op and prints **No changes**. Upgrades replace owned generated content while preserving unrelated edits.

| Surface | Project setup | Global setup |
| --- | --- | --- |
| Session store + project metadata | Create `.ariadne/`, register root, add marked ignore entry | Initialize no arbitrary projects; availability only |
| Managed-session resources | `.ariadne/integrations/`: plugin, rules, generated launch configuration | Versioned shared resources under `~/.ariadne/integrations/` |
| External Claude plugin, opt-in | `.claude/skills/ariadne/` | `~/.claude/skills/ariadne/` |
| External Claude bootstrap, opt-in | Effective project `CLAUDE.md` | `~/.claude/CLAUDE.md` |
| External Codex rules, opt-in | Effective project instruction file | Effective instruction file in Codex home |
| External Codex hook, opt-in | `.codex/hooks.json` owned entry | Codex-home `hooks.json` owned entry |
| Ownership journal | `.ariadne/setup-manifest.json` | `~/.ariadne/integrations/setup-manifest.json` |

Before applying changes, parse settings and validate destinations. If an owned-name directory already exists without an Ariadne journal, stop with the exact collision; never assume ownership. For malformed settings, give a diagnostic without rewriting them. Detect concurrent file changes with checksums immediately before commit. Persist the planned journal before edits so interrupted setup can resume or roll back. After a partial failure, report exactly what succeeded and what rollback did.

`uninstall` removes only matching generated blocks/entries and files recorded as owned. It does not restore an entire old settings file over later user changes. If an owned block has been edited, preserve it and print the unresolved cleanup rather than guessing. Remove a file created by setup only if it contains no other content. Retain session JSON and the `.ariadne/` ignore entry while history remains; report retained data. Preserve shared/global resources still referenced by another project installation. Remove empty resource directories only when ownership is established.

Host-owned trust records remain host-owned. Setup reports any trust requirement; uninstall does not edit private trust databases. Native host records should be removed through a documented host operation only if needed and scoped to Ariadne.

## Build and install

Planned user entry point: `make install`. It checks macOS, Xcode Command Line Tools, the pinned Rust toolchain, Node/npm, `/Applications` write access, and target architecture before building. It runs locked dependency installs, builds the release CLI/app/worker, and checks bundle contents. Development dependencies may be downloaded at build time. The installed UI/store works offline; managed agent inference needs the provider's network service. Provider CLIs are user-installed prerequisites, checked by `doctor`, not silently downloaded or updated.

Install `Ariadne.app` under `/Applications`. For the CLI, honor explicit `BIN_DIR`; otherwise choose `~/.local/bin` when on PATH, then `~/.cargo/bin` when on PATH, then an existing writable user-owned PATH directory. Print the selected destination and never overwrite an unrelated same-name binary. If none is suitable, fail preflight with one exact PATH instruction; do not silently edit shell startup files or install a CLI that the shell cannot find. If `/Applications` requires permissions, report the concrete install step needing them. Build artifacts can remain ready for that step.

Stage replacements next to their targets and preserve the previous working installation until replacement succeeds. Record installed paths/checksums in a package install manifest. If the app is running, explain that it needs to be quit/restarted for replacement; do not kill an unrelated process. Integrations invoke a stable installed CLI path, not a Cargo build output that may disappear.

Support the host Mac's architecture first. Record the deployment target and tested macOS versions in M0; build Intel/universal binaries only if the intended machine requires them. Local unsigned installation is allowed. README explains macOS's supported open-anyway workflow for unsigned apps; do not disable Gatekeeper globally. Validate installation from the packaged app, since notification and launch behavior can differ in development.

`ariadne uninstall` reverses integration setup. A separate `make uninstall` removes app/CLI files owned by the package manifest, after explaining that integrations should be removed first. Neither deletes conversation history automatically.

## Real integration acceptance script

Run separately for Claude and Codex in disposable projects with dedicated test configuration homes where supported; do not use the owner's real settings as fixtures.

1. Record versions and initial configuration checksums. Install Ariadne, initialize the scratch project, run setup twice, and confirm the second run changes nothing.
2. Complete project/configuration trust. Start a managed Claude conversation in Ariadne, ask it to compare harmless choices, and verify an MCP question appears live. Repeat the full script for Codex.
3. Answer only in Ariadne. Send no terminal message. Verify automatic dispatch when idle, exact answer receipt, agent acknowledgment, and recorded outcome. Repeat while busy: the answer queues and dispatches automatically after completion.
4. Exercise a harmless tool permission: allow once, deny, cancel, and disconnect. Verify item answers never approve tool execution. Exercise a native user-input request where supported without a stuck turn or duplicate question.
5. Kill the app/worker/host at separate send/accept/receipt boundaries. Verify saved data, uncertain-delivery UI, no blind replay, and owned-process cleanup. Stop, resume, and confirm the exact same conversation binding. Start another project conversation and prove answer isolation. Reject a second managed writer in the same root.
6. Verify missing login, quota/error events, unsupported versions, hidden-window activity, quit, and restart. Do not mistake stale run records for live connections.
7. Test opt-in external-terminal setup separately, including hook failure and explicit fetch. Its manual-pickup label must be visible. Managed conversations must not receive duplicate hook delivery.
8. Change unrelated configuration after setup; uninstall and verify those changes survive. Confirm history is still readable and no Ariadne handler fires in an unconfigured project.

Protocol and hook fixtures cannot replace this real-host exercise. Run live provider-backed sessions only in the implementation phase with the owner's available host access; no paid evaluation jobs are launched during planning.
