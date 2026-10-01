# Synthesis — Month three: a scientist who uses Acabox weekly to build and rerun analysis tools

Date: 2026-09-30. Lens: sustained use — iterating on a tool through chat, recovering from a bad edit, trusting a number a tool shows, long-running analyses, scheduled work, sharing a tool with a colleague, cost over a month on the user's own key, and whether tools are reused. Reliability and recoverability outrank polish; every proposal states model calls per use and prefers what the host or the Agent SDK can do for zero calls.

## 0. Inputs and method

All sixteen report files were read in full (839 KB, not the ~450 KB estimated). None was missing. Three (`copy-jargon-audit`, `anthropic-surfaces`, `openai-google-surfaces`) exceeded the per-read cap and were completed on a second read; the four largest landscape reports were read in halves. The owner's live facts (dev app, 2026-09-30) were treated as ground truth.

Where reports disagreed or a recommendation hinged on a fact only code can settle, I read the repository (read-only, nothing run):

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5456-5466` — the SDK result message carries `total_cost_usd`, `modelUsage` and `duration_api_ms`. The doc text: the value is "cumulative across turns in streaming-input sessions — each result carries the running total so far", so a per-turn figure is a delta within a session. `enableFileCheckpointing` (1625) and `Query.rewindFiles` (2974) and `Query.interrupt()` (2713) exist in this build.
- `src/cobuilding/agent-server/index.ts:702` — `broadcastSSE(state, 'message', message)` forwards the whole SDK message, so cost fields already reach the host. `interrupt` appears only in the route comment at line 17.
- `src/cobuilding/main/agentSession.ts:1328-1332` — the result row keeps only `subtype`, `result`, `is_error`.
- `src/cobuilding/main/db/chatRepository.ts:329-345` — `cleanupOrphanTurnRows` deletes every `assistant`/`tool_result` row after the last `result` row; `main/index.ts:2397-2402` — `chat:stop` only `unregisterSession`s (destroy), writing nothing.
- `src/cobuilding/renderer/historyMessageConverter.ts:103-182` — handles `user`, `assistant`, `tool_result` only, and keeps only `text`/`tool_use` blocks (line 179): a `fallback` block is dropped silently.
- `src/cobuilding/main/packageInstaller.ts:234,329` — a failed wave logs only `waveError.message` and the exit code; `main/backgroundBuilder.ts:41-49` — every boot runs `ensureAppLiveDeps` for every existing app and marks it ready only on success, so a wave that exits 1 re-runs every boot.
- `src/cobuilding/skills/manage-mini-application/assets/reusable/useAppState.ts:5-11` — the tool's `notebook.ipynb` is documented as "the durable, portable source of truth" for parameters, outputs and run results. This rules out removing the notebook scaffold even though the kernel is never used.
- `src/cobuilding/renderer/components/schedule/scheduleCron.ts:23-27` — "days" emits `0 0 */N * *` (a day-of-month step).
- `src/cobuilding/renderer/components/MiniAppViewer.tsx` — the only error state is `rebuildState.kind === 'error'` (build); no runtime-error path exists.

## 1. The month-three picture

The production data describes exactly this user. 56 chats over nine weeks, 63% attached to a tool, 14 tools built. The owner's data says what a tool is in practice: a shareable analysis report with a UI, built in a 1–3 day conversation, published within minutes (7 of 13, all with input data), and rarely touched again. Only 3 tools were ever re-run; the one genuine re-runnable instrument (`coScientistUserMessages`, 66 opens) has had a broken refresh path since Jul 30 (27 failures: "No Redshift credentials…"). Every one of the 14 notebooks is the untouched scaffold; `executeCode` appears in no tool; tools run Python through `exec` or ship baked data.

What the weekly user actually spends time on, in order of measured loss:

1. **Waiting on work that cannot report back.** 19 nudge messages, about 56 hours stalled across eight incidents, 12 of those nudges swallowed; 28 `ScheduleWakeup`, 41 background commands, 4 `Monitor`, 4 blocked `sleep`, 386 dead task notifications in five days. The scheduler the agent recommends has 0 tasks and 0 runs.
2. **Maintaining tools.** `coScientistUserMessages` took 309 Edits, 155 Writes and 481 Reads across 8 chats; 15 host-composed error reports (bursts of three in three seconds); six chat titles are failures. There is no way back after a bad edit — no snapshot of a tool's code exists anywhere, and delete is `rm`.
3. **Paying without seeing.** About $2,750 in nine weeks, single chats at $100–160, 26% in sub-agents, 40 of the last 73 sessions at `max` effort — and no number anywhere in the app, although the SDK hands the host a running total on every result.
4. **Losing work to Stop.** Three Stops in five days each deleted the partial turn at the next message (237 and 27 rows); the live test showed the model's kill-grace-period reply ("the sandbox blocks long sleep commands") displayed as a finished turn and then erased.
5. **Not knowing a tool is broken.** The only dev tool opened to a blank pane marked IDLE; the host knows build errors and nothing else.

Strengths to protect: quotes (15.6% of messages), screenshots and multi-chat-per-tool are used naturally; sharing works and is used; the knowledge loop fires without prompting (134 `record_finding` calls); the swallowed-turn ladder works in production; the credential proxy carried 6,139 third-party calls with zero leaks; build reliability is high (50/55 agent builds succeeded).

## 2. Ranked recommendations

Priority: P0 = fix before anything else; P1 = next; P2 = later. Effort S/M/L/XL. "0 calls" means no Anthropic API call beyond turns the user already sends.

### P0

**01 — Stop keeps the record** (fix-bug, S, 0 calls)
- Problem: the Stop button destroys the session; no `result` row is written, so the next message's `cleanupOrphanTurnRows` deletes everything the agent did (live: 4 rows; production: 237 and 27 rows). During the SIGTERM grace period the model still produces a reply, which the UI shows as a finished turn with a hallucinated reason, then erases. No "Stopped" marker exists; files the partial turn wrote are on disk with nothing in the chat saying so.
- Evidence: live fact (Stop test); production-usage §4.2; chat-experience §2; `main/index.ts:2397-2402`, `chatRepository.ts:329-345`, SDK `interrupt()` at `sdk.d.ts:2713` unused (`agent-server/index.ts:17` comment only).
- Proposal: on `chat:stop`, call the SDK `interrupt()` first (soft stop, no grace-period reply), ignore any assistant message arriving after the stop was requested, then write a `result` row `{subtype:'stopped'}` so partial rows survive the sweep; add a converter case rendering "Stopped by you · N steps · changed: file, file"; then destroy. Also write `stopped` for the two first-message-lost shapes.
- Benefit: Stop becomes a steering wheel instead of an eraser; what the agent wrote (and which files it touched) stays visible.

**02 — A crashed tool is a visible, fixable state; the builder forbids duplicate React** (fix-bug, M, 0 to display; 1 turn when the user clicks fix)
- Problem: a render-time crash leaves a blank white pane with the chip reading IDLE. The scaffold `ErrorBoundary` renders `null`; `ErrorDisplay` subscribes in `useEffect`, after the error fired; the host (`MiniAppViewer`) tracks only build errors. The dev cause (two React copies bundled from a nested install) is one `npm install` away from production. Runtime errors reach the chat only when the user forwards a stack trace under their own name, often three times in three seconds.
- Evidence: live fact (blank/IDLE, root cause); tools-lifecycle F8/F9 (`manage_mini_app.mjs:220-222`, `MiniAppViewer.tsx:1137-1143`); production-usage §5.3 (15 error reports, bursts); `MiniAppViewer.tsx` error state is build-only.
- Proposal: the scaffold's ErrorBoundary renders "This tool crashed — Ask me to fix it / Restore last working version" and posts `runtime-error` to the host through the bridge, buffering errors that fire before `ErrorDisplay` mounts; main records runtime health beside build health (chip `CRASHED`, Activity "Needs attention", home card variant — `.cdCard--crashed` CSS already exists unused); `requestFix` expands a collapsed chat panel; reports are deduped to one per 10 s. In `miniAppBuilder`, pass esbuild `--alias:react=` / `--alias:react-dom=` pointing at the npm-site's single copy so nested copies can never be bundled twice.
- Benefit: "nobody told" ends; a broken tool is as visible as a broken build, and the fix is one click, user-initiated.

**03 — Tool history with Restore** (feature, M, 0 calls)
- Problem: no version of a tool's code is ever kept; `Edit`/`Write` overwrite `App.tsx` in place; delete is `rm` with no trash. After a bad edit the only recourse is asking Claude to "put it back" from memory. Every comparable product (Lovable, Bolt, Replit, Cursor, Cline, Claude Code `/rewind`, Base44) treats restore as basic; the most-cited non-technical complaint is "it wiped out an existing feature".
- Evidence: tools-lifecycle §2.1/F3 (grep: no snapshot, `fileHandlers.ts:629-631`); production-usage §5.3 (309 Edits on one tool, failure-titled chats); vibecoding-mainstream §5.4; anthropic-surfaces Tier 1 #1; desktop-agents #1/#9; agent-ux C1/D4.
- Proposal: on every successful `buildMiniApp` (`miniAppBuilder.ts:141`) copy the code tree (`src/`, `manifest.json`, `notebook.ipynb`, `requirements.txt`, `package.json`, `setup/`; never `input`/`output`/`dist`) into `<userData>/tool-history/<dir>/<ts>/` (APFS clone; tens of KB), keep the last N, label each with the first line of the chat turn that made it; a "History" menu in the tool header with preview/Restore (copy back + rebuild); "Restore last working version" offered automatically when build health or runtime health (02) is failed; snapshot on Delete so "Undo delete" exists; a fix-loop guard — after three consecutive failed fixes on one tool, the fix button recommends Restore + a fresh chat. State plainly that `tool-data/` is not reverted (code vs data, as every peer says). Later, optionally, SDK `enableFileCheckpointing` for the user's research files (Write/Edit only; Bash excluded).
- Benefit: "it worked yesterday, put it back" becomes one click; iteration stops being a gamble.
- Depends on: 02 for the automatic offer on crash (optional).

**04 — Cost on every turn, per chat, per month** (cost, S, 0 calls)
- Problem: the user pays per token on their own key and sees nothing. The SDK result message carries `total_cost_usd` and `modelUsage` (sub-agents included); the agent server forwards the whole message; the host drops it at the result row. Max effort is now the majority setting with no feedback. Every landscape report names cost opacity as the #1 complaint across the field.
- Evidence: production-usage §2 (~$2,750; $100–160 chats; 40/73 at max; `agentSession.ts:1328-1332`); live fact #3; `sdk.d.ts:5456-5466`; `agent-server/index.ts:702`.
- Proposal: persist `total_cost_usd`, `modelUsage`, `duration_api_ms` on the result row; compute per-turn cost as the delta of the running total within a session (the SDK value is cumulative per `query()`); show "$0.42" on the fold line ("Worked for 4m · 26 steps · $0.42"), a per-chat total in the header, month-to-date and per-model breakdown in Settings → Usage, and per-run cost on scheduled-task rows; label it "estimate at list price"; the effort blurb "uses your limits faster" becomes "costs more"; cost labels on actions ("Rebuild — no Claude call", "Ask me to fix it — 1 turn"). Optional soft monthly figure in Settings that only warns (nothing blocked).
- Benefit: the owner's own cost rule finally has an instrument; the user can see what max effort and sub-agents cost before the invoice does.

**05 — Files tab delete: confirm, and Trash instead of rm** (safety, S, 0 calls)
- Problem: the row trash icon and the context-menu Delete permanently remove a file or whole folder from the user's real research directory with no confirmation and no Trash (`fsPromises.rm(recursive)`). Removing a folder from the workspace list does confirm; skills get a 30-day trash; research data gets neither.
- Evidence: live fact #5 (`FilesTab.tsx:368-371,449-451` → `fileHandlers.ts:323`); secondary-tabs §2.3(1).
- Proposal: `shell.trashItem` plus the confirm pattern Settings already uses; name the item and its size in the dialog.
- Benefit: a mis-hit beside Rename is recoverable from the macOS Trash.

### P1

**06 — Asynchronous work: a host-owned "wait for" primitive, then exactly one turn** (feature, L, 0 while waiting; 1 turn when the condition fires — the same turn the user triggers by hand today)
- Problem: the biggest measured loss in production. The agent promises "the poller will bring me back" and nothing does; the user types "any update?" 19 times, two of the four 11-hour waits are then swallowed; the only offered mechanism (Activity scheduler) has never been used. The agent's own attempts (`ScheduleWakeup`, `run_in_background`, `Monitor`, `sleep`) can never fire in a one-turn-one-process harness. CLAUDE.md rightly rejected keep-alive sessions (open-ended bill).
- Evidence: production-usage §4 (56 h stalled, 19 nudges, 386 dead task notifications, scheduler 0/0); CLAUDE.md "Background Bash commands die with the turn".
- Proposal (two phases). Phase 1 (M): a `schedule` relay tool so the agent can create a bounded one-shot or short recurring task from the chat ("check Devin at 18:40; stop after 3 checks") that the host shows in Activity and the user can cancel; 0 calls to create, 1 turn per check, explicit and bounded. Phase 2 (L): a `wait_for` relay where the agent registers a deterministic condition — HTTP GET predicate (through the credential proxy), file appears/changes, command exit code — with a poll interval and a deadline, and ends its turn with "I'll continue when X is ready". Main polls with zero model calls, shows "Waiting for … · checks every 2 min · until 18:40 · Cancel" in Activity, and when the condition fires or times out starts exactly ONE turn in the same chat carrying the observed result, with a notification (13). No session is kept alive; nothing runs unattended on a timer except the deterministic probe.
- Benefit: Devin/Hex/labelling jobs that take 5–60 minutes stop costing hours of silence; the honest "ask me again" sentence becomes unnecessary.
- Depends on: 13 (notification). Respects the recorded decision against keep-alive pollers.

**07 — A failed install is a state, not a loop; the pip wave's stderr is kept; satisfied waves are skipped** (fix-bug, M, 0 to display; 1 turn if the user asks for a fix)
- Problem: every dev boot runs a pip wave for a tool's `requirements.txt` that exits 1 although every package is satisfied; stderr is not logged and nothing is shown. When a wave fails during first open, the viewer retries every 3 s and the rows cycle FAILED → QUEUED → INSTALLING forever with no Skip, no error text and no fix path; the one actionable message in the code (`userActionable`, "Install Python 3…") is dropped and rendered nowhere.
- Evidence: live fact (4 boots); tools-lifecycle F1/F2 (`MiniAppViewer.tsx:826-847`, `packageInstaller.ts:120-151,278-283`, `pythonSetup.ts:155-163`); `packageInstaller.ts:234,329`; `backgroundBuilder.ts:41-49`.
- Proposal: keep the last ~20 stderr lines per wave and include them in the `wave failed` log line and in the FAILED row; pre-check installed distributions (`pip show`/`importlib.metadata`) so a satisfied wave is skipped and the app marked ready, ending the per-boot re-run; stop the unconditional 3 s retry; render FAILED with the real line, Retry, "Open anyway" (deps are usually needed only at Run) and "Ask me to fix it"; surface `userActionable` verbatim. Drop `r-packages.txt`/`apt-packages.txt` from the watcher's dep files (both refused anyway).
- Benefit: a stuck install has an exit, and the host stops doing silent failing work on every launch.

**08 — Read-only folders enforced; agent deletions go to a trash** (safety, M, 0 calls)
- Problem: the padlock labelled "Read only" is prose in the system prompt — and the prose tells the agent "direct edits will fail", which is false. `rm -rf` on a shared research folder runs silently; nothing is in a trash; no snapshot, no undo. CLAUDE.md itself names the PreToolUse hook as the fix. SDK checkpointing cannot cover Bash, which is where this agent does much of its work.
- Evidence: agent-capabilities §4 (`agentSession.ts:590`, `skills/acabox/SKILL.md:271-273`); onboarding §3 (no `trashItem` in `main/`); desktop-agents §17-19; anthropic-surfaces §3.2 (Cowork's universal delete confirmation).
- Proposal: a PreToolUse hook on Write/Edit/NotebookEdit and on Bash whose arguments resolve (realpath) into a read-only root → deny with a plain message the user also sees; a hook that rewrites `rm`/destructive `mv` inside shared folders into a move to `<userData>/agent-trash/<stamp>/` with a 7-day sweep and a "Restore" row in Activity; fix the guidance text so "will fail" is true; if enforcement is not done, rename the lock to "Ask before editing".
- Benefit: the one promise a non-technical user cannot verify becomes true, and a wrong `rm` is recoverable.

**09 — Reproducible runs: immutable run snapshots and a provenance footer on charts** (feature, M, 0 calls)
- Problem: a tool shows numbers with no way to see what produced them; only 3 of 14 tools were ever re-run and the one refresh path is broken; tools ship baked data. Peers (Deepnote run snapshots, GlideOS "how figures were derived", Hex "SQL one click away", Prism linked updates) treat this as the trust surface; Julius's non-reproducibility is its loudest scientific complaint.
- Evidence: production-usage §5.2; science-and-data (Deepnote 2026-04-27, GlideOS recap, Prism); tools-lifecycle §1.4 (`useAppState`, `run_metadata.json`); agent-ux G2.
- Proposal: each tool run (host job end) writes `tool-data/<dir>/runs/<stamp>/` with input file hashes, the executed command or cell source, the outputs list and environment versions (`pip list` once per run); the `@reusable`/`plotTheme` kit adds a standard footer to every chart — "from plate3.csv · 1,204 rows · run 14:02" — with "Show the code" and "Show the rows"; "data changed since this figure was made" by hash comparison; "Compare with previous run" in the viewer; a per-tool "Export for a colleague" bundle (script + inputs + outputs) for the bioinformatician down the hall.
- Benefit: a number in a paper can be traced to the file, rows and code that made it; "rerun" means byte-identical, not "ask again".

**10 — Figure and file export that works** (fix-bug, S, 0 calls)
- Problem: `OutputFileList`'s Download is a silent no-op for images (only `type === "text"` downloads); Plotly's modebar — the camera button every scientist knows — is disabled; `downloadFile` takes a string, so a tool cannot hand over a PNG or XLSX; the skill forbids adding other download buttons.
- Evidence: tools-lifecycle F6/F7 (`OutputFileList.tsx:56-65`, `plotTheme.ts:140-145`, `bridge-api.md:26`, `SKILL.md:627`); science-and-data (Prism export dialog).
- Proposal: a bridge call `saveFileCopy(relPath)` (save dialog + copy) used by `OutputFileList`; let `downloadFile` accept base64; an `ExportChartButton` in the kit (PNG at 300/600 dpi, SVG, single/double-column widths, transparent background) or a camera-only modebar in `ACABOX_CONFIG`.
- Benefit: the output of a weekly analysis can leave the tool and enter a manuscript.

**11 — A scheduler a scientist can trust** (fix-bug/feature, M, 0 calls; the runs are the cost the user chose; auto-pause saves calls)
- Problem: "Every 7 days" is `0 0 */7 * *` (fires on the 1st, 8th, 15th, 22nd, 29th, 1st); no weekday or time of day; "Daily" means midnight and never says so; a run's chat is not linked from the task though `session_id` is stored; runs default to Opus 5 at high effort with no turn or budget cap and no cost shown; nothing catches up a run missed while the Mac slept; a broken task keeps running every interval. It has 0 uses, and it is the agent's recommended answer to waiting.
- Evidence: live fact #6; secondary-tabs §5.2 (`scheduleCron.ts:26,120`, `runner.ts:30`, `scheduledTaskRepository.ts:146`); agent-capabilities §7; anthropic-surfaces §4.9 ("green status ≠ task success", missed-run catch-up); long-tail #12 and science (pause after N failures).
- Proposal: true weekly/daily cron with a time-of-day picker ("Every Monday at 08:00"); "Open result" on each run; per-task model/effort picker (no silent default change) and `maxBudgetUsd`; per-run cost on rows (04); auto-pause after 3 consecutive failures with a Needs-attention row; `powerSaveBlocker` during a run and one catch-up run for the most recently missed time; the row summary is the run's final assistant text, not just "Finished". Reword "whether or not Acabox is on screen" to "while Acabox is running".
- Depends on: 04 for the cost line.

**12 — Fallbacks, refusals, API retries and spend limits shown honestly** (fix-bug, S, 0 calls)
- Problem: 23 `fallback` blocks in 6 chats — an Opus 5.5 chat silently answered by Opus 4.8 or Opus 5 while the header said Opus 5.5; the renderer keeps only `text`/`tool_use` blocks. Two "Opus 5.5 can't help with this. Start a new session" dead ends; a CLI-flavoured 400 shown verbatim; `api_retry`/`rate_limit_event`/`permission_denied` ignored so a retry window reads as THINKING…; Anthropic's spend-limit 429/400 shapes would surface as raw errors.
- Evidence: production-usage §3.1; chat-experience §4; `historyMessageConverter.ts:179`; desktop-agents §16 (error shapes).
- Proposal: a `fallback` case live and in history → muted line "Answered by Opus 4.8 after a safety check" and the pin chip reflects it; a refusal → "Chat paused — start a new chat from here" card carrying the last N messages (1 turn only when clicked, which the user would start anyway); `api_retry` → "Anthropic is busy — retrying (2 of 10)"; spend-limit shapes → plain message with a Console link and scheduled tasks paused (never backfilled); `result.is_error` rendered as an error strip, not prose.
- Benefit: quality changes stop being silent; a stuck or paused chat says why.

**13 — Finish the recorded notification design; add "while you were away"** (feature, S, 0 calls)
- Problem: a 40-minute turn finishing while the user is elsewhere produces only an unread dot, unless the agent remembers to call the toast tool. CLAUDE.md already holds the design (unit = the wait; tiered by where the user is; only >30 s or failed; never for installs).
- Evidence: CLAUDE.md deferred design; chat-experience §10.16; desktop-agents #11; agent-ux J1/A5.
- Proposal: main fires an OS notification when a turn or tool job longer than 30 s ends or fails while Acabox is unfocused (`chatActivity` already knows focus), deep-linking to the chat; a red "needs you" state in the rail and Activity once 06 exists; a Home line composed deterministically from the job registry and unread chats ("While you were away: 2 tools finished, 1 build failed, 3 chats replied").
- Benefit: long analyses can be left alone.

**14 — Error reports a scientist can read, one at a time** (ux, S, 0 calls — one turn instead of three)
- Problem: the UI composes stack traces into the user's own bubble ("An error occurred in mini-app `x`… **Stack trace:**"), three times in three seconds; 27 "No Redshift credentials… write them to …/input/redshift.json" and 8 "Hex 403 — not granted access" failures were addressed to nobody; six chat titles are the error.
- Evidence: production-usage §5.3, §3.3; copy-audit #71-72; tools-lifecycle §1.6.
- Proposal: dedupe to one report per 10 s per tool; send a short user line ("Something went wrong in X — please fix or explain it") with the technical report as a collapsed quote block; when the error is a missing grant or credential, lead with "what you can do" and link the tool's Settings checkbox; the agent reads build output from `tool-build-health.json` itself.
- Benefit: fewer wasted turns and fewer chats titled by their failures.

**15 — Sharing with a colleague: safe defaults and a visible publish state** (safety/ux, M, 0 calls; the pre-publish fix is 1 turn only if clicked)
- Problem: publishing is the observed unit of value (7 of 13 tools, within minutes) — and every publish uploaded input data because "Include input data" defaults on; one shared `PUBLISH_TOKEN` lets any publisher replace or delete anyone's artifact; the Settings hint points at `src/share-workers/README.md`; the shared viewer carries no provenance line.
- Evidence: production-usage §5.1/§9; tools-lifecycle F5/F10/F11 (`SharePublishDialog.tsx:66-67`, `docs/design/sharing.md` hazards); copy-audit #126; openai-google (Sites' version-then-deploy, audience picker).
- Proposal: default "Include input data" off with the size shown; per-user publish tokens on the api Worker (token → owner; DELETE/PUT scoped to the owner's artifacts); publish state on the card and header ("Shared · updated 2d ago", "Update share" when BEHIND); a provenance line on the viewer ("built with Claude in Acabox · data as of <date>"); a pre-publish scan of the bundle for key-shaped strings, home paths and `tool-data` references with "Share anyway" or "Ask me to fix" (1 turn); Settings copy without a repo path.
- Benefit: sharing clinical or unpublished data becomes a choice, not a default, and a colleague's copy says what it is.

**16 — Dates: Home relative times and Chats row dates** (fix-bug, S, 0 calls)
- Problem: Home "Jump back in" parses SQLite's zone-less `updated_at` as local time, so every chat updated in the last 7 h reads NOW west of UTC and a 2-day-6-hour-old chat reads "1D"; `dateFromSessionStoredAt` already exists and the tool side panel uses it. Chats rows show `createdAt` while the list is sorted by activity.
- Evidence: live fact; shell-home §5.1 (`CommandDesk.tsx:171`, `sessionTimestamps.ts:3-15`, `ToolWorkspace.tsx:312`); chat-experience §5 (`thread-list.tsx:238,318-320`).
- Proposal: use `dateFromSessionStoredAt` wherever `updated_at`/`created_at` is parsed bare; show last activity on Chats rows.
- Benefit: a weekly user finds last week's chat by its real age.

**17 — Attachment rejection is visible; shared-folder files are referenced, not copied** (fix-bug, S, 0 calls)
- Problem: a 32.6 MB file against the 30 MB cap throws inside the adapter and every caller swallows it; the user asked "how many did I attach?", the agent spent 4 + 35 minutes, Stop erased the work. Files dragged from an already-shared folder are copied into the workspace root because the symlinked path never matches.
- Evidence: production-usage §8.5/§10.5; chat-experience §3 bugs 1–2 (`attachmentAdapter.ts:204-208,221-229`, `fileHandlers.ts:280-305`).
- Proposal: a composer notice per rejected file with the reason and "put it in one of your folders and I'll read it there"; resolve native paths against the shared-dir list (realpath) before deciding to copy; copy strangers into `attachments/`, not the root.
- Benefit: no silent third attachment, no duplicated gigabytes.

**18 — Debug leaves the rail; Hard Reset tells the truth about tool-data** (safety, S, 0 calls)
- Problem: a developer console with Telemetry crash buttons and "Yes, Delete Everything" is one click from the main nav for every user; the Hard Reset list names two dead features (briefings, calendar) and omits `tool-data/` — the saved outputs the app promised survive tool deletion — which it wipes.
- Evidence: live fact; shell-home §3; secondary-tabs §7 (`HardResetDebug.tsx:63-79`, `ipc/debug.ts:577-580`); onboarding #14.
- Proposal: remove Debug from the rail in packaged builds (Settings → Advanced → Diagnostics); keep "Save support bundle" and "Back up / restore my workspace" as user-facing items; Hard Reset lists what it deletes, including saved tool data, and requires a typed confirmation; remove the crash buttons and Podman rows from production.
- Benefit: three months of saved results cannot vanish from a mis-click in a tab nobody needed.

**19 — Trusting a number: assumptions checklist, Computed-vs-Interpretation footer, "Check this number"** (feature, M, 0 calls for the first two; 1 turn per click for the third, user-initiated and labelled)
- Problem: a wrong number in a paper is this audience's costliest failure. Julius reviews document wrong p-values and parametric tests on non-normal data; Kosmos's own grading shows 85% accuracy on computed statements vs 58% on synthesised conclusions; Prism — the non-AI bar — attaches an assumptions checklist to every inferential result and reports effect sizes with CIs by default. Acabox has none of these and (correctly) no numeric confidence.
- Evidence: science-and-data §1, §8, §11 and priority view #3-4; agent-ux G1/G3/G4; NN/G "AI chatbots discourage error checking".
- Proposal: a shared `@reusable/statsChecks.py` (normality, variance homogeneity, n per group, paired/unpaired, effect size + CI) whose output a tool renders as a checklist beside any test, with the skill instructing the agent to call it; a workspace CLAUDE.md rule that analysis replies end with "Computed from your data / Interpretation / Could not do" lines naming the file or command each rests on, rendered as a small card; a "Check this" item on the existing selection toolbar that composes "re-derive this value from the source file by a different method and report whether it matches" (1 turn, shown as such). No percentages anywhere.
- Benefit: the trust surface becomes a picture and a checklist, not a p-value in prose.

**20 — Authored skills and review items surfaced; the roster right-sized** (ux/cost, M, 0 calls; negative on every turn)
- Problem: six skills Claude wrote for this user sit disabled and unreviewed on a page the user never visits, with 37 findings files inside; ten "Needs attention" review items (three of them identical, per the live walkthrough) are unseen; seventeen shipped skills were never invoked or read in nine weeks yet sit in the always-in-context listing (the budget was raised to 5% because it overflowed). The knowledge loop itself works (134 findings).
- Evidence: production-usage §6/§10.11; live fact (three identical cards); CLAUDE.md skills entry.
- Proposal: "Awaiting your OK" skills and review items on Home/Activity Needs-attention with one-line plain descriptions; dedupe identical review cards; a per-workspace roster that hides shipped skills never used here behind "More skills" (smaller listing = fewer tokens on every turn); retire `differential-expression` (see removals) and fix the `acabox` skill's R/DESeq2/activity-summary claims.
- Benefit: the knowledge a scientist accumulates over months becomes visible and usable; every turn gets cheaper.

### P2

**21 — Polling tools must not flood the host** (fix-bug, M, 0 calls)
- Problem: one tool's 5-second `exec` poll produced 2,737 shell spawns in two days, filled `tool-jobs.json` to its 300-entry cap, evicted every other tool's job history (which "RAN WHILE CLOSED" depends on), and filled Activity's "Recently finished". The host has a Rust file monitor but the bridge exposes no change events, so the vibecoded tool polls.
- Evidence: production-usage §5.4/§10.9 (`notes/src/App.tsx:41`, `jobRegistry.ts:70`).
- Proposal: collapse identical sub-second jobs per tool and cap per-tool entries in the registry; expose `hostAPI.watch(path)` from the existing monitor; a skill rule against polling faster than 30 s.

**22 — Half-built tools: resume or clear** (ux, S, 0 calls — the resumed turn is one the user asks for)
- Problem: `dataBrokerOptOuts` has `creation_pending: true` and no `App.tsx` since Sep 28 and shows BEING WRITTEN forever; two zero-message tool chats exist.
- Evidence: production-usage §5.1/§10.16.
- Proposal: a BEING WRITTEN card older than ~10 minutes offers "Resume building" (opens its chat with a prefilled message) and "Remove"; stale pending tools appear under Needs attention.

**23 — Inline images and plots in replies** (feature, S, 0 calls)
- Problem: `![plot](output/plot.png)` does not render (no `img` override), so a quick analysis answer forces a file-viewer detour or a whole tool build; sent images are not viewable in history.
- Evidence: chat-experience §7 and §10.9-10 (`markdown-text.tsx:197-264`, CSP already allows `local-file:`).
- Proposal: an `img` override mapping workspace-relative `src` to `local-file://` with a lightbox; persist a small thumbnail for sent images.

**24 — Per-tool instructions that travel with the tool** (feature, S, 0 calls)
- Problem: instructions are global (`SOUL.md`); a tool's conventions must be re-explained in each of its chats (one tool has eight).
- Evidence: openai-google #13; science (Colab notebook-level instructions); desktop-agents #13.
- Proposal: `.applications/<dir>/INSTRUCTIONS.md`, editable from the tool's Settings panel, injected into that tool's chats and included in export.

**25 — Queue a follow-up while a turn runs; pause-and-steer** (feature, M, 0 extra calls — messages the user would send anyway)
- Problem: during a 40-minute turn the user cannot ask a side question or add a correction without Stop, which (until 01) throws the work away. CLAUDE.md records that a second message into a live session is answered.
- Evidence: production-usage §8.6; chat-experience §2; vibecoding-mainstream §5.8 (Lovable follow-ups, Bolt queue).
- Proposal: allow Send during a turn; deliver into the live session and show a small queue under the composer; "Pause, add a note, continue" instead of only Stop.

## 3. Removals (simplify rule: delete, do not disable)

- The Reactions system task and everything behind it: `main/ipc/reactions.ts`, the boot re-enable (`main/index.ts:1262-1266`), the `activity-summary` and `reaction` skills, `ReactionsToolView`, `ReactionsSidebar`, the `reaction` relay. A dormant 96-turns-per-day loop no UI can enable, whose Pause is undone at boot and whose Delete is refused.
- `differential-expression` skill and the `differentialExpression` template (R kernel; self-declared unrunnable; copied into every workspace on boot), plus the `acabox` skill's claims of R, R kernels, DESeq2 and daily activity summaries.
- `src/utils/processCpuMonitor.ts` and its start at `main/index.ts:910` (Podman-era VM watchdog; ~140 false warnings in five days).
- The `writing_agent` briefing step of the scan (one Haiku call per manuscript into a table nothing renders) and the Word-overlay call sites (`.docx` click launches Word; `setDockRightForDocument` is not exposed by preload).
- Dead renderer verticals: `components/calendar/*` (8,266 lines) with `main/calendarAgentSession.ts`, `main/ipc/calendar.ts` (31 IPC handlers) and `calendarRepository.ts`; `HomePage.tsx` + `BriefingHistory.tsx`; `PaperMonitorView` branch; `FocusEditor.tsx`; `ContainerTests.tsx/.css`; `MiniAppsTab.tsx`; `WritingAgentView.css` and the HTML-reply path; `grant-finder-entry.tsx` + `prebuilt-apps/grantFinder/`; `OverlayNavigationHandler`; `SetupBanner` Podman stages and the `setupStore` 'downloading' state; `StorageDebug` Podman rows; `tool-labels.ts:92-160` dropped-integration labels; `approval-buttons.tsx`; `tool-write.tsx`; `latex.d.ts`; the unused `main/mcpServers/notificationMcpServer.ts` and `reactionMcpServer.ts`.
- Quick Chat (`quickChat.ts`, the window, preload, `QuickChatInjector`, the `Alt+Shift+A` global shortcut that hijacks typing Å system-wide).
- The `preBuilt`/`nativeTools:getUrl` path and the `PRE-BUILT` and `ON-DEMAND` tags.
- The fabricated `SYNCED` word and the permanent `AGENTS 0 LIVE` segment (no mocks in prod: real values or hide).
- `r-packages.txt` / `apt-packages.txt` from `backgroundBuilder`'s dep files (both are refused by the installer).
- Debug from the rail in packaged builds (moved under Settings → Advanced, see 18); Telemetry crash buttons from production.

## 4. Deliberately left out of the 25, and why

- **First-run items** — the Node.js prerequisite for the first build, the launch-time `python3` probe popping the Command Line Tools dialog, the Gatekeeper copy, the API-key card and validation, the privacy statement. All real and high for a new user; they belong to the first-run lens. A month-three user has passed them, and a colleague who opens a shared tool needs no install (read-only snapshot in the browser).
- **The copy and naming sweep** (Claude vs Acabox vs "CS:", "paste a repo", "scaffolds", Servers/Connectors/APIs taxonomy, status bar telemetry). Important and zero-cost, but polish relative to recoverability; covered exhaustively by the copy audit and the shell lens.
- **`AskUserQuestion` / `canUseTool` relay** (L). Confirmed absent by the live test. Prose questions work today (39 turns ended with a question; 35 were answered). Deterministic hooks (08) give the safety value without the relay; revisit after 06.
- **Element-targeted pointing inside a tool** (M). A genuine accelerator for iteration, but the user already points with quotes (51 messages) and screenshots (31); restore (03) and crash visibility (02) matter more.
- **Dictation cleanup** (S) — strip fillers client-side, editable transcript before send. Small; P2 if there is room.
- **A credential home for non-HTTP sources (Redshift DSN)** (L). The 27 `redshift.json` failures are one user's data source; the HTTP registry already covers the scientific catalog. Revisit if a second non-HTTP source appears.
- **Memory UI.** Memory works (28 files, loaded every turn) and the field is simplifying memory UIs (Dia retired it). Per-tool instructions (24) are the better investment.
- **Starter gallery / example prompts.** First-run again; the month-three user has tools.
- **Window/tab state persistence, ⌘K palette, New-chat button.** Shell conveniences; the ⌘K fix (focus the search input) is a one-liner worth taking opportunistically.

## 5. Do not build (ideas from the reports, rejected with reasons)

1. **Keep-alive sessions so the agent's own pollers run.** The owner's recorded decision; unattended model turns on a timer are the one open-ended bill. 06 gives the same outcome with zero calls while waiting.
2. **Remove the Jupyter kernel gateway and the per-tool notebook scaffold** (production-usage idea 7). The kernel path is dead in production, but `useAppState` documents `notebook.ipynb` as the tool's durable state store, and the gateway is already spawned only on first use. Removing the notebook breaks every tool's persistence; at most, stop installing `jupyter_kernel_gateway`/`ipykernel` eagerly — after measuring what the eager bootstrap costs.
3. **Automatic or "one bounded" auto-retry on build or runtime failure; autonomous QA ("Verify this tool"); browser self-testing.** 1+ model turns per failure, open-ended across tools; the agent already fixes build errors inside the turn; fixes stay user-initiated and labelled with their cost.
4. **Plan-approval gate, editable plan files, three design directions before a build.** +1 turn per build; approved plans still produce wrong code (byteiota/Nadeem post-mortem); this audience cannot evaluate plan text. The reviewable artifact is the running tool and the result — invest in 02, 03, 09.
5. **Per-action approval prompts or an autonomy dial as the default safety control.** 93% of prompts are approved (Anthropic 2026); non-experts do not maintain policies (Yan 2026). Deterministic hooks and a trash (08) with a few always-ask categories instead.
6. **An automatic reviewer after every turn** (Claude Science style). 1 call per turn; the same model checking itself. Offer only the button-only "Check this number" (19), priced on the button.
7. **Session recaps, next-prompt suggestions, Haiku-written row summaries, timer-based suggestion scans.** Recurring model calls; CLAUDE.md already removed one such scan (≤$5/hour).
8. **Numeric confidence scores on results.** They raise agreement with wrong answers too (Whitmore 2026; Li 2025).
9. **Cloud routines, Dispatch, mobile remote control, computer use, an in-app browser, a separate deep-research mode.** Infrastructure a private local app does not have, or decisions CLAUDE.md records as deliberate.
10. **Subscription (BYOS) sign-in.** Forbidden by Anthropic's third-party OAuth policy (API keys only for Agent SDK products).
11. **On-device Apple Foundation Models for titles or previews.** Violates Claude-only.
12. **Credit systems and "free fix" allowances.** Acabox bills nothing itself; the honest analog is cost visibility (04) and the fix-loop guard (03).
13. **Building the same message on two models and picking one.** 2× cost.
14. **Silently routing small edits to a cheaper model.** "Quality roulette" (Nielsen 2026). A visible per-message "Quick edit (Haiku)" chip would be acceptable; a silent router is not, and the default model stays pinned as recorded.

## 6. What the reports disagree on (and how it was settled)

1. **Does the SDK result carry cost?** production-usage: "`total_cost_usd` is not written by this SDK build" (true of the CLI's transcript files it mined). anthropic-surfaces, openai-google and the live walkthrough: every result carries it. Settled in code: `sdk.d.ts:5456-5466` defines `total_cost_usd`/`modelUsage` on the result message and `agent-server/index.ts:702` forwards the whole message; the host drops it at `agentSession.ts:1328`. Nuance for implementation: the value is cumulative per `query()` call, so per-turn cost is a delta.
2. **Are unlisted tools (AskUserQuestion) denied or run?** chat-experience and agent-capabilities leave it open (SDK doc vs CLAUDE.md's `allowedTools: []` measurement). The live test settles it: the tool is absent from the toolset; the agent says it has no such tool. Nothing stalls; nothing asks.
3. **Jupyter: remove it?** production-usage says remove the gateway and the scaffold (0 executeCode, 0 kernel spawns). tools-lifecycle describes kernel runs as the kit's run path, and `useAppState` documents the notebook as the state store. Resolution: the kernel is dead weight in practice, the notebook file is load-bearing; remove neither wholesale.
4. **What the HEALTHY chip lies about.** shell-home: it reads HEALTHY regardless (`startedFlag` set unconditionally). copy-audit: it reads STARTING forever when `running` is false. Both agree it does not measure agent health; the fix (drive it from `isAgentServerHealthy()`, add OFFLINE) is the same.
5. **How to fix Stop.** chat-experience: soft `interrupt()` and keep the session. production-usage: write a `stopped` result row. Both are needed — interrupt to stop the grace-period reply, the row to survive the sweep (01).
6. **Scheduler: hazard or answer?** agent-capabilities frames scheduled runs as an unbounded Opus 5 cost hazard; production-usage frames the scheduler as the unused answer to waiting; secondary-tabs documents the cron bug. Compatible: bound it and fix it (11) before promoting it, and prefer deterministic waits (06).
7. **Sharing: operator-hosted or self-hosted?** tools-lifecycle asks; production shows operator-hosted use (7 publishes to share.acabox.us) — so per-user tokens and the input-data default (15) are what matter, not the self-host README.
8. **Memory UI.** agent-capabilities and anthropic-surfaces propose memory visibility; desktop-agents says do not invest (Dia retired memory; Claude simplified it). For this lens, desktop-agents wins; per-tool instructions (24) are the cheaper, more useful container.
9. **Approval surface.** Several landscape reports recommend permission modes or dials; agent-ux and the Anthropic containment paper argue for deterministic boundaries for non-technical users. The synthesis follows the latter (08), keeping prompts for a tiny set of irreversible actions.
10. **Stale CLAUDE.md guidance** flagged by production-usage: "not verified whether the model volunteers `record_finding`" — 134 calls say it does. Update the file.

## 7. Suggested order

Week 1 (P0, all S/M, zero calls): 01 Stop, 05 Files trash, 04 cost, 16 dates alongside; then 02 crash visibility and 03 history, which together close "it worked yesterday".
Weeks 2–4 (P1): 07 install state, 10 export, 12 honest states, 13 notifications, 14 readable errors, 17 attachments, 18 Debug/Hard Reset, 08 hooks and trash, 15 sharing defaults, 09 run snapshots, 19 stats checklist, 11 scheduler, 20 skills.
Then 06 wait-for (L), with 13 in place to deliver its one notification.
Removals (§3) can be interleaved; each is independent and reduces surface the P1 items would otherwise have to style or document.
