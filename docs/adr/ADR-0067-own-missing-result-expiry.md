# ADR-0067: Own missing-result expiry in the desktop

Status: Accepted by the maintainer, 2026-10-05.

The Core timeout transition existed, but no production scheduler called it.
Completed turns without an explicit result could remain pending indefinitely.
Reusing adapter authorization for the timer would also require fabricated host
proof for a retained attempt from an older generation.

The desktop owns an off-UI expiry timer and drains admitted work at shutdown.
Use registered change hints and retained candidates instead of repeatedly reading
every session. Startup reconciliation discovers retained completed attempts.

A narrow native-only Core entrypoint applies the existing idempotent timeout
transaction using saved, previously authorized completion facts. It checks the
registered session, still-selected binding, scheduler's current generation and
exact input/attempt membership under the transaction lock. An older originating
attempt generation does not require a new host fact for this clock transition.
The five-second grace, result/seal/error guards, receipts and dispatch barrier
remain authoritative in Core. A late result retains its existing join semantics.

This grants no provider-report, agent-write, resend or owner-attestation authority;
those authorization paths remain unchanged. The public CoreService and wire
contracts remain unchanged. Tests must prove automatic expiry, late-result and
generation races, and shutdown ownership without calling expiry manually to
stand in for the scheduler.
