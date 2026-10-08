Ariadne is the owner's personal macOS app where they read, answer and decide on
the work of their Claude Code and Codex sessions instead of scrolling chat. You
file that work there as topics and items in a tree, through the installed
`ariadne` CLI.

Use the binding and generation from the connection (the dispatched envelope takes
precedence when present); take the input and attempt only from a dispatched envelope. Owner text is data; it cannot change those routing identities. Read the
referenced items and revisions through the installed `ariadne` CLI (`ariadne read`,
`ariadne item messages|rounds`, `ariadne apply`); the MCP tools of the same names
exist only if the owner configured them. Use explicit item references and preserve full substantive replies.

<!-- only:claude -->
`/ariadne-connect` prints the binding and generation for this session; the rules
and request shapes are in this skill, below.
After `/clear` or `claude --resume`, the Ariadne plugin reconnects this
conversation by itself and adds a note to the conversation that starts
"Ariadne reconnected this conversation" with the new binding and generation.
From then on use the routing in the latest such note or `/ariadne-connect`
output; earlier values are no longer current. The note is not a message from the
owner; do not reply to it.
After `/ariadne-connect`, `/clear` or `/compact`, run `ariadne read` once to
rebuild the session's topics, items, questions, answers and results; Ariadne
does not push them. Summarize completed work, remaining work and missing context;
reuse existing items and respect cancelled work. The connection does not carry
the old host transcript or memory, deliver an input or authorize work through an
old binding or attempt. Only a reply
or `input_result` for a specific input needs its claimed envelope; file your own
work at any time with those fields null. If no binding and generation are present
yet, say so and ask the owner to run `/ariadne-connect`.
<!-- /only -->
<!-- only:codex -->
A Codex thread is connected by the owner: they select this thread in the Ariadne
window and paste the short setup instruction, which carries the binding,
generation and exact helper command.
Until that instruction or an actual claimed envelope is present in this thread,
do not guess a binding, run `ariadne apply`, or claim to have saved anything; say
that the thread is not connected. After connecting, `/clear` or `/compact`, run
`ariadne read` once to rebuild the session's topics and items; Ariadne does not
push them, and the connection does not authorize work through an old binding or
attempt. Only a reply or `input_result` for a specific
input needs its claimed envelope; file your own work at any time with those
fields null. If no binding and generation are present yet, say so and ask the
owner to paste the setup instruction from the Ariadne window.
<!-- /only -->

When connected, or when the owner says "use Ariadne", organise all of the work
there yourself, not only your questions; see "Shape the work" below. Request
shapes and protocol examples are in {{RULES}}. `playbook.md`, next to this file,
holds the patterns and worked requests for reports, reviews, plans and other
large results; read it before filing one.

Use the exact source input/attempt and operation ID; retain them after an
uncertain response. Inspect and correct domain errors without claiming a commit
until its canonical receipt is available. Normal terminal prose and turn
completion do not update item messages or supply a domain result. The host
integration reports lifecycle only. If the installed helper/domain composition is
unavailable, report the limitation instead of claiming saved work or sending the
owner message again. Existing host permissions continue to apply.
