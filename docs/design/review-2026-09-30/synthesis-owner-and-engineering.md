# Acabox review — synthesis through the owner's lens

Lens: the product owner who maintains this codebase with Claude-written, Sonnet-sized tickets. Everything below is judged by the four rules (no mocks in prod; cost vs UX with model calls stated per use; simplify by removing; Claude-only), by the decisions the root CLAUDE.md records as deliberate, and by what the Agent SDK already gives for free. Date: 2026-09-30.

## 0. What was read and what was checked

All sixteen reports were read in full (839 KB, not the ~450 KB estimated; six exceeded the reader's page cap and were read in two pages each). None was missing or truncated: live-walkthrough, shell-home-navigation, chat-experience, tools-lifecycle, secondary-tabs-settings, agent-capabilities, onboarding-setup-errors-updates, production-usage, copy-jargon-audit, anthropic-surfaces, openai-google-surfaces, vibecoding-mainstream, vibecoding-long-tail-and-pro, science-and-data-assistants, desktop-agents-local-files, agent-ux-patterns.

Where reports disagreed or made load-bearing claims about the SDK, I checked the repo read-only (nothing run):

- `@anthropic-ai/claude-agent-sdk` is 0.3.280. `sdk.d.ts` exposes `canUseTool?` (:1521), `enableFileCheckpointing` (:1625) + `Query.rewindFiles()` (:2974), `maxBudgetUsd` (:1870), `Query.interrupt()` (:2713), and `total_cost_usd` on every result message (:5456), documented as "cumulative across turns in streaming-input sessions — each result carries the running total so far, so read the latest result rather than summing… An estimate, not a billing statement." `AskUserQuestionInput` is defined (`sdk-tools.d.ts:1102`).
- The app references none of these: `grep total_cost_usd src/cobuilding` → nothing; `canUseTool`/`permissionMode` appear only in comments. `agentSession.ts:1328-1332` persists exactly `subtype`, `result`, `is_error`. The agent server only ever calls `queryInstance.close()` (`agent-server/index.ts:709, 802, 1179, 1214`), never `interrupt()`.
- `shared/agentAllowedTools.ts:12-16` still says "an unlisted tool still runs — it just falls to the default permission path". Production data (6 "Claude requested permissions… but you haven't granted it yet" prompts, NotebookEdit 5/5 failures, AskUserQuestion 1/1 failure) and today's live test say the opposite on 0.3.280: unlisted tools are denied. `NotebookEdit` is not in the allowlist (grep exit 1).
- `cleanupOrphanTurnRows` runs at `agentSession.ts:488` on the next message (`db/chatRepository.ts:329`); nothing on `chat:stop` (`main/index.ts:2397`) writes a result row.
- `processCpuMonitor.start()` at `main/index.ts:910` (Podman-era VM watchdog); Reactions boot re-enable at `main/index.ts:1263-1265`; rail `SYNCED` literal at `Rail.tsx:205`; eager `ensurePythonVenv()` at `AgentInfrastructureController.ts:550`; Home uses `relTimeShort(chat.updated_at)` at `CommandDesk.tsx:171` while `dateFromSessionStoredAt` exists at `renderer/sessionTimestamps.ts:8`; the scaffold dispatches `cobuild-error` at `manage_mini_app.mjs:209`.

The live facts supplied with the task are treated as ground truth and override any report that says otherwise.

## 1. Executive summary — five things the owner should know

1. **The product is throwing away free safety and trust data the SDK already hands it.** Cost (`total_cost_usd`), a soft stop (`interrupt()`), structured questions (`AskUserQuestion` via `canUseTool`), file rewind (`enableFileCheckpointing`) and a per-turn budget (`maxBudgetUsd`) are all in the bundled SDK and none is wired. Roughly $2,750 of the owner's own spend in nine weeks (production-usage §2) was invisible inside the app, with 40 of the last 73 sessions at `max` effort — the cost rule cannot be honoured by users who cannot see cost.
2. **Three live defects break trust in exactly the way a non-technical user cannot diagnose:** Stop deletes the partial turn from the database at the next message (237 rows on Sep 30); a crashed tool renders a blank pane marked IDLE; the Files tab deletes a research folder permanently on one click with no confirmation and no Trash. All three are zero-model-call fixes.
3. **The agent runs at the equivalent of "Skip all approvals" with advisory read-only folders, while the UI shows a padlock and the agent is told "direct edits will fail".** Anthropic's own containment guidance says non-technical users need deterministic boundaries, not prompts. One PreToolUse hook plus one confirm class (permanent delete) covers it.
4. **A large share of what a scientist meets on screen is leftover or developer-only:** Debug in the rail, a fabricated `SYNCED`, `AGENTS 0 LIVE`, CPU/MEM/DISK, a Servers tab, a Knowledge page of frontmatter and byte sizes, a dormant 96-turns-a-day Reactions task with a boot re-enable and no off switch, ~11,000 lines of unreachable calendar/briefing/overlay UI, Podman strings, and a `CS:` prefix from the abandoned upstream brand. The simplify rule says delete, and most of it is mechanical.
5. **Sequencing matters more than scope.** A week of S-sized truth fixes (increment 0) and three trust fixes (increment 1) change the product's honesty before any new capability; the permission relay (increment 3) is the one foundation several later items depend on.

## 2. Rules applied, and recorded decisions honoured

- Every recommendation states model calls per use. Twenty-three of twenty-five are zero-marginal-cost; the two that cost a call do so only when the user clicks a button that replaces a turn they would otherwise type by hand.
- Deliberate CLAUDE.md decisions kept: no in-app browser; no keep-alive sessions for pollers; default model pinned; onboarding flow removed (a first-run nudge is proposed, not a flow); tool output excluded from search; the hourly suggestion scan stays removed; jump-to-message not built.
- Where a report's idea conflicts with a rule or a recorded decision, it is in §6 (do not build) with the reason.

## 3. Ranked recommendations with reasoning

Severity is for a non-technical scientist; priority is the owner's sequencing. Effort is Sonnet-ticket sized: S = one ticket, M = two or three, L = a small plan.

### P0 — fix before anything else (increment 0 and 1)

**owner-and-engineering-01 — Stop keeps the record (soft stop).**
Problem: Stop destroys the session; no result row is written; `cleanupOrphanTurnRows` deletes every assistant/tool row after the last result at the next message. The user's bubble stays with no reply and no "Stopped" marker; files the agent wrote are on disk with nothing in the chat saying so. During the SIGTERM grace the model also produced a hallucinated explanation ("the sandbox blocks long sleep commands") rendered as a finished turn.
Evidence: live fact #1 (4 rows cleaned; shots 47–49); production-usage §4.2 (237 and 27 rows deleted; 3 Stops in 5 days); chat-experience §2 (`agentSession.ts:1008-1025`, `agent-server/index.ts:1171-1190`, `chatRepository.ts:329-345`); `sdk.d.ts:2713`.
Proposal, two rungs: (a) S — on `chat:stop`, before destroy, insert a result row `{subtype:'stopped', is_error:false}` for the current messageId so the sweep keeps the partial rows; render "Stopped by you · N steps" (Activity already uses that wording). (b) M — add `POST /sessions/:id/interrupt` → `queryInstance.interrupt()` and use it for a user Stop instead of `/stop`; the session survives for the next message and the CLI ends the turn itself. Measure what result subtype interrupt produces and whether the model still emits a trailing line; if it does, the host-authored row wins.
Benefit: nothing the user watched vanishes; no invented reason is shown; the next message does not cost a cold session.
Model calls per use: 0. Effort: M (rung a alone is S). Category: fix-bug. Depends on: nothing.

**owner-and-engineering-02 — Show real cost: per turn, per chat, month to date.**
Problem: the SDK result carries `total_cost_usd`, `usage` and `modelUsage`; the app persists only subtype/result/is_error. The user pays per token on their own key and sees nothing; 55% of recent sessions run at max effort; single chats cost $100–160.
Evidence: live fact #3 (`agentSession.ts:1328-1332`; grep → no hits); production-usage §2 (≈$2,750, sub-agents 26%); `sdk.d.ts:5456`; anthropic-surfaces §1.3 (cost opacity is the loudest complaint across every Anthropic surface); vibecoding-mainstream §5.1 (cost is the #1 complaint on every platform).
Proposal: store `total_cost_usd` and `modelUsage` on each result row (migration adds two nullable columns). Semantics to settle on the first live run: the value is cumulative per `query()` call and "continues from the total its transcript saved, when it has one"; Acabox runs one query per turn, so each result is normally that turn's cost, but if a resumed chat's first result already carries earlier turns, per-turn = delta from the previous result row. Show "$0.14 · 26 steps" on the fold line, "$3.40 this chat" in the chat header meta, and a month-to-date figure in Settings → Account. Label every figure "estimate at list price", as the SDK itself does — a real number with an honest caveat, not a mock. Follow-on (same ticket or next): `maxBudgetUsd` per turn from a user-set soft cap; it "counts only the spend since this query() call started", which matches one-query-per-turn exactly.
Benefit: the only surface in this product family that shows nothing becomes the one that shows the real bill; max-effort becomes a visible choice.
Model calls per use: 0. Effort: S (store + three displays; a per-model Usage page is a later M). Category: cost. Depends on: nothing.

**owner-and-engineering-03 — A crashed tool never reads IDLE; dedupe React at build.**
Problem: a render-time exception leaves a blank white pane; the scaffold's ErrorBoundary renders `null` and dispatches `cobuild-error` before `ErrorDisplay` has subscribed (it subscribes in `useEffect`); the host tracks build errors only, so the chip says IDLE; nothing offers a fix. The dev cause (two React copies bundled from nested `lucide-react/node_modules/react` and `react-plotly.js/node_modules/react`) is dev-only, but the failure mode is general — production users forwarded 15 stack traces by hand.
Evidence: live fact #1 and #4; tools-lifecycle F8 (`manage_mini_app.mjs:220-222`), F9 (`MiniAppViewer.tsx:1137-1143`); production-usage §5.3 (15 error reports, "React has detected a change in the order of Hooks").
Proposal: (1) scaffold's boundary renders a visible crash card ("This tool crashed. Ask me to fix it.") and posts `{type:'runtimeError'}` to the host through the existing bridge; (2) `MiniAppViewer` adds a `CRASHED` chip and reuses Activity's "Ask Claude to fix it" composer (expanding a collapsed panel, which the in-frame Fix button currently fails to do); (3) `miniAppBuilder` passes `--alias:react=<npm-site>/react --alias:react-dom=<npm-site>/react-dom` so a nested copy can never be bundled twice; (4) dedupe error bursts (one report per 10 s). Hook the chip into `buildHealth` so Home shows it with no viewer mounted.
Benefit: a broken tool says so and offers the one action a scientist has.
Model calls per use: 0 to display; 1 user-initiated turn when "fix" is clicked (replaces today's hand-forwarded stack trace). Effort: M. Category: fix-bug. Depends on: nothing.

**owner-and-engineering-04 — Files tab delete goes to Trash with a confirm.**
Problem: the row trash icon and the context-menu Delete call `fsPromises.rm(resolved, {recursive:true})` on paths inside the user's real research folders, with no dialog and no Trash. Removing a folder from the workspace list does confirm; skills go to a 30-day trash; user files do not.
Evidence: live fact #5 (`FilesTab.tsx:368-371, 449-451` → `fileHandlers.ts:323`); secondary-tabs §2.3(1) (`FilesTab.tsx:925-930, 406-412`; `fileHandlers.ts:320-324`); onboarding §3.
Proposal: `shell.trashItem` instead of `rm`; the same confirm pattern Settings uses; copy names the item and says it goes to the Trash.
Benefit: a mis-hit while reaching for Rename is recoverable.
Model calls per use: 0. Effort: S. Category: safety. Depends on: nothing.

**owner-and-engineering-05 — Debug leaves the rail; diagnostics behind Settings → Advanced.**
Problem: a developer console (Logs, Kernels, Observations, Telemetry crash buttons, Hard Reset "Yes, Delete Everything") sits in primary navigation for every user; the Hard Reset list names two dead features and omits `tool-data/`, which it wipes.
Evidence: live fact (Debug tab for everyone); shell §3 (`Rail.tsx:99-101,208-211`, `HardResetDebug.tsx:66-79`); secondary-tabs §7 (`TelemetryDebug.tsx:151-183`; `ipc/debug.ts:577-579`); onboarding §2.2.
Proposal: remove the rail entry; Settings → Advanced gets "Save support bundle (logs)" and "Back up / restore workspace" (the two user-facing things buried there); Hard Reset behind a typed confirmation with a truthful list including saved tool data; drop the Telemetry test-throw buttons and the Podman rows in `StorageDebug` from packaged builds.
Benefit: the single most dangerous surface for the audience is no longer one click away.
Model calls per use: 0. Effort: S. Category: remove. Depends on: nothing.

**owner-and-engineering-06 — Shell indicators tell the truth.**
Problem: rail footer `~/workspace-data SYNCED` is a hard-coded word over a path that does not exist; chrome `HEALTHY` is `startedFlag`, set unconditionally by `ensureSetup()` and never cleared when the agent server's restart budget is exhausted; `AGENTS 0 LIVE` is permanent noise; CPU/MEM/DISK/UP are whole-machine telemetry.
Evidence: live fact (`Rail.tsx:205`); shell §5.2 (`ChromeBar.tsx:9`, `containerService.ts:299-301, 542-545, 1077-1080`), §4; copy-audit #1, #6, #8, #9, #11.
Proposal: delete `SYNCED` and the tilde path (show nothing, or the real shared-folder names); drive the chrome indicator from `isAgentServerHealthy()` with three states (STARTING / READY / OFFLINE with a Restart action); render the agents segment only when n>0 as "N CHATS WORKING"; move CPU/MEM/DISK/UP into the diagnostics page.
Benefit: the only green light on screen means what it says.
Model calls per use: 0. Effort: S. Category: fix-bug. Depends on: nothing.

**owner-and-engineering-07 — Small truths: ⌘K, Home times, Chats dates, the `_reusable` chip.**
Problem: ⌘K and the Home search box only switch to the Chats tab without focusing the search input; "Jump back in" times are wrong by the UTC offset (`relTimeShort(chat.updated_at)` parses a bare SQLite timestamp as local time; the fix `dateFromSessionStoredAt` already exists and the tool panel uses it); the Chats row shows `createdAt` while the list sorts by activity; `backfillAllAppChatLinks` enumerates every non-dot directory so `_reusable` is linked as a tool.
Evidence: live facts (⌘K; "1D" for a 2-day-6-hour-old chat); shell §5.1/§5.3 (`CommandDesk.tsx:88, 171`; `renderer/sessionTimestamps.ts:3-15`); chat §5; production-usage §10.14 (`main/index.ts:1943`).
Proposal: make the header box a real input that focuses the Chats search (or drop the keycap); use `dateFromSessionStoredAt` at `CommandDesk.tsx:171` and anywhere else `updated_at`/`created_at` is parsed bare; show last activity on Chats rows; skip `_`-prefixed and manifest-less dirs in the backfill.
Benefit: four visible lies removed in one afternoon.
Model calls per use: 0. Effort: S. Category: fix-bug. Depends on: nothing.

**owner-and-engineering-08 — Delete the Reactions system task.**
Problem: `ensureReactionsTask` seeds "Reactions — every 15 minutes" (96 Opus-5 high-effort agent turns a day, each running WebSearch) when a settings flag no renderer can set any more; boot force-re-enables it (`main/index.ts:1263-1265`), Pause is undone at next start, Delete is refused ("System tasks cannot be deleted"), and the only screen about it says "Enable in Settings → Reactions", a section that does not exist. Armed for any legacy install.
Evidence: secondary-tabs §5.3; agent-capabilities §0.6/§7; the grep above.
Proposal: delete `main/ipc/reactions.ts`, the boot block, the `reaction` relay, the `activity-summary` and `reaction` skills, `ReactionsToolView`/`ReactionsSidebar`, and migrate any existing `reactions-system` row to deleted. Also delete the dead duplicate `main/mcpServers/{notification,reaction}McpServer.ts`.
Benefit: an unbounded, unreachable spend loop is gone; ~900 lines less.
Model calls per use: 0 (removes up to 96/day on legacy installs). Effort: S. Category: remove. Depends on: nothing.

### P1 — next (increments 2–5)

**owner-and-engineering-09 — Never fold the final answer; list the files a turn changed.**
Problem: `finalAnswerStart` is "the first part after the LAST tool call", so a turn that ends with a TodoWrite completion or `build_and_open` folds its prose answer away; the user sees "Worked for 3m 40s · 14 steps" and a ticked checklist, no sentence. CLAUDE.md records one instance. Nothing lists which files a turn changed.
Evidence: chat §1 "the trap in the fold" (`turnSteps.ts:117-127`, pinned by `turnSteps.test.ts:52`); anthropic-surfaces §10.8; vibecoding-long-tail §3.7.
Proposal: boundary = last non-blank text part when the trailing calls are checklist/outcome tools; under the fold a "Changed 3 files" line from Write/Edit/NotebookEdit parts, click-to-open. (The same list is the anchor for Restore in owner-and-engineering-16.)
Benefit: "where is the answer?" stops being the whole experience.
Model calls per use: 0. Effort: S. Category: ux. Depends on: nothing.

**owner-and-engineering-10 — Copy must-fix pass and one narrator.**
Problem: the shell speaks as a build server while the chat speaks as a colleague; `CS:` (Coscientist) prefixes every preview; "paste a repo", "scaffolds", "rebundle", "Waiting for container...", "Could not load application dirName", `mcp__hex__…`, `pid 41823 · node index.mjs`, "frontmatter", Coscientist placeholders in the Add-a-skill form; four narrators (me / Claude / ACABOX / it) on adjacent screens; the agent is ordered never to identify as Claude while every button says "Ask Claude".
Evidence: copy-audit §7 must-fix list (about 40 items, each with file:line and rewrite), §3 naming matrix, §4; live-walkthrough "Naming observed on screen"; agent-capabilities §0.3/§8.
Proposal: apply the must-fix rewrites as written (one afternoon); pick one narrator for UI strings (first person "I/me" matches the Tools and Chats pages that already read best); replace `CS:` with the chosen name; remove the "Never identify yourself as Claude" line from `identityPreamble.ts` — the denial is an honesty problem, and "I'm Acabox, built on Claude" is true. Owner decision: which name.
Benefit: the audience stops at the first unknown word; this removes the first forty.
Model calls per use: 0. Effort: S. Category: copy. Depends on: nothing (owner-and-engineering-23 depends on this vocabulary).

**owner-and-engineering-11 — First-run cards, key validation, plain-language API and spend errors.**
Problem: no first-run state at all: the user discovers the key by being refused, finds it as the last control in Settings under "Account" below "Rescan", gets no link to the Console, no validation (an OpenAI key or an org id says "Saved."), and non-401 failures ("credit balance is too low", 429, 529, the two spend-limit shapes) arrive raw. The folder step is equally undiscoverable.
Evidence: onboarding §2.3/§2.4/§7.5-6 (`ApiKeySettings.tsx:58-89`, `DirectoryPermissions.tsx:365-397`, `main/index.ts:2737-2771`, `agentSession.ts:822, 1399`); shell §1; desktop-agents §16 (Raycast Verify; Anthropic 429 `enforced_spend_limit_reached` without `retry-after`, 400 "You have reached your specified API usage limits"); chat §4 table.
Proposal: two Home cards shown only while real state says so (no key → "Add your Anthropic key", opens Settings scrolled to the field; key but no folders → "Add a research folder", opens the picker). Validate on save with the existing non-billable `GET /v1/models` (`modelCatalog.ts`) and say "Key works — your account can use …" / "Rejected" / "No billing on this key"; link `console.anthropic.com/settings/keys`; say a Claude.ai subscription is not a key (Anthropic policy forbids BYOS). Map `credit balance`, 429, 529, both spend-limit shapes and network-down to one sentence each with the next step; pause scheduled tasks on a spend-limit error and never backfill. Move key + folders to the top of Settings. Keep the error-block text clickable.
Benefit: the first five minutes stop being a refusal followed by a scavenger hunt.
Model calls per use: 0 (one non-billable request on save). Effort: M. Category: ux. Depends on: nothing.

**owner-and-engineering-12 — Stock-Mac prerequisites: node shim, seeded npm-site, no launch-time Python probe.**
Problem: the scaffold is `node …/manage_mini_app.mjs` and react/react-dom/react-plotly.js/lucide-react are "already installed" only because an agent once ran `npm install -g`; macOS ships neither Node nor npm, so on a stock Mac the first tool build fails with esbuild output and a "let it fix itself" button that cannot. Separately, `ensurePythonVenv()` runs fire-and-forget at every launch and execs `python3` from PATH, which on a Mac without Command Line Tools pops Apple's "install the developer tools?" dialog every time; the one actionable message (`userActionable`) is read by nobody.
Evidence: live fact #7; onboarding §2.6/§2.7/§7.1-2 (`SKILL.md:28-29, 120-123`; `packageInstaller.ts:290`; `pythonSetup.ts:60-85, 159`; `AgentInfrastructureController.ts:550`); CLAUDE.md Known hazards ("Requires system Python 3.9+ and npm on PATH").
Proposal: ship a `node` shim on the subprocess PATH that execs `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (the app already does this for the agent server); vendor the four packages (plus plotly.js) as a prebuilt tarball seeded into `npm-site` at provisioning — which also removes the nested-React class of failure for good; never exec `python3` from PATH at launch — probe known absolute locations and `xcode-select -p`, defer the venv bootstrap to first notebook/pip need; show the real detection result in Settings → Advanced only when something is missing (hidden when fine, per no-mocks). Bundling Python (python-build-standalone, already named in CLAUDE.md) is the L follow-on.
Benefit: vibecoding works on the machine the audience actually owns.
Model calls per use: 0. Effort: M. Category: fix-bug. Depends on: nothing.

**owner-and-engineering-13 — An install failure is a state, not a loop; quiet the boot pip wave.**
Problem: `ensureAppDeps` rejection → `setTimeout(3000)` retry, unconditionally; the installer re-queues failed packages, so rows cycle FAILED → QUEUED → INSTALLING forever with no Skip, no error text, no fix path, and the tool UI is never reached even when the package is irrelevant to rendering. Every dev boot runs a pip wave for the tool's `requirements.txt` that exits 1 although every package is satisfied; stderr is not logged; nothing shows in the UI.
Evidence: live fact (pip wave ×4 boots); tools-lifecycle F1 (`MiniAppViewer.tsx:826-847`, `packageInstaller.ts:120-151`), F2 (`packageInstaller.ts:281`).
Proposal: stop the unconditional retry; render FAILED with the real pip/npm line, Retry, "Open anyway", and "Ask me to fix it" (one turn); surface `userActionable` verbatim; log pip stderr; skip the boot wave when the `requirements.txt` hash matches the last successful wave; record wave failures in Activity "Needs attention".
Benefit: the loop a scientist cannot escape becomes a screen with three buttons.
Model calls per use: 0 (1 user-initiated turn on "Ask"). Effort: M. Category: fix-bug. Depends on: nothing.

**owner-and-engineering-14 — `canUseTool` relay: structured questions, readable denials, NotebookEdit approved.**
Problem: there is no `canUseTool` handler, so every tool outside the allowlist is denied with "you haven't granted it yet": `AskUserQuestion` 100%, `NotebookEdit` 100%, Monitor, DesignSync. The agent asks in prose and the turn ends (12.8% of turns end in a question). The allowlist header still claims unlisted tools run. For a product whose tools have a notebook backend, the agent cannot edit a notebook.
Evidence: live fact #2; production-usage §3.2 and §1.7; agent-capabilities §1.1; chat §2 "clarifying questions"; `sdk.d.ts:1521`, `sdk-tools.d.ts:1102`; `agentAllowedTools.ts:12-16` (stale); NN/G "buttons and checkboxes" and Promptions in agent-ux §1/§4.
Proposal: add `canUseTool` in the agent server relayed to main and the renderer (same mcp-call/mcp-result shape already used); render `AskUserQuestion` as a 2–4 option card with an "Other" field in both composers; the answer continues the same turn. Any other unlisted tool is denied with a readable reason instead of the raw prompt. Add `NotebookEdit` to the allowlist (one line). Fix the header comment. Policy line in the workspace CLAUDE.md: at most one round of ≤3 questions before scaffolding a tool, never for small edits.
Benefit: the model's best elicitation tool starts working; fewer wasted turns; the foundation for owner-and-engineering-15.
Model calls per use: 0 extra (same turn; saves the round trip). Effort: M. Category: feature. Depends on: nothing.

**owner-and-engineering-15 — Enforce read-only folders; confirm permanent deletes; trash-on-delete for the agent's shell.**
Problem: read-only is a sentence in the prompt; `Write`/`Edit` succeed; the UI shows a padlock labelled "Read only"; the agent is told "direct edits will fail" (false) while its own skill says "Nothing enforces it". `rm -rf` on a shared folder runs silently; there is no trash for agent deletions. Anthropic's containment guidance: non-technical users need deterministic boundaries; per-action prompts are approved 93% of the time.
Evidence: agent-capabilities §0.1/§4 (`agentSession.ts:590-591`; `skills/acabox/SKILL.md:271-273`; `DirectoryPermBadge.tsx:24`); onboarding §3; desktop-agents §0.1-2 and §17; agent-ux §8 and B3/B4; CLAUDE.md Known hazards names this fix.
Proposal: (1) PreToolUse hook denying Write/Edit/NotebookEdit under read-only roots and Bash commands whose arguments resolve into one (main exports the ro list to the hook env; realpath-dedup already exists); fix the guidance text so "will fail" becomes true. (2) PreToolUse hook rewriting `rm`/destructive `mv` of paths inside shared folders into a move to a per-run trash (`newTrashDir`/`moveInto` exist for skills), 7-day sweep, "Restore" from Activity. (3) One confirm class only, via the relay from owner-and-engineering-14: permanent delete / overwrite of a non-empty user file → card "Allow / Move to Trash instead / Cancel". Everything else stays auto-approved — no autonomy dial, no policy editor.
Benefit: the padlock means something; a wrong `rm` is recoverable; the agent is interrupted only for the one class of action a scientist cannot undo.
Model calls per use: 0. Effort: M. Category: safety. Depends on: owner-and-engineering-14 for the card; the two hooks are independent and can ship first.

**owner-and-engineering-16 — Tool history with Restore (and Undo delete).**
Problem: no version history, undo or restore for a tool after a bad edit; `Edit`/`Write` overwrite `App.tsx` in place; delete is `rm` with no trash; one tool received 309 Edits across 8 chats. Every comparable product treats rollback as table stakes and separates code from data.
Evidence: tools-lifecycle F3/I1 (`miniAppBuilder.ts:141`; `fileHandlers.ts:629-631`); production-usage §5.3; vibecoding-mainstream §5.4; vibecoding-long-tail §3.1; desktop-agents §17/§19.9; agent-ux C1.
Proposal: on every successful `buildMiniApp`, copy the code tree (`src/`, `notebook.ipynb`, `manifest.json`, `requirements.txt`, `package.json`, `setup/`; never `input`/`output`/`dist`) to `<userData>/tool-history/<dir>/<ts>/` (APFS clone is free), keep the last N; a header History menu lists "Built 14:07 — after 'make the threshold a slider'" with Restore (copy back + rebuild); snapshot on Delete so "Undo delete" exists; state plainly that `tool-data/` is not reverted. Fix-loop guard: after three consecutive failed fix turns on a tool, the Activity row offers Restore + "start a new chat". Optional second step: `enableFileCheckpointing` + `rewindFiles` for Write/Edit on user files ("Undo this turn's file changes" on the fold) — verify that resuming with an empty prompt does not bill a turn; Bash edits are not covered, which is why the build snapshot is the primary mechanism here.
Benefit: "it worked yesterday, put it back" becomes one click.
Model calls per use: 0. Effort: M. Category: feature. Depends on: owner-and-engineering-09 for the "Changed N files" anchor (nice to have, not required).

**owner-and-engineering-17 — Plain-English step rows; honest error, retry and fallback states.**
Problem: step rows speak Unix (`bash`, `glob`, `grep`, raw shell command, `EXIT 1`); the model's `description` is ignored; `api_retry`, `rate_limit_event` and `permission_denied` are ignored so a 10-minute retry window reads as THINKING…; a `result.is_error` row is never displayed; 23 `fallback` blocks (Opus 5.5 → 4.8/5 after a safety check) and two "can't help with this. Start a new session" dead ends were never surfaced while the header still said Opus 5.5; raw host strings ("failed to become healthy within 15s", "Failed to authenticate. API Error: 401", `ECONNREFUSED`) reach the bubble.
Evidence: chat §1/§4/§10.4-5 (`tool-card-display.ts:42-101`; `agentSession.ts:1439-1589`; `historyMessageConverter.ts:102-123`); production-usage §3.1; copy-audit #41-52, §5.2.
Proposal: Bash `description` on the row, command in the expanded body; `bash`→"Ran a command", `grep/glob`→"Searched files", `fetch`→"Read a web page", `EXIT 1`→"Failed"; map `api_retry` → "Anthropic is busy — retrying (2 of 10)", `rate_limit_event` → "Usage limit reached, resets at …", network → "Can't reach Anthropic"; render `result.is_error` as a red strip not prose; render a `fallback` block as "Answered by Opus 4.8 after a safety check" with "Start a new chat from here"; funnel host/SDK errors behind a plain headline with Details.
Benefit: a scientist can tell "Anthropic is overloaded" from "Acabox is talking".
Model calls per use: 0. Effort: M. Category: ux. Depends on: nothing.

**owner-and-engineering-18 — Attachment truths: visible rejections, in-place references, a dropzone on the full chat.**
Problem: an oversize file throws inside the adapter and every caller swallows it (a 32.6 MB jsonl cost the user a 4-minute plus 35-minute detour); files dragged from an already-shared folder are copied to the workspace root because symlink real paths never match; the empty state says "drop files" but the Chats detail view has no dropzone.
Evidence: chat §3 bugs 1–3 (`attachmentAdapter.ts:204-208, 221-229`; `thread.tsx:85-93, 148`; `index.tsx:1357`); production-usage §8.5/§10.5.
Proposal: a composer notice (reuse `cdMicNotice`) for too large / unsupported / copy failed, suggesting "put it in one of your folders and I'll read it there"; resolve native paths through the shared-dir list before deciding to copy; copy strangers into `attachments/` not the root; wrap the Chats detail column in `ComposerPrimitive.AttachmentDropzone`.
Benefit: the third file never silently disappears again.
Model calls per use: 0. Effort: S. Category: fix-bug. Depends on: nothing.

**owner-and-engineering-19 — Finish the recorded notification design.**
Problem: when a turn or build finishes while the user is elsewhere, only an unread dot appears unless the agent remembers to call the toast tool; 19 production nudges and ~56 hours of stalled waiting were mostly the agent promising callbacks, but the "it finished while you were away" case has no cue either. CLAUDE.md already holds the design (unit = the wait; tier by where the user is; only >30 s or failed; never for installs).
Evidence: chat §10.16; production-usage §4.1; agent-ux J1; desktop-agents §19.11.
Proposal: main fires an OS notification from `chatActivity` when a turn >30 s ends unseen (focus logic exists), from `buildHealth` on a failure, and (after owner-and-engineering-14) when a question is waiting; click deep-links to the chat; a Home "While you were away" line composed deterministically from the job registry and unread chats.
Benefit: the user stops typing "any update?".
Model calls per use: 0. Effort: S. Category: ux. Depends on: owner-and-engineering-14 for the "needs your answer" case only.

**owner-and-engineering-20 — Scheduler truths.**
Problem: "Every 7 days" emits `0 0 */7 * *`, a day-of-month step (1st, 8th, 15th, 22nd, 29th, 1st); "Daily" means midnight and never says so; no weekday or time of day; each run's chat is not linked from the task; runs are Opus 5 at high effort with every tool and no cap; a broken task runs forever; missed runs are neither marked nor folded. Production has zero tasks, yet the agent now recommends the scheduler as the answer to waiting.
Evidence: live fact #6 (`scheduleCron.ts:26`); secondary-tabs §5.2; agent-capabilities §7; production-usage §4.1/§10.12; desktop-agents §11/§19.10; science §3 (Deepnote pause-after-N-failures).
Proposal: true weekly cron (`0 8 * * 1`) with weekday + time-of-day pickers; link each run to its chat via the stored `session_id`; pause after N consecutive failures with a Needs-attention row; a per-task model/effort picker that keeps the existing default (no silent change — CLAUDE.md pins the default deliberately) and extends the honest cost line to "≈ N runs/month"; `powerSaveBlocker` during runs; mark skipped runs, never backfill.
Benefit: the one feature that spends money unattended behaves as labelled.
Model calls per use: 0 (saves calls). Effort: M (the cron fix alone is S). Category: fix-bug. Depends on: nothing.

**owner-and-engineering-21 — Dead-code and dropped-feature sweep.**
Problem: ~11,100 lines of unreachable renderer UI plus ~1,200 of backend and 31 IPC handlers for the calendar alone; Podman-era strings still reachable ("Waiting for container...", "Container is not running"); a Podman VM watchdog emitting ~140 false warnings; Word-overlay call sites that open Microsoft Word when a `.docx` is clicked; a half-finished Quick Chat on a system-wide hotkey that hijacks typing Å; a non-functional R template copied into every workspace; dead tool labels for five dropped integrations.
Evidence: secondary-tabs §1; shell §9; chat §9; onboarding §5; copy-audit §6; production-usage §10.13; tools-lifecycle F4/F17; agent-capabilities §5. Full list in §5 below.
Proposal: delete per the list; `tsc --noEmit` and `npm test` gate; one commit per vertical so each reverts cleanly.
Benefit: fewer words a scientist can meet by accident; a smaller surface for every later ticket.
Model calls per use: 0. Effort: M. Category: remove. Depends on: owner-and-engineering-08 (reactions) and 05 (debug) are slices of this; do them first.

**owner-and-engineering-22 — Agent instructions: audience preamble, ask-don't-guess, truthful capability skill.**
Problem: the agent is never told the user is a non-technical scientist; it is taught `dir_name`, esbuild, `mcp__…`, 405/403 and told to relay them; the `acabox` skill — what it reads to answer "what can you do?" — promises R, R kernels, a ready DESeq2 skill and a daily activity summary, two false and one unreachable; no instruction says to confirm before deleting or to state what changed.
Evidence: agent-capabilities §0.2/§0.4/§2.3/§5 (`identityPreamble.ts:6-10`; `skills/acabox/SKILL.md:78-85, 257`; `manage-mini-application/SKILL.md:45, 274, 442-450`); tools-lifecycle F4; agent-ux G1/G4.
Proposal: one paragraph in `IDENTITY_PREAMBLE`: scientist not programmer; plain language; no paths or tool names unless asked; say what changed in which file; on contradictory or missing data, say so and ask (via the question card) before producing a figure; end analysis replies with Verified / Assumed / Could-not-do lines naming the file or command each rests on; never numeric confidence. Rewrite the `acabox` skill's capability inventory; remove the R-kernel example and the `differential-expression` skill + template.
Benefit: the model stops teaching the user its own jargon and stops promising R.
Model calls per use: 0 (adds a few hundred tokens per turn). Effort: S. Category: agent-guidance. Depends on: owner-and-engineering-14 for the question card (the text works without it).

### P2 — later

**owner-and-engineering-23 — Flatten the information architecture; restructure Settings.**
Problem: nine destinations where five serve a scientist; "things Claude can connect to" live in three places (Servers tab, Settings → Connectors, Settings → APIs) and each page explains itself against the other; Knowledge is a developer file browser (roster, frontmatter, byte sizes) at top level; Settings orders developer integrations before the two first-run essentials.
Evidence: shell §3/§12.7; secondary-tabs §3/§4/§6/§8; copy-audit §5.1; agent-capabilities §9.
Proposal: rail Home · Chats · Tools · Files · Activity (+ Settings); Settings sections Your folders · Instructions for Acabox · About you · Connected services (Connectors + APIs, with "Running on this Mac" = hosted servers as a group inside) · Sharing · Anthropic key · Advanced (Claude Design, base URL, diagnostics, developer server form). Knowledge becomes "What I know" under Settings with machinery skills (`manage-*`, `acabox`, `react-plotly`) hidden by default and the Hex-flavoured placeholders replaced.
Benefit: a scientist's five tabs, and nothing to explain against another page.
Model calls per use: 0. Effort: M. Category: ux. Depends on: owner-and-engineering-10 (vocabulary), 05 (Debug gone).

**owner-and-engineering-24 — Research-profile scan: truthful, cheaper, and visible.**
Problem: the only trigger is a button labelled "Rescan" (for something that has never scanned) under Account; it spends 1 Sonnet agent + 1 Haiku agent + 1 Haiku call per untagged PDF + 1 per manuscript writing `writing_agent` briefings into a table no screen renders; progress events have no renderer listener; the About-you textareas load once so the fresh profile is overwritten by stale text on Save; the model id `claude-sonnet-4-6` is hardcoded and superseded.
Evidence: secondary-tabs §6.3/§6.8; agent-capabilities §6 (`researchProfile.ts:35-60, 195-213`; `fileTagging.ts:544-600`); onboarding §2.5.
Proposal: drop the briefing step (pure saving); state the cost before running ("about N PDFs, roughly N calls"); subscribe to `scanner:event`; write the result to the report and let Settings merge rather than overwrite hand-typed text; reload the fields after the run; move the button beside About you; use the current roster id. Running it automatically after the first folder is added is tempting but is a model-call default nobody chose — keep it a button.
Benefit: the one unexplained button that spends dollars explains itself and stops writing to a dead table.
Model calls per use: removes N Haiku calls per scan; the UX change is 0. Effort: S. Category: cost. Depends on: nothing.

**owner-and-engineering-25 — Tool output and sharing truths.**
Problem: `OutputFileList`'s Download is a silent no-op for images; `downloadFile` is string-only so a tool cannot hand over a PNG or XLSX; the Plotly camera button is disabled; "Download" (export zip) and "Import tool" do not read as a pair. Publishing uploads input data by default (all 7 production publishes did), one shared `PUBLISH_TOKEN` lets any publisher replace or delete anyone's artifact, and the Settings hint points at `src/share-workers/README.md`.
Evidence: tools-lifecycle F5/F6/F7/F10/F11/F19 (`OutputFileList.tsx:56-65`; `plotTheme.ts:140-145`; `SharePublishDialog.tsx:66-67`; `SharingSettings.tsx:98-104`); production-usage §5.2.
Proposal: a bridge `saveFileCopy(relPath)` used by `OutputFileList`; base64 in `downloadFile`; camera-only Plotly modebar; rename to "Export tool…"; `includeInput` default off; per-user publish tokens on the api Worker (token → owner; DELETE/PUT scoped), operator URLs pre-filled from release config, the hint rewritten; a pre-share regex scan for key-shaped strings and home paths.
Benefit: a scientist can save a figure, and sharing a dashboard does not ship the dataset by accident.
Model calls per use: 0. Effort: M. Category: safety. Depends on: owner decision on operator-hosted sharing (production says that is what it is).

## 4. Sequencing — increments that each ship alone

- **Increment 0 — truth week (all S, all 0 calls, no dependencies):** 04 Files → Trash; 05 Debug out of the rail; 06 shell indicators; 07 small truths; 08 Reactions task deleted; 09 never fold the answer; 10 copy must-fix pass. Seven tickets; one release.
- **Increment 1 — trust (P0 core):** 02 cost meter → 01 Stop keeps the record → 03 crashed-tool state. Order: cost first because it is the cheapest and the owner's own rule; Stop second because it loses work; crash third because it needs the bridge change.
- **Increment 2 — the front door:** 11 first-run cards + validation + error mapping; 12 stock-Mac prerequisites; 13 install failure as a state. Independent of each other.
- **Increment 3 — safety foundation:** 14 `canUseTool` relay (foundation) → 15 read-only enforcement + delete confirm + shell trash (hooks can precede the card) → 16 tool history with Restore. 22 (agent instructions) rides alongside since its question-card line needs 14.
- **Increment 4 — clarity:** 17 plain-English rows and honest states; 18 attachments; 19 notifications (its "needs your answer" case waits for 14); 20 scheduler. Independent.
- **Increment 5 — simplify:** 21 dead-code sweep (after 05/08, which are its first slices); 23 IA flatten (after 10's vocabulary).
- **Later:** 24 scan; 25 output/sharing.

Dependencies named: 15 → 14 (card only); 19 → 14 (one case); 22 → 14 (one line); 23 → 10 and 05; 21 → 05 and 08 (slices); 16 ← 09 (anchor, optional).

## 5. Removals (simplify rule: delete, do not disable)

1. **Reactions vertical:** `main/ipc/reactions.ts` (system task, boot re-enable at `main/index.ts:1263-1265`), `reaction` relay in the agent server, `activity-summary` and `reaction` skills, `ReactionsToolView.tsx`, `ReactionsSidebar.tsx`, dead duplicates `main/mcpServers/notificationMcpServer.ts` and `reactionMcpServer.ts`.
2. **Calendar vertical:** `renderer/components/calendar/*` (17 files, ~8,266 lines), `main/calendarAgentSession.ts`, `main/ipc/calendar.ts` (31 handlers), `main/db/calendarRepository.ts`, 31 preload methods, the `calendar` branch in `chat:send`.
3. **Pre-Activity home and overlay era:** `HomePage.tsx`, `BriefingHistory.tsx`, `PaperMonitorView` branch (`toolsViewMode==='paper-monitor'`), `FocusEditor.tsx`, `WritingAgentView.css` + the `looksLikeHtml` reply path, `OverlayNavigationHandler`, `ContainerTests.tsx/.css`, `MiniAppsTab.tsx`.
4. **Word-overlay call sites:** `.docx` → `open -b com.microsoft.Word` + `setDockRightForDocument` (`renderer/index.tsx:759-764`, `FilesTab.tsx:946-951`, the undefined `overlay:ensureReady`); the `writing_agent` briefing step in `fileTagging.ts:544-600`; the "Open in Word" row button (replace with open-in-default-app or nothing).
5. **Podman residue:** `SetupBanner.tsx` stage strings + `setupStore.ts` 'downloading' state and the three "Setting up environment…" copies; `StorageDebug.tsx:54-59` Podman rows; "Waiting for container..." (`MiniAppViewer.tsx:707-708`); "Container is not running" (`main/index.ts:1692`); "Container restarted" (`packageInstaller.ts:185`); `src/utils/processCpuMonitor.ts` and its start at `main/index.ts:910`; the agent-server header comment; `scripts/bench-build.sh`.
6. **Grant finder and pre-built path:** `renderer/grant-finder-entry.tsx`, `prebuilt-apps/grantFinder/`, its `extraResource` entry; the `preBuilt`/`nativeTools:getUrl` path (returns `null`), the `PRE-BUILT` and `ON-DEMAND` tags, "Open in browser".
7. **Chat dead code:** `tool-labels.ts:92-160` (ms-word/obsidian/apple-notes/google-docs/google-drive labels) and the unused mapper, `tool-write.tsx`, `approval-buttons.tsx`, `latex.d.ts`.
8. **Quick Chat:** `quickChat.ts` (stubbed `captureContext`), the window and forge entry, `QuickChatInjector`, the system-wide `Alt+Shift+A` registration.
9. **`differential-expression` skill and `differentialExpression` template** (R kernel; self-declared unrunnable; copied into every workspace on boot).
10. **Debug in the rail**, Telemetry crash buttons in packaged builds, stale Hard Reset bullets ("briefings", "calendar").
11. **Status-bar CPU/MEM/DISK/UP segments and `AGENTS 0 LIVE` at zero; rail `SYNCED` and `~/workspace-data`.**
12. **Dormant upstream residue:** `coscientistAnalytics.ts`, Datadog/Fullstory/`ONBOARDING_V2_ENABLED` defines in `webpack.plugins.js`; `docs/AUTO_UPDATER.md`, `docs/FEED_SERVER.md`; README's "Academia.edu account" line and `scripts/build-signed.sh` reference.
13. **Stale comments that mislead the next engineer:** `agentAllowedTools.ts:12-16` ("an unlisted tool still runs"), `ChromeBar.tsx:9` ("Health = agent-server liveness"), CLAUDE.md "NOT verified whether the model volunteers record_finding" (134 calls say it does), the "profile-seeded chips" claim (they are hard-coded).

## 6. Do not build (ideas from the reports, rejected or deferred, with reasons)

- **Keep-alive sessions or a host-owned "wait for" primitive (production-usage idea 1).** CLAUDE.md records the keep-alive decision; the stall data came from the agent promising callbacks it could not keep, which the Sep 21 honesty fix already changed. Ship owner-and-engineering-19 (notifications) and 20 (a scheduler that works as labelled) first; revisit a bounded host-side trigger only if nudges persist.
- **Removing the Jupyter kernel gateway and per-tool notebooks (production-usage idea 7).** The product definition is "React + Plotly front ends with a Jupyter notebook backend"; the one production user is a product manager running analytics through `exec`, not a bench scientist; the kernel is already spawned lazily. Measure with target users first. What should go now is NotebookEdit's 100% denial (owner-and-engineering-14).
- **Auto-reporting runtime errors (1 turn per error), bounded auto-retry on build failure, autonomous post-build QA or "Verify this tool", three design directions before a build.** Each adds model calls per failure or per tool; the owner's rule calls that a regression. The manual "Ask me to fix it" button is the design; the zero-cost cousin (capture the error, offer the button) is owner-and-engineering-03.
- **Recurring background calls:** session recap on return, next-prompt suggestions, Haiku-written agent-view headlines, `/goal`-style evaluators, an auto-mode classifier per action, a "tidy" pass on dictation, model-written questions per attached file. The unread dot, the fold line and deterministic chips cover the need; client-side filler stripping is fine.
- **"Check this answer" reviewer (1 call per use).** Defensible as an opt-in button after the cost meter exists; not before, and never automatic.
- **Apple on-device Foundation Models for titles or previews.** Zero Claude calls but a non-Claude model — conflicts with the Claude-only rule.
- **Subscription sign-in (BYOS).** Anthropic's policy forbids OAuth from Free/Pro/Max accounts in third-party apps; Settings should say so and point at the Console.
- **An autonomy dial or user-authored permission policies as the primary safety control.** Non-experts do not maintain them and approve at runtime anyway (Yan 2026; Anthropic's 93% approval telemetry). Deterministic boundaries plus a single confirm class (owner-and-engineering-15) instead.
- **Numeric confidence scores; generic disclaimers under every answer.** Raise over-reliance / become clutter (Whitmore 2026, Li 2025, NN/G).
- **In-app browser, cloud routines, Dispatch, mobile remote control, computer use, a deep-research mode, multiplayer, Figma import, custom domains per tool, credit systems and free-fix allowances.** CLAUDE.md decisions, infrastructure Acabox does not have, or features that belong to a hosted product; Acabox bills nothing itself.
- **A full ⌘K command palette.** Make the box honest now (owner-and-engineering-07); a palette is an M with no evidence of demand.
- **A new Memory UI.** The Knowledge page already lists memory files; the field is dropping memory UIs (Dia retired memory; Claude moved to a settings list); per-folder instructions are the better later investment.
- **Silent routing of small edits to a cheaper model.** "Quality roulette" (Nielsen); a visible per-message chip is acceptable later, not a silent default.
- **Bringing back the hourly suggestion scan** in any form; **jump-to-message from search** (deliberately not built); **auto-running the profile scan** when a folder is added (a model-call default nobody chose).

## 7. What the reports disagree on, and how it was settled

1. **Do unlisted tools run or get denied?** `agentAllowedTools.ts` and CLAUDE.md's 2026-07-28 measurement say they run; production data (6 "haven't granted it yet" prompts; NotebookEdit, AskUserQuestion, Monitor, DesignSync 100% failures) and today's live test say they are denied. Settled: denied on SDK 0.3.280; the comment is stale; NotebookEdit needs a one-line allowlist entry.
2. **Is cost available?** production-usage says the transcript `.jsonl` does not carry `total_cost_usd`; live-walkthrough says the app drops it. Settled: the SDK result message carries it (`sdk.d.ts:5456`), the app never reads it; its cumulative-per-query semantics mean "store the raw value, derive per-turn as the delta where the chat was resumed" — first live run decides.
3. **Jupyter: dead weight or core?** production-usage says remove; tools-lifecycle and the product definition treat it as the backend. Settled: keep, defer its bootstrap, fix NotebookEdit, measure with bench users.
4. **Claude or Acabox?** copy-audit wants "I/Acabox" everywhere; agent-capabilities says the "never identify as Claude" order is an honesty problem. Settled: one narrator in UI strings and drop the denial; the owner picks the name.
5. **Plan mode.** The vibecoding reports want Plan/Discuss modes; agent-ux cites "plan mode is dead — approved plans still yield wrong code" and says invest in result-side gates. Settled: a short "here's what I'll build" brief in the agent's instructions (0 calls), no plan-mode toggle now; Restore (16) and the crash state (03) are the result-side gates.
6. **Memory UI.** anthropic-surfaces, openai-google and vibecoding-mainstream propose a Settings memory page; desktop-agents shows the field dropping memory UIs. Settled: do not build.
7. **Who hosts sharing?** tools-lifecycle asks operator-hosted vs self-hosted; production shows 7 of 13 tools published to the operator's deployment within minutes. Settled: operator-hosted in practice → per-user tokens and pre-filled URLs (25); `includeInput` default off regardless.
8. **Scheduled-task default model.** agent-capabilities wants Sonnet by default for tasks; CLAUDE.md pins the default deliberately. Settled: a per-task picker with the existing default and a visible cost line; no silent change.
9. **Does Stop kill in-flight Bash children?** chat-experience leaves it open; the live test shows the model answering during the kill grace. Settled: measure with `interrupt()` in owner-and-engineering-01; the host-authored result row is correct either way.
10. **Is the Debug tab meant to ship?** Open question in three reports. Settled by the audience: remove from the rail, keep diagnostics behind Settings → Advanced.
11. **Starter gallery of real tools.** Several reports rank it high; it is content work that must be kept building across SDK and skill changes. Deferred (see §8), with the cheaper fix (chips derived from the folders) folded into owner-and-engineering-11's folder card.

## 8. Deliberately left out, and why

- **Element picker / annotation mode inside mini-apps** (tools-lifecycle I4, vibecoding reports). Real value, M effort, 0 calls — but quotes (15.6% of messages) and screenshots (31) already carry the user's pointing today. After increment 3.
- **Inline result cards before a full tool; inline images and LaTeX in replies; viewable sent images.** Good, 0 calls, but renderer work that does not fix a lie or a loss. After increment 4.
- **Per-folder instructions (`INSTRUCTIONS.md`), data dictionary per folder, provenance per output, run snapshots, Prism-style assumptions checklist and export dialog.** The science report's strongest ideas for a paper-grade tool; each is 0 calls; none is a current defect. A second review pass once trust is fixed.
- **Bridge file-change events to stop the Notes poller flooding the job registry** (2,737 spawns; 300/300 cap). Real, M, but one user's one tool; cap per-tool jobs in the registry as a small fix inside owner-and-engineering-13 if it recurs.
- **Window bounds persistence, tab persistence, an application menu without Reload/DevTools, ⌘N.** Correct and S, but polish; after increment 0.
- **Developer ID signing.** Removes the Gatekeeper dance, the Keychain/TCC churn and `selfUpdater.ts`; a process decision, not a ticket.
- **Privacy statement in Settings and `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in the agent env.** 0 calls, S, and the right thing; left out of the 25 only for the count — fold it into owner-and-engineering-11 as one paragraph on the key card.

## 9. Open decisions for the owner

1. The agent's name in UI strings (Acabox with "built on Claude", or Claude) — owner-and-engineering-10 needs it.
2. Is sharing operator-hosted for all users? Then per-user tokens matter (25).
3. Keep the Jupyter notebook backend as a product commitment, or let the data from bench users decide?
4. Should Knowledge show machinery skills to a scientist at all, or only domain skills (23)?
5. Which single confirm class is acceptable (permanent delete and overwrite of user files, as proposed) — anything wider becomes approval fatigue.
