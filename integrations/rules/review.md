# Filing a review or a choice

For PRs, docs, specs, plans and comparisons. The `SKILL.md` rules still apply.

## Review

- The summary is an `explanation`, `open` with `ack_to: "done"`, no ask and
  the PR in `links`. Its Ack stays with the owner; settling children is not Ack.
- Under it, the verdict is a `decision` with its own `ask` and options such as "Request
  changes", "Approve as is" and "Comment only".
- Each comment you would post is its own `decision` child: `question` is the comment
  text, `ask` "Post it on the PR?", options "Post it", "Skip" and "Edit first", `links`
  the file. The owner decides each.
- Checked and fine: one `explanation`, `open` with `ack_to: "done"`, with a
  bullet list.
- Don't file the comments `done` under one blanket ask on the parent.
- Post nothing to the PR until the owner answers. They can follow up on one comment
  ("drop this", "soften it") or reply on the whole topic ("approve the PR");
  see `follow-up.md`.

## Choice

- One `decision`, asked, whose options are the alternatives; `recommended` is your
  pick.
- Each alternative is a child `explanation`, `open` with `ack_to: "done"`,
  trade-offs in `outcome` and evidence in `why`.

## Approvals and proposed text

- Merge, deploy, delete, spend and clean-up each get their own ask; the
  `consequence` says what cannot be undone. Act only after the answer.
- Text you would post (PR comments, messages, docs) is the item's `outcome`.

## Example

```json
{"summary":"Reviewed notes sync","operations":[{"op":"topic.add","name":"Review: notes sync retries","short":"Notes sync review"},{"op":"item.add","question":"Notes sync is sound apart from one fix","short":"Notes sync review","type":"explanation","status":"open","ack_to":"done","outcome":"One retry fix needs a decision","why":"Review evidence is in the children.","links":[{"kind":"pr","label":"Notes sync review","target":"https://example.com/org/repo/pull/812"}],"children":[{"question":"Notes sync needs one fix; request changes?","short":"Sync verdict","type":"decision","ask":"What should the review say?","options":[{"label":"Request changes","consequence":"Posts the comment","recommended":true},{"label":"Approve as is","consequence":"Posts an approving review"}]},{"question":"Add jitter to the retry backoff: clients retry in lockstep after an outage.","short":"No jitter","type":"decision","ask":"Post this on the PR?","options":[{"label":"Post it","consequence":"Posts it as written","recommended":true},{"label":"Skip","consequence":"Posts nothing"},{"label":"Edit first","consequence":"You reword it; then I post"}],"links":[{"kind":"file","label":"src/retry.rs","target":"src/retry.rs"}]},{"question":"Checked and fine","short":"Checked, fine","type":"explanation","status":"open","ack_to":"done","outcome":"- Retry cap is respected\n- Errors keep their cause","why":"Read the whole diff and ran the tests."}]}]}
```
