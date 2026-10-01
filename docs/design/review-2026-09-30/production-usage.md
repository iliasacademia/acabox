# Acabox production usage review — what the owner's own data says

Reader: production-data miner. Date: 2026-09-30. Everything below comes from
read-only copies of the production state of the one real Acabox install
(`~/Library/Application Support/acabox/production/`). No repo file was changed,
no app was run, and no secret or research-file content was read or printed.

## 0. Sources, method, and what the data cannot say

| Source | What it holds | Caveat |
|---|---|---|
| `cobuilding.db` copy (121 MB + 4 MB WAL, migration 33) | 56 chats, 25,895 message rows | `result` rows persist only `subtype`, `result`, `is_error` (`src/cobuilding/main/agentSession.ts:1328-1332`) — **no cost, duration or token counts** |
| SDK transcripts (`claude-config/projects/...`, 235 MB, 53 main + 272 sub-agent `.jsonl`) | per-message `usage` + `model`, API errors, compactions, fallbacks | `total_cost_usd` is not written by this SDK build; cost below is estimated from token counts at list prices |
| `cobuilding.log` + `cobuilding.old.log` (75,218 lines) | Sep 25 13:06 → Sep 30 20:22 PT only | 5 MB rotation; anything before Sep 25 is gone |
| `cobuilding-command-log.jsonl` (6,665 entries, Jul 25 → Oct 1) | every host-brokered shell command: `command`, `exitCode`, `source` (agent/iframe/build), `appDirName` | complete |
| `cobuilding-system-log.jsonl` (10,000-line ring) | Sep 30 22:07Z → Oct 1 03:22Z | 61% is `[APIs]` proxy traffic from one evening |
| `tool-jobs.json` (300 entries) | host job registry | capped at 300 (`src/cobuilding/main/jobRegistry.ts:70`) and **100% filled by one tool's poller**, so every other tool's job history is gone |
| manifests, notebooks, `src/` sizes for 14 tools; `tool-data/` sizes | | `open_count`/`lastOpened` bump only on an explicit open (`fileHandlers.ts:494`, `index.ts:2125`); tabs restored at boot do not count, so both under-count |
| `skills-state.json`, `knowledge-review.json`, `scheduling.db`, `tool-build-health.json` | | |

JSON shapes were inspected before aggregating: user = `{text, attachments[], quote}`;
assistant = array of one block (`tool_use` 9,421 / `thinking` 4,432 / `text` 1,979 /
`fallback` 23); tool_result = array of `{tool_use_id, content, is_error}`;
result = `{subtype, result, is_error}`.

---

## 1. Quantitative usage profile

### 1.1 Sessions over time
56 chats (54 with messages). Two bursts: **Jul 24–31: 10 chats**, **Sep 9–30: 44 chats**
(Aug: 1). Peak day Sep 25 (10 chats). 35 of 56 chats (63%) are attached to a tool
(`sessions.app_dir_name`); the busiest tools own several: coScientistUserMessages 8,
firstActionsAudit 6, authorPositionVsEngagement 5, pathTo300kCoScientistUsers 3.
Two chats have **zero messages** (Traffic Intent Signals, Data Coverage Map) — the
"empty app chat" rows `sessions:findForApp` created (CLAUDE.md 2026-09-18 entry).
One chat is linked to `app_dir_name = '_reusable'`, which is not a tool (see §11).

Working pattern: weekdays (Tue–Fri 32/81/76/54 user messages; Sun 13, Sat 7), 9:00–17:00
PT with a second evening block 20:00–23:00.

### 1.2 Messages
25,895 rows: 326 user, 15,855 assistant, 9,409 tool_result, 305 result.
Bytes: tool results 55.5 MB, assistant 45.5 MB, results 0.7 MB, **user text 157 KB**.
The user typed 0.15% of what is stored.

User messages per chat: 13 chats with exactly one, 9 with two, 6 with three; long tail to 40
(the pathTo300k "Traffic based on knowledge" chat). Tool chats average 6.5 user messages,
plain chats 4.6. User text: median 110 chars, p90 824, max 19,530 (a pasted document);
45 messages under 20 chars.

### 1.3 Turn durations (user row → next result row, 305 turns)
| p50 | p75 | p90 | p95 | max | >10 min | >30 min | total agent time |
|---|---|---|---|---|---|---|---|
| **1m43s** | 5m11s | 15m57s | 27m | **1h57m** | 44 turns | 13 turns | 27.8 h (mean 5.5 min) |

Buckets: <10s 17 · 10–30s 47 · 30–60s 49 · 1–3m 85 · 3–10m 63 · 10–30m 31 · 30–60m 12 · >1h 1.

Ten longest (paraphrased first line):
1. 1h57m — "analyse what the top spenders use the product for; messages, chats, …" (1 user message, 2,249 assistant rows, 1,152 tool calls)
2. 52m — dictated: compare how users respond to task-focused suggestions ("Tuscan suggestions" in the transcript)
3. 40m — "Run as you proposed"
4. 40m — "no, i want you to use hex api to pull data i want" (Jul 30)
5. 39m — better field classification for users (the React-hooks-error chat)
6. 38m — "Yes, your approach makes sense… maximum fidelity…"
7. 36m — "Yes, let's do that so we can compare the two groups"
8. 36m — "This session ended on 'analysis': acabox://chat/… too strong a conclusion"
9. 35m — "Look through my downloads folder… I can't attach seed_texts.jsonl (figure out why)"
10. 35m — save the data-broker directory and analyse opt-out methods

### 1.4 Models and effort
Pinned per chat (`sessions.model/effort`): Opus 5.5 31 (22 high, 9 max), Opus 5 11 (7 high, 4 max),
Fable 5.1 9 (8 high, 1 max), Fable 5 1, NULL 4. In the Sep 25–30 log window, 73 agent
sessions were created: **40 at `effort=max`** (36 Opus 5.5, 4 Fable 5.1) and 33 at high.
Max effort is now the majority setting.

### 1.5 Tool use (9,421 calls)
Bash 3,740 · Read 2,604 · Write 788 · Edit 621 · **Agent (sub-agents) 285** · ToolSearch 173 ·
WebSearch 144 · **mcp__knowledge__record_finding 134** · TaskUpdate 130 · WebFetch 117 · Grep 110 ·
TaskCreate 74 · Hex MCP tools 250 total (get_thread 58, create_thread 32, continue_thread 31,
get_cell_output 30, run_cell 23, create_cell 21, …, authenticate 8, complete_authentication 4) ·
build_and_open_mini_application 55 · TodoWrite 35 · mcp__apis__list_apis 29 · **ScheduleWakeup 28** ·
Skill 24 · open_mini_application 21 · mcp__chats__read_chat 21 · TaskStop 14 · list_chats 11 ·
NotebookEdit 5 · Monitor 4 · Glob 3 · ListAgents 2 · AskUserQuestion 1 · DesignSync 1 ·
SendMessage 1 · `mcop__knowledge__record_finding` 1 (a typo'd tool name).

Bash content: 2,339 Python invocations, 474 curl, 69 esbuild/build-app, 41 `run_in_background`,
14 `.applications/install`. Writes land in `.applications/*` (592) and the agent's own memory
(`.academia/agent-memory`: 32 Writes + 76 Edits); the user's shared data folders receive very
few writes (RepoOutreachTargets/work 6, IntentSignals 7). Reads: authorPositionVsEngagement
alone was Read 1,400 times.

### 1.6 Attachments, quotes, links, screenshots, dictation
- 34 user messages (10%) carry attachments: **31 images** (18 pasted `image.png`, 13 `Screenshot…`
  files), 2 CSV, 1 xlsx, 1 md, 1 html, 1 jsonl. The screenshot tool logged 5 captures in 5 days,
  all "drag inside Acabox → cropped". Images are how the user reports UI bugs: "Fix this chart:",
  "remove this box:", "Look at the legend in this chart. Review all visualizations for bad visual bugs."
- **Quotes: 51 messages (15.6% of all user messages)** — 48 quoting an assistant message, 3 quoting
  a mini-app. The most-used input affordance after plain text.
- Chat links (`acabox://chat/…`): 2 messages.
- Dictation: 5 dictation sessions in the 5-day log (`[Dictation] Event: final` ×5); 15 user messages
  contain spoken fillers ("um,", "uh,", "you know,"). Mis-hearings reached the agent verbatim:
  "Tuscan suggestions" (task-focused), "a plug-in for the tarot" (Zotero) — the user re-sent 30 s
  later: "Note, i meant Zotero."

### 1.7 The agent asking back
41 of 1,979 assistant text blocks end in "?"; **39 of 305 turns (12.8%) end by asking the user
something**; 35 were answered, 4 are the last turn of their chat. The one `AskUserQuestion`
call (Jul 29: "What should the dashboard actually show?" with options) failed with
`Answer questions?` — there is no UI for it, and the agent never tried again.

---

## 2. Cost — estimated, and invisible to the user

Token totals from the transcripts (main + sub-agent files), priced at current list rates
(Opus 5.5 $4/$20, cache write 1.25×, cache read $0.20; Opus 5 and 4.8 $5/$25, read $0.50;
Fable 5.1 $10/$50, read $0.25; Fable 5 read assumed $1.00; Sonnet 5 $2/$10; Sonnet 4.6 $3/$15):

| Model | Role | Output tokens | Cache reads | Cache writes | ≈ Cost |
|---|---|---|---|---|---|
| claude-opus-5-5 | main | 9.72 M | 1.19 B | 87 M | **$869** |
| claude-fable-5-1 | main | 4.04 M | 0.24 B | 38 M | **$737** |
| claude-opus-5 | main | 2.89 M | 0.25 B | 17 M | $306 |
| claude-sonnet-5 | sub-agent | 5.52 M | 0.21 B | 51 M | $225 |
| claude-opus-5-5 | sub-agent | 3.04 M | 0.24 B | 20 M | $208 |
| claude-opus-4-8 | sub-agent | 0.49 M | 0.07 B | 17 M | $154 |
| claude-opus-5 | sub-agent | 1.11 M | 0.05 B | 7 M | $96 |
| claude-fable-5 | main | 0.20 M | 0.02 B | 3 M | $75 |
| claude-opus-4-8 | main (fallback) | 0.46 M | 0.04 B | 4 M | $55 |
| claude-sonnet-4-6 | sub-agent | 0.30 M | 0.03 B | 3 M | $25 |
| **Total** | | **27.8 M** | **2.34 B** | **248 M** | **≈ $2,750**, sub-agents ≈ $708 (26%) |

Single chats routinely cost three figures (main transcript only): "App Analysis Review and
Improvement" ≈ $161, "Agent Bug Causes Wrong Task Execution" ≈ $148, "Engagement Analysis Needs
Deeper Investigation" ≈ $139, "TypeSafe Jev Model Message Classification" ≈ $136 (Fable 5.1),
"Top Spender Usage Analysis Request" ≈ $108 (one user message), "LLM Performance Abstract vs
Full Paper" ≈ $101.

**None of this is visible anywhere in Acabox.** The SDK's result message carries
`total_cost_usd`; `agentSession.ts:1328-1332` writes only `subtype/result/is_error`, and no
renderer or main file references `total_cost_usd` (grep: zero hits). The user has selected
`max` effort for 40 of the last 73 sessions and runs 285 sub-agents with no feedback on what
either costs.

---

## 3. Errors and failures

### 3.1 Turn-level
- `result.is_error` = 5 of 305: "Not logged in · Please run /login" (Jul 24, pre-fix);
  "Prompt is too long" ×3 (one chat, the 5.5 MB CSV incident); "API Error: 400 Claude Code
  2.1.273 does not support this model; version 2.1.280 or newer is required. Run 'claude
  update'…" (Sep 22 — CLI-flavoured text shown to the user).
- Transcript API errors (7): **"API Error: Opus 5.5 can't help with this. Start a new session to
  continue."** ×2 and the Sonnet equivalent ×1 (a sub-agent) — hard safety refusals on
  business-analytics chats; "Server error mid-response. The response above may be incomplete." ×1;
  "Claude's response exceeded the … output token maximum" ×1. `stop_reason: refusal` 8,
  `max_tokens` 7.
- **Model fallbacks: 15 `model_refusal_fallback` events / 23 `fallback` blocks in 6 chats** —
  Opus 5.5 → Opus 4.8 (13) or → Opus 5 (10). The renderer has no handling for a `fallback` block
  (`thread.tsx` imports only `ToolFallback`; `historyMessageConverter` has no case), so the chat
  silently ran on a different model while the header chip still said Opus 5.5.
- **Context compaction: 10 boundaries in 4 chats** (all Opus 5 era) — also unsurfaced.

### 3.2 Tool-level error rates (tool_result.is_error joined to tool_use)
Bash 3.5% (129/3,737) · Read 3.3% · Edit 4.5% · Agent 9.1% (26, all "Concurrent subagent limit
reached") · build_and_open 9.1% (5/55) · mcp__hex__get_cell_output **46.7%** (409 while the
thread runs) · NotebookEdit **100%** (5) · Monitor **100%** (4) · AskUserQuestion 100% · DesignSync
100% · Skill 4% ("design-login is not in this session's skills allowlist").

The agent cannot wait by any route: `sleep` is blocked by the CLI ("Blocked: sleep N … To wait for
a condition, use Monitor with an until-loop" ×4), Monitor needs approval ("This command requires
approval", "Contains command_substitution") that nothing in Acabox can grant, `run_in_background`
dies with the turn (41 uses), and `ScheduleWakeup` (28 uses) answers "Next wakeup scheduled for …
the harness re-invokes you when the wakeup fires" — into a process that is destroyed at turn end.

Permission prompts nobody can answer (no `canUseTool` handler — `shared/agentAllowedTools.ts:15`):
"Claude requested permissions to write to …/notebook.ipynb, but you haven't granted it yet" ×2;
WebFetch ×2 (Jul 28, before it was allow-listed); Edit into the skills store ×2; 4
`permission_denied` SSE events in the 5-day window.

The `block-secret-reads` hook fired **31 times** (11 Bash, 20 Read): the agent keeps trying to read
Acabox's own credentials file, presumably hunting for API keys.

The 5 build failures (Jul 25–27, dataCoverageMap) returned only "esbuild exited with code 1" — the
"Ask Claude to fix it" message carried the same empty detail. Fixed since: `miniAppBuilder.ts:133`
now includes stderr. Build-health today: `tool-build-health.json` is `[]`.

### 3.3 Command log (6,665 host-brokered commands)
By source: agent 3,816 · **iframe 2,782 (2,743 of them the Notes poller)** · build 67. Exit≠0: 176
(2.6%). Top failure tails: **"No Redshift credentials. Write them to
.applications/coScientistUserMessages/input/redshift.json as {host, port, …}" ×27** (Jul 30 /
Aug 6; the file never appeared — the input dir holds no `redshift.json`); "Hex returned HTTP 403
… The tool 'coScientistUserMessages' has not been granted access to the 'hex' API" ×8;
`AttributeError: 'list' object has no attribute 'keys'` ×6. esbuild: 65 ok / 2 failed.

### 3.4 Logs (Sep 25–30)
75,218 lines: debug 41,460 · info 31,242 · **warn 150 · error 2**. Of the 150 warnings, ~140 are
`[ProcessCPU] WARNING: vm:apple-vz using 9x% CPU (pid=5488)` — `src/utils/processCpuMonitor.ts`
is the Podman-era VM watchdog (labels `vfkit`, `gvproxy`, `com.apple.Virtualization.VirtualMachine`
at lines 8–10), still started at `main/index.ts:910`, now warning about an unrelated VM on the
machine. Others: `[AgentServer] exited (code=0)` ×4 (all app quits), `[Models] Discovery failed:
fetch failed` ×2 (offline), `[UPDATER] Error: net::ERR_INTERNET_DISCONNECTED` ×1.

Specific strings: "Prompt is too long" 0 · "Refusing turn" 0 · "BUILD FAILED" 0 · "keeping the
turn open" **2** (the swallowed-turn ladder fired and worked) · "swallowed" 0 · "restart" 0 ·
real HTTP 401: 0 (the 11 ` 401` hits are OpenAlex work-IDs in URLs) · Hex 429 rate limits: 6 ·
`[APIs] REFUSED` 4 (devin 502 "Could not reach api.devin.ai"; two nonexistent API names
"projects"/"v1"; hex 403 "The tool 'coScientistSpendExplorer' has not been granted access to the
'hex' API. Grant it in the tool's settings.") · `task_notification` SSE events **386** (the CLI
reporting background tasks killed at turn end) · `[Dictation]` 37 · `[Screenshot]` 5 ·
`[Knowledge]` 71 · `record_finding` 102 · `[UPDATER]` 15 (self-update to 0.1.27 succeeded).

---

## 4. The waiting problem — where the hours go

### 4.1 Nineteen nudges
19 user messages are pure nudges: "any update?" (and typos "any udpate?", "any updatE?"),
"update?" ×9, "Please respond" ×2, "You stuck?", "you there?". In almost every case the message
just before them is **the agent promising to come back on its own**:

| Gap before nudge | What the agent had said (tail, paraphrased where long) |
|---|---|
| **730.8 min** | "…It should land within the hour. The poller and heartbeat will bring me back to fold it in and give you the final summary." |
| **699.2 min** | (Hex tier explanation; turn ended) |
| **657.7 min** | "…The poller and heartbeat will bring me back when Devin answers." |
| **655.8 min** | "…if Devin is still working I re-arm both watchers. When the reply lands I will review the tables…" |
| 306.3 min | "I cannot watch the session between messages, so if you want it checked on a timer, schedule a recurring task from Acabox's Activity page." |
| 171.4 min | "…Waiting on the labelers." |
| 105.9 min | "Checking the Devin thread now." |
| 52.4 min | "…as soon as Devin finishes. These sessions usually take several minutes…" |
| 10.2 min | "**You do not need to do anything. I will report back when it is in.**" |
| 1.1 min | "…I will copy it into the app's input slot… If Devin pauses again I will nudge it again." |

Eight incidents sum to roughly **56 hours of stalled work** between a promised callback and the
user giving up and typing. Two of the four 11-hour waits were then **swallowed**: the nudge itself
came back as an empty result within a second (14 empty-result rows in the DB, 12 of them the
swallowed-resume shape, Aug 6 → Sep 21), so the user typed it again ("any udpate?" at 16:14:32,
"any updatE?" at 16:14:45; "PLease respond" 08:35, "Please respond" 08:50).

Since Sep 22 the agent's wording has changed to the honest form ("Nothing is still running on my
side. Ask me again in a few minutes and I'll collect Devin's table") — the CLAUDE.md fix — but the
nudges continue (Sep 23, 25, 28, 29) because the work is genuinely asynchronous (Devin sessions,
Hex batch cells, labelling jobs run for 5–60 min) and the only mechanism offered, "schedule a
recurring task from Acabox's Activity page", has **never been used: `scheduling.db` has 0 tasks and
0 runs**. 149 assistant rows mention Acabox together with "can't"/"cannot"/"not able to" — the agent
explaining platform limits is a recurring genre.

### 4.2 Turns that never answered
21 of 326 user messages (6.4%) have no result row before the next user message:
- 3 are the **Stop button**: `chat:stop` → `removeForwarding` + `unregisterSession`
  (`main/index.ts:2397-2402`) destroys the session mid-turn (log: "deferring destroy until
  turn-complete" then "session destroyed" 8–13 ms later on Sep 25 15:50, Sep 29 11:04, Sep 30
  14:45 PT). No result row is written, so at the next message `cleanupOrphanTurnRows`
  (`agentSession.ts:488`, `db/chatRepository.ts:329-345`) deletes the partial work: **237 rows
  (4m16s of agent activity) on Sep 30, 27 rows on Sep 29**. The user's message stays with no reply
  and no "Stopped" marker; any files the agent wrote in that partial turn are on disk but nothing
  in the chat says so.
- ~6 are bursts/re-sends (3 mini-app error reports within 3 s, twice; a dictated message
  re-sent 30 s later with "Note, i meant Zotero").
- ~12 are genuinely lost turns, mostly before the Sep 21 fix: two were the **first message of a
  new chat** (Sep 17, Sep 22 — the user had to say "Try again"), and on Sep 25 a first message got
  nothing for 12.5 min until "Update?" (log window starts after it; cause not recoverable).

### 4.3 What the agent tried instead
`ScheduleWakeup` ×28 (all in Jul 30 and Sep 20–21 chats, delays 2–30 min, e.g. "Heartbeat: check
the Devin session … for the round-2 reply"), `Monitor` ×4, `run_in_background` ×41, `TaskStop` ×14,
`sleep` ×4 blocked. 386 `task_notification` events in five days are the corpses.

---

## 5. Tools: what got built, what got reused, what got published

### 5.1 Inventory
20 `manage_mini_app.mjs` invocations in Bash (14 distinct scaffolds + helper calls). On disk: 14
tool directories; 0 archived; 1 deleted (randomNumberGenerator, Jul 30, its `tool-data` still
holds `.tool-meta.json`); 1 never finished — **dataBrokerOptOuts has `creation_pending: true`,
no `App.tsx`, after a 35-minute single-message chat on Sep 28; opened once, it shows the
"BEING WRITTEN" state forever.**

| Tool | created | open_count | lastOpened | lastRun | published | App.tsx |
|---|---|---|---|---|---|---|
| coScientistUserMessages | Jul 30 | **66** | Sep 25 | Sep 25 | – | 48 KB + 6 files |
| coScientistSpendExplorer | Sep 18 | 44 | **Sep 29** | – | Sep 18 | **110 KB** |
| pathTo300kCoScientistUsers | Sep 18 | 35 | Sep 29 | – | Sep 18 | 38 KB |
| authorPositionVsEngagement | Sep 22 | 33 | Sep 25 | – | Sep 22 | 24 KB |
| firstActionsAudit | Sep 25 | 29 | Sep 30 | – | Sep 28 | 22 KB + 9 files |
| notes | Sep 27 | 12 | Sep 27* | Sep 29 | – | 26 KB + 7 files |
| dataCoverageMap | Jul 25 | 8 | Sep 10 | – | – | 33 KB |
| hexRunHealth | Jul 30 | 7 | Sep 10 | Aug 6 | – | 21 KB |
| trafficIntentSignals | Sep 21 | 6 | Sep 21 | – | – | 31 KB |
| trialCancellationsAug2026 | Sep 29 | 4 | Sep 29 | – | – | 19 KB |
| userReturnFrequency | Sep 24 | 3 | Sep 24 | – | Sep 24 (+44 s) | 9 KB |
| zoteroPluginCensus | Sep 25 | 3 | Sep 25 | – | Sep 25 | 22 KB |
| paymentMethodAbUplift | Sep 18 | 1 | Sep 18 | – | Sep 18 (+1 min) | 17 KB |
| dataBrokerOptOuts | Sep 28 | – | Sep 28 | – | – | **none** |

\* the command log shows Notes running on Sep 28 and 29 while `lastOpened` stays Sep 27 — the tab
was restored at boot, which does not count as an open.

### 5.2 The reuse thesis, tested
- Opened on a later day than created: **8 of 13** built tools (62%).
- Opened after the tool's own chats went quiet (i.e. used, not still being built): **3** —
  coScientistSpendExplorer (4 days later), dataCoverageMap and hexRunHealth (both 6 weeks later,
  on the same day — a browse).
- Re-RUN (host `lastRun` stamped): **3 tools ever** — coScientistUserMessages (a data sync whose
  script fails without `redshift.json`), hexRunHealth (once, Aug 6), notes (a poller).
- **Every one of the 14 notebooks is the untouched 2-cell scaffold with 0 outputs** (hexRunHealth
  has 3 cells, 0 outputs). `executeCode` appears in **zero** tools' sources; "kernel" appears
  zero times in 75k log lines. Tools either ship baked data (`data.ts`, `data.json`, `census.json`)
  or run Python through `exec` (notes 9 call sites, userMessages 5).
- **7 of 13 tools were published to share.acabox.us**, all with `includeInput: true`, and all
  within minutes to hours of being built (paymentMethodAbUplift published one minute after its
  last build and never opened again; userReturnFrequency published 44 s after creation).

Honest reading: a "tool" here is a **shareable analysis report with a UI**, built in a 1–3 day
conversation, published, and rarely touched again. The re-runnable-instrument half of the thesis
is carried by one tool (coScientistUserMessages), and its refresh path has been broken since Jul 30.

### 5.3 Maintenance load lands on the user
- 15 host-composed error reports "An error occurred in mini-app `x`. Please fix or explain it."
  (11 coScientistUserMessages, 4 coScientistSpendExplorer; kinds: hex 7, console 6, exception 2),
  including "React has detected a change in the order of Hooks called by %s…" — a stack trace a
  non-technical user is asked to forward. Twice three reports landed within 3 seconds.
- 3 build-failure forwards ("The build for `x` failed. Diagnose and fix it.").
- 6+ of 56 chat titles are failures: "React Hooks Called in Wrong Order", "Hex HTTP 403 Error
  During Run", "Polling Process Crashed During Session", "Chart Needs Fixing", "Unable to Connect
  to Hex", "Device Malfunction Help Request" (the user typed "why is it not working?").
- coScientistUserMessages received **309 Edits, 155 Writes, 481 Reads** across 8 chats.
- `tool-data/` holds **1.7 GB** (authorPositionVsEngagement 12,215 files / 1.0 GB; userMessages
  341 MB; dataBrokerOptOuts 207 MB) with no in-app view of size.

### 5.4 The Notes poller
`notes/src/App.tsx:41`: `const POLL_MS = 5000; // picks up edits made in Obsidian, or by Acabox
in chat` → `exec("python3 .applications/notes/scripts/notes_fs.py scan")` every 5 s while open:
**2,737 shell spawns** (Sep 28: 874 over 6.5 h; Sep 29: 1,862 over 2.6 h), each a host job,
filling `tool-jobs.json` to its 300 cap and evicting every other tool's history; each one is also
an Activity "Recently finished" row and a `lastRun` stamp. The host has a Rust file monitor, but
the bridge exposes no change events, so the vibecoded tool polls.

---

## 6. Knowledge, skills, connectors, APIs, servers, scheduler

- **`mcp__knowledge__record_finding`: 134 calls.** CLAUDE.md's "NOT verified whether the model
  volunteers it" is stale — it does, heavily. Findings files: database-lookup 44, coscientist-
  analytics 11, acabox 10, manage-mini-application 9, academia-redshift-analytics 9,
  devin-sessions 5, react-plotly/devin-api/devin-analytics/xlsx/zotero-plugins 4 each.
  `knowledge-review.json` holds 10 items, all `connector-without-ledger` for hex (UI string:
  "This chat queried hex without consulting the ledger").
- **6 agent-authored skills exist and all are `enabled: false`** (coscientist-analytics Jul 30;
  academia-redshift-analytics, devin-sessions Sep 21; devin-analytics Sep 22; devin-api Sep 24;
  zotero-plugins Sep 25) — adopted disabled by design (`skillStore.ts:667/870`) and never enabled.
  They stay symlinked (`skillRender.ts` header) and the agent Reads them by path anyway
  (coscientist-analytics 5 reads) and writes findings into them.
- `Skill` tool: manage-mini-application 16, acabox 6, react-plotly 1, design-login 1 (failed).
  Skills Read by path: database-lookup 19, manage-mini-application 12, react-plotly 6,
  coscientist-analytics 5. **The 10 bioscience database skills, flow-cytometry,
  differential-expression, docx, pptx, pdf, xlsx, academic-writing-agent, activity-summary and
  reaction were never invoked and never read** — yet sit in the roster every turn (budget bumped
  to 5% precisely because the listing overflowed). manage-mini-application and react-plotly read
  as MODIFIED (SKILL.md, two examples).
- Connectors: hex only. The Jul 29 OAuth saga is visible: 8 `mcp__hex__authenticate` and 4
  `complete_authentication` calls across 2 chats on one day. Hex MCP works now (250 calls).
- APIs registry: hex, devin, typesafe-jev, openalex. One evening (Sep 30) the proxy relayed
  **6,139 POSTs to typesafe-jev** from an agent script, all 200. `mcp__apis__list_apis` 29 calls.
- Claude-authored local MCP servers: **none exist** (no `.mcp-servers/`, no `mcp-servers/`);
  `manage-mcp-server` never invoked. The fork's third charter capability has zero production use.
- Scheduler: **0 tasks, 0 runs** (and it is the agent's recommended answer to waiting).
- Sharing: 7 publishes (§5.1). Updater: self-update to 0.1.27 worked.

---

## 7. First-message themes (54 chats)

| Theme | ≈ chats | Paraphrased examples |
|---|---|---|
| Analysis / data question (Hex, Devin, Redshift via the agent) | 22 | "of the users we invited, what % clicked and what % then chatted"; "what do the top spenders use it for"; "confirm the 20% unsubscribe figure from this chat"; "are there reliable stats on how researchers use AI" |
| Build a tool | 10 | "build an app showing data coverage vs publication volume"; "a dashboard on Hex run health"; "make an app that clearly communicates this retention data"; "a simple to-do / notes app — or Obsidian inside Acabox?" |
| Fix / error report | 8 | "why is it not working?" (+screenshot); "Why do I get 'Hex returned HTTP 403'…"; the React-hooks error forward; "Fix this chart:" (+screenshot); "the poller died — what happened?" |
| Capability question | 6 | "Can you access all of my local files?"; "Can you access this link?"; "Can you read IntentSignals/HANDOFF.md? yes or no"; "Is this opus 5.5? do we need acabox update?" |
| Change / review a tool | 4 | "It's too much data. The UI is too busy. Make key points…"; "review the analysis in this app — reasonable?"; "look at the legend… bad visual bugs" |
| Ideas / other | 4 | a Zotero plugin marketplace (dictated); biologists and code execution; running untrusted code in a sandbox |

Short user messages (<25 chars, 45 of them) are dominated by steering and nudging: "yes",
"continue", "try now", "done. try now", "any update?", "update?", "where is the report?",
"let's do path b", "run as you proposed", "/compact".

---

## 8. What a non-technical scientist experiences (walkthrough from the data)

1. **Day 1 — build.** She describes a tool in one message. The agent scaffolds it; a card appears.
   It then spends 20–50 minutes writing a 20–110 KB `App.tsx` and several files; the card says
   BEING WRITTEN. If she looks away and the agent decides it needs Devin or Hex, it says
   "I will report back when it is in. You do not need to do anything." Nothing reports back.
   Eleven hours later she types "any update?" — and that message comes back blank in one second,
   so she types it again.
2. **The tool opens.** It is a handsome dashboard of frozen numbers. Pressing its Refresh button
   fails 27 times with "No Redshift credentials. Write them to …/input/redshift.json", or with
   "Hex returned HTTP 403 … has not been granted access to the 'hex' API" because a checkbox in
   the tool's Settings panel was never ticked. She has no way to know either sentence is addressed
   to her.
3. **Something breaks.** A red overlay says "React has detected a change in the order of Hooks
   called by %s." She clicks Ask Claude; three identical reports go into a new chat titled
   "React Hooks Called in Wrong Order". That chat costs ~$140 and takes a day.
4. **She points at things.** Screenshots (31) and quotes (51) are her language; they work well.
   Dictation works too, except the agent hears "the tarot" for "Zotero".
5. **She attaches three files; two chips appear.** The third was 32.6 MB against a 30 MB cap
   (`attachmentAdapter.ts:206-207`); no explanation reached her, so she asks the agent "How many
   did I attach?", it goes off for four minutes, she hits Stop, then asks it to "figure out why"
   (35 minutes). After her next message the chat shows her question with no reply at all.
6. **She wants an answer in a hurry.** The agent is half-way through a 40-minute turn; she cannot
   ask a side question without queueing it; Stop throws away what it had done so far, with no trace.
7. **Quality changes silently.** Twenty-three times her Opus 5.5 chat was answered by Opus 4.8 or
   Opus 5 after a safety fallback; twice the model said "can't help with this. Start a new session
   to continue." The header still said Opus 5.5.
8. **The bill.** About $2,750 in nine weeks, $100–160 per big chat, 40 of the last 73 sessions at
   max effort — and no number anywhere in the app.
9. **What she never finds:** the scheduler the agent tells her to use (Activity page, never
   opened), six skills Claude wrote for her waiting disabled on the Knowledge page, ten review items
   there, 1.7 GB of tool data, and the three "Servers" features she has never needed.

---

## 9. Strengths the data confirms
- Quotes (15.6% of messages), screenshots (31) and multi-chat-per-tool (8 chats on one tool) are
  used naturally — the input design is right.
- Sharing is real: 7 of 13 tools published, within minutes of being built. The product's observed
  unit of value is "a report I can send", and that path works.
- The knowledge loop fires without prompting: 134 findings recorded across 11 skills.
- The swallowed-turn ladder works in production ("keeping the turn open" ×2, each followed by the
  CLI's own answer).
- The credential proxy carried 6,139 third-party API calls in one evening with zero leaks; the
  secret-read hook stopped 31 attempts.
- Build reliability is now high: 50/55 agent builds and 65/67 esbuild runs succeeded; the only
  failures were in the first week.
- Only 2 error-level log lines in five days; 4 clean restarts; self-update succeeded.

---

## 10. Gaps (inferred pain points, with the numbers)

1. **Asynchronous work has no honest model (high).** 19 nudges, ~56 h of stalled work across 8
   incidents, 12 swallowed nudges, 28 ScheduleWakeups + 41 background commands + 4 Monitors + 4
   blocked sleeps that could never fire, 386 dead-task notifications in 5 days, 0 scheduled tasks.
2. **Stop and lost turns erase work (high).** 3 Stops in 5 days each deleted the partial turn at
   the next message (237, 27 rows); 21 messages (6.4%) with no reply row; two first messages of
   new chats silently lost; a 12.5-min silent wait. No "Stopped" marker exists
   (`index.ts:2397-2402`, `chatRepository.ts:329-345`).
3. **Cost is invisible (high, given the owner's cost rule).** ≈$2,750, $100–160 chats, 26% in
   sub-agents, 55% of recent sessions at max effort; `total_cost_usd` dropped at
   `agentSession.ts:1328`.
4. **Tools that need approval always fail (medium-high).** NotebookEdit/Monitor/AskUserQuestion/
   DesignSync 100% failure; "Claude requested permissions… but you haven't granted it yet" ×6;
   no `canUseTool` handler. The one structured question to the user died here.
5. **Attachment rejection is silent (medium).** 32.6 MB `.jsonl` vs 30 MB cap → "I only see 2" →
   a 4-min + 35-min detour; `attachmentAdapter.ts:206` throws with no composer-level handler found.
6. **Model fallbacks and hard refusals are unsurfaced (medium).** 23 fallback blocks in 6 chats,
   2 "Start a new session to continue" dead ends, 10 compactions; renderer has no `fallback` case.
7. **Runtime errors are forwarded as stack traces by the user (medium).** 15 error reports, bursts
   of 3 in 3 s, 6 chats titled by their error; coScientistUserMessages needed 309 Edits.
8. **Non-HTTP data sources have no credential home (medium).** 27 "No Redshift credentials…
   redshift.json" failures; the API registry is HTTP-only; the agent's fallback was a plaintext
   JSON in the agent-writable workspace (never created).
9. **A polling tool floods the host (medium).** 2,737 spawns, `tool-jobs.json` 300/300 one tool,
   every other tool's job history evicted; no file-change bridge event.
10. **Jupyter is dead weight for this user (medium, simplify).** 14/14 scaffold notebooks, 0
    outputs, 0 `executeCode`, kernel never spawned in 75k lines — yet every tool ships a notebook
    and the venv bootstraps the gateway stack.
11. **Skills roster is wrong-sized and the authored skills are dark (medium).** 17 shipped skills
    never invoked or read by this user; 6 agent-written skills disabled and unreviewed with 37
    findings files inside; 10 knowledge review items unseen.
12. **The scheduler is the recommended answer and has 0 uses (medium).** The agent now says
    "schedule a recurring task from Acabox's Activity page"; nothing in the chat offers to do it.
13. **ProcessCPU is Podman-era dead code emitting ~140 false warnings (low, dead code).**
    `src/utils/processCpuMonitor.ts:8-10`, started at `main/index.ts:910`.
14. **`_reusable` is linked as a tool (low, bug).** `backfillAllAppChatLinks` enumerates every
    non-dot directory (`main/index.ts:1943`), so `_reusable`/`_bridge`/`_vendor`/`_templates` are
    scanned and the first chat is tagged with a chip for a non-tool.
15. **Dictation fillers and mis-hearings reach the agent verbatim (low-medium).** 15 messages with
    fillers; "Tuscan suggestions", "the tarot".
16. **Half-built tools stay half-built (low-medium).** dataBrokerOptOuts `creation_pending: true`
    with no `App.tsx` since Sep 28; two zero-message tool chats.
17. **Open/run telemetry under-counts (low, data quality).** Tabs restored at boot do not bump
    `lastOpened`/`open_count`; `lastRun` only via host jobs.
18. **CLAUDE.md is stale on record_finding (low, stale guidance).** It says volunteering was not
    verified; 134 calls say otherwise.

---

## 11. Ideas (what the data says to build or remove)

| # | Idea | Model calls per use | Effort |
|---|---|---|---|
| 1 | **Host-owned "wait for" primitive**: the agent registers a condition (URL/API poll, file appears, Devin/Hex status) and ends its turn; main polls cheaply and starts ONE turn when it fires or times out. Replaces ScheduleWakeup/Monitor/pollers. | 0 while waiting; 1 turn when the event fires — the same turn the user triggers by hand today | L |
| 2 | **Stop keeps the record**: write a `{subtype:'stopped'}` result row on `chat:stop`, keep partial rows, render "Stopped by you · N steps · files changed: …". Also a "Stopped" state for the two first-message losses. | 0 | S |
| 3 | **Show cost**: persist `total_cost_usd`/`duration_ms` from the SDK result, show per-turn cost in the fold line ("Worked for 4m · 26 steps · $1.80"), per-chat total in the header, running total in the status bar; flag `max` effort cost. | 0 | S |
| 4 | **Attachment feedback**: toast per rejected file with the reason and the cap; over-cap files attach as a path reference instead of vanishing. | 0 | S |
| 5 | **Render `fallback` blocks and hard refusals in plain words** ("Answered by Opus 4.8 after a safety check") with a one-click "Start a new chat from here" that carries the last N messages. | 0 (the new chat's first turn is one the user would start anyway) | S |
| 6 | **Answer the agent's structured questions**: a UI for `AskUserQuestion` (option chips in the composer) and a minimal `canUseTool` that auto-denies with a readable reason instead of "you haven't granted it yet". | 0 (fewer wasted turns) | M |
| 7 | **Remove the Jupyter kernel gateway and the per-tool notebook scaffold** (keep Python via `exec`); drop `ipykernel`/`jupyter_kernel_gateway` from the venv bootstrap. | 0 | M |
| 8 | **Delete `processCpuMonitor`** and its two log tags. | 0 | S |
| 9 | **Bridge file-change events** (`hostAPI.watch(path)`) from the existing Rust monitor; collapse identical sub-second jobs in the registry and cap per tool. | 0 | M |
| 10 | **Error reports that a scientist can read**: dedupe bursts (one report per 10 s), lead with "what you can do" vs "a bug Claude will fix", include the tool's grant/credential state when the error is 403/credentials. | 0 (one turn instead of three) | S |
| 11 | **Per-workspace skill roster**: hide shipped skills never used in this workspace behind "More skills"; surface the 6 "Awaiting review" skills and the 10 review items on Home. | 0; negative on every turn (smaller roster) | M |
| 12 | **Offer the schedule in-chat**: when the agent says "ask again later", the host renders a one-click "Check every 30 min for 3 h" that creates a bounded scheduled task. | 1 turn per check (explicit, bounded, user-approved) | M |
| 13 | **Non-HTTP credentials**: a DSN entry type (Redshift/Postgres) in the credential store exposed to tools through the proxy as a query endpoint. | 0 | L |
| 14 | **Dictation cleanup**: strip "um/uh/you know" client-side; optional "tidy" pass. | 0 (strip) / 1 Haiku call per dictation (tidy) | S |
| 15 | **Finish or clear half-built tools**: a "Resume building" action on a `creation_pending` card that reopens its chat with the scaffold state. | 0 (the resumed turn is one the user asks for) | S |
| 16 | **Fix `backfillAllAppChatLinks`** to skip `_`-prefixed dirs and dirs without a manifest. | 0 | S |
| 17 | **Lean into publishing**: the observed unit of value is the shared report; put Publish on the tool header and show the live URL/last-published time on the card. | 0 | S |
| 18 | **Update CLAUDE.md**: record_finding is volunteered (134 calls); note the Stop/sweep interaction and the Notes poller as known hazards. | 0 | S |

---

## 12. Open questions the data cannot settle
- Whether the Sep 25 12.5-minute silent first message was the swallowed-turn bug on v0.1.25 (the
  log window starts after it).
- Whether the user *saw* a rejection for the 32.6 MB attachment (no renderer handler was found,
  but assistant-ui may surface adapter errors internally).
- Whether the 6 disabled agent-written skills were ever shown to the user (the Knowledge page
  renders them; no visit telemetry exists).
- The exact pricing for Fable 5 cache reads (assumed $1.00/MTok); the total is ±5% on that.
