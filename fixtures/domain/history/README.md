# Item conversation history

`seed.json` is a canonical schema-v1 session containing a release decision, a
finished item, and an explicit agent creation activity. All host identity is fake;
no provider transcript is imported. The history integration tests use this seed
with the declarative full-text `five-rounds.json` scenario, fixed IDs and clocks
to exercise five successive rounds, answer corrections,
multiple item replies, child forks, and a message to the finished item.

History functions operate on owned candidates. Store/core later persist the
candidate atomically, increment the session revision, and enforce operation
replay. The fixture does not simulate that durability or provider delivery.
