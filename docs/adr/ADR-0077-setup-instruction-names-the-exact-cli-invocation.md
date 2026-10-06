# ADR-0077: The setup instruction names the exact CLI invocation

Status: accepted (2026-10-06).
Supersedes: none
Superseded by: none

## Context

The saved binding-connect instruction told the agent to run bare `ariadne read …`
and `ariadne apply …`. A live Codex run (P7.3, 2026-10-06) showed both assumptions
fail in an agent's tool shell:

- The helper is not on PATH, so `ariadne` was not found.
- The shell does not inherit `ARIADNE_HOME`. With the helper found by absolute
  path, the CLI opened `/Users/<owner>/.ariadne` and failed with `io_error`
  because the app's data root was elsewhere.

The owner had to tell Codex the absolute helper path and an `env ARIADNE_HOME=…`
prefix by hand. No Ariadne mutation happened before the fix.

## Decision

- `VerifiedHost` carries `cli_invocation`. Core's `connect_receipt` writes it in
  place of `ariadne` in the two saved command lines.
- The desktop composes the invocation at startup (`NativeConfiguration`): the
  absolute `--ariadne-helper` path, prefixed with `ARIADNE_HOME=<data root> ` only
  when the data root is not `$HOME/.ariadne`. Values with shell-special
  characters are single-quoted. With no helper path configured it stays `ariadne`.
- `ProviderInstructions` hands the same invocation to the Codex and the Claude
  instruction, since both go through the one connect receipt path. The Claude Mod
  itself is unchanged.
- The shared rules text says `ariadne` stands for the invocation named in the
  setup instruction and must be run verbatim. The 64 KiB instruction bound stays.

## Consequences

- A Codex thread given only the pasted instruction can run `read` and `apply` first
  time, with no PATH or environment setup.
- The saved instruction embeds a machine path, so it is only valid on the machine
  and data root that produced it. It is saved per binding, so a moved helper needs a
  fresh connect.
- The renderer shows the instruction under the project header with a Copy button.

## Spec references

- [Setup and delivery](../planning/low-level/SETUP_AND_DELIVERY.md)
- [ADR-0076](ADR-0076-claude-framed-plugin-prompts-and-turn-correlation.md)
