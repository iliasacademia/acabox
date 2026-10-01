# Acabox review — Files, Knowledge, Servers, Activity/Scheduling, Settings, Debug, vestigial screens

Reviewer scope: everything outside Home/Chat/Tools. Read-only; code is treated as truth, CLAUDE.md as a log.
All paths relative to `src/cobuilding/` unless absolute. Production evidence came from read-only
`sqlite3 -readonly` and `grep -o` against `~/Library/Application Support/acabox/production` (no secrets read).

Judged for the stated audience: a scientist who cannot read code, does not use a terminal, and cannot
debug a build.

---

## 1. Reachability map (what a user can actually reach)

Determined by grepping imports from `renderer/index.tsx` and following render sites, not by file presence.

| Surface | Reachable? | Evidence |
|---|---|---|
| Rail nav: Home, Chats, Tools, Knowledge, Servers, Files, Activity + footer Debug, Settings | Yes | `components/command-desk/Rail.tsx:24-32,142-150` |
| Files tab + FileViewer (md, csv, xlsx, pdf, image, code) | Yes | `index.tsx:1298-1346` |
| Knowledge page | Yes | `index.tsx:1168-1178` |
| Servers page + ServerConfigForm + ServerDetail | Yes | `index.tsx:1181-1192` |
| Activity panel + ScheduleSection/SchedulePanel | Yes | `index.tsx:1155-1165`, `ActivityPanel.tsx:184-189,287-293` |
| Settings (`DirectoryPermissions`) with 8 sections | Yes | `index.tsx:1384-1397` |
| Debug (10 sections) | Yes, in the rail footer for every user | `Rail.tsx:97-102,205-212`; `debug/DebugPanel.tsx:16-27` |
| Notebook viewer | Only inside a tool's code browser when the active file is `.ipynb` | `MiniAppViewer.tsx:1328,1400` — never from the Files tab |
| `ReactionsToolView` | Only via a desktop notification whose session has `source='reactions'/'reactions-system'` | `index.tsx:139-145`; nothing in the renderer can create such a session any more (`grep setReactionsEnabled renderer` → only `types.d.ts`) |
| `PaperMonitorView` | **Dead** — imported, but `setToolsViewMode('paper-monitor')` is never called | `index.tsx:23,637,1215`; grep for `'paper-monitor'` finds only the type union |
| `HomePage.tsx` + `BriefingHistory.tsx` (briefings / "Open in Word") | **Dead** — not imported anywhere | grep `from '.*HomePage` → none |
| `components/calendar/*` (17 files, 8,266 lines) + `main/calendarAgentSession.ts` (792) + `main/ipc/calendar.ts` (219, 31 IPC handlers) + `main/db/calendarRepository.ts` (188) + 31 preload methods | **Dead UI, live backend** — nothing imports the calendar components; the IPC handlers and preload surface still ship | `main/index.ts:22-23,2298-2310`; `main/preload.ts:420-421` |
| `ReactionsSidebar.tsx`, `FocusEditor.tsx` (`'focus'` TabKind), `WritingAgentView.css`, `ContainerTests.tsx/.css`, `MiniAppsTab.tsx` (imported at `index.tsx:21`, never rendered), `components/ui/select.tsx` (only used by a debug screen) | **Dead** | greps in this review |
| `SetupBanner.tsx` Podman stage strings ("Downloading Podman...", "Initializing Podman VM...", "Starting Podman VM...", "Downloading base image...") | Unreachable text — `ensureSetup(_onProgress)` ignores its callback and only `'ready'` is ever emitted | `SetupBanner.tsx:42-57`; `main/containerService.ts:193,1077` |

Dead renderer code in my area alone: **~11,100 lines** (calendar 8,266 + HomePage/BriefingHistory 525 + PaperMonitorView 346 + ReactionsSidebar 95 + FocusEditor 74 + WritingAgentView.css 339 + ContainerTests 442 + MiniAppsTab 190 + ReactionsToolView 18), plus ~1,200 lines of calendar backend. Owner rule 3 ("remove, don't disable") applies; the CLAUDE.md hazard "ContainerTests debug panel is stale" is itself stale — the panel is unreachable.

---

## 2. Files tab

### 2.1 What it offers (exact words)

Tree rooted at the workspace folder, whose row label is derived from the path (`FilesTab.tsx:73`) and therefore reads **`workspace-data`** (`WorkspaceController.ts:85` joins `userData` + `WORKSPACE_DATA_DIR = 'workspace-data'`, `shared/paths.ts:9`). Each shared folder appears as a sibling root with a lock badge reading **"Read only"** / **"Editable"** / **"Applying…"** (`DirectoryPermBadge.tsx:24`). Header stat: `N FILES` (`index.tsx:1330`).

Root-row buttons (tooltips): **"Import file"**, **"New folder"**, **"Refresh files"** (`FilesTab.tsx:541,551,561`).
Row hover actions: **"Rename"**, **"Delete"** (`FilesTab.tsx:912,925`) and, on `.docx` only, **"Open in Word"** (`FilesTab.tsx:897`).
Context menu (`FilesTab.tsx:666-752`): `New File`, `New Folder` (dirs); `Tag as MANUSCRIPT / GRANT / SLIDES / REFERENCE`, `Remove Tag` (files); `Rename`; `Show in Finder`; `Share…` → `Copy link` / `Refresh shared copy` / `Unpublish`; `Delete`.
Drag & drop: internal move, external copy with a progress bar `Copying X... (n of N)` (`FilesTab.tsx:644`).
Auto-refresh on disk change (`FilesTab.tsx:234-238`).

### 2.2 Viewing: formats, limits, editing

`main/fileHandlers.ts:242-276` + `shared/fileKinds.ts`:

| Extension | Rendered as | Component |
|---|---|---|
| png/jpg/… (`IMAGE_EXTENSIONS`) | `<img>` | `FileViewer.tsx:78-79` |
| pdf | Chromium PDF iframe (zoom/search free) | `PdfView.tsx:10` |
| md/markdown/mdown | Rendered/Source toggle | `MarkdownView.tsx:17-30` |
| csv/tsv | Sortable virtualised table, delimiter auto-detect | `CsvView.tsx` |
| xlsx/xlsm | ExcelJS table with sheet tabs; `.xls`/`.ods` not supported (comment at `fileKinds.ts:33-35`) | `XlsxView.tsx` |
| js/ts/tsx/py/json/r/html | Syntax highlighted | `CodeView.tsx:22-37` |
| **everything else** (`.docx`, `.pptx`, `.ipynb`, `.fcs`, `.xls`, `.ods`, `.txt`, `.fasta`, …) | read as UTF-8 and dumped in a `<pre>` (`fileHandlers.ts:267,276` → `CodeView.tsx:72-73`) | binary files show mojibake; `.ipynb` shows raw JSON |

Limit: **10 MB** (`fileHandlers.ts:27`) → "File is too large to view (12.3 MB)" (`FileViewer.tsx:75`). Images/PDFs bypass the limit.
Editing: **none** in the Files tab (`files:writeFile` exists in preload but no viewer calls it). Copy-whole-file button exists (`CopyFileButton.tsx`).
Open in default app: **none** — `files:showInFinder` actually calls `shell.openPath` (`fileHandlers.ts:389-393`, misnamed) but the Files tab only calls `revealInFinder` (`FilesTab.tsx:338`). The only "open" affordance is the `.docx`-only Word button.
Send to chat: **none** — grep for attach/ask/send in `FilesTab.tsx`/`CommandDesk.tsx` finds nothing; files reach the chat only via the composer's attach button, drag onto the composer, or typing a path.

### 2.3 Defects (ranked for this audience)

1. **One click permanently deletes a file or whole folder from the user's real research directory — no confirmation, no Trash.** Row trash icon → `onDeleteRequest` → `handleDeleteNodePath` → `filesAPI.deleteFile` (`FilesTab.tsx:925-930, 406-412`); context "Delete" → `handleDelete` (`FilesTab.tsx:321-326`). Main does `fsPromises.rm(resolved, { recursive: true })` (`fileHandlers.ts:320-324`). Shared folders are allowed paths, so this reaches `~/Data/MyLab`. Compare: removing a *folder from the workspace list* does confirm (`DirectoryPermissions.tsx:117`) and skills go to a 30-day trash (`KnowledgePage.tsx:299-312`). Severity: high.

2. **Manuscripts (.docx) cannot be viewed in Acabox, and clicking one throws.** `handleSelectFile` (`index.tsx:758-765`) intercepts `.docx/.doc`, runs `open -b com.microsoft.Word` (`main/index.ts:1825-1835`), then calls `window.fileMonitorAPI.setDockRightForDocument` — which is declared in `types.d.ts:804` but **not exposed by preload** (`preload.ts` fileMonitorAPI exposes only status/start/stop/getTodaySessions/openFile) → `TypeError` at runtime. Without Word installed, `execFileSync('open', …)` throws and the fallback `shell.openPath(fileUrl)` is handed a `file://` URL. Net effect: the most important file type for a scientist either launches Word (the dropped Word-overlay flow) or does nothing. The row's "Open in Word" button (`FilesTab.tsx:893-905`) has the same two calls plus `ensureAccessibilityPermission`, whose IPC `overlay:ensureReady` has no main handler (grep → none) and silently returns true. Severity: high.

3. **"Read only" lock badge overstates what it does.** The flag is only prose in the system prompt — `agentSession.ts:588-592`: "`(read only) — make a copy inside the workspace before editing; direct edits will fail.`" Nothing fails; `Write`/`Edit` succeed (CLAUDE.md "Known hazards" admits this). A lock icon labelled "Read only" promises enforcement to exactly the person who cannot verify it. Also set at session create, so toggling mid-chat does nothing until a new chat. Severity: high (trust).

4. **Rail footer always says `~/workspace-data SYNCED`.** `Rail.tsx:203-206` — `SYNCED` is a hardcoded literal, synced to nothing. Violates owner rule 1 (no mocks in prod). The folder name shown is the internal `workspace-data`. Severity: medium.

5. **File types scientists have render as garbage or JSON.** `.docx/.pptx` (binary → mojibake), `.ipynb` (raw JSON even though a notebook renderer exists at `notebook/NotebookViewer.tsx`), `.fcs`, `.xls`. Severity: medium.

6. **Tag vocabulary is inherited and partly dead.** `Tag as GRANT` (`FilesTab.tsx:59-64`) survives the grants cut; tags feed only the agent's `list_scanned_files` tool (`AgentInfrastructureController.ts:277-289`), which nothing explains in the UI. `e.name !== 'google-drive'` filter (`FilesTab.tsx:169`), `driveFileId`/`driveMimeType` fields (`FilesTab.tsx:49-50`) are Drive vestiges. A `console.log` of DB rows ships (`FilesTab.tsx:133`). Severity: low.

### 2.4 What a non-technical scientist experiences
Opens Files → sees a folder called `workspace-data` containing `tool-data`, plus their lab folder with a lock that says "Editable". Clicks their manuscript → Word opens (or nothing happens). Clicks a notebook → a wall of JSON. Hovers a row to rename, mis-hits the trash icon → the folder is gone, permanently, with no dialog. Wants to ask Claude about a CSV they just found → there is no button; they must go back to Chat and attach it again.

---

## 3. Knowledge

### 3.1 What it shows (exact words)
Header: `N SKILLS · N MEMORIES` / "Knowledge" / **"What Claude can do here, and what it has learned. All of it is markdown you can read and correct."** (`KnowledgePage.tsx:331-339`).
Card: **"Add a skill — A skill is a folder of instructions Claude loads when it decides the job needs them — a warehouse's traps, a house query form, a procedure worth getting right twice."** (`:352-357`). The three examples are the owner's Hex/Redshift context; a biologist cannot parse "a house query form".
Skill rows: name = directory id (e.g. `manage-mini-application`), chips `BUILT IN / IMPORTED / MINE`, `OFF` ("Not in the roster, so Claude will not see it listed. The files are still on disk."), `BROKEN` ("The CLI drops a skill whose frontmatter will not parse, silently."), `MODIFIED`, licence, `N FINDINGS`, `N SCRIPTS` ("Runnable files. They run with your privileges the moment Claude invokes one.") (`:63-110`). Meta line: **`SKILL.md 4.2 KB · 54 files · desc 941 chars · imported 3d ago`** (`:146-160`). Actions: Open / Enable|Disable / Revert / Delete (`:277-312`). Footer: **"N of M on the roster. A skill that is off keeps its files and stays readable; Claude just stops seeing it listed."** (`:394-396`) + "Restore built-in skills…".
Memories section **"What Claude has learned"**: chips `INDEX` ("Loaded on every turn…"), `UNLINKED` ("MEMORY.md does not link to this file, so the model has no pointer to it."), meta "not indexed in MEMORY.md" (`:425-438, 486-506`). Production has 29 files in the memory dir → 28 "memories" + index.
Needs attention: **"This chat queried hex without consulting the ledger"** / **"Ask Claude to extract it"**; **"X / Y may say the same thing in skill"** / "Review" (`:535-583`).
Add modal: Name placeholder `coscientist-analytics`, help **"Lowercase letters, digits and single hyphens. This is the name Claude types to load it, and it is the directory name on disk."**; "When should Claude use it?" placeholder **"How to analyse Co-Scientist product data in Redshift through the Hex connector."**; "Import from GitHub"; **"Import, off the roster"** (`:688-725`, `ImportSkillPanel.tsx:243`). The "Ask Claude to write it" prompt tells Claude to "Use the manage-mini-application skill's conventions for the folder layout" (`:709-714`) — a mini-app skill for a skill folder.
Detail: Frontmatter block + Markdown body, an Edit tab with disk-conflict handling, a Findings table with `ID / Finding / Scope / Recorded / Last read / Supersede` (`KnowledgeDetail.tsx:360-390`).
Foot link: **"Claude reaches Hex and other services through Connectors →"** (`:445-447`).

### 3.2 Assessment
Engineering is careful (no fabricated budget meter, no fake "recalled" chip — `:24-39`). But the page is written for the person who built the skill system: roster, frontmatter, CLI, ledger, index, `desc 941 chars`, byte sizes, directory ids as names. A scientist does not know what a "skill" is, why one would be "off the roster", or what a "finding" is. The built-in list exposes internal machinery (`manage-mini-application`, `manage-mcp-server`, `acabox`, `activity-summary`, `reaction`) alongside domain skills (`flow-cytometry`, `geo-database`), and still ships `differential-expression` — documented in CLAUDE.md as unrunnable (R kernel) — and `academic-writing-agent`/`activity-summary`/`reaction`, whose consumers are dead.

**Stale guidance:** `docs/design/skills-knowledge-loop.md:3` still reads **"Status: proposed, not approved, not implemented. 2026-07-29."** while the whole system has shipped (CLAUDE.md 2026-07-29 entry, this page).

**Cost:** page itself is zero model calls. "Ask Claude to write it", "Ask Claude to extract it", and the detail's "Ask Claude" each compose *and send* a turn immediately (`:214-218`) — 1 model turn per click, with no chance to read the prompt first.

---

## 4. Servers

### 4.1 What it shows (exact words)
`N SERVERS RUNNING HERE` / "Servers" / **"Local MCP servers Acabox runs on this machine — separate from Connectors, which are remote services Acabox connects to."** (`ServersPage.tsx:285-292`).
Empty state: **"No servers yet. Ask Claude to build one for you — describe what you need in a chat and it can write and run a small server."** with links **"Open chat"**, **"Claude just built one? Check now"**, **"Advanced: add a server yourself"** (`:310-341`). "Open chat" auto-sends *"I'd like a small local MCP server for something I do here. Ask me what I need before writing anything."* (`:187-190`) — 1 model turn.
Rows: status word (`Available / Starting / Stopped / Not checked / Off / Needs sign-in / Failed`, `shared/mcpServers.ts:66-74`) and a mono meta line **`pid 41823 · 3 tools · node index.mjs`** (`:69-77`). Actions: Open / Start|Stop|Restart / **Re-promote** / Remove (`:230-278`).
"Authored by Claude": **"Small local servers Claude has written into your workspace, waiting for you to review. Nothing here runs until you enable it — Acabox then copies the files out and runs that copy, so editing them afterwards changes nothing until you approve again."**, chip `Awaiting review`, meta `.mcp-servers/<id>`, actions **"Review & enable"** / Remove (`:369-395`).
"Published by your tools" and a collapsed **"Show built into Acabox (7)"** list of tool names (`:420-466`).
Advanced form: Name (`filesystem`), Label, Command (`npx`), Arguments rows (`-y`) — **"Each row is one argument, passed exactly as typed. Acabox does not run a shell, so quotes and $VARIABLES are not interpreted"**, Environment (`API_TOKEN`), autostart, and the disclosure **"Adding this server means Acabox will run `…` on your machine, with your user account and your files, every time you start it. Every tool it offers is auto-approved… It does not make it safe."** (`ServerConfigForm.tsx:173-274`).
Detail: `as typed:` / `argv: [...]` / Working directory / Environment `KEY = ••••••••` / Tools with per-tool checkboxes / Log (`stderr` tail) (`ServerDetail.tsx:160-260`).

### 4.2 Assessment
`docs/design/mcp-hosting.md:1-30` header is accurate (0–5, 7–9 done; 6 not). The doc's own review said it plainly: *"What Increment 3 describes is a developer console … A scientist cannot author `npx -y @modelcontextprotocol/server-filesystem`"* (`mcp-hosting.md:66-71`), and the catalog that was supposed to fix that (R1) was cut. So for this audience the page is: a nav slot named after a protocol, an empty state that is honest, and a detail view of pids, argv and stderr. The one path that works for them — "ask Claude" — then dumps them back here with jargon ("Re-promote", "Awaiting review", `.mcp-servers/<id>`). A scientist has no mental model for why they must "review" code they cannot read before "enabling" it; the security argument is real but the UI gives them nothing reviewable except a description string.

Cost: zero model calls on the page; "Open chat" is 1 turn.

---

## 5. Activity and scheduling

### 5.1 Activity (exact words)
"Activity"; **"On a schedule"** with **"New task"**; empty: **"Nothing is scheduled."**; **"Nothing running, and nothing waiting on you."**; **"Needs attention"** → **"This tool doesn't build, so it can't run. Last tried 4m ago."** + **"Ask Claude to fix it"** (auto-sends a turn with the build log, `ActivityPanel.tsx:159-167`, 1 model turn); **"Running now"** rows `Command · label · running 2m 10s` with **Stop**; **"Recently finished"** `Finished · took 12s · 3m ago`; outcome words `Finished / Failed / Stopped by you / Interrupted when Acabox closed / Ran while Acabox was closed — result unknown` (`:69-80`). Good, honest copy.

### 5.2 Scheduling
Panel (`SchedulePanel.tsx`): Name (`Overnight data check`), Description (`Optional — a note to your future self`), **"What should Claude do?"** (placeholder *"Check the files in ~/Data for new results and tell me if anything looks wrong."*; help **"This is sent as a chat message, on the schedule below. It can do anything you could ask for in a chat — read your files, run code, and use your servers. Ask it to notify you and it will."**), **"How often — Every [N] [minutes|hours|days]"**, note **"Each run is a real conversation with Claude, billed to your API key, and it happens whether or not Acabox is on screen."** (`:324-327`), Recent runs (`Finished / Failed — <error> / Running now` + `3h ago`), Run now / Delete / Create.

What it can express (`scheduleCron.ts:22-28,82-98`): `*/N` minutes (5–55, multiples of 5), `0 */N` hours (1–24), `0 0 */N` days (1–31). **No weekday, no time of day, no "every Monday", no "at 8 am".** "Daily" means midnight and the UI never says so (`cronToHuman` → "Daily", `:120`). Worse, **"Every 7 days" is false**: `0 0 */7 * *` is a day-of-month step, so it fires on the 1st, 8th, 15th, 22nd, 29th and then the 1st again (2–3 day gap), and "Every 5 hours" fires at 0,5,10,15,20 then 0 (a 4-hour gap). A midnight schedule on a laptop that sleeps runs on wake (setTimeout fires late, `scheduler.ts:43`).

How results are delivered: each run is a new chat titled **`[Task] <name> — <date> (<tz>) <time>`** (`runner.ts:30`) with no `source`, so it appears in the Chats list and gets the unread dot. The task panel's "Recent runs" shows outcome and time but **no link to that chat**, although `scheduled_task_runs.session_id` is stored (`shared/types.ts:152`, `scheduledTaskRepository.ts:146`). Desktop notification only if the prompt asks. No digest, no "here is what it found".

Answer to the brief's question — *can a non-technical user create "every Monday summarise new files"?* **No.** Weekly is not expressible; "new files" requires the prompt itself to define "new" (there is no built-in "since last run" context, and CLAUDE.md records that background pollers are disallowed). The closest is "Every 7 days" at midnight, which runs on month-day multiples.

Cost shown honestly (1 turn per run). Production evidence: **zero** scheduled tasks and zero `[Task]` sessions in the production DB (`scheduling.db` tasks table empty; `sessions where title like '[Task]%'` = 0) — the feature has never been used by its one user.

### 5.3 The Reactions system task — a dormant cost loop with no off switch
`main/ipc/reactions.ts:53-58` creates **"Reactions — Summarizes your recent activity every 15 minutes"** (`*/15 * * * *`, `session_source='reactions-system'`) whose prompt runs the `activity-summary` and `reaction` skills — **96 model turns a day**. It is gated on `reactionsEnabled` in settings, which **no renderer code can set** any more (grep → only `types.d.ts:849-850`), so new users cannot turn it on. But a user who enabled it in an earlier build: boot force-re-enables the task every launch (`main/index.ts:1262-1266`: `if (rTask && !rTask.enabled) setTaskEnabled(rTask.id, true)`), the schedule UI's **Pause** is therefore undone at next start, **Delete** is refused ("System tasks cannot be deleted", `main/index.ts:3452`), and the only switch (`settings:setReactionsEnabled`) has no UI. `ReactionsToolView.tsx:13-16` even tells them "Enable in Settings → Reactions" — a section that does not exist. Production check: key absent, so the owner is not affected today; the trap is still armed for any legacy install. The notification-click path to this view (`index.tsx:141-145`) and `ReactionsSidebar.tsx` are otherwise dead.

---

## 6. Settings — every section (`DirectoryPermissions.tsx`)

Order on the page: Workspace directories → System prompt → About you → Connectors → Claude Design → APIs → Sharing → Account. **The API key, the one thing a fresh install needs, is the last control on the page**, inside a section called "Account" that also holds "Rescan workspace" (`:366-399`). CLAUDE.md notes there is no first-run nudge; the layout compounds it.

### 6.1 Workspace directories
"Local folders"; rows show the **full absolute path** (`:197-199`) with the lock badge and an unlabelled × ("Remove directory", confirm: *"Are you sure you want to remove this directory from your workspace?"*); **"Add folder"** (max 10, `shared/paths.ts:12`); empty: "No local directories added." Understandable. Same read-only overstatement as §2.3(3).

### 6.2 System prompt
**"Custom instructions appended to the AI system prompt for this workspace. Saved to .academia/SOUL.md."** placeholder **"Enter custom instructions for the AI agent..."** (`:233-245`). Three pieces of jargon in two sentences (system prompt, `.academia/SOUL.md`, AI agent). The feature itself is right for the audience ("how should Claude behave for me"); the label and copy are wrong.

### 6.3 About you
**"Two files Claude reads to know who you are and what you are working on: `about_you.md` and `working_on.md`, in `.academia/agent-memory/`. Claude writes other memories into that same directory on its own, and they are not shown here. See everything Claude has learned →"** (`:276-289`). Fields "About You" / "What You're Working On".
What fills them: only the scan (`researchProfile.ts:35-60,195-212`, Sonnet 4.6, up to $2, written as second-person prose). Production: `about_you.md` = 70 bytes, `working_on.md` = 41 bytes, `scanned_files` = 0 — **the scan has never run**, so the owner's own "About you" is effectively empty and nothing on this page says "press Rescan to fill this in". The two are disconnected by two sections and a heading called "Account".
**Bug:** the textareas load once on mount (`:58-74`, `[]` deps). After a Rescan rewrites the files, the fields keep showing the old text; pressing Save then overwrites the fresh profile with the stale one. No reload, no notice.

### 6.4 Connectors (`ConnectorsSettings.tsx`)
**"Connect Acabox to external services over MCP. Anything you connect becomes a set of tools the agent can call in chat. Changes apply to open chats straight away."** (`:219-223`). Catalog (`shared/connectors.ts:94-142`): **Hex, Sentry, Notion, Linear, GitHub** + Custom — a BI tool and four developer tools; nothing a bench scientist uses (compare the APIs catalog, which is excellent). Status copy: "Status read live from the running agent." / "No chat session has run yet, so no status has been observed." Form: Name (`hex`) with help **"The agent calls its tools as `mcp__hex__…`"**, **Transport** `HTTP (remote)` / `SSE (remote)`, URL (**"Must be https:// — http:// is allowed only for localhost."**), **Headers** rows (`Authorization` / `Bearer …`), **"Always load this server's tools — Off by default: tools stay behind tool search, which keeps them out of every prompt."**, and a warning **"Unmanaged servers in the workspace … `.mcp.json` declares … the agent can write that file itself."** (`:393-407`). Every field demands protocol knowledge. For catalog entries with OAuth the only needed input is the label ("Sign in from chat"), which is fine — but the form still shows Transport/URL/Headers.

### 6.5 Claude Design
**"Not signed in. Sign in to let chats read your claude.ai/design design-system projects."** (`ClaudeDesignSettings.tsx:85`). Clear flow (browser, five-minute link, paste-a-code fallback). The question is relevance: a design-system sync for scientists who "can only vibecode" is a niche the owner wanted; the copy at least says what it is.

### 6.6 APIs (`ApiSettings.tsx`)
**"HTTP APIs Claude may call directly, for services with no MCP connector — or where the connector is read-only and the REST API isn't. Acabox holds the credentials and attaches them itself, so a key is never shown to the agent, written into a script, or stored in a chat."** (`:256-261`). Catalog (`shared/apis.ts:539-760`) is the one genuinely scientific list in Settings: NCBI E-utilities, UniProt, ChEMBL, RCSB PDB, AlphaFold DB, Ensembl, Europe PMC, Crossref, Semantic Scholar, ORCID, Zenodo, Figshare, OSF, protocols.io, plus Hex, Benchling, GitHub; ten need no key. Chips `READ ONLY / READ & WRITE`, `KEY SET / NO KEY`; Test verdicts are honest ("Working — the server answered successfully.", "Reached it — HTTP 200, but the same request works without your key…", "The server rejected the credential", `:824-903`). Form jargon: **"Claude calls it as `$ACABOX_API_BASE/hex/…`"**, **"Requests resolve against this, and on this host they may not escape its path — so a trailing slash matters."**, Authentication `None — public API / Bearer / Custom header / Query parameter / HTTP Basic`, "Header name" `x-api-key`, **"Extra allowed hosts … A leading dot matches subdomains"**, "Notes for Claude … Goes into the prompt verbatim", **"Allow writes … a page it reads mid-task could otherwise talk it into a DELETE."** Also a stale banner branch: **"It starts with the agent — open a chat, or restart Acabox."** (`:270`; CLAUDE.md already flags it as wrong). For a scientist, the catalog cards + one key field is all they need; the rest should be behind "Advanced".

### 6.7 Sharing (`SharingSettings.tsx`)
**"Publish a mini-app or a single workspace file as a read-only, login-gated link on your own Cloudflare Workers deployment — setup lives in `src/share-workers/README.md`. Viewers sign in with an @academia.edu Google account, and Cloudflare Access is free for the first 50 viewers."** (`:98-104`). Fields **Site URL** (`https://acabox-share.<account>.workers.dev`), **API URL**, **Publish token**, Test (**"Send one real GET at /v1/health"**). This points a non-technical user at a README inside the source tree and asks for a Workers deployment and a bearer token. Meanwhile the Files context menu offers **"Share…"** to everyone, which fails with an error notice until this is configured. Either this is an operator-only setting (hide behind Advanced, pre-fill from the operator's deployment) or it should not be visible to a scientist at all.

### 6.8 Account
**"Rescan workspace — Re-scan your folders to refresh your research profile and file tags."** button `Rescan` / `Scanning...` (`:371-393`), then **"Anthropic API key"** — "No API key set. Paste one below to use Acabox." / placeholder `sk-ant-...` / **"Base URL (optional — defaults to api.anthropic.com)"** / "The key is set via the ANTHROPIC_API_KEY environment variable and takes precedence." (`ApiKeySettings.tsx:54-81`). Inline styles reference tokens that do not exist (`--border-color, #555`, `--error-color`, `--success-color`, `:74,81,97-103`) — the same defect CLAUDE.md fixed in ClaudeDesignSettings on 2026-09-23 but not here.

**Rescan cost, which the UI does not state** (`directoryScanner/agents/*`): 1 × Sonnet 4.6 research-profile agent (maxTurns 10, `maxBudgetUsd 2`) + 1 × Haiku file-tagging agent (maxTurns 15) + **1 Haiku call per untagged PDF in every shared folder** (YES/NO classifier, `fileTagging.ts:93-135`) + 1 Haiku call per reference PDF for title extraction (`:410-440`, indexed so once) + **1 Haiku call per manuscript to write a `writing_agent` briefing** (`:544-600`) **into a table no screen renders** (HomePage is dead; production `briefings` = 0 but only because the scan never ran). A lab folder with 800 PDFs = 800+ calls from one unexplained button. Progress events (`scanner:event`) have **no renderer consumer** (grep → only `scannerAPI.start()` in Settings), so the button just reads "Scanning..." for minutes, and the About-you fields do not refresh (§6.3).

---

## 7. Debug
Rail footer entry **"Debug"** for every user (`Rail.tsx:97-102,205-208`). Sections (`DebugPanel.tsx:16-27`): **Logs, Kernels, Observations, File Monitor, Storage, API Key, Scanned Files, Telemetry, Export, Hard Reset**.
- **Telemetry** offers **"Throw in event handler", "Unhandled promise rejection", "Trigger React ErrorBoundary", "Crash renderer process", "Uncaught exception in main"** (`TelemetryDebug.tsx:151-183`) — crash buttons one click from the main nav.
- **Observations** lists "Browser Sessions / File Sessions / Session Files" — the file-monitor data from the dropped Word/browser integrations.
- **Hard Reset** copy: *"The following will be permanently deleted: All chats and message history / All briefings / All calendar events, plans, and resources / All applications in `.applications/` / All workspace configuration in `.academia/`"* (`HardResetDebug.tsx:63-71`). Two of five bullets are dead features; it **omits `tool-data/`** — the saved tool outputs the app promised survive tool deletion — which `ipc/debug.ts:577-579` wipes with the whole `workspace-data` dir.
- **Export / Import**: *"Export all workspace data — chats, reactions, applications, and briefings — as a ZIP file."* (`ExportDebug.tsx:59`) — the only backup affordance in the app, hidden under Debug with stale nouns.
- **Logs** has the only "export logs" button (`AppsDebug.tsx:76`), which is what a support conversation needs — also hidden here.
- `ContainerTests.tsx` (runs `ls /data`, `R --version`) is unreachable; delete it.

For this audience the whole tab should collapse to two user-facing things — "Save a support bundle (logs)" and "Back up / restore my workspace" — with the rest behind a hidden developer toggle.

---

## 8. Jargon list (string → file:line → proposed rewrite)

| Where | Current | Rewrite |
|---|---|---|
| Rail | `Servers` (`Rail.tsx:29`) | "Claude's extra abilities" — or fold into Knowledge as "Abilities" |
| Rail footer | `~/workspace-data SYNCED` (`Rail.tsx:204-205`) | the lab folder's display name, no status word (or a real one) |
| Files | root row `workspace-data` (`FilesTab.tsx:73`) | "Acabox workspace" |
| Files | `Tag as GRANT` (`FilesTab.tsx:59-64`) | drop GRANT; "Mark as manuscript / slides / reference" |
| Files | `Read only` lock (`DirectoryPermBadge.tsx:24`) | "Ask before editing" (and make it true) |
| Settings | `System prompt` / "appended to the AI system prompt… Saved to .academia/SOUL.md." (`DirectoryPermissions.tsx:233-236`) | "How Claude should work with you — standing instructions Claude reads in every chat." |
| Settings | "Two files Claude reads… `about_you.md` and `working_on.md`, in `.academia/agent-memory/`" (`:277-280`) | "Claude keeps a short profile of you and your current projects. Edit it here, or let Claude fill it in from your folders (Scan)." |
| Settings | `Rescan workspace` under **Account** (`:367-373`) | move beside About you: "Let Claude read my folders and draft my profile — uses N calls, a few cents" |
| Settings | `Connectors` / "over MCP" / `Transport` / `Headers` / `mcp__hex__…` (`ConnectorsSettings.tsx:219-223,444-520`) | "Connected services"; hide Transport/URL/Headers unless Custom |
| Settings | APIs: `$ACABOX_API_BASE/hex/…`, "may not escape its path — so a trailing slash matters", "Extra allowed hosts", "Goes into the prompt verbatim" (`ApiSettings.tsx:466-468,480-483,569-580,593-596`) | "Scientific databases Claude can query"; catalog card + key field; everything else under Advanced |
| Settings | Sharing: "your own Cloudflare Workers deployment — setup lives in `src/share-workers/README.md`" (`SharingSettings.tsx:99-103`) | operator-only; for users: "Share a tool or file with your lab (sign-in required)" |
| Settings | `Base URL (optional — defaults to api.anthropic.com)` (`ApiKeySettings.tsx:80`) | hide under Advanced |
| Knowledge | "roster", "frontmatter", "the CLI drops…", `desc 941 chars`, `SKILL.md 4.2 KB` (`KnowledgePage.tsx:71-82,146-160,394`) | "on / off"; "has a formatting error Claude can't read"; drop byte/char meta |
| Knowledge | "a warehouse's traps, a house query form" (`:355-356`) | "how your lab names samples, which columns in your plate-reader export matter, a protocol worth getting right twice" |
| Knowledge | `Import, off the roster` (`ImportSkillPanel.tsx:243`) | "Import (turned off until you enable it)" |
| Knowledge | "This chat queried hex without consulting the ledger" (`KnowledgePage.tsx:565`) | "Claude learned things about Hex in this chat but didn't write them down" |
| Servers | `pid 41823 · 3 tools · node index.mjs` (`ServersPage.tsx:69-77`) | "3 abilities · running" |
| Servers | `Re-promote`, `Awaiting review`, `.mcp-servers/<id>` (`:258-266,381-395`) | "Update to Claude's latest version", "New — needs your OK", hide path |
| Servers | `Advanced: add a server yourself` → Command/Arguments/Environment (`ServerConfigForm.tsx:199-250`) | keep, but only behind a developer toggle |
| Schedule | `Every 7 days` for `0 0 */7 * *` (`scheduleCron.ts:120`) | either true weekly cron (`0 0 * * 1`) or "On the 1st, 8th, 15th…" |
| Schedule | "Daily" (`:120,126`) | "Every day at midnight" and let the user pick the hour |
| Debug | `Debug` in main nav; `Observations`, `Kernels`, `Telemetry` (`DebugPanel.tsx:16-27`) | "Help & backups": Save support bundle · Back up / restore |
| Debug | Hard-reset list naming briefings/calendar, omitting `tool-data` (`HardResetDebug.tsx:66-70`) | list what is actually deleted, including saved tool data |
| Status bar | `CPU 12% · MEM 8.1/16 GB · DISK … · AGENTS 1 LIVE` (`StatusBar.tsx:70-83`) | hide hardware stats by default; keep "Claude is working" |

---

## 9. Walkthrough — a non-technical scientist's first week with these screens

Day 1. Opens Acabox, types a question, gets "No Anthropic API key configured. Add one in Settings." Opens Settings: eight sections; the key is in the last one, under "Account", after "Rescan workspace", a "Base URL" field and a Sharing form asking for a Cloudflare Workers deployment. Pastes the key. Never sees a prompt to add a folder.

Day 2. Adds the lab folder in "Workspace directories". Sets it "Read only" because the data is precious, and trusts the lock. Opens Files: a folder called `workspace-data`, their lab folder, a footer saying `SYNCED`. Clicks the manuscript `.docx` → Word launches (or nothing). Clicks a notebook → JSON.

Day 3. Wants Claude to know who they are; finds "About you" empty, does not connect it to "Rescan workspace" two sections down. Presses Rescan anyway: "Scanning..." for eight minutes with no progress, 600 Haiku calls against their key, briefings written to a table nothing shows, and the About-you boxes still blank until restart.

Day 4. Opens Knowledge to "see everything Claude has learned": 21 skills named `manage-mcp-server`, `react-plotly`, `differential-expression` (which does not work), chips reading `BUILT IN · 54 files · desc 941 chars`, and 28 "memories" with an `UNLINKED` warning. Closes it.

Day 5. Opens Servers: "No servers yet. Ask Claude to build one for you." Does not know what a server is or why they would want one. Opens Activity: "Nothing is scheduled." Tries "New task" to get a Monday summary of new files — can only choose minutes/hours/days; picks "Every 7 days"; it runs at midnight on the 1st, 8th, 15th… and the result appears as a chat called `[Task] Weekly summary — 2026-10-01 (PDT) 00:00` with no link from the task.

Day 6. In Files, reaches for Rename and hits the trash icon on the lab folder. It is gone, permanently.

---

## 10. Strengths worth keeping
- Honest state words everywhere activity is reported: "Ran while Acabox was closed — result unknown", "Stopped by you" (`ActivityPanel.tsx:69-80`); the scheduler's explicit cost note (`SchedulePanel.tsx:324-327`); Test verdicts that refuse to invent a pass (`apis.ts:824-903`).
- The APIs catalog is exactly right for scientists (NCBI, UniProt, Ensembl, Europe PMC, Zenodo…), ten entries need no key, and credentials never reach the agent.
- Knowledge/Servers deliberately show no fabricated meters or "recalled" chips; skills go to a 30-day trash and built-ins can be restored.
- The Files viewer handles the formats it claims well (sortable virtualised CSV, Excel with cell styles and sheet tabs, Chromium PDF, Rendered/Source markdown) and the Copy button is a good Claude-Code borrow.
- Secrets are encrypted at rest and masked over IPC in every Settings section.

---

## 11. Ideas (model calls per use, effort)

1. **Trash + confirm for Files delete** — `shell.trashItem` instead of `rm -rf`, with the same confirm pattern Settings already uses. 0 calls. S.
2. **"Ask Claude about this file" in the Files context menu and viewer header** — attaches the path/contents through the existing attachment adapter and switches to chat; nothing sent until the user types. 0 calls (the user's next turn is one they would send anyway). S.
3. **Fix .docx: render it in-app and drop the Word launch** — the `docx` skill already converts; a mammoth/docx→HTML viewer (or Claude-free text extraction via the existing `extractText`) replaces `open -b com.microsoft.Word`; remove the dead `setDockRightForDocument`/`overlay:ensureReady` calls. 0 calls. M.
4. **Route `.ipynb` in the Files tab to the existing `NotebookViewer`** (read-only). 0 calls. S.
5. **Make "Read only" true or rename it** — a PreToolUse hook on Write/Edit/Bash paths under flagged dirs (CLAUDE.md already names this fix), else label it "Ask before editing". 0 calls. M.
6. **Scheduler: weekday + time-of-day picker, true weekly cron, and link each run to its chat** — `0 0 * * 1`-style expressions, "Every Monday at 08:00", and a "Open result" button using the stored `session_id`. 0 calls. M.
7. **One scheduled template: "Weekly summary of new files"** — a prompt that lists files changed since the task's own `last_run_at` (passed into the prompt by the runner). 1 model turn per run, user-chosen. S.
8. **Kill the Reactions system task entirely** — delete `ipc/reactions.ts`, the boot re-enable, the `activity-summary`/`reaction` skills, `ReactionsToolView`/`ReactionsSidebar`, and migrate any existing `reactions-system` row to disabled/deleted. Saves up to 96 turns/day on legacy installs. L cost removed, 0 added. S.
9. **Settings re-order and reframing** — API key first (with a "not set" banner), then Folders, "How Claude should work with you", "About you" with the Scan button beside it stating its cost before running ("about N calls for N PDFs"), then "Connected services / Databases", with Sharing, Claude Design, Base URL, headers and transport under one Advanced toggle. 0 calls. M.
10. **Scan: reload About-you after the run, show progress, stop writing `writing_agent` briefings** — the briefing step is 1 Haiku call per manuscript into a dead table; removing it is a pure saving; `scanner:event` already carries progress. Removes N calls per scan. S.
11. **Delete the dead verticals** — calendar (8.3k lines UI + 1.2k backend + 31 IPC), HomePage/BriefingHistory, PaperMonitorView, FocusEditor, ContainerTests, MiniAppsTab, Podman strings in SetupBanner; remove `briefings`/`calendar` nouns from Hard Reset and Export copy; list `tool-data` there. 0 calls. M.
12. **Move Debug out of the main rail** — keep "Save support bundle" and "Back up / restore" as a Help section; developer sections behind a hidden toggle; remove the crash buttons from production. 0 calls. S.
13. **Knowledge for scientists** — rename to "What Claude knows", show only domain skills by default (hide `manage-*`, `acabox`, `react-plotly`), drop byte/char meta and roster/frontmatter words, retire `differential-expression`, and replace the Hex-flavoured examples. 0 calls. M.
14. **Replace the Connectors catalog with scientific services or merge it into APIs** — Sentry/Linear/Notion/GitHub are developer tools; the APIs page already has the right catalog. 0 calls. S–M.
15. **Servers page: hide behind Knowledge as "Abilities Claude built", plain-language only** — status word + description + On/Off; pid/argv/stderr under "Details for a developer". 0 calls. M.
16. **Fix the fabricated `SYNCED`** — remove or bind to the symlink resync result. 0 calls. S.

---

## 12. Open questions for the owner
- Is Sharing meant for end users at all, or is it the owner's operator setting? If users, the operator's Site/API URL should be pre-filled and only the token asked for.
- Is "Read only" meant to be enforced? If not, the lock has to go.
- Should Knowledge show Acabox's own machinery skills (`manage-mini-application`, `manage-mcp-server`, `acabox`) to a scientist, or only domain skills?
- Does anyone still need the scan's file tags / `list_scanned_files` tool, given the briefings consumer is dead and production has 0 scanned files? If not, the whole scan could shrink to the one Sonnet profile call.
- Is the Servers page a first-class destination for this audience, or an engine room that Knowledge should front?
