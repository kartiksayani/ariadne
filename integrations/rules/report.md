# Filing a report

For reports and investigations. Follow `SKILL.md`. While work runs, file an
`in_progress` summary and add results as they land (`checklist.md`).

## Method

Split the result into points: a claim, a check, a choice, a step, a risk. For each
ask:

1. Does the owner need to act? Only they can decide it: an ask. It matters to them
   later but does not block you: `open`. Does reading finish this item? Choose
   its `ack_to`: `open` if work continues, `in_progress` if underway, or
   `done`/`decided`/`dropped` only for a finished or ruled-out point.
2. Is it the same as another point? Merge them; a scenario listed under "what we
   tested" and again under "outcomes" is one item.
3. Would the owner comment on it alone? Then it is its own item; otherwise a table
   row or a line in its parent's `why`.
4. What does it belong to? Put it under that item, so the tree reads like the
   report's outline.

## Tree

- The summary is a `finding`, `open` with a deliberate `ack_to`: `question` states
  the result and what waits on the owner, `outcome` what it proves, `why` how you know.
- Sections are `explanation` or `finding` items, `open` with their own `ack_to`,
  each with an `outcome`. Points are children: a `finding`, a recorded decision
  (`ack_to: "decided"`), a `task` for someone, or an ask.
- Owner choices and offers become asks; track running work `in_progress`.
  Commands, logs and numbers go in `why`; keep long logs in linked files.

## Example

Reading leaves the summary Open while cleanup waits; finished setup becomes
Done, the load choice Decided, and the rejected cache lead Dropped.

```json
{"summary":"Filed the load test report","operations":[{"op":"topic.add","name":"Load test round 1: sync-service on staging-2","short":"Load test round 1"},{"op":"item.add","question":"11 of 11 checks pass; 1 choice waits on you","short":"Result summary","type":"finding","status":"open","ack_to":"open","outcome":"The service holds 500 rps with p99 under 200 ms","why":"Ran 11 scenarios for 30 minutes each; none breached the thresholds.","children":[{"question":"Test setup","short":"Setup","type":"explanation","status":"open","ack_to":"done","outcome":"| Item | Value |\n|---|---|\n| Host | staging-2 |\n| Build | #412 |","why":"Read from the run log."},{"question":"Ran with 50 virtual users","short":"Virtual users","type":"decision","status":"open","ack_to":"decided","outcome":"50 users","why":"The staging database saturates above 80."},{"question":"Investigate cache contention","short":"Cache contention","type":"finding","status":"open","ack_to":"dropped","outcome":"No cache bottleneck","why":"Traces show no wait on the cache."},{"question":"Delete the staging fixtures?","short":"Fixture cleanup","type":"decision","ask":"Delete the staging fixtures now?","options":[{"label":"Delete","consequence":"Cannot be undone"},{"label":"Keep","consequence":"Round 2 reuses them","recommended":true}]}]}]}
```
