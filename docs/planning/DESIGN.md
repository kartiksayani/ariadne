# Design translation and scope decisions

## Sources actually reviewed

- Repository `DESIGN_PROMPT.md`: short product/design brief and canonical SDK-cache example.
- `designs/Ariadne UI mockups.zip`: 16 files, 382,719 uncompressed bytes. Its `design_handoff_ariadne/README.md` is the detailed 433-line handoff, distinct from the repository design prompt.
- Main `Ariadne.dc.html`, board `Ariadne Mockups.dc.html`, component files, scenario entry pages, status diagram, and `_ds/.../styles.css` inspected as reference source.
- Two representative prototype screens rendered in an isolated browser and visually inspected: [dark tree/detail](assets/mockup-dark-tree.png) and [light graph/detail](assets/mockup-light-graph.png). These show scripted mockup data, including the optional message rail; they are not screenshots of an implemented Ariadne app.

The export is HTML plus a custom component/template runtime. `support.js` loads React, ReactDOM, Babel, fonts, and icons to render demo behavior. Port reusable markup, CSS variables, dimensions, and SVG shapes into React components; do not ship its runtime compiler, CDN imports, fake agent timers, or hard-coded session data. Preserve the original ZIP unchanged. In M0, extract a reference directory with a manifest of source checksums and component mappings.

## Visual contract

Target viewport: **1600 × 960**. Main frame rows: **48 px header, 38 px tabs, flexible body, 30 px footer**. Persistent left waiting column: **300 px**. Center: at least **560 px**. Detail: **400 px** when selected. The optional **240 px** message rail is deferred. Independent vertical scrolling preserves header and footer; maintain the waiting column on screen when the center/detail require horizontal overflow.

Keep the Projects tab, All sessions tab, closable session tabs, session header, view switch, status chips, topic picker, search, and footer keyboard hints. Only show controls and shortcut hints implemented in release one; omit Archive and Messages controls for their deferred features. Closing a tab only removes the tab. Projects are the known registered roots; All sessions lists every known session, not only open tabs. Restore tab order, selection, expansion, search/filter preferences, drafts, and scroll positions between launches.

Minimum supported v1 window: 1000 × 700. At narrow widths, keep the waiting column pinned and let center/detail occupy a horizontally scrollable region. An item detail may be closed explicitly to recover width. No mobile layout or resizable panels in v1; neither is designed in the handoff.

| Token / component | Target |
| --- | --- |
| Dark background / surface / text / accent | `#161826` / `#232532` / `#e9e9ed` / `#9184d9` |
| Light background / text / accent | `#f3f5fe` / `#292b31` / `#796cbf` |
| Dividers | Dark text at 16%; light neutral-900 at 14% |
| Typography | Inter 400/500, locally bundled with license; Menlo/system monospace for IDs/keycaps |
| Detail / page title / item | 20 px / 18 px / 15 px with original line heights |
| Metadata | 12–12.5 px; section labels 11 px, medium, tracked uppercase |
| Radius | 4 px keycaps; 6 px badges; 8 px cards/buttons; 14 px dialogs |
| Primary controls | Accent outline; preserve outline treatment rather than generic filled buttons |
| Tree indentation | 24 px per level; neutral guides and accent selected ancestry |
| Status badges | Distinct shape plus text/color; 22 px high pills |
| Graph nodes | Approximately 190 × 66 px, two-line preview, full question in detail |
| Graph edges | Curved tree edges; selected path accent; dashed labelled replacement links |
| Focus | 2 px accent outline with `:focus-visible` |

Port the complete ramps/status colors from the source CSS rather than inferring them from screenshots. Package Inter and the required Phosphor regular/fill icons locally, preserving their licenses. Use the spiral mark from the reference. Fonts/icons must render with the network disabled.

Use **System** as the initial theme preference, with Light and Dark overrides. Match each theme separately; contrast/focus fixes may adjust low-opacity text if measured accessibility would otherwise fail. Document such a change with before/after screenshots.

## UI component map

| Reference source | Production responsibility |
| --- | --- |
| `Ariadne.dc.html` chrome | AppShell, Header, SessionTabs, Footer, ProjectList, SessionList |
| `Item Row.dc.html` | TreeRow, ancestor guides, question/outcome, selection and status |
| `Status Badge.dc.html` | StatusIcon, StatusBadge, shared status labels/colors |
| `Answer Control.dc.html` | OptionChoice, recommendation, consequence, free-text editor, submit states |
| `Message Excerpt.dc.html` | ItemTimeline with author/time and touched-item context |
| Main detail markup | ItemDetail, breadcrumbs, outcome/why, replacement and children, answer receipt |
| Main waiting markup | GlobalWaitingPanel, WaitingCard, SentSection |
| Main graph markup | TopicGraph, GraphNode, replacement edges, overview controls |
| `Component Sheet.dc.html` | Development-only component gallery for both themes and all states |
| New managed-session controls | NewSession dialog, Conversation panel, prompt composer, activity summary, permission cards, Stop/Resume and delivery recovery; use the supplied tokens |

## Explicit reconciliation of the sources

The owner's managed-session correction takes precedence over the build prompt's next-turn baseline. Other data/behavior follows the prompt. The following decisions make additions and deviations reviewable.

| Mockup feature or assumption | Release-one decision | Reason |
| --- | --- | --- |
| Global waiting queue and Sent section | Keep across known sessions | Makes unanswered work visible from every tab |
| Project/session pages and tabs | Keep with explicit registration, New session and Resume | Required session switching plus managed conversation controls |
| Transcript auto-discovery, “Connected,” “Agent running,” iTerm identity | Managed sessions show measured process state; external sessions show last activity | The runtime supplies liveness; no transcript scraping or guessed terminal ownership |
| MCP integration / AppleScript typing | Managed CLI protocols carry owner input; local stdio MCP records tree changes | Meets automatic delivery requirement without terminal injection or preview Channels |
| Preselected recommendation and Enter sends | Mark recommendation but require deliberate selection; Enter opens detail outside answer editing, Cmd+Enter sends from editor | Prevent a navigation key from committing an unchosen answer; visible recommendation styling is retained |
| Full-mode answer treats option and free text as alternatives | Allow one selected option with optional explanation, or free text alone; show both parts in the submitted-answer summary | Lets the owner accept an option while adding a condition without losing the explicit selection |
| Search question/outcome/short label | Search question/outcome/why/topic/message excerpts; no independently authored short-label field | Makes provenance and the reason for a decision discoverable without requiring another label to maintain |
| Sending → Received → In progress → Resolved | Saved/busy queue/accepted/received/uncertain/resolved from persisted facts | Host acceptance and agent receipt are separate; provide Resume/recovery when required |
| UI answer does not itself change status in handoff | Atomically move waiting to in_progress, labelled “Answered · awaiting agent” until receipt | Build prompt says answering moves the item along; the delivery label prevents implied execution |
| Shared topics across sessions, Continue, reroute to a different running agent | Defer; session-bound topic and answer recipient | Avoid ambiguous recipients and multi-file transactions in the initial JSON store |
| Archive topics / close sessions that hide waiting questions | Defer archive/session-closing actions; retain tab close and terminal item history | No owner question should disappear from the queue through an unrelated view action |
| Bring it up / note / drop / park / follow-up owner controls | v1 UI supports answering and answer corrections; agent CLI supports reopen/drop/children | These extra submission types exceed the primary read/answer workflow; architecture preserves history for later additions |
| Optional message rail | Defer; keep complete per-item timeline | Explicitly optional in the short design brief; limits default density |
| “Explained” badge | Display “Explained” for explanation + done, persist done | Preserves design language without adding a status |
| PR/file/doc links | Show labelled targets and copy action; no previews or automatic navigation | Keeps provenance UI local; provider processes handle their own network calls |
| Native notification and pin-window controls absent from visual designs | Add compact native menu/settings controls using existing tokens | Required by build prompt |
| Initial prompt, follow-ups and tool permissions absent from visual designs | Add a collapsible Conversation panel in the detail region plus global permission cards | Managed sessions need direct controls; preserve the main tree/queue layout |

Deferred entries are not silently part of the v1 acceptance list. If the owner later wants the extended handoff workflow, implement it as a separate expansion after the required release passes. The current user delegated these scope choices; no additional approval is pending.

## Screens and states to implement and capture

Capture at 1600 × 960 in both themes: Projects, session tree, selected closed item, waiting-item detail, inline option/free-text answer, Sent state, graph, replacement detail, loading, empty session, all-clear, no results, stale/corrupt file, unavailable project, write failure with retained draft, question changed during an answer, New session (Claude default and Codex), Conversation panel, busy queue, permission allow/deny, stopped/resume, auth/compatibility error, uncertain delivery, and active-run quit prompt.

Conversation and Item detail are mutually selectable panels within the existing detail region. Preserve a prompt draft when switching to inspect an item. Stream updates do not steal scroll/focus when the owner is reading older activity. A header permission indicator and global request cards remain reachable regardless of the selected project/tab; they are visually distinct from task questions. The mockup's deferred message rail remains deferred.

Use deterministic demo clocks and the canonical fixture. Compare component dimensions, wrapping, indentation, icons, colors, focus, and selected ancestry with the reference. Antialiasing differences are acceptable; missing states, unreadable text, clipped controls, and spacing/layout drift are not. Keep a small screenshot-diff tolerance for rasterization and require human inspection of changed baselines.
