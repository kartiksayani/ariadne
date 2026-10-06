# Clean-checkout install evidence (P8.1)

2026-10-07 UTC. Fresh clone of `kartiksayani/ariadne` at `1e8d9e7` (main), then `make install` ->
`ariadne doctor` -> `ariadne doctor --json` -> `make install` -> bundle check -> `make uninstall`,
run in an isolated temporary HOME on the owner's Mac. Raw logs were not retained; the lines quoted
below are the evidence.

## Machine

- macOS 26.7 (25G229), `MacBookPro17,1`, arm64.
- node v22.23.2, npm 10.9.8, rustc 1.98.1, cargo 1.98.1, Python 3.14.6.
- Isolation: clone at `/private/tmp/ariadne-clean-1e8d9e7`, `HOME=/private/tmp/ariadne-clean-home`,
  `CARGO_HOME=/private/tmp/ariadne-clean-cargo` (fresh, empty before the run),
  `RUSTUP_HOME=/Users/kartik.sayani/.rustup` (read-only use; no toolchain download).
  `$HOME/.local/bin` was created first, as the README asks. The real HOME was not used.
- `git rev-parse --short HEAD` in the clone: `1e8d9e7`.

## Stage 1: `make install`

- Preflight line: `{"preflight": {"os": "macOS", "os_version": "26.7", "architecture": "arm64", "python": "3.14.6", "node": "v22.23.2", "npm": "10.9.8", ... "rust_toolchain": "1.98.1", ...}}`.
- Result: `Installed Ariadne 0.1.0: /private/tmp/ariadne-clean-home/Applications/Ariadne.app`.
- rc 0, 366 s (cold: empty `CARGO_HOME`, no `target/`, no `node_modules`).
- Automatic post-install doctor: `Result: warning`.
- Layout (`find -maxdepth 5`, excluding `.npm`):
  - `.local/share/ariadne/{versions/0.1.0, current, install.lock}`
  - `Applications/Ariadne.app`
  - `.local/bin/ariadne`, `.local/bin/ariadne-mcp`
  - `.agents/skills/ariadne`
- `.npm` (npm cache) appears under HOME; it is excluded from the listings.

## Stage 2: doctor

- `ariadne doctor`: rc 0, <1 s, `Result: warning`.
- `ariadne doctor --json`: rc 0, <1 s, `ok: true`, `data.status: warning`.
- `ok`: `installation.resource_parity`, `registry.empty`.
- `warning`: `control.socket`, `claude.version_unknown`, `codex.version_unknown`.

## Stage 3: second `make install`

- rc 0, 86 s, same `Installed Ariadne 0.1.0: ...` line.
- `find` listing diffed against stage 1: identical (`FS-IDENTICAL`).

## Stage 4: bundle check

- `Contents/MacOS` holds one executable: `ariadne-desktop` (bundle about 30 MB).
- `grep -rci "wdio\|webdriver"` over the whole bundle: 0 hits in every file.
- `strings` of the binary piped to `grep -ci "TAURI_WEBDRIVER\|WDIO_\|tauri-plugin-wdio\|webdriver\|ARIADNE_E2E"`: 0.

## Stage 5: `make uninstall`

- rc 0, 1 s: `Personal package uninstall finished. Project history and host configuration were preserved.`
- Remaining under HOME: empty `Applications/`, `.local/bin/`, `.agents/skills/`,
  `.local/share/ariadne/versions/` (empty), `.local/share/ariadne/install.lock`, and the `.npm` cache.
- Removed: the `0.1.0` version dir, `current`, `Ariadne.app` link, `ariadne`/`ariadne-mcp` links, the skill link.
- No project was registered (`registry.empty`), so history retention was not exercised.

## Timing

- Total wall time, clone-to-uninstall: about 472 s (install 366 s, second install 86 s).

## P8.1 acceptance

| Item | Result |
| --- | --- |
| Clean checkout of `1e8d9e7` installs with `make install` | PASS (rc 0, `Installed Ariadne 0.1.0`) |
| Post-install doctor | PASS (`Result: warning`, expected before host setup; resource parity ok) |
| Second install is a no-op on disk | PASS (listing identical) |
| No driver/test hooks in the shipped bundle | PASS (0 / 0) |
| Uninstall removes owned files only | PASS for owned removal; history retention NOT exercised |
