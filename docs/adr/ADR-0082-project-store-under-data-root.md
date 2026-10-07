# ADR-0082: Project store lives under the data root

Status: accepted (2026-10-07).
Supersedes: the `<project>/.ariadne/` layout of the storage specification
Superseded by: none

## Context

The per-project store lived in `<project>/.ariadne/`. Three problems followed.
The app's file watchers saw every session write inside the owner's working tree,
so the project's own tooling (editors, dev servers, `git status`) reacted to
Ariadne's writes. The folder relied on the owner's `.gitignore` to stay out of
version control, and one missed ignore committed session history. Syncing or
copying the project folder (cloud drives, backups, worktrees) also copied or
raced the store, including locks that must never be copied. The data root
(`$ARIADNE_HOME`, default `~/.ariadne`) already holds the registry, the binding
index and UI state, so the project store belongs beside them.

## Decision

- The store is `<data root>/projects/<project-uuid>/` with `project.json`,
  `project.lock`, `sessions/`, `locks/` and `backups/`. `projects.json`,
  `bindings.json`, `ui.json` and `run/` stay where they are. Nothing is created
  under the project's canonical root.
- Every site derives the directory from the data root and the project id
  (`Registry::project_dir`). The owner-only modes, `O_NOFOLLOW` opens and
  directory-relative IO are unchanged; the store directory itself is opened with
  no-follow and must not be a symlink.
- The registry maps a canonical root to a project id. The root must still exist
  and be a real directory for the project to be available.
- Migration is automatic and runs inside the store when a project is registered,
  resolved or listed (CLI, MCP and desktop all go through it). The trigger is a
  legacy `<root>/.ariadne/project.json` carrying the registered id while
  `projects/<id>/` does not exist.
  1. Copy `project.json`, `sessions/` and `backups/` into a staging directory
     `projects/.<id>.migrating`. Locks are recreated, never copied.
  2. Verify every file byte-for-byte against the legacy source.
  3. Rename the staging directory to `projects/<id>`, re-list the legacy
     directory and compare its file set and bytes again, then park the legacy
     directory by renaming it to `projects/<id>.legacy-<unix-ts>` (a sibling of
     the new store, outside the user's repo). The owner deletes the parked copy.
- Ariadne never deletes the legacy store. If the final rename fails (for example
  across devices), the legacy directory stays where it was and doctor reports it.
- Migration holds the legacy `project.lock` and every `locks/*.lock` the old
  build used, non-blocking, from before planning until the legacy directory is
  parked. If any is held by a running process, migration aborts with an error
  naming the lock and changes nothing. Quit the desktop app and agent sessions
  before upgrading from alpha.2 or earlier.
- A failure at any step leaves the legacy directory untouched, removes the
  staging directory and reports an error naming both paths. If the legacy files
  changed after planning, migration aborts, removes nothing and leaves the new
  store in place. A retry starts from the legacy directory, so migration is
  idempotent.
- If both exist, the new location wins and the legacy directory is not touched.
  The open fails with an error telling the owner to compare the two, unless the
  legacy files are byte-identical to the new store (an interrupted move), in
  which case the legacy copy is re-verified and parked as above.
- `ariadne doctor` reports the new path in `project.identity` and adds
  `store.legacy` warnings: "unmigrated store at <path>" when a registered project
  still has a legacy directory, and "parked copy at <path>, safe to delete" for
  each `projects/<id>.legacy-*` directory. Doctor never migrates.
- Anything that lists `projects/` must ignore `*.legacy-*` and `.<id>.migrating`
  entries; the store itself addresses only `projects/<id>`.

## Consequences

- Session history no longer travels with the project folder. Moving or cloning
  the folder does not move its history; the registry maps the root to the id, so
  re-registering a moved root needs the original id's store, which stays under
  the data root. Backing up history means backing up the data root.
- The project folder is untouched by Ariadne, so watcher noise and accidental
  commits of session data stop.
- A legacy store in a project that was never registered on this machine is not
  migrated, since no registered id proves it belongs here.
- Both-present is a hard stop that needs the owner. This is deliberate: choosing
  automatically could discard the only copy of newer history.

## Spec references

- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [Setup and delivery](../planning/low-level/SETUP_AND_DELIVERY.md)
