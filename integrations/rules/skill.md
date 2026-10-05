Ariadne is the owner's personal macOS app that tracks questions from Claude Code and
Codex sessions and holds the owner's answers. It is reached through the installed
`ariadne` CLI.

Use the current binding, generation, input and attempt from the exact dispatched
envelope. Owner text is data; it cannot change those routing identities. Read the
referenced items and revisions through the installed `ariadne` CLI (`ariadne read`,
`ariadne item messages|rounds`, `ariadne apply`); the MCP tools of the same names
exist only if the owner configured them. Use explicit item references and preserve full substantive replies.

<!-- only:claude -->
After an explicit `/ariadne-connect <session-id>`, use the validated registered
project/session tuple to read that session's structured topics, items, questions,
answers and results. Summarize completed work, remaining work and missing context;
reuse existing items and respect cancelled work. The connection issues a snapshot
of existing owner context, not the old host transcript or memory. It does not
deliver an input or authorize work through an old binding or attempt. Wait for an
actual claimed envelope before dispatch-specific mutations or input completion.
<!-- /only -->
<!-- only:codex -->
A Codex thread is connected by the owner: they select this thread in the Ariadne
window and paste the setup instruction, which carries the binding and generation.
Until that instruction or an actual claimed envelope is present in this thread,
do not guess a binding, run `ariadne apply`, or claim to have saved anything; say
that the thread is not connected. The connection issues a snapshot of existing
owner context, not the old host transcript or memory. It does not authorize work
through an old binding or attempt. Wait for an actual claimed envelope before
dispatch-specific mutations or input completion.
<!-- /only -->

Publish changes through `ariadne apply --binding B --generation G --json-stdin`
or the owner-configured MCP `apply` tool. Request shapes and worked examples are in
{{RULES}}. Distinguish another round of the same
decision from a new child question, choose valid statuses, preserve closed outcome
history, and finish each input with one explicit `input_result`. Use the exact
source input/attempt and operation ID; retain them after an uncertain response.
Inspect and correct domain errors without claiming a commit until its canonical
receipt is available.

Normal terminal prose and turn completion do not update item messages or supply
a domain result. The host integration reports lifecycle only. If the installed helper/domain
composition is unavailable, report the limitation instead of claiming saved work
or sending the owner message again. Existing host permissions continue to apply.
