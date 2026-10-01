# Acabox review — App shell, Home ("Command Desk"), navigation, composer, status bar

Reader: shell/home/navigation. Repo: `/Users/iliasbeshimov/Documents/Dev Folders/Acabox` (paths below relative to it). Read-only; nothing run.
Audience the judgements are made for: a non-technical scientist who cannot read code, does not use a terminal, and cannot debug a build.

Reference frame: the chosen Home design in `docs/design/design_handoff_acabox_home/README.md` (Jul 23) and the Phase B brief `docs/design/phase-b-design-brief.md`. Where the code and the design (or CLAUDE.md) disagree, the code is treated as the truth.

---

## 1. What a non-technical scientist experiences at first launch (no folders, no API key)

Reconstructed from `renderer/index.tsx`, `command-desk/*`, `GlobalComposer.tsx`, `main/index.ts`. Nothing below is from running the app.

1. **Window** — a fixed 1440×900 frameless window (`main/index.ts:706-716`, `titleBarStyle: 'hiddenInset'`, no `minWidth`/`minHeight`, no bounds persistence — every launch opens at the same default size/position). The macOS menu bar is **Electron's default menu**: there is no `Menu.setApplicationMenu` anywhere in `src/` (grep), so the scientist gets View → *Reload* / *Force Reload* / *Toggle Developer Tools* and a Help menu whose items ("Learn More", "Documentation", "Community Discussions", "Search Issues") point at electronjs.org — those strings are present in the shipped Electron Framework binary (`grep -a` hits for "Community Discussions", "Toggle Developer Tools", "electronjs.org"). Help → Learn More opens the Electron website, not anything about Acabox.
2. **Chrome bar** (`ChromeBar.tsx:36-52`): B-box mark + mono `ACABOX · V0.1.27`; on the right an amber dot + `STARTING`, flipping to green `HEALTHY`. What HEALTHY measures is **not** agent health (see §5.2).
3. **Rail** (`Rail.tsx:24-32`, expanded by default): Home (active), Chats, Tools, Knowledge, Servers, Files, Activity. No counts (both counts are gated on `> 0`, `Rail.tsx:138-144`), no Recents, no Pinned tools (both sections gated on length, `Rail.tsx:160,181`). Footer (`Rail.tsx:203-214`): `hard_drive ~/workspace-data SYNCED`, `Debug`, `Settings`.
4. **Home header** (`CommandDesk.tsx:83-93`): "Command desk" · `TUE SEP 30 · 20:06` · a 280px box reading "Search chats, tools, files…" with a `⌘K` keycap. It is a `<button>`, not an input (`CommandDesk.tsx:88`): clicking it navigates to the Chats page.
5. **Tools section** (`CommandDesk.tsx:98-152`): mono label **`TOOLS — 0 OF 0`** + "All tools" link, then one dashed card: *"Build a new tool" / "Describe it below — ACABOX scaffolds it"*. Click focuses the composer (`focusComposer`, `CommandDesk.tsx:24-26`).
6. **Jump back in** (`CommandDesk.tsx:156-176`): label + "All chats · 0" + card reading *"No chats yet — start one below."*
7. **Drive** (`CommandDesk.tsx:179-199`): label **`DRIVE — ~/WORKSPACE-DATA`** + "Browse" + card reading *"No files yet — share a folder in Settings."* — "Settings" is plain text, not a link.
8. **Composer** (`GlobalComposer.tsx:66-105`): blue `▸` glyph, placeholder *"What are we building? — describe a tool, paste a repo, or ask"*, attach-file, screenshot ("Screenshot — drag an area or click a window"), mic ("Dictate (on-device)", only if the Swift helper exists), model chip **"Opus 5  High ⌄"**, blue send arrow.
9. **Status bar** (`StatusBar.tsx:72-110`): `CPU 12%  MEM 18.2/32.0G  DISK 412/994G  AGENTS 0 LIVE … UP 0M`. `AGENTS 0 LIVE` is shown permanently once main has answered once (`agentCount != null`), even when nothing is happening.
10. **They type something and press Enter.** `chatAdapter`'s onSend navigates to Chats → detail (`index.tsx:741-755`). The header reads *"New chat · OPUS 5 · HIGH · NAMES ITSELF AFTER THE FIRST REPLY"* (`ChatHeader.tsx:120-124`, `useSessionMeta.ts:60-67`). Main refuses the turn with **"No Anthropic API key configured. Add one in Settings."** (`main/index.ts:486`), rendered as an error block (`thread.tsx:346-354`, `.cdMsgError`). Nothing in that block is clickable. To fix it the scientist must find the gear at the bottom of the rail, scroll a Settings page with eight sections — *Workspace directories, System prompt, About you, Connectors, Claude Design, APIs, Sharing, Account* (`DirectoryPermissions.tsx:190,233,274,339,346,353,360,367`) — and find the key field as the **last control on the page**, inside "Account", *below* "Rescan workspace" (`DirectoryPermissions.tsx:397`). The field's own copy is fine: *"No API key set. Paste one below to use Acabox."* / `sk-ant-...` (`ApiKeySettings.tsx:54-73`), but the "APIs" section two cards above it is a different thing (HTTP API registry), which a non-technical reader will open first.
11. **Folders.** Adding a research folder is in the first Settings section, "Workspace directories". Nothing on Home opens it; the Drive card's empty copy names Settings but does not go there.

Net: the Home screen makes exactly one thing obvious — the composer — and that is right. But the two setup steps a first-run user must do (key, folder) are both reached only through text that names Settings and through the deepest part of the Settings page. There is no first-run nudge of any kind (confirmed: no renderer component references the API key outside the Settings sections; `grep "API key" renderer` → only `SchedulePanel` and the two settings components).

---

## 2. Design intent vs implementation (Home handoff README vs code)

| Design element (README) | Implemented? | Notes / evidence |
|---|---|---|
| Window chrome: dots, `ACABOX — LOCAL VM · V0.4.2`, green `HEALTHY` | Changed, deliberately | `ChromeBar.tsx:39-44` drops "LOCAL VM" (comment explains: no VM anymore). Shows `STARTING`/`HEALTHY` from `containerAPI.status()`; see §5.2 for what that really measures. |
| Rail: Home/Chats/Tools/Files/Activity + counts | Extended | Now 7 nav items + Debug + Settings (`Rail.tsx:24-32,203-214`). Counts for Chats/Tools only when `>0`. |
| RECENTS: 5 chats + "More" | Built | `index.tsx:1153`, `Rail.tsx:160-178`. |
| PINNED TOOLS: 3 rows + status dot | Built differently | "Pinned" = the 3 most recently *opened* tools (`index.tsx:1041-1056` sorts by `lastOpened`). There is no pin action anywhere; the label is a misnomer. Dot only when non-idle (good). |
| Footer: `hard_drive ~/acabox SYNCED` | Built, fake | `Rail.tsx:203-207`: `~/{workspaceName}` where `workspaceName` is the basename of the userData workspace (`'workspace-data'`, `shared/paths.ts:9`) — a path that does not exist at `~`. `SYNCED` is a hard-coded literal (`Rail.tsx:205`, the only occurrence in the renderer). Violates "no mocks in prod": a status word that is not measured. |
| Header search field 280×36, "Opens a command palette; also bound to ⌘K" | Not built | `cdSearch` is a button that calls `onNavigateChats` (`CommandDesk.tsx:88`). ⌘K does the same (`index.tsx:992-1007`, comment: "interim: routes to the chat list (it has search) until a real command palette exists"). The Chats page's search input is **not focused** on arrival (no `autoFocus`/`focus()` in `thread-list.tsx`), so ⌘K → user must click into the search box. |
| INSTRUMENTS grid "4 OF 7" + status chips RUNNING/BUSY/SLEEPING/CRASHED | Built, re-vocabularied | Label `Tools — N of M` (`CommandDesk.tsx:99-101`; reads `TOOLS — 0 OF 0` when empty). Chips only when something is happening: WORKING / BUILDING / FIRST BOOT / BUILD FAILED / RAN WHILE CLOSED / INTERRUPTED (`toolStatusDisplay.ts:25-38`). RUNNING/SLEEPING deliberately removed (CLAUDE.md). |
| Progress bar + "3/8 · ETA 41M" on a BUSY card | Not built | No progress on home cards (`CommandDesk.tsx` has no `cdProgress`). `.cdProgress` CSS is used only inside the tool viewer's install interstitial (`MiniAppViewer.tsx:691`). |
| CRASHED card variant (`#fff2f2` bg, `error` icon, "CRASHED 2H", [Revive], "Read the logs") | Not built | `.cdCard--crashed` CSS exists (`commandDesk.css:494-503`) but no TSX applies it (grep). A failed build shows only the `BUILD FAILED` chip; the card's action is still "Open". "Ask Claude to fix it" exists but only on the Activity page (`ActivityPanel.tsx`). |
| New-tool dashed card; "Click focuses the composer" | Built | `CommandDesk.tsx:143-152` → `cd:focus-composer` → `GlobalComposer.tsx:31-37`. Copy: "Describe it below — ACABOX scaffolds it". |
| JUMP BACK IN (list, rel-time right) | Built | `CommandDesk.tsx:156-176` — but see §5.1: the relative time is wrong by the UTC offset. |
| DRIVE — ~/ACABOX + "Browse", 4 rows | Built | `useHomeData.ts:60` slices 4 newest-mtime files across shared dirs (`fileHandlers.ts` sorts `mtimeMs` desc). |
| Composer: `▸`, placeholder, attach, model chip "AUTO", send | Built, extended | Placeholder verbatim (`GlobalComposer.tsx:73-77`); added screenshot + dictation; model chip shows `Opus 5 High` instead of `AUTO` (no auto mode exists). |
| Status bar: `CPU 12%` `MEM 3.1/8.0G` `DISK 34.2/80G` `MODELS 3 WARM` … `SNAPSHOT 04:12 ✓` | Partly | CPU/MEM/DISK/UP built, live (`systemStats.ts`). MODELS WARM / SNAPSHOT correctly dropped (nothing to measure). Added `AGENTS N LIVE`, `N TOOLS WORKING`, `N SERVERS DOWN/STARTING`. |
| ⌘K command palette (search chats/tools/files) | Not built | See above. |
| Blinking cursor motif | Removed on purpose (Phase B brief) | Fine. |
| Copy voice "terse, playful-hacker" | Kept | "Where to?", `▸`, "paste a repo", "scaffolds", mono uppercase everywhere — see §6 for whether this voice fits the audience. |

Phase B brief vs code (shell-relevant parts only): chat header (back · title · meta · GENERATING · rename/delete) built (`ChatHeader.tsx`) plus a copy-link button; tool viewer tab bar / header / side panel built (`ToolWorkspace.tsx`, `MiniAppViewer.tsx:420-498`); onboarding built then **removed entirely** (CLAUDE.md "Onboarding flow removed"), which is what produced the first-run experience in §1.

---

## 3. Information architecture: nine destinations judged for a non-technical scientist

Rail order: Home, Chats, Tools, Knowledge, Servers, Files, Activity, then Debug, Settings (`Rail.tsx:24-32,203-214`; `SIDEBAR_TAB_IDS` in `shared/types.ts:191-193`).

- **Home** — right concept; the composer is THE call to action and the page says so twice ("start one below", "Describe it below"). Keep.
- **Chats** — fine. Header copy: *"Every conversation you've had with me. Most recent first."* (`thread-list.tsx:197-199`). Note there is **no "New chat" button** on this page or on Home; the only way to start a chat is the composer (which is fine, but the Chats page lacks the one action a chat list usually has). Search placeholder "Search chat titles and messages…" is good.
- **Tools** — fine. Header: `N TOOLS AVAILABLE` / "Tools" / *"Things the workspace can do for you. Ask me to build one, then return to it any time."* and a CTA *"Ask me to do something or build a tool"* (`ToolsPage.tsx:383-402`). The CTA opens a modal "Create a tool" whose submit **starts a new chat and sends immediately** (`ToolsPage.tsx: handleCreateTool` → `composerRuntime.send()`), i.e. one model turn per submit, which is expected. Footer "Import tool" (`:655-659`) is a developer concept (zip of a tool) that most scientists will never use; harmless.
- **Knowledge** — *"What Claude can do here, and what it has learned. All of it is markdown you can read and correct."* (`KnowledgePage.tsx:312-316`), stats `N SKILLS · N MEMORIES`. For the audience: "skills", "memories", "markdown" are implementation vocabulary. A scientist does not need a top-level tab to curate Claude's skill files; this belongs under Settings (or an "Advanced" area) with plain-language framing ("What Claude remembers about your work").
- **Servers** — *"Local MCP servers Acabox runs on this machine — separate from Connectors, which are remote services Acabox connects to."* (`ServersPage.tsx:289-293`), stats `N SERVERS RUNNING HERE`. The subtitle has to explain itself against a *different* page (Connectors, in Settings), and a third sibling (APIs, also in Settings) exists too. Three homes for "things Claude can connect to": Servers (nav), Connectors (Settings), APIs (Settings). For a scientist, "MCP server" means nothing. Candidate to fold into one "Connections" surface.
- **Files** — fine, and it is where the Drive card's "Browse" goes.
- **Activity** — good page (*"Nothing running, and nothing waiting on you."*, `ActivityPanel.tsx:192-195`; sections "Needs attention / Running now / Recently finished", plus "On a schedule"). This is also the only place scheduling can be discovered, which CLAUDE.md records as a known tradeoff.
- **Debug** — exposed to everyone in the rail footer *and* the collapsed rail (`Rail.tsx:99-101,208-211`). Sections (`DebugPanel.tsx:15-26`): *Logs, Kernels, Observations, File Monitor, Storage, API Key, Scanned Files, Telemetry, Export, Hard Reset*. "Hard Reset" is one click from the rail, ends in a button labelled **"Yes, Delete Everything"** and lists what it deletes in developer terms: *"All applications in `.applications/`", "All workspace configuration in `.academia/`"* (`HardResetDebug.tsx:66-79`). This is the single most dangerous surface for the target audience.
- **Settings** — eight sections (listed in §1). The API key is the last thing on the page; "Connectors", "Claude Design", "APIs", "Sharing" are all developer/integration concepts stacked before it.

Verdict: five tabs (Home, Chats, Tools, Files, Activity) are what a scientist needs. Knowledge and Servers should not be top-level; Debug should not be visible in a non-dev build; Settings should put the two first-run essentials (key, folders) first and merge Connectors/APIs/Servers into one plainly named section.

---

## 4. Status bar, chrome, rail indicators — what they mean to this user

- `CPU 12%` — whole-machine CPU over the last 5 s (`systemStats.ts:22-33,62-68`, `os.cpus()` delta), not Acabox's usage. Meaningless as a signal about *Acabox*.
- `MEM 18.2/32.0G` — Activity Monitor's "Memory Used" formula for the whole Mac (`systemStats.ts:40-56`). Same objection.
- `DISK 412/994G` — the user's data volume (`systemStats.ts:72-80`). Fine but irrelevant to the task.
- `AGENTS 0 LIVE` — the number of chats with a turn in flight (`StatusBar.tsx:44-49,80`). "Agents" is jargon; "0 LIVE" shown permanently when idle is noise.
- `N TOOLS WORKING` (pulsing dot) — tools with a host job running; hover lists names (`StatusBar.tsx:82-89`). Good, hidden at zero.
- `N SERVERS DOWN` / `N SERVERS STARTING` — hosted MCP servers (`StatusBar.tsx:93-109`). Meaningful only if the user set one up.
- `UP 2H 05M` — Acabox process uptime (`process.uptime()`). Meaningless to the audience.
- Chrome `HEALTHY` / `STARTING` — see §5.2: this is `startedFlag`, which `ensureSetup()` sets to true unconditionally; it is not agent liveness.
- Rail `SYNCED` — hard-coded.
- Rail dots: blue dot beside "Chats" = unread reply (tooltip "Some chats have replies you haven't seen", `Rail.tsx:130-137`); red dot beside "Servers" = a server is down; chat rows: amber pulsing = replying, blue = unread (`ChatMarkDot.tsx`). These are well done and have tooltips.

Verdict: of the always-visible segments, only `N TOOLS WORKING` and the chat dots tell the scientist something they can act on. CPU/MEM/DISK/UP are a developer's dashboard in a scientist's app.

---

## 5. Bugs and misleading indicators found in this area

### 5.1 Home "Jump back in" times are wrong by the machine's UTC offset (confirmed)
`CommandDesk.tsx:171` renders `relTimeShort(chat.updated_at)`. `relTimeShort` does `Date.parse(when)` (`format.ts:5`). `sessions.updated_at` is written by SQLite as `strftime('%Y-%m-%dT%H:%M:%f','now')` — UTC with **no `Z`** (`main/db/database.ts:21`, `chatRepository.ts:258,298`); the dev DB holds e.g. `2026-09-28T21:46:32.407` (read-only `sqlite3` check). V8 parses a bare `YYYY-MM-DDTHH:MM:SS.sss` as **local** time; measured here (`TZ=America/Los_Angeles node -e …`): the bare parse is 7 h ahead of the true instant. Consequence in a UTC−7 zone: every chat updated in the last 7 h reads **`NOW`** (negative minutes fall into the `< 1` branch), a chat from 10 h ago reads `3H`. East of UTC the times read too *old*. The codebase already has the fix — `dateFromSessionStoredAt` in `renderer/sessionTimestamps.ts:3-15`, whose header comment describes exactly this trap — and the tool side-panel uses it (`ToolWorkspace.tsx:312`); Home does not. Sorting in `useHomeData.ts:33-37` is unaffected (uniform offset). The tool-card metric is unaffected because `lastOpened`/`lastRun` are written with `toISOString()` (`fileHandlers.ts:494,514`).

### 5.2 Chrome-bar `HEALTHY` does not measure agent health
`ChromeBar.tsx:9` says "Health = agent-server liveness via containerAPI.status(), polled." `container:status` returns `containerService.isRunning()` (`main/index.ts:1422-1424`), which returns `startedFlag` (`containerService.ts:299-301`). `ensureSetup()` sets `startedFlag = true` unconditionally — *"No container to set up — process service is always ready"* (`containerService.ts:1077-1080`) — and the renderer calls `ensureSetup()` at boot (`SetupBanner.tsx:70-83`). So HEALTHY goes green regardless of whether `dist/agent-server.js` is up, and when the agent server crashes three times in 60 s and the supervisor **gives up** (`containerService.ts:542-545`) the flag is never cleared: the chrome keeps saying HEALTHY while every chat turn fails. The one green indicator the scientist can see is therefore not a health indicator.

### 5.3 ⌘K and the header search box do not search
See §2. Both route to the Chats list; the search input is not focused. The keycap and placeholder promise a palette that does not exist.

### 5.4 `SYNCED` and `~/workspace-data` in the rail footer
Hard-coded word, nonexistent path (`Rail.tsx:203-207`). Nothing syncs; shared folders are symlinked into an internal workspace.

### 5.5 Default Electron menu
No `setApplicationMenu` in `src/` → View → Reload / Force Reload / Toggle Developer Tools, Help → electronjs.org links, in the packaged app. `webPreferences` does not disable devtools (`main/index.ts:714-718`). A scientist pressing ⌘R mid-turn reloads the renderer; ⌥⌘I opens DevTools.

---

## 6. Jargon and voice on these surfaces (quoted)

- Composer placeholder: *"What are we building? — describe a tool, paste a repo, or ask"* (`GlobalComposer.tsx:75`) — "paste a repo" is developer-only; the audience has no repos.
- Home card: *"Describe it below — ACABOX scaffolds it"* (`CommandDesk.tsx:150`) — "scaffolds".
- Chat empty state: *"Describe a tool, paste a repo, or drop files — it takes it from there."* (`thread.tsx:148`); chips *"Turn a script into an app"*, *"What's in my folders?"*, *"Build a PDF → BibTeX tool"* (`thread.tsx:97-110`). The chips are **hard-coded**, not "profile-seeded" as CLAUDE.md's Phase B entry says. "Turn a script into an app" presumes the user writes scripts.
- Chat header meta: *"OPUS 5 · HIGH · NAMES ITSELF AFTER THE FIRST REPLY"* (`ChatHeader.tsx:120-124`).
- Model chip and menu: *"Opus 5 / High"*, *"Fable 5.1 — Highest intelligence, premium cost"*, *"Opus 5.5 — Newest Opus, most capable for ambitious work"* (`shared/models.ts:51-58`); *"Effort"* with levels *Low / Medium / High / Extra / Max* and blurb *"Higher effort means more thorough responses, but takes longer and uses your limits faster."* (`ModelSelector.tsx:40-46,258`); discovered models read *"New from Anthropic — may need an Acabox update"* (`shared/models.ts:174`). Model names are meaningless to a scientist; the default (Opus 5) is a hidden choice; "limits" is unexplained.
- Status bar: `AGENTS 0 LIVE`, `UP 0M`, `CPU/MEM/DISK` (`StatusBar.tsx:76-80,109`).
- Rail: `SYNCED`, `~/workspace-data`, "Debug", "Knowledge", "Servers".
- Servers subtitle: *"Local MCP servers Acabox runs on this machine — separate from Connectors, which are remote services Acabox connects to."* (`ServersPage.tsx:290-293`).
- Knowledge subtitle: *"…All of it is markdown you can read and correct."* (`KnowledgePage.tsx:314-315`).
- Debug: *"All applications in .applications/"*, *"All workspace configuration in .academia/"*, *"Yes, Delete Everything"* (`HardResetDebug.tsx:66-79`).
- Tool viewer chips: `FIRST BOOT`, `BEING WRITTEN`, `BUILD FAILED`, `IDLE`; actions "Rebuild" (`MiniAppViewer.tsx:440-498`). "Rebuild" and "BUILD FAILED" are developer states; the scientist cannot act on a build error except by asking Claude.
- Voice is inconsistent across pages: first person ("me", "Tools I've built for you", `ToolsPage.tsx:386,407`; "conversations you've had with me", `thread-list.tsx:198`) vs third person ("What Claude can do here", "Ask Claude to build one", `KnowledgePage.tsx:313`, `ServersPage.tsx:319`) vs brand ("ACABOX scaffolds it") vs "it" ("it takes it from there"). Four narrators on adjacent screens.

Whether the "terse, playful-hacker" voice the design asked for suits scientists is a product call; the specific developer nouns above (repo, scaffold, build, kernel, MCP, markdown, agents) are not a voice question — they are words the audience does not know.

---

## 7. Keyboard shortcuts and discoverability

Found (grep for `metaKey|ctrlKey`, `globalShortcut`): ⌘K → Chats list (`index.tsx:1003`); ⌘F / ⌘G / ⇧⌘G find-in-page (`findShortcut.ts`); Esc stops a running turn (`index.tsx:203-222`, `EscStopsRun`); Enter sends / ⇧Enter newline (assistant-ui default); ⌘S in the notebook editor (`NotebookViewer.tsx:197`); **Alt+Shift+A** OS-wide → Quick Chat (`main/index.ts:1252-1259`). Nothing lists any of these; the only on-screen hint is the `⌘K` keycap (`CommandDesk.tsx:91`) — for a shortcut that does not do what the keycap implies. There is no ⌘N (new chat), no ⌘, (Settings), no shortcut help. Collapsed-rail icons have `title` tooltips (good).

---

## 8. Window and tray behaviour

- Close (red light): on macOS the window is destroyed, the app stays in the Dock and menu bar (`window-all-closed` quits only off-darwin, `main/index.ts:3540-3544`); Dock click recreates the window (`activate`, `:1286-1290`). Tray menu: *Show Window · Check for Updates… · Version: x · Quit* (`tray.ts:19-56`). A running turn survives a window close — `onSenderGone` removes the subscriber but `removeSubscriber` defers destroy while a turn is in progress (`main/index.ts:660-664`, `sessionRegistry.ts` ~`:259-266`) — and the reply lands as unread. Good. But reopening is a full renderer reboot: open tool tabs are lost (`useTabs.ts` keeps tabs in React state only, no persistence), the rail/tab state resets to Home.
- Quit with work running: a native dialog *"1 tool is still working." / "This work will keep running in the background and finish on its own. Acabox will show you what happened the next time you open it."* with *Quit / Stop them and quit / Cancel* (`main/index.ts:3569-3582`). Clear and honest.
- A non-technical user has no cue that closing ≠ quitting beyond the Dock dot; acceptable macOS convention.

---

## 9. Dead or unreachable UI in this area

- `renderer/grant-finder-entry.tsx` + `renderer/prebuilt-apps/grantFinder/` — not a webpack entry (`forge.config.js:249-290` lists five entries; this is not one) and imported by nothing. Dead.
- `MiniAppsTab` — imported in `index.tsx:21`, never rendered; `MiniAppsTab.tsx` (190 lines) has no other importer (`toolIcon.tsx` only mentions it in a comment). Dead.
- `PaperMonitorView` branch — `toolsViewMode === 'paper-monitor'` (`index.tsx` ~1240-1283) is never set anywhere (only the type union at `:132,637`). 346 lines of unreachable UI.
- `ReactionsToolView` — reachable only via a notification for a `reactions`-source session (`index.tsx:139-146`); reactions can only be enabled through `settings:setReactionsEnabled`, which **no renderer code calls** (grep `ReactionsEnabled` in renderer → none; Settings has no Reactions section). Its copy is stale twice: *"surface suggestions in the Briefings panel. Enable in Settings → Reactions."* (`ReactionsToolView.tsx:11-14`) — no Briefings panel, no such Settings section. `ReactionsSidebar.tsx` has no importer.
- `OverlayNavigationHandler` (`index.tsx:171-199`) listens for `navigate-to-page`; no sender in `main/` (grep). Dead (Word-overlay era).
- Quick Chat: the window is created at boot (`main/index.ts:1239`) and bound to Alt+Shift+A. `captureContext()` is a stub returning `EMPTY_CONTEXT` (`quickChat.ts:23-25`), so the "Context from: …" badges (`QuickChatInput.tsx:84-104`) and `QuickChatInjector`'s `[Context]` block (`index.tsx:86-105`) can never render. Nothing in the UI, tray or Settings mentions the shortcut. A ghost feature: reachable, undiscoverable, half-dead.
- `SetupBanner` Podman-era strings — *"Downloading Podman..."*, *"Initializing Podman VM..."*, *"Starting Podman VM..."*, *"Downloading base image..."* (`SetupBanner.tsx:36-55`). `containerService` emits only `'ready'` (`containerService.ts:193`), so these are unreachable, but the file is still compiled and the component is mounted (`index.tsx:1137`).
- `.cdCard--crashed` CSS (`commandDesk.css:494-503`) — never applied.
- Type union members `'paper-monitor'` / `'reactions'` in `SidebarTab`-adjacent state carry dead branches through `globalComposerVisible` and `quoteToolbarEnabled` (`index.tsx:1078-1096`).

---

## 10. Stale guidance noticed (CLAUDE.md / comments vs code)

- CLAUDE.md Phase B: *"empty state ('Where to?' + profile-seeded chips)"* — chips are a hard-coded array (`thread.tsx:97-110`).
- `ChromeBar.tsx:9` comment *"Health = agent-server liveness"* — it is `startedFlag`, set unconditionally by `ensureSetup()`.
- `index.tsx:992` comment calls ⌘K "interim … until a real command palette exists" (Jul 23); still interim.
- `setupStore.ts:3-5` and `SetupBanner.tsx:7-11` still describe "podman + base image download".
- Design README is explicitly a reference; its "PINNED TOOLS" and "SYNCED" were copied as labels without the underlying concept.

---

## 11. Strengths worth keeping

- The composer is unmistakably the primary action; empty states point at it; the dashed card focuses it.
- "Jump back in" / Drive / Tools on one screen is the right information set for a scientist.
- Status chips only appear when something is happening; idle tools are silent (CLAUDE.md: deliberate). Chat dots (amber working / blue unread) are consistent across six surfaces with tooltips.
- Pinned model chip in a started chat explains itself: *"This chat runs on Opus 5 · High, fixed when it started. Start a new chat to use a different model."*
- Quit dialog copy is honest about background work.
- Activity page's language ("Nothing running, and nothing waiting on you", "Stopped by you", "Ran while Acabox was closed — result unknown") is the best-written copy in the shell and a model for the rest.

---

## 12. Ideas (each with model-call cost and effort)

1. **First-run cards on Home** (0 model calls, S). When no API key: a Home card "Add your Anthropic key to start" that opens Settings scrolled to the key field; when no folders: "Share a research folder" that opens the folder picker directly. Replace the error-block text "Add one in Settings" with a button. Hide both once done (real state, no mock).
2. **Fix Home relative times** (0, S). Use `dateFromSessionStoredAt` in `CommandDesk.tsx:171` (and anywhere else `updated_at`/`created_at` is parsed bare).
3. **Honest health indicator** (0, S–M). Drive `HEALTHY` from the agent server's real `/health` (the host already has `isAgentServerHealthy()`); add a red `OFFLINE` state with a "Restart" action once the restart budget is exhausted.
4. **Real ⌘K palette or drop the keycap** (0, M). Reuse the existing prose search for chats, add tools and files by name, plus actions (New chat, Open Settings, Add folder, Stop all work). Until then: make the header box a real input that focuses the Chats search, or remove `⌘K`.
5. **Remove Debug from the rail in packaged builds** (0, S); move Hard Reset behind Settings → Advanced with a typed confirmation and plain-language consequences.
6. **Replace the developer status bar** (0, S). Show "Claude ready / offline", "N tools working", "N chats replying", and nothing else; move CPU/MEM/DISK/UP to Debug. Remove the permanent `AGENTS 0 LIVE`.
7. **Flatten the IA** (0, M). Top nav: Home, Chats, Tools, Files, Activity. Fold Knowledge into Settings ("What Claude remembers"); merge Servers + Connectors + APIs into one "Connections" section with plain names. Put Key and Folders at the top of Settings.
8. **Copy pass on the shell** (0, S). "describe a tool, paste a repo, or ask" → "Ask a question, describe a tool, or drop a file"; drop "scaffolds", "repo", "AGENTS … LIVE", "SYNCED", "~/workspace-data" (show the real shared folder names, or nothing). Pick one narrator (first person "I" matches the chat).
9. **Model chip for non-experts** (0, S). Default label "Claude" with a tooltip; move model/effort names under "Advanced"; the blurb "uses your limits faster" → "costs more".
10. **Application menu** (0, S). Set a real menu: File → New Chat ⌘N, Edit roles (needed for ⌘C/⌘V), View without Reload/DevTools when packaged, Help → "Acabox help", "Reveal log file", "Report a problem". Add a ⌘/ shortcut sheet.
11. **Quick Chat: finish or delete** (0, S to delete / M to finish). Either remove `quickChat.ts`, the entry, the preload and `QuickChatInjector`, or finish context capture and surface the hotkey in Settings. Per the owner's "simplify" rule, delete.
12. **Delete the dead code in §9** (0, S): grant-finder entry + prebuilt app, `MiniAppsTab`, paper-monitor branch, `ReactionsToolView`/`ReactionsSidebar`, `OverlayNavigationHandler`, Podman strings in `SetupBanner`/`setupStore`, `.cdCard--crashed` (or use it, see 13).
13. **Failed-tool card variant** (0 for display; "Ask Claude to fix it" is one user-initiated turn per click, S). Apply the existing `.cdCard--crashed` style when `buildFailed`, change the card button to "Ask Claude to fix it" (already implemented on Activity), and say what failed in one plain sentence.
14. **"Pinned tools" → real pins or honest label** (0, S). Either a star action on tool rows, or rename the rail section "Recent tools".
15. **Persist shell state** (0, S). Window bounds via `getBounds()` on close; open tool tabs + active tab in localStorage; restore on launch.
16. **New chat affordance** (0, S). A "New chat" button on the Chats page header and ⌘N, both calling `switchToNewThread()` and focusing the composer.

---

## 13. Open questions for the owner

- Is the Debug tab meant to ship to end users, or only in dev builds?
- Is Quick Chat (Alt+Shift+A) a feature you want, or leftover from the Coscientist fork?
- Should Servers and Knowledge remain top-level destinations for scientists, or live under Settings?
- Do you want real tool pinning, or should the rail section be renamed?
- Is the "playful-hacker" copy voice from the design still the intent for a non-technical audience, or should the shell switch to plain scientist-facing language?
