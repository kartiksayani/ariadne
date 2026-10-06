# Ariadne user guide

The full steps for installing, connecting and using Ariadne. For a short
overview, see the [README](../README.md).

Contents:

- [What you get](#what-you-get)
- [Install from a release download](#install-from-a-release-download)
- [Quick start (build from source)](#quick-start-build-from-source)
- [Install in detail](#install-in-detail)
- [First launch (unsigned app)](#first-launch-unsigned-app)
- [Setup and `ariadne doctor`](#setup-and-ariadne-doctor)
- [Connect Claude Code](#connect-claude-code)
- [Connect Codex](#connect-codex)
- [A 60-second tour](#a-60-second-tour)
- [What the agents are told](#what-the-agents-are-told)
- [Recovery](#recovery)
- [Uninstall](#uninstall)
- [Known limits](#known-limits)
- [What Ariadne does not do](#what-ariadne-does-not-do)
- [How it's built](#how-its-built)

## What you get

- **One list of what is waiting on you**, across all your sessions, oldest
  first. A count in the menu bar shows it without opening the window.
- **Answers go to the right session.** Each answer is queued for the session
  that asked and delivered in order. Five messages are five inputs, not a batch.
- **A tree of topics and items.** Each question is an item with its options, the
  agent's replies and its status, so you see what was asked, decided and dropped.
- **A graph view** of the same items, to see how far one question branched.
- **Full history per item**, in rounds, plus a message rail to see which messages
  touched which item.
- **No guessing after a failed delivery.** If Ariadne cannot confirm a message
  arrived, it stops and asks you what to do. It never resends on its own.
- **Local only.** Your data is plain files on your Mac. No account, no cloud, no
  telemetry.

## Install from a release download

Download `ariadne-<version>-macos-<arch>.tar.gz` from the
[Releases page](https://github.com/kartiksayani/ariadne/releases) (the alpha is a
pre-release). It is for Apple Silicon Macs; on an Intel Mac, build from source.
You need macOS 13 or newer and `python3` 3.11 or newer, nothing else. Then:

```sh
tar xzf ariadne-*.tar.gz
cd ariadne-*/
./install.sh
```

`install.sh` does these steps in order:

1. It checks that `python3` is 3.11 or newer, and stops with a message if not.
2. It stops if this version is already installed (the app stays 0.1.0 across
   alphas). Uninstall the existing install first with
   `python3 install.py uninstall`; your project history is kept.
3. It prints "This download is unsigned; removing macOS's download quarantine
   mark from this folder so it can run. Only install packages you trust." and
   clears the quarantine mark from the package folder.
4. It runs `python3 install.py install --package "$PWD"`.

The app is not signed. If macOS still refuses to open it, go to System Settings →
Privacy & Security and choose Open Anyway (see
[First launch](#first-launch-unsigned-app)). A managed company Mac may block an
unsigned app either way. To uninstall, run `python3 install.py uninstall` from the
package folder.

After the install, open `~/Applications/Ariadne.app`, then continue with
[Setup and `ariadne doctor`](#setup-and-ariadne-doctor).

## Quick start (build from source)

You need macOS 13 or newer, Python 3.11 or newer, Xcode command line tools, and
these tools already installed: Node 22.23.2 or newer on the 22 line, 24.15.0 or
newer on the 24 line, or 26 and later; npm 10.9.8 or newer; and Rust 1.98.1 or
newer (through `rustup`, the Rust installer). Ariadne does not install any of
them.

```sh
git clone https://github.com/kartiksayani/ariadne.git
cd ariadne
mkdir -p ~/.local/bin
make install
```

Open `~/Applications/Ariadne.app` (see [First launch](#first-launch-unsigned-app)
if macOS refuses). Then prepare an integration and connect one session:

```sh
~/.local/bin/ariadne setup --agent claude    # or codex, or both
```

Follow [Connect Claude Code](#connect-claude-code) or
[Connect Codex](#connect-codex). To look around first without any agent:

```sh
~/.local/bin/ariadne demo --root /absolute/path/to/an/empty/folder
```

## Install in detail

From the repository folder, run `make install`. If your `python3` is too old,
pick another one:

```sh
make PYTHON=/absolute/path/to/python3 install
```

First, a preflight check prints your macOS version, chip and tool versions. It
stops with a clear message if something is missing. Then it builds the app, the
`ariadne` command and `ariadne-mcp` (an MCP server: a helper agents use to talk
to Ariadne).

It puts everything under `~/.local/share/ariadne/versions/<version>` and points
`current` at it. It puts a real copy of the app at `~/Applications/Ariadne.app`,
so Finder, Spotlight and Launchpad can find it; the command-line helpers stay in
the versioned folder. It adds links at
`~/.local/bin/ariadne` and `~/.local/bin/ariadne-mcp`. It also adds a link at
`~/.agents/skills/ariadne`, the Ariadne skill that Codex reads. It does not edit
your shell startup files. The two `~/.local/bin` links are made only if that
folder already exists, so run `mkdir -p ~/.local/bin` before `make install`. The
skill link is skipped, with a message, if something else already sits at that
path. Move it aside and run `make install` again. Running it again with the same
version changes nothing.

### First launch (unsigned app)

If macOS refuses to open the app:

1. Try to open `~/Applications/Ariadne.app` once.
2. Open System Settings, then Privacy & Security.
3. Scroll down to the message about Ariadne and click **Open Anyway**.
4. Confirm. After that it opens normally.

## Setup and `ariadne doctor`

Setup prepares the Claude and Codex integration files. Run it with the full
path of the installed command. macOS does not look in `~/.local/bin` by
default, so a bare `ariadne` gives "command not found":

```sh
~/.local/bin/ariadne setup --agent claude    # or codex, or both
~/.local/bin/ariadne setup --agent both --project /absolute/path/to/project
```

Optional: to type just `ariadne`, add `~/.local/bin` to your PATH (the list of
folders the terminal searches for commands) in `~/.zshrc`.

`--project` is optional. When you give it, that project is registered too. Setup
never edits Claude Code or Codex settings. It prints the commands you run
yourself in the host. Running setup again is safe.

Setup also records where Claude and Codex live in `~/.ariadne/providers.json`.
It looks for `claude` and `codex` on the PATH of your terminal and prints each path
it recorded. If one is not found, run setup again with `--claude-bin
/absolute/path/to/claude` or `--codex-bin /absolute/path/to/codex`. The app reads
that file when it opens, so quit and reopen Ariadne after running setup.

Check the result at any time:

```sh
~/.local/bin/ariadne doctor
~/.local/bin/ariadne doctor --project /absolute/path/to/project
```

Doctor only reads. It repairs nothing, resends nothing and starts no session.
It uses the paths setup recorded, and warns if none are recorded or a recorded
program has moved. You can point it at specific programs with `--claude-bin` and
`--codex-bin` (absolute paths). Add `--json` for machine-readable output.

## Connect Claude Code

1. Run `~/.local/bin/ariadne setup --agent claude`.
2. In your Claude Code session, run the commands setup prints. They look like:
   - `/plugin marketplace add <path>/claude-mod`
   - `/plugin install ariadne@ariadne-local`
   - `/reload-plugins`
   - `/ariadne-connect`
3. `/ariadne-connect` prints a one-line report of the connection (session,
   project, binding and state). There is nothing to paste: Claude gets the
   Ariadne rules from the Ariadne skill inside the plugin, loaded on demand.
4. To attach a fresh Claude conversation to an Ariadne session you already have,
   use `/ariadne-connect <session-id>`. The new conversation reads the saved
   items and history. It does not receive the old terminal transcript.

Claude Code will ask you to trust the plugin. That choice stays yours.

## Connect Codex

1. Run `~/.local/bin/ariadne setup --agent codex`.
2. In the already-running Codex terminal, run `/status`. It shows the thread you
   will pick in step 4.
3. In Ariadne, open the Projects page and click **Register project**. Type the
   project folder and click **Register project** again. (**Discover host
   sessions** on the Projects page can also list running sessions and fill in
   their project folder.)
4. Open that project and click **Connect existing session**. The dialog lists
   the Codex threads that are loaded and fills in the socket path from your
   Codex home. Each entry shows a thread's title or its ID. Click **Use host
   session** on the entry, then match the thread ID from `/status` against the **External session ID** field,
   which fills in when a candidate is picked. Click **Connect existing
   session** again. A fresh thread works: it does not need a first message.
5. Under the project header, a **Session connected** card shows the setup
   instruction and a **Copy instruction** button. It lists only the
   capabilities that are unavailable. Click **Copy instruction** and paste it
   into that Codex thread, once per thread. Connecting sends nothing to the
   model, so the agent gets the Ariadne rules only from this paste.

The instruction names the exact command to run: the full path of the `ariadne`
helper, with an `ARIADNE_HOME=` prefix only when your data folder is not
`~/.ariadne`. That is why the paste works in Codex's shell without any PATH
setup.

Codex has no command inside the thread to connect, so connecting is always done
from the app. Codex approvals stay yours. Ariadne does not turn them on or off.

## A 60-second tour

- **Waiting panel.** Every question waiting on you, across sessions. Click one to
  open it. Inside an item, click **Later** to push it aside.
- **Tree and Graph.** Switch between them with the two buttons in the top bar.
  The tree is a list of items. The graph is the same items drawn as a map; use
  the `+` and `-` buttons to zoom.
- **Item detail.** Shows the question, its options and the full replies. Type
  your answer in your own words or pick an option, then send. Ariadne saves your
  answer at once. The agent replies on the item and the history is kept.
- **Message rail.** The side column with the conversation history. Toggle it from
  the top bar.
- **Search box** in the top bar filters items. The sun/moon button cycles the
  theme (system, light, dark).
- **Menu-bar icon.** Shows how many questions wait on you and lists the oldest.
  Clicking one opens it. Ariadne can also send a macOS notification when an
  agent asks something.
- **Connection controls.** Pause or resume sending to a session, or disconnect
  it. (The app calls a session's connection a "binding".)

Quitting Ariadne does not stop Claude Code or Codex sessions. Your saved data
stays readable by the command-line tool and the MCP server while the app is
closed.

## What the agents are told

Connecting a session sends nothing to the model. Codex agents get the rules from
the setup instruction you paste into the thread, and from the Ariadne skill the
installer links. Claude Code agents get them from the skill inside the plugin.
In one paragraph: record
findings as structured items through `ariadne apply`, write full replies on the
item rather than only in the terminal, choose item statuses deliberately, and
finish every input Ariadne sends them with exactly one explicit result. Agents
must never guess which session they belong to, and never repeat work because a
result was missing. The full text is in [integrations/rules](../integrations/rules/):
[claude.md](../integrations/rules/claude.md) and [codex.md](../integrations/rules/codex.md).
They are generated from [source.md](../integrations/rules/source.md); do not edit
the generated files.

## Recovery

Ariadne never resends something on its own. If a message cannot be confirmed, it
stops and asks you. Look for **Delivery needs attention** and click **Review
recovery**. Pick from **Recovery choice**, type a reason, then click **Save
recovery decision**.

| State you see | What it means | What you can choose |
|---|---|---|
| Delivery uncertain | Ariadne sent your message but never got a confirmation. It may or may not have arrived. | Look at the terminal. If the message ran, choose **Confirm evidence**. If not, choose **Prepare resend** (may repeat work, so you must tick a warning) or **Skip and continue**. |
| `needs_attention` (sent but rejected) | The agent refused the message, so it never ran. | **Prepare retry** (offered only here), **Prepare resend**, **Skip and continue** or **Confirm evidence**. |
| Missing result | The agent finished its turn but did not record the required result. | **Request missing result** (asks only for the result), **Prepare resend**, **Skip and continue** or **Confirm evidence**. |

Every choice needs a short reason and is saved in the history. Before choosing,
make sure the terminal is idle. If the agent does not record a result soon after
finishing, Ariadne marks the result missing by itself. The check runs while the
app is open. Sending to that session stays paused until you decide. Resuming
sending is a separate click.

## Uninstall

```sh
~/.local/bin/ariadne uninstall --agent both    # removes only the integration files setup wrote
make uninstall                    # removes the installed app and command-line tools
```

Removed: the files Ariadne installed itself, the app at `~/Applications/Ariadne.app`,
and the links `~/.local/bin/ariadne`, `~/.local/bin/ariadne-mcp`
and `~/.agents/skills/ariadne` (the last only if the installer created it).
Only unchanged files that Ariadne owns are removed. If you edited the app, it is
left in place with a message. Anything you edited or
anything that is not Ariadne's is left in place and listed.

Kept: all project history, sessions and backups, and every Claude Code and Codex
setting. Remove the Ariadne plugin from Claude Code yourself if you want it gone.
A small lock file under `~/.local/share/ariadne` can remain.

## Known limits

- Claude Code and Codex only. There is no plugin system for further agents yet.
- After `ariadne setup` (or after moving Claude or Codex), quit and reopen the
  app. It reads the recorded program paths only when it starts.
- Codex: you paste the setup instruction once per thread. Ariadne cannot yet
  send it for you.
- Codex: a thread with no messages yet may not appear in the connect dialog's
  list. Click the dialog's own **Refresh host sessions** button and look again. As a fallback,
  type the thread ID from `/status` into the **External session ID** field by
  hand.
- No automatic repair for corrupted data, full disks or power loss.
- Speed targets are recorded, not guaranteed.
- Everything under [Status](../README.md#status) also applies.

## What Ariadne does not do

Checked in the app configuration and source:

- No remote assets. The window only loads its own bundled files.
- No telemetry and no automatic updater. Neither is configured in the app.
- It does not read host transcripts and does not handle your Claude or Codex
  credentials.
- It does not listen on the network. Parts of Ariadne talk to each other through
  a private local socket.

## How it's built

A Rust core, the `ariadne` command-line tool and the `ariadne-mcp` server share
one saved store of plain JSON files on disk. The window is a Tauri 2 app (a
desktop shell around a web view) with a React interface.

Design notes: [docs/planning](planning/README.md).
