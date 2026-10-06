# ADR-0080: Install the app bundle as a real copy in ~/Applications

Status: accepted (2026-10-07).
Supersedes: the `~/Applications/Ariadne.app` symlink sentence of ADR-0062
Superseded by: none

## Context

`install.py` installed the app at `~/.local/share/ariadne/versions/<v>/Ariadne.app`
and made `~/Applications/Ariadne.app` a relative symlink through `current`
(ADR-0062). Finder, Spotlight and Launchpad ignore a symlink into a hidden folder,
so the owner could not find the installed app. The owner found this on 2026-10-07
with `v0.1.0-alpha.1`. The CLI only needs the receipt's `app_path` to canonicalize
to a directory, so it works with either layout.

## Decision

- `~/Applications/Ariadne.app` is a real copy of the bundle, owned by the
  installer. The versioned package keeps its canonical `versions/<v>/Ariadne.app`,
  `bin/` and `integrations/`, and `current` flips as before. The `.local/bin/*`
  and Codex skill links stay symlinks.
- After the version is published and `current` points at it, install copies the
  versioned bundle to `~/Applications/.Ariadne.app.stage-<uuid>`, renames an
  existing owned copy to `.Ariadne.app.old-<uuid>`, renames the stage into place
  and removes the old one. `~/Applications` is created with mode 0700 when absent.
  Removals use the anchored no-follow helpers; a failure removes the stage and
  restores the old copy.
- Ownership is proved, never assumed. An existing `~/Applications/Ariadne.app` is
  replaced only when it is (a) the old relative symlink and a receipt records it in
  `owned_links`, or (b) a real directory whose inventory (file SHA-256 and modes,
  contained symlinks) equals the `Ariadne.app/` subset of a valid receipt of any
  installed version. Anything else is refused with "Foreign or edited install
  path". Receipts of every installed version count, so a retry after an
  interrupted upgrade still recognises the older copy.
- Receipts move to `inventory_version` 2, which adds `owned_app` (boolean) and no
  longer lists the app link. Version 1 receipts are still accepted, including their
  app symlink, so the old layout uninstalls and migrates. A version 1 receipt has
  no `owned_app`, so the matching bytes are its proof.
- Uninstall removes the copy only when its bytes still match a receipt. If a
  receipt owns it and the bytes differ, it is left in place with one plain message.
- A same-version reinstall still compares the versioned tree and refuses a
  different package. The app copy follows it; an identical copy is kept.

## Consequences

- The app exists twice on disk, about 30 MB each.
- Upgrade swaps the copy after the `current` flip. A crash between the two leaves
  the old copy; `doctor` and `ariadne open` still canonicalize `app_path` and work.
- Same-version reinstall over the symlink layout migrates cleanly and keeps the
  version 1 receipt, since the versioned tree is unchanged.
- An owner who edits or re-signs the copy keeps it through uninstall.

## Not verified

- Launchpad's indexing delay after install or upgrade.

## Spec references

- [ADR-0062](ADR-0062-publish-contained-personal-packages.md)
- [Installer notes](../../scripts/install/README.md)
