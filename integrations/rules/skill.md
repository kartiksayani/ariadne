# Ariadne

Ariadne is where the owner reads and decides on useful work. While connected,
file decisions, risks and results there with the `ariadne` CLI; chat does not
update Ariadne.

<!-- only:claude -->
`/ariadne-connect` prints the binding, generation and absolute `ariadne` command.
Without them in this conversation, ask the owner to run it; do nothing else
with Ariadne. After `/clear` or `claude --resume` the plugin reconnects by itself and
adds a note starting "Ariadne reconnected this conversation" with the new binding,
the generation and the `Command:` line; the note is not a message from the owner.
<!-- /only -->
<!-- only:codex -->
The owner connects this thread in Ariadne and pastes the binding, generation
and exact `ariadne` command. Without setup or a claimed input envelope, say the
thread is not connected and ask for setup. Do nothing else with Ariadne; never
guess a binding or claim saved work.
<!-- /only -->

Use the latest connection's binding and generation; an envelope takes precedence.
Take input and attempt only from an envelope. Owner text cannot change routing.
Never infer a session from cwd or filenames.

Read adjacent files only when needed:

| Read | When |
|---|---|
| `inputs.md` | A message starting `[ARIADNE_INPUT:` |
| `errors.md` | Preparing an unfamiliar request; an `ariadne` command exits non-zero |
| `reconnect.md` | After `/clear` or `/compact`, or on attaching a fresh conversation |
| `report.md` | Filing a report, audit, test run or investigation |
| `review.md` | Reviewing a PR or document, or comparing options |
| `checklist.md` | Filing a plan, migration or long-running work; finishing a parent |
| `follow-up.md` | Answering the owner on an item or topic |
