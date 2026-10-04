# ADR-0055: Route explicit owner commands through native Core

Status: Accepted

## Decision

The installed owner CLI uses the existing NativeCoreService, Registry and Store
for owner history, lifecycle and recovery commands. Canonical wrappers, explicit
registered membership, locked replay and receipts remain unchanged. Saved connect
replay and operation conflicts precede desktop access; only a new connect uses the
existing private binding_connect relay with the original wrapper and operation ID.
The desktop still owns provider qualification. No provider is launched by setup.

The canonical continuation preview wrapper keeps session:null. A trusted Registry
owner resolves its explicit params.target through registered membership and passes
that matching Session owner to HistoryActionService. An existing Session owner is
never retargeted, and an agent remains denied. Preview performs no mutation or
provider IO.

Only validated explicit project-register and demo setup may initialize a missing
private data-directory final component beneath an existing trusted parent. The
existing anchored no-follow Directory helper checks ownership and permissions;
existing files, links and foreign permissions are rejected without repair or
clobber. Ordinary reads open existing data only. Custom ARIADNE_HOME identifies
that data directory directly, without an extra .ariadne nesting.

## Consequences

These joins add no wire DTO, general owner transport or permission expansion.
Default recovery observation remains Unknown and requires current-request owner
attestation where prescribed. Commands retain owner pause and never dispatch work.
Actual packaged/native and qualified runtime acceptance remain separate evidence.
