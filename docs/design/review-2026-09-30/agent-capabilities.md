# Acabox review — what the agent can do, what it is told, guardrails, skills, memory, scheduling, scans

Reader: agent-capabilities. Repo: `/Users/iliasbeshimov/Documents/Dev Folders/Acabox` (paths below are relative to `src/cobuilding/` unless they start with `docs/`, `node_modules/` or `/`). Read-only review of code plus a read-only look at the production userData (`~/Library/Application Support/acabox/production`, databases copied to the scratchpad before querying; no secrets printed). Judged for a non-technical scientist who cannot read code, does not use a terminal, and cannot debug a build.

---

## 0. Headline findings

1. **The agent runs with no approval surface at all.** `allowedTools` is auto-approve, `permissionMode` is never set, there is no `canUseTool`, and the only PreToolUse hooks block package installs and credential-file reads (`shared/agentAllowedTools.ts:12-16`, `agent-server/index.ts:555-616`, `settings.json:1-28`). `rm -rf` on a shared research folder runs silently. There is no trash for agent deletions, no snapshot, no undo, no dry-run, and "read only" folders are a sentence in the prompt (`main/agentSession.ts:590-591`) that the agent's own skill admits "Nothing enforces" (`skills/acabox/SKILL.md:271-273`) while the UI shows a padlock labelled "Read only" (`renderer/components/DirectoryPermBadge.tsx:24`).
2. **The agent is never told who it is talking to.** Nothing in the system prompt, `CLAUDE.md`, or any skill says the user is a non-technical scientist or asks for plain language (the only "plain language" line in the whole agent-facing corpus is `skills/manage-mcp-server/SKILL.md:69`). The agent is instead taught a vocabulary of `dir_name`, esbuild, `mcp__…` tool names, PreToolUse hooks, 405/403 codes and `$ACABOX_API_BASE`.
3. **The product disagrees with itself about the agent's name.** The agent is ordered "Never identify yourself as Claude; you are Acabox" (`main/hostApps/identityPreamble.ts:6`), while every UI surface says Claude — "What should Claude do?", "Ask Claude to fix it", "Claude is still writing this tool", "What Claude has learned" — and the chat list still prefixes replies with "CS:" (Coscientist) (`renderer/chatPreviewStore.ts:64-69`, `renderer/components/assistant-ui/thread-list.tsx:303`).
4. **The acabox skill — the one the agent reads to answer "what can you do?" — promises R, R kernels and a ready-to-go DESeq2 skill** (`skills/acabox/SKILL.md:78-85`) that the differential-expression skill itself says "does not currently run" (`skills/differential-expression/SKILL.md:17-27`), and promises "A daily activity-summary … and reaction threads" (`:257-258`) that no UI can turn on.
5. **The research-profile scan has never run in production and cannot run by itself.** Its only trigger is a "Rescan" button in Settings → Account (`renderer/components/DirectoryPermissions.tsx:371-392`, `main/index.ts:1397`); nothing runs it at boot or when a folder is added; its progress events have no renderer listener; its output overwrites the user's hand-edited "About you" text; and the briefing cards it generates with one Haiku call per manuscript render on a page (`HomePage.tsx`) that is no longer mounted. Production DB: `workspace_reports`, `scanned_files`, `briefings` all empty.
6. **Scheduled tasks are full Opus 5 / high-effort agent turns with every tool, no turn cap, no budget cap, and no cost shown anywhere** (`main/scheduledTasks/runner.ts:25-55` passes no model; `main/controllers/AgentInfrastructureController.ts:507-511` sets `model: DEFAULT_MODEL`, `effort: 'high'`). `total_cost_usd` is never read by any code (grep: zero hits in main or renderer). A dormant system task ("Reactions", every 15 minutes, runs WebSearch for papers) would be 96 such turns a day if the `reactionsEnabled` settings flag were ever set — and the only UI that mentions it says "Enable in Settings → Reactions", a section that does not exist.
7. **Memory and the findings ledger work and are heavily used** — production has 28 agent-written memory files with a 5.7 KB `MEMORY.md` loaded every turn, and 6 findings in `manage-mini-application` — but what the user sees of them is a Knowledge page written in developer vocabulary ("not indexed in MEMORY.md", "Frontmatter did not parse", "roster characters").

---

## 1. Full tool inventory — what the agent can actually do

### 1.1 Built-in Claude Code tools

The chat agent is `query()` with `systemPrompt: { type: 'preset', preset: 'claude_code', append }` and **no `tools` restriction** (`agent-server/index.ts:555-616`; `agent-server/sessionConfig.ts:39-56` has no `tools` field). So the model has the CLI's whole toolset. The auto-approved subset (`shared/agentAllowedTools.ts:43-81`):

| Tool | Approved | Shown to the user as |
|---|---|---|
| Bash | yes | `bash <command>` row; "Ran N commands" in the fold (`renderer/components/assistant-ui/tool-card-display.ts:42-49`, `turnSteps.ts:170-209`) |
| Read / Write / Edit | yes | `read` / `write` / `edit` + path; "read N files", "wrote N files" |
| Glob / Grep | yes | `glob` / `grep` + pattern; "searched" |
| Agent (sub-agents) | yes — no custom `agents` defined, so the CLI's default sub-agent types | `agent` + description; "Running sub-agent" (`tool-labels.ts:58-61`) |
| WebSearch / WebFetch | yes | `web` / `fetch` |
| TodoWrite, TaskCreate/Update/Get/List | yes (both spellings) | `todo` checklist |
| ToolSearch | yes | "Searching tools" |
| EnterPlanMode / ExitPlanMode | yes | `plan` — **note: ExitPlanMode being auto-approved means the agent approves its own plan; "plan mode" offers the user no gate** |
| NotebookEdit, Skill, AskUserQuestion, DesignSync, ListMcpResources, ReadMcpResource… | present in the preset (`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:750-1102, 2721-2937`) but **not** in `allowedTools` | NotebookEdit is labelled; AskUserQuestion has no renderer at all (grep `AskUserQuestion` in renderer: none) |

What happens to a tool that is present but not auto-approved is **unresolved by this review**: `shared/agentAllowedTools.ts:12-16` says "an unlisted tool still runs — it just falls to the default permission path", and the root CLAUDE.md records that `allowedTools: []` still ran Bash; but the bundled SDK's own doc says "Without one (bare -p / SDK query() with no canUseTool), 'ask' decisions are terminal" (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5291`). Either way the consequence for the user is the same — nothing ever asks them — but whether `AskUserQuestion` (structured clarifying questions) silently fails is worth one live test. It is the one tool whose absence a non-technical user would feel most.

**Not available, and the user is told so only if they ask:** no browser or computer use (`skills/acabox/SKILL.md:276-277`), no image generation (nothing in the SDK tool list; mini-apps can call Haiku/Sonnet/Opus through the proxy but no image model), no voice output (dictation input only), no background jobs that outlive a turn (`CLAUDE.md:91-101`, "A background shell command dies when your turn ends"), nothing runs while Acabox is quit except mini-app shell commands already in flight.

### 1.2 Acabox's own MCP relay servers (defined `agent-server/index.ts:227-408`, executed `main/controllers/AgentInfrastructureController.ts:117-370`)

| Server.tool | What it does | Notes for the audience |
|---|---|---|
| `activity.query_activity` | Browser pages visited and files edited/viewed, by time range | Browser capture is a dropped integration; only the local file monitor feeds it |
| `notification.show_notification` | Native macOS notification with optional deep link | Works; used by the reaction skill |
| `reaction.create_reaction_thread` | Creates a chat row with `source='reactions'` | Reachable in UI only via a notification click (`renderer/index.tsx:138-144`); the view it opens is a stub saying "Enable in Settings → Reactions" (`renderer/components/ReactionsToolView.tsx`) |
| `mini-apps.open_mini_application` / `build_and_open_mini_application` | Open / esbuild-and-open a tool by `dir_name` | Core feature; labels "Opening tool" / "Building tool" / "Build failed" are good plain language (`tool-labels.ts:161-170`) |
| `mini-apps.list_published_servers` / `call_published_tool` | Call tools a mini-app publishes while its iframe is open | Fulfils the fork charter's third capability |
| `knowledge.record_finding` | Host-written findings ledger per skill | 6 real findings in production (`…/skills/manage-mini-application/references/findings/digest.md`) |
| `workspace.get_scanned_files` / `get_research_profile` | Scan index and profile | Both empty in production (never scanned); profile falls back to `about_you.md`/`working_on.md` |
| `apis.list_apis` | Live list of Settings → APIs entries, masked | Good design: never reveals credentials |
| `chats.list_chats` / `read_chat` | Read other chats in the workspace (paginated) | Devin-style chat links; well bounded |
| connectors `mcp__<id>__*` | User's remote MCP servers (production: `hex`) | Approved whole |
| hosted `mcp__<id>__*` | Claude-authored local MCP servers (Servers page) | Start disabled; user enables — the one real approval gate in the product |

Dead duplicates: `main/mcpServers/notificationMcpServer.ts` and `reactionMcpServer.ts` are imported nowhere (grep: no imports); the live implementations are the relay handlers in the controller.

### 1.3 Skills on the roster
`buildSkillRuntimeConfig` passes the enabled store ids plus the bundled `claude-api` skill (`shared/skills.ts:154, 571-580`); `skillListingBudgetFraction: 0.05` (`agent-server/index.ts:614`). Production `skills-state.json`: 22 built-ins enabled, 6 custom skills (all disabled). Per-skill status is in §5.

### 1.4 Environment
Python venv with `pandas numpy matplotlib` (plus `jupyter_kernel_gateway`), npm prefix with React/Plotly/lucide; installs only through `.applications/install pip|npm|manual` (`CLAUDE.md:11-31`); `apt`, `R`, `conda` refused (`hooks/block-host-installs.sh:36-44, 73-76`). HTTP APIs through the credential-holding proxy (`CLAUDE.md:33-67`).

---

## 2. What the agent is told

### 2.1 System prompt assembly (`agent-server/index.ts:520-553`, `buildSystemPrompt`)
`claude_code` preset + `append` = `soulMd` + `docxGuidance/hostGuidance` + `workspaceDirectoriesGuidance` + `apiGuidance` + `KNOWLEDGE_ROUTING_GUIDANCE`, built per session in `main/agentSession.ts:567-603, 741-757`:

- **Identity** (`main/hostApps/identityPreamble.ts:6-10`), every session: *"You are Acabox, a local research workbench that does the work and builds the tools. Never identify yourself as Claude; you are Acabox. … Default to doing the thing rather than explaining how the user could. When a task is one the user will repeat, offer to build it into a mini-app. When the user asks about Acabox itself … invoke the `acabox` skill."*
- **Custom instructions** = the whole of `<workspace>/.academia/SOUL.md` (`agentSession.ts:569-574`). Edited in Settings under the heading **"System prompt"**: *"Custom instructions appended to the AI system prompt for this workspace. Saved to .academia/SOUL.md."*, placeholder *"Enter custom instructions for the AI agent..."* (`renderer/components/DirectoryPermissions.tsx:233-245`). Production SOUL.md is an 8,000-byte "Orchestrator System Prompt — Cost-Aware Execution" the owner wrote — i.e. power-user content; a scientist is unlikely to produce anything under a heading called "System prompt".
- **Workspace directories** (`agentSession.ts:586-601`): `- Name/ (read only) — make a copy inside the workspace before editing; direct edits will fail.` / `- Name/ (read & write) — edit files directly.` **"direct edits will fail" is false** — nothing fails; see §4.
- **APIs** (`shared/apis.ts:451-481`): the curl recipe plus one line per enabled API with the user's "Notes for Claude".
- **Knowledge routing** (`agent-server/index.ts:500-518`): a fact about the USER → memory file; a fact about a DATA SOURCE/SYSTEM → `mcp__knowledge__record_finding`.
- **Workspace `CLAUDE.md`** (`src/cobuilding/CLAUDE.md`, loaded via `settingSources: ['project']`): relative paths, never `cd`, install wrapper, API proxy, opening mini-apps by `dir_name`, scanned files, background commands die with the turn, TodoWrite for 3+ steps. Provisioned with policy `keep-local`, so the agent — which has Write on the workspace — can rewrite its own rules and they stay (`main/skills.ts:84-100`: only `settings.json` and the hook scripts are `restore`d).

### 2.2 About the user
The agent is told nothing about the user in the prompt. The research profile (`about_you.md`, `working_on.md`) is NOT injected; it is reachable only through `mcp__workspace__get_research_profile`, and `CLAUDE.md:89` tells the agent to call it "When the user asks about their research profile or what you know about them". In production the two files read, in full: "My name is Ilias Beshimov and I am a product manager at academia.edu." / "I'm working on the co-scientist product." — hand-typed in Settings, never generated. The auto-memory index (`MEMORY.md`, loaded every turn by the CLI) is in practice where the agent's knowledge of the user lives.

### 2.3 Nothing says "speak plainly"
Grep for non-technical / plain language / jargon / layperson across `CLAUDE.md`, all skills, `agentSession.ts`, `agent-server/index.ts`: one hit, `skills/manage-mcp-server/SKILL.md:69` ("Tell the user what you built in plain language (not a `tools/list` dump)"). The acabox skill's "Voice" section (`SKILL.md:39-54`: "Lead with the result", "Concrete over hedged", "Brief") is good but is only in context when the user asks about Acabox itself. Meanwhile `CLAUDE.md` and `manage-mini-application/SKILL.md` mention `dir_name`/esbuild/MCP/TypeScript/npm/pip 9 and 63 times respectively, and tell the agent to relay "405 read-only" / "403 naming a refused host" to the user (`CLAUDE.md:56-58`).

---

## 3. Memory: what persists, who controls it

- **Auto-memory ON**, directory `<workspace>/.academia/agent-memory` (`agent-server/index.ts:598-600`); `autoDreamEnabled: false` with the reason in the comment (`:601-606`). The CLI loads `MEMORY.md` every turn; other files are reached through its links (`shared/paths.ts:31-36`). Production: 28 files (feedback_*, project_*, reference_*, user_*), index 5.7 KB — real, useful, and growing; the agent writes them with no notice to the user.
- **User surfaces:** Settings → "About you": *"Two files Claude reads to know who you are and what you are working on: about_you.md and working_on.md, in .academia/agent-memory/. Claude writes other memories into that same directory on its own, and they are not shown here. See everything Claude has learned →"* (`DirectoryPermissions.tsx:277-286`). Knowledge page: "N MEMORIES", "What Claude has learned", per-row chips including *"not indexed in MEMORY.md"* and the tooltip *"MEMORY.md does not link to this file, so the model has no pointer to it."* (`renderer/components/knowledge/KnowledgePage.tsx:310, 414, 428, 484-501`); detail modal with edit and **"Ask Claude to improve this"**, whose prompt is *"Please review the memory file `.academia/agent-memory/x.md` (under `.academia/`). Read it, then tell me whether anything in it is now wrong or belongs in a skill instead of a memory."* (`KnowledgeDetail.tsx:255-258`).
- **Transcripts** persist in `<userData>/claude-config/projects/<key>/<id>.jsonl` (`main/claudeConfigDir.ts:4-8`), deleted with the chat and swept at boot; the agent is blocked from reading them (`hooks/block-secret-reads.sh:43`).
- **Findings ledger** (`main/knowledge/findingsLedger.ts`): host-written, never refuses a write, per-skill `references/findings/{digest.md,index.md,<bucket>.md}`. Surfaced as a "N FINDINGS" chip on the skill row (`KnowledgePage.tsx:100-104`) and inside the skill detail. The **omission watch** (`main/knowledge/omissionWatch.ts`) raises a Knowledge "Needs attention" row *"This chat queried hex without consulting the ledger"* with **"Ask Claude to extract it"**, whose prompt reads *"Earlier in this chat you used hex without reading anything under `references/findings/`. … record each one with `mcp__knowledge__record_finding`…"* (`KnowledgePage.tsx:543-575`). Production `knowledge-review.json` already holds six such rows — for the target audience this is a recurring notification about an internal bookkeeping rule, in developer vocabulary.
- **Nothing lets the user say "forget that"** short of editing or deleting a markdown file on the Knowledge page, and nothing tells them when a memory was just written.

---

## 4. Guardrails — what exists, what is missing

**Exists**
- `block-host-installs.sh` (exit 2 on pip/npm/apt/conda/`install.packages`) and `block-secret-reads.sh` (settings file, claude-config, `.claude.json`, `agent.json`) — both `PreToolUse` on Bash, the second also on Read|Edit|Write (`settings.json`). Hooks and `settings.json` are re-provisioned with `restore` so the agent cannot disable them (`main/skills.ts:84-100`).
- Secrets encrypted at rest; `agent.json` 0600 outside the workspace; API proxy attaches credentials, read-only by default (405), host allow-list (403); connectors host-owned; hosted MCP servers start disabled and the user enables them on the Servers page; imported skills carry an honest warning: *"Bash is auto-approved in Acabox with no permission handler. An imported skill can instruct Claude to do anything you could do at a terminal … Importing is a trust decision equivalent to `curl … | sh`"* (`renderer/components/knowledge/ImportSkillPanel.tsx:555-562`).
- Skill revert/delete go to a trash (`main/skillStore.ts:205-262`); `workspace-file-backups/` covers only hooks and `settings.json`.
- The **scanner** agents have real deny hooks for hidden paths and paths outside the scan roots (`main/directoryScanner/shared.ts:226-278`) — the one-shot scanner is sandboxed harder than the chat agent that edits the user's files.
- Tool-job Stop button and quit-time warning (Activity page); chat delete asks *"Delete this chat? This cannot be undone."* (`ChatHeader.tsx:80`).

**Missing (for an audience that cannot inspect what happened)**
- No approval step for any agent action; no `canUseTool`; no deny rule for `rm -r`, `rm -f`, `mv` over a user file, `>` truncation, `git clean`, or writes into a read-only folder.
- No trash for agent deletions, no pre-edit snapshot, no undo, no diff view of what the agent changed in a user file. The file monitor's `.academia/temp_files` snapshots (`main/fileMonitor/fileMonitorService.ts:64-85`) exist for activity diffs, not recovery, and only for files the monitor saw opened.
- Read-only is advisory. The guidance even claims "direct edits will fail" (`agentSession.ts:590`), so the agent may believe a guard exists and skip care.
- `manual` install scripts are "elevated-risk — Verify with the user before running one" in prose only (`manage-mini-application/SKILL.md:548`); nothing enforces the verification.
- Self-modification: `CLAUDE.md` (keep-local), `SOUL.md`, memory and every skill under `.claude/skills` are agent-writable by design.
- No `maxTurns`/`maxBudgetUsd` on chat or scheduled runs (only the scanner has them: `researchProfile.ts:37-38`, `fileTagging.ts:41-42`); no cost shown anywhere.

---

## 5. Skills — one line each

| Skill | Purpose | State | A user would say |
|---|---|---|---|
| `acabox` | Identity/voice/capability inventory | **Stale/wrong**: claims "Run Bash, Python, and R directly on the host" (:78), "(Python or R kernels)" (:83), "Domain skills ready to go: differential-expression (DESeq2…)" (:84-85), "daily activity-summary … reaction threads" (:257) | "what can you do?", "is X possible?" |
| `manage-mini-application` | Scaffold/build mini-apps | Working; stale bits: `--kernel ir for R` (:45), refers to `Monitor`/`ScheduleWakeup` tools that are not in this harness (:107); 748 lines of dev vocabulary | "build me a tool/dashboard" |
| `react-plotly` | Charts in mini-apps | Working | (implicit when building charts) |
| `manage-mcp-server` | Claude writes a local MCP server | Working; only skill that says "plain language" | "give yourself a tool that…" |
| `academic-writing-agent` | Draft/revise/review/cite | Working; mentions a "Zotero library" the fork dropped (:204) | "review my introduction" |
| `docx` / `pdf` / `pptx` / `xlsx` | Anthropic document skills | Working (licence question noted in `docs/design/skills-plugins-connectors.md`) | "edit this Word doc", "merge these PDFs" |
| `database-lookup` | 78 public DBs via REST | Working; says "Check environment or `.env` for: NCBI_API_KEY…" (:70-73), contradicting the never-ask-for-keys rule | "look up gene X" |
| `ensembl-database`, `gnomad-database`, `geo-database`, `pdb-database`, `alphafold-database-access`, `opentargets-database`, `reactome-database`, `string-database-ppi` | Deeper per-DB recipes | Working; GEO/PDB correctly say `GEOparse`/`rcsb-api` are NOT installed | "find the structure of…", "download GSE…" |
| `flow-cytometry` | FlowKit gating scripts | Plausibly working (FlowKit must be installed via wrapper) | "gate these FCS files" |
| `differential-expression` | DESeq2 in R | **Broken, self-declared** ("does not currently run", :17-27); still enabled and on the roster, costing listing budget | "run DESeq2" |
| `activity-summary` | Daily activity log from the file monitor | Runs only from the dormant Reactions task; "Also used by the hourly scheduler" is stale (task is 15-minutely and unreachable) | "what did I work on today?" |
| `reaction` | Paper suggestions off the activity summary | Unreachable: no UI toggle for `reactionsEnabled` (grep renderer: none); its output view is a stub | — |
| `claude-api` (bundled SDK skill) | Anthropic API reference | Working | (mini-app code calling the API) |

Other stale leftovers the agent or user can hit: `agent-server/index.ts:2` header "runs inside the Podman container"; `renderer/components/SetupBanner.tsx:42-55` "Downloading Podman…", "Initializing Podman VM…" (still mounted at `renderer/index.tsx:1123`; emitter is `containerService.ensureSetup`, which no longer has a Podman to set up); `tool-labels.ts:92-160` labels for ms-word/obsidian/apple-notes/google-docs/google-drive tools that no longer exist; `prebuilt-apps/grantFinder` (dropped feature); `CLAUDE.md:5` still says user directories are "mounted".

---

## 6. The research-profile scan and file tagging

**When it runs:** only when the user presses **Rescan** in Settings → Account (*"Re-scan your folders to refresh your research profile and file tags."*, button disabled with zero local folders) → `scanner:start` → `BriefingsController.runInitialWorkspaceScan` (`DirectoryPermissions.tsx:371-392`, `main/index.ts:1397`, `main/controllers/BriefingsController.ts:39-57`). No boot trigger, no trigger on adding a folder (`main/ipc/workspaceIpc.ts`, `WorkspaceController.ts`: no scan call). Production: never run (`workspace_reports` empty).

**What the user sees while it runs:** the button reads "Scanning...". The scanner emits "progress"/"file_activity" events (`researchProfile.ts:133-193`, forwarded as `scanner:event` at `main/index.ts:544`) but no renderer code subscribes (`scannerAPI.onEvent` exists only in `types.d.ts:1195`). The onboarding screen that showed them was deleted.

**What it produces:**
- `about_you` and `working_on`, 2-4 second-person paragraphs each (`researchProfile.ts:58-73`), stored in `workspace_reports.report_data` AND written over `.academia/agent-memory/about_you.md` / `working_on.md` unconditionally (`researchProfile.ts:195-213`). **A rescan silently replaces whatever the user typed in Settings → About you.**
- Tagged files (manuscript/grant/presentation/reference) → `scanned_files`, queried by `get_scanned_files`.
- Every reference PDF converted to a full-text markdown copy in `.academia/references/` with a Haiku-extracted title (`fileTagging.ts:401-460`).
- A `writing_agent` briefing per manuscript (`fileTagging.ts:553-661`), rendered only by `HomePage.tsx`/`BriefingHistory.tsx`, which `renderer/index.tsx` no longer imports, and whose click target is the dropped Word overlay (root CLAUDE.md, "Known hazards").

**Model and cost per scan:** profile agent `claude-sonnet-4-6` (a SUPERSEDED id per `shared/models.ts:64-70`, hardcoded), `maxTurns 10`, `maxBudgetUsd 2`, effort low, thinking disabled; tagging agent Haiku 4.5, `maxTurns 15`, `maxBudgetUsd 1`; plus **one Haiku call per untagged PDF** (YES/NO, ~1,500 chars in), one per reference (title), one per manuscript (card) — unbounded in count, cheap each, minutes of wall time for a large folder with no progress display. Tree capped at depth 4 / 500 lines (`shared.ts:122-141`). Hidden dirs excluded. Google-Drive branches are dead code.

**Where the output is seen:** Settings → About you textareas; the agent via `get_research_profile`; nothing on Home or in the chat empty state (the chips there are static: "Turn a script into an app", "What's in my folders?", "Build a PDF → BibTeX tool" — `thread.tsx:98-111`).

---

## 7. Scheduled tasks

**UI** (Activity page → "On a schedule" → `renderer/components/schedule/SchedulePanel.tsx`): fields **Name** ("Overnight data check"), **Description**, **"What should Claude do?"** with help *"This is sent as a chat message, on the schedule below. It can do anything you could ask for in a chat — read your files, run code, and use your servers. Ask it to notify you and it will."*, **How often: Every N [unit]**, note *"Each run is a real conversation with Claude, billed to your API key, and it happens whether or not Acabox is on screen."*, **Recent runs**, **Run now**.

**What a run is** (`main/scheduledTasks/runner.ts:11-57`, `scheduler.ts:43-80`): `createAgentSession(…)` with no model and no effort → the agent-server default `model: 'claude-opus-5'`, `effort: 'high'` (`AgentInfrastructureController.ts:507-511`, `agent-server/sessionConfig.ts:92-107`), full toolset, auto-approved, no `maxTurns`, no budget; the prompt is sent as a user message; the chat lands in Chats titled `[Task] <name> — <date> (<tz>) <time>`. Runs only while Acabox is running (main-process `setTimeout`); nothing catches up a run missed while the Mac slept or the app was quit, so "whether or not Acabox is on screen" is true but a user will read it as "even when closed".

**Cost model:** one unattended Opus-5 high-effort agent turn per run, open-ended in length. No model picker, no estimate, no per-run cost (the SDK's `result.total_cost_usd` is never stored or shown). Production: zero tasks, zero runs.

**The dormant system task:** `ensureReactionsTask` seeds "Reactions" (`*/15 * * * *`, prompt: run `activity-summary` then `reaction`, which WebSearches for papers and fires a notification) when `reactionsEnabled` is true (`main/ipc/reactions.ts:16-21, 53-58`; `main/index.ts:1262-1266`). No renderer code calls `settings:setReactionsEnabled` (grep: none). If the flag were ever set, that is 96 Opus-5 agent turns per day with a paper search each. The feature is unreachable but armed, and the only screen about it says "Enable in Settings → Reactions" — no such section exists (`ReactionsToolView.tsx`).

---

## 8. Name: Acabox or Claude?

- Agent side: *"Never identify yourself as Claude; you are Acabox"* (`identityPreamble.ts:6`); *"First person, named Acabox. … Never identify as Claude — the user's product is Acabox."* (`skills/acabox/SKILL.md:41-42`).
- UI side (all user-facing strings): "What should Claude do?" (`SchedulePanel.tsx:277`), "Each run is a real conversation with Claude" (`:325`), "Ask Claude to fix it" (`ActivityPanel.tsx:214`), "Claude is still writing this tool." (`miniAppBuildState.tsx:77`), "Claude request" (`MiniAppViewer.tsx:41-42`), "Two files Claude reads…", "See everything Claude has learned →" (`DirectoryPermissions.tsx:277-285`), "What Claude has learned", "Ask Claude to write it" (`KnowledgePage.tsx:414, 727`), "Ask Claude to improve this" (`KnowledgeDetail.tsx:440`), "No servers yet. Ask Claude to build one for you", "Authored by Claude" (`ServersPage.tsx:319, 375`), "Notes for Claude" (`ApiSettings.tsx:585`), "HTTP APIs Claude may call directly" (`:257`). Chat previews and search hits: **"CS:"** (`chatPreviewStore.ts:64-69`, `thread-list.tsx:303`).
- Net effect: every button tells the user to ask Claude; the thing that answers insists it is Acabox and is instructed to deny being Claude when asked. For a non-technical user this is confusing; the denial is also an honesty problem.

---

## 9. Jargon that leaks into what the user reads

- **Agent vocabulary** (taught, then repeated to users): `dir_name`, "esbuild error", "PreToolUse hook blocks it", "the install wrapper", "`$ACABOX_API_BASE` is empty", "405 read-only", "403 host not allowed", "`mcp__hex__authenticate`", "frontmatter", "roster characters", "`.applications/<dir>/input/`".
- **Chat step rows** (expanded): mono names `bash`, `glob`, `grep`, `read`, `todo`, `tool search`, `extension <server> <tool words>`; raw `toolName` fallback for anything unmapped (`tool-card-display.ts:91-99`, `tool-labels.ts:171`). The folded summaries ("Ran 3 commands, wrote 2 files", "Worked for 4m 12s · 26 steps") are good.
- **Prompts the UI writes into the composer on the user's behalf** (visible before send): *"The mini-app "X" (`.applications/xyz`) fails to build. Please read its source, fix the problem, and rebuild it. Build output: ```…```"* (`ActivityPanel.tsx:159-168`); *"Please improve the skill `pdf`. Its files are at `.claude/skills/pdf/`… Keep the frontmatter `name` and `description` conformant, and remember the description costs roster characters on every turn."* (`KnowledgeDetail.tsx:248-253`).
- **Settings/Knowledge copy:** "System prompt", ".academia/SOUL.md", "about_you.md", "MEMORY.md", "not indexed in MEMORY.md", "Frontmatter did not parse", "Lowercase letters, digits and single hyphens. This is the name Claude types to load…" (`KnowledgePage.tsx:685`).

---

## 10. What it lacks against Claude.ai, Claude Code and ChatGPT agents

| Capability | Claude.ai / Claude Code / ChatGPT agents | Acabox |
|---|---|---|
| Permission prompts for risky actions | Claude Code asks (or auto-mode classifier); ChatGPT agent confirms consequential actions | None |
| Undo / checkpoints | Claude Code `/rewind`, IDE diffs | None; no trash for agent deletions |
| Structured clarifying questions | AskUserQuestion cards | No renderer; likely denied |
| Browser / computer use | ChatGPT agent, Claude computer use | None (deliberate, documented) |
| Image generation | Yes | No |
| Scheduled runs while the app is closed | Claude.ai scheduled tasks / cloud routines run server-side | Only while Acabox is running |
| Cost / usage visibility | Claude Code `/cost`; API dashboards | Nothing; `total_cost_usd` never read |
| Projects / knowledge containers | Claude Projects, ChatGPT Projects | Memory dir + skills + findings; no document container, no retrieval index beyond manuscript/grant/presentation/reference tags that were never generated |
| Lightweight artifacts | Inline artifacts/canvas | Mini-apps (heavier, build step) or markdown |
| Sub-agent visibility | Claude Code shows sub-agent progress | One "agent" row |
| Sharing a conversation | Yes | No (links are internal) |
| Voice | Voice in/out | Dictation in only |
| Multi-model | Yes | Claude-only by owner rule |

---

## 11. Walkthrough — what a non-technical scientist experiences

1. **Install, open, add a folder.** Blank Command Desk. Settings → "Add folder". Nothing happens next: no scan, no profile, no "here is what I found". The Home empty state offers three static chips.
2. **"What can you do?"** The agent reads the acabox skill and answers that it can run Python and R, run DESeq2, keep a daily activity summary and react to it. Two of those are false; one is unreachable.
3. **"Run DESeq2 on my counts."** The differential-expression skill tells the agent to refuse: "Acabox cannot run DESeq2 today", offering `pydeseq2` instead — a contradiction of what it just said.
4. **"Clean up the old results folder."** The agent runs `rm -rf` through Bash; nothing asks, nothing is in a trash, the fold reads "Ran 2 commands". If the folder was marked "Read only" the lock icon promised nothing.
5. **"Are you Claude?"** The button said "Ask Claude"; the reply says "I'm Acabox". The chat list labels the reply "CS:".
6. **"Do this every night."** Activity → New scheduled task → "What should Claude do?" The run is Opus 5 at high effort with every tool; "Recent runs" shows completed/failed and a time, never a cost; nothing runs if the laptop was shut.
7. **A build fails.** Activity shows "Ask Claude to fix it"; clicking drops a message containing `.applications/coScientistSpendExplorer` and an esbuild stack trace into the composer.
8. **Settings.** "System prompt — Custom instructions appended to the AI system prompt for this workspace. Saved to .academia/SOUL.md." "About you" has two textareas the user fills in; a later Rescan would overwrite them.
9. **Knowledge.** 28 memories, chips like "not indexed in MEMORY.md", and a "Needs attention" row: "This chat queried hex without consulting the ledger — Ask Claude to extract it".

---

## 12. Ideas (model calls per use · effort)

1. **Audience preamble** — one paragraph in `IDENTITY_PREAMBLE`: the user is a scientist, not a programmer; plain language; no paths/tool names unless asked; confirm before deleting, moving or overwriting their files; say what changed in which file. · 0 calls · S.
2. **Destructive-command hook** — `PreToolUse` on Bash denying `rm -r*`, `rm -f`, `mv`/`>` onto paths under shared folders, `git clean/reset --hard`, with the message "Ask the user first and explain what will be removed". · 0 · S.
3. **Pre-edit snapshot + "Undo"** — hook on Write/Edit/NotebookEdit (and Bash redirects) copies the target into `<userData>/agent-trash/<stamp>/` before the change; chat shows "Changed 3 files · Undo" using the fold that already exists. · 0 · M.
4. **Enforce read-only** — main exports the read-only list to the hook env; deny Write/Edit/NotebookEdit and Bash writes under those roots; fix the guidance text ("direct edits will fail" becomes true). · 0 · S.
5. **Approval surface** — implement `canUseTool` for a small deny-by-default set (deletes outside tool-data, `manual` install scripts, writes into read-only roots, ExitPlanMode) rendered as a card with Allow / Deny. · 0 · M-L.
6. **Fix the acabox skill and simplify** — remove R/R-kernel/DESeq2 claims; delete `differential-expression` skill + `differentialExpression` template, `reaction` + `activity-summary` skills, the Reactions task, `ReactionsToolView`, `main/mcpServers/*`, Podman banner strings, dead host-app tool labels (Simplify rule). · 0 · S-M.
7. **Scheduled tasks cost honesty** — default new tasks to Sonnet 5, add a model picker, `maxTurns`/`maxBudgetUsd` per task, store `result.total_cost_usd` per run and show "$0.42 · 3m" in Recent runs; reword "whether or not Acabox is on screen" to "while Acabox is running". · 0 extra · S-M.
8. **Show cost everywhere it is free** — `total_cost_usd` is already in every `result` message; show per-turn cost in the fold line and a per-chat total in the header. · 0 · S.
9. **Make the profile scan real** — run it once after the first folder is added and offer "Rescan" after folder changes; subscribe to the existing progress events; write the result to the report only and let Settings merge, never overwrite `about_you.md`; drop the manuscript briefing enrichment (no surface). · ≈1 Sonnet + 1 Haiku + N Haiku per scan, justified once · M.
10. **One name** — either the UI says Acabox everywhere or the agent may say it is Claude running inside Acabox; drop the "Never identify yourself as Claude" line; replace "CS:" with the chosen name. · 0 · S.
11. **Plain-language step rows and Settings copy** — "Ran a command" / "Searched your files" instead of `bash`/`glob`; "Instructions for Acabox" instead of "System prompt"; hide MEMORY.md/frontmatter chips behind an Advanced toggle; rewrite the UI-composed prompts without paths and code fences. · 0 · S.
12. **Memory transparency** — toast "Acabox remembered: <title>" when a memory file is written (the host sees the Write); "Forget this" button; mute or hide the omission-watch channel for non-technical users. · 0 · S-M.
13. **Structured questions** — wire `canUseTool`/`onUserDialog` so `AskUserQuestion` renders as option buttons; the model stops guessing when a scientist is vague. · 0 extra · M.

---

## 13. Open questions (not verifiable read-only)

- With no `canUseTool`, what actually happens to `AskUserQuestion`, `NotebookEdit`, `Skill` and `ExitPlanMode` approvals? The SDK doc says "ask" decisions are terminal denials; the root CLAUDE.md measured Bash running with an empty allowlist. One live turn per tool settles it.
- Does `claude-sonnet-4-6` still serve through the bundled CLI? The scan has never run in production, so the hardcoded id has never been exercised.
- Would the owner accept a model default below Opus 5 for scheduled runs (cost rule) — and is the Reactions task meant to exist at all?
- Is the SOUL.md "System prompt" field meant for end users, or only for the owner?
