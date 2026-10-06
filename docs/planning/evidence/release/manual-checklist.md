# Manual checklist (V11, V21, V24)

Short owner checklist for the three `manual check` rows of [MATRIX](MATRIX.md).
Run it on the installed app after `make install` at the release source SHA.
Leave a Result cell blank until the step has been done; write `pass`, `fail` or
`n/a` with a short note.

## Recorded environment

| Item | Value |
|---|---|
| Mac model | MacBookPro17,1 |
| macOS version | 26.7 (25G229) |
| Claude Code version | 2.1.291 (Claude Code) |
| Codex CLI version | codex-cli 0.160.1 |
| Ariadne version | 0.1.0 |
| Source SHA | 1e8d9e7 |
| Date and tester | DATE_TESTER_PENDING |

## V11: app lifecycle with external host

| # | Step | Result |
|---|---|---|
| 1 | Connect one Claude Code or Codex session to a project. | |
| 2 | Quit Ariadne from the menu. Confirm the host session keeps running. | |
| 3 | With the app closed, run `~/.local/bin/ariadne doctor` and an `ariadne` read command. Both read the saved data. | |
| 4 | Reopen Ariadne. The connection and queued inputs are restored; nothing is resent. | |

## V21: native macOS app

| # | Step | Result |
|---|---|---|
| 1 | An agent asks a question. A macOS notification appears; clicking it opens that item. | |
| 2 | The menu-bar count equals the number of waiting items shown in the Waiting list. | |
| 3 | Launch Ariadne a second time. The running app comes to the front; no second window or process starts. | |
| 4 | Quit Ariadne. External Claude Code and Codex sessions stay running. | |
| 5 | Register a project whose path contains spaces. Connect, ask and answer work normally. | |
| 6 | Quit Ariadne, let a question arrive, then click its notification. The app opens with that item shown. | |

## V24: full release journey

| # | Step | Result |
|---|---|---|
| 1 | Clean checkout: `make install`, then open the app (use **Open Anyway** if macOS asks). | |
| 2 | `ariadne demo --root <empty folder>` opens; browse the demo offline. | |
| 3 | Edit an item as the owner (answer, mark later) and see it in the history. | |
| 4 | `ariadne setup --agent both`, then connect a Claude Code session ([live evidence](../live-acceptance/CLAUDE-2026-10-06.md)). | |
| 5 | Connect a Codex thread and paste the setup instruction once ([live evidence](../live-acceptance/CODEX-2026-10-06.md)). | |
| 6 | Answer a question in Ariadne; it lands in the right session and the agent records a result. | |
| 7 | `ariadne uninstall --agent both`, then `make uninstall`. Only Ariadne-owned files are removed; history is kept. | |
