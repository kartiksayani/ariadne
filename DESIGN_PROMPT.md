**Design a local web app: Ariadne, a thread back through long conversations with an AI coding agent**

**The problem.** I work with an AI coding agent in long chat sessions. I ask one thing, and it replies with N questions, decisions or findings. I ask about a few of those, and each spawns M more. After an hour I can't tell which of its messages relates to which earlier item, what I've already decided, and what's still waiting on me. I need to see the conversation as a **tree of items with a clear status on each**, not as a scroll of messages. Like Ariadne's thread in the labyrinth, it must let me trace any point back to where it came from.

Items must make sense to someone who doesn't remember any codes. Every item reads as a plain sentence a human understands without context: what was asked, and what was decided. IDs exist only so the agent can reference items; the UI shows them small and secondary, or hides them.

**Who uses it.** One engineer, me. It sits on a second screen next to a terminal chat with the agent. I glance at it often, so it must be readable at a glance.

**Data model.** The agent writes these as we talk; I mostly read, and answer.
- **Item:**
  - `id`: internal, hierarchical
  - `question`: what was asked or proposed, as a full plain sentence
  - `outcome`: what was decided or done, as a full plain sentence, once closed
  - `why`: one line of reasoning
  - `type`: question for me, decision, finding, task, or explanation
  - `status`
  - `parent`
  - `created_in_message`
  - `updated_in_messages[]`
  - `links`: PRs, files, docs
  - `owner`: me, the agent, or someone else
  - `options[]`: for questions to me, each with a label, a one-line consequence, and whether it's the agent's recommendation
- **Statuses:**
  - **Open:** not discussed yet.
  - **Waiting on me:** the agent needs my answer.
  - **In progress:** the agent is working on it.
  - **Decided**
  - **Done**
  - **Dropped:** decided not to do it.
  - **Replaced:** superseded by another item, with a link to it.
- **Message:** `number`, `author` (me or the agent), `timestamp`, `excerpt`, `items_touched[]`.
- **Topic:** a top-level grouping, named in plain words, e.g. "Reviewer's comments on the SDK cache PR".

**Screens and views:**
1. **Tree view (main).** A collapsible outline. Each row shows the question and, once closed, its outcome, both in full sentences, plus a status badge. Closed branches (decided, done, dropped, replaced) collapse by default and look dimmed. A replaced item clearly points to its replacement.
2. **"Waiting on me" panel.** Pinned, and always visible. It lists only the items waiting on my answer across all topics, oldest first, each with its plain-language path ("SDK cache PR › test fixtures › fallback-merge test"). This answers "what do I still have to decide?"
3. **Item detail.** The question, the outcome, the reasoning, the links, and a **timeline** of the chat messages that created and touched the item, with excerpts. This answers "this message relates to that item, which came from that earlier message."
4. **Answer inline.** For an item waiting on me: the agent's options as buttons with its recommendation marked, each showing its consequence, plus a free-text box. Answering moves the item along, and the agent picks it up.
5. **Graph view (secondary).** The same items as connected nodes, to see how far one question branched out.
6. **Message rail (optional).** A narrow list of chat messages. Hovering a message highlights the items it touched, and hovering an item highlights its messages.

**Interactions.** Keyboard first: arrows to move, Enter for detail, `a` to answer, `/` to search the text. Filters by status, topic and owner. It updates live as the agent writes. Fast answering matters more than anything else.

**Visual direction.** Calm, dense, developer-tool feel, like Linear or GitHub's tree views. Readability first: full sentences, generous line height, and context from plain-language parents and indentation. Never make the reader decode an ID. Status shown with icon plus colour, never colour alone. Light and dark themes. No marketing chrome.

**What to deliver.**
- The tree view with the Waiting-on-me panel.
- Item detail with its timeline.
- The inline answer state.
- The graph view.
- Empty and loading states.
- Light and dark variants.
- A component sheet: status badge, item row, answer control, message excerpt.

**Example data to design with,** a synthetic software review session:
- **Reviewer's comments on the SDK cache PR (#226)**
  - *Should the SDK use the shared cache by default when no experiment is set?* → **Decided:** yes. Teams roll out with an experiment, then remove it and stay on the shared cache.
  - *Can cached profiles go stale forever, since reads keep extending their life?* → **Decided:** the service guarantees every change republishes the profile; no expiry cap.
    - *What would a "maximum age" check involve?* → **Explained:** it would need changes in the service too, and would cap cache life at that age.
    - *Do we need a runbook for fixing stale entries?* → **Done:** a task to write the SOP was created.
  - *Are the byte-for-byte test fixtures worth keeping?* → **Decided:** no. Removed them, along with the test-only encoder.
    - *Does the fallback-merge test still earn its place?* → **Decided:** keep it, slimmed down.
      - *Add a check that a second merge reads nothing from Redis?* → **Decided:** keep.
      - *Count Redis reads when the initial profile belongs to a workspace?* → **Dropped:** it duplicates an existing test.
        - *Check one experiment decision per sync quota calculation?* → **Replaced, then dropped:** already covered.
- **Should the SDK delete cache entries it can't read?** → **Decided:** no. The service repairs them; the SDK code and its metric were removed.
  - *Should the service serve default profiles from the shared cache too?* → **Waiting on me:** approve PR #757. Options: "Approve" (recommended: review found nothing blocking) / "Request changes".
- *Should we remove the duplicate sub-agent rule from CLAUDE.md?* → **Waiting on me.** Options: "Yes, keep it only in AGENTS.md" (recommended) / "No, keep both".

---
