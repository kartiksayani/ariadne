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

`npm run test:install` uses temporary homes and scripted artifacts. Release CI
separately reuses the real production bundle and release helpers for the
temporary-home installed-artifact check; it does not install in the owner's home.
