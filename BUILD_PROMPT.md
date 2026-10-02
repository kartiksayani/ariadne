# Build Ariadne — autonomous build prompt

You are building **Ariadne** from scratch, fully autonomously. Make every decision yourself, record each significant one with its reason in `DECISIONS.md`, and keep going. Only stop to ask the owner if you are truly blocked (missing designs, a credential, or an action outside this machine). There is no token budget limit — spend what it takes to make this good.

## Why it exists

The owner works with AI coding agents (Claude Code and Codex) in long chat sessions. One question from the owner turns into N questions/decisions/findings from the agent; follow-ups on a few of those each spawn M more. After an hour the owner can't tell which agent message relates to which earlier item, what has been decided, and what is still waiting on them.

Ariadne fixes that: the agent records every question, decision, finding and task as an **item in a tree**, written in plain sentences, with a status. The owner watches it in a macOS app on a second screen, sees at a glance what is decided and what is waiting on them, and answers right there. The agent picks the answers up on the next turn. Like Ariadne's thread, it lets the owner trace any point back to where it came from.

## Inputs

- `designs/` — UI mockups produced by Claude Design from `DESIGN_PROMPT.md`. Build the UI to match them (layout, spacing, colours, light/dark, component states). If the designs and this prompt disagree on data or behaviour, this prompt wins; on look and feel, the designs win.
- `DESIGN_PROMPT.md` — the brief the designs were made from: data model, views, interactions, example data. Read it first.

## What to build

**A macOS app plus an `ariadne` command-line tool,** sharing one store. macOS only for now; don't spend effort on Linux or Windows, but don't rule them out either.

**Stack:** Tauri 2 (Rust core) with a TypeScript + React UI, and the `ariadne` CLI in Rust in the same workspace. Start from the current official Tauri templates (`create-tauri-app`, React + TypeScript) and check the current Tauri version and docs before building — don't rely on memory. Reuse the HTML/CSS from `designs/` as directly as the stack allows.

1. **Storage.** One JSON file per project session (e.g. `.ariadne/<session>.json` in the project, gitignored by setup; or under `~/.ariadne/<project>/` — pick one, explain why). Versioned schema, validated on every write, atomic writes, safe when the app and an agent write at the same time. The app lists all known sessions across projects and lets the owner switch between them.
2. **CLI for agents.** Small, predictable commands an agent can call cheaply: add an item (with parent), update/close/drop/replace an item, record a message and the items it touched, list what's open / waiting on the owner, and fetch answers the owner gave in the UI since the last fetch. Output must be compact and parseable (plain text by default, `--json` option). Errors explain how to fix the call.
3. **The macOS app.** Live updates when the store changes. Implements the designs: tree view with closed branches collapsed, the always-visible "Waiting on me" panel, item detail with message timeline, inline answering with the agent's options and recommendation, graph view, search and filters, keyboard-first navigation, light/dark following the system setting. Answering writes the answer to the store and marks the item for the agent to pick up. Mac touches:
   - a **menu-bar icon** showing the "waiting on me" count, with a quick list of those items;
   - a **native notification** when an agent adds an item waiting on the owner (clicking it opens that item);
   - an **"always on top"** option for second-screen use;
   - `ariadne open` from the terminal opens or focuses the app on the current project's session.
4. **Agent integration — Claude Code and Codex are both first-class.**
   - **Rules for agents** (one source text, shipped to both): when and how to create items; every item is a full plain sentence a human understands without remembering codes (`question`, and on close `outcome` + one-line `why`); follow-ups become children; close items when decided; mark replacements instead of silently reusing an item; record which items each reply touched; at the start of each turn, pick up the owner's UI answers.
   - **Claude Code:** a plugin containing a skill with those rules and a `UserPromptSubmit` hook that injects new UI answers into the agent's context automatically.
   - **Codex:** the same rules delivered the way Codex reads instructions (an `AGENTS.md` section or Codex's skill mechanism). Use whatever Codex supports for running a command before each turn; if nothing exists, the rules tell Codex to fetch new answers itself at the start of each turn. Find out what current Codex supports rather than assuming.
   - **`ariadne setup`** wires a project (or globally) for Claude Code, Codex or both; idempotent; prints exactly what it changed. **`ariadne uninstall`** reverses it.
5. **Demo.** A command that creates a demo session from the example data in `DESIGN_PROMPT.md`, so the app can be seen without an agent.
6. **Install.** One command builds and installs the app into `/Applications` and the `ariadne` CLI onto the `PATH` (e.g. a script or `make install`). The app is for local use: unsigned is fine, but document how to open an unsigned app on macOS.

## Constraints

- Local only: no accounts, no cloud, no telemetry, no network calls.
- Never touch an agent's settings outside what `setup` prints and `uninstall` reverses.
- Plain-language first: the UI never makes the reader decode an ID; IDs are for agents and stay small or hidden.
- Keep it simple. No feature the owner didn't ask for unless it clearly serves "see what's decided, what's waiting on me, and where it came from".

## Done means

- A Mac with the toolchains installed can build and install it in one command, open the app on the demo session, and it matches the designs in light and dark; the menu-bar count and notifications work.
- In a real Claude Code session in a scratch project: after `ariadne setup`, Claude logs items as it works; they appear live in the app; answering an item in the app reaches Claude on the owner's next message without the owner retyping it.
- The same end-to-end works with Codex.
- Tests: unit tests for the store and CLI (including concurrent writes from the app and the CLI), and end-to-end UI tests for tree, panel, detail, answering and live update (use the approach Tauri currently recommends, or test the React UI against a mocked backend where driving the real app isn't practical). No flaky tests: run the suites repeatedly and in shuffled order until they are clean.
- README: what it is, install, setup for Claude Code and Codex, a 60-second tour, how the agent rules work, uninstall.
- Work in a local git repo in this directory with small, meaningful commits. Do not create a remote or publish anything; at the end, tell the owner it's ready and ask whether to publish.

## When finished

Report: what was built, how to install and try it, the decisions in `DECISIONS.md` worth the owner's attention, anything that differs from the designs and why, and known limitations.
