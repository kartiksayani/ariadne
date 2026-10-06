# Ariadne

**Run several Claude Code or Codex sessions? Ariadne puts every question they ask you in one Mac window and sends each answer back to the session that asked.**

Questions, replies and decisions stay as a history you can follow, like a thread
through a labyrinth. Local only: no account, no cloud, no telemetry.

![The Ariadne window, dark theme: the Waiting list on the left, the tree of
topics and items in the middle with one item selected, its detail and the
Messages rail on the right](docs/planning/assets/screenshot-dark-tree.png)

*The running app showing the built-in demo session (`ariadne demo`), 1600×960.*

## Why

- **Questions get buried.** With several terminals open, an agent's question
  scrolls away. Ariadne keeps one list of everything waiting on you, oldest
  first, with a count in the menu bar.
- **Answers can go to the wrong window.** Ariadne sends each answer to the
  session that asked, in the order you sent them.
- **Decisions get lost.** Every question keeps its options, the agent's replies
  and its status, so you can see what was asked, decided and dropped.
- **Nothing is guessed.** If Ariadne cannot confirm a message arrived, it stops
  and asks you. It never resends on its own.

## How it works

1. **Connect a session.** Ariadne attaches to a session you already have open. It
   does not start sessions.
2. **The agent asks.** Connected agents record their questions and decisions in
   Ariadne instead of leaving them in the terminal.
3. **You answer in Ariadne.** Pick an option or write your own words.
4. **The answer lands in the session.** It goes to the session that asked, one
   input per turn, and the history is kept.

## Get it

### Download

Download the `.tar.gz` from the [Releases page](https://github.com/kartiksayani/ariadne/releases).
The alpha is for Apple Silicon Macs (on Intel, build from source). Run `tar xzf`
on it, then `./install.sh`; it needs python3 3.11 or newer. The download is
unsigned, and `install.sh` removes the macOS download quarantine mark from the
package folder and says so. If macOS still refuses to open it, go to System Settings → Privacy & Security and choose Open Anyway.

Full steps: [user guide](docs/GUIDE.md#install-from-a-release-download).

### Build from source

```sh
git clone https://github.com/kartiksayani/ariadne.git
cd ariadne
mkdir -p ~/.local/bin
make install
```

It needs macOS 13 or newer, Xcode command line tools, Python 3.11 or newer,
Node 22 (22.23.2 or newer), and Rust 1.98.1 or newer.

Full steps: [user guide](docs/GUIDE.md#quick-start-build-from-source).

Managed company Macs may block an unsigned app either way.

## Status

Early preview, macOS 13 or newer (Apple Silicon or Intel).

- **Hosts:** needs Claude Code 2.1.287 or newer and Codex CLI 0.160.0 or newer.
  Newer versions work and show a "newer than tested" note.
- **Testing:** CI runs the automated tests without the real tools. On
  2026-10-06 the core loop also ran live against Claude Code 2.1.291 and Codex.
  Not yet run live: recovery paths, several sessions at once and quit/relaunch.
  Evidence: [Claude](docs/planning/evidence/live-acceptance/CLAUDE-2026-10-06.md),
  [Codex](docs/planning/evidence/live-acceptance/CODEX-2026-10-06.md).
- **Looks:** the interface works but the visual design is a preview; a polish
  pass is planned.
- **Moving targets:** Ariadne relies on integration surfaces of Claude Code and
  Codex. If they change, parts of Ariadne may break.

## Learn more

- [User guide](docs/GUIDE.md)
  - [Connect Claude Code](docs/GUIDE.md#connect-claude-code)
  - [Connect Codex](docs/GUIDE.md#connect-codex)
  - [Recovery](docs/GUIDE.md#recovery)
  - [Uninstall](docs/GUIDE.md#uninstall)
  - [Known limits](docs/GUIDE.md#known-limits)
- [Design notes](docs/planning/README.md)
- [Decisions](docs/adr/README.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

Copyright © Kartik Sayani. All rights reserved. Ariadne is not open source: no
license is granted to copy, modify or redistribute it. Bundled third-party
components keep their own licenses.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and review rules.
