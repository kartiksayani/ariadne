# Platform research ledger

**Checked:** 2026-10-01. This records official documentation and release evidence for planning; documented support has not been exercised in this workspace unless explicitly stated. Links below point to upstream official sources.

## Observed official documentation

### Tauri 2 and macOS

- **Versions (official release index, 2026-10-01):** `tauri` 2.12.0, `tauri-cli` 2.12.0, `@tauri-apps/api` 2.12.0 (all dated 2026-09-26); `create-tauri-app` 4.7.4 (dated 2026-09-04). Specific release pages confirm the core, CLI, and JS API 2.12.0 releases. These are the versions listed by the checked release index, not a compatibility lock recommendation. [Release index](https://v2.tauri.app/release/) · [tauri 2.12.0](https://v2.tauri.app/release/tauri/v2.12.0/) · [tauri-cli 2.12.0](https://v2.tauri.app/release/tauri-cli/v2.12.0/) · [API 2.12.0](https://v2.tauri.app/release/@tauri-apps/api/v2.12.0/)
- **React TypeScript scaffold:** `create-tauri-app` offers React and TypeScript as selectable template/flavor options. Tauri recommends Vite for React single-page apps. [Create a project](https://v2.tauri.app/start/create-project/) · [Frontend configuration](https://v2.tauri.app/start/frontend/)
- **Tray/menu:** Desktop tray icons and attached native menus are supported from Rust and JavaScript. macOS tray config documents icon, title, tooltip and template-icon choices; `showMenuOnLeftClick` is the supported key (`menuOnLeftClick` no longer works since Tauri 2.2). The docs do not promise numeric badge/count semantics for a status item. [System tray](https://v2.tauri.app/learn/system-tray/) · [Tray configuration](https://v2.tauri.app/reference/config/#trayiconconfig)
- **Native notifications:** The notification plugin lists macOS support. Its interactive notification actions and `onAction` listener are documented as mobile-only; the plugin page does not document a macOS notification-click event or payload routing callback. This is a documentation gap, not proof that native macOS APIs cannot support it. [Notifications](https://v2.tauri.app/plugin/notification/)
- **Always on top:** The window API exposes `setAlwaysOnTop(boolean)`; official examples show setting it true. [Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#setalwaysontop)
- **Single instance/focus:** The official plugin lists macOS support. Its second-instance callback receives app handle, arguments and cwd; docs show focusing the existing `main` webview window with `set_focus()`. The plugin docs say it must be registered first among plugins. [Single-instance plugin](https://v2.tauri.app/plugin/single-instance/)
- **WebDriver:** Tauri’s recommended WebdriverIO Tauri service supports macOS through its embedded WebDriver server. Direct `tauri-driver` desktop use supports Windows/Linux only because macOS has no WKWebView driver tool. [WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/)

### Claude Code local plugins, hooks, and settings

- **Plugin layout and scopes:** A plugin directory packages skills, hooks and optional other components. User, project and local scopes respectively enable plugins across the machine, across repository collaborators, or for one user in one repository. Settings are `~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`; local overrides project, which overrides user. Disabling/uninstalling is documented. [Plugin install and scopes](https://code.claude.com/docs/en/plugins/install#choose-an-install-scope) · [Manage installed plugins](https://code.claude.com/docs/en/plugins/install#manage-installed-plugins)
- **Local, no-publish paths:** `--plugin-dir` loads a local plugin for one session only. The docs also say a plugin directory in `~/.claude/skills/` containing `.claude-plugin/plugin.json` loads every session without a marketplace or install step; `claude plugin init` scaffolds there. A repository can also use standalone project skills/hooks or a local marketplace path. [Create plugins](https://code.claude.com/docs/en/plugins/create#develop-without-a-marketplace) · [Persistent personal plugin](https://code.claude.com/docs/en/plugins/create#make-a-plugin-load-in-every-session) · [Local marketplace source](https://code.claude.com/docs/en/plugins/install#add-a-marketplace)
- **Project skills-directory plugins:** `.claude/skills/<name>/.claude-plugin/plugin.json` is also supported. The project must be trusted, and discovery uses the primary working directory rather than searching parent directories; launch from the project root for this plan's project setup. [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository)
- **UserPromptSubmit hook:** Runs before Claude processes each prompt. The hook receives the submitted prompt and can return JSON `hookSpecificOutput.additionalContext`; that context is added alongside the prompt. Default command-hook timeout is 30 seconds; timeout discards output/context while the prompt continues. [Hooks reference](https://code.claude.com/docs/en/hooks#userpromptsubmit-input) · [Context output](https://code.claude.com/docs/en/hooks#add-context-for-claude)

### Codex CLI local findings and official docs

- **Local version observation supplied by the main agent:** codex-cli `0.159.3`. This is a local environment observation, not verified here as the current public release.
- **Hooks:** Official Codex documentation lists both user (`~/.codex/hooks.json`) and repository (`<repo>/.codex/hooks.json`) hook configuration, and supports `UserPromptSubmit` JSON output with `hookSpecificOutput.additionalContext`. Non-managed hooks require trust/review; `/hooks` lets users inspect, trust, or disable them. [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- **AGENTS.md precedence:** Global instructions load first; project instructions are discovered from project root down to cwd. Closer instructions are appended later and override broader guidance; `AGENTS.override.md` replaces `AGENTS.md` within the same directory. [AGENTS.md configuration](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## Not yet exercised / planning spikes

- Test macOS notification delivery, permission denial, app foreground/background behavior, and click-to-route with a packaged app; current Tauri docs only document notification action callbacks on mobile.
- Test whether a dynamic numeric tray title is legible and stable under menu-bar crowding, notch layouts, and common menu-bar managers; official docs specify a macOS title but no count/badge behavior.
- Exercise Tauri single-instance activation, focus, and launch arguments for the packaged macOS app.
- Exercise Codex user/project hook precedence, trust prompts, `/hooks` disable/re-enable, and context injection in the target local CLI build.
- Exercise Claude Code persistent local plugin loading and update/reload behavior under the chosen user or repository scope; session-only `--plugin-dir` behavior is documented but does not prove persistent setup.
- The organization-specific the review tool security guidance was not fetched for this evidence ledger; security guidance review is tracked by the main planning work.
