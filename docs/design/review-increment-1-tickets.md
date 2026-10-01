# Review increment 1 — tickets

**Source:** `docs/design/product-review-2026-09-30.md` (item numbers C01…C46 refer to its section 4).
**Owner decisions taken 2026-10-01:**

- **Q2:** the default model becomes **Opus 5.5** (`claude-opus-5-5`).
- **Q3:** shared folders become **writable by default**. Locking a folder is an explicit choice, and a lock is **enforced**.
- **Q7:** one name. The UI says **Acabox**, in first person where it speaks. The agent may say "I'm Acabox, built on Claude"; the instruction to deny being Claude goes.
- **Q8:** Quick Chat is deleted. Debug is dev-only.
- **Q10:** delete the Reactions vertical, the `differential-expression`, `activity-summary` and `reaction` skills, the `differentialExpression` R template, and every claim that the agent can run R or DESeq2.

Waves: **1** = T01–T09 in parallel; **2** = T10, T11 once wave 1 is merged; **3** = T12 (copy) last, because it touches strings everywhere.

---

## Appendix — rules every ticket follows

1. **Worktree setup.** You are in an isolated git worktree. First run
   `ln -s "/Users/iliasbeshimov/Documents/Dev Folders/Acabox/node_modules" node_modules`
   from the worktree root (it is gitignored). Never `cd` into the main checkout and never edit files there.
2. **Gate.** `npx tsc --noEmit` must be clean and `npm test` (never bare `npx jest`) must be fully green before you finish. Paste both tails in your report.
3. **Do not launch the app.** No `npm start`, no `pkill`, no `npm run package`/`make`. Several tickets run at once and share one dev userData directory. Live verification is done afterwards by the reviewer.
4. **Commit** your work on the worktree's branch (one or more commits). Message ends with the line
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push, do not merge.
5. **Match the code around you**: its comment density, naming and idiom. Comments explain *why*, as this codebase's do.
6. **No mocks in prod:** a UI element shows a real value or is not rendered.
7. **Simplify rule:** when something is removed, delete the whole slice (code, IPC, preload, types, CSS, tests that pin it, docs that describe it). Do not leave it disabled.
8. **Zero new model calls.** None of these tickets may add an Anthropic API call.
9. **Tests:** add unit tests for every pure rule you add or change. Put them beside the existing suites (`__tests__` folders). Code that imports `@assistant-ui/react` cannot be imported under jest (ESM-only dependency), so keep logic in pure modules.
10. **Report** at the end: what changed (files), what you verified and how, anything you found but did not change, and anything you could not verify.
11. **Don't edit `CLAUDE.md`** at the repo root. The reviewer updates it.

---

## T01 — Files delete goes to the Trash, behind a confirm (C03)

**Problem.** `FilesTab.tsx` deletes with `window.filesAPI.deleteFile(path)` from two places: the context menu (`handleDelete`, ~line 368) and a hover trash icon on every row (`handleDeleteNodePath`, ~line 449), including depth-0 shared-folder roots. Main runs `fsPromises.rm(resolved, { recursive: true })` (`main/fileHandlers.ts:~323`). No confirmation, no Trash.

**Do:**
1. Add an IPC `files:trashFile(path)` in `main/fileHandlers.ts` that resolves and checks the path exactly as `files:deleteFile` does (reuse its guard), refuses a path that IS a shared-folder root (depth 0) or the workspace root, and calls `shell.trashItem(resolved)`. Expose it as `filesAPI.trashFile` in `main/preload.ts` and `renderer/types.d.ts`.
2. **Do not change `files:deleteFile`.** The mini-app bridge's `useAppState` calls it on every input re-pick, and that must stay a silent delete.
3. In `FilesTab.tsx`: remove the hover trash icon (and `handleDeleteNodePath` and anything only it used). Keep Delete in the context menu, rename it **"Move to Trash"**, hide it on depth-0 rows (shared-folder roots), and put it behind `window.confirm` — the pattern used elsewhere in the renderer (grep `window.confirm(`). Text: `Move "<name>" to the Trash?` plus, for a folder, `\n\nEverything inside it goes too. You can restore it from the Trash in Finder.`
4. Update `renderer/components/__tests__/FilesTab.test.tsx` (it exists): no trash icon on rows; no Move to Trash on a root; confirm cancelled → `trashFile` not called; confirm accepted → `trashFile` called with the path.

**Acceptance.** Gate green. No code path in `FilesTab.tsx` calls `deleteFile` any more.

---

## T02 — Stop keeps the record, and interrupts instead of killing (C01 a+b)

**Problem (verified live and in production).** `chat:stop` (`main/index.ts:~2397`) → `unregisterSession` → `session.destroy()` (`main/agentSession.ts:~1008`) → `POST /sessions/:id/stop` → `queryInstance.close()` in the agent server (`agent-server/index.ts:~1171-1180`). No result row is written. On the next message, `cleanupOrphanTurnRows` (`main/db/chatRepository.ts:~329`, called at `agentSession.ts:~488`) **deletes** every assistant and tool row after the last result. Production lost 237 rows on one Stop. Also, during the kill grace period the model produced a reply blaming "the sandbox" (its Bash tool was SIGTERMed under it), and the UI rendered that as a finished turn.

**Do:**
1. **Agent server: an interrupt route.** `POST /sessions/:id/interrupt` calls `state.queryInstance.interrupt()` (the SDK `Query` method; check its signature in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) and responds 200 `{ok:true}` or 404/409 when there is no session or query. It does not close the query or end the session. Header comment at the top of `agent-server/index.ts` lists routes; add it there.
2. **Host: `stop()` on the session object** (add it to the `AgentSession` interface next to `destroy()`):
   - If no turn is in progress → just `destroy()`.
   - Otherwise POST `/interrupt`, then wait up to **4 s** for the turn's `result` message to arrive through the normal SSE path (resolve a promise from the result branch). Whatever happens, then call `destroy()`.
   - If the CLI's result arrived, it is persisted by the existing result branch as usual (expect `subtype` like `error_during_execution` or a `terminal_reason`; log what you get at info level so the reviewer can see it live).
3. **`destroy()` writes the stopped row when a turn is still open.** In `destroy()`, if `turnState.turnInProgress` is still true (no result arrived — interrupt failed, timed out, or this is quit/eviction/crash teardown), write a host-authored terminal row **before** severing the SSE:
   - an assistant text row: `Stopped by you.` for a user Stop (pass a reason into `destroy(reason?: 'user' | 'teardown')`; default `'teardown'`), or `Stopped — Acabox closed this chat before the reply finished.` for teardown;
   - then a result row `{subtype:'stopped', result:'', is_error:false, stopped_by:'user'|'teardown'}`;
   - emit `turn-complete` for the current messageId so the renderer stops its indicator; set `turnInProgress = false`.
   Reuse/extend the existing `completeTurnFromHost` helper (~line 614) rather than duplicating it — give it a way to write the `stopped` subtype.
4. **Any message that reaches the host after the stopped row is not persisted.** Once `destroy()` has run (`sessionState.stopped`), the SSE result/assistant branches must not insert rows. Check this holds; add a guard if not, with a comment saying it is what kept the "blames the sandbox" reply out.
5. **`chat:stop` calls `stop('user')`, not `unregisterSession` directly.** Keep the registry consistent: after the stop completes, unregister. Look at `main/sessionRegistry.ts` for how `unregisterSession` destroys; avoid a double destroy (destroy must be idempotent — make it so if it isn't).
6. **`cleanupOrphanTurnRows` no longer deletes.** Repurpose it: when there are assistant/tool rows after the last result (a crash left a turn open), **append** a terminal result row `{subtype:'stopped', result:'', is_error:false, stopped_by:'crash'}` instead of deleting, and return the number of rows it closed over. Rename to `closeOrphanTurn` (update callers and its tests).
7. **Renderer.** In `renderer/historyMessageConverter.ts` and the fold (`renderer/components/assistant-ui/turnSteps.ts` + `turn-steps.tsx`): a turn ended by a `stopped` result renders its kept steps and prose normally; a tool call with no tool_result in that turn renders as **stopped** (not running, not failed). The fold label for such a turn: `Stopped · N steps` (no duration — none is measured). Find how `FAILED` is counted today and do not count a stopped tool as failed.
8. **`read_chat`.** `main/chatReference.ts` renders a `stopped` result as `[stopped by the user]` / `[stopped]` in its transcript output.
9. **Tests:** registry/session tests for stop → interrupt → result arrives → no host row; stop → timeout → host row; destroy with no turn → no row; destroy idempotent; `closeOrphanTurn` appends rather than deletes (existing chatRepository tests — find them); converter/turnSteps cases for a stopped turn with an unfinished tool.

**Acceptance.** Gate green. `grep -n "DELETE FROM messages" main/db/chatRepository.ts` no longer shows the orphan sweep. The reviewer will drive a live Stop afterwards.

---

## T03 — Scheduler: no timer overflow, no "every N days" (C46)

**Problem.** `validateInterval` allows 1–31 days (`renderer/components/schedule/scheduleCron.ts`); `0 0 */25 * *` yields a delay above Node's 2,147,483,647 ms `setTimeout` ceiling, which Node clamps to 1 ms, so the run fires immediately and `scheduleNext` (`main/scheduledTasks/scheduler.ts:~43`) re-arms on the same far date — a tight loop of full model turns. Separately, "every N days" emits `0 0 */N * *`, a day-of-month step (Oct 29 → Nov 1), and "Daily" means midnight without saying so.

**Do:**
1. `scheduler.ts`: clamp every computed delay to `2**31 - 1` ms. When a clamped timer fires early, re-arm toward the same target instead of running. Comment why (Node clamps overflow to 1 ms).
2. At scheduler start, reconcile run rows left in a `running` state by a previous process (mark them failed/interrupted — read the repository for the right status values).
3. Replace the `days` unit with two schedule kinds: **Daily at HH:MM** → `M H * * *`, and **Weekly on <weekday> at HH:MM** → `M H * * D`. Keep minutes (5–55) and hours (1–24). Update `scheduleCron.ts` (`ScheduleUnit`, `intervalToCron`, `cronToInterval`, `validateInterval`, `cronToHuman`) and the editor UI (find it from `renderer/components/schedule/SchedulePanel.tsx`) with a time input and a weekday select. Times are local time; `cronToHuman` renders `Daily at 08:00`, `Weekly on Monday at 08:00`.
4. An existing task stored as `0 0 */N * *` must still read truthfully: `cronToHuman` returns `Every N days of the month (from the 1st)` for N>1 and `Daily at 00:00` for `0 0 * * *`; opening it in the editor maps it to Daily at 00:00 (N=1) or leaves the raw cron visible with a note that it will be replaced on save. Pick the smallest honest behaviour and test it.
5. Update `renderer/components/schedule/__tests__` (29 existing cases) and add scheduler clamp tests (a far target arms a clamped timer and does not fire the task when it expires early).

**Acceptance.** Gate green. No code path can produce `*/N` in the day-of-month field.

---

## T04 — Safety hooks work without `jq` (from C04)

**Problem.** `src/cobuilding/hooks/block-host-installs.sh:~23` and `block-secret-reads.sh:~29` parse the hook payload with `jq`, which ships only on macOS 15+. On 13/14 `jq` is missing, `set -e` aborts the script with a non-2 exit code, and the CLI treats that as "allow" — both guards are silently off.

**Do:**
1. Parse with `/usr/bin/plutil`, which ships with every supported macOS:
   `printf '%s' "$input" | /usr/bin/plutil -extract tool_input.command raw -o - - 2>/dev/null`
   (measured 2026-10-01: handles quotes, unicode and embedded newlines; exits 1 with no output when the key is absent). Write a small `json_field()` shell function in each script that tries `plutil` first, then `jq` if present, and prints nothing when the key is absent.
2. **Fail closed.** If the payload is non-empty but neither parser could read it (both tools missing or the JSON unreadable), exit 2 with a short stderr message ("Acabox could not check this command, so it was blocked. Try again; if it repeats, report it.") rather than allowing.
3. `block-secret-reads.sh` must keep scanning both `command` and `file_path`.
4. Tests: find the existing hook tests (grep `block-host-installs` / `block-secret-reads` under `src/**/__tests__`). Add cases that run each script with a `PATH` that has **no jq** (e.g. `PATH=/usr/bin:/bin` after confirming `/usr/bin/jq` absence is simulated — the reliable way is to run with `PATH` set to a temp dir containing symlinks to only `bash`, `grep`, `cat`, `printf`, `plutil` …), asserting: install command → exit 2; secret path read → exit 2; harmless command → exit 0; unreadable JSON → exit 2.

**Acceptance.** Gate green. `grep -n "jq" src/cobuilding/hooks/*.sh` shows only the optional fallback.

---

## T05 — Folders writable by default; a lock is enforced (Q3, C14 rules part)

**Problem.** `main/db/workspaceRepository.ts:63` defaults `readOnly = true` and both callers (`main/controllers/WorkspaceController.ts:~120,~169`) omit it, so every shared folder is locked though nobody chose that. The lock is advisory: the prompt says "direct edits will fail" (`main/agentSession.ts:~591`) while nothing enforces it, and `skills/acabox/SKILL.md:~271` says "Nothing enforces it".

**Do:**
1. Default `readOnly = false` in `addWorkspaceDirectory` (or whatever the function at line ~63 is called). Callers keep omitting it.
2. **Migration** (next number after the current highest in `main/db/database.ts`; read how migrations are declared): set `read_only = 0` for every existing directory row. Comment why: the old default was an accident nobody chose, and since the lock was never enforced, unlocking preserves what the agent could actually do.
3. **Enforcement via SDK permission deny rules.** The SDK `Options.settings` accepts `{ permissions: { deny: string[] } }`; deny beats `allowedTools`. For each read-only directory, build rules for `Edit`, `Write` and `NotebookEdit` covering BOTH the real path and the workspace symlink path (`<workspace>/<name>`), using the absolute-path rule form `Edit(//abs/path/**)` (two leading slashes = filesystem-absolute; check the Claude Code permissions docs bundled in the SDK or `sdk.d.ts` comments for the exact syntax and document what you found in a comment). Put the rule builder in a pure function in `src/cobuilding/shared/` (e.g. `readOnlyRules.ts`) with tests (paths with spaces, trailing slashes, the symlink and real path both covered).
   - The host computes the rules where it already builds `workspaceDirectoriesGuidance` (`agentSession.ts:~580-600`) and sends them in the session-create payload; the agent server passes them as `settings: { permissions: { deny } }` into `query()` (find where `query({ options })` is built in `agent-server/index.ts` / `sessionConfig.ts`). If the agent server already passes a `settings` object, merge.
4. **Guidance tells the truth.** Line ~591 becomes: `- ${name}/ (locked by you) — Acabox blocks Edit/Write on it. Do not change files here with shell commands either; copy the file into the workspace and edit the copy.` Update `skills/acabox/SKILL.md` around line 271 to match (Edit/Write are blocked; shell writes are not technically blocked, and the agent must not make them).
5. **The lock explains itself in the UI.** Find the folder card with the "Read only" padlock (grep `Read only` in `renderer/components`). Label the toggle **"Lock"** / state **"Locked — Acabox won't edit files here"**, unlocked state shows nothing extra. Lock changes apply to new chats (guidance and rules are set at session create) — say so in the toggle's `title`: "Applies to new chats."
6. Tests: repository default, migration effect (follow how existing migration tests run — if migrations are only exercised via better-sqlite3 under `npm test`, write one), rule builder.

**Acceptance.** Gate green. The reviewer will verify live that a locked folder refuses an Edit.

---

## T06 — Opus 5.5 is the default model; esbuild pins one React (Q2, C02-A)

**Part A — default model.** `src/cobuilding/shared/models.ts:143` `DEFAULT_MODEL = 'claude-opus-5'`. Change it to `'claude-opus-5-5'` and rewrite the comment above it: the owner chose Opus 5.5 on 2026-10-01 because it costs less per token at list price ($4/$20 vs $5/$25 per MTok) and is the newer model; keep the rule that the default never moves automatically with discovery. Grep the repo for other hard-coded `claude-opus-5'` defaults (the scanner in `main/directoryScanner/`, scheduled runs, title generation, anything with its own model literal) — change those that mean "the default chat model" to import `DEFAULT_MODEL`; leave deliberate cheap-model choices (Haiku for titles, etc.) alone and list them in your report. Check that `claude-opus-5-5` is in the picker roster and the mini-app allowlist. Update `shared/__tests__` model tests.

**Part B — one React per tool bundle.** In `src/cobuilding/main/miniAppBuilder.ts`, next to the existing `--alias:@reusable=…`, add `--alias:react=<npm-site>/lib/node_modules/react` and `--alias:react-dom=<npm-site>/lib/node_modules/react-dom` (find how the builder learns the npm prefix — `COSCIENTIST_NPM_PREFIX` / `getNpmPrefix` or similar). Comment why: a package with its own nested React copy (seen with `lucide-react` and `react-plotly.js` in the dev npm-site) otherwise bundles a second React and crashes the tool with "Invalid hook call … useContext of null". Only add an alias when that directory exists. Add/extend a builder test that asserts the flags are present when the dirs exist and absent when not.

**Acceptance.** Gate green.

---

## T07 — Delete Quick Chat and the Podman CPU watchdog; Debug is dev-only (Q8, C09, C28)

1. **Quick Chat — delete the whole vertical:** `main/quickChat.ts`, `main/quickChatPreload.ts`, `renderer/quick-chat-entry.tsx`, `renderer/QuickChatInput.tsx`, its forge entry in `forge.config.js`, its references in `main/index.ts` (incl. the global `Alt+Shift+A` registration), `main/preload.ts`, `renderer/index.tsx` (`QuickChatInjector` or similar), `shared/types.ts`, `main/findInPageHost.ts`, CSS, and any tests. Grep `-i quickchat` and `quick-chat` and `Alt+Shift+A` until empty.
2. **CPU watchdog:** delete `src/utils/processCpuMonitor.ts`, its start at `main/index.ts:~910`, its import, and its use in `main/fileMonitor/fileMonitorService.ts` (`register`/`unregister`).
3. **Debug is dev-only.** `authAPI.isDev` exists in preload (`process.env.NODE_ENV === 'development'`). Hide the Debug rail entry (`renderer/components/command-desk/Rail.tsx`) and do not mount the Debug tab in `renderer/index.tsx` when `!isDev`. In dev, nothing changes.
4. Inside Debug: delete the Telemetry crash-test buttons (grep `crash` in `renderer/components/debug/`) and the three Podman rows in `StorageDebug.tsx` that "Delete Selected" cannot act on. Fix the Hard Reset confirmation text so it lists truthfully what is deleted and what survives — read `debug:hardResetWorkspace` in `main/ipc/debug.ts` and write the list from the code (`tool-data` is deleted? the API key, connectors, skills, promoted MCP copies survive? check each). Change nothing about what the reset does.
5. Export Logs must remain reachable for a packaged user: if it only lives in Debug, add an "Export logs…" button to Settings (find the Settings page component — `DirectoryPermissions.tsx` hosts the sections) that calls the same IPC.

**Acceptance.** Gate green; `grep -rni "quickchat\|processCpuMonitor" src forge.config.js` empty.

---

## T08 — Delete the Reactions vertical and the dead R/DESeq2 skills (Q10, C11, C17-delete)

1. **Reactions — delete:** `main/ipc/reactions.ts`, `main/mcpServers/reactionMcpServer.ts` (and any other dead duplicates under `main/mcpServers/` that only it used), the boot block in `main/index.ts:~1262-1266` that re-enables the system task, the `reaction` relay in `agent-server/index.ts` and its entries in `shared/agentAllowedTools.ts` / `AgentInfrastructureController.ts`, `renderer/components/ReactionsToolView.tsx`, `ReactionsSidebar.tsx`, the `toolsViewMode==='reactions'` branch and other references in `renderer/index.tsx`, `useHomeData.ts`, `SchedulePanel.tsx`, `StorageDebug.tsx`, `ExportDebug.tsx`, preload/types, `shared/analyticsTypes.ts`/`connectors.ts` reserved names (keep a reservation only if removing it would let a connector take the name — use judgment and say which). Delete `FocusEditor.tsx` if it is only referenced from the reactions path (check). **Do not touch the `activity` relay.**
2. **Legacy data:** a migration (in `schedulingDatabase.ts`, following its pattern) that deletes the Reactions system task row if present. The `reactions` settings flag can be ignored on read (remove the getter/setter).
3. **Skills — delete** `skills/reaction/`, `skills/activity-summary/` (if present), `skills/differential-expression/` and the `differentialExpression` mini-app template (find under `skills/manage-mini-application/` templates). Remove them from any shipped-skill list (`main/skillStore.ts` or the seed/manifest that enumerates shipped skills — read how a shipped skill becomes known). The skill store's reconcile must not crash or "adopt" a removed shipped skill: read `skillStore.ts` for what happens when a previously shipped skill disappears from Resources (CLAUDE.md says a dropped skill holding findings is kept as custom — that is fine; verify a dropped skill without findings is removed cleanly and say what you found).
4. **Remove R/DESeq2/activity-summary claims** from agent-facing text: `skills/acabox/SKILL.md` (around lines 78, 82-85: R and DESeq2; ~257: daily activity summary; ~270: "not shareable except as an exported zip" — replace with one line saying tools can be shared from the tool's Share button when sharing is set up), `skills/manage-mini-application/SKILL.md` (R kernel lead at ~45, ~275, ~442-450; `kernel: "ir"` branches), and `src/cobuilding/CLAUDE.md` (the workspace agent's instructions). Only Python (`python3` kernel) exists.
5. Update the tests that pin these files (relay-name tests, allowed-tools tests, skill lists).

**Acceptance.** Gate green; `grep -rniE "reaction(s)?ToolView|create_reaction_thread|differential-expression|differentialExpression|DESeq2|kernel: \"ir\"" src` empty (the `reactome-database` skill is unrelated and stays).

---

## T09 — Check the API key on save; never send it to the renderer (C06)

1. `auth:getApiKey` (`main/index.ts:~2719`) returns the plaintext key; its only consumer is `renderer/components/ApiKeySettings.tsx:~18`. Delete the handler, the preload entry and the type; the component uses `getApiKeyStatus()` plus a masked display (`sk-ant-…` + last 4 chars) supplied by a new field on the status response, computed in main.
2. On save (find the save handler near `main/index.ts:~2760`, which already fires a `GET /v1/models` with the new key and discards the result): add a dedicated check — a direct `GET https://api.anthropic.com/v1/models?limit=1` (respect a configured `ANTHROPIC_BASE_URL`) with the new key, 8 s timeout — and return a verdict with the save result: `accepted` (2xx), `rejected` (401/403), `unconfirmed` (anything else, or network error; include the status or error). Put the status → verdict mapping in a pure function in `shared/` with tests, shaped like `interpretApiTest` in `shared/apis.ts`. The key is saved in every case (a network blip must not lose it).
3. `ApiKeySettings.tsx` shows: **"Key accepted."** / **"Anthropic rejected this key. Check it was copied in full."** / **"Saved, but Acabox couldn't confirm it with Anthropic just now (<detail>)."** Add under the field: a link **"Get a key from the Anthropic Console"** → `https://console.anthropic.com/settings/keys` (opens in the browser via the existing external-link handling), and one line: "A Claude.ai Pro or Max subscription is not an API key. Usage is billed to your Anthropic API account."
4. Tests for the verdict mapping and for the status response no longer containing the key.

**Acceptance.** Gate green; `grep -rn "auth:getApiKey'" src` empty.

---

## T10 — Show real cost (C07 slice 1) — wave 2

**Problem.** The SDK's `result` message carries `total_cost_usd`, `duration_api_ms` and `modelUsage`; `agentSession.ts` (result branch, ~line 1328) persists only `subtype/result/is_error`. The value is **cumulative per `query()`** — a resumed session continues the count; a fresh `query()` (new agent-server session) starts again at zero.

**Do:**
1. Persist `total_cost_usd`, `duration_api_ms` and `modelUsage` in the result row's JSON content (no migration).
2. Per-turn cost: the difference between this result's `total_cost_usd` and the previous result row's in the same chat **when both came from the same `query()`**. Because the count restarts when a new agent-server session starts, also persist an identifier of the query run (the agent-server session id is available in `agentSession.ts`) and compute the delta only between rows with the same run id; the first result of a run costs its own `total_cost_usd`. Put this in a pure module (`shared/turnCost.ts`) with tests: same run, run restart, missing values (→ unknown), stopped turn without cost (→ unknown).
3. Chat total = sum over runs of each run's last cumulative value. Same module, tested.
4. **Display:** on the fold line, `Worked for 4m 12s · 26 steps · $0.14`; in the chat header meta (`renderer/components/command-desk/ChatHeader.tsx`), `$3.40 so far` with `title="Estimated at list price by the Claude Agent SDK."`. Live turns get the cost through the `turn-complete` event (add a field, like `workedMs` travels in `metadata.custom` via `chatAdapter.ts`); history through `historyMessageConverter.ts`. Unknown → render nothing (no `$0.00`). Format: `<$0.01`, then two decimals.
5. No month-to-date total anywhere (it would omit mini-app proxy calls, titles and scheduled runs).

**Acceptance.** Gate green. Tests cover the delta rules.

---

## T11 — The shell tells the truth (C10) — wave 2

1. `renderer/components/command-desk/Rail.tsx:~203-207`: delete the hard-coded `SYNCED` and the `~/workspace-data` footer.
2. Timestamps: `CommandDesk.tsx:~171` and `renderer/historyMessageConverter.ts:~94,~169` parse zone-less SQLite timestamps as local time. Use the existing `dateFromSessionStoredAt` (find it, `sessionTimestamps.ts`) at all three. Add tests in the converter suite for a zone-less timestamp.
3. Chats list rows show the last-activity date, not `createdAt` (the list already sorts by activity; find the row component).
4. `HEALTHY`: `ChromeBar.tsx` reads `startedFlag`. Add a new `agentAlive` boolean (and `gaveUp` when the supervisor stopped restarting) to the `container:status` payload in `main/containerService.ts` — **do not change the meaning of the existing `running` field**, `MiniAppViewer` consumes it. Chrome shows `STARTING` / `READY` / `OFFLINE`; OFFLINE `title`: "The assistant stopped. Quit and reopen Acabox." `waitForAgent` (same file) fails fast when the supervisor has given up instead of polling for five minutes.
5. Status bar: the agents segment renders only when n > 0, as `N CHATS WORKING`. Leave CPU/MEM/DISK/UP alone (owner decision pending).
6. `backfillAllAppChatLinks` (`main/index.ts:~1943`): skip `_`-prefixed dirs and dirs with no `manifest.json`.
7. ⌘K and the header "Search chats…" box: when they switch to Chats, focus the Chats search input.

**Acceptance.** Gate green.

---

## T12 — One name, one voice (Q7, C21, C19) — wave 3, split in two

Source list: `docs/design/review-2026-09-30/copy-jargon-audit.md` (cited below as `#N`). Line numbers there are from 2026-09-30 and have moved — find each string by grep. **Skip any string whose code was deleted by wave 1/2** (Debug, Quick Chat, Reactions, Podman rows, SYNCED, AGENTS LIVE, HEALTHY are already handled). Skip #83 (unreachable) and do not copy #67's invented "usually a minute or two".

**The voice rules (both halves):**
- Where Acabox speaks, it speaks in the **first person** ("I", "me"): "Ask me to fix it", "What should I do?". Where the UI labels something neutrally, use **Acabox** ("Starting Acabox…").
- **"Claude" survives only** as a model name in the model picker (e.g. "Claude Opus 5.5"), in "Claude Design" (Anthropic's product), and in "Anthropic API key" contexts. Every other user-visible "Claude" becomes I/me/Acabox (audit §4 lists the sites; re-grep `Claude` in string literals and JSX text).
- Nouns: **tool** (never mini-app/application in UI), **chat** (never conversation/session), **your folders** (never workspace directories), **Show in Finder**, **New chat** (sentence case, including `DEFAULT_SESSION_TITLE` — existing rows keep their stored title; any code that compares against the placeholder must accept both spellings).
- Errors reaching a user: a plain headline + next step; raw text (paths, codes, compiler output) goes behind a "Details" disclosure or into the log, never as the headline.

### T12a — agent identity, chat, tools, shell

1. **Identity.** `main/hostApps/identityPreamble.ts`: replace "Never identify yourself as Claude; you are Acabox." with: "You are Acabox, built on Claude by Anthropic. If asked what you are, say so plainly — "I'm Acabox, built on Claude". Speak in the first person." Keep the rest. Add one paragraph: "The person you are working with is usually a scientist, not a programmer. Use plain language. Keep internal names — directory names, tool ids, error codes, `mcp__` names — out of replies unless asked; name the file, the column and the row count instead. End a turn that changed files by saying which files changed." Update `skills/acabox/SKILL.md`'s voice rule (~lines 39-42) to match (first person, named Acabox, built on Claude; never deny it). Then **delete `main/hostApps/`'s other files if they are a dead stub registry** (CLAUDE.md/review say its only live consumer is the identity preamble): move `IDENTITY_PREAMBLE` to `main/identityPreamble.ts`, update importers, delete the rest of the folder and anything only it used (e.g. `resolveSessionHostApp` in `agentSession.ts` if it only serves dropped host apps — read before deleting; keep behaviour for the remaining caller).
2. **`CS:` → `▸`** in `renderer/chatPreviewStore.ts` and `thread-list.tsx` (search-hit prefix). `You:` stays.
3. **Chat surfaces:** #13, #21 (Chats browse-mode empty state), #22, #23, #28 (one working word: chip `WORKING`; `GENERATING` gone; `THINKING…` only inside the thread), #30, #31, #32 (chips: "Summarise what's in my folders" · "Plot a dataset" · "Turn a spreadsheet into a dashboard"), #34, #47/#48/#49/#50 (funnel raw agent/host errors in main into the plain headlines given in the audit; raw text to the log), #51, #52, #172 (Files empty state).
4. **Step rows (C19):** `renderer/components/assistant-ui/tool-card-display.ts` — use the model's `description` when present, falling back to the command (`description || cmd`, ~line 48); step names per #41 (`command`, `find files`, `search text`, `web page`, `helper`, `checklist`, `your files`); #42 `EXIT n` → `FAILED` (code stays in the expanded body); #43 humanize `mcp__x__y` → `x: y`; delete the dead labels #44 (`tool-labels.ts` dropped integrations) and `approval-buttons.tsx` (#54) if wave 1 left them. Update the step-row tests.
4b. **Two live defects found while verifying wave 1:**
   - `ChatHeader.tsx`: `NAMES ITSELF AFTER THE FIRST REPLY` stays in the header meta after the title has arrived, until navigation (review §2.11 #13). Show it only while the title is still the placeholder — compare against the title the header is actually rendering (both `New Chat` and `New chat` spellings).
   - **A live Stop renders as "Worked · N steps" until reload; history then says "Stopped · N steps".** The live path (`renderer/chatAdapter.ts`) does not mark the aborted message stopped. When the user's Stop aborts the run, yield final metadata `custom.stopped = true` (no `workedMs`) so `turn-steps.tsx` renders `Stopped · N steps` live, matching history. Check how the adapter learns of an abort (the `abortSignal` passed to `run`). Also: live, an empty trailing assistant bubble with only a timestamp appeared after the Stop — find whether the adapter yields an empty message on abort and suppress it.
5. **Tool viewer / build states:** #56 (`ON-DEMAND`), #57/#18 (`PRE-BUILT` branches — delete if no pre-built tool can exist), #64, #65 (build-failed screen: headline "This tool won't open right now.", sub "Something in its code needs fixing. The quickest fix is to let me do it.", primary "Ask me to fix it", secondary "Try again", raw output behind "Show details"), #66, #67 (`STILL WRITING` / "I'm still writing this tool." / "It shows up here as soon as I start on it and opens on its own when I finish."), #68, #69, #70, #73, #80, #81, #86, #87, #88, #89, #90, #179, #183, #187, #188 (container/npm wording only), #130 (delete dead Podman stages in `SetupBanner.tsx` and the `'downloading'` setup state + its "Setting up environment…" copy if nothing else sets it).

### T12b — Settings, Knowledge, Servers, Activity copy

1. **Settings:** #93, #94, #95 (section "Instructions for Acabox"; drop the `.academia/SOUL.md` path from the copy), #96, #97 (Rescan copy only — moving it is fine if trivial), #98, #100 (Base URL behind a "Advanced" disclosure), #103, #104 (transport chip off the row), #106, #107, #109, #110, #111, #112, #113, #114, #115, #117, #118, #119, #123, #124, #126 (Sharing intro — no repo path), #128, #129 (copy only).
2. **Knowledge:** #131, #132, #133 (qPCR placeholders), #134–#146, #149–#155.
3. **Servers:** #156–#167 (copy only; hide `pid`/command on the row per #158 — keep them in the detail panel under a "Technical details" fold), #171.
4. **Files/notebooks/dialogs:** #173, #174, #175, #176 (copy only), #180, #181, #182, #184 (headline + Details), #185.
5. Update tests that assert any changed string.

Both halves: gate green; a final grep for `Claude` in renderer string literals/JSX must show only model names, "Claude Design" and Anthropic-key contexts — list the survivors in the report.
