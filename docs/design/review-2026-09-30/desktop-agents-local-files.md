# Desktop and OS-level AI agents that work on local files — what Acabox can learn

Research group: desktop/OS agents on local files, background work, and BYO-key onboarding.
As of: 2026-09-30. Researcher: Claude (Fable 5.1), one of several agents in the Acabox product review.
Method: 40 web searches (budget exhausted at 200/200 shared) + ~70 page fetches of official docs,
changelogs, help centers and reviews. Every claim carries a source URL and an as-of date.
Legend: **[primary]** = vendor doc/changelog/newsroom; **[secondary]** = press/review; **unverified** = could
not reach a primary source. Acabox status is judged ONLY from the repo's CLAUDE.md (I did not read code).

Acabox baseline used for the gap calls (from CLAUDE.md, 2026-09-28): `allowedTools` is auto-approve, there is
no `canUseTool` handler anywhere, the agent has unrestricted Bash on the workspace, read-only directories are
advisory, no undo/checkpoint for user files (only skills-trash and tool-data retention), a local scheduler on the
Activity page that creates one chat per run, a jobs registry (commands survive quit; kernel/Claude work is
"interrupted"), unread/working dots on chats, an agent-invoked desktop-toast tool, API key in Keychain and
never shown in the UI, no usage/cost display, no first-run banner, no plan-approval UI.

---

## 0. Executive summary — the eight patterns that matter for non-technical scientists

1. **Every serious local-file agent now has an "ask / auto / skip" dial, and a hard gate on deletes.** Claude Cowork
   (Manual/Auto/Skip + delete confirmation), ChatGPT desktop (Ask for approval / Approve for me / Full access),
   Manus My Computer (Allow Once / Always Allow per command), Warp (Always Ask / Agent Decides / Always Allow /
   Never per action type, denylist wins), Microsoft Copilot Actions (Allow Always / Ask every time / Never per
   known folder), Perplexity Personal Computer (explicit approval before deleting files or sending mail), Lindy
   ("write actions always wait for your approval"). Acabox has none of this; its agent runs at the equivalent of
   "Skip". The 11 GB Cowork deletion story is the field's canonical failure and Anthropic's response was a
   confirmation prompt, not a smarter model.
2. **Undo is table stakes for coding agents and is arriving in file agents.** Claude Code checkpoints (/rewind, Esc Esc),
   the **Agent SDK's `enableFileCheckpointing` + `rewindFiles()`** (the exact SDK Acabox runs), GitHub Copilot CLI
   `/rewind` (git-independent), VS Code Keep/Undo + checkpoints, Cline Compare/Restore after every tool use. All
   restore only edits made through file tools, never Bash — Acabox's agent leans on Bash, so a trash-on-delete
   hook has to accompany it.
3. **Cost is shown per response, not per month.** Warp's credit chip (hover: tool calls, context, files changed),
   Raycast's per-response credit cost and `/usage`, Cline's per-task dollar figure, Genspark's "using free quota"
   badge. Manus is the cautionary tale: no pre-run estimate, mid-task exhaustion, Trustpilot ≈1/5. Acabox shows nothing.
4. **Scheduled/background work is delivered as a thread per run plus a notification**, and everyone had to solve
   "the laptop was asleep": Cowork moved to cloud default (Oct 6, 2026), Raycast folds missed runs into one and
   offers Prevent Sleep, Notion skips runs when credits run out rather than running them late.
5. **BYO-key products verify the key on save and say what the key implies for privacy.** Raycast has a Verify
   button and states which requests transit its servers; Cursor warns that Zero Data Retention does not apply to
   BYOK. **Subscription sign-in (Raycast's BYOS) is not available to Acabox**: Anthropic's Feb 19, 2026 policy
   forbids third-party apps from using Claude.ai/Pro/Max OAuth credentials.
6. **Spend caps belong at the provider, and the app's job is to explain the refusal.** Anthropic's Console has
   a user-settable monthly spend limit (Settings > Billing) and distinct error codes when it trips. Notion and Lindy
   pause and tell you; Acabox would surface a raw error.
7. **Scoped, per-folder trust is the privacy story.** Cowork 3P `allowedWorkspaceFolders` with `mode: ro` enforced
   on resolved paths; Copilot's six known folders and a separate agent account; Perplexity's "start with one messy
   folder" onboarding; Portable Computer's user-gated cloud escalation. Acabox's read-only flag is advisory.
8. **Memory UIs are being simplified or dropped.** Dia retired Memory on Sept 24, 2026 ("newer models no longer
   require it"); Claude moved memory to categorized entries with a Settings page; Raycast gives Projects
   auto-summarised memory. Signal for Acabox: don't invest in a memory UI; invest in instructions-per-folder.

---

## 1. Claude Cowork (Anthropic) — depth on permissions, file safety, background work, scheduling, notifications

### Feature inventory
| Feature | Interaction (what the user does/sees) | Source | As of |
|---|---|---|---|
| Workspace folders | User attaches one or more folders to a session; agent can read, create, modify anywhere inside; a **trust prompt** appears on first attach (3P config can pre-select and skip it). Access is checked against the **resolved** path so symlinks and `..` cannot escape. | https://claude.com/docs/third-party/claude-desktop/local-access [primary] | fetched 2026-09-30 |
| Read-only folders | 3P managed config `mode: "ro"`: agent can view/search but not modify in Cowork; in Code sessions ro applies to file tools only, not shell. Admin can set `blockReadsOutsideWorkingDirectories`. | same | 2026-09-30 |
| Permission modes | **Manual** (pause and ask for each action), **Auto** (read-only tools auto-approved; write/delete tools reviewed by Claude's safety system which blocks unsafe actions), **Skip** (no automatic pausing; basic safety checks only). Toggled any time from the chat. | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork [primary] | 2026-09-30 |
| Delete confirmation | "The system requires explicit permission before permanently deleting files via a confirmation prompt." Added after the r/ClaudeAI "deleted 11 GB" incident; a secondary source says Anthropic shipped bulk-delete confirmations within two weeks. | support article above [primary]; https://www.coworkhow.com/guides/user-feedback-summary [secondary, 2026-08-12] | 2026-09-30 |
| Folder instructions | Per-folder instructions give project-specific context to every session touching that folder. | support article above [primary] | 2026-09-30 |
| Sandbox | Tasks run in isolated environments; on desktop, a sandbox VM runs code against attached folders (Windows uses built-in virtualization; network drives mount only if present at sandbox start). | local-access doc [primary] | 2026-09-30 |
| Scheduled tasks | `/schedule` creates recurring or on-demand tasks; managed from a "Scheduled" sidebar; each run is its own thread so runs can be compared; Cowork outputs save to the file system in designated folders. Launched Feb 25, 2026. Since the cloud move they run with no device online. | release notes https://support.claude.com/en/articles/12138966-release-notes [primary]; https://www.xda-developers.com/claude-scheduled-tasks-feature/ [secondary, 2026-03-29] | 2026-09-30 |
| Background / cloud | Jul 7, 2026: remote sessions (beta) save to the account; "close your laptop and Claude keeps going". **Oct 6, 2026: cloud becomes default for Pro/Max and the "Only on your computer" option is removed**; local file and browser access still require the desktop app to be open; tasks started locally stay local; transcripts downloadable. | https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile [primary] | 2026-09-30 |
| Notifications | Desktop: "turn on notifications and Claude will ping you when it needs your permission or when a task is complete." Mobile push when a task finishes or needs input. | support articles above [primary] | 2026-09-30 |
| Computer use / Dispatch | Mar 17, 2026 persistent agent thread (Dispatch) for Pro/Max; Mar 23, 2026 computer-use research preview via Dispatch (file ops, tool execution, navigation). Browser built into Desktop rolling out. | release notes [primary] | 2026-09-30 |
| Memory | Aug 25, 2026 memory spans chat and Cowork in the cloud; managed under Settings > Memory with a sensitive-topics toggle; Jul 10, 2026 memory moved from daily summaries to categorized entries. | release notes [primary] | 2026-09-30 |
| Unification | Sept 16, 2026 "Cowork comes to every conversation" — one surface across chat, Cowork, projects, connectors, skills. | release notes [primary] | 2026-09-30 |
| Usage limits | Chat, Code and Cowork draw from one pool (rolling 5-hour window plus weekly cap); `/usage` shows plan pressure; Team plans have per-person visibility. Cowork burns it faster because it spins up a VM and does real work. | https://genaiunplugged.substack.com/p/claude-session-hygiene-usage-limits-code-chat-cowork [secondary, 2026-06-28]; https://www.vellum.ai/blog/official-claude-cowork-breakdown [secondary, 2026-09-07] | 2026-09-30 |
| Plans | Pro, Max, Team, Enterprise (admin-enabled). GA on macOS/Windows Apr 9, 2026. | release notes [primary] | 2026-09-30 |

### What non-technical users praise / complain about
- Praise: multi-file reasoning across many files; asks disambiguating questions instead of guessing; first agent reviewers would hand to a non-technical team without hesitation. [secondary: coworkhow 2026-08-12; aitoolanalysis.com]
- Complaints: the 11 GB "clean up my folder" deletion; the UI shows internal files, scripts and processes that confuse non-technical users; usage limits exhausted fast (one developer "$12 to fix a typo"); Electron UI sluggish; connectors (Drive/Calendar) fail silently; has to unlearn chatbot habits and delegate outcomes. [secondary: coworkhow; usecarly.com; superframeworks.com]

### What Acabox could take (model calls per use in brackets)
- Permission modes Manual/Auto/Skip as a host-side `canUseTool` handler with a confirmation card in the chat and a mode switch in the composer. **[0]** Status: absent.
- Delete confirmation: intercept `rm`/`unlink`/`shutil.rmtree`/`mv` out of a shared dir and Write over non-empty files in shared dirs; show "Claude wants to delete 14 files in MyResearch/raw — Allow / Move to Trash instead / Cancel". **[0]** Status: absent.
- Enforce read-only folders with a PreToolUse hook on Write/Edit and on Bash commands whose arguments resolve into an ro root (Acabox already dedups by realpath). **[0]** Status: partial (advisory only).
- Folder instructions: a `.acabox/INSTRUCTIONS.md` per shared folder, editable from Settings, injected into the system prompt. **[0]** Status: absent.
- "Scheduled" filter in the Chats list and a link from each run to the folder it wrote. **[0]** Status: partial (one chat per run exists).
- OS notification when Claude needs permission (once modes exist) or when a turn longer than ~30 s finishes while Acabox is not focused — the design CLAUDE.md already deferred. **[0]** Status: partial.
- Cowork's cloud move is the opposite of Acabox's premise (local data). Keep local, but copy the honest framing: say plainly in Settings what leaves the machine (prompt text, file contents the agent reads, attachments) and that it goes to Anthropic under the user's own API terms. **[0]** Status: unknown.

---

## 2. ChatGPT desktop (Work, Codex, Computer Use), Operator/agent timeline, Pulse and scheduled tasks

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Unified desktop app | March 2026: Atlas, the ChatGPT desktop app and Codex combined into one app with Chat and Work under ChatGPT alongside Codex (macOS/Windows). | help.openai.com "Moving to the new ChatGPT desktop app" (returned 403 on fetch; from search snippet) **unverified** | 2026-09-30 |
| Local folder for Work | In the desktop app, Work can use a local folder or project after the user grants access; "within the permissions you provide it can read files, understand how they relate, create new documents, and modify files in that working folder." Web/mobile Work run in the cloud and do not read local folders. | https://learn.chatgpt.com/docs/permission-modes [primary]; https://www.bigprompthub.com/chatgpt-work-local-folder-guide/ [secondary, 2026-07-15] | 2026-09-30 |
| Permission modes | **Ask for approval** (default; sandbox `workspace-write`; reads/edits inside the workspace and routine commands auto-approved; asks before internet or leaving the workspace), **Approve for me** (an automatic reviewer handles boundary requests; "auto-review can make mistakes"; sandbox unchanged), **Full access** (no sandbox; warned as "significantly increases the risk of data loss, leaks, or unexpected behavior"). Extra modes are enabled under Settings > General > Permissions; CLI `/permissions`. No undo/checkpoint described. | https://learn.chatgpt.com/docs/permission-modes [primary] | 2026-09-30 |
| Computer Use | ChatGPT asks permission before using an app; "Always allow" per app; an **Always-allowed apps** list lives in Settings > Computer Use; sees screenshots and interacts with windows/menus/keyboard/clipboard; cannot automate terminal apps or ChatGPT itself; user can stop or take over any time; "keep sensitive apps closed unless required"; file edits and shell commands follow the permission mode. macOS/Windows with ChatGPT Work and Codex. | https://learn.chatgpt.com/docs/computer-use [primary] | 2026-09-30 |
| Operator → agent → removal | Operator launched Jan 23, 2025, shut down Aug 31, 2025 into ChatGPT agent; ChatGPT agent "removed from ChatGPT in early August 2026 without an advance deprecation notice", help center pointing to ChatGPT Work and a cloud-browser feature. | https://en.wikipedia.org/wiki/OpenAI_Operator [secondary; page flagged as possibly AI-generated text] **partly unverified** | 2026-09-21 |
| Pulse | Launched Sept 25, 2025 for Pro: 5–10 cards generated overnight from recent chats + connected Gmail/Calendar, each with summary and source links; deliberately capped and "done for today". A help-center note says Pulse is being retired with proactive updates moving into **scheduled tasks** ("ask ChatGPT to schedule a daily briefing"). | https://tecknexus.com/chatgpt-pulse-openai-proactive-ai-morning-briefs/ [secondary]; sunset note from help.openai.com snippet (403 on fetch) **unverified** | 2026-09-30 |
| Scheduled tasks | Exist in ChatGPT; an XDA review calls them "a glorified reminder app" versus Claude's file-writing scheduled runs. | https://www.xda-developers.com/claude-scheduled-tasks-feature/ [secondary, 2026-03-29]; help page 403 | 2026-09-30 |

Acabox take: the "Always-allowed apps/tools" list is the right shape for a non-technical user — a visible, editable allowlist in Settings rather than a one-time dialog. **[0]** Status: absent. The "Approve for me" auto-reviewer is a model call per boundary request **[+1 small model call per gated action]** — Acabox can start with a rule-based gate (0 calls) and only consider an LLM reviewer for ambiguous Bash.

---

## 3. Manus (incl. My Computer desktop app)

| Feature | Interaction | Source | As of |
|---|---|---|---|
| 2026 changelog | Telegram Agents Feb 16; **My Computer desktop app Mar 16**; Cloud Computer (always-on Ubuntu add-on) Apr 30; Preferred Browser May 12; **Branch** (parallel sessions from any point) Jul 9; Auto-Publish Jul 13; native .pptx Jul 14; **Plan Mode** (review/edit the plan before it runs) Jul 22; Supabase/ElevenLabs connectors Jul 24–Aug 3. | https://www.taskade.com/blog/manus-ai-review [secondary, updated 2026-09-22] | 2026-09-30 |
| My Computer permissions | User authorizes specific local folders; **every terminal command Manus proposes requires approval: Allow Once or Always Allow**; access scoped to authorized folders; runs on Apple Silicon Macs and Windows 10/11; agent planning still consumes cloud credits even when local hardware executes. Reviewers advise "read commands before execution and avoid broad Always Allow for unfamiliar work" and to start with a new folder containing copies of non-sensitive files. | https://www.testingcatalog.com/manus-launches-my-computer-with-local-ai-agent-on-desktop/ [secondary, 2026-03-16]; https://www.therundown.ai/tools/my-computer [secondary, 2026-08-29] | 2026-09-30 |
| Scheduled tasks | Free: 2 scheduled tasks; Pro: 20. | https://www.lindy.ai/blog/manus-ai-pricing [secondary] | 2026-09-30 |
| Credits | Free 300/day; Pro $20 = 4,000/mo (+300/day), $40 = 8,000, $200 = 40,000; Team $20/seat. Credits shown **per task after the fact**; no per-action breakdown; **no pre-run estimate**; identical tasks cost different amounts depending on steps/retries. | https://www.eesel.ai/blog/manus-ai-pricing [secondary]; taskade [secondary] | 2026-09-30 |

Non-technical praise/complaints: praised for multi-site research and browser automation; complaints are overwhelmingly about credits (hit the limit mid-task with nothing recoverable; Trustpilot ≈1/5 dominated by billing/refunds), tasks beyond ~5 dependent steps fail often, inconsistent output formatting (malformed CSVs), the agent losing its place and looping. [secondary: usecarly.com, future-stack-reviews.com, taskade]

Acabox take: (a) per-command confirmation with "Allow Once / Always allow commands like this" — **[0]**, absent. (b) Plan Mode as an opt-in per message using the SDK's plan permission mode — **[+1 model turn per task when used]**, status unknown/partial (CLAUDE.md mentions plan prompts rendered as results). (c) Show a *historical* typical cost for the kind of task before running (computed from Acabox's own result rows) and warn when a run passes the user's own budget — **[0]**, absent. (d) "Branch this chat from here" via SDK session forking — **[0 until the branch is used]**, absent.

---

## 4. Genspark Super Agent

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Super Agent | Type a prompt on the homepage or pick Super Agent from New; it coordinates agents/tools in "a dedicated sandbox environment: real browser, own filesystem"; deliverables appear as **file cards in chat** and stay downloadable in the project; "close your laptop and come back to finished work"; multiple tasks per project. | https://www.genspark.ai/helpcenter/super-agent [primary] | 2026-09-30 |
| Credits & quota | Standard-mode tasks are covered by a **Free Quota**; flagship models and Ultra mode draw credits. Profile menu shows current credits and remaining quota; a usage page gives detail; **each task shows a blue "Using free quota at no credit cost" indicator** when applicable. Plus from 10,000 credits/mo, Pro from 125,000; unlimited chat/image promo for pre-Sept-18-2026 subscribers through Dec 31, 2026. | https://www.genspark.ai/helpcenter/membership-plans [primary] | 2026-09-30 |
| Office plugins | Workspace 4.0 (Apr 2026) added native PowerPoint/Excel/Word plugins. | https://www.lindy.ai/blog/genspark-ai-features [secondary] **unverified against Genspark** | 2026-09-30 |

Acabox take: label every action in the UI with whether it costs a model call ("Rebuild — no Claude call", "Ask Claude to fix it — 1 turn"), the Genspark badge idea. **[0]**, absent.

---

## 5. Perplexity — Computer, Personal Computer (Mac/Windows), Portable Computer, Comet

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Computer (cloud) | Consumer launch late Feb 2026; enterprise Mar 10, 2026 at Ask 2026; started as an internal Slack bot — `@computer` in Slack threads, continue on web/mobile; orchestrates ~20 models (Opus for reasoning, Gemini for research, GPT for long context); each session in an isolated Firecracker VM; org credit pools, "roughly 15 cents" for a text brief. Computer for Pro subscribers and Computer for Slack shipped Mar 13, 2026. | https://venturebeat.com/technology/perplexity-takes-its-computer-ai-agent-into-the-enterprise-taking-aim-at [secondary]; https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026 (403 on fetch) **unverified** | 2026-09-30 |
| SPACE sandbox | Jul 15, 2026: every task in a Firecracker microVM (~5 ms boot); long-running tasks (hours–months) with **pause, resume and branching**; live memory and files captured as often as every minute, retained up to a week; passwords/API keys never stored in the sandbox; user-supplied encryption keys for archives. | https://siliconangle.com/2026/07/15/perplexity-launches-secure-sandbox-make-ai-agents-secure-powerful/ [secondary] | 2026-09-30 |
| Personal Computer (Mac/Windows) | Jul 28, 2026: native app that "reads and writes to approved folders" only; works across Office apps and OneDrive; **explicit approval before any sensitive or hard-to-reverse action — sending email, deleting files, remote actions started from another device**; Max ($200/mo) or Enterprise Max; Opus 4.7 default orchestrator, switchable. Reviewer advice: "start with one messy folder" of copied, low-stakes files; wants "a clean before-and-after result, a small uncertain pile, and an obvious way to undo." | https://www.techtimes.com/articles/321882/20260728/perplexity-brings-ai-desktop-agent-windows-routing-tasks-across-20-models.htm [secondary]; https://kryden.ai/news/perplexity-personal-computer-windows [secondary, 2026-07-28] | 2026-09-30 |
| Portable Computer (on-device) | Aug 25, 2026: whole agent stack runs locally (Qwen 3.8 27B / PPLX 27B) on DGX Spark or Linux RTX 24 GB+; Windows planned Sept 2026; **Apple silicon not planned**; **cloud escalation is user-gated**, runs a PII check first, blocks flagged content and sends text guidance rather than documents; zero token cost after hardware. | https://website.vellum.ai/blog/official-perplexity-computer-breakdown [secondary]; https://siliconangle.com/2026/08/25/perplexity-ai-launches-portable-computer-on-device-ai-agent/ [secondary] | 2026-09-30 |
| Comet | Launched Jul 9, 2025 (Win/Mac), free for all Oct 2025, iOS Mar 18, 2026. Assistant acts on the current page/tabs, Gmail/Calendar read-write; **asks permission before acting in the browser and holds that preference for the task**. **Background Assistants** (Max): a dashboard of autonomous assistants working a to-do list with recurring triggers ("summarize the morning's email and calendar at 8:30"). Prompt-injection class issues (CometJacking, LayerX, Oct 2025) described as "an unsolved class of problem". | https://en.wikipedia.org/wiki/Comet_(browser) [secondary]; https://geotoolbox.ai/blog/perplexity-comet [secondary, updated 2026-09-20] | 2026-09-30 |

Acabox take: (a) the delete/send gate — **[0]**, absent. (b) First-run guidance "add a copy of one folder first" with a one-click "duplicate this folder into a sandbox copy" (APFS clone is instant) — **[0]**, absent. (c) A per-turn "what left your machine" line (which files were read and sent, attachments) computed from tool-call logs — **[0]**, absent; a PII pre-check like Portable Computer's would need a model call and is not recommended. (d) Pause/branch of long tasks: Acabox has Stop; a Branch would reuse SDK forking **[0]**.

---

## 6. Raycast AI (macOS/Windows launcher with agent)

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Projects | A Project groups chats, with **instructions** (audience, terminology, format) and a **working directory** that is "the default location for file and terminal work"; Raycast reads/writes there "without repeated prompts" and respects `AGENTS.md`; the folder is **not uploaded** — only attached files are; per-project **memory** is auto-summarised every few hours (goal, focus, decisions, open questions). | https://manual.raycast.com/ai/projects [primary]; changelog v2.3 Sept 11, 2026 https://www.raycast.com/changelog [primary] | 2026-09-30 |
| Automations | Settings > AI > Automations > Create Manually (name, icon, model, new vs existing chat, prompt with `@` extensions/MCP/Skills, schedule) or **Create with AI** from plain language. Schedules: Once / Hourly (1–24 h, weekdays) / Daily (time + days). **Every run is delivered as a message in AI Chat marked "Automated by <name>"**, into a new chat or a cumulative one. **Background Notifications** when a run completes or needs approval. The Mac must be awake with Raycast open; **Prevent Sleep During AI Runs**; **missed runs execute once at next launch and multiple misses fold into a single run**. Billed like normal messages. | https://manual.raycast.com/ai/automations [primary] | 2026-09-30 |
| Agent mode & permissions | v2.3 rebuilt AI Chat to plan, use extensions, write code and iterate; "enhanced approval system with tool confirmation defaults and auto-review rules"; "auto mode now handles routine local work with fewer unnecessary interruptions". | changelog v2.3 [primary] (manual page for permissions returned 404) | 2026-09-30 |
| Usage & credits | Sept 10, 2026: from rate limits to monthly AI credits — Pro $10/500, Pro+ $20/3,000, Max $50/7,500; credits expire 60 days; top-ups. Usage visible in Settings > Account, an AI Usage view by model/time, **`/usage` in the composer**, and **per-response input/output credit cost on each answer**. When credits run out AI stops until renewal/top-up or the user switches to BYO options. | https://manual.raycast.com/ai/usage-limits [primary]; https://www.raycast.com/blog/changing-how-raycast-ai-is-priced [primary, 2026-09-10] | 2026-09-30 |
| Bring Your Own Key | Settings > AI > Models & Providers > API Keys (Pro-exclusive): pick Anthropic/Google/OpenAI/OpenRouter, paste key, **click Verify** ("Raycast will check the key with the provider"), Save. Costs at provider rates; **Anthropic/Google/OpenAI requests still pass through Raycast servers; OpenRouter goes direct**; image generation still uses Raycast credits. | https://manual.raycast.com/ai/bring-your-own-key [primary] | 2026-09-30 |
| Bring Your Own Subscription | Connect a Claude or ChatGPT **subscription** (not API-only accounts): enable Local AI Subscriptions, install Claude Code or Codex CLI, run `claude` → `/login` or `codex login`; models appear with badges; usage counts against the subscription's 5-hour/weekly limits; prompts go from the provider's CLI on your machine straight to Anthropic/OpenAI, "never through Raycast's servers"; no automatic fallback when the subscription limit is hit. | https://manual.raycast.com/ai/bring-your-own-subscription [primary] | 2026-09-30 |
| Perf | v2.6 (Sept 30, 2026): host process ~50% less memory. | changelog [primary] | 2026-09-30 |

User reaction to the Sept 2026 pricing change: none recorded at publication. [secondary: alternativeto.net 2026-09-10]

Acabox take: Verify on save (one non-billable `GET /v1/models`) — **[0 billable]**, partial. Per-turn cost chip — **[0]** (from the SDK result's cost/usage), absent. `powerSaveBlocker` during scheduled runs and fold missed runs — **[0]**, partial. Folder instructions — **[0]**, absent. BYOS: **not permissible for Acabox** (see §16) — explain in Settings why only API keys are accepted — **[0]**.

---

## 7. Warp (agentic development environment) + Oz cloud agents

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Open source / Oz | Apr 28, 2026: Warp open-sourced (MIT/AGPL) and paired with Oz, its cloud agent orchestrator. | https://www.warp.dev/newsroom/2026/4/28/warp-open-sources-its-agentic-development-environment [primary] | 2026-09-30 |
| Agent profiles & permissions | Settings > Agents > Profiles: each profile sets base model, autonomy and tool access; autonomy per action type (code diffs, file reading, plan creation, command execution, clarifying questions) is **Agent Decides / Always Ask / Always Allow / Never**; command **allowlist** regexes (ls, grep, find) auto-run; **denylist** (wget, curl, rm, eval) always asks and **takes precedence over Always Allow**; "Run until Completion" (⌘⇧I) grants temporary full autonomy. | https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/ [primary] | 2026-09-30 |
| Plans | Prompts become "structured, editable plans with version history and selective execution"; review gates before anything runs. | https://www.xda-developers.com/warp-isnt-terminal-tried-new-agentic-coding-mode/ [secondary, 2026-04-10] | 2026-09-30 |
| Code review | Code Review panel (git diff chip, "Review changes" in the conversation, tab-bar button) updates live as agents edit; inline comments batched back to the running agent; **revert a hunk from the gutter**, **discard all**. Jul 23, 2026 TUI surfaces file-edit permission requests and **editable** shell confirmations; Aug 27 MCP confirmations show which tool and which server. | https://docs.warp.dev/code/code-review/ [primary]; https://docs.warp.dev/changelog/2026/ [primary] | 2026-09-30 |
| Usage & cost | A **credit count chip** at the bottom of each agent response; hover shows "credits, tool calls, context window, files changed, diffs applied"; Settings > Billing and usage; Aug 27, 2026 **per-category dollar cost breakdown alongside credits**; Aug 19 inline `/usage` in the Agent CLI; premium models pause at the monthly limit; add-ons/auto-reload. | https://docs.warp.dev/_llms-txt/support.txt [primary]; changelog 2026 [primary] | 2026-09-30 |
| BYOK | Settings → search "API keys"; Anthropic/OpenAI/Google; invalid keys halt requests with clear errors; rate-limited keys don't silently fall back to credits unless enabled; keys stored locally; Auto models, Codebase Context and Cloud Agents still use credits; Jul 3, 2026 Warp suggests a provider-appropriate default model after saving a key. | https://docs.warp.dev/agents/inference/bring-your-own-api-key/ [primary]; changelog [primary] | 2026-09-30 |
| Oz triggers & delivery | Triggers: cron schedules, Slack mentions, Linear updates, GitHub Actions, REST/SDK/webhooks, manual `oz agent run-cloud`. Every run leaves a transcript (prompt, plan, commands, logs, outputs); results reply to the Slack thread/Linear issue that started them; Runs page shows status/trigger/creator/credit usage; `/handoff` promotes a local conversation to the cloud with uncommitted changes; `/continue-locally` forks back; Jun 17, 2026 automatic handoff confirmations when the computer sleeps. | https://docs.warp.dev/_llms-txt/automation-platform.txt [primary]; changelog [primary] | 2026-09-30 |
| Non-dev notes | Speech language setting for voice input; Markdown in agent output (Jul 23, 2026). Reviewers note the diff-first workflow presumes code-review literacy. | changelog [primary]; XDA [secondary] | 2026-09-30 |

Acabox take: two named profiles ("Careful" = always ask on writes/deletes/network; "Trusting" = ask only on denylisted commands) with a denylist that outranks everything — **[0]**, absent. The response-footer cost chip with files changed — **[0]**, partial (Acabox's "Worked for 4m 12s · 26 steps" fold is the natural home). Editable command confirmations (fix a path before allowing) — **[0]**, absent.

---

## 8. Dia (The Browser Company / Atlassian)

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Skills | Natural Language Skill Builder (v1.2.0, Oct 23, 2025): describe a workflow ("summarize this page and pull out action items") and save it as a reusable skill; skills chain across tabs and use connected services. | https://supasidebar.com/blog/dia-browser-mac-review-2026 [secondary] **unverified against Dia docs** | 2026-09-30 |
| Memory retired | **v1.50.0, Sept 24, 2026: "Memory feature being retired; newer models no longer require it."** | https://www.diabrowser.com/changelog [primary] | 2026-09-30 |
| Morning Brief & tools | Enterprise Morning Brief pulls overnight Slack, calendar and assigned action items; Mar 2026 Slack/Notion/GCal/Gmail/Amplitude; Sept 10, 2026 Outlook/SharePoint/Teams; Aug 20 Zoom; Sept 24 Figma; Sept 3 "request a tool" from the top 400 SaaS apps; Apr 23 deferred tool loading to shrink context. | changelog [primary] | 2026-09-30 |
| Transparency | Jul 9 thinking visible with expand/collapse; Jul 30 thinking UI redesigned to show real-time reasoning; Sept 24 search across previous chats, browsing history and artifacts. | changelog [primary] | 2026-09-30 |
| Privacy/perf | Jun 8 out-of-process page reading; Jul 9 Privacy pane redesign; Apr 9 cross-device Sync of Tabs/Privacy/Profiles/Memory. Pricing: free + $20/mo Pro; Apple Silicon only. | changelog [primary]; supasidebar [secondary] | 2026-09-30 |

Acabox take: "Save this as a skill" from a finished chat (the skill store is user-owned already) — **[1 model turn per skill created]**, partial. Dia dropping Memory supports not building a memory UI in Acabox — **[0]**. Deferred tool loading mirrors Acabox's own context-budget work.

---

## 9. Microsoft Copilot on Windows — Copilot Actions, agent workspace, Vision, Recall

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Copilot Actions | Composer dropdown → "Take Action"; attach files/folders; the task runs in an **agent workspace**, "a separate desktop instance just for Copilot"; the user can check progress, review actions taken, and **take over at any time**. Rolling out to Windows Insiders from Nov 17, 2025 (Copilot Labs); still **preview**; agent workspace private preview. | https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/ [primary]; https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features [primary] | 2026-09-30 |
| Security model | Off by default (Settings > System > AI components > Agent tools > Experimental agentic features, admin-only); each agent runs under its **own standard account**; starts with access only to six known folders (Documents, Downloads, Desktop, Pictures, Music, Videos) and must ask for more; preview builds ≥26100.7344 offer **Allow Always / Ask every time / Never allow** per agent per folder; "all actions of an agent are observable and distinguishable" with a **tamper-evident audit log**; extra approval requested for sensitive steps. | https://learn.microsoft.com/en-us/windows/security/book/operating-system-agentic-security [primary, 2025-11-13]; support page above [primary] | 2026-09-30 |
| File Explorer AI actions | Right-click actions: summarize, ask about content, generate FAQs, compare up to five documents into a table (OneDrive web and File Explorer). | https://techcommunity.microsoft.com/blog/windows-itpro-blog/evolving-windows-new-copilot-and-ai-experiences-at-ignite-2025/4469466 [primary, body not retrievable; from search snippet] **partly unverified** | 2026-09-30 |
| Copilot Vision | Highlights where to click and what to do next; works with "Hey Copilot"; **does not take actions** — it explains. | https://support.microsoft.com/en-us/microsoft-365-copilot/how-vision-microsoft-365-works [primary, from snippet] | 2026-09-30 |
| Recall | Captures screen snapshots every few seconds; **off by default**; timeline gated by Windows Hello; snapshots encrypted on-device (BitLocker/TPM); Purview DLP integration for orgs. | https://www.windowslatest.com/2026/02/20/... [secondary, 2026-02-20] | 2026-09-30 |
| 2026 status | A "Copilot Cowork" for M365 with admin-controlled action was reported; the page was not retrievable. | windowsforum.com [secondary] **unverified** | 2026-09-30 |

Acabox take: the per-folder trust level (Allow Always / Ask / Never) is the simplest UI for non-technical users and maps onto Acabox's shared-folder list — **[0]**, partial (ro flag exists, unenforced). An exportable audit log of agent actions per folder (Acabox already has an API-proxy audit line and a command log) — **[0]**, partial.

---

## 10. Apple Intelligence — Siri AI, App Intents, Foundation Models framework

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Siri AI (WWDC Jun 2026) | Conversational Siri with personal context across Messages, Photos, Notes, Files, Mail; on-screen awareness; multi-step actions across apps via App Intents; queries "the Spotlight index and App Toolbox, which work entirely on device"; complex requests go to Private Cloud Compute (independently verifiable); developer betas now, user beta later in 2026 (English first); M1+ Macs. | https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/ [primary] | 2026-09-30 |
| App Intents | Apps expose actions/content so Siri can act in them and include them in personal context (Spotlight integration). WWDC 2026 session 343. | https://wwdc.ai/2026/343 [secondary] | 2026-09-30 |
| Foundation Models framework | Third-party apps get "direct access to the on-device foundation language model" (~3B params), **"AI inference that is free of cost"**, guided generation (`@Generable`), tool calling via a Swift `Tool` protocol, adapter training toolkit. | https://machinelearning.apple.com/research/apple-foundation-models-2025-updates [primary] | 2026-09-30 |

Acabox take: (a) exposing "open tool X / run tool X / ask a chat" as App Intents so the user can say it to Siri on macOS 27 — **[0]**, absent, speculative value. (b) Using the free on-device model for chat titles, previews or snippet cleanup would remove a Haiku call per new chat — **[0 Claude calls]** but it is a non-Claude model, which **conflicts with the Claude-only rule**; flagged for the owner, not recommended by default.

---

## 11. Notion Custom Agents

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Launch & plans | Live Feb 24, 2026 for Business/Enterprise; run autonomously on triggers while you are offline. | https://matthiasfrank.de/en/notion-custom-agents-full-tutorial-use-cases-pricing-changes/ [secondary] | 2026-09-30 |
| Triggers | Recurring schedules (daily/weekly/monthly with timezone), Notion events (page created, property updated, comment added), Slack events (message, emoji, @mention), Calendar and Mail events; multiple triggers with filters; `@AgentName` manual trigger. | https://www.notion.com/help/custom-agents [primary] | 2026-09-30 |
| Permissions | Grant only the pages/databases needed; levels Full Access / Can Edit / Can View and Interact; web access toggled separately (URL allowlisting); each connected app authorized per agent; custom MCP servers. | same [primary] | 2026-09-30 |
| Model & effort | Auto, Claude Opus 5 / Sonnet 5 / Fable 5, GPT, Gemini, Grok; an **Effort** setting controls reasoning depth and therefore cost; Fable requires admin enablement. | same [primary]; matthiasfrank [secondary] | 2026-09-30 |
| Activity & failures | **Activity tab lists every run with trigger, actions taken, error messages, and "what the agent thought at each step"**; you can reopen any run and continue the conversation; **version history** restores previous agent configurations. | same [primary] | 2026-09-30 |
| Credits | Notion Credits launched May 4, 2026 at **$10 per 1,000**, workspace-wide, monthly, no rollover; consumption depends on data processed, tools, steps, frequency, model, effort; **when credits run out agents pause and scheduled runs are skipped, not run retroactively**; "Notion credits dashboard". | same [primary]; matthiasfrank [secondary] | 2026-09-30 |

Acabox take: when the API returns `enforced_spend_limit_reached` or the user's own limit (see §16), **pause the scheduler, mark skipped runs in Activity, and never backfill** — **[0]**, absent. Version history for a scheduled task's prompt — **[0]**, absent. Per-task model + effort selection already exists for chats in Acabox (pinned per chat); expose it on scheduled tasks — **[0]**, unknown.

---

## 12. Zapier Agents

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Building | agents.zapier.com → "Create my first agent" or a template; describe the job in natural language and a prompt assistant rewrites it; choose a trigger (on demand, scheduled, from a Zap, from another app); add knowledge (Drive, Box, Notion, Asana) and web browsing via "Insert tools"; **test in the right-hand panel before Save**. | https://zapier.com/blog/zapier-agents-guide/ [primary, updated Nov 2025] | 2026-09-30 |
| Statuses & queue | Six statuses on every activity row: In progress, **Needs action**, Failed, Cancelled, Completed, Test; "Needs action" = the agent needs your input (missing info, broken auth) before continuing; **All activity** page is the complete history. | https://ob-zapier.helpjuice.com/understand-your-agent-s-statuses [primary, from snippet; direct fetch 404] **partly unverified** | 2026-09-30 |
| Pricing | Free up to 400 activities/mo; Pro $33.33/mo (annual) 1,500; Enterprise custom with audit logs; a trigger, knowledge lookup, action, search or browse each counts as an activity; sharing as Viewer/Editor/Owner. | https://www.therundown.ai/tools/zapier-agents [secondary]; https://zapier.com/pricing [primary] | 2026-09-30 |

Acabox take: a "Needs action" state for chats/tasks blocked on a permission prompt or a failed credential, surfaced in the Activity page's "Needs attention" (which already exists for failed builds) — **[0]**, partial. A "Run once now" test button on a scheduled task before saving — **[1 model turn, user-initiated]**, unknown.

---

## 13. Lindy

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Positioning | Relaunched Feb 2026 as a personal AI executive assistant (inbox triage, drafting in your voice, scheduling, meeting notes) built on a no-code trigger/step builder; reached through Slack, iMessage, Chrome extension. | https://www.usecarly.com/blog/lindy-ai-review/ [secondary]; https://docs.lindy.ai/ [primary] | 2026-09-30 |
| Approvals | "**Write actions always wait for your approval, so nothing ships without you**"; "anything with outside impact waits for approval — sending an email, updating a ticket, posting to another channel, publishing a doc." | https://docs.lindy.ai/ [primary]; https://www.lindy.ai/pricing [primary] | 2026-09-30 |
| Credits | Plus $29.99 (3,000), Pro $99.99 (15,000), Max $199.99 (35,000) per user/mo; tiers of work: Everyday Asks 2–250, Deep Work 250–1,000, Big Builds 1,000–2,500 credits; shared pool; "**if the pool runs low, Lindy pauses and tells you**"; no free plan (first week free via Slack). | https://www.lindy.ai/pricing [primary] | 2026-09-30 |
| Memory | Shared memory files the team can open and edit; Skills (named playbooks) and Routines (scheduled/triggered work) belong to the workspace. | https://docs.lindy.ai/ [primary] | 2026-09-30 |

Acabox take: budget warning at a user-set monthly dollar figure (computed locally from result costs) that pauses scheduled tasks and says so — **[0]**, absent. Lindy's human-readable cost classes ("Everyday ask / Deep work / Big build") are a good way to label expected cost without a number — **[0]**.

---

## 14. Relay.app — **shut down September 2026**

- Jan 2026: human-in-the-loop requests could be sent to **any email address, Slack channel or user, including non-Relay users**; "anyone with the link" could respond; a Code sandbox AI tool for data analysis; tools auto-suggested from the prompt; GPT-5.2/Gemini 3 Flash added. https://www.relay.app/blog/new-year-new-features-built-in-forms-and-hitl-updates [primary; 404 on direct fetch, from search snippet] **partly unverified**
- Feb 2026: rebranded around AI agents with HITL as the differentiator vs Zapier/Make. [secondary: toarn.com, agent-finder.co]
- **The relay.app homepage now states the service "shut down in September 2026"** and points to an Internet Archive snapshot. https://www.relay.app/ [primary, fetched 2026-09-30]

Acabox take: the one durable idea is approval-by-link — when a scheduled task needs a decision while the user is away, a notification that deep-links straight to the pending prompt. **[0]**, absent. Also a market signal: HITL-first automation did not sustain a standalone business; approvals belong inside the agent product.

---

## 15. n8n Agents

| Feature | Interaction | Source | As of |
|---|---|---|---|
| Agents builder | A dedicated Agents object: choose a model, write instructions, attach tools/skills/workflows, connect channels (Slack, Telegram, Linear) or a schedule; one agent turn = one execution. Sept 2026 releases: **docked preview chat beside the editor** (2.39), New Chat icon on agent cards, **background tasks panel** showing sub-agents and workflow jobs (2.40), **session traces open full-page with a timeline** (2.36), streaming responses with tool visibility (2.37), required fields marked (2.40). | https://docs.n8n.io/changelog/release-notes [primary]; https://kingy.ai/news/n8n-agents-2026-what-changed-cost-controls/ [secondary, 2026-09-27] | 2026-09-30 |
| Gateway credits | Use supported models in n8n Cloud without creating provider accounts, on a **prepaid Gateway credits balance** (renamed from "n8n credits" 2.38.1, Sept 1, 2026); role-aware top-up flow (2.35). | release notes [primary] | 2026-09-30 |

Acabox take: the side-by-side "edit the instructions, test in the preview" pattern applies to Acabox skills and scheduled-task prompts — **[1 model turn per test, user-initiated]**, absent. The background-tasks panel is Acabox's Activity "Running now", already present.

---

## 16. BYO-API-key onboarding — Cursor, Cline, Open WebUI, Jan, LM Studio, Msty (+ Raycast/Warp above) and the Anthropic constraints

| Product | Key entry UX | Validation | Spend / usage display | Privacy framing | Source | As of |
|---|---|---|---|---|---|---|
| Cursor | Settings > Models; OpenAI/Anthropic/Google/Azure/Bedrock; chat models only (Tab completion stays on Cursor models). | None up front: "if a key is invalid or rejected, requests using that provider fail until you update or remove the key." | Individual plans: provider bills you; Teams: $0.25/M-token "Cursor Token Rate" shown under "Other Models" in the Spending dashboard; June 2026 spend alerts to Slack/email, team-wide monthly limit; per-member caps Enterprise only. | **"Zero Data Retention does not apply when you use your own API keys"**; key not stored on Cursor servers but sent with every request. | https://cursor.com/help/models-and-usage/api-keys [primary]; https://www.finout.io/blog/what-happened-to-cursor-pricing-2026-guide-5-cost-cutting-tips [secondary] | 2026-09-30 |
| Cline | Settings ⚙ → API Provider dropdown → Anthropic → paste key → pick model; "copy the key immediately, you will not see it again"; alternatives: **Sign In with Cline** (OAuth via Google/GitHub/email, pay-as-you-go), ClinePass $9.99/mo for open-weight models; Ollama/LM Studio need no auth. | Not described. | Secondary sources: real-time per-task cost in the task header; typical $0.01–$0.10 per task; 5–15 API calls per task. Credits added in settings or app.cline.bot/dashboard. No spend limits in Cline. | Not addressed on the key page. | https://docs.cline.bot/provider-config/anthropic [primary]; https://docs.cline.bot/getting-started/authorizing-with-cline [primary]; https://www.deployhq.com/guides/cline [secondary] | 2026-09-30 |
| Cline safety | Checkpoints after **each tool use** with **Compare** (diff) and **Restore** (Files / Task only / Files & Task) in a shadow git repo; Auto Approve categories (read project/all files, edit project/all files, safe/all commands, browser, MCP) plus **notifications when approval is needed or a command runs >30 s**; YOLO mode checkbox. | — | — | — | https://docs.cline.bot/features/checkpoints [primary]; https://docs.cline.bot/features/auto-approve [primary] | 2026-09-30 |
| Open WebUI | Avatar > Settings > Admin > Connections → "+" → provider URL + key → Save; models listed automatically (manual Model IDs for providers without a list). | Implicit: an empty model list means "verify the URL and key". | None. | Self-hosted. | https://docs.openwebui.com/getting-started/quick-start/ [primary] | 2026-09-30 |
| Jan | Settings → Model Providers → Anthropic → paste key; models auto-discovered (Opus/Sonnet/Haiku), manual add by model id. | Guidance only: check key not expired, billing configured, "sufficient credits". | None. | Points to Anthropic's terms. | https://jan.ai/docs/desktop/remote-models/anthropic [primary] | 2026-09-30 |
| LM Studio | Local models; its own server issues API keys for clients; not a BYO-cloud-key product. | — | — | Local-first. | https://localaiops.com/posts/lm-studio-api-key-setup-guide-for-local-ai-models-2026/ [secondary] | 2026-09-30 |
| Msty | "Nexus" central gateway: manage runtimes, providers, keys, policies, app tokens and **usage** in a local control center; "zero product telemetry", customer-controlled storage. | Not described. | Usage via Nexus (details not published). | "Private AI for real work". | https://msty.ai/ [primary, marketing] | 2026-09-30 |
| Raycast | Verify button; Pro-only; see §6. | Provider check on save. | Per-response credits, `/usage`. | States which requests transit Raycast. | §6 | 2026-09-30 |
| Warp | Settings search "API keys"; see §7. | Clear errors on invalid/rate-limited key; suggests a default model after save. | Credit chip + dollar breakdown. | Keys local; provider retention differs. | §7 | 2026-09-30 |

**Anthropic-side constraints that bound Acabox's options**
- **Subscription sign-in is off the table.** Enforcement blocked Max OAuth in third-party clients from Jan 9, 2026; the Feb 19, 2026 documentation update says OAuth tokens from Free/Pro/Max accounts may be used only in Claude Code and Claude.ai, and "developers building products… including those using the Agent SDK, should use API key authentication through Claude Console". https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use [secondary]; https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ [secondary]; https://github.com/agentclientprotocol/claude-agent-acp/issues/337 [secondary]. **unverified against the Anthropic policy page itself** (not fetched), but consistent across four sources.
- **Spend limits live in the Console.** Tier caps Start $500 / Build $1,000 / Scale $200,000 per month; the user can set a lower limit at Settings > Billing > Spend limits > Adjust limit. Hitting the tier cap returns HTTP 429 `rate_limit_error` with `error.details.error_code = "enforced_spend_limit_reached"` and **no `retry-after`**, so SDK retries fail until the month resets; hitting a self-set limit returns HTTP 400 `invalid_request_error` beginning "You have reached your specified API usage limits" and states when access resumes. The Console Usage page charts tokens, requests, rate-limit headroom and cache hit rate. https://platform.claude.com/docs/en/api/rate-limits [primary]
- **Keys are shown once at creation** (Cline and Jan both warn about this); Acabox's Settings copy should say so and link to https://console.anthropic.com/settings/keys.

Acabox take: (a) Verify on save with one non-billable request and a plain-English result ("Key works. Your account can use Opus 5.5, Sonnet 5, Haiku 4.5.") — **[0 billable]**, partial. (b) Detect the two spend-limit error shapes and render "Your Anthropic spend limit was reached; raise it at Console > Billing" instead of a raw error, and pause scheduled tasks — **[0]**, absent. (c) A data-handling statement in Settings (Cursor's ZDR note inverted: "Acabox sends only what the agent reads to Anthropic under your Console account's terms; nothing to Acabox") — **[0]**, unknown. (d) First-run banner pointing at Settings when no key is stored (the CLAUDE.md-noted gap) — **[0]**, absent.

---

## 17. Adjacent references on local-file safety (not in the group list, but the strongest available patterns)

| Product | Interaction | Source | As of |
|---|---|---|---|
| Claude Code checkpointing | Every prompt that starts a turn creates a checkpoint; `/rewind` or Esc Esc opens a menu listing prompts; options **Restore code and conversation / Restore conversation / Restore code / Summarize from here / Summarize up to here**; snapshots kept for the 100 most recent checkpoints, saved with the session (works after resume), swept after ~30 days. **Not tracked: changes made by Bash (`rm`, `mv`, `cp`), subagent edits, external edits, symlinked/hard-linked paths** (skipped with a warning). "Not a replacement for version control." | https://code.claude.com/docs/en/checkpointing [primary] | 2026-09-30 |
| **Agent SDK file checkpointing** | `enableFileCheckpointing: true` plus `extraArgs: {"replay-user-messages": null}`; each user message in the stream carries a `uuid` usable as a restore point; `query.rewindFiles(uuid)` restores files on disk (deletes files Claude created, restores modified content) **without touching the conversation**; works after the stream ends by resuming the session with an empty prompt and calling rewind inside the loop; CLI equivalent `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <id> --rewind-files <uuid>`. Tracks **Write/Edit/NotebookEdit only**; Bash changes and directory create/move/delete are not undone; `RewindFilesResult.skippedLinks` counts skipped symlinks (CLI ≥2.1.216). | https://code.claude.com/docs/en/agent-sdk/file-checkpointing [primary] | 2026-09-30 |
| GitHub Copilot CLI | Esc Esc or `/undo`/`/rewind` opens a picker of prompts (ten most recent); choose **Conversation only** or **Conversation + files**; restores files Copilot changed to their state **before** that prompt; skips files the user edited since, files too large to back up; **works outside git repos**. Added Aug 2026 with a Sessions sidebar. | https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/roll-back-changes [primary] | 2026-09-30 |
| VS Code agent sessions | Pending edits marked with a dot in Explorer/tabs; overlay with **Keep / Undo** per file and per inline change; **checkpoints** snapshot before each request and "restore checkpoint" rewinds files + chat (not terminal commands, network, deployments); `chat.checkpoints.showFileChanges` previews files and line counts; sessions list shows file-change statistics; Changes panel diff with comments the agent resolves. | https://code.visualstudio.com/docs/agents/run/review-code-edits [primary] | 2026-09-30 |
| Cline | See §16: checkpoint after each tool use, Compare + Restore (3 options), shadow git. | https://docs.cline.bot/features/checkpoints [primary] | 2026-09-30 |

Acabox take — the single highest-value item in this report: enable SDK file checkpointing in the agent server, record each turn's checkpoint uuid in the sessions table, and put **"Undo this turn's file changes"** on the "Worked for N · M steps" fold (and a "Changed 3 files" count from the `Write`/`Edit` tool calls Acabox already streams). **[0 model calls]**. Because the Acabox agent does much of its work in Bash (`manage_mini_app.mjs`, pip/npm, data scripts), pair it with (1) a PreToolUse hook that rewrites `rm` of paths inside shared dirs into a move to a per-run trash folder (Acabox already has `newTrashDir`/`moveInto` for skills) and (2) a per-tool **"Restore last working version"** for mini-apps: snapshot `.applications/<dir>` (APFS clone) before each agent turn that touches it, keyed to build-health — the vibecoder's real question is "it worked yesterday, put it back", not "show me the diff". **[0]**. Status: absent.

---

## 18. Cross-cutting lenses

**Permission model.** Ask-every-time is universally the default for writes outside a sandbox; the differentiators are (a) a per-action or per-folder dial with three or four levels (Cowork, ChatGPT, Warp, Copilot), (b) a denylist that outranks "always allow" (Warp), (c) "always allow this app/command" lists that are visible and editable in Settings (ChatGPT, Manus), and (d) scoping to a folder checked on resolved paths (Cowork 3P). Nobody asks a model to decide permissions except ChatGPT's "Approve for me" (which documents that it "can make mistakes") and Cowork's Auto mode safety reviewer. Acabox: absent — the agent runs fully trusted, with two shell hooks as guardrails.

**Local file safety.** Confirm-before-delete (Cowork, Perplexity, Manus via per-command, Copilot via extra approval) is now expected. Undo exists in every coding agent (Claude Code, Agent SDK, Copilot CLI, VS Code, Cline, Warp hunk revert) and is consistently limited to tool-made edits — Bash is the hole everyone documents. Nobody ships filesystem snapshots or trash-on-delete for the agent's shell; that is an open opportunity Acabox can take on macOS (APFS clones are free). Acabox: absent for user files.

**Background and scheduled work; delivery.** One thread per run (Cowork, Raycast, Notion activity), results written to disk (Cowork), delivered into a chat marked as automated (Raycast), replies posted back to where the task came from (Warp Oz), a dashboard of running assistants (Comet, n8n, Warp Runs page), notifications when done or when blocked (Cowork, Raycast, Cline). Sleep is the universal failure: Cowork went cloud, Raycast folds missed runs and prevents sleep, Notion skips runs when credits run out. Acabox: present for scheduler + chat per run + jobs registry; missing OS notifications, power assertion, missed-run policy, and skipped-run marking.

**Memory.** Trending toward less UI: Dia retired it; Claude moved to categorized entries with a Settings page; Raycast scopes it to Projects with automatic summaries; Lindy keeps editable memory files. Acabox: partial (MEMORY.md-based; auto recall measured not firing). Recommendation: per-folder instructions beat memory for scientists.

**Privacy framing / what leaves the machine.** Cowork says local files are reachable only while the desktop app is open and that web tools run server-side; Raycast says exactly which provider paths transit its servers; Cursor says ZDR does not apply to BYOK; Portable Computer gates cloud escalation and runs a PII check; Copilot isolates the agent in its own account; Perplexity SPACE never stores credentials in the sandbox. Acabox: strong engineering (Keychain, 0600, hooks) but no user-facing statement — unknown/partial.

**Onboarding / first run.** Raycast: Verify + Pro gating + plain explanation; Jan/Cline: tell you the key is shown once and link to the Console; Perplexity reviewers: "start with one messy folder"; Zapier: templates and a test panel before save; Raycast Automations: "Create with AI" from plain language. Acabox: no first-run nudge, key validation status unknown.

**Cost transparency.** Per-response cost (Warp chip with hover detail, Raycast per-response credits, Cline per-task dollars), `/usage` commands (Raycast, Warp, Claude), free-vs-paid badges (Genspark), dollar breakdown by category (Warp Aug 2026), "pauses and tells you" (Lindy, Notion), skip-not-backfill (Notion). The negative example is Manus (no estimate, mid-task exhaustion, 1-star billing complaints). Acabox: absent, despite the SDK result message carrying cost and usage on every turn.

---

## 19. What Acabox could take — ranked for non-technical scientists, with model calls per use

| # | Idea (Acabox version) | Pattern source | Model calls per use | Acabox status |
|---|---|---|---|---|
| 1 | **Undo this turn's file changes**: enable Agent SDK `enableFileCheckpointing`, store checkpoint uuid per turn, button on the "Worked for" fold; show "changed N files". | Agent SDK, Claude Code, Copilot CLI, Cline, VS Code | 0 | absent |
| 2 | **Trash-on-delete for the agent's shell**: PreToolUse hook rewrites `rm`/destructive `mv` inside shared dirs to a move into a per-run trash with a 7-day sweep; "Restore" from Activity. | Cowork incident; Acabox's own skills-trash | 0 | absent |
| 3 | **Delete / overwrite confirmation card** with Allow / Trash instead / Cancel, via a host `canUseTool` handler. | Cowork, Perplexity PC, Manus, Copilot | 0 | absent |
| 4 | **Permission dial** per chat: Careful (ask on writes, deletes, network, installs) / Normal (ask on deletes and anything outside shared dirs) / Trusting (denylist only); denylist outranks everything; mode shown in the composer. | Cowork Manual/Auto/Skip, ChatGPT, Warp profiles | 0 | absent |
| 5 | **Per-turn cost chip** ("$0.12 · 26 steps · 3 files changed") from the SDK result's cost/usage, plus a monthly total in Settings and `/usage`-style command. | Warp, Raycast, Cline, Claude `/usage` | 0 | absent |
| 6 | **Spend-limit awareness**: detect `enforced_spend_limit_reached` (429, no retry-after) and the self-set 400; show a plain message with a Console deep link; pause scheduled tasks and mark skipped runs (never backfill). | Anthropic Console, Notion, Lindy | 0 | absent |
| 7 | **Verify key on save** with one non-billable request; show the models the account can use; say the key is shown once in Console; data-handling statement; first-run banner. | Raycast Verify, Cursor ZDR note, Jan/Cline | 0 billable | partial |
| 8 | **Enforced read-only folders** (hook on Write/Edit and on Bash arguments resolving into an ro root) and a per-folder trust level Allow / Ask / Never in Settings. | Cowork 3P `mode: ro`, Copilot known folders | 0 | partial |
| 9 | **"Restore last working version" for a mini-app**: APFS-clone `.applications/<dir>` before any agent turn that edits it; one button when build-health says failed. | VS Code checkpoints; vibecoder need | 0 | absent |
| 10 | **Scheduled-run hygiene**: `powerSaveBlocker` during runs, missed runs fold into one at next launch, "Scheduled" filter in Chats, each run links to the folder it wrote. | Raycast Automations, Cowork | 0 | partial |
| 11 | **OS notification tiering**: toast when a >30 s turn finishes or a permission prompt waits while Acabox is unfocused; notification deep-links to the pending prompt. | Cowork, Raycast, Cline, Relay | 0 | partial |
| 12 | **"Needs action" state** in Activity for chats blocked on a prompt or a failed credential. | Zapier statuses | 0 | partial |
| 13 | **Folder instructions**: `.acabox/INSTRUCTIONS.md` per shared folder, editable in Settings, injected per session. | Cowork folder instructions, Raycast Projects/AGENTS.md | 0 | absent |
| 14 | **Cost labels on actions** ("Rebuild — no Claude call", "Ask Claude to fix — 1 turn") and a historical typical cost per task type before running. | Genspark badge, Manus complaint | 0 | absent |
| 15 | **"What left your machine" line per turn** (files read and sent, attachments), computed from tool calls. | Portable Computer, Cowork framing | 0 | absent |
| 16 | **Start-with-a-copy onboarding**: offer to clone a folder into a sandbox copy on first add. | Perplexity reviewer advice, Manus guidance | 0 | absent |
| 17 | **Editable command confirmations** (fix the path before allowing). | Warp TUI | 0 | absent |
| 18 | **Plan mode toggle per message** (edit the plan before it runs). | Manus Plan Mode, Warp plans | +1 model turn per task when used | unknown/partial |
| 19 | **Branch this chat from here** (SDK fork). | Manus Branch, Perplexity SPACE | 0 until used | absent |
| 20 | **Save this chat as a skill** button. | Dia Skills builder | 1 model turn per skill | partial |
| 21 | **Scheduled-task prompt version history** and per-task model/effort. | Notion | 0 | unknown |
| 22 | **Approval-by-link** for scheduled tasks needing a decision while away (notification → pending prompt). | Relay.app, Cowork mobile push | 0 | absent |
| 23 | App Intents for "open/run tool X" via Siri on macOS 27. | Apple | 0 | absent (speculative) |
| 24 | On-device Foundation Models for titles/previews. | Apple | 0 Claude calls, but a non-Claude model | absent; **conflicts with Claude-only rule** |
| — | Subscription sign-in (BYOS). | Raycast | — | **not permitted by Anthropic policy** |

---

## 20. Caveats — what I could not verify

- Web search budget (shared, 200/200) ran out partway; the remaining gaps were filled with direct fetches. Items marked **unverified** rest on search snippets or secondary sources only.
- **help.openai.com and openai.com returned 403** on every fetch: the unified desktop app article, the Pulse article (including the sunset note), and the scheduled-tasks article are from snippets/secondary sources. The ChatGPT agent "removed in early August 2026" claim comes from Wikipedia (page flagged for possible AI-generated text).
- **perplexity.ai changelog/help pages returned 403**: "Computer for Pro subscribers, Computer for Slack (Mar 13, 2026)" and the local-folder-access help article are unverified; Comet background assistants come from a secondary review.
- Manus: the help center index loaded but no article bodies; per-command Allow Once/Always Allow, Plan Mode and Branch dates are from secondary reviews (consistent across three).
- Cowork's "confirmation prompts for bulk deletions added within two weeks of the 11 GB incident" is from coworkhow.com (secondary); the support article confirms a delete-confirmation prompt exists today but not when it shipped.
- Microsoft Copilot Actions general-availability status in 2026 is unknown; the support page still says preview/private preview. The Ignite 2025 blog body and the "Copilot Cowork" article could not be retrieved.
- Apple: Siri AI is in developer beta with a user beta "later in 2026"; the Foundation Models documentation page is JS-rendered, so details come from Apple's ML research post (2025 updates). Whether the framework is unchanged in macOS 27 is unverified.
- Raycast: v2.3 permission details ("tool confirmation defaults and auto-review rules") come from the changelog summary; the permissions manual page 404'd. Dia's Skills builder date is from a review, not Dia docs.
- Anthropic's third-party OAuth policy is reported consistently by four sources but the policy page itself was not fetched.
- Cline's per-task cost display is from secondary guides; Cline docs did not describe it. Relay.app's shutdown is stated on its own homepage with no further detail.
- Zapier's six statuses come from a search snippet of the help center (direct fetch 404). Genspark's Workspace 4.0 Office plugins come from a competitor's blog.
- Acabox statuses are from CLAUDE.md only; I did not read code, so "unknown" is used where CLAUDE.md is silent (e.g. whether the API key is validated on save, whether a plan mode exists).
