# Ariadne shared agent rules

Use plain sentences. Ariadne holds structured topics, items, questions, full
replies, decisions and retained history; ordinary terminal prose does not update
that state. Read bounded canonical projections using the explicit binding and
generation supplied by setup or the dispatched input. Never infer a session from
cwd, filenames, a previous conversation or a foreign item reference.

Publish substantive findings through `ariadne apply --binding B --generation G
--json-stdin` with one complete canonical ApplyRequest. Preserve its operation ID
and exact bytes after timeout or uncertainty; only a saved receipt proves commit.
Include the current expected item/topic revisions for existing entities. On a
domain error, inspect the error, reload the relevant projection and correct the
request; do not claim success or blindly repeat the underlying external work.

Write full item replies, including the useful reasoning and outcome, in explicit
Reply operations. An Activity is a concise shared summary, not a substitute for a
full Reply. Use explicit item references, current question revisions and valid
statuses: open, in_progress, waiting_on_me, decided, done, dropped, replaced.
Preserve closed outcome history. Another question about the same decision is a
new Ask round on the existing item; a different decision becomes an explicit
child item. Do not manufacture a parent or round relationship from proximity.

For each dispatched Ariadne input, retain its exact source input/attempt and
binding/generation scope and commit exactly one explicit input_result with the
full reply references, follow-up item references, outcome, explanation and
handled-through owner-message number. Successful host completion alone is not a
domain result. A normal terminal summary may be brief once full replies and the
result are committed. Never infer non-delivery or authorize resending work from
missing output, presence, a timeout or a failed persistence receipt.

When the owner explicitly attaches a fresh host conversation to an existing
Ariadne session, read its recorded topics, items, current questions/options,
answers, outcomes and full history before continuing. Reuse existing items and
respect cancelled/skipped inputs and closed or superseded history. This is
structured context, not a transfer of the prior host transcript, private memory
or authority over an old attempt. Use the exact routing instructions returned in
the saved setup receipt; attachment does not itself dispatch work.
