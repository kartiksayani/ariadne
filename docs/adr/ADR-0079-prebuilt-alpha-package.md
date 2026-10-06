# ADR-0079: Install the alpha from a prebuilt release package

Status: accepted (2026-10-06).
Supersedes: none
Superseded by: none

## Context

`make install` builds from source and needs Node, npm, Rust and Xcode command line
tools. The owner wants to install from a GitHub pre-release download instead.
Ariadne is more than the app: `scripts/install/install.py` places `Ariadne.app`,
the `ariadne` and `ariadne-mcp` helpers, the integration resources the helper
exports, `install.json` and owned links under `$HOME`.

## Decision

- `make package` builds exactly as `install` does, then writes
  `dist/ariadne-<app version>-macos-<arch>.tar.gz` with one top-level directory
  holding `bundle/macos/Ariadne.app`, `ariadne`, `ariadne-mcp`, `package.json`
  (build facts, `app_version`, `source_sha`, `built_at`), `install.py` and an
  executable `install.sh`. The relative paths are the ones `install()` already
  reads, so `install()` is unchanged. `tar` creates the archive so symlinks and
  permissions in the app survive.
- `install.py install --package <dir>` skips the build and the Node/Rust/Xcode
  preflight, keeps the macOS 13+, arm64/x86_64 and Python 3.11+ checks, requires
  every package file, a parseable `package.json` with the expected keys, an
  `app_version` equal to the app's, and an `architecture` equal to the installing
  Mac's. It calls `install()` with the package directory as read-only input and
  records installing-Mac facts plus a `built` object. The anchored no-follow, lock
  and owned-removal logic is untouched. `make install` and `make uninstall` are
  unchanged.
- `install.sh` checks for `python3` 3.11 or newer with a plain message, then runs
  `install.py install --package "$PWD"`.
- `.github/workflows/release.yml` runs on `v*` tags and manual dispatch on
  `macos-26` with the quality workflow's toolchain, runs `make package`, installs,
  runs `doctor --json` and uninstalls from the extracted tarball under a temporary
  HOME, then creates a GitHub pre-release with `gh`. A manual run without a tag
  keeps the tarball as a workflow artifact only.
- The app version stays 0.1.0; release tags look like `v0.1.0-alpha.1`.

## Consequences

- The owner installs with download, `tar xzf` and `./install.sh`, needing only
  python3 3.11 or newer.
- The app is unsigned in both install paths, so macOS asks for right-click Open on
  first launch, and a managed Mac may block it.
- A package is for one architecture; the other chip needs its own package or a
  source build.
- Each tag build is verified end to end in isolation before it is published.

## Spec references

- [Personal release scope](../planning/PERSONAL_RELEASE.md#prebuilt-alpha-package)
- [Installer notes](../../scripts/install/README.md#prebuilt-package)
- [ADR-0072](ADR-0072-toolchain-minimums-not-pins.md)
