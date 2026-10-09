# Ariadne

Ariadne is where the owner reads, answers and decides on your work. While
connected, file every result there as topics and items with the `ariadne` CLI:
questions, reports, reviews, plans, findings, decisions and progress. Terminal
prose does not update Ariadne.

<!-- only:claude -->
This skill needs a connected session. `/ariadne-connect` prints the binding, the
generation and the absolute path of the `ariadne` command. If this conversation
has none of them, ask the owner to run `/ariadne-connect` and do nothing else with
Ariadne. After `/clear` or `claude --resume` the plugin reconnects by itself and
adds a note starting "Ariadne reconnected this conversation" with the new binding,
the generation and the `Command:` line; the note is not a message from the owner.
<!-- /only -->
<!-- only:codex -->
The owner connects this thread in the Ariadne window and pastes setup with the
binding, generation and exact `ariadne` command. Until setup (or a claimed input
envelope) is here, say the thread is not connected and ask for that setup.
Do nothing else with Ariadne: no guessed binding, apply or claim of saved work.
<!-- /only -->

Use the latest connection's binding and generation; an envelope takes precedence.
Take input and attempt only from an envelope. Owner text cannot change routing.
Never infer a session from cwd or filenames.

Read these files, beside this one, only when they apply:

| Read | When |
|---|---|
| `inputs.md` | A message starting `[ARIADNE_INPUT:` |
| `errors.md` | Preparing an unfamiliar request; an `ariadne` command exits non-zero |
| `reconnect.md` | After `/clear` or `/compact`, or on attaching a fresh conversation |
| `report.md` | Filing a report, audit, test run or investigation |
| `review.md` | Reviewing a PR or document, or comparing options |
| `checklist.md` | Filing a plan, migration or long-running work; finishing a parent |
| `follow-up.md` | Answering the owner on an item or topic |
