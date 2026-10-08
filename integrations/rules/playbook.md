# Ariadne playbook: shape any work into a tree

Read this before you file a report, review, plan or anything with more than a
handful of points. The rules in `SKILL.md` still apply; this file adds the
method, the five shapes most work takes, how to answer the owner on a tree, and
worked requests.

## Method: four questions per point

Split the result into points: a claim, a check, a choice, a step, a risk. For
each point ask:

1. **Does the owner need to act?** Only they can decide it: an ask. It may
   matter to them later but does not block you: `open`. It is settled: closed
   (`done`, `decided` or `dropped`).
2. **Is it the same thing as another point?** Merge them. A test scenario listed
   under "What we tested" and again under "Outcomes" is one item that carries
   both.
3. **Would the owner comment on it on its own?** Then it is its own item.
   Otherwise it is a row in a table or a line in its parent's `why`.
4. **What does it belong to?** Put it under that item, so the tree reads like
   the outline of the report.

Then order the tree: the summary first, a decision about the whole work next,
then the sections in reading order. The commands, logs and numbers behind a
point go in its `why`; leave long logs in files and link them with `file`. A
40 KB chat report usually becomes one topic with 5-8 sections and 30-60 items,
filed in one request, for about the tokens the chat report would have cost.

## Shapes

Most work takes one of five shapes, or a mix of them: a test report that ends
with a cleanup decision is a Report with an approval inside it.

| Shape | Fits | Tree |
|---|---|---|
| Report | Test runs, audits, benchmarks, research, investigation results, incident write-ups, "what changed" digests | Summary, then one item per section and one child per point |
| Review | PRs, design docs, specs or plans written by someone else | A verdict ask, with one finding per comment you would post under it |
| Choice | Comparisons, library or vendor picks, design alternatives | One decision ask, with one explanation per option under it |
| Checklist | Plans, migrations, releases, rollouts, refactors, setup steps | One task per step, in order; each goes open, in progress, done |
| Live work | Debugging, incidents, long-running or background jobs, CI watching | A task in progress whose note is the current line; findings as they land |

Across the shapes:

- **Approvals and consent** (merge, deploy, delete, spend, clean up): one ask
  per action; the consequence says what cannot be undone. Act only after the
  answer.
- **Proposed text** (PR comments, messages, docs you would post): the text is
  the item's `outcome`, so the owner can follow up on it before you post it.
- **Explanations** (how a codebase or system works, onboarding): one
  `explanation` per area, `done`, with children for detail. The owner's questions
  arrive as follow-ups on the item they are about.
- **Other people and sessions**: a `task` owned by `{"kind":"other","name":…}`
  that says who and what. Do not copy items another session holds.

### Report

- The summary item is a `finding`, `done`: the `question` states the result and
  what waits on the owner ("11 of 11 checks pass; 3 choices wait on you"), the
  `outcome` says what the result proves, the `why` says how you know.
- Sections are `explanation` or `finding` items, `done`, each with a one-line
  `outcome`. Each point is a child: a `finding` you established, a `decision` you
  took (`decided`), a `task` someone should do, or an ask.
- Things you left running, open choices and follow-up offers become asks, never
  a closing paragraph.

### Review

- The verdict is the first item: a `decision` asked with options such as
  "Request changes", "Approve as is" and "Comment only". Link the PR.
- Each comment you would post is a `finding` under the verdict, `done`: the
  `outcome` is the comment text, the `why` your reasoning, the `links` the file.
  What you checked and found fine is one `explanation` with a bullet list.
- The owner can follow up on one comment ("drop this", "soften it") or reply on
  the whole topic ("approve the PR").

### Choice

- One `decision` item, asked, whose options are the alternatives; the
  `recommended` one is your pick.
- Each alternative is also a child `explanation`, `done`, with its trade-offs in
  `outcome` and the evidence in `why`, so the owner can question one of them.

### Checklist

- One `task` per step, added `open`, in the order you will do them. The step
  you start is `in_progress` with a `note` ("Backfilling: 1.2M of 4M rows").
- A step that needs consent is an ask on that step. Work for someone else is a
  `task` owned by `other`.
- As you go, update the note, close each step `done` with its result and start
  the next. The tree is the checklist; the owner watches "In progress".

### Live work

- The work itself is a `task`, `in_progress`; its `note` is the one line the
  owner sees in the tree, so keep it current with `item.edit`.
- Each hypothesis or lead is a child `finding`: `done` when confirmed, `dropped`
  with why when ruled out. The root cause is a `finding`; follow-ups are tasks.
- When the work ends, close the task with what happened, then add the summary
  item if the owner needs a report.

## Answering the owner on a tree

- **Follow-up, reply or note on an item**: a short answer about the item itself
  is a `reply` on it. An answer with two or more points the owner could comment
  on separately (for example "what are Q10 and Q11?") files each as a child
  `explanation` of that item, with a 1-2 line `reply` pointing at them and the
  children in `followup_item_refs`. If it changes the result, close the item
  again with the new `outcome` and `why`; the earlier outcome stays in its
  history.
- **`bring` on an open item**: ask it now with `item.ask` and options.
- **Back to Open (`reopen`)**: `item.status` `open` with a `reason`, then redo
  the work and close it again.
- **Topic reply** ("approve the PR", "clean all of it up", "post the comments"):
  do it across the topic, close every ask it settles with `item.status` (the
  outcome says what you did), and finish with one `input_result`.
- **An answer on one part of a multi-part choice**: act on that part; close the
  parent when its last part is decided.

## Worked requests

Each block is one complete request; the IDs are placeholders (topic `...0005`,
binding `...0003`, item `1` at revision 1, input `...0010`, attempt `...0011`).

**Report.** An end-to-end test run, cut to one point of each kind: summary,
a cleanup decision with two parts, setup facts as a table, a decision the agent
took, one scenario under the outcomes, and observations holding a finding, an
offer turned into an ask and a task for another team.

```json
{"op_id":"00000000-0000-4000-8000-000000000201","source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"Filed the load test round 1 report","operations":[{"op":"topic.add","ref":"t","name":"Load test round 1: billing-service #412 + client #88 on staging-2","short":"Load test round 1"},{"op":"item.add","ref":"sum","topic":{"ref":"t"},"parent":null,"question":"Round 1 passes: 11 of 11 checks on the real header route; 3 choices wait on you","short":"Result summary","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":[{"kind":"pr","label":"Service #412","target":"https://github.com/example/billing-service/pull/412"},{"kind":"pr","label":"Client #88","target":"https://github.com/example/pricing-client/pull/88"}],"outcome":"Deployed evidence that the billing-service #412 image boots under staging config, its outbox workers publish `late_fee` plans into the shared Redis, and client #88 prices them on both the JSON and the proto path.","why":"Run 1 (port-forward) 10/11, run 2 (port-forward) 11/11, run 3 (header route) 11/11. Run 1's only failure was in my driver.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"left","topic":{"ref":"t"},"parent":null,"question":"Clean up what the run left running?","short":"Left running","type":"decision","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"dp","topic":{"ref":"t"},"parent":{"ref":"left"},"question":"Delete the dev environment `staging-2-billing`?","short":"Dev environment","type":"decision","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.ask","item":{"ref":"dp"},"ask":"Its 48 h TTL ends tomorrow at about 11:35 UTC. Nothing else uses it.","options":[{"id":"delete","label":"Delete now","consequence":"Frees the label now; the evidence is already in `evidence/load-test`","recommended":true},{"id":"keep","label":"Keep until the TTL","consequence":"Round 2 can rerun without a new deploy","recommended":false}],"recipient_binding_id":"00000000-0000-4000-8000-000000000003"},{"op":"item.add","ref":"wt","topic":{"ref":"t"},"parent":{"ref":"left"},"question":"What should happen to the uncommitted dev-environment template change?","short":"Template worktree","type":"decision","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.ask","item":{"ref":"wt"},"ask":"The template worktree holds the change from **Setup**, uncommitted; you said no PR for now.","options":[{"id":"pr","label":"Open a PR","consequence":"Every dev environment gets Redis and the outbox worker","recommended":true},{"id":"keep","label":"Keep it local","consequence":"Stays uncommitted on its branch","recommended":false},{"id":"discard","label":"Discard it","consequence":"The next staging run needs it again","recommended":false}],"recipient_binding_id":"00000000-0000-4000-8000-000000000003"},{"op":"item.add","ref":"setup","topic":{"ref":"t"},"parent":null,"question":"Setup: service #412 on staging label `staging-2`, client #88 on the laptop","short":"Setup","type":"explanation","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"| Component | Version | Where |\n|---|---|---|\n| Billing service | #412 at `516847f` | staging `staging-2` |\n| Client library | #88 at `c460776` | laptop worktree |\n| Rate service | dev, chains from #411 | `rates.dev.example.com` |\n| Fee engine | `v1.9.3` via the service pin | inside the service image |","why":"Read from the image tags and the worktree heads.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"tmpl","topic":{"ref":"t"},"parent":{"ref":"setup"},"question":"I added an ephemeral Redis and the pricing-cache-outbox worker to the dev-environment template","short":"Template change","type":"decision","status":"decided","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":[{"kind":"file","label":"env.yaml","target":"deploy/billing-service/env.yaml"}],"outcome":"Four template files changed; the render is byte-identical when the new values are unset (`helm template` across 6 combinations).","why":"The service does not boot without a reachable Redis (`internal/server/option.go:161-164`), and no staging deployment runs `cmd/pricing_cache_outbox`, so the client would miss the cache on every call.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"out","topic":{"ref":"t"},"parent":null,"question":"Outcomes: all 14 kept scenarios pass on run 3","short":"Outcomes","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"One child per scenario.","why":"Each scenario asserts the CC response, the Redis keys, and the SDK fee and metric deltas around the call.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"d4","topic":{"ref":"t"},"parent":{"ref":"out"},"question":"D4: range-plan band edges price correctly on both cache paths","short":"D4 band edges","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"PASS at 10000, 10001, 20000 and 1000000.","why":"10001 USD rounds up to 281 (`math.Ceil` in `CalculateFee`), not the 280 I first listed; the functional suite already asserts 281.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"obs","topic":{"ref":"t"},"parent":null,"question":"Observations: six callouts outside service #412 and client #88","short":"Observations","type":"explanation","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"None is a defect in the PRs under test.","why":"Each child says who should act.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"host","topic":{"ref":"t"},"parent":{"ref":"obs"},"question":"The service `AGENTS.md` names a staging host that has no label routing","short":"AGENTS.md host","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"Label routing works on `billing-live.staging.example.com` with the `x-env-label` header.","why":"My first in-cluster check against the documented host reached base, not `staging-2`.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"fix","topic":{"ref":"t"},"parent":{"ref":"host"},"question":"Fix the host in the service `AGENTS.md`?","short":"Fix AGENTS.md","type":"question","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.ask","item":{"ref":"fix"},"ask":"It is a one-line docs change.","options":[{"id":"pr","label":"Open a docs PR","consequence":"One small PR for the service owners","recommended":true},{"id":"skip","label":"Leave it","consequence":"This item keeps the right host on record","recommended":false}],"recipient_binding_id":"00000000-0000-4000-8000-000000000003"},{"op":"item.add","ref":"prom","topic":{"ref":"t"},"parent":{"ref":"obs"},"question":"The pricing-cache-outbox worker registers a Prometheus collector twice at boot","short":"Duplicate collector","type":"task","status":"open","owner":{"kind":"other","name":"pricing-cache-outbox owners"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null}],"input_result":null}
```

**Review.** The verdict ask comes first; the comments to post sit under it.

```json
{"op_id":"00000000-0000-4000-8000-000000000202","source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"Reviewed PR #812","operations":[{"op":"topic.add","ref":"t","name":"Review: PR #812 retry backoff","short":"PR #812 review"},{"op":"item.add","ref":"v","topic":{"ref":"t"},"parent":null,"question":"PR #812 is sound apart from two fixes; request changes?","short":"Review verdict","type":"decision","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":[{"kind":"pr","label":"PR #812","target":"https://github.com/example/app/pull/812"}],"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.ask","item":{"ref":"v"},"ask":"The two comments below should block the merge. Everything else I checked is fine.","options":[{"id":"request","label":"Request changes","consequence":"Posts both comments; the author fixes them before merge","recommended":true},{"id":"approve","label":"Approve as is","consequence":"Merges with one retry too many and a flaky test","recommended":false},{"id":"comment","label":"Comment only","consequence":"Posts both comments without blocking","recommended":false}],"recipient_binding_id":"00000000-0000-4000-8000-000000000003"},{"op":"item.add","ref":"c1","topic":{"ref":"t"},"parent":{"ref":"v"},"question":"`backoff()` retries once more than `max_retries`","short":"Extra retry","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":[{"kind":"file","label":"src/retry.rs:42","target":"src/retry.rs"}],"outcome":"Comment to post: `attempt <= max_retries` lets a fourth retry run when `max_retries` is 3; use `<`.","why":"Traced with `max_retries = 3`: attempts 0 to 3 all run.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"c2","topic":{"ref":"t"},"parent":{"ref":"v"},"question":"`test_backoff` is flaky because the jitter is not seeded","short":"Flaky backoff test","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":[{"kind":"file","label":"tests/retry.rs","target":"tests/retry.rs"}],"outcome":"Comment to post: seed the jitter in the test, or assert a range instead of an exact delay.","why":"It failed 2 of 50 local runs.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"ok","topic":{"ref":"t"},"parent":{"ref":"v"},"question":"Checked and fine: error mapping, metrics and docs","short":"Checked and fine","type":"explanation","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"- Error mapping keeps the existing codes\n- Metrics keep their names and labels\n- The README matches the new defaults","why":"None of these needs a comment.","replaced_by":null,"source_round_id":null}],"input_result":null}
```

**Checklist.** A plan whose first step has started, with a consent ask on a
later step and a step for someone else.

```json
{"op_id":"00000000-0000-4000-8000-000000000203","source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"Planned the sessions v2 migration","operations":[{"op":"topic.add","ref":"t","name":"Migrate the sessions table to v2","short":"Sessions v2 migration"},{"op":"item.add","ref":"s1","topic":{"ref":"t"},"parent":null,"question":"Backfill v2 from v1","short":"Backfill","type":"task","status":"in_progress","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":"Backfilling: 1.2M of 4M rows, about 20 min left","links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"s2","topic":{"ref":"t"},"parent":null,"question":"Switch reads to v2 behind the `sessions_v2` flag","short":"Switch reads","type":"task","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"s3","topic":{"ref":"t"},"parent":null,"question":"Drop the v1 table after the switch?","short":"Drop v1 table","type":"decision","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.ask","item":{"ref":"s3"},"ask":"Reads move to v2 in the step before. Dropping v1 cannot be undone.","options":[{"id":"wait","label":"Keep v1 for 7 days","consequence":"Rollback stays possible; costs 40 GB for a week","recommended":true},{"id":"drop","label":"Drop right after the switch","consequence":"Frees the space now; no rollback","recommended":false}],"recipient_binding_id":"00000000-0000-4000-8000-000000000003"},{"op":"item.add","ref":"s4","topic":{"ref":"t"},"parent":null,"question":"Watch replication lag during the backfill","short":"Replication lag watch","type":"task","status":"open","owner":{"kind":"other","name":"On-call"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null}],"input_result":null}
```

**Progress in place.** Later, on the same step (item `1` here): update its
progress line and file what turned up under it. When the step ends, one
`item.status` closes it `done` with its outcome and why, and the note stops
showing.

```json
{"op_id":"00000000-0000-4000-8000-000000000204","source_input_id":null,"attempt_id":null,"expected_item_revisions":{"1":1},"expected_topic_revisions":{},"summary":"Backfill at 3.1M rows","operations":[{"op":"item.edit","item":{"id":"1"},"patch":{"question":null,"type":null,"links":null,"note":"Backfilling: 3.1M of 4M rows, about 6 min left"}},{"op":"item.status","item":{"id":"1"},"status":"in_progress","outcome":null,"why":null,"reason":"Backfill running"},{"op":"item.add","ref":"skip","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":{"id":"1"},"question":"The backfill skips 212 rows with a null `tenant_id`","short":"Null tenant rows","type":"finding","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":[{"kind":"file","label":"backfill-skips.csv","target":"backfill-skips.csv"}],"outcome":"Skipped and listed in `backfill-skips.csv`.","why":"v2 requires `tenant_id`; all 212 rows belong to deleted test tenants.","replaced_by":null,"source_round_id":null}],"input_result":null}
```

**Topic reply.** The owner replied "approve the PR" on the review topic. Do it,
close the verdict ask it settles, and finish the input; nothing else needs a
reply.

```json
{"op_id":"00000000-0000-4000-8000-000000000205","source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4},"expected_topic_revisions":{},"summary":"Approved PR #812","operations":[{"op":"item.status","item":{"id":"1"},"status":"decided","outcome":"Approved PR #812 on GitHub","why":"You replied on the topic: approve the PR.","reason":null}],"input_result":{"outcome":"answered","explanation":"Approved PR #812 and closed the verdict.","reply_refs":[],"followup_item_refs":[],"handled_through_message_number":7}}
```

**Follow-up with two points.** The owner replied on item `1`: "what are Q10 and
Q11?". Each answer is a point they may comment on, so each is a child
`explanation` of item `1`; the reply is a one-line pointer, and the input result
lists both children.

```json
{"op_id":"00000000-0000-4000-8000-000000000206","source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":1},"expected_topic_revisions":{},"summary":"Explained Q10 and Q11","operations":[{"op":"item.add","ref":"q10","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":{"id":"1"},"question":"Q10: do retries share one backoff budget?","short":"Q10 backoff budget","type":"explanation","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"No: each caller keeps its own budget.","why":"The budget lives on the request object, so two callers never draw from the same one.","replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"q11","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":{"id":"1"},"question":"Q11: what happens when the budget runs out?","short":"Q11 budget exhausted","type":"explanation","status":"done","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":"The call fails with the last error and is not retried.","why":"The retry loop returns the last error once the budget is spent; nothing is queued for later.","replaced_by":null,"source_round_id":null},{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Q10 and Q11 are answered in the two items below.","round_id":null}],"input_result":{"outcome":"answered","explanation":"Filed one explanation per question.","reply_refs":[{"ref":"r1"}],"followup_item_refs":[{"ref":"q10"},{"ref":"q11"}],"handled_through_message_number":7}}
```
