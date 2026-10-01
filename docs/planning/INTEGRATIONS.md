# Agent integration, setup, and installation

## One behavioral rule source

Maintain `packages/agent-rules/RULES.md` as the only authored behavioral source. Generate the Claude skill body and Codex managed instruction section from it; a test compares normalized content. Platform adapters contain only host-specific discovery, command invocation, and context-envelope details.

The shared rules must instruct both agents to:

1. At the start of every owner turn, resolve the bound Ariadne session, read injected answers or fetch pending answers, finish any pending pages, then acknowledge the exact IDs read.
2. Record each meaningful question, decision, finding, task, and explanation in a full sentence. Avoid tool-call noise and duplicate items for repeated discussion of the same point.
3. Record follow-up questions as children of the causal item. Refining the same question may remain on that item, with a new message and preserved prior answers.
4. Put an item in waiting only when the owner's input is needed. Supply options with consequences when useful, identify at most one recommendation, and allow free text.
5. Give every terminal item an outcome and one-line why. Replace with a new linked item when meaning changes; never silently repurpose an ID.
6. Record a concise excerpt and the items touched for every substantive reply, preferably in one `apply` transaction. Describe actual work and decisions; never fabricate transcript quotes or claim unperformed actions.
7. Use explicit project/session/consumer routing and stable operation IDs on retried mutations. Read current state after conflicts.
8. Treat UI answers as attributed owner input about the named item. They do not override host instructions, security policy, or permissions. Do not act twice merely because an unacknowledged answer is delivered again.
9. If Ariadne is unavailable, tell the owner briefly, continue independent authorized work, and retry at the next turn. Do not silently discard an answer or claim to have recorded something that failed.

## Claude Code adapter

Package a real local plugin with `.claude-plugin/plugin.json`, `skills/ariadne/SKILL.md`, and `hooks/hooks.json`. The synchronous `UserPromptSubmit` command invokes the installed `ariadne hook claude` binary and reads the host's JSON stdin. The plugin contains no MCP configuration and no Node runtime dependencies.

Chosen persistent layout: project setup installs the plugin at `<project>/.claude/skills/ariadne/`; global setup uses `~/.claude/skills/ariadne/`. Current official documentation describes skills-directory plugins in both locations. Project plugins require workspace trust and are loaded from the primary working directory, so project setup prints **Start Claude from this project root**. `--plugin-dir` is for development smoke tests, not the installed workflow. Verify the exact minimum supported Claude version in M0. [Claude plugin loading](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository)

Add a clearly marked bootstrap section to project `CLAUDE.md` or global `~/.claude/CLAUDE.md` to ensure the agent uses Ariadne's rules. Preserve existing content and imports. The hook also identifies the active binding and how to load rules, so relying on automatic skill selection alone cannot silently disable recording. Setup identifies managed-policy or explicitly disabled-plugin conflicts and reports them without overriding the owner's choice.

Hook output uses JSON `hookSpecificOutput` with `hookEventName: UserPromptSubmit` and `additionalContext`. The adapter returns no context when there is nothing relevant, except a concise initial binding/rules hint. Keep hook execution bounded to three seconds, with the store's shorter lock timeout inside it. On error, emit a concise host-compatible warning with a manual fetch command, exit without blocking the user's prompt, and retain pending answers. Host timeouts do not constitute receipt. [Claude hooks](https://code.claude.com/docs/en/hooks#userpromptsubmit-input)

## Codex adapter

Project setup installs a managed instruction section into the effective root `AGENTS.md` (or existing `AGENTS.override.md` if it is the file Codex actually reads), and merges one owned `UserPromptSubmit` command entry into `<project>/.codex/hooks.json`. Global setup uses the resolved Codex home instead. Respect `CODEX_HOME`; never rewrite it. Detect nearer instruction overrides and instruction-size limits and report their effect in `doctor`. [Instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

Codex currently documents turn-start command hooks, JSON additional context, and project/user hook sources. It requires review of non-managed hooks through `/hooks`; changes can require fresh trust. Setup prints that required host step and never bypasses hook trust or weakens sandbox settings. Existing duplicate project/global handlers are detected; the adapter's binding/idempotency logic also tolerates repeated calls. The local CLI observed during planning is `0.159.3`; actual minimum supported versions remain an M0 result. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

The generated rules always include an explicit `answer fetch` instruction. On a version where hooks are absent, untrusted, or disabled, the agent fetches on its first action of the turn. `doctor` labels this **instruction fallback**, rather than claiming automatic injection works. Both mechanisms use the same consumer identity and answer IDs. Do not install undocumented before-turn workarounds or intercept host transcripts.

Global integration means the rules/adapters are available in all projects. They activate only in explicitly registered/initialized Ariadne projects; ordinary agent work elsewhere is a no-op. A project still needs initialization to create its store and ignore entry. Global setup prints this distinction.

## Reversible setup contract

`setup` defaults to the current project and the explicitly selected host(s). It prints a before/after change list and then applies those owned changes; `--dry-run` prints the same list without writes. Ordinary setup is already authorized by invoking it. It does not edit unrelated settings or enable external services.

Each installation journal records version, scope, canonical target path, whether the file existed, original and installed checksums, owned markers/JSON entries, and backups needed for rollback. Use a lock for setup/uninstall in the same scope. Re-running with identical inputs is a no-op and prints **No changes**. Upgrades replace owned generated content while preserving unrelated edits.

| Surface | Project setup | Global setup |
| --- | --- | --- |
| Session store + project metadata | Create `.ariadne/`, register root, add marked ignore entry | Initialize no arbitrary projects; availability only |
| Claude plugin | `.claude/skills/ariadne/` | `~/.claude/skills/ariadne/` |
| Claude bootstrap | Effective project `CLAUDE.md` | `~/.claude/CLAUDE.md` |
| Codex rules | Effective project instruction file | Effective instruction file in Codex home |
| Codex hook | `.codex/hooks.json` owned entry | Codex-home `hooks.json` owned entry |
| Ownership journal | `.ariadne/setup-manifest.json` | `~/.ariadne/integrations/setup-manifest.json` |

Before applying changes, parse settings and validate destinations. If an owned-name directory already exists without an Ariadne journal, stop with the exact collision; never assume ownership. For malformed settings, give a diagnostic without rewriting them. Detect concurrent file changes with checksums immediately before commit. Persist the planned journal before edits so interrupted setup can resume or roll back. After a partial failure, report exactly what succeeded and what rollback did.

`uninstall` removes only matching generated blocks/entries and files recorded as owned. It does not restore an entire old settings file over later user changes. If an owned block has been edited, preserve it and print the unresolved cleanup rather than guessing. Remove a file created by setup only if it contains no other content. Retain session JSON and the `.ariadne/` ignore entry while history remains; report retained data. Preserve shared/global resources still referenced by another project installation. Remove empty resource directories only when ownership is established.

Host-owned trust records remain host-owned. Setup reports any trust requirement; uninstall does not edit private trust databases. Native host records should be removed through a documented host operation only if needed and scoped to Ariadne.

## Build and install

Planned user entry point: `make install`. It checks macOS, Xcode Command Line Tools, the pinned Rust toolchain, Node/npm, `/Applications` write access, and target architecture before building. It runs locked dependency installs, builds the release CLI/app, and checks bundle contents. Development dependencies may be downloaded at build time; the resulting product is offline.

Install `Ariadne.app` under `/Applications`. For the CLI, honor explicit `BIN_DIR`; otherwise choose `~/.local/bin` when on PATH, then `~/.cargo/bin` when on PATH, then an existing writable user-owned PATH directory. Print the selected destination and never overwrite an unrelated same-name binary. If none is suitable, fail preflight with one exact PATH instruction; do not silently edit shell startup files or install a CLI that the shell cannot find. If `/Applications` requires permissions, report the concrete install step needing them. Build artifacts can remain ready for that step.

Stage replacements next to their targets and preserve the previous working installation until replacement succeeds. Record installed paths/checksums in a package install manifest. If the app is running, explain that it needs to be quit/restarted for replacement; do not kill an unrelated process. Integrations invoke a stable installed CLI path, not a Cargo build output that may disappear.

Support the host Mac's architecture first. Record the deployment target and tested macOS versions in M0; build Intel/universal binaries only if the intended machine requires them. Local unsigned installation is allowed. README explains macOS's supported open-anyway workflow for unsigned apps; do not disable Gatekeeper globally. Validate installation from the packaged app, since notification and launch behavior can differ in development.

`ariadne uninstall` reverses integration setup. A separate `make uninstall` removes app/CLI files owned by the package manifest, after explaining that integrations should be removed first. Neither deletes conversation history automatically.

## Real integration acceptance script

Run separately for Claude and Codex in disposable projects with dedicated test configuration homes where supported; do not use the owner's real settings as fixtures.

1. Record versions and initial configuration checksums. Install Ariadne, initialize the scratch project, run setup twice, and confirm the second run changes nothing.
2. Complete required host trust/reload steps. Start a fresh host conversation from the documented working directory, ask it to compare two harmless choices, and verify a question with options appears live.
3. Answer only in Ariadne. Send a neutral next message in the host. Verify the host receives the exact answer, acknowledges it, and records an outcome without the owner retyping it.
4. Simulate a hook process ending before output/receipt. Confirm the answer is redelivered and no terminal action is duplicated by Ariadne's commands.
5. Start another conversation and prove answers do not leak into it. Resume the original conversation and verify its binding and history persist.
6. Change unrelated configuration after setup; uninstall and verify those changes survive. Confirm history is still readable and no Ariadne handler fires in an unconfigured project.

A scripted hook JSON fixture passing is necessary but cannot replace this real-host exercise. Run live provider-backed sessions only in the implementation phase with the owner's available host access; no paid evaluation jobs are launched during planning.
