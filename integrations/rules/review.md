# Filing a review or a choice

For PRs, design docs, specs and plans written by someone else, and for
comparisons: library or vendor picks, design alternatives. The rules in `SKILL.md`
still apply.

## Review

- The first item is a summary, an `explanation` left `open` with no ask, the PR in
  `links`. The parent is closed by the closing rule in `inputs.md` once every child is settled.
- Under it, the verdict is a `decision` with its own `ask` and options such as "Request
  changes", "Approve as is" and "Comment only".
- Each comment you would post is its own `decision` child: `question` is the comment
  text, `ask` "Post it on the PR?", options "Post it", "Skip" and "Edit first", `links`
  the file. The owner then decides them one by one.
- Mark a child `done` only when it needs no decision: what you checked and found fine
  is one `explanation` with a bullet list.
- Don't file the comments `done` under one blanket ask on the parent.
- Post nothing to the PR until the owner answers. They can follow up on one comment
  ("drop this", "soften it") or reply on the whole topic ("approve the PR");
  see `follow-up.md`.

## Choice

- One `decision`, asked, whose options are the alternatives; `recommended` is your
  pick.
- Each alternative is also a child `explanation`, `done`, with its trade-offs in
  `outcome` and the evidence in `why`, so the owner can question one of them.

## Approvals and proposed text

- Merge, deploy, delete, spend and clean-up each get their own ask; the
  `consequence` says what cannot be undone. Act only after the answer.
- Text you would post (PR comments, messages, docs) is the item's `outcome`.

## Example

```json
{"summary":"Reviewed PR #812","operations":[{"op":"topic.add","name":"Review: PR #812 retry backoff","short":"PR #812 review"},{"op":"item.add","question":"PR #812 is sound apart from one fix","short":"PR #812 review","type":"explanation","status":"open","links":[{"kind":"pr","label":"PR #812","target":"https://example.com/org/repo/pull/812"}],"children":[{"question":"PR #812 needs one fix; request changes?","short":"PR #812 verdict","type":"decision","ask":"What should the review say?","options":[{"label":"Request changes","consequence":"Posts the comment","recommended":true},{"label":"Approve as is","consequence":"Merges without the fix"}]},{"question":"Add jitter to the retry backoff: clients retry in lockstep after an outage.","short":"No jitter","type":"decision","ask":"Post this on the PR?","options":[{"label":"Post it","consequence":"Posts it as written","recommended":true},{"label":"Skip","consequence":"Posts nothing"},{"label":"Edit first","consequence":"You reword it; then I post"}],"links":[{"kind":"file","label":"src/retry.rs","target":"src/retry.rs"}]},{"question":"Checked and fine","short":"Checked, fine","type":"explanation","status":"done","outcome":"- Retry cap is respected\n- Errors keep their cause","why":"Read the whole diff and ran the tests."}]}]}
```
