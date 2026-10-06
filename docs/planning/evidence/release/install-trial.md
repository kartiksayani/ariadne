# Personal install trial (P6.4)

2026-10-06 UTC. Real `make install` -> `ariadne doctor` -> `make install` -> `make uninstall`
on commit `ed56f7d` (the tree merged as #109), run in an isolated temporary HOME on the
owner's Mac. Raw logs were not retained (ADR-0069); the lines quoted below are the evidence.

## Machine

- macOS 26.7 (25G229), arm64.
- node v22.23.2, npm 10.9.8, rustc 1.98.1, cargo 1.98.1, Python 3.14.6, Xcode CLT `/Applications/Xcode.app/Contents/Developer`.
- Isolation: `HOME=/private/tmp/ariadne-install-trial.FjEw`, `CARGO_HOME=/tmp/ariadne-install-trial/cargo-home`,
  `RUSTUP_HOME=/Users/kartik.sayani/.rustup` (read-only use, so the installed toolchain was found; no download).
- Every destination in `scripts/install/install.py` derives from `HOME`. Real-home mtimes of
  `~/.rustup`, `~/.cargo`, `~/.npm` were unchanged after the run.

## Stage 0: first attempt refused

- `HOME=/tmp/ariadne-install-trial.FjEw` failed: `Unsafe directory: /tmp/ariadne-install-trial.FjEw`.
- Cause: `/tmp` is a symlink to `private/tmp` on macOS and the installer walks HOME with `O_NOFOLLOW`.
- Retried with the `/private/tmp/...` path. Log: `install0-symlink-tmp-refusal.log`.

## Stage 1: `make install`

- Preflight line: `{"preflight": {"os": "macOS", "os_version": "26.7", "architecture": "arm64", ... "rust_toolchain": "1.98.1", ...}}`.
- Build: `npm ci --ignore-scripts`, three `--locked` xtask `--check` runs, `cargo build --release --locked`, `tauri build --no-default-features`.
- Result: `Installed Ariadne 0.1.0: /private/tmp/ariadne-install-trial.FjEw/Applications/Ariadne.app`.
- Duration 73 s (second attempt; compile cache warm from the refused first attempt, which took 323 s).
- Automatic post-install doctor: `Result: warning`, rc 0.
- Layout (`find -maxdepth 5`, excluding `.npm`):
  - `.local/share/ariadne/versions/0.1.0/{Ariadne.app,bin/ariadne,bin/ariadne-mcp,install.json,integrations/}`
  - `.local/share/ariadne/current -> versions/0.1.0`, plus `install.lock`.
  - `Applications/Ariadne.app -> ../.local/share/ariadne/current/Ariadne.app`
  - `.local/bin/ariadne -> ../share/ariadne/current/bin/ariadne`
  - `.local/bin/ariadne-mcp -> ../share/ariadne/current/bin/ariadne-mcp`
  - `.agents/skills/ariadne -> ../../.local/share/ariadne/current/integrations/codex-skills/ariadne`
- No `.zshrc`, `.zprofile`, `.bash*` or `.profile` in HOME.

## Stage 2: doctor

- `~/.local/bin/ariadne doctor`: rc 0, `Result: warning`.
- `ariadne doctor --json`: rc 0, `{"api_version":1,"ok":true,"data":{"app_version":"0.1.0",...`.
- `ok installation.resource_parity` (changed/missing empty); `ok registry.empty`.
- Warnings only: `control.socket` (desktop not open), `claude.version_unknown`, `codex.version_unknown`
  (no `--claude-bin`/`--codex-bin` given).

## Stage 3: bundle check

- Bundle contains one executable, `Contents/MacOS/ariadne-desktop` (30.14 MiB bundle).
- `grep -ci "wdio|webdriver"` on `Info.plist`, the binary and recursively over all files in the bundle: 0 hits.
- `strings | grep -ci "TAURI_WEBDRIVER|WDIO_|tauri-plugin-wdio|webdriver|ARIADNE_E2E"`: 0.
- `devtools` strings in the binary are Tauri's generic ACL names (`deny-internal-toggle-devtools`); no listener or driver.

## Stage 4: second `make install`

- rc 0, 71 s, same `Installed Ariadne 0.1.0` line and same doctor output.
- `find` listing diffed against stage 1: identical (`FS-IDENTICAL`).
- No "unchanged"/"nothing changes" message is printed (see README mismatches).

## Stage 5: `make uninstall`

- rc 0, 1 s: `Personal package uninstall finished. Project history and host configuration were preserved.`
- Remaining under HOME (excluding `.npm`): empty `Applications/`, `.local/bin/`, `.agents/skills/`,
  `.local/share/ariadne/versions/` (empty) and `.local/share/ariadne/install.lock`.
- Removed: the `0.1.0` version dir, `current`, all four links.
- No project history existed in the temp HOME (nothing was registered), so history retention was not exercised.

## Observations, not blocking

- A HOME that is itself a symlink (`/tmp` on macOS) is refused as `Unsafe directory`; a real
  home directory is not a symlink, so the README does not mention it.
- Repeat install prints the full `Installed Ariadne 0.1.0` banner rather than an "unchanged"
  line; the file listing proves nothing changed, which is what the README promises.
- The post-install doctor ends with `Result: warning` on a machine with no hosts configured
  (socket closed, host versions unknown); that is the expected state before setup.
- Uninstall leaves empty parent directories as well as `install.lock`.
- Not exercised: the "PATH directory is absent" instruction (the directory was created first,
  as the README asks) and history retention across uninstall (no project was registered).
  Both are covered by `tests/functional/install/test_install.py`.

## P6.4 acceptance

| Bullet | Result |
| --- | --- |
| 1. Preflight OS/arch/toolchain, locked builds, owned manifest; app in `~/Applications`, helpers/rules/Mod under versioned path | PASS (`install.json` inventory, `versions/0.1.0`, `current`) |
| 2. Only contained owned symlinks/current updated; no startup-file edit; no sudo/toolchain/provider download | PASS for links, no startup files, no sudo, no toolchain download. Missing-PATH-dir instruction NOT exercised |
| 3. Uninstall removes only owned app/helpers/links, retains history/unrelated edits; no driver/devtools/test listener in bundle | PASS for owned removal and bundle scan. History retention NOT exercised (no history created) |
