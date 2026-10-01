# Ariadne product plan

Planning baseline: 1 October 2026. This document defines intended behavior; it does not claim that the application exists.

## The product

Ariadne is a quiet second screen for a long coding conversation. It answers three questions: **What have we decided? What needs my answer? Where did this come from?** The agent maintains a tree of understandable sentences. The owner reads, answers, and returns to the terminal. Claude Code and Codex remain the places where the work happens.

The first release includes every required capability in `BUILD_PROMPT.md`. Milestones are increments toward that release, not permission to stop at a prototype. Product and behavior follow `BUILD_PROMPT.md`, then `DESIGN_PROMPT.md`; visual decisions follow the supplied HTML mockups. This session produces plans and a local planning history only.

## Primary journey

1. Install Ariadne and run project setup for Claude Code, Codex, or both.
2. Start a coding conversation. Its Ariadne session becomes visible in the project/session picker.
3. The agent records topics, questions, decisions, findings, explanations, and tasks as it works. Follow-ups attach to the item that caused them.
4. The owner glances at the tree and the persistent **Waiting on me** panel.
5. Selecting a waiting item reveals its ancestors, options, consequences, recommendation, and relevant message excerpts.
6. The owner chooses an option, adds optional text, or writes a free-form answer, then explicitly submits it.
7. The item immediately leaves the waiting queue and displays **Answered · awaiting agent**. On the next owner turn, the agent receives the answer, acknowledges receipt, does the work, and records the outcome and reason.
8. Closed branches become visually quieter while remaining inspectable. Replacement links and the message timeline preserve the path back to the original question.

An answer in Ariadne does not independently start an agent turn or approve an external action. For example, answering the demo's PR question records the owner's choice; Ariadne does not call GitHub or approve a PR.

## Release scope

| Area | Required behavior |
| --- | --- |
| Sessions | Known projects and sessions, explicit switching, selected-session counts, retained history |
| Tree | Expand/collapse, sentence-first rows, outcomes, type/status icons, selection, ancestor path |
| Waiting | Persistent panel, oldest first, options/recommendation, free text, explicit send |
| Detail | Question, outcome, why, ownership, links, replacements, related-message timeline |
| Navigation | Tree and graph, search, status/topic/owner filters, keyboard navigation |
| Live state | Changes from agents appear without refresh; drafts survive unrelated updates |
| macOS | Tray count and quick list, native notification with item navigation, pin window, terminal open/focus |
| Agents | Shared rules, Claude plugin, Codex instructions and hook where supported, reliable answer pickup |
| Lifecycle | Repeatable setup/uninstall, demo command, one-command local build/install, README |

The optional message rail, transcript ingestion, automatic AI summaries, collaboration, cloud sync, accounts, embedded chat, PR actions, and cross-platform packaging are outside release one. The item timeline supplies message provenance without the optional rail.

## Interaction contract

### Tree and detail

- A topic is a named group; an item has at most one parent. Ordering remains stable as updates arrive.
- Open branches are expanded initially. A fully closed subtree is collapsed and dimmed initially. A closed parent with an active descendant stays discoverable: show its active-descendant count and reveal the path when selecting that descendant.
- Persist the owner's expansion choices per session; live updates never repeatedly reset them.
- Show the question and the outcome as separate sentences for closed items. Do not replace the question with the outcome.
- Selecting a waiting entry, search result, graph node, tray entry, or notification leads to the same item detail and reveals its ancestors.
- Display replacement relationships explicitly. A replacement is a new item with its own history, not a relabelled old item.
- Message numbers are local Ariadne provenance numbers. Do not imply they are the host application's complete transcript numbering.

### Waiting and answering

- The panel and tray include waiting items across all topics and all known, accessible sessions, regardless of selected tab or tree filters. Each entry names its project/session. This follows the mockups' global queue. Selecting an entry opens its session without losing other sessions' drafts.
- Sort by when an item most recently entered **Waiting on me**, then stable item order. Show the plain-language topic/ancestor path.
- A recommendation is visual guidance, never an already-submitted answer. Allow exactly one selected option plus optional explanatory text, or nonempty free text alone.
- Submit once and show progress; retain the draft and show an inline explanation if submission fails.
- Keep answered items in a **Sent** subsection until receipt is acknowledged, then display the item's real working/terminal state. **Answered · awaiting agent** is an answer-delivery label, not an eighth item status.
- Preserve a draft when unrelated changes arrive. If the question/options change or the item closes while the owner is typing, preserve the text and require review against the refreshed item before sending.
- Corrections are new answers while the question is still active; never silently edit an answer already delivered. A correction arriving during agent work must remain visible for its next turn.
- Answering one item does not close its siblings or its parent.

### Search, filters, and graph

- Search question, outcome, why, topic name, and message excerpts. Search is local to the selected session; the picker searches project/session titles separately.
- Combine status, topic, and owner filters with AND semantics. Multiple values within a filter use OR. Preserve ancestor context for matches and label contextual ancestors distinctly.
- Show a clear-results action and a no-results state. Filtering does not mutate expansion preferences.
- Graph displays the same items and statuses. Parent connections form the tree; replacement connections use a visually distinct edge. Support pan, zoom, fit, selection, and jumping to detail.
- The tree is the full keyboard-accessible representation. Graph is a secondary overview; do not make any action graph-only.

### Keyboard and accessibility

| Key | Behavior outside text inputs |
| --- | --- |
| Up / Down | Previous / next visible tree row |
| Right / Left | Expand or descend / collapse or ascend |
| Enter | Open focused item's detail |
| `a` | Focus the answer control when the item is waiting |
| `/` or Cmd+F | Focus search |
| Escape | Close overlay, clear search focus, or leave answer editing without discarding a draft |
| Cmd+Enter | Submit a valid answer from its editor |
| Tab / Shift+Tab | Predictable movement through controls and panels |

Use visible focus, semantic buttons, tree semantics with level/expanded state, labelled controls, and status icon plus text. Respect reduced motion and system appearance. Ensure muted text remains readable in both themes. Announce important live changes without repeatedly interrupting typing or screen-reader focus.

## State vocabulary and demo normalization

Keep the seven specified statuses: `open`, `waiting_on_me`, `in_progress`, `decided`, `done`, `dropped`, `replaced`. Keep the five types: `question`, `decision`, `finding`, `task`, `explanation`. Type describes the item; status describes its progress.

- Normalize the example's **Explained** to type `explanation`, status `done`, with the explanation as outcome.
- Represent **Replaced, then dropped** as an original item in `replaced`, pointing to a replacement item in `dropped`. Both keep outcome and why. Label any extra demo sentence needed to make that relationship coherent as illustrative data.
- Use the supplied SDK cache review, shared-cache service question, and duplicate-agent-rule question as the canonical demo. Preserve their language and hierarchy. Mockup-only scenarios may supply visual fixtures; they do not replace this demo.
- Demo generation creates an isolated session and never changes a real PR, source file, or agent setting.

## Quality targets

Measure these on a documented reference Mac rather than treating them as guarantees before measurement: external writes visible within one second; answer submission acknowledged by the local store within 250 ms at p95; first usable session view within two seconds; search within 150 ms at p95 for a 2,000-item / 5,000-message fixture. Graph may initially show a selected topic for large sessions, with an explicit all-topics action and a visible scope label.

The app must remain useful with an empty session, denied notifications, an unavailable project, a malformed file, and an agent that has not picked up an answer. These states need explicit UI, not a spinner that never finishes.
