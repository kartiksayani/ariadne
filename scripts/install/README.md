# Personal source installation

Use the toolchains pinned in CONTRIBUTING (Python 3.11 or newer). On macOS 13+
with arm64 or x86_64 and selected Xcode command line tools:

```sh
make install
make uninstall
```

If the system `python3` is older, choose an existing supported interpreter with
`make PYTHON=/absolute/path/to/python3 install`. The preflight reports the OS,
architecture and selected tool versions before building; it does not install
toolchains or providers. Builds use the repository lockfiles, check generated
contracts/rules, and use ordinary release features.
Rustup preflight selects only an already installed pin, and build children have
automatic toolchain installation disabled. Missing Rust components require
explicit setup before retrying.

The app, CLI, MCP and canonical Mod/rules live together in a version directory.
The app is also a real, installer-owned copy of the bundle at
`~/Applications/Ariadne.app`, so Finder, Spotlight and Launchpad find it (a
symlink into a hidden folder is invisible to them; ADR-0080). The versioned
package stays canonical and holds the helpers. Install swaps the copy after the
`current` pointer flips and replaces an existing one only when its bytes match a
receipt (or it is the old symlink layout), otherwise it refuses; uninstall
removes the copy only when unedited. The optional existing PATH-directory links
and the Codex skill link go through `current`. No shell startup or host configuration files are edited. After
publication the installed helper runs read-only doctor; unknown provider status
still requires explicit host qualification/setup. Installation alone does not
register, trust or load the Mod in an existing terminal.

Repeat install preserves identical version bytes. An edited/foreign package or
install target causes refusal. Uninstall removes only unchanged owned inventory;
an edited/missing helper prevents ownership validation and preserves the entire
package. Foreign files, edited resources, project history and backups survive
(history lives under `~/.ariadne/projects/`, not in project folders).
The stable installation coordination lock can remain after uninstall.

## Prebuilt package

`make package` runs the same preflight and build as `make install`, then writes
`dist/ariadne-<app version>-macos-<arch>.tar.gz`. Its single top-level directory
`ariadne-<app version>/` holds:

| Path | Content |
|---|---|
| `bundle/macos/Ariadne.app` | the built app, symlinks and permissions kept |
| `ariadne`, `ariadne-mcp` | the release helpers |
| `package.json` | build machine facts, `app_version`, `source_sha`, `built_at` (UTC) |
| `install.py` | a copy of this installer |
| `install.sh` | checks `python3` is 3.11 or newer, then runs `install.py install --package "$PWD"` |

`install.py install --package <dir>` installs from that directory without
building. It keeps the macOS 13+, arm64/x86_64 and Python 3.11+ checks and skips
the Node, Rust and Xcode checks. It refuses a directory with a missing file, an
unreadable or malformed `package.json`, an `app_version` that differs from the
app, or an `architecture` that differs from this Mac. It then calls the same
`install()` with the package directory as read-only input and records the
installing Mac's facts plus the package's `built` facts in `install.json`.
Uninstall is unchanged: `python3 install.py uninstall` from the package directory.
If `~/.local/share/ariadne/versions/<app version>` already exists (the app stays
0.1.0 across alphas), `install.py` prints "Replacing the Ariadne 0.1.0 already
installed (your projects and history are kept).", runs the owned-only uninstall,
then installs. A partial install (for example `bin/` and the app gone) counts: uninstall
treats anything the receipt owns that is already missing as removed, and only skips the
integration-inventory cross-check when the helper itself is gone. Edited or foreign files
are retained; if one blocks the replacement, the install stops with one sentence naming
the folder to move aside. Quit the desktop app and agent sessions before upgrading
from alpha.2 or earlier: the first open migrates each project's store out of the
repo and parks the old copy at `~/.ariadne/projects/<id>.legacy-<ts>` for you to
delete. If `xattr` exists it then prints "This download is
unsigned; removing macOS's download quarantine mark from this folder so it can
run. Only install packages you trust." and runs `xattr -dr com.apple.quarantine`
on the package folder, because `tar` copies the browser's quarantine mark onto
every file and Gatekeeper would block the unsigned `ariadne`. The release
workflow refuses a tag that does not start with `v` plus the app version, does not
publish on manual dispatch, and will not overwrite an existing release.
The tag-triggered release workflow builds the package, installs and uninstalls it
under a temporary HOME, and attaches it to a GitHub pre-release.

`npm run test:install` uses temporary homes and scripted artifacts. Release CI
separately reuses the real production bundle and release helpers for the
temporary-home installed-artifact check; it does not install in the owner's home.
