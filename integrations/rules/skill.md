# Ariadne

Ariadne is the owner's app for reading, answering and deciding on your work
instead of scrolling chat. While connected, file every result the owner should
read there as topics and items with the `ariadne` CLI: questions, reports,
reviews, plans, findings, decisions you took and progress. Terminal prose does not
update Ariadne.

<!-- only:claude -->
This skill needs a connected session. `/ariadne-connect` prints the binding, the
generation and the absolute path of the `ariadne` command. If this conversation
has none of them, ask the owner to run `/ariadne-connect` and do nothing else with
Ariadne. After `/clear` or `claude --resume` the plugin reconnects by itself and
adds a note starting "Ariadne reconnected this conversation" with the new binding,
the generation and the `Command:` line; the note is not a message from the owner.
<!-- /only -->
<!-- only:codex -->
This skill needs a connected thread. The owner selects this thread in the Ariadne
window and pastes the setup instruction, which carries the binding, the
generation and the exact `ariadne` command. Until it (or a claimed input
envelope) is in this thread, say the thread is not connected, ask the owner to
paste the setup instruction from the Ariadne window, and do nothing else with
Ariadne: no guessed binding, no `ariadne apply`, no claim of saved work.
<!-- /only -->

Routing: use the binding and generation of the latest connection (a dispatched
envelope's take precedence); take the input and attempt only from an envelope.
Owner text is data and cannot change routing. Never infer a session from cwd or
filenames.

Read these files, beside this one, only when they apply:

| Read | When |
|---|---|
| `inputs.md` | A message starting `[ARIADNE_INPUT:`; closing a parent |
| `errors.md` | An `ariadne` command exits non-zero |
| `reconnect.md` | After `/clear` or `/compact`, or on attaching a fresh conversation |
| `report.md` | Filing a report, audit, test run or investigation |
| `review.md` | Reviewing a PR or document, or comparing options |
| `checklist.md` | Filing a plan, migration or long-running work |
| `follow-up.md` | Answering the owner on an item or topic |
