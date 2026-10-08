# ADR-0087: Supervisors retry, publish health and write a log

Status: accepted
Supersedes: none (amends one rule of ADR-0032)
Superseded by: none

## Context

In the owner's live test, answers to a Codex session stayed at "Sending" with no
delivery attempt and nothing said why. Under
[ADR-0032](ADR-0032-binding-supervisors-and-volatile-checkpoints.md), a binding
supervisor ended on its first failure that was not a Core barrier. For example,
Codex reporting the thread as not loaded ended it. The task then stayed dead
until the app restarted. Nothing was logged, and the UI had no way to show it.

## Decision

This ADR amends ADR-0032's sentence "On receipt failure upstream stops…". The
supervisor still never acknowledges a checkpoint past an unsaved fact and never
resends. It now keeps going after a failure:

- **Retry.** A failed scheduling pass is logged and retried. The delay starts at
  1 s and doubles up to 30 s. Each retry first flushes the retained facts with
  their original event IDs, and repeats a possibly saved claim with its original
  request ID. A preparation stranded mid-pass becomes its terminal fact
  (uncertain if submission may have started, rejected otherwise). Reconciliation
  never moves the observation checkpoint.
- **Stop only when the scope ended.** The supervisor ends only for a stale or
  replaced generation, a binding mismatch, conflict or ambiguity, not-found, or
  the disconnected barrier, and on a lost connected receipt. If a stop request
  interrupts a retry, the exit hands back that unresolved cause.
- **Re-check earlier attempts.** History may not settle earlier attempts yet.
  The gate then stays closed: Core's FIFO already refuses every claim on that
  binding while those inputs are in flight or need attention. The re-check
  backs off from 1 s to 30 s, and the log names the inputs and attempts it waits on.
- **Health.** Only push bindings (Codex) publish health entries:
  `{binding_id, generation, state: running|backing_off|stopped, reason,
  retry_in_seconds, updated_at}`. Each `reason` is a plain-words sentence for
  the owner. The desktop emits each change as `ariadne://supervisor_health` and
  serves the latest entries through the `supervisor_health` command. When a
  supervisor stops on request, its entry is dropped. Pull bindings (Claude
  Code, delivered by its Mod) never publish.
- **Health file.** The desktop mirrors the entries to
  `$ARIADNE_HOME/logs/supervisor-health.json` (mode 0600). It rewrites the file
  on every change and every 15 s. `ariadne doctor` reads it, and a file older
  than 60 s means the app is not running.
- **Log.** `$ARIADNE_HOME/logs/ariadne.log` caps each file at 1 MiB and keeps
  three rotated files (directory 0700, files 0600). It records supervisor and
  delivery steps by ID, state and error code only. Message bodies, output text,
  provider reasons and credentials never go in it.

## Consequences

A transient failure (store busy, Codex restarting, thread not loaded) no longer
needs an app restart: delivery resumes by itself, and the owner sees why it
paused. A permanent fault retries every 30 s at most. Each retry is read-only or
idempotent, so this costs little and never sends twice. The supervisor tests now
assert retry, health and stop-on-scope-end behaviour, not exit on the first
failure.

## Spec references

- [ADR-0032: binding supervisors](ADR-0032-binding-supervisors-and-volatile-checkpoints.md)
- [PROCESS: ownership and control](../planning/low-level/PROCESS_AND_PROTOCOLS.md#1-ownership-leases-and-app-control)
