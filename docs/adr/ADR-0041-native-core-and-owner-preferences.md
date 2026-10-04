# ADR-0041: Compose native Core and persist owner preferences

Status: accepted for this implementation.

## Context

The real query, binding, input, apply and delivery services are merged, but native
entrypoints still need a concrete `CoreService`. Navigation and unsent drafts use
canonical preferences DTOs without an authoritative preferences writer.

## Decision

`NativeCoreService` delegates the existing synchronous methods to those actual
services. Its native dependencies supply bounded local UUID/time callbacks and a
trusted read-only host verifier. BindingService retains replay before preflight,
qualification outside every storage lock, and the locked replay recheck. The
delegate creates no provider connection, lease, inferred route or placeholder ID.
Later history/recovery commands remain explicitly Unsupported.

The Registry's verified owner data directory contains fixed `ui.json`, sibling
`ui.lock` and `ui.previous.json`. Store exposes only the fixed-file locked bytes
and atomic publisher, reusing its existing anchored/no-follow IO, keyed mutex,
bounded flock, private modes, exclusive temporary files and directory fsync.
Core owns strict typed preferences parsing and validation. There is no Store to
Core dependency or general storage framework.

The private record contains the canonical `PreferencesSnapshot` and ordered
owner-scoped operation/digest/exact `PreferencesPatchedReceipt` records. The
snapshot's schema_version is the sole schema authority; existing malformed,
future or incomplete records are never default-filled or overwritten. Receipt
IDs/scopes/revisions and uniqueness agree with the full retained commit history.

Absence reads as revision1: System, Projects navigation, no window, pin or
watermark, and empty session views, Later and drafts. Reading may create only the
stable lock. A first patch expects1 and commits revision2 with its receipt;
subsequent new valid patches increment exactly once, including empty patches.
The digest binds owner, command discriminant and complete typed parameters,
including expected revision and exact text; operation ID selects the receipt.
Exact replay returns the original receipt before revision guards without writes.
Changed same-operation parameters return OperationReused.

First publication is atomic no-clobber. Replacements first preserve the validated
previous record in the private backup, then atomically rename and fsync the
directory. Definite prepublication failures remain ordinary typed errors;
postpublication uncertainty retains the original operation ID for replay.

The actual canonical framed preference response must fit the existing 1MiB
response budget; each patch/draft retains existing canonical request/text bounds.
A patch cannot save a response that cannot be read. There is no invented ui.json
hard quota: receipt history remains complete, without pruning, TTL or compaction.

## Consequences and remaining joins

Preferences are global local-owner data. Agent queries never expose them. Draft
persistence and restart never dispatch Inputs. Unrelated patches preserve stale
or unavailable session routes, view state and exact draft contents; submission
owns current domain/binding/question checks.

Corrupt/future files remain untouched with a bounded path-specific error. Explicit
owner backup/reset recovery is still a Settings/native acceptance item. Runtime
lease/context construction, provider qualification, executable bridge report
after desktop exit, five-second scheduler, desktop watchers/hints and native E2E
are consuming joins, not claimed by this backend implementation.

See [preferences API](../planning/low-level/API_AND_MCP.md),
[storage](../planning/low-level/DOMAIN_AND_STORAGE.md) and
[native UI](../planning/low-level/UI_AND_NATIVE.md).
