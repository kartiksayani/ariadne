# ADR-0074: Keep the Claude Mod inside Claude Code's static module validator

Status: accepted (2026-10-06).
Supersedes: none
Superseded by: none

## Context

Claude Code 2.1.291 statically validates a plugin module before it runs it. The
P7.1 proof used 2.1.287, which was lenient. In the live P7.2 run on 2026-10-06 the
2.1.291 validator rejected `integrations/claude/plugin/hooks/register.js`, skipped
the whole module silently, and `/ariadne-connect` was "Unknown command".
`claude plugin validate integrations/claude/plugin` reproduces the rejection.

The rules it enforced, one error at a time:

- `register` must be exported as a `const` bound to a function.
- `$.plugin` is used only as `$.plugin.name` or `$.plugin.root` (no `?.`, no whole object).
- `$` is spelled `$.noun.event(...)` at every call site. It is never bound, passed,
  spread, returned or read, except into a function declared at the top level of the
  same file. It is never followed across an import.
- `on` is always `on("<event>", hook)` (with an optional filter object), and `next.to`
  is always `next.to(e, "<tier>")`.

## Decision

- `hooks/register.js` exports `register` as `export const register = on =>
  registerModule(installed, on)`. `createRegister(descriptor)` stays exported for
  tests as `on => registerModule(descriptor, on)`.
- Module state lives in one `state` object created in the top-level
  `registerModule`. Former inner functions are top-level declarations taking
  `(state, $, ...)`.
- Code in other files (`claims.js`, `setup.js`, `discovery.js`) never receives the
  real `$`. `register.js` builds a facade with `host($)` whose members are written
  as `$.session.id()`, `$.process.run(...)`, `$.prompt.submit(...)`, `$.ui.log(...)`
  and a lazy `plugin` getter returning `{name, root}`. Those files keep their
  behaviour and their `$`-named parameters unchanged.
- `claude plugin validate integrations/claude/plugin` is a required check for any
  change under `integrations/claude/plugin/`. `scripts/check-commit.py` runs it when
  `claude` is on PATH (always on the full run) and skips it otherwise. Validate the
  installed form as well, with `installed.js` replaced by a frozen descriptor.

## Consequences

- Behaviour is unchanged: same hooks, handlers, messages, helper calls and timers.
- New Mod code must follow the rules above; the validator names the offending line.
- The host facade is the only place the real `$` is touched, so the next SDK rule
  change has one place to fix.
- The check cannot run where `claude` is not installed; CI without it relies on the
  manual run before release.
