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
The owned Applications and optional existing PATH-directory links go through
`current`. No shell startup or host configuration files are edited. After
publication the installed helper runs read-only doctor; unknown provider status
still requires explicit host qualification/setup. Installation alone does not
register, trust or load the Mod in an existing terminal.

Repeat install preserves identical version bytes. An edited/foreign package or
install target causes refusal. Uninstall removes only unchanged owned inventory;
an edited/missing helper prevents ownership validation and preserves the entire
package. Foreign files, edited resources, project history and backups survive.
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
The tag-triggered release workflow builds the package, installs and uninstalls it
under a temporary HOME, and attaches it to a GitHub pre-release.

`npm run test:install` uses temporary homes and scripted artifacts. Release CI
separately reuses the real production bundle and release helpers for the
temporary-home installed-artifact check; it does not install in the owner's home.
