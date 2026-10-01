# Acabox — audit of user-visible copy: jargon, naming, errors, empty states

Read-only review, 2026-09-30. Repo: `/Users/iliasbeshimov/Documents/Dev Folders/Acabox`; paths below are relative to `src/cobuilding/` unless they start with `docs/`. Line numbers were looked up against the working tree on the day of the audit.

Audience judged for: a non-technical scientist who can only describe what they want ("vibecode"), does not read code, does not use a terminal, and cannot debug a build.

## 0. Method and legend

Method: the task's jargon grep over `renderer/**/*.{ts,tsx}` (1,542 raw hits, 79 inside string literals/JSX once code identifiers were filtered), then a full read of every main surface — Rail, ChromeBar, StatusBar, Home (`CommandDesk`), Chats page (`thread-list`), chat header, thread, both composers, model picker, Tools page, tool viewer, Activity + schedules, Settings (all seven sections), Knowledge, Servers, Files, notebooks, Debug, updater, error boundary — plus every main-process string that reaches the renderer (`agentSession`, `index.ts` `chat:send`, `miniAppBuilder`, `packageInstaller`, `containerService`, `apiProxy`, `shared/apis`, `shared/connectors`, `share/*`, `mcpHost/*`, `skillStore`, `knowledge/*`, `claudeDesignLogin`, `agent-server/index.ts`). Before calling anything "missing" I grepped for it.

Voice reference: `docs/design/design_handoff_acabox_home/README.md` ("Copy voice: terse, playful-hacker, sentence case … Statuses ALWAYS mono uppercase") and the agent's own voice rule in `skills/acabox/SKILL.md:39-42` ("First person, named Acabox … Never identify as Claude — the user's product is Acabox").

Classes used in the tables:

- **must-fix** — a scientist cannot understand it, it is false, it blames them, it leaks an internal name, or it is a leftover from a dropped product (Coscientist, Podman).
- **should-fix** — understandable with effort, but off-voice, inconsistent, or exposes machinery the audience never asked about.
- **fine-for-Debug-only** — acceptable on the Debug tab; must not appear elsewhere.
- **fine** — listed only where it is a counter-example worth keeping.

Every copy change below costs **0 model calls per use**.

---

## 1. What a non-technical scientist experiences (walkthrough)

**First launch.** The window chrome reads `ACABOX · V0.1.27` and a yellow dot with `STARTING` (`ChromeBar.tsx:37,46`). The chip says STARTING for as long as `containerAPI.status().running` is false — including when the agent server has crashed or never came up — so the one health indicator on screen can never say "something is wrong". The bottom bar reads `CPU 12% MEM 3.1/8.0G DISK 34.2/80G AGENTS 0 LIVE … UP 4M` (`StatusBar.tsx:70-109`). "AGENTS 0 LIVE" is permanent once main has answered (`agentCount != null`, L77): a scientist is told, forever, that zero agents are live. The rail footer says `~/acabox-workspace  SYNCED` (`Rail.tsx:204-205`) — the tilde is shell notation and `SYNCED` is a string literal with nothing behind it.

**Home.** "Command desk" (`CommandDesk.tsx:85`). The search box promises "Search chats, tools, files…" with a ⌘K keycap (L88-91) but its only behaviour is `onNavigateChats` — it opens the Chats list. The new-tool card says "Describe it below — ACABOX scaffolds it" (L150); "scaffold" is developer vocabulary. The composer placeholder is "What are we building? — describe a tool, paste a repo, or ask" (`GlobalComposer.tsx:74`): a scientist has no "repo" to paste. The right-hand card is "Drive — ~/acabox-workspace" (L180): "Drive" reads as Google Drive, and the files it lists are local.

**First chat.** Empty state "Where to?" / "Describe a tool, paste a repo, or drop files — it takes it from there." (`thread.tsx:147-148`) — "repo" again, and "it" when the agent is meant to speak as "I". While working the thread says `THINKING…` / `WORKING — …` (`thread.tsx:340`) while the header chip says `GENERATING` (`ChatHeader.tsx:124`, `ToolWorkspace.tsx:328`) and the unread-dot tooltip says "Working" (`ChatMarkDot.tsx:21-22`): three words for one state. When a turn's steps are expanded, every row is labelled in Unix: `bash`, `glob`, `grep`, `fetch`, `agent`, `todo` (`tool-card-display.ts:48-77`), with `EXIT 1` as the error meta (`tool-fallback.tsx:133`).

**If the agent server is unhealthy** the bubble shows raw host text: "Agent failed to start. Check the Debug panel for details." (`main/agentSession.ts:526`) or "Agent server failed to become healthy within 15s" (`main/containerService.ts:578`, surfaced verbatim via `emitError(errorMessage)` at `agentSession.ts:850`). A rejected key reads "Failed to authenticate. API Error: 401" (`agent-server/index.ts:710`) on the path that bypasses the friendlier `agentSession.ts:822` text.

**Chats page.** Header stat `0 CONVERSATIONS` under the title "Chats" (`thread-list.tsx:102,197`). A brand-new user sees header + search box + nothing — there is no browse-mode empty state (`thread-list.tsx:125-134`; `chatListEmpty` exists only for search, L160). Every preview and search hit prefixes the agent's words with `CS:` (`chatPreviewStore.ts:69`, `thread-list.tsx:303`) — "CS" is Coscientist, the upstream product this fork left.

**Tools.** The page speaks well ("Tools I've built for you", "Ask me to do something or build a tool", `ToolsPage.tsx:398-406`) — first person, plain. But every row carries a permanent `ON-DEMAND` tag that means nothing (L441). Opening a tool shows `FIRST BOOT — INSTALLING 3 PACKAGES` with a live `▸ Collecting numpy…` pip line (`MiniAppViewer.tsx:684,697`). If the build breaks: "Build failed. / The rebundle didn't come up. Full output:" followed by raw esbuild output in a `<pre>` (L586-588). If Claude has not written the source yet: "Claude is still writing this tool. It appeared here as soon as it was scaffolded, but its source has not been saved yet. This view will build it on its own the moment the file lands." (`miniAppBuildState.tsx:77-80`). If the viewer cannot load the page: "Could not load application **coScientistSpendExplorer**. Expected: `/Users/…/src/index.html`" (L1241-1243). If the host service is down: "Waiting for container..." (L708) — there has been no container since the fork.

When the user clicks "Send to chat — let it fix itself" or Activity's "Ask Claude to fix it", the composer is filled and sent as the user's own message: "The build for `coScientistSpendExplorer` failed. Diagnose and fix it. Build output: ```…```" (L288) or "The mini-app "X" (`.applications/x`) fails to build…" (`ActivityPanel.tsx:162`). The scientist now owns a bubble full of compiler output under their own name.

**Settings.** Sections: Workspace directories · System prompt · About you · Connectors · Claude Design · APIs · Sharing · Account (`DirectoryPermissions.tsx:190-367`). "System prompt" explains itself as "Custom instructions appended to the AI system prompt for this workspace. Saved to .academia/SOUL.md." (L236). "Rescan workspace … refresh your research profile and file tags" lives under **Account** (L367-373). Connectors opens with "Connect Acabox to external services over MCP" (`ConnectorsSettings.tsx:220`), rows carry `HTTP`/`SSE` chips (L246), and the help says "The agent calls its tools as `mcp__hex__…`" (L451). APIs opens with "HTTP APIs Claude may call directly, for services with no MCP connector — or where the connector is read-only and the REST API isn't" (`ApiSettings.tsx:257`), and can show the banner "The API proxy isn't running … It starts with the agent — open a chat, or restart Acabox." (L265-271), advice the engineering log itself records as wrong.

**Servers and Knowledge** are top-level nav entries (`Rail.tsx:28-29`). Servers: "Local MCP servers Acabox runs on this machine — separate from Connectors, which are remote services Acabox connects to" (`ServersPage.tsx:291`), rows showing `pid 41823 · 3 tools · node index.mjs` (L81-83), a detail panel with `argv: ["node","index.mjs"]`, "Working directory", "Environment", a stderr `Log` (`ServerDetail.tsx:169-259`), and a form whose placeholders are `filesystem`, `npx`, `-y`, `API_TOKEN` (`ServerConfigForm.tsx:178-241`). Knowledge: "What Claude can do here, and what it has learned" with chips `BUILT IN · MINE · OFF · BROKEN · MODIFIED · 3 FINDINGS · 2 SCRIPTS` and meta `SKILL.md 4.2 KB · desc 180 chars` (`KnowledgePage.tsx:66-160`); the "Add a skill" form's placeholders are `coscientist-analytics` and "How to analyse Co-Scientist product data in Redshift through the Hex connector." (L681,701) — internal Academia examples a scientist would copy.

**Debug** is one click away in the rail footer for every user (`Rail.tsx:103,209`), with sections "Kernels", "Observations", "Telemetry", "Hard Reset" (`debug/DebugPanel.tsx:16-26`), storage rows for "Podman Binaries" / "VM State & Sockets" (`debug/StorageDebug.tsx:57-59`) and a Hard Reset list that still promises to delete "All briefings" and "All calendar events, plans, and resources" (`debug/HardResetDebug.tsx:67-68`), two features that no longer exist.

Net effect: the chat itself speaks as a colleague ("I'll load the counts and run DESeq2"), the Tools page speaks as a colleague, and almost everything around them speaks as a build server.

---

## 2. Findings — by surface

Columns: where · exact current text · who sees it and when · why it is a problem for a non-technical scientist · suggested rewrite · class.

### 2.1 Shell: window chrome, rail, status bar

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 1 | `renderer/components/command-desk/Rail.tsx:205` | `SYNCED` (string literal) | Always, rail footer | Fabricated status: nothing feeds it. Violates "no mocks in prod". | Remove the word, or drive it from a real signal (last symlink resync time → `CHECKED 09:41`). | must-fix |
| 2 | `Rail.tsx:204` | `~/{workspaceName}` | Always | `~/` is shell notation. | `{workspaceName}` with a folder icon, or "Your folders". | should-fix |
| 3 | `Rail.tsx:103`, `:209` | `Debug` (collapsed title and footer row) | Always, every user | A developer console in primary navigation. | Remove from rail; reach via Settings → "Advanced" or a shortcut. | must-fix (structural) |
| 4 | `Rail.tsx:28` | `Knowledge` | Always | Abstract noun; the page is skills + memory files. | "What I know" / "Skills & memory" (see §5). | should-fix |
| 5 | `Rail.tsx:29` | `Servers` | Always | A scientist has no mental model of "servers" on a laptop, and the page cross-links to Connectors because the split is invisible to them. | Merge into one "Connections" page or hide under Advanced (§5). | should-fix (structural) |
| 6 | `command-desk/ChromeBar.tsx:46` | `HEALTHY` / `STARTING` | Always, top right | `STARTING` is shown whenever `running` is false — including a crashed or never-started agent — so the indicator cannot say "offline". | Three states: `STARTING` (first 30 s), `READY`, `OFFLINE — click for help`. | must-fix |
| 7 | `ChromeBar.tsx:37` | `ACABOX · V0.1.27` | Always | Fine as mono label; version is useful for support. | keep | fine |
| 8 | `command-desk/StatusBar.tsx:77` | `AGENTS {n} LIVE` | Always once main has answered → `AGENTS 0 LIVE` permanently | "Agents" is internal vocabulary; a permanent zero is noise. | Render only when n>0: `{n} CHAT{S} WORKING`. | must-fix |
| 9 | `StatusBar.tsx:70-74` | `CPU 12%`, `MEM 3.1/8.0G`, `DISK 34.2/80G` | Always | Machine telemetry nobody asked for; from the hacker design brief. Owner call, but it reads as "this is a dev tool". | Hide by default; show on hover of the version, or in Activity. | should-fix |
| 10 | `StatusBar.tsx:83,92,105` | `N TOOLS WORKING`, `N SERVERS DOWN`, `N SERVERS STARTING` | When non-zero | WORKING is good. "SERVERS DOWN" alarms without a next step. | `1 CONNECTION FAILED — see Servers`; make it clickable. | should-fix |
| 11 | `StatusBar.tsx:109` | `UP 6D 04H` | Always | Uptime of the app is a sysadmin metric. | Remove. | should-fix |

### 2.2 Home (Command Desk)

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 12 | `command-desk/CommandDesk.tsx:88-91` | "Search chats, tools, files…" + `⌘K`; `onClick={onNavigateChats}` | Always, header | Promises three scopes; delivers the Chats list. Misleading affordance. | Either build the palette or relabel "Search chats…" and route ⌘K to the Chats search box focused. | must-fix |
| 13 | `CommandDesk.tsx:150` | "Describe it below — ACABOX scaffolds it" | New-tool card | "Scaffolds" is developer jargon; third person. | "Describe it below and I'll build it." | must-fix |
| 14 | `CommandDesk.tsx:180` | `Drive — ~/{workspaceName}` | Always | "Drive" implies a cloud drive; `~/`. | `RECENT FILES` (mono label) with "Browse" link. | should-fix |
| 15 | `CommandDesk.tsx:185` | "No files yet — share a folder in Settings." | Empty drive card | "Share" can read as sharing with others. | "No files yet — add a folder in Settings → Your folders." | should-fix |
| 16 | `CommandDesk.tsx:127` | "No description yet — open it and ask for one." | Tool card without description | OK, but passive about who writes it. | "No description yet — open it and ask me for one." | fine |
| 17 | `CommandDesk.tsx:33-36`, `command-desk/format.ts:4-15` | `LAST RUN 12M`, `OPENED 2D`, `3MO`; `relTimeShort` | Tool cards, chat rows | `12M` means 12 minutes on a chat row while `2M` means 2 MB on the file row beside it, in the same mono style. | Use `12 MIN`, `2 H`, `3 D`, `3 MO` for time; `2 MB` for size. | should-fix |
| 18 | `CommandDesk.tsx:36` | `PRE-BUILT` | Card metric for `preBuilt` apps | The pre-built stub tools were removed (CLAUDE.md 2026-07-24); if `preBuilt` can still be true, the word is unexplained. | Drop the branch or say `BUILT IN`. | should-fix |
| 19 | `CommandDesk.tsx:85` | "Command desk" | Page title | Military/ops metaphor from the design brief; harmless but not what a scientist calls a start page. | "Home" (the rail already says Home). | should-fix |

### 2.3 Chats page and chat header

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 20 | `renderer/chatPreviewStore.ts:69`; `components/assistant-ui/thread-list.tsx:303` | `CS: …` (preview and search-hit prefix; `You:` for the user) | Every chat row with an assistant preview (38 of 50 production previews per CLAUDE.md) | "CS" = Coscientist, the abandoned upstream brand. Unexplained two-letter code on the most-used list. | `Acabox: …` (or the ▸ glyph). | must-fix |
| 21 | `thread-list.tsx:125-134` | (no browse-mode empty state; `Items` renders nothing) | New user opens Chats | Header "0 CONVERSATIONS", a search box, blank space. Nothing tells them what to do. | "No chats yet. Type below to start one — describe your data or what you want built." | must-fix |
| 22 | `thread-list.tsx:102` vs `:197` | `{n} CONVERSATION{S}` under the title "Chats" | Always | Two names for one thing on one screen; also "Rename chat / Enter a new name for this conversation." (L355-358). | `{n} CHATS`; "Enter a new name for this chat." | should-fix |
| 23 | `thread-list.tsx:237` vs `command-desk/ChatHeader.tsx:113`, `ToolWorkspace.tsx:296` | `'New Chat'` vs `'New chat'` (also `main/db/chatRepository.ts:5` `DEFAULT_SESSION_TITLE = 'New Chat'`) | Untitled chats | Case inconsistency across surfaces. | `New chat` everywhere (sentence case per design brief). | should-fix |
| 24 | `thread-list.tsx:128` | "Refreshing chats…" | During list reload | Fine. | keep | fine |
| 25 | `thread-list.tsx:160` | "No chats mention "x"." | Search miss | Good. | keep | fine |
| 26 | `thread-list.tsx` row date (`createdAt`, see CLAUDE.md 2026-09-28 "Seen, not changed") | e.g. "1 week ago" on a chat that just moved to the top | Chats list | Sorted by activity, dated by creation: reads as a bug. | Show last activity. | should-fix |
| 27 | `ChatHeader.tsx:117` | `NAMES ITSELF AFTER THE FIRST REPLY` | Empty chat header meta | Acceptable mono hint; slightly long. | `TITLE COMES AFTER THE FIRST REPLY` or drop. | fine |
| 28 | `ChatHeader.tsx:124`, `ToolWorkspace.tsx:328` vs `thread.tsx:340` vs `ChatMarkDot.tsx:21-22` | `GENERATING` vs `THINKING…`/`WORKING — …` vs "Working — a reply is streaming" | Running turn | Three words for one state, two of them mono chips. | One vocabulary: chip `WORKING`, thread line `THINKING…` → `WORKING — reading Data.csv`. | should-fix |
| 29 | `ChatHeader.tsx:80` | "Delete this chat? This cannot be undone." | Delete | Good. | keep | fine |

### 2.4 Composer, model picker, input buttons

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 30 | `components/GlobalComposer.tsx:74` | "What are we building? — describe a tool, paste a repo, or ask" | Every empty chat, docked composer | "Paste a repo" is for developers; a scientist has data folders, not repositories. | "What should I do? — describe an analysis, a tool, or a question about your files" | must-fix |
| 31 | `components/assistant-ui/thread.tsx:148` | "Describe a tool, paste a repo, or drop files — it takes it from there." | Empty chat body | "Repo"; "it" instead of "I". | "Describe a tool, drop in files, or ask a question — I'll take it from there." | must-fix |
| 32 | `thread.tsx:100-110` | Chips: "Turn a script into an app" / "What's in my folders?" / "Build a PDF → BibTeX tool" | Empty chat | Chip 1 assumes the user has scripts; chip 3 is niche. Chip 2 is right. | "Summarise what's in my folders" · "Plot a dataset" · "Turn a spreadsheet into a dashboard" | should-fix |
| 33 | `components/assistant-ui/chat-composer.tsx:25`; `thread.tsx:126,130`; `MiniAppViewer.tsx:707` | "Setting up environment…" / "This may take a few minutes on first launch." | `setup.state === 'downloading'` | "Environment" is developer-speak; also this state is only set by the dead Podman stages in `SetupBanner.tsx` (see §6), so it is stale. | "Getting Acabox ready…" if the state is kept; otherwise delete. | should-fix |
| 34 | `components/ModelSelector.tsx:250` | "Higher effort means more thorough responses, but takes longer and uses your limits faster." | Effort submenu | "Your limits" is a claude.ai subscription concept; Acabox bills the user's API key per token. False cost model. | "Higher effort is more thorough but slower and costs more." | should-fix |
| 35 | `ModelSelector.tsx:46,49` | `Extra`, `Max` ("Best on the most capable models") | Effort list | Opaque scale for non-experts; no indication of cost. | Low · Normal · High · Very high · Maximum, with "Default" and "costs more" badges. | should-fix |
| 36 | `shared/models.ts:49-54` | "Fable 5.1 — Highest intelligence, premium cost", "Opus 5 — Previous-generation Opus", "Haiku 4.5 — Fastest for quick answers" | More models | Anthropic family names mean nothing to the audience; the descriptions carry the load and are good. "Previous-generation Opus" and "Older Opus" explain nothing to someone who doesn't know Opus. | Add plain tiers: "Best quality (slowest, costs most)", "Good everyday", "Fast and cheap". | should-fix |
| 37 | `ModelSelector.tsx:205-206` | "This chat runs on Opus 5.5 · High, fixed when it started. Start a new chat to use a different model." | Pinned chat picker tooltip | Good, honest. | keep | fine |
| 38 | `command-desk/DictationButton.tsx:105` | "Dictate (on-device)" | Mic tooltip | "On-device" is privacy jargon. | "Dictate — stays on your Mac" | should-fix |
| 39 | `DictationButton.tsx:64` | "Downloading the en-US speech model…" | First dictation | Locale code. | "Downloading English speech recognition…" | should-fix |
| 40 | `command-desk/ScreenshotButton.tsx:80`; `main/screenshotHost.ts:140,161` | "Screenshot — drag an area or click a window"; "Acabox window is gone."; "Capturing outside Acabox needs macOS 15 or later." | Screenshot | Clear. | keep | fine |

### 2.5 Thread: step rows, tool cards, errors reaching the chat

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 41 | `components/assistant-ui/tool-card-display.ts:48,59,61,65,67,77,88,98` | Step names `bash`, `glob`, `grep`, `fetch`, `agent`, `todo`, `workspace`, else raw lowercase tool name | Expanded step groups; the one running step while a turn works | Pure Unix/SDK vocabulary on every step a scientist opens. | `command`, `find files`, `search text`, `web page`, `helper`, `checklist`, `your files`. | should-fix |
| 42 | `components/assistant-ui/tool-fallback.tsx:133` | `EXIT 1` meta on a failed command | Failed step | Exit codes mean nothing to the audience. | `FAILED` (keep the code inside the expanded output). | should-fix |
| 43 | `components/assistant-ui/tool-labels.ts:60,56,89,173` | "Running sub-agent", "Searching code", "Exiting plan mode", raw `toolName` fallback | Step labels | "Sub-agent", "plan mode", raw names like `mcp__chats__read_chat`. | "Working on a side task", "Searching your files", "Finished planning"; humanize `mcp__x__y` → "x: y". | should-fix |
| 44 | `tool-labels.ts:92-160` | Labels for `mcp__ms-word__*`, `mcp__obsidian__*`, `mcp__apple-notes__*`, `mcp__google-docs__*`, `mcp__google-drive__*` | Never (integrations dropped) | Dead code, ~70 lines. | Delete. | dead-code |
| 45 | `components/assistant-ui/turnSteps.ts:184,186,197` | "ran 2 agents", "used 1 skill", "called hex 3 times" | Collapsed step line | "Agents"/"skill" are internal nouns; "called hex" is fine. | "ran 2 helpers", "used 1 playbook"/keep "skill" if the Knowledge page is renamed consistently. | should-fix |
| 46 | `components/assistant-ui/turn-steps.tsx:162-164`, `turnSteps.ts:244` | `26 STEPS · 3 FAILED`, "Worked for 4m 12s · 26 steps" | Finished turn | Good. | keep | fine |
| 47 | `thread.tsx:325-333` (`MessageError` renders `ErrorPrimitive.Message` verbatim) + `main/agentSession.ts:850,1395-1403` | Raw strings: "Agent server failed to become healthy within 15s" (`main/containerService.ts:578`), "Agent server exited before becoming healthy (code=1, signal=null)" (L572), "Unknown agent error", any SDK error text | When the host or SDK fails mid-turn | The chat bubble shows infrastructure text with no action. | Funnel in main: headline "Acabox's assistant isn't responding. Try again in a moment — if it keeps happening, quit and reopen Acabox." + collapsed "Details". | must-fix |
| 48 | `main/agentSession.ts:526` | "Agent failed to start. Check the Debug panel for details." | 5-minute startup timeout | Sends a scientist to Debug. | "Acabox couldn't start its assistant. Quit and reopen Acabox; if that doesn't help, [Report a problem]." | must-fix |
| 49 | `main/agentSession.ts:533,535` | "Starting agent service..." / "Waiting for agent..." | Status line while waiting | "Agent" is internal. | "Starting Acabox…" / "Almost ready…" | should-fix |
| 50 | `agent-server/index.ts:710` | "Failed to authenticate. API Error: 401" | Auth failure that is not retried | Raw code; contrast with the good text at `agentSession.ts:822` "Your Anthropic API key was rejected. Update it in Settings and try again." | Reuse the L822 text. | must-fix |
| 51 | `main/agentSession.ts:100-103` | "This conversation is too long for the model's context window, so the request was rejected before the model saw it. Its history has been reset — the next message will start from a clean context, without the earlier turns in this chat." | Context overflow | "Context window", "clean context". The honesty is right; the words are not. | "This chat got too long for me to keep in memory, so I've had to start fresh. I no longer remember the earlier messages here — they're still shown above, so you can paste anything I need." | should-fix |
| 52 | `main/agentSession.ts:198-200` | "The agent did not answer that message. Its turn was spent on a background command left over from the previous session, and a second attempt came back empty as well. Send it again." | Rare swallowed-turn fallback | Third person "the agent"; "background command", "session". | "I didn't manage to answer that — something left over from last time got in the way. Please send it again." | should-fix |
| 53 | `main/index.ts:486` | "No Anthropic API key configured. Add one in Settings." | Send with no key | Good; could point at the exact place. | "Add your Anthropic API key in Settings → Account to start chatting." | fine |
| 54 | `components/assistant-ui/approval-buttons.tsx:6,75` | "Allow once" / "Always allow" / "Deny" rendered as buttons whenever a reply's prose contains all three phrases; hard-coded `#3b82f6` | Any reply that happens to mention those words | No `canUseTool` handler exists (CLAUDE.md), so the buttons do nothing real; off-design colours. | Delete. | dead-code |

### 2.6 Tools page

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 55 | `components/ToolsPage.tsx:388,398-399,404` | "Things the workspace can do for you. Ask me to build one, then return to it any time." / "Ask me to do something or build a tool" / "Tools I've built for you" | Always | Good: first person, plain. Only "the workspace" is odd — the workspace is a folder. | "Things I can do for you. Ask me to build one, then come back to it any time." | fine / minor |
| 56 | `ToolsPage.tsx:441` | `ON-DEMAND` tag on every active tool | Every row | A constant tag conveys nothing; it is decoration pretending to be status. | Remove. | must-fix |
| 57 | `ToolsPage.tsx:440,488` | `PRE-BUILT` | `preBuilt` rows | Dead concept (see #18). | Remove or `BUILT IN`. | should-fix |
| 58 | `ToolsPage.tsx:384` | `{n} TOOLS AVAILABLE` | Header stat | Fine. | keep | fine |
| 59 | `ToolsPage.tsx:418-419` | "All your built tools are archived — restore them from the Archived section below." / "You haven't built any tools yet — describe one above to get started." | Empty | Good. | keep | fine |
| 60 | `ToolsPage.tsx:475,486` | "APIs this tool may call" · "read & write" / "read only" | Tool settings panel | "APIs" needs a gloss. | "Online services this tool may use" | should-fix |
| 61 | `ToolsPage.tsx:581,602` | "Working files kept from tools you deleted…" / "tool deleted 3 days ago" | Saved data | Good. | keep | fine |
| 62 | `ToolsPage.tsx:668` | "Delete X? This removes the tool's code. Any input and output files it saved are kept and stay browsable under Saved data." | Delete modal | Good; "code" is acceptable here. | keep | fine |
| 63 | `ToolsPage.tsx:255` | Composer is filled with "Create a tool for me that does the following:\n\n{text}" | After the Create modal | Fine — it is the user's intent in their words. | keep | fine |

### 2.7 Tool viewer, build and install states

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 64 | `components/MiniAppViewer.tsx:708` | "Waiting for container..." | Tool opened while host service not yet running | The container was removed in the fork. False and stale. | "Starting Acabox…" | must-fix |
| 65 | `MiniAppViewer.tsx:586-588` | "Build failed." / "The rebundle didn't come up. Full output:" + raw esbuild `<pre>` | Broken tool | "Rebundle" is bundler jargon; the compiler output is the body of the screen. | Headline "This tool won't open right now." Sub: "Something in its code needs fixing. The quickest fix is to let me do it." Primary: "Ask me to fix it". Secondary: "Try again". Raw output behind "Show details". | must-fix |
| 66 | `components/miniAppBuildState.tsx:47` | "Build failed (exit 1) with no output." | Fallback | Exit code. | "The build stopped without saying why." (behind details) | should-fix |
| 67 | `miniAppBuildState.tsx:76-80` | `BEING WRITTEN · 09:41` / "Claude is still writing this tool." / "It appeared here as soon as it was scaffolded, but its source has not been saved yet. This view will build it on its own the moment the file lands." | Tool opened before `src/App.tsx` exists | "Scaffolded", "source", "file lands"; "Claude" vs product voice. | `STILL WRITING · 09:41` / "I'm still writing this tool." / "It shows up here as soon as I start on it and will open on its own when I finish — usually a minute or two." | must-fix |
| 68 | `MiniAppViewer.tsx:1241-1243` | "Could not load application **{dirName}**." / "Expected: `/Users/…/src/index.html`" | Iframe load error | Internal directory name and absolute path; "application". | "This tool's page couldn't be opened. Try Rebuild, or ask me to fix it." (path in details) | must-fix |
| 69 | `MiniAppViewer.tsx:684,697` | `FIRST BOOT — INSTALLING 3 PACKAGES` + live `▸ Collecting pandas…` line | First open of a tool with deps | "Packages", raw pip/npm line. The checklist itself (DONE/INSTALLING…/QUEUED/FAILED) is good. | `SETTING UP — 3 THINGS TO INSTALL`; keep the live line behind "details". | should-fix |
| 70 | `MiniAppViewer.tsx:458` | `FIRST BOOT` chip | Header while installing | Boot = computers, not tools. | `SETTING UP` | should-fix |
| 71 | `MiniAppViewer.tsx:47-54` | Composer filled and SENT as the user: "An error occurred in mini-app `X`. Please fix or explain it. **Error type:** … **Stack trace:** ```…```" | "Ask to fix" from a tool runtime error | The scientist's own bubble becomes a stack trace; "mini-app". | Send a short user line ("Something went wrong in X — please fix or explain it.") and attach the technical report as a collapsed attachment/quote block. | should-fix |
| 72 | `MiniAppViewer.tsx:288`; `command-desk/ActivityPanel.tsx:162` | "The build for `dir` failed. Diagnose and fix it. Build output: …" / "The mini-app "X" (`.applications/dir`) fails to build. Please read its source, fix the problem, and rebuild it." | "Send to chat" / "Ask Claude to fix it" | Same issue: internals under the user's name. | As #71; the agent can find the build output itself from `tool-build-health.json`, or receive it as a quote block. | should-fix |
| 73 | `MiniAppViewer.tsx:596` | "Send to chat — let it fix itself" | Build-failed actions | "It" is ambiguous (the tool? the chat?). | "Ask me to fix it" | should-fix |
| 74 | `MiniAppViewer.tsx:540` | "View source" / "View tool" | More menu | Developer term; harmless in a menu but the source viewer that follows ("Empty directory.", "Select a file to view its contents.", L1384-1398) is a code browser. | "Show the code" / "Back to the tool"; consider hiding for this audience. | should-fix |
| 75 | `MiniAppViewer.tsx:495-499` | "Rebuild" | Header button | The only "build" word a user must learn; acceptable if the failure screen explains it. Elsewhere the agent tool says "Building tool"/"Tool built" (`tool-labels.ts:165-168`) — consistent. | keep, but tooltip "Reload this tool from its latest code". | fine |
| 76 | `MiniAppViewer.tsx:407-408`; `ActivityPanel.tsx:144-146` | "Stop this tool? It has been working for 3 minutes. Anything it has half-written will be left as it is." | Stop | Good. | keep | fine |
| 77 | `MiniAppViewer.tsx:40-42`; `ActivityPanel.tsx:62-65` | Job labels "Running code", "Claude request"; kinds `Command`, `Code`, `Claude`, `Agent` | Activity rows | "Command"/"Agent"/"Claude request" are internal. | "Running a step", "Writing with Acabox", "Working" — kind words: "Script", "Analysis", "Acabox", "Helper". | should-fix |
| 78 | `command-desk/ToolWorkspace.tsx:212` | "Drag to resize (320–560)" | Divider tooltip | Pixel range leaks implementation. | "Drag to resize" | should-fix |
| 79 | `ToolWorkspace.tsx:313` | `EMPTY` | Chat switcher row with no messages | OK mono label. | `NEW` | fine |
| 80 | `components/share/ToolShareHeaderControls.tsx:36` | `SHARED · BEHIND` | Header chip when the published copy is stale | "Behind" is git vocabulary. | `SHARED · OUT OF DATE` | should-fix |
| 81 | `components/share/SharePublishDialog.tsx:207` | Row label "Vendor" | Publish dialog size table | "Vendor" = bundled libraries, a build term. | "Libraries" | should-fix |
| 82 | `SharePublishDialog.tsx:256` | "Viewers need an @academia.edu Google account. Everything in the table is uploaded." | Publish dialog | Clear and honest. | keep | fine |
| 83 | `main/share/shareApiClient.ts:190` | "ShareApiClient: exhausted retries" | Publish failure after retries | Class name in a user error. | "Couldn't reach the sharing service after several tries. Check your connection and try again." | must-fix |

### 2.8 Activity and schedules

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 84 | `command-desk/ActivityPanel.tsx:194,200,241,265` | "Nothing running, and nothing waiting on you." · "Needs attention" · "Running now" · "Recently finished" | Activity | Excellent plain copy. | keep | fine |
| 85 | `ActivityPanel.tsx:77` | "Ran while Acabox was closed — result unknown" | Adopted job | Honest, good. | keep | fine |
| 86 | `ActivityPanel.tsx:210,214` | "This tool doesn't build, so it can't run. Last tried 4m ago." / "Ask Claude to fix it" | Broken tool row | "Build" is tolerable; "Claude" breaks voice. | "This tool won't open until its code is fixed. Last tried 4m ago." / "Ask me to fix it" | should-fix |
| 87 | `schedule/SchedulePanel.tsx:277` | "What should Claude do?" | Task editor | Voice. | "What should I do?" | should-fix |
| 88 | `SchedulePanel.tsx:285` | placeholder "Check the files in ~/Data for new results and tell me if anything looks wrong." | Task editor | `~/Data` tilde path. | "Check my Data folder for new results and tell me if anything looks wrong." | should-fix |
| 89 | `SchedulePanel.tsx:289-292` | "…It can do anything you could ask for in a chat — read your files, run code, and use your servers. Ask it to notify you and it will." | Task editor help | "Use your servers" is meaningless here. | "…read your files, run analyses, and use your connected services. Ask me to notify you and I will." | should-fix |
| 90 | `SchedulePanel.tsx:325-326` | "Each run is a real conversation with Claude, billed to your API key, and it happens whether or not Acabox is on screen." | Task editor | Right instinct (cost honesty); voice. | "Each run is a real chat with me and is billed to your Anthropic key, whether or not Acabox is open." | fine / voice |
| 91 | `SchedulePanel.tsx:42` | `Failed — ${run.error}` | Recent runs | Raw error in the row. | "Failed" + "Show details". | should-fix |
| 92 | `schedule/scheduleCron.ts:83-93` | "Must be a positive whole number" / "Must be a multiple of 5" / "Must be between 5 and 55" | Interval validation | Imperative but fine; the 5-minute step is unexplained. | "Minutes go in steps of 5 (5–55)." | fine |

### 2.9 Settings

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 93 | `components/DirectoryPermissions.tsx:190,192,219,226` | "Workspace directories" → "Local folders" → "No local directories added." → "Add folder" | Settings top | Three nouns for one thing in one card (workspace directories / local folders / local directories / folder). | Section "Your folders"; "No folders yet — add the folder your data lives in."; "Add folder". | should-fix |
| 94 | `DirectoryPermissions.tsx:117,103` | "Are you sure you want to remove this directory from your workspace?" / "This directory is already in your workspace." | Remove/add | "Directory", "workspace". | "Stop sharing this folder with Acabox? Your files are not touched." / "That folder is already added." | should-fix |
| 95 | `DirectoryPermissions.tsx:233,236,242` | "System prompt" / "Custom instructions appended to the AI system prompt for this workspace. Saved to .academia/SOUL.md." / placeholder "Enter custom instructions for the AI agent..." | Settings | "System prompt", "AI agent", a dotfile path. | Section "Instructions for Acabox"; "Anything I should always keep in mind — your field, preferred formats, house rules."; placeholder "e.g. Always report p-values to 3 decimals; our lab uses R-style column names." | must-fix |
| 96 | `DirectoryPermissions.tsx:274-285` | "About you" / "Two files Claude reads to know who you are and what you are working on: `about_you.md` and `working_on.md`, in `.academia/agent-memory/`. Claude writes other memories into that same directory on its own, and they are not shown here." / "See everything Claude has learned →" | Settings | File names and a hidden directory; "Claude". | "Who you are and what you're working on. I read these before every chat, and I add my own notes over time — see them under What I know." | should-fix |
| 97 | `DirectoryPermissions.tsx:367-373` | Section "Account" containing "Rescan workspace — Re-scan your folders to refresh your research profile and file tags." plus the API key | Settings | Rescan is not an account matter; "research profile and file tags" are internal artefacts. | Move Rescan under "Your folders" as "Look through my folders again"; section "Anthropic account & key". | should-fix |
| 98 | `components/ApiKeySettings.tsx:57` | "Active key: sk-ant-ap…x9Q2 (from settings) · https://…" | Settings → Account | "(from settings)" / "(from env)" is implementation provenance. | "Key saved" + masked tail; env case: "Key set by your system (ANTHROPIC_API_KEY)". | should-fix |
| 99 | `ApiKeySettings.tsx:64-65` | "The key is set via the ANTHROPIC_API_KEY environment variable and takes precedence. Unset it to manage the key here." | Env-managed key | Only developers hit this; acceptable, but could be shorter. | keep (power-user path) | fine-for-Debug-only |
| 100 | `ApiKeySettings.tsx:80` | placeholder "Base URL (optional — defaults to api.anthropic.com)" | Settings | Power-user field shown to everyone. | Hide behind "Advanced". | should-fix |
| 101 | `ApiKeySettings.tsx:58` | "No API key set. Paste one below to use Acabox." | Fresh install | Good; but there is no first-run nudge anywhere else (CLAUDE.md Known hazards). | Add a Home banner "Add your Anthropic API key to start" linking here. | should-fix (gap) |
| 102 | `DirectoryPermissions.tsx:339,346,353,360` | Section labels "Connectors", "Claude Design", "APIs", "Sharing" | Settings | Three of four are jargon or product names; the two service sections are siblings the audience cannot distinguish. | "Connected services" (one section with two sub-tabs: "Apps" = MCP connectors, "Web APIs"), "Claude Design" → hide unless the user has a claude.ai design project (owner call), "Sharing" keep. | should-fix (structural) |
| 103 | `components/ConnectorsSettings.tsx:220-222` | "Connect Acabox to external services over MCP. Anything you connect becomes a set of tools the agent can call in chat. Changes apply to open chats straight away." | Connectors intro | "Over MCP", "the agent". | "Connect services like Hex, Notion or GitHub so I can use them in chat. Changes take effect straight away." | must-fix |
| 104 | `ConnectorsSettings.tsx:246` | chip `HTTP` / `SSE` (transport) | Every connector row | Protocol names as a status chip. | Remove from the row; keep inside Edit. | must-fix |
| 105 | `ConnectorsSettings.tsx:253,259` | "Not checked · last seen 09:41" · "ask in chat: "authenticate the hex connector"" | Row status | The sign-in instruction is a magic phrase the user must type. | Add a "Sign in" button that sends that phrase for them. | should-fix |
| 106 | `ConnectorsSettings.tsx:308-311` | "Status read live from the running agent." / "Status from the last chat session (09:41). Start a chat for live state." / "No chat session has run yet, so no status has been observed." | Status footer | "Agent", "chat session", "observed". | "Checked just now." / "Last checked 09:41 — open a chat to check again." / "Not checked yet — open a chat and I'll check." | should-fix |
| 107 | `ConnectorsSettings.tsx:451`; `servers/ServerConfigForm.tsx:181`; `ApiSettings.tsx:464` | "The agent calls its tools as `mcp__hex__…`" / "Claude calls it as `$ACABOX_API_BASE/hex/…`" | Name field help | Pure implementation. | "Short name, letters and hyphens — e.g. hex." | must-fix |
| 108 | `ConnectorsSettings.tsx:462-463` | "Transport: HTTP (remote) / SSE (remote)" | Custom connector form | Jargon; only matters for power users. | Hide under "Advanced" with a one-line gloss. | should-fix |
| 109 | `ConnectorsSettings.tsx:519-523` | "Leave empty for services that sign in with OAuth — the agent handles that in chat. Tokens are encrypted with your macOS keychain…" | Headers help | "OAuth", "the agent", "tokens". | "Leave empty if the service asks you to sign in through your browser — I'll handle that in chat. Keys are encrypted in your Mac's keychain and never shown again." | should-fix |
| 110 | `ConnectorsSettings.tsx:533-536` | "Always load this server's tools — Off by default: tools stay behind tool search, which keeps them out of every prompt. Turn on only if the agent keeps missing them." | Form | "Tool search", "prompt", "the agent". | "Always keep this service's tools ready — Off by default to keep chats fast. Turn on only if I keep forgetting this service exists." | should-fix |
| 111 | `ConnectorsSettings.tsx:394-404` | "Unmanaged servers in the workspace — `.mcp.json` declares `x`. Acabox loads it, but it isn't managed here — and the agent can write that file itself. Remove it unless you put it there deliberately." / "Remove file" | Rare | Security warning in developer words. | "A connection file I didn't set up was found in your workspace (.mcp.json, naming x). If you didn't add it yourself, remove it." | should-fix |
| 112 | `ConnectorsSettings.tsx:173-174` | "Saved and applied to open chats." / "Saved. It will apply when the agent next starts." | After save | "The agent". | "Saved — it applies to open chats." / "Saved — it applies from your next chat." | should-fix |
| 113 | `shared/connectors.ts:370-380` | "Connected", "Needs authentication", "Failed", "Connecting…", "Disabled", "Unknown" | Row status | "Needs authentication" → "Needs sign-in"; "Unknown" is honest but unhelpful. | "Needs sign-in"; "Not checked yet". | should-fix |
| 114 | `components/ApiSettings.tsx:257-260` | "HTTP APIs Claude may call directly, for services with no MCP connector — or where the connector is read-only and the REST API isn't. Acabox holds the credentials and attaches them itself, so a key is never shown to the agent, written into a script, or stored in a chat." | APIs intro | Sentence one is for engineers. Sentence two is the point and is good. | "Online data services I can use — PubMed, UniProt, Zenodo and more. Acabox keeps the keys; I never see them, and they never end up in a chat or a file." | must-fix |
| 115 | `ApiSettings.tsx:265-271` | "The API proxy isn't running" / "It starts with the agent — open a chat, or restart Acabox." / "Nothing configured here can be called until it does, and Claude is not told the APIs exist." | Banner when proxy down | "Proxy"; CLAUDE.md records the advice as wrong. | "These services aren't reachable right now. Quit and reopen Acabox; if this keeps happening, [details]." | must-fix |
| 116 | `ApiSettings.tsx:291,295` | chips `READ & WRITE` / `READ ONLY` · `KEY SET` / `NO KEY` | Rows | Good mono statuses. | keep | fine |
| 117 | `ApiSettings.tsx:123` | "3 calls since launch · 1 refused · last 404" | Row meta | HTTP code. | "3 uses since Acabox opened · 1 blocked" (code in tooltip). | should-fix |
| 118 | `ApiSettings.tsx:317` | tooltip "Send one real GET at the base URL" / "The proxy is not running" | Test button | "GET", "proxy". | "Check that this service answers with your key" | should-fix |
| 119 | `ApiSettings.tsx:480-482` | "Requests resolve against this, and on this host they may not escape its path — so a trailing slash matters. https:// only, except localhost." | Base URL help | Engineer-only. | "Paste the address from the service's documentation. It must start with https://." (rest behind Advanced) | should-fix |
| 120 | `ApiSettings.tsx:493-497` | "None — public API" / "Bearer token (Authorization: Bearer …)" / "Custom header" / "Query parameter" / "HTTP Basic" | Authentication select | HTTP auth vocabulary. For catalog entries this is prefilled, so hide it; for Custom it is unavoidable but glossable. | "No key needed" / "Key sent as a bearer token (most common)" / "Key sent in a named header" / "Key added to the web address" / "Username and password". | should-fix |
| 121 | `ApiSettings.tsx:532-538` | "leave blank for key-as-username … Benchling and Stripe both work that way" | Basic auth help | OK for the people who need it. | keep | fine-for-Debug-only |
| 122 | `ApiSettings.tsx:569-580` | "Extra allowed hosts … A leading dot matches subdomains (.zenodo.org covers files.zenodo.org)." | Form | Engineer-only; prefilled from the catalog. | Move under Advanced. | should-fix |
| 123 | `ApiSettings.tsx:585-595` | "Notes for Claude" / "Goes into the prompt verbatim. This is the field that stops Claude guessing endpoints…" | Form | Voice; "prompt", "endpoints". | "Notes for me" / "What this service is for and anything I should know — one sentence here saves a lot of guessing." | should-fix |
| 124 | `ApiSettings.tsx:607-612` | "Allow writes — Off by default: only GET and HEAD are permitted, and anything else is refused by Acabox before it reaches the network. Turn this on only for an API you intend Claude to change things in — a page it reads mid-task could otherwise talk it into a DELETE." | Form | Right idea, HTTP verbs. | "Allow changes — Off by default, so I can only read from this service. Turn on only if you want me to create or delete things there." | should-fix |
| 125 | `shared/apis.ts:827-902` (`interpretApiTest`) | "Working — the server accepted your credential." / "The server rejected the credential (HTTP 401). Check the key and the auth style." / "Reached it — HTTP 200, but the same request works without your key, …" | Test result | Good verdict copy; HTTP codes could go in details. | keep; "auth style" → "sign-in method". | fine |
| 126 | `components/SharingSettings.tsx:88-93` | "Publish a mini-app or a single workspace file as a read-only, login-gated link on your own Cloudflare Workers deployment — setup lives in `src/share-workers/README.md`. Viewers sign in with an @academia.edu Google account, and Cloudflare Access is free for the first 50 viewers." | Sharing intro | Points a scientist at a source file in the repo; "mini-app", "Workers deployment", "login-gated". | "Share a tool or a file as a private link that only @academia.edu accounts can open. Someone technical sets this up once (ask them for the two addresses and the token)." | must-fix |
| 127 | `SharingSettings.tsx:100-135` | "Site URL", "API URL", "Publish token", placeholder "https://acabox-share.<account>.workers.dev" | Sharing form | Unavoidable for setup; label them as "from your administrator". | keep, add the gloss. | fine |
| 128 | `SharingSettings.tsx:81`, `:163` | test result "HTTP 401: …"; tooltip "Send one real GET at /v1/health" | Test | Codes/paths. | "Couldn't sign in to the sharing service — check the token." | should-fix |
| 129 | `components/ClaudeDesignSettings.tsx:83-87` | "Not signed in. Sign in to let chats read your claude.ai/design design-system projects." | Settings | A designer/engineer feature; "design-system projects" means nothing to the audience. | Hide the section unless enabled under Advanced (owner call). | should-fix |
| 130 | `components/SetupBanner.tsx:44-58` | "Downloading Podman...", "Setting up Podman...", "Initializing Podman VM...", "Starting Podman VM...", "Downloading base image..." | Never — main only emits stage `ready` (`main/containerService.ts:193`) | Dead Podman copy left in a mounted component; the only live branch is the "Setup error" banner (L111-123) which prints a raw error. | Delete the dead stages; rewrite the error banner "Acabox couldn't finish starting: {plain reason}. Retry." | dead-code / must-fix |

### 2.10 Knowledge

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 131 | `components/knowledge/KnowledgePage.tsx:312-315` | "Knowledge" / "What Claude can do here, and what it has learned. All of it is markdown you can read and correct." | Page header | "Claude"; "markdown". | "What I know" / "The skills I can use here and the notes I've kept. You can read and correct all of it." | should-fix |
| 132 | `KnowledgePage.tsx:681` | placeholder `coscientist-analytics` | Add a skill → Name | Internal Academia/Coscientist example. | `qpcr-analysis` | must-fix |
| 133 | `KnowledgePage.tsx:701` | placeholder "How to analyse Co-Scientist product data in Redshift through the Hex connector." | Add a skill → When should Claude use it? | Internal company data warehouse example; a scientist will copy its shape. | "How to normalise and plot qPCR results from our plate reader exports." | must-fix |
| 134 | `KnowledgePage.tsx:685-686` | "…This is the name Claude types to load it, and it is the directory name on disk." | Name help | "Directory name on disk". | "Short name, lowercase with hyphens." | should-fix |
| 135 | `KnowledgePage.tsx:693,727` | "When should Claude use it?" / "Ask Claude to write it" | Add a skill | Voice. | "When should I use it?" / "Ask me to write it" | should-fix |
| 136 | `KnowledgePage.tsx:84` | BROKEN chip tooltip "The CLI drops a skill whose frontmatter will not parse, silently." | Broken skill | "CLI", "frontmatter", "parse". | "This skill's header is malformed, so I can't load it." | must-fix |
| 137 | `KnowledgePage.tsx:384` | "Frontmatter did not parse: {js-yaml message}. Claude will not see this skill at all." | Broken skill row | Same, plus a YAML parser message inline. | "The header of this skill is malformed, so I can't use it." + details. | must-fix |
| 138 | `KnowledgePage.tsx:154-160` | meta `SKILL.md 4.2 KB · 12 files · desc 180 chars · imported 3d ago` | Every skill row | File names and character counts. | `12 files · added 3d ago` (char count only when over budget: "description too long"). | should-fix |
| 139 | `KnowledgePage.tsx:75-77,395-396` | OFF chip "Not in the roster, so Claude will not see it listed." · "3 of 5 on the roster. A skill that is off keeps its files and stays readable; Claude just stops seeing it listed." | Rows/footer | "Roster" is an internal term for the always-in-context list. | "Off — I won't use it until you turn it back on." · "3 of 5 turned on." | should-fix |
| 140 | `KnowledgePage.tsx:102-110` | `3 FINDINGS` ("Things Claude discovered while working and wrote back into this skill."), `2 SCRIPTS` ("Runnable files. They run with your privileges the moment Claude invokes one.") | Chips | Findings tooltip is good; "privileges"/"invokes" is legalese. | "2 scripts — these can run on your Mac when I use this skill." | should-fix |
| 141 | `KnowledgePage.tsx:370` | "No skills in the store." | Empty | "Store" is the internal directory name. | "No skills yet." | should-fix |
| 142 | `KnowledgePage.tsx:428` | " · not indexed in MEMORY.md" | Memory rows | File name. | " · not linked from my notes index" or hide. | should-fix |
| 143 | `KnowledgePage.tsx:558,571` | "This chat queried hex without consulting the ledger" / "Ask Claude to extract it" | Needs attention | "Ledger", "queried", "extract". | "A chat used Hex without checking what I already know about it" / "Ask me to save what I learned". | should-fix |
| 144 | `KnowledgePage.tsx:527` | "F-12 / F-14 may say the same thing in hex-warehouse" | Needs attention | Finding ids. | "Two notes in hex-warehouse may overlap" | should-fix |
| 145 | `KnowledgePage.tsx:352-356` | "Add a skill — A skill is a folder of instructions Claude loads when it decides the job needs them — a warehouse's traps, a house query form, a procedure worth getting right twice." | Card | The examples are data-engineering; the definition is good. | "…a lab protocol, a plotting style, a procedure worth getting right twice." | should-fix |
| 146 | `KnowledgePage.tsx:452` | "Claude reaches Hex and other services through Connectors →" | Footer link | Voice. | "I reach Hex and other services through Connected services →" | should-fix |
| 147 | `components/knowledge/KnowledgeDetail.tsx:90,308` | Title `xlsx/SKILL.md`; "Frontmatter" label | Detail modal | File path as title; YAML term. | Title = skill name; "Header" or hide the fence. | should-fix |
| 148 | `KnowledgeDetail.tsx:329-334` | "This file changed on disk while you had it open. The copy on disk is now 4.1 KB and it is not what you opened. Claude can write here directly, so this is most likely its work. Nothing has been saved." / "Take the new version" / "Keep mine" | Save conflict | Good structure; "on disk", "Claude". | "This changed while you had it open — probably by me during a chat. Nothing has been saved yet." | fine / voice |
| 149 | `KnowledgeDetail.tsx:363,390,233` | Table "ID · Finding · Scope · Recorded · Last read"; button "Supersede"; confirm "Mark F-12 superseded? … Its body moves to the archive file and its index row moves with it." | Findings tab | "Supersede", "index row". | "Retire this note" / "Retire F-12? It moves to the archive; nothing is deleted." | should-fix |
| 150 | `KnowledgeDetail.tsx:440` | "Ask Claude to improve this" | Footer | Voice. | "Ask me to improve this" | should-fix |
| 151 | `components/knowledge/KnowledgeRow.tsx:85` | "The skill's frontmatter declares this name; the directory name is what Claude calls." | Alias tooltip | Jargon. | "Also called {alias} inside the skill." | should-fix |
| 152 | `components/knowledge/ImportSkillPanel.tsx:127,140,243` | "Resolving the commit…" / "Downloading the repository…" / "Import, off the roster" | Import flow | Git vocabulary; "roster". | "Checking the link…" / "Downloading…" / "Import (turned off until you enable it)". | should-fix |
| 153 | `ImportSkillPanel.tsx:304-330` | "GitHub link" … "Whatever you paste, the branch is resolved to a commit and it is the commit that gets recorded — so the import is reproducible even after the branch moves." | Import | Git concepts. | "Paste a GitHub link to a skill or a collection of skills." (reproducibility note behind "Why this is safe to re-run"). | should-fix |
| 154 | `ImportSkillPanel.tsx:397,540,555-562` | "581 skills · 21.7 MB downloaded once"; "1 symlink was removed…"; "Bash is auto-approved in Acabox with no permission handler… equivalent to `curl … | sh` from that repository…" | Preview | The disclosure is deliberately verbatim (design decision) but its reference points — Bash, permission handler, `curl | sh` — mean nothing to this audience, so it does not actually warn them. | Keep the fact, change the frame: "Importing a skill is like installing software from a stranger: once it's on, I will follow its instructions and may run its scripts on your Mac with your access. Only import from people you trust." | should-fix |
| 155 | `main/knowledge/skillImporter.ts:593-606` | "Claude cannot read this skill's frontmatter (…). It will still load, but with a description invented from the first heading of the body." / "The description is 240 characters; the spec caps it at … and it competes with every other skill for the roster budget." | Import problems | "Frontmatter", "roster budget", "spec". | "This skill's header is malformed; I'll guess its purpose from its first heading." / "Its description is long, which slows every chat a little." | should-fix |

### 2.11 Servers

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 156 | `components/servers/ServersPage.tsx:287-292` | `2 SERVERS RUNNING HERE` / "Servers" / "Local MCP servers Acabox runs on this machine — separate from Connectors, which are remote services Acabox connects to." | Page header | The subtitle exists because the split is invisible to users; "MCP". | "Add-ons I run on this Mac" — or merge with Connectors (§5). | should-fix (structural) |
| 157 | `ServersPage.tsx:319-338` | "No servers yet. Ask Claude to build one for you — describe what you need in a chat and it can write and run a small server." / "Open chat" / "Claude just built one? Check now" / "Advanced: add a server yourself" | Empty state | The intent is right; "server" is still undefined for the reader, and "Claude" x2. | "Nothing here yet. If you need me to talk to a program or database on this Mac, ask me in chat and I'll build the bridge." / "Ask in chat" / "I just built one? Check now" | should-fix |
| 158 | `ServersPage.tsx:81-83` | row meta `pid 41823 · 3 tools · node index.mjs` / `(no command)` | Every running row | Process id and command line on a list row. | `3 tools · started 09:41` (command in detail → Advanced). | must-fix |
| 159 | `ServersPage.tsx:390-392` | "Small local servers Claude has written into your workspace, waiting for you to review. Nothing here runs until you enable it — Acabox then copies the files out and runs that copy, so editing them afterwards changes nothing until you approve again." | Authored by Claude | Good safety message; "workspace", "copies the files out". | "Bridges I wrote for you, waiting for your OK. Nothing runs until you turn it on; after that, changes I make need your OK again." | should-fix |
| 160 | `ServersPage.tsx:403,408,264` | chip "Awaiting review"; "Review & enable"; action "Re-promote" ("Copy the changed files from the workspace and restart with them.") | Rows | "Re-promote" is internal pipeline vocabulary. | "Approve changes" | should-fix |
| 161 | `ServersPage.tsx:417` | "Remove "x"? Acabox won't offer to adopt this workspace directory again." | Confirm | "Adopt", "workspace directory". | "Remove "x"? I won't suggest it again." | should-fix |
| 162 | `ServersPage.tsx:433`; `main/mcpHost/authored.ts:166-198` | "2 items in .mcp-servers could not be adopted: "foo" — No manifest.json in this directory.; "bar" — manifest.json is not valid JSON: Unexpected token…" | Rejected note | Developer diagnostics shown as prose. | Hide behind "Show details"; headline "2 folders here aren't valid bridges". | should-fix |
| 163 | `ServersPage.tsx:457-466` | "published by coScientistSpendExplorer · 2 tools" / "A tool publishes its server while it is open and withdraws it when you close it. Claude can only call these while the tool is on screen…" | Published by your tools | Directory name instead of the tool's display name; "server", "Claude". | Use the tool's name; "I can use these only while the tool is open." | should-fix |
| 164 | `components/servers/ServerDetail.tsx:169-172,177-186,258-259` | "Command — as typed: node index.mjs / argv: ["node","index.mjs"]" · "Working directory … (no cwd set)" · "Environment — No environment variables." · "Log" (stderr tail, "(nothing written yet)") | Detail panel | Terminal concepts throughout. | Collapse all four under "Technical details"; show Status, Tools, actions. | should-fix |
| 165 | `ServerDetail.tsx:199` | "Never read — the server has not started." | Tools section | "Read" is ambiguous. | "Not started yet, so I don't know its tools." | should-fix |
| 166 | `ServerDetail.tsx:306-311`; `ServerConfigForm.tsx:294-311` | "Resolved to `/opt/homebrew/bin/node`" · "Acabox could not read your login shell's PATH — this used a fallback." · "It answered, but offered no tools." · "Started successfully." | Test result | "Login shell's PATH". | "Acabox couldn't see all the programs installed on your Mac, so it used a fallback." (details). | should-fix |
| 167 | `components/servers/ServerConfigForm.tsx:163-169` | "Add a server (advanced)" / "Most people never need this form — describe what you want in a chat and Claude can write and run a small server for you. This is the manual path: a command Acabox will run directly, with no shell in between." | Advanced form | Right framing; voice. | keep, "Claude" → "I". | fine / voice |
| 168 | `ServerConfigForm.tsx:178,204,216,241` | placeholders `filesystem`, `npx`, `-y`, `API_TOKEN` | Advanced form | Only reachable via "Advanced", acceptable. | keep | fine-for-Debug-only |
| 169 | `shared/mcpServers.ts:66-74` | "Available", "Starting", "Stopped", "Not checked", "Off", "Needs sign-in", "Failed" | Rows | Plain words — good. | keep | fine |
| 170 | `main/mcpHost/diagnose.ts:72,93,121,132` | "Acabox could not find "x". It is not installed, or not on the path Acabox sees." / "Started, but never answered. It may be waiting for a password or a browser sign-in." / "Exited immediately and said nothing (exit code 1)." / "This server ships a compiled add-on built for a different version of Node…" | Failed row reason | Mostly plain; the Node add-on one is for the person who built it. | keep; move exit code to details. | fine |
| 171 | `main/mcpHost/authored.ts:137`, `mcpHost/index.ts:109` | "Hosted MCP servers are disabled on this machine: the OS keyring is not available, so server configs cannot be sealed at rest." | Rare | "Keyring", "sealed at rest". | "Acabox can't run add-ons on this Mac because it can't store their settings securely (no keychain)." | should-fix |

### 2.12 Files and notebooks

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 172 | `components/FilesTab.tsx` (no empty state found; root row only) and `renderer/index.tsx:1331-1332` | `0 FILES` / "Files" with an empty tree | New user | Nothing says how to get files in. | "No folders yet — add one in Settings → Your folders, and your files will show here." | must-fix |
| 173 | `FilesTab.tsx:730` vs `MiniAppViewer.tsx:548`, `KnowledgeDetail.tsx:432`, `ToolsPage.tsx` ("Reveal in Finder" title) | "Show in Finder" vs "Reveal in Finder" | Context menus | Two labels for one action. | "Show in Finder" (Apple's wording). | should-fix |
| 174 | `FilesTab.tsx:551` vs `:692,695` | "New folder" (tooltip) vs "New File" / "New Folder" (menu) | Toolbar/menu | Title-case inconsistency. | Sentence case everywhere. | should-fix |
| 175 | `FilesTab.tsx:719` | "Remove Tag" | Context menu | Tags are a scanner artefact the user never created. | "Remove label" or hide. | should-fix |
| 176 | `FilesTab.tsx:946-951` | "Open in Word" (`fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word')`) | .docx rows | Only one app gets a dedicated button; leftover from the dropped Word overlay. | "Open in default app" for every file type, or drop. | should-fix |
| 177 | `components/FileViewer.tsx:65,75` | "Couldn't open this file. {readError}" / "File is too large to view (120.3 MB)" | Viewer | Good; raw reason appended. | keep; put `readError` behind details. | fine |
| 178 | `components/fileViewers/XlsxView.tsx:62,68,118`, `CsvView.tsx:50` | "Parsing spreadsheet…" / "Workbook contains no visible sheets." / "Sheet is empty." / "CSV is empty." | Viewer | "Parsing". | "Opening spreadsheet…"; rest fine. | fine |
| 179 | `components/notebook/NotebookViewer.tsx:302` | "Starting kernel... (this may take a moment if the container is starting)" | Notebook open | Stale container reference; "kernel". | "Starting Python…" | must-fix |
| 180 | `NotebookViewer.tsx:307-308`, `:282,286`; `NotebookCell.tsx:264` | "Kernel failed to start" + raw `kernel.error`; "Interrupt kernel" / "Restart kernel" / "Interrupt" | Notebook | "Kernel" everywhere. | "Python couldn't start" + details; "Stop" / "Restart Python". | should-fix |
| 181 | `renderer/tabs/TabBar.tsx:75` | "This will shut down the running kernel and lose any in-memory state. Close anyway?" | Closing a notebook tab | Jargon. | "Closing this notebook stops its Python session and clears unsaved results. Close anyway?" | should-fix |
| 182 | `components/notebook/useNotebook.ts:49-68`; `kernelRegistry.ts:229` | "File too large to open" / "Cannot read notebook file" / "Invalid notebook JSON" / "No kernel connection — is the kernel gateway running?" | Notebook errors | "JSON", "kernel gateway". | "This notebook file is damaged and can't be opened." / "Python isn't running — try Restart Python." | should-fix |
| 183 | `main/containerService.ts:1030-1032,1039` | "Kernel gateway exited before becoming healthy (code=1, signal=null). Is jupyter installed in /Users/…/python-venv?" / "Kernel gateway failed to become healthy within 15s" | Notebook/tool kernel start failure | Pure ops text, with a path. | "Acabox couldn't start Python for this notebook. Quit and reopen Acabox; if it still fails, [details]." | must-fix |

### 2.13 Dialogs, updater, error boundary, quit

| # | Where | Current text | Seen when | Problem | Rewrite | Class |
|---|---|---|---|---|---|---|
| 184 | `components/ErrorBoundary.tsx:50-66` | "Something went wrong." / "The error has been reported. Reloading usually clears it." + raw `error.message` in a `<pre>`; styled with `system-ui`, Tailwind hexes | Renderer crash | Raw message in view; off the design system. | Keep headline; move message under "Details"; use design tokens. | should-fix |
| 185 | `renderer/update.tsx:60,70,79`; `main/updater.ts:48,119-121` | "Update v0.1.28 is available." / "Download & Restart" / "Downloading update... 42%" / "Update error: {errorMessage}" / "No Updates Available — You're on the latest version" | Updater | Fine except the raw error. | "Couldn't download the update. Try again later." + details. | should-fix |
| 186 | `main/index.ts:3572-3581` | Quit: "1 tool is still working." / "N pieces of work are still running." / "This work will keep running in the background and finish on its own. Acabox will show you what happened the next time you open it." / buttons Quit · Stop them and quit · Cancel | Quit with work in flight | Excellent. | keep | fine |
| 187 | `main/index.ts:1692` | "Container is not running" (thrown from `container:ensureAppDeps`) | Tool dependency install while host service is down | Stale container reference, reaches the renderer as an invoke error. | "Acabox is still starting — try again in a moment." | must-fix |
| 188 | `main/packageInstaller.ts:185,290,331,371` | "Container restarted; install state reset" / "npm is not installed. Install Node.js (https://nodejs.org or "brew install node") and try again." / "pip install exited with code 1" / "apt installs are not supported on host. Install the dependency manually and re-open the app." | Install failures (FAILED row, agent) | Container (stale); brew/npm instructions aimed at developers; exit codes. | "This tool needs Node.js, which isn't installed on your Mac. Ask me and I'll explain how to install it." / "Couldn't install {pkg}" + details. | should-fix |
| 189 | `main/miniAppBuilder.ts:75,82` | "esbuild executable not found. Looked in: …" / "Mini-application directory not found: .applications/x" | Build failure | Internal paths; mostly agent-facing but reaches BuildErrorView. | Headline "Acabox's build tool is missing — reinstall Acabox." / "This tool's folder is missing." | should-fix |
| 190 | `renderer/attachmentAdapter.ts:207` | "File is too large (42.0 MB). Maximum allowed size is 30 MB." | Attaching a big file | Clear; could suggest the alternative. | "…Put it in one of your folders instead and I'll read it from there." | fine |

### 2.14 Debug tab (fine-for-Debug-only, with stale items)

| # | Where | Current text | Problem | Action |
|---|---|---|---|---|
| 191 | `components/debug/DebugPanel.tsx:16-26` | "Logs · Kernels · Observations · File Monitor · Storage · API Key · Scanned Files · Telemetry · Export · Hard Reset" | Fine for a Debug tab; the tab itself should not be in the rail (#3). | hide rail entry |
| 192 | `components/debug/StorageDebug.tsx:57-59` | "Podman Binaries — Downloaded podman, gvproxy, vfkit" / "Config & VM Images" / "VM State & Sockets" | Podman is gone; these rows offer to delete things that don't exist. | delete (stale) |
| 193 | `components/debug/HardResetDebug.tsx:66-70` | "All chats and message history · All briefings · All calendar events, plans, and resources · All applications in .applications/ · All workspace configuration in .academia/" | Briefings and calendar were removed; the list is false. | fix list |
| 194 | `components/ContainerTests.tsx` (whole file, not imported anywhere) | "Workspace mount (/data)", "R runtime", "DESeq2…", "Write a file inside the container…" | Dead, Podman-era. | delete |

---

## 3. Naming inconsistency matrix

| Concept | Words in use (file:line) | Recommendation |
|---|---|---|
| The thing Claude builds | **Tools** (rail, Home, Tools page, viewer); **mini-app** (`MiniAppViewer.tsx:47` error prompt, `ActivityPanel.tsx:162`, `SharingSettings.tsx:88`, `miniAppBuilder.ts:82` "Mini-application"); **application** (`MiniAppViewer.tsx:1241`); **app** (step card name `app`, `tool-card-display.ts:83-85`; `ToolsPage.tsx` "Create a tool for me"); **instruments** (design brief only — grep finds 0 user-facing uses, good) | "Tool" everywhere a user can read; "mini-app" only in code. |
| A conversation | **Chats** (rail, pages, header); **CONVERSATIONS** (`thread-list.tsx:102`, L358); **session** (`ConnectorsSettings.tsx:310-311` "chat session", `agentSession.ts:199` "previous session"); **thread** (code only) | "Chat" / "chats". |
| External services | **Connectors** (Settings), **Servers** (rail, page), "MCP servers" (both intros), "remote services" (`ServersPage.tsx:291,499`), "external services" (`ConnectorsSettings.tsx:220`), "APIs" (Settings), "your servers" (`SchedulePanel.tsx:292`), "connected services" (nowhere yet) | One umbrella: "Connected services" with sub-kinds "Apps" (MCP), "Web APIs", "Running on this Mac". |
| Skills & memory | **Knowledge** (rail/page), **skills** (rows, chips, confirms), **memories** (stat, section), "roster" (`KnowledgePage.tsx:75,395`, `ImportSkillPanel.tsx:243`), "store" (L370), "ledger"/"findings" (L558, KnowledgeDetail) | Page "What I know"; "skills" and "notes"; retire roster/store/ledger from UI. |
| Folders | **Workspace directories** (`DirectoryPermissions.tsx:190`), **Local folders** (L192), **local directories** (L219), **folder** (L226, Home L185 "share a folder"), **workspace** (`ConnectorsSettings.tsx:394`, `ServersPage.tsx:390`, Rail footer path), "shared folders" (chips, `thread.tsx:104`) | "Your folders" for the user's dirs; never "workspace" in UI. |
| Build words | **Rebuild** (viewer header, build-failed CTA), **Build failed** (chips, screens), **Building tool / Tool built** (step labels), "rebundle" (`MiniAppViewer.tsx:587`), "scaffolds" (`CommandDesk.tsx:150`, `miniAppBuildState.tsx:79`), "doesn't build" (Activity) | Keep "Rebuild"/"Build failed" as the one pair; delete rebundle/scaffold. |
| Run words | **Run** (notebook cell `NotebookCell.tsx:277`, "Run all cells", "Run now" schedule), **Execute** (debug/ContainerTests only), **Use** (Tools row button `ToolsPage.tsx:467`), **Open** (Home card, Activity rows) | "Open" for tools (a tool is a place), "Run" for notebooks/schedules; drop "Use". |
| Working states | `GENERATING` (header chips), `THINKING…`/`WORKING — …` (thread), `WORKING` (tool chips, status bar), "Working" (dot tooltip), "Running now" (Activity), `INSTALLING…`/`FIRST BOOT`/`BUILDING`/`BEING WRITTEN` (viewer) | `WORKING` as the one chip word; `THINKING…` only inside the thread; `SETTING UP` for first-open installs; `STILL WRITING` for awaiting-source. |
| "Show in Finder" | "Show in Finder" (`FilesTab.tsx:730`), "Reveal in Finder" (`MiniAppViewer.tsx:548`, `KnowledgeDetail.tsx:432`, `ToolsPage.tsx:610` title), "Finder" (`ToolsPage.tsx:614`) | "Show in Finder". |
| New chat | "New chat" (`ChatHeader.tsx:113`, `ToolWorkspace.tsx:296,319`), "New Chat" (`thread-list.tsx:237`, `chatRepository.ts:5`) | "New chat". |

## 4. "Claude" vs "Acabox" in the UI

The agent is instructed to speak as Acabox and never as Claude (`skills/acabox/SKILL.md:41-42`); the Tools page and Chats subtitle already use "I"/"me" (`ToolsPage.tsx:388,398`, `thread-list.tsx:198`). The rest of the renderer names **Claude** in roughly 45 user-visible strings, so the product contradicts itself inside one screen: a scientist reads "Ask me to build one" on Tools and "Ask Claude to fix it" on Activity.

User-visible "Claude" (excluding the model picker's model names and the "Claude Design" product name, which are legitimately Anthropic's): `miniAppBuildState.tsx:77`; `ActivityPanel.tsx:64,214`; `SchedulePanel.tsx:277,325`; `DirectoryPermissions.tsx:277,279,285`; `ApiSettings.tsx:257,270,585,591,594`; `KnowledgePage.tsx:68,77,104,110,248,269,314,355,384,414,452,571,641,685,693,701,727`; `KnowledgeDetail.tsx:333,440`; `KnowledgeRow.tsx:85`; `ImportSkillPanel.tsx:508,559`; `ServersPage.tsx:319,335,390,463`; `ServerConfigForm.tsx:167,271`; `main/miniAppBuilder.ts:107`; `main/knowledge/skillImporter.ts:593,601`; `main/skillStore.ts:1105`; `main/mcpHost/authored.ts:560`; `chatPreviewStore.ts:69` (`CS:` = the older Coscientist name).

Recommendation (owner decision, see Open questions): pick one. If "Acabox" is the agent's name, every "Claude" above becomes "I"/"me"/"Acabox", `CS:` becomes `Acabox:`, and "Claude" survives only in the model picker ("Powered by Claude Opus 5.5") and in Settings → Account ("Anthropic API key").

## 5. Structural recommendations

### 5.1 Rail and page names

| Now | Proposed | Why |
|---|---|---|
| Home ("Command desk") | Home | The page title should match the rail. |
| Chats (`0 CONVERSATIONS`) | Chats (`0 CHATS`) | One noun. |
| Tools | Tools | Keep. |
| Knowledge | What I know (or Skills & notes) | Says what is inside. |
| Servers + Settings → Connectors + Settings → APIs | **Connected services** (one page; three groups "Apps I can use" / "Web data services" / "Running on this Mac"; "Add a service" picks the kind) | The current split (remote MCP vs local MCP vs HTTP) is an implementation taxonomy; both pages carry a footer link to the other because users land in the wrong one. |
| Files | Files | Keep; add empty state. |
| Activity | Activity | Keep (copy is the best in the app). |
| Debug (rail footer, every user) | Remove from rail → Settings → Advanced → "Open diagnostics" | A developer console is not navigation. |
| Settings sections: Workspace directories · System prompt · About you · Connectors · Claude Design · APIs · Sharing · Account | Your folders · Instructions for Acabox · About you · Connected services · Sharing · Anthropic key · Advanced (Claude Design, base URL, diagnostics) | Plain nouns; power-user items grouped. |

### 5.2 Raw technical output that should sit behind a plain headline and a "Details" disclosure

| Output | Where it is shown raw today | Headline to show instead |
|---|---|---|
| esbuild build output | `MiniAppViewer.tsx:588` `<pre>{message}</pre>`; also pasted into the user's chat bubble at L288 and `ActivityPanel.tsx:162-165` | "This tool won't open right now." + "Ask me to fix it" |
| pip/npm live install line | `MiniAppViewer.tsx:697` | "Setting up — installing 2 of 3" |
| Agent/host errors (`emitError` strings, SDK errors, "failed to become healthy within 15s", `Failed to authenticate. API Error: 401`) | chat bubble via `thread.tsx:325-333` | "Acabox's assistant isn't responding. Try again; if it keeps happening, quit and reopen." |
| Kernel gateway errors with venv paths | `NotebookViewer.tsx:308`, `containerService.ts:1030-1039` | "Python couldn't start." |
| `argv: [...]`, `pid`, working directory, environment keys, stderr "Log" | `ServerDetail.tsx:169-259`, `ServersPage.tsx:81` | Status + tools only; "Technical details" fold |
| Manifest/JSON rejection reasons | `ServersPage.tsx:433`, `authored.ts:166-198` | "2 folders here aren't valid add-ons." |
| `Failed — ${run.error}` | `SchedulePanel.tsx:42` | "Failed" |
| Connector `· ${report.error}` | `ConnectorsSettings.tsx:258` | "Failed" + details |
| HTTP status codes | `ApiSettings.tsx:123` ("last 404"), `SharingSettings.tsx:81` ("HTTP 401: …"), `apis.ts` verdicts | Verdict sentence; code in details |
| `error.message` | `ErrorBoundary.tsx:66`, `update.tsx:79`, `SetupBanner.tsx:113-120`, `FileViewer.tsx:65` | Plain headline + details |
| Stack traces | `MiniAppViewer.tsx:54` (composed into the user's message) | Collapsed quote block, not the user's words |
| js-yaml / frontmatter parser text | `KnowledgePage.tsx:384`, `skillImporter.ts:593` | "This skill's header is malformed." |

## 6. Dead or stale code found on the way (simplify rule: delete, don't disable)

- `components/calendar/*` (17 files) — imported by nothing outside the folder; the Hard Reset copy still promises to wipe "calendar events".
- `components/HomePage.tsx` + `BriefingHistory.tsx` — the pre-Activity home; not mounted.
- `components/MiniAppsTab.tsx` — imported in `index.tsx:21`, never rendered.
- `components/ContainerTests.tsx` + `.css` — not imported; Podman-era tests ("Workspace mount (/data)", "R runtime").
- `components/ReactionsSidebar.tsx`, `FocusEditor.tsx`, `WritingAgentView.css` — flagged dead in CLAUDE.md, still present.
- `components/SetupBanner.tsx:44-58` — Podman progress branches that no stage ever reaches (main emits only `ready`, `containerService.ts:193`); the `setupStore` 'downloading' state and its "Setting up environment…" copy in three components exist only for them.
- `components/assistant-ui/tool-labels.ts:92-160` — labels for five dropped integrations.
- `components/assistant-ui/approval-buttons.tsx` — pattern-matched approval buttons with no handler behind them.
- `debug/StorageDebug.tsx:57-59` Podman rows; `debug/HardResetDebug.tsx:67-68` briefings/calendar lines.
- `PRE-BUILT` / `preBuilt` branches (`CommandDesk.tsx:36`, `ToolsPage.tsx:440,488`, `MiniAppViewer.tsx:516` "Open in browser") if no pre-built tool can exist any more.
- `docs/design/design_handoff_acabox_home/README.md` still specifies "LOCAL VM", "paste a repo", "Break things freely", `MODELS 3 WARM` — the design brief's voice is the source of several must-fixes above and should be re-briefed for scientists before the next design pass.

## 7. Prioritised fix list

**Must-fix (one afternoon of copy edits, 0 model calls):** #1 `SYNCED`; #3 Debug in rail; #6 STARTING-forever; #8 `AGENTS 0 LIVE`; #12 search promise; #13 "scaffolds"; #20 `CS:`; #21 Chats empty state; #30/#31 "paste a repo"; #47/#48/#50 raw agent errors; #56 `ON-DEMAND`; #64 "Waiting for container"; #65 "rebundle" screen; #67 "still writing / scaffolded"; #68 "Could not load application dirName"; #83 `ShareApiClient:`; #95 "System prompt"; #103/#104/#107 Connectors MCP/HTTP/SSE/`mcp__`; #114/#115 APIs intro and proxy banner; #126 Sharing intro; #130 Podman setup copy; #132/#133 Coscientist placeholders; #136/#137 frontmatter/CLI; #158 `pid … node index.mjs`; #172 Files empty state; #179 "container is starting"; #183 kernel gateway text; #187 "Container is not running".

**Should-fix next:** the "Claude" → "Acabox/I" sweep (§4); one status vocabulary (#28); step-row names (#41-45); Settings restructure (#93-102); Knowledge/Servers vocabulary (#131-171); time-vs-size mono units (#17); "Details" disclosures (§5.2).

**Fine-for-Debug-only:** #99, #121, #168, #191 — provided Debug leaves the rail and the stale Podman/briefings rows go.

**Counter-examples to protect (already in the right voice):** Activity sections and outcomes (#84-85), quit dialog (#186), Tools page header and empty states (#55,#59,#62), API test verdicts (#125), delete-chat confirms (#29), share footnote (#82), `WORKED FOR 4m 12s · 26 STEPS` (#46), server state words (#169), `mcpHost/diagnose.ts` reasons (#170).
