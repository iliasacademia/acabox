# Live walkthrough of Acabox v0.1.27 (dev channel, 2026-09-30)

Driven over CDP against `npm start` with the real dev database (45 chats, 1 tool: Liver Atlas
Explorer, 1 Claude-authored MCP server awaiting review, 22 skills, no shared folders, Haiku 4.5
selected). Screenshots in `../shots/`. Everything below was observed, not inferred.

## Screens, as a non-technical scientist would meet them

### Home ("Command desk") — shots 01, 16 (collapsed rail)
- Header "Command desk · WED SEP 30 · 20:15" + search field "Search chats, tools, files… ⌘K".
  **⌘K and the search field do not open a palette; they switch to the Chats tab** (shot 17).
  The design handoff specified a command palette.
- TOOLS — 1 OF 1: tool card (icon, name, description, Open, "OPENED 7D") + dashed "Build a new
  tool — Describe it below — ACABOX scaffolds it" ("scaffolds" is jargon).
- JUMP BACK IN: 3 recent chats with blue unread dots and relative age.
- DRIVE — ~/WORKSPACE-DATA: lists `tool-data/liverAtlasExplorer/output/results.json 2K`, 
  `…/expression.json 8.2M`, `…/umap.json 3.5M` — internal tool output files with raw paths, not
  the user's research files. With no shared folders this is the only "drive" content.
- Composer placeholder: "What are we building? — describe a tool, paste a repo, or ask". "Paste a
  repo" is developer vocabulary. Buttons: attach, screenshot, mic, model chip "HAIKU 4.5 HIGH",
  send. No starter prompts, no examples, no "try this with your data" for a first-time user.
- Rail: Home, Chats (45 + dot), Tools (1), Knowledge, Servers, Files, Activity; RECENTS (5 chats +
  More); PINNED TOOLS; footer `~/workspace-data SYNCED` (the word SYNCED is a hardcoded string,
  `Rail.tsx:205` — nothing is synced anywhere), Debug, Settings.
- Status bar: `CPU 33% MEM 29.2/36.0G DISK 388/995G AGENTS 0 LIVE … UP 0M` — real numbers, but a
  devops dashboard for a scientist.
- Chrome bar: "ACABOX · V0.1.27" and a green "HEALTHY".

### Chats — shots 02, 34 (search)
- "45 CONVERSATIONS / Chats / Every conversation you've had with me. Most recent first."
- Rows: title, tool chip (display name when the tool exists, raw `linkProbeTool` dir name when it
  does not), preview "You: … · CS: …" — **"CS:" is the assistant-preview prefix**
  (`chatPreviewStore.ts:69`, "exactly the old thread-list format"); it means nothing to a user
  and is not the product's name.
- Search works on titles and message text with highlighted snippets, up to 3 lines per chat.
- Row menu (⋮) exists; no pin, no folders/projects, no bulk actions.

### A chat — shots 18, 41–44 (live Haiku turn)
- Header: back · title · mono `HAIKU 4.5 · HIGH` · "Open tool" (when app-linked) · rename · copy
  link · delete. For a brand-new chat the mono line reads `NAMES ITSELF AFTER THE FIRST REPLY`;
  **it stayed on screen after the reply arrived even though the rail already showed the new
  title ("Sleep Nine Then Confirm")** — stale header until navigation.
- Live turn: "GENERATING" chip in the header, `THINKING…` indicator, then the running step line
  `▸ ● bash sleep 9   1S` with a ticking clock (raw shell command shown to the user), **a Stop
  button (blue square, aria "Stop generating") in the composer**, status bar `AGENTS 1 LIVE`.
  After: `Worked for 13s · 1 step` fold above the answer; model chip turns into a lock.
- Composer placeholder inside a chat: "Reply — or ask for the next change".
- No message editing, no regenerate, no copy-reply button, no feedback, no cost/token readout,
  no changed-files summary (confirm from code; none seen in the DOM).
- User bubble on the right in pale blue, assistant text plain left with mono timestamp.

### Tools — shots 03, 30 (Settings panel open)
- "1 TOOL AVAILABLE / Tools / Things the workspace can do for you. Ask me to build one, then
  return to it any time." CTA card "Ask me to do something or build a tool".
- Row: name, chip "ON-DEMAND" (`ToolsPage.tsx:441`, meaning unclear), description, "USED 7 DAYS
  AGO", buttons Settings / Use. Dashed "Import tool".
- Settings panel: "APIS THIS TOOL MAY CALL" (Crossref checkbox, explanation), "NOT SHARED
  Publish…", "Archive tool", "Delete tool". No rename, no edit-description, no version history,
  no duplicate, no "open the chat that built this".

### Tool view — shots 22–29
- Tab bar with the tool tab; header: back, icon, name, status chip `IDLE`, "Rebuild", chat toggle,
  share, ⋯ menu (View source / Reveal in Finder / Download). Right side panel = the tool's chat
  (switcher dropdown, +, pop-out, collapse), model meta with lock.
- **The tool pane was blank white for the whole session while the chip said IDLE.** Instrumented
  from inside the frame (shot/probe): the bundle throws at mount — "Invalid hook call … Cannot
  read properties of null (reading 'useContext') at useLucideContext" — because the dev npm-site
  holds THREE copies of React (`node_modules/react`, `lucide-react/node_modules/react`,
  `react-plotly.js/node_modules/react`) and esbuild bundled two of them. Production's npm-site has
  no nested copies, so production tools are not affected by this cause. But the FAILURE MODE is
  general and is the finding:
  1. The scaffold's `ErrorBoundary` renders `null` on error and dispatches `cobuild-error`;
     `ErrorDisplay` subscribes in a `useEffect`, i.e. after the first commit, so an error thrown
     during the first render is dispatched before anyone listens. Result: nothing on screen.
  2. The host (`MiniAppViewer`) only knows BUILD errors (`rebuildState.kind === 'error'`); it
     never learns about runtime errors in the frame. A crashed tool reads **IDLE**.
  3. Nothing offers "Ask Claude to fix it" for a runtime crash; the chat beside the tool does not
     know the tool is broken either.
- Share dialog ("Publish 'Liver Atlas Explorer'"): a table CODE 9 files · 15 MB / OUTPUT 5 files ·
  12 MB / INPUT 1 file · 393 MB / VENDOR / TOTAL 20 files · 420 MB, "Include input data" checkbox,
  "Viewers need an @academia.edu Google account. Everything in the table is uploaded." Clear and
  honest, but the Sharing settings it depends on ask for two Worker URLs and a publish token.
- Side-panel folds: `Worked for 18s · 1 step` → `Ran 1 command  1 STEP` → `bash sleep 14` row.
- Background installer: on EVERY boot the host runs a pip wave for this tool's
  `requirements.txt` and logs `pip wave exited with code 1 … pip wave failed` although every
  package reports "Requirement already satisfied"; stderr is not logged, and nothing in the UI
  shows it (seen 4 boots in the dev log: 09-28 ×3, 09-30).

### Knowledge — shots 04, 31
- "22 SKILLS · 1 MEMORY / Knowledge / What Claude can do here, and what it has learned. All of it
  is markdown you can read and correct."
- NEEDS ATTENTION 3: three cards "This chat queried spike without consulting the ledger — 'Call
  spike_counter tool once' · 6w ago — [Ask Claude to extract it] [Dismiss]". Opaque to anyone who
  does not know what the ledger is; two of the three are duplicates.
- "Add a skill — A skill is a folder of instructions Claude loads when it decides the job needs
  them — a warehouse's traps, a house query form, a procedure worth getting right twice."
- SKILLS list: `acabox  BUILT IN  PROPRIETARY … SKILL.md 15 KB · desc 602 chars · changed 9d ago
  [Open] [Disable]`. Open shows a modal `acabox/SKILL.md` with Read/Edit tabs, FRONTMATTER block,
  Rendered/Source toggle, a truncated absolute path, "Reveal in Finder", "Ask Claude to improve
  this", Cancel, Save. This is a developer file editor.

### Servers — shots 05, 32
- "0 SERVERS RUNNING HERE / Servers / Local MCP servers Acabox runs on this machine — separate
  from Connectors, which are remote services Acabox connects to."
- AUTHORED BY CLAUDE 1: "DNA Toolkit  Awaiting review … `.mcp-servers/dna-toolkit`  [Review &
  enable] [Remove]"; "Show built into Acabox (8)"; "Remote services are configured in Settings →
  Connectors". The Servers/Connectors split is an implementation distinction.

### Files — shots 06, 46
- "7 FILES / Files" and a tree `workspace-data > data, tool-data`. Clicking a JSON file opens a
  full-page viewer with "← Back to files", filename, "Copy", syntax-highlighted content. No
  preview pane, no "ask about this file", no drag into chat, no "add folder" CTA when empty.

### Activity — shots 07, 33
- "ON A SCHEDULE — Nothing is scheduled. [New task]" and "Nothing running, and nothing waiting on
  you." New task panel: NAME, DESCRIPTION, "WHAT SHOULD CLAUDE DO?" textarea with a good
  explanation ("This is sent as a chat message, on the schedule below…"), HOW OFTEN "Every 1
  hours", and the honest cost line "Each run is a real conversation with Claude, billed to your
  API key, and it happens whether or not Acabox is on screen." Only interval schedules (every N
  minutes/hours/days); no "every Monday 9am", no run-now, no history visible until a run exists.

### Settings — shots 08, 10–12
- Workspace directories: "Local folders — No local directories added. [+ Add folder]".
- System prompt: "Custom instructions appended to the AI system prompt for this workspace. Saved
  to .academia/SOUL.md." (jargon + file path).
- About you: "Two files Claude reads to know who you are …: about_you.md and working_on.md, in
  .academia/agent-memory/. Claude writes other memories into that same directory on its own, and
  they are not shown here. See everything Claude has learned →" then two textareas.
- Connectors: "Connect Acabox to external services over MCP… No connectors yet. No chat session
  has run yet, so no status has been observed. [Refresh] [+ Add connector]".
- Claude Design: "Not signed in. Sign in to let chats read your claude.ai/design design-system
  projects."
- APIs: "HTTP APIs Claude may call directly, for services with no MCP connector — or where the
  connector is read-only and the REST API isn't…" Crossref row with Test/Disable/Edit/Remove.
- Sharing: "Publish a mini-app or a single workspace file as a read-only, login-gated link on
  your own Cloudflare Workers deployment — setup lives in src/share-workers/README.md …" with SITE
  URL / API URL / PUBLISH TOKEN inputs. A repo path in end-user settings copy.
- Account: "Rescan workspace", "Anthropic API key — Active key: sk-ant-api…(masked tail) (from settings)",
  key input `sk-ant-...`, "Base URL (optional — defaults to api.anthropic.com)", "Update key". No
  link to where a key comes from, no validation feedback shown, no spend information.

### Debug — shot 09
- A developer panel in the main rail for everyone: Logs, Kernels, Observations, File Monitor,
  Storage, API Key, Scanned Files, Telemetry, Export, Hard Reset ("Deletes all data for the
  current workspace and relaunches the app").

### Model picker — shot 38
- Popover: "Haiku 4.5 — Fastest for quick answers ✓", "Effort  High ›", "More models ›". The
  chip copy is the model's marketing name plus an effort level; no cost hint.

## Naming observed on screen
- The agent is told to call itself Acabox; the UI says "Claude" in Knowledge ("What Claude can
  do here", "Ask Claude to extract it", "Ask Claude to improve this"), Servers ("Authored by
  Claude"), Settings ("Two files Claude reads"), Activity ("What should Claude do?"), while Chats
  says "me" and previews say "CS:". Tools are "tools" in the UI, "mini-apps" in Settings →
  Sharing and in the agent's vocabulary.

## Things that worked well
- The shell is fast, quiet and consistent (DM Sans + mono labels, flat cards, blue = clickable).
- Turn folding ("Worked for 13s · 1 step") keeps a finished conversation readable.
- Stop button exists and is wired; unread dots and the working dot are live and correct.
- Chat search with snippets is genuinely useful; the scheduler's cost sentence is a model of
  honesty; the share dialog's size table is exactly the right disclosure.
- The tool card appears immediately and the viewer shows real states (BEING WRITTEN, BUILD
  FAILED) for the cases it knows about.

## Live tests run after the walkthrough (dev app, Haiku 4.5, 2026-09-30 20:24–20:33)

1. **Stop mid-turn.** Sent "Use the Bash tool to run exactly `sleep 25`, then reply with exactly: STOPTEST DONE" and pressed the composer's Stop button ~5 s later. The log shows the session destroyed at 20:31:53.698. During the kill grace period the model still produced a reply, shown as a finished turn: `Worked · 1 step  1 FAILED` (no duration — a stopped turn writes no result row) followed by "I can't run a standalone `sleep 25` — the sandbox blocks long sleep commands to prevent polling loops…" (a hallucinated reason; nothing blocked it, the user's Stop killed it). The next message in the same chat logged `Cleaned 4 orphan turn rows` and the DB for that chat now holds only: user, user, assistant(thinking), assistant("AFTER STOP"), result. The failed step and the hallucinated explanation were deleted from the database while still on screen. Shots 47–49.
2. **AskUserQuestion.** Asked the agent to use the AskUserQuestion tool with two options. Reply: "I don't have access to an `AskUserQuestion` tool in my current environment." No tool_use row in the DB. Structured clarifying questions are not available in this harness today (no canUseTool handler, tool absent from the toolset).
3. **Cost is received and thrown away.** `agentSession.ts:1328-1332` persists only `subtype`, `result`, `is_error` from the SDK result message; `total_cost_usd`, `duration_ms` and `usage` are not stored or shown anywhere (`grep total_cost_usd src/cobuilding` → no hits).
4. **Blank tool root cause (dev only) and general failure mode.** Probing the mini-app frame with error listeners installed before load: `Invalid hook call … Cannot read properties of null (reading 'useContext') at useLucideContext`. The dev npm-site holds three copies of React (`node_modules/react`, `lucide-react/node_modules/react`, `react-plotly.js/node_modules/react`); production's npm-site has none nested, so production tools are not hit by this cause. General part: the scaffold's ErrorBoundary renders null and `ErrorDisplay` subscribes in a `useEffect`, so a render-time crash is dispatched before anyone listens; the host (`MiniAppViewer`) only tracks build errors, so the chip read IDLE over a blank pane for the whole session.
5. **Files tab delete has no confirmation and no Trash**: `FilesTab.tsx:368-371, 449-451` → `filesAPI.deleteFile` → `fileHandlers.ts:323` `fsPromises.rm(resolved, { recursive: true })`. Verified by reading, not by deleting anything.
6. **"Every N days" schedules are day-of-month steps**: `scheduleCron.ts:26` emits `0 0 */N * *`, so "Every 7 days" fires on the 1st, 8th, 15th, 22nd, 29th and 1st.
7. **Node.js is a hidden prerequisite for building tools**: nothing in `main/` installs react/react-dom/react-plotly.js/lucide-react into the npm-site (grep → no hits), the scaffold script is invoked as `node …/manage_mini_app.mjs`, and `nodeSetup.ts:9` says "We don't bundle npm itself — most users on macOS have it via Homebrew, nvm…". On a stock Mac the first tool build fails.
