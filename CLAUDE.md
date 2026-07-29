# Acabox — engineering context

> This file is auto-loaded at the start of every Claude Code session in this
> repo. It is the working-context handoff for whoever (human or agent) picks
> up next. Keep it current: when you finish a meaningful chunk, update the
> "Status" and "Known hazards" sections.
>
> NOTE: this is NOT the workspace-agent instructions. Those live at
> `src/cobuilding/CLAUDE.md` and are read by the Claude that runs *inside* the
> Acabox app. Don't confuse the two.

## What this project is

Acabox (formerly working name `clawdbox`) is a slimmed-down fork of
`academia-edu/academia-electron` — the "Academia Coscientist" Electron app.
The product lets a scientist point the app at local research folders and use
Claude to build, host, and run small local apps ("mini-apps") that work with
their files.

The fork's purpose: **remove the Podman/VM container** (it ate too many
resources) while preserving the three capabilities that matter:

1. Local file access from user-shared folders for data analysis.
2. Mini-apps live, are accessed, and used inside Acabox.
3. **New:** mini-apps can create and run MCP servers that the agent and other
   mini-apps can call.

Dropped on purpose: Apple Notes, Word overlay, browser extension, Google
Drive/Docs, Obsidian, Zotero, CiteRight, grants — and all their MCP servers.

- GitHub: `https://github.com/iliasacademia/acabox` (private). Default branch
  `main` — local `main` tracks the `acabox` remote; push there. The original
  upstream is still wired as the `origin` remote
  (`academia-edu/academia-electron`) for reference only. The earlier
  `clawdbox` remote/repo is retired.
- App identity: package name `acabox`, product name "Acabox", bundle id
  `com.electron.acabox`, userData under
  `~/Library/Application Support/acabox/<channel>`. Deliberately disjoint
  from the original Coscientist app so both can coexist on one machine.

## Architecture (post-slim)

The container is gone. Everything runs as **host child processes** spawned by
the Electron main process:

- **Agent server** — `dist/agent-server.js`, a webpack bundle of
  `src/cobuilding/agent-server/`. Spawned via `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1`. Wraps the Claude Agent SDK `query()` in an
  HTTP/SSE server on `127.0.0.1` (port from `findFreePort(23200..23299)`).
  Talks to the host over SSE; MCP tool calls relay back to the host via
  `mcp-call` SSE events + a `/mcp-result` POST.
- **Jupyter kernel gateway** — spawned from the per-user Python venv on first
  notebook use. Port range `23300..23399`.
- **Python venv** — `~/Library/Application Support/acabox/<channel>/python-venv`.
  Bootstrapped lazily (and now eagerly, in the background, on
  `agentInfrastructure.start`) from system `python3` (3.9+ required). Holds
  `jupyter_kernel_gateway ipykernel pandas numpy matplotlib` plus whatever
  mini-apps install.
- **npm prefix** — `~/Library/Application Support/.../npm-site`. Shared global
  install location for mini-app npm deps. `NODE_PATH` points at
  `<prefix>/lib/node_modules` so esbuild bundles resolve them.
- **Workspace** — `~/Library/Application Support/.../cobuilding-workspace`.
  The agent's cwd. User-shared directories are **symlinked into** this
  workspace (e.g. `<workspace>/MyResearch -> /Users/x/Data/MyResearch`) so the
  agent reaches them with relative paths. Symlinks are resynced on
  `containerService.start()`.

Subprocess env (agent Bash, esbuild, kernel, install wrapper) is built by
`buildSubprocessEnv()` in `containerService.ts`: sets `COSCIENTIST_VENV_DIR`,
`COSCIENTIST_NPM_PREFIX`, `NODE_PATH`, and prepends venv `bin/` + npm `bin/`
to `PATH`.

## Key files

- `src/cobuilding/main/containerService.ts` — `HostProcessService` (replaces
  the old Podman service, same public surface). Spawns/monitors agent server
  + kernel gateway, syncs workspace symlinks, builds subprocess env,
  auto-restarts the agent server on unexpected exit (throttled 3/60s).
- `src/cobuilding/main/agentSession.ts` — host side of a chat turn: waits for
  agent health, creates the agent session, drives the SSE stream, relays MCP
  calls, handles 401 → credential refresh → retry, translates attachment
  paths to workspace-relative.
- `src/cobuilding/agent-server/index.ts` — the agent server itself. MCP relay
  servers: activity, notification, reaction, mini-apps, suggested-tasks,
  workspace. (All the dropped integrations were deleted from here.)
- `src/cobuilding/main/controllers/AgentInfrastructureController.ts` — builds
  the agent config + allowedTools, registers `globalThis.__hostMcpServers`,
  starts the agent server, kicks the background venv bootstrap.
- `src/cobuilding/main/miniAppBuilder.ts` — single esbuild entry point for
  both the renderer Rebuild button and the agent's
  `build_and_open_mini_application` tool. Resolves esbuild from
  `node_modules/.bin`.
- `src/cobuilding/main/miniAppMcpRegistry.ts` — routes agent ↔ mini-app-iframe
  tool calls via `webContents.send` + postMessage, with WebContents-destroyed
  reaping and a 60s invocation timeout.
- `src/cobuilding/main/packageInstaller.ts` — host pip/npm install waves.
  pip → venv pip; npm → `npm -g --prefix <npm-site>`; R/apt refused.
- `src/cobuilding/main/pythonSetup.ts` / `nodeSetup.ts` — venv + npm
  bootstrap/detection helpers. `ensurePythonVenv` is single-flight.
- `src/cobuilding/skills/manage-mini-application/assets/install` — the
  `.applications/install` wrapper the agent uses. Host pip/npm only; reads
  `COSCIENTIST_VENV_DIR` / `COSCIENTIST_NPM_PREFIX`.
- `src/cobuilding/main/freePort.ts` — loopback port probing for the agent
  server + kernel gateway. Electron-free so it can be unit-tested; see the
  header for why the probe address is load-bearing.
- `src/cobuilding/main/secretStore.ts` — `safeStorage` encryption-at-rest for
  the API key and connector auth values, plus the mask/decrypt helpers that
  keep secrets off the IPC boundary.
- `src/cobuilding/main/claudeConfigDir.ts` — resolves + migrates
  `CLAUDE_CONFIG_DIR` (MCP OAuth tokens, transcripts) to userData.
- `src/cobuilding/shared/connectors.ts` — user-configured MCP connectors: the
  catalog (add a service = one entry), id/URL validation, and conversion to the
  SDK's `mcpServers` shape. Shared by main, agent-server, and renderer.
- `src/cobuilding/main/connectorsStore.ts` — connector persistence in
  `cobuilding-settings.json` (host-owned, outside the workspace), observed
  status, and `.mcp.json` detection.
- `src/cobuilding/main/controllers/WorkspaceController.ts` — workspace + shared
  dir management. Dedups directories by `realpath`.
- `forge.config.js` — packaging. Ships `dist/agent-server.js` + skills + hooks
  via `extraResource`; unpacks the Claude SDK native binary from asar.

## Conventions

- **Test with `npm start`** (dev mode). It runs `prestart` (builds the
  agent-server bundle + Rust file monitor) then `electron-forge start`.
- `npm start -- -- --smoke-test` boots all services then exits 0 — use it to
  verify boot without the UI. The real boot-healthy signals are:
  `[AgentServer] Listening`, `[HostProcess] Agent server healthy`,
  `[BackgroundBuilder] Watching`.
- `npx tsc --noEmit` must stay clean before committing.
- Do NOT run `npm run package` for routine testing — production build only.
- Logs: `~/Library/Application Support/acabox/development/cobuilding.log`,
  plus the in-app Debug tab (command log + system log streams).
- To kill stray dev instances:
  `pkill -9 -f "Acabox/node_modules/electron"`.

## Status (last updated 2026-07-28)

**Released v0.1.5 (2026-07-28).** Everything below through the tool-status work
is shipped. Verified after publishing, not just from the release log: the three
assets carry the right 0.1.5 names/sizes, `latest-mac.yml` is **anonymously
downloadable** (the property the updater depends on — no embedded token), its
sha512 matches the built zip byte-for-byte, and the packaged bundle is `valid on
disk / satisfies its Designated Requirement` with `CFBundleShortVersionString`
0.1.5 and id `com.electron.acabox`. Ad-hoc signed as usual (no Developer ID), so
a fresh download still needs right-click → Open; auto-update installs via
`main/selfUpdater.ts` rather than Squirrel.

**Stop, build health, and an Activity surface (2026-07-28).** Closing the three
gaps left by the job registry below. The framing that drove the design: all
three are the same question at different moments — *what is my computer doing
for me, and what happened while I wasn't looking?* — so they share one surface
rather than being three patches.
- **Stopping work was not a convenience, it was a missing emergency brake.**
  There was no way to stop a running tool at all: not from the tool, not from
  the app, and **not by quitting** (verified — the app exits and the work keeps
  going). A tool stuck in a loop, burning CPU or the user's API key, survived
  every gesture short of Activity Monitor. `cancelJob` now kills `command` work
  outright and asks the owning renderer to interrupt `kernel`/`claude` work
  (relayed via `jobs:cancelRequested`; the shell handles it so it works with no
  viewer mounted). Stop lives in the tool header and on every Activity row.
  Cancelled is its own status, distinct from `failed`, because half-written
  output must not be adopted as a result — and it does **not** stamp `lastRun`.
- **Kills walk the process tree, never `kill(-pid)`.** These children are
  spawned without `detached`, so they share Acabox's own process group — a
  negative-pid signal would kill the app itself. `descendantsOf` recurses via
  `pgrep -P`, SIGTERM from the leaves up, SIGKILL to survivors after 3s. Covered
  by a test that builds a real `sh → sh → sleep` tree and asserts every level
  dies (a naive single-pid kill leaves the grandchild running).
- **Quit warns instead of killing (user's call).** `before-quit` shows
  Quit / Stop them and quit / Cancel when work is in flight, so the long-run
  case (close the lid at 6pm, analysis finishes overnight) keeps working while
  never being a silent surprise. Guarded against blocking a headless quit —
  `--smoke-test` and a destroyed-window state skip the prompt.
- **New `main/buildHealth.ts` — build failure is a health state, not a status.**
  Statuses describe what's happening now and are rightly transient; "this tool
  doesn't build" is a property of the tool that stays true while nobody is
  looking. Recorded inside `buildMiniApp` so every build path (Rebuild button
  and the agent's tool) reports identically, persisted to
  `<userData>/tool-build-health.json` — deliberately **not** the manifest, which
  travels on export, where a failure on this machine means nothing. Cleared on
  tool delete so a later tool reusing the dir name doesn't inherit it.
- **New `command-desk/ActivityPanel.tsx`** replaces the old briefings page on
  the under-used Activity tab: *Needs attention* (unseen outcomes + broken
  tools, each with **Ask Claude to fix it**, which composes the real build error
  into a chat turn), *Running now* (with Stop and elapsed time), *Recently
  finished* (24h). Empty sections aren't rendered. Wording never invents an
  outcome — work that outlived a quit reads "result unknown", because we weren't
  its parent and there is no exit code.
- Verified live: a failed build put **BUILD FAILED on the home card with no
  viewer mounted** (impossible before); Stop killed a real `sleep 300` and the
  job read `cancelled`; the Activity panel rendered all three sections with the
  right copy. Plus 19 registry cases (incl. the real process-tree kill) and 29
  store cases. tsc clean; jest 178/179 (only the pre-existing
  `fileMonitorIntegration`); smoke test exits 0.
- **Still not done: notifications.** Deliberately deferred — the design is the
  hard part, not the plumbing. The unit should be the *wait*, not the job (a
  tool making 20 short kernel calls must not fire 20 toasts), tiered by where
  the user is: in-app cue when they're elsewhere in Acabox, OS notification when
  they've switched away, and a digest line on Home for work that finished while
  it was closed. Only for user-started work that ran past ~30s or failed —
  background dep installs must never toast.
- Known nit: `buildFailed` outranks `working` in the chip precedence, so a
  broken tool that is somehow also running shows BUILD FAILED. Activity shows
  both, which is what it's for.

**The host owns a tool's work; status survives navigation and restart
(2026-07-28).** Follow-on to the status rewrite below, which left a real gap:
`clearToolStatus` fired when a tool's viewer unmounted, so the status went dark
while the work carried on. Established by test first: a mini-app's shell command
**completes normally after Acabox has fully quit** (0 Electron processes left,
marker file still written on schedule) — `exec` children aren't in the
`before-quit` teardown and a POSIX child outlives its parent.
- **New `main/jobRegistry.ts`** — a persisted, host-owned record of what each
  tool is doing (`<userData>/tool-jobs.json`). `container:execLogged` opens a
  job itself when `appDirName` is set (it owns the child process, and gets its
  pid via the new `exec(..., {onSpawn})`); the renderer reports what main can't
  see for itself — kernel runs and Claude calls — over `jobs:begin`/`jobs:end`,
  tagged with the reporting WebContents so its death closes them out.
- **Boot reconciliation is per-kind, because survival is per-kind.** A `command`
  may genuinely still be running, so its pid is checked and the job re-adopted;
  `kernel` dies with the app (the gateway is killed in `before-quit`) and
  `claude` is an HTTP call from main, so both are reported **interrupted** and
  never as running. An adopted job whose process is gone becomes
  `finishedWhileAway` — it ran unsupervised, so claiming it succeeded would be
  a guess. Adopted pids are polled (3s) since nothing will notify us.
- **Bug caught by the test, not by reading:** the pid fingerprint originally
  included the command line, but `sh -c "…"` **execs** into the program it runs,
  so `ps` reports `/bin/sh -c sleep 30` at spawn and `sleep 30` moments later —
  every shell command would have failed to re-adopt. The signature is now start
  time only (pid + start time is unique; pid reuse gets a new start time).
- **Consequences in the UI.** The home/rail chip is no longer unreachable: a
  tool with work in flight reads **WORKING** with no viewer open. `StatusBar`
  gained a "N TOOLS WORKING" segment (hidden at zero) — the only always-visible
  surface. New `interrupted` status renders **RAN WHILE CLOSED** /
  **INTERRUPTED**, cleared when the user opens the tool (`jobs:acknowledge`).
  `lastRun` is now stamped by **main** on job completion, so it records work the
  renderer never saw finish; the renderer-side `miniApps:markRun` IPC is gone.
- **Tools are now expected to be resumable** (the other half — results must
  outlive the UI, not just the status). `useAppState` exposes `lastRunAt`; new
  `@reusable/useRunsWhileClosed` compares it against the host's job history and
  reports runs that completed while the tool was closed, via a new
  `jobs:listForApp` bridge call, so the app can re-read `output/run_metadata.json`
  and adopt results it never got to record. SKILL.md gained a "Your UI is not
  where the work lives" section making this a rule rather than a nicety.
- Verified live end-to-end, not just unit-tested: work started with **no viewer
  open** lit the home card WORKING + "1 TOOL WORKING"; quitting Acabox left 0
  Electron processes with the work still alive; **reopening showed WORKING again
  immediately**; and when the process exited at t+70s the card flipped to RAN
  WHILE CLOSED. Plus 14 jest cases against the real registry (adopt/interrupt/
  recycled-pid/persistence, exercised against real live and real dead pids) and
  10 more on the store's host-job merge. tsc clean; jest 173/174 (only the
  pre-existing `fileMonitorIntegration`).
- Not done: no notification when work finishes while you're elsewhere, and no
  way to cancel a running job from the UI. Both are natural next steps now that
  the jobs are enumerable.

**Measured: what an open tool actually costs in memory (2026-07-28).** Taken to
size a "keep tools alive when you navigate away" decision. Method: dev build,
one **fresh app launch per condition** (tool tabs persist in app state, so
conditions leak into each other otherwise), median of 5 samples, macOS
`phys_footprint` — the number Activity Monitor calls "Memory".
- **All mini-apps share ONE renderer process, not one each.** Verified with 1,
  2, 3 and 4 tools open simultaneously — always exactly 1 extra process. They
  are all same-origin (`local-file://`), so Chromium's site isolation puts them
  together. Any reasoning that assumes a process per tool is wrong.
- Simultaneously-open tools (React tool w/ a 250-row table): **1 → 36 MB,
  2 → 42 MB, 3 → 46 MB, 4 → 51 MB.** So the *first* tool costs ~36 MB (mostly
  the shared process itself, paid once) and each additional ordinary tool adds
  only **~5 MB**.
- By weight, measured alone: trivial (no framework) **21 MB**, typical React
  **36 MB**, heavy (120k parsed records held in memory) **145 MB**.
- **Conclusion: memory is not the constraint on keeping tools warm.** Four
  ordinary tools ≈ 51 MB. The risk is concentrated entirely in data-heavy
  tools — one is worth ~3 typical ones — so any eviction policy should be
  **memory-aware, not count-aware** ("keep the last 3" is the wrong shape).
  The real arguments against keep-alive are non-memory: unattended CPU/API
  spend, silently stale data, and invisible accumulation.
- Caveat: the app's own dev baseline (~650 MB) is inflated by dev tooling and
  is **not** a production number; no prod baseline was captured. The per-tool
  figures do transfer, since the mini-app bundle is identical in both.

**Removed the stale signing scripts + the wrong release warning (2026-07-28).**
`release.mjs` warned that "macOS auto-update will download but FAIL to install
until Developer-ID signed + notarized (Squirrel.Mac refuses unsigned updates)"
— untrue since `main/selfUpdater.ts` took over the install step precisely to
remove that requirement. It now states what is actually true: auto-update
works, and the only consequence of an ad-hoc build is Gatekeeper on a *fresh
download* (right-click → Open). Also deleted the `codesign`, `package:sign`
and `make:sign` npm scripts: they ran `codesign` **after** the dmg/zip were
built, so they never reached the distributed artifact, and forge's
`postPackage` hook already ad-hoc signs at the correct point (before the
makers). They were dead and actively misleading — running `make:sign` would
have produced an artifact no better than `make`, with the false impression it
was signed. The Squirrel references left in `selfUpdater.ts`/`updater.ts` are
accurate and explain why that module exists; they stay.

**Port isolation + secrets at rest (2026-07-28).** Two hazards the connector
work surfaced, both fixed and verified live.

*Dev no longer hijacks the packaged app's agent server.* `findFreePort` probed
`0.0.0.0` while both host servers bind `127.0.0.1`; on macOS the wildcard bind
succeeds while loopback is held, so a dev instance called 23200 "free" while
the packaged app served on it, then `isAgentServerHealthy()` saw a 200 and
adopted it — wrong workspace, wrong key, wrong channel.
- Probe moved to `main/freePort.ts` (electron-free, so it is unit-testable)
  and binds `127.0.0.1`. **The rule is that the probe must perform exactly the
  bind the server performs.** Measured: wildcard and loopback do *not* collide
  in either direction on macOS, so loopback probing is not "stricter" — it is
  simply the same question `listen()` asks. An earlier comment claiming it was
  strictly stricter was wrong and the test that disproved it is kept.
- `/health` now returns `instance` (a per-app-run token passed as
  `COSCIENTIST_AGENT_INSTANCE`) and `workspace`; adoption requires a token
  match, so a stranger's server *or our own orphan from a crashed run* is
  replaced rather than driven. Probe host is the `127.0.0.1` literal, not
  `localhost` (which can resolve to `::1` first). If the cached port is taken
  after our process dies, we re-pick instead of spawning onto a dead bind.
- Verified live: with the packaged app holding 23200, dev now starts on
  **23201** and both coexist.

*Secrets are encrypted at rest and out of the agent's reach.* The trigger is
in the user's own transcript: the agent read `cobuilding-settings.json` while
answering a question and printed the API key into the chat.
- New `main/secretStore.ts` wraps Electron `safeStorage` (macOS Keychain) with
  an `enc:v1:<base64>` envelope. Applied to `customAnthropicApiKey` **and**
  connector headers/env. Legacy plaintext reads through untouched and is
  re-encrypted once at boot (`migratePlaintextApiKey`,
  `migratePlaintextConnectorSecrets`, both after `whenReady` — `safeStorage`
  throws before it). Falls back to plaintext with a warning where the OS has
  no keyring rather than refusing to save.
- **Secrets never cross IPC.** `listConnectors()` returns header *keys* with
  blank values; `listConnectorsWithSecrets()` (main-only) is what builds the
  agent config. A blank value on save means "keep the stored one", so editing
  a URL doesn't wipe the token; deleting the row removes it.
- `CLAUDE_CONFIG_DIR` moved from `<workspace>/.academia/claude-config` to
  userData (`main/claudeConfigDir.ts`, with migration). It holds `mcpOAuth` —
  access/refresh tokens for every connector the user signs in to — and was
  sitting in the agent's own cwd. Session resume is unaffected (the SDK keys
  projects off `cwd`, which didn't change).
- **`agent.json` moved too, and this one mattered most.** It is the SDK's
  input, so it holds the *raw* key and *decrypted* headers and cannot be
  encrypted — and it was being written to `<workspace>/.academia/agent.json`.
  Encrypting settings.json while leaving that would have been theatre. Now
  userData, mode 0600, with the legacy in-workspace copy deleted on boot.
- New `hooks/block-secret-reads.sh` (PreToolUse on `Bash` and
  `Read|Edit|Write`) denies those paths. Honest scope: with unrestricted Bash
  this is a guardrail against incidental leakage, **not** a security boundary;
  the encryption is the real control.
- Verified: 11/11 secretStore assertions against the **real macOS keychain**
  in a real Electron main process (jest can't — `ELECTRON_RUN_AS_NODE` has no
  `safeStorage`); 12/12 over CDP on the live app (ciphertext on disk, no
  plaintext anywhere in the file, blank-on-IPC, secret preserved across an
  edit, replaced when retyped, dropped when the row is deleted); a **real chat
  turn** round-tripped "ENCRYPTION OK" proving the decrypt path still feeds
  the SDK; and the screenshot scenario re-run against the live agent — asked
  to `cat` the settings file it was blocked and answered without any secret in
  the transcript. jest 150/150 (15 new), tsc clean, smoke exits 0.

**Tool status states are now truthful; RUNNING is gone (2026-07-28).** Every
tool the user had ever opened claimed **RUNNING** on the home grid while doing
nothing. There were two disjoint status systems both using that word:
`liveToolDirNames` (home + rail) was literally "a viewer tab is open this
session", while `toolStatusStore`'s `running` was the *else-branch* of the
build/install lifecycle — never set deliberately, and the default for any tool
with no entry. Neither had any notion of the tool executing something.
- **One vocabulary, one store.** `toolStatusStore.ts` now merges *lifecycle*
  (`installing` / `building` / `buildFailed`, pushed by MiniAppViewer via the
  renamed `setToolLifecycle`) with *activity* (`working`, ref-counted). `idle`
  is the resting state and the default. Precedence: buildFailed > building >
  installing > working > idle. Idle tools are **absent** from the snapshot map,
  so surfaces that only signal news render nothing on a miss.
- **WORKING is derived from operations the host already brokers** — no new
  mini-app API, so tools built before today report it. `ACTIVITY_BRIDGE_TYPES`
  in MiniAppViewer wraps `executeCode`, `executeCommand`, `anthropic:complete`
  and `anthropic:stream` (the stream closes its episode on done/error, not when
  the handler returns), plus agent→mini-app MCP invocations (opened at the
  `mcp:invoke` postMessage, closed at the matching `mcp:result`). File I/O and
  `mcp:callTool` are **deliberately excluded** — millisecond-scale, would strobe.
- **Anti-flicker: 200ms delay-in, 800ms minimum-visible.** A sub-200ms op never
  shows; a shown op stays readable; a new op inside the hold-out keeps WORKING
  continuously instead of blinking.
- **Home cards and the rail carry a chip/dot only when non-idle.** An idle tool
  shows nothing at all, so any chip means something is genuinely happening.
  The viewer header always has a chip and spells `IDLE` out.
- **Real `lastRun`.** The card metric said "LAST 22M" sourced from
  `lastOpened` — the same class of lie. New `miniApps:markRun` IPC stamps
  `manifest.lastRun` when an activity episode ends (trailing-edge collapsed 3s
  in the renderer so a burst of short ops is one write). Cards read
  `LAST RUN …`, falling back to `OPENED …`, then `NEW`.
- Verified live over CDP against a running app with a throwaway fixture tool
  driving a **real** `executeCommand` through the bridge: baseline `IDLE` →
  `WORKING` at 214ms → held across the whole 3s → `IDLE` at 3060ms; a 50ms op
  never showed; `BUILDING` caught at 10ms and cleared at 44ms (a 34ms build —
  coarser sampling misses it); `BUILD FAILED` observed on a genuinely broken
  build; `lastRun` landed on disk and the card read `LAST RUN NOW`; and
  `RUNNING`/`SLEEPING` appear nowhere in the rendered document. 19 new jest
  cases against the real store (timing, precedence, ref-counting, stale-end
  safety) plus one that renders `useToolStatus` through React. tsc clean;
  jest 133/134 (only the pre-existing `fileMonitorIntegration`).
- **Gap found here, FIXED the same day by the job registry above:** navigating
  away from a tool unmounts its viewer and destroys the iframe (verified: 0
  iframe CDP targets after nav), which fired `clearToolStatus` — so a home card
  could never actually light up, and the work kept running unobserved. Host-owned
  jobs make `working` reachable with no viewer mounted. Still true and still
  unfixed: `building`/`installing` are written directly with no delay-in, so a
  34ms build flashes; and `buildFailed` is viewer-local, so it still disappears
  from the grid when you leave the tool (only *jobs* survive, not lifecycle).
  **`buildFailed` FIXED later the same day** by `buildHealth.ts` — see the top
  of Status. The `building`/`installing` flash is still real.

**De-Podman'd the agent-facing docs; `containerAPI` → `hostAPI` (2026-07-28).**
The mini-app bridge still exposed `window.containerAPI.exec` documented as
"execute a command in the Podman container", and the drift ran much wider than
that one line. Three defects were **actively wrong**, not merely dated:
- **The PreToolUse hook's rejection message was a trap.** `block-host-installs.sh`
  told the agent to use `.applications/install R` / `install apt` — which the
  wrapper hard-refuses (`assets/install:70`, `packageInstaller.ts:366`). Agent
  runs `apt-get install` → blocked, redirected to the wrapper → wrapper refuses.
  Two guaranteed wasted turns. The message now states plainly that apt/R/conda
  have no wrapper equivalent and must not be retried. Same fix in
  `src/cobuilding/CLAUDE.md` and `manage-mini-application/SKILL.md`.
- **The documented esbuild snippet could not work.** It passed
  `--alias:@reusable=/data/.applications/_reusable`, a container path. Verified
  against the real production workspace: the absolute `$PWD/...` form builds
  clean (exit 0, 14.5 MB bundle), while both the container path and a relative
  path fail — esbuild does not resolve a relative alias against cwd. Corrected,
  with the reason recorded so nobody "simplifies" it back.
- **Two skills claimed packages that are not installed.** `geo-database` claimed
  `GEOparse`, `pdb-database` claimed `rcsb-api`; neither is in the venv (checked
  with real `pip list`). Both now say so and give the install command. Across the
  10 database skills, "pre-installed in the container" is replaced with the
  guaranteed set (`pandas`/`numpy`/`matplotlib` = `REQUIRED_PACKAGES`), noting
  `requests` is present only **transitively** via jupyter-kernel-gateway, so an
  app that depends on it should declare it.
- **`window.hostAPI` is the new bridge name**, with `containerAPI` kept as a
  one-line alias to the same object (mini-apps can be exported/imported, so the
  full consumer set isn't enumerable; the shared `_bridge/` is force-overwritten
  on every boot, so there's no per-app opt-out). The postMessage wire type was
  already correctly named `executeCommand`, so nothing host-side changed. Delete
  the alias once no shared app references it. `bridge-api.md` now documents what
  `exec` really does: host child process, cwd = workspace root, venv + npm-prefix
  `bin/` on PATH, and **exitCode 127 = never launched** (a missing dependency,
  not a failed analysis) — a distinction callers kept getting wrong.
- **Found dead, flagged not deleted:** the `differential-expression` skill and
  the `differentialExpression` mini-app template are both unrunnable. The
  template hardcodes `kernel: "ir"`; verified against the real gateway that only
  `python3` is registered and there is no R binary on the machine, and R cannot
  be installed. Both are now marked non-functional in the docs the agent reads
  (so no turn is wasted scaffolding a tool that fails on first Run) and point at
  `pydeseq2` as the Python route. **Deleting them is a product call — not made.**
  Likewise `scripts/bench-build.sh`, which benchmarks building a `Dockerfile.base`
  that no longer exists and which nothing references.
- Verified: `tsc --noEmit` clean; jest 114/115 (only the pre-existing
  `fileMonitorIntegration`); the edited hook re-tested end-to-end (exit 2 +
  new message on `apt-get install`, exit 0 on a harmless command); and the
  renamed bridge bundled with the **real** esbuild and executed in JSDOM —
  7/7 assertions incl. `hostAPI === containerAPI` and both posting identical
  `executeCommand` messages. Note `bridge.ts` is **not** in the tsc project
  (it ships as source, bundled per-app), so a clean typecheck proves nothing
  about it — hence the execution test.

**Connectors: user-configured MCP servers (2026-07-28).** Settings → Connectors
lets the user attach external MCP services (Hex, Sentry, Notion, Linear,
GitHub, or Custom). Every behavioural claim below was measured against the
bundled SDK/CLI, not inferred from docs.
- **What was already true.** `settingSources: ['project']` (needed for
  CLAUDE.md) *also* loads a project `.mcp.json`, so the workspace could always
  have grown connectors. What silently does **not** work is `claude mcp add` —
  its default (**local**) and `--scope user` writes land in `.claude.json`,
  which `['project']` never reads. Measured: `['project']`→`[]`,
  `['project','local']`→`[hexlocal]`, `['user','project','local']`→both.
- **Host-owned, not workspace-owned.** Connectors live in a `connectors` array
  in `cobuilding-settings.json` (userData), *not* in the workspace — the agent
  has Write+Bash on the workspace, and an agent that can add an arbitrary
  remote MCP server can exfiltrate it. `.mcp.json` can't be turned off without
  losing CLAUDE.md, so `detectUnmanagedMcpJson` surfaces one in Settings with a
  Remove button instead.
- **Live apply, no new chat.** New `POST /connectors` on the agent server calls
  `query.setMcpServers()` on every live session. **Trap, verified:**
  `setMcpServers` *replaces* the whole dynamic set, and Acabox's relay servers
  (activity, mini-apps, workspace, notification, reaction) are themselves
  dynamic — sending only the connectors returned `removed:['relaydemo']` and
  killed them. `applyConnectorsToSession` always sends relay+connectors
  together; nothing else may call `setMcpServers`.
- **Second trap, verified:** a server passed in the original `mcpServers`
  option that never got past `needs-auth` is *not* dropped by
  `setMcpServers({})` (returns `removed:[]`, stays in `mcpServerStatus()`).
  `toggleMcpServer(name, false)` does disable it, so that's the backstop —
  applied only to names we ourselves supplied, never a relay or a `.mcp.json`
  server.
- **OAuth works headlessly.** A needs-auth server exposes
  `mcp__<id>__authenticate` / `..._complete_authentication`; the first returns a
  real authorize URL with a `http://localhost:<port>/callback` redirect. It
  works end-to-end because links already open in the system browser
  (2026-07-27), the CLI subprocess survives across turns (streaming
  `userMessageGenerator`), and tokens persist to `mcpOAuth` in `.claude.json`
  under `CLAUDE_CONFIG_DIR`.
- **`allowedTools` is not what gates this.** Measured: with Acabox's exact list
  and hex omitted, `mcp__hex__authenticate` still ran; `allowedTools: []` still
  ran `Bash`. It is auto-approve, not a restriction, and there is no
  `canUseTool` handler anywhere. `connectorAllowedTools()` adds `mcp__<id>`
  per connector so this is correct rather than accidental.
- Status shown in the UI is observed only — captured from the SDK `system`/
  `init` event (`mcp_servers`) and `mcpServerStatus()`. No session yet → the row
  says "Unknown", never a fabricated "Connected".
- New files: `shared/connectors.ts` (types + catalog + validation + SDK
  serialization; **adding a service is one entry in `CONNECTOR_CATALOG`**),
  `main/connectorsStore.ts`, `renderer/components/ConnectorsSettings.{tsx,css}`.
  Touched: agent-server `index.ts`/`sessionConfig.ts`, `containerService.ts`,
  `AgentInfrastructureController.ts`, `main/index.ts`, `preload.ts`,
  `types.d.ts`, `DirectoryPermissions.tsx`, `skills/acabox/SKILL.md`.
- Verified: `tsc --noEmit` clean; jest **115/115** (24 new); **11/11** against
  the REAL built `dist/agent-server.js` on its own port and workspace (relay
  survival, live add, live removal, clear); **14/14** driving the real app over
  CDP (IPC round-trip, main-side rejection of bad ids / remote plaintext http /
  reserved names, enable-disable persistence, UI rendering, catalog picker,
  custom form) plus screenshots; smoke test exits 0.
- Secrets note: connector headers are stored **plaintext** in settings.json,
  same as `customAnthropicApiKey`. The UI says so. `safeStorage` is the upgrade
  if that ever needs to change — for both, together.
- **The `findFreePort` hazard bit this during testing** and is worth fixing: a
  running packaged Acabox owned `127.0.0.1:23200`, the dev instance's
  `0.0.0.0` probe called it free, and dev then drove the *packaged* app's agent
  server — which has no `/connectors` route, so status came back
  `{"error":"Not found"}`. Both connector read paths now tolerate that, but the
  one-word fix (probe `127.0.0.1`) is still not applied.

## Earlier status (last updated 2026-07-27)

**Links open in the system browser; agent got `WebFetch` (2026-07-27).** Two
things, after an evaluation of embedding a Chromium browsing surface concluded
**don't** (Electron 37 = Chromium 138, EOL 2026-01-13, so browsing the open web
would run 13 months of unpatched Chromium; and authenticated interactive
automation would close the prompt-injection trifecta against an agent that has
auto-approved `Bash` with no `canUseTool` gate anywhere in the app).
- **`WebFetch` added to `allowedTools`** (`AgentInfrastructureController.ts`).
  It was missing while `database-lookup/SKILL.md` and `reaction/SKILL.md` both
  instruct the agent to call it. Note `allowedTools` is **auto-approve, not a
  restriction** — the SDK's restriction option is `tools`, which this app never
  sets, so with the `claude_code` preset the agent has the full toolset and
  anything off the list just falls to the default permission path with no
  handler to answer it. Also de-Podman'd the two stale skills (they still said
  "Running in the container" / "use `podman exec`") and corrected their
  "`requests` and `pandas` pre-installed in the container" line.
- **Every surfaced link now opens in the default browser.** New
  `main/externalLinks.ts`, installed on **every** WebContents via
  `app.on('web-contents-created')` before `whenReady`, so it also covers code
  not yet written. `setWindowOpenHandler` denies all `window.open`/`_blank` and
  hands remote http(s) to `shell.openExternal`; `will-frame-navigate` cancels
  remote navigation and does the same. Deliberately **not** also listening to
  `will-navigate` — it is main-frame-only and would double-fire, opening two
  tabs. Both reuse `validateExternalUrl`, so guards can't become a looser
  second door to `shell.openExternal` than the existing IPC.
  `shared/urlTargets.ts` holds the one definition of "internal" (`file:`,
  `local-file:`, `about:`/`data:`/`blob:`, devtools, and http(s) on loopback).
  This fixed two live bugs: `XlsxView.tsx`'s `target="_blank"` hyperlinks and
  `PaperMonitorView.tsx`'s `window.open` both spawned a bare BrowserWindow
  inheriting our preload, and any stray `<a href>` navigated the whole app away
  with no back button.
- **Mini-app links needed a different mechanism, established by testing not
  inference.** Two dead ends, both ruled out live: (1) a listener attached from
  MiniAppViewer can't work — a mini-app frame is `local-file://` while the host
  is `localhost:3000`/`file://`, so `iframe.contentDocument` is cross-origin and
  null (an interceptor written this way was built, proven inert, and deleted);
  (2) letting the frame navigate so the main guard catches it can't work either
  — the host CSP `frame-src local-file: http://localhost:*` makes Chromium
  refuse it ("Refused to frame 'https://…'") *before* `will-frame-navigate`
  fires, so the click silently did nothing. Note the CSP violation report is
  also useless as a signal: it strips the path (`https://example.com/`).
  Fix: `main/miniAppLinkShim.ts`, a script injected into every `local-file:`
  subframe on `did-frame-navigate` via `webFrameMain.executeJavaScript`, which
  routes clicks through the `{type:'openExternal', id, url}` bridge
  MiniAppViewer already exposes (and which validates `event.source`).
- Verified live over CDP against the running app, not just read: chat-style
  anchor click and `window.open` both logged `[ExternalLinks] Opening in default
  browser (navigation | window.open)` with the app never navigating away and
  `window.open` returning null; and a real `local-file:` fixture frame produced
  the bridge message with the **full URL incl. path**, with the four
  `frame-src` CSP violations that the same fixture produced beforehand dropping
  to zero. `tsc --noEmit` clean; jest 90/91 (only the pre-existing
  `fileMonitorIntegration`), including 9 cases on the shared predicate and 8
  that evaluate the **actual shipped shim string** in a fresh JSDOM window per
  case rather than a reimplementation; smoke test exits 0.
- Not done (deliberately, see the evaluation): no in-app reader view, no
  headless browsing tool for the agent, no browser tab. Those were staged 1–3
  and are not started.

**macOS auto-update works without a Developer ID (2026-07-27).** v0.1.2 shipped
and the tray "Check for Updates…" reached the install step and died there:

    Code signature at URL file:///…/com.electron.acabox.ShipIt/update.wdWeDhW/
    Acabox.app/ did not pass validation: code failed to satisfy specified code
    requirement(s)

That is the predicted ad-hoc/cdhash failure (see Known hazards) and it is
unfixable by configuration — the check is inside Squirrel's ShipIt binary.
Rather than block on an Apple Developer ID, the install step is now ours:
- **New `main/selfUpdater.ts`.** electron-updater still does **detection only**
  (it reads `latest-mac.yml` off the release and compares versions — that part
  always worked). On accept we download the zip the manifest names, verify the
  manifest's **sha512**, `ditto -x -k` it into a staging dir **beside** the
  installed bundle (same volume, so the final move is a rename not a 180MB
  copy), validate the unpacked bundle (CFBundleIdentifier,
  CFBundleShortVersionString == the expected version, `codesign --verify
  --strict` to catch transit corruption), then spawn a **detached bash script**
  that waits for our pid to exit and swaps the bundles.
- **Swap safety.** The old bundle is *moved aside*, never deleted first, so
  there is no window with nothing installed; any failure rolls it back. If the
  app is somehow still alive after 60s the script **aborts** rather than
  replace a running bundle. Swap log: `~/Library/Logs/Acabox/update-swap.log`.
- `autoUpdater.autoInstallOnAppQuit` is now **false** and the
  `update-downloaded`/`download-progress` handlers are gone — nothing may hand
  Squirrel a payload, including the quit-time path, which would fail silently.
- Preflight (`checkSelfUpdateSupported`) runs at boot and logs whether a swap
  is possible: refuses non-darwin, dev mode, an unresolvable bundle, an
  **App Translocation** path (a quarantined app runs from a read-only shadow
  copy — swapping it would silently do nothing), or an unwritable parent dir.
- Verified before shipping: 15/15 sandbox assertions against the **real**
  extracted swap script (happy path, rollback when the new bundle vanishes
  mid-swap, refusal while the pid is alive, paths containing spaces) using fake
  bundles in a temp dir; and the whole download→validate pipeline against the
  **real published v0.1.2 artifact** — sha512 base64 matches the manifest,
  `ditto` yields `Acabox.app`, bundle id / version / `codesign --verify` all
  pass.
- **Delete this module once there's a Developer ID** — plain Squirrel beats
  anything hand-rolled. It is self-contained for exactly that reason.

**Model/effort pinned per chat + many chats per tool (2026-07-27).** Two
user-requested features, both verified live over CDP against a running app.
- **Model + effort are now pinned to the conversation and displayed.** They
  were never actually pinned: `chat:send` only read the picker when no
  in-memory session existed, and `sessionRegistry` destroys a session as soon
  as its last subscriber detaches (i.e. after *every* turn), so each turn
  silently re-read whatever the picker then said. DB migration **31** adds
  `sessions.model` / `sessions.effort`, written **once** on the first turn and
  reused forever after (`setSessionModelInfo` is a write-once
  `... WHERE ... IS NULL` update, so a pin cannot drift mid-conversation).
  `model` is captured from the Agent SDK's `system`/`init` event — the id it
  actually **resolved**, not what we asked for; `effort` is what we sent (the
  SDK does not echo it back). Shown as a mono `OPUS 5 · HIGH` meta line in both
  `ChatHeader` and the tool side-panel header, via the new shared
  `command-desk/useSessionMeta.ts`. Rows predating the migration are NULL and
  render **no chip** rather than a guess (no-mocks rule); they pin on their
  next turn.
- **Incidental real bug this surfaced:** `ModelSelector` is the only thing that
  calls `registerModelContextProvider`, and it's mounted solely in the docked
  `GlobalComposer` — which is hidden in tool detail view. So chats started in a
  tool side panel sent **no model at all** and silently got the agent-server
  default, ignoring the picker. Pre-existing, but load-bearing once we pin.
  `chatAdapter.ts` now falls back to `getSelectedModel()`, mirroring what
  `effort` already did.
- **A tool can now own many chats.** The link was `manifest.chatSessionId` →
  exactly one chat. It's now the `sessions.app_dir_name` column (added by
  migration 15, indexed, and never used until now). New
  `sessions:listForApp` / `sessions:createForApp` IPCs; the side-panel header
  is two rows (title-as-dropdown · GENERATING · ＋ · pop-out · collapse, over
  the model meta), the dropdown lists that tool's chats **newest-message-first**.
  Ordering is `MAX(messages.created_at)`, deliberately **not** `updated_at` —
  `updateSessionTitle` bumps `updated_at`, so a rename would have jumped a chat
  to the top. Opening a tool loads its most recently active chat; `＋` reuses an
  existing unused chat instead of stacking empties; switching chats keeps the
  tool view open (`suppressThreadDeactivateRef`). Chats-list rows carry a tool
  chip. A boot sweep (`backfillAllAppChatLinks`) populates the column from
  existing manifests, which also let `ChatHeader` drop a per-chat
  `.applications/*` directory scan.
- Also fixed: pre-creating app chat rows would have made `isFirstMessage`
  (`!existingDbSession`) permanently false, so new app chats would never
  auto-title. Redefined as "no messages yet AND title is still the
  `DEFAULT_SESSION_TITLE` placeholder".
- Verified: tsc clean; smoke test exits 0; jest 67/68 (only the pre-existing
  `fileMonitorIntegration`); a 22-assertion harness against the **real**
  `chatRepository` + migration chain (incl. "rename does not reorder" and
  "second write is ignored"); and live CDP — with the picker set to
  Haiku/Low, a turn in a pinned chat logged
  `Session created: … model=claude-opus-5 effort=high`.

**Chat now refuses cleanly with no API key (2026-07-27).** A keyless build
answered chat turns with Claude Code's own "Not logged in · Please run /login"
— meaningless in a fork with no login. (Trigger in the wild: the *packaged*
app uses the `production` userData channel, and the key only ever existed in
`development/cobuilding-settings.json`; `.env.local` is empty and a
GUI-launched app inherits no shell env, so `resolveApiKey()` returned null.)
Three edits:
- `main/index.ts` — new `NO_API_KEY_MESSAGE` constant (also reused at the two
  existing literal sites), and a guard at the head of the `chat:send` handler,
  above the dedup / already-running / calendar / `createAgentSession` branches
  so no session is ever created or re-messaged without a key. It checks the
  in-memory store first, then re-resolves env → settings from disk (same
  two-step as the reference-file converter) so a key added out-of-band counts.
  Reported via `event.sender.send('chat:error', …)` and a **resolved** invoke —
  *not* a throw: Electron wraps a rejected `invoke` as "Error invoking remote
  method 'chat:send': …" and preload forwards `.message` verbatim, which would
  put IPC plumbing in front of the user's instructions.
- `agent-server/index.ts` — `startQuery()` refuses an empty
  `sessionConfig.anthropicApiKey` before flipping `state.running`. Defence in
  depth: the key is snapshotted at `createSession()` and `POST /credentials`
  only updates `currentConfig`, so a session born keyless stays keyless, and
  handing `''` to the SDK blanks the inherited env key. The throw is caught by
  the existing IIFE and broadcast as an `error` SSE → `chat:error`.
- Both messages stay free of `401`/`token`/`unauthorized` so
  `agentSession.isAuthError()` can't reclassify them as retryable.

Verified at runtime, not just by reading: (1) real app driven over CDP with the
settings file stashed — the thread rendered exactly "No Anthropic API key
configured. Add one in Settings.", no `/login`, no IPC prefix, log shows
`[chat:send] Refusing turn`, no session created, and **zero rows persisted**
for that thread (a refused turn isn't saved — matches the `No active
workspace` early-return); (2) regression — with the key restored, a real turn
round-tripped and the DB holds `assistant: "ACABOX WORKS"`, `is_error:false`;
(3) the agent-server guard exercised standalone against the built bundle on
its own port — empty key → `error` SSE with the exact message and `query()`
never starts; key present → `Starting query()` and no guard message.
`tsc --noEmit` clean; jest 67/68 (only the pre-existing `fileMonitorIntegration`
failure). Still open: no first-run banner pointing at Settings, so a fresh
install is silent until the user sends a message and reads the refusal.

**macOS "…is damaged" / code-signing fixed; prod build validated (2026-07-24).**
A downloaded packaged build showed *""Acabox" is damaged and can't be opened."*
Root cause: with no Developer ID, the Electron fuses flip left an **invalid**
ad-hoc signature (`Info.plist=not bound`, identifier `com.github.Electron`);
invalid signature + the browser's `com.apple.quarantine` = "damaged" on Apple
Silicon.
- **Fix:** forge.config's new `postPackage` hook ad-hoc re-signs the whole
  bundle (`codesign --force --deep --sign -`) after packaging/fuses, before the
  dmg/zip makers — only when `APPLE_IDENTITY` is unset (a real identity signs
  during packaging via `osxSign`). Verified on the **published** v0.1.1 dmg:
  `codesign --verify` → "valid on disk / satisfies its Designated Requirement",
  identifier `com.electron.acabox`, Info.plist now bound. Downloaders now get
  "unidentified developer" → **right-click → Open** (works), not "damaged".
  A clean download (no prompt) + macOS auto-*install* still require Developer ID
  + notarization.
- **Published v0.1.1** with the fix; **deleted the broken v0.1.0** (release +
  tag). `release.mjs` now always runs `npm run make` (osxSign covers Developer
  ID, the postPackage hook covers ad-hoc; the old `make:sign` codesign step ran
  after the dmg and never reached the artifact).
- **Dev gotcha that cost hours:** `ELECTRON_RUN_AS_NODE=1` in a shell makes a
  direct `Acabox.app/Contents/MacOS/Acabox` exec run as **Node** (reads stdin,
  exits 0) — it looks exactly like an instant silent crash but the app is fine.
  Test packaged launches via Finder / `open`, or `env -u ELECTRON_RUN_AS_NODE`.
  Also note: packaged logs go to the **`production`** channel
  (`~/Library/Application Support/acabox/production/cobuilding.log`), and console
  logging is off when packaged.

**Update pipeline switched to GitHub Releases + prod build unblocked
(2026-07-24).** The leftover Coscientist S3/CloudFront auto-update vertical is
replaced with GitHub Releases; the prod build no longer needs any secret env.
- **Build gate removed.** `webpack.plugins.js` used to `throw` on any non-dev
  build unless `CLOUDFRONT_DOMAIN` was set — this silently blocked `npm run
  make`. Removed the gate + the now-unused `CLOUDFRONT_DOMAIN` DefinePlugin
  entry. `npm run make` now runs clean with zero env (verified: full make →
  `out/make/Acabox-0.0.1-arm64.dmg` + `…/zip/darwin/arm64/Acabox-darwin-arm64-0.0.1.zip`).
- **Updater → GitHub provider.** `updater.ts` now uses `electron-updater`'s
  `github` provider (`iliasacademia/acabox-releases`, env-overridable), dropped
  the custom `channel = 'acabox'` (default channel matches the standard
  `latest-mac.yml`), and added a silent check-on-launch. Gated on
  `app.isPackaged`; degrades gracefully (logs, no crash) when there's no
  release/repo.
- **Release command.** `npm run release` (`scripts/release.mjs`): builds with
  plain `npm run make` (see 2026-07-28 — `make:sign` was wrong and is gone), reuses
  `scripts/generate-update-manifest.js` to emit `latest-mac.yml`, and
  `gh release create v<version>` with the zip + dmg + yml. Supports
  `--dry-run` / `--skip-make` / `--repo`. Verified end-to-end in dry-run
  against a real build (correct sha512/size yml, correct asset set, correct
  `gh` command).
- **Deleted dead CloudFront pieces:** `scripts/update-manifest.js`
  (CloudFront URL-rewriter), `src/utils/validateCloudFrontDomain.{js,d.ts}`.
  Kept `scripts/generate-update-manifest.js` (the sha512/yml generator, reused).
- **First release published + verified (v0.1.0).** `iliasacademia/acabox-releases`
  is created, public, and seeded — a brand-new repo has no default branch, so it
  needed one initial commit before `gh release create` would work (422
  "Repository is empty" otherwise). `npm run release` published v0.1.0 (dmg +
  zip + `latest-mac.yml`); confirmed `latest-mac.yml` is anonymously
  downloadable (the proof the public-repo path lets the updater read it without
  a token). `release.mjs` now `rm -rf out/make` before building so a version
  bump can't leave stale artifacts that get uploaded / mis-referenced in the
  metadata. Remaining gap: **Apple Developer ID** — Mac builds are unsigned, so
  Mac auto-*install* still won't work (Win/Linux fine); auto-update *detection*
  only exercises on the next release (bump `version` → `npm run release`).
  `tsc --noEmit` clean.

**Files tab now hides internal dot-dirs (2026-07-24).** Fix for "Home says no
files but I have files": the Home "Drive" card (`files:findByExtension`) has
always skipped dotfiles at every level, so on a blank workspace (no shared
folders) it correctly showed "No files yet". But the **Files tab** listed the
workspace tree *including* Acabox's internal `.applications`/`.claude`/`.academia`
dirs, so it looked populated while Home said empty — the source of the confusion.
Fix: `FilesTab.tsx`'s `isHiddenWorkspaceEntry` now also returns true for any
name starting with `.` (was `~$`-only). It's the single predicate used by
`loadRoot`, `loadChildren`, and `countFilesFromEntries`, so root + subdir
listings + the FILES count all now exclude dotfiles — the Files tab and Home
agree (blank workspace → "0 FILES", empty tree). Standard file-browser
convention; also drops incidental `.git`/`.DS_Store` inside research folders.
New jest case in `FilesTab.test.tsx` asserts the three internal dot-dirs are
hidden while a real file (`Data.csv`) still renders. Verified: tsc clean, full
jest green (68/68), and live via CDP against `npm start` (Files tab shows
"0 FILES" + only the `workspace-data` root, no children).

**Tool cleanup + code/data separation (2026-07-24).** Two changes:
- **All 7 pre-built stub tools removed.** Deleted `availableTools.ts`
  (`AVAILABLE_TOOLS_STUB`) and every consumer: the ToolsPage "Other available
  tools" section + all stub-only machinery (file-picker modal, Word-overlay
  handlers, `handleStubAction`/`handleOpenFilePicker`/`handlePickFile`/
  `handleBrowseFile`, `reactionsStatus`, the `onOpenReactions` prop), the
  CommandDesk home-grid stub cards, and the rail/home tool counts (now
  `activeApps.length`). The Reactions *scheduled* feature (cron task, `reaction`
  agent MCP, `ScheduledTaskEditor`, settings) and its notification deep-link
  view (`ReactionsToolView`, `toolsViewMode==='reactions'`) are untouched — only
  the tools-list card is gone. Still-dead-regardless files left for a separate
  pass: `ReactionsSidebar.tsx`, `FocusEditor.tsx`, `mcpServers/reactionMcpServer.ts`.
- **Tool code and tool data are now separated on disk.** A mini-app's working
  files live under `<workspace>/tool-data/<dir>/{input,output}/` (durable); the
  code dir `.applications/<dir>/` reaches them via relative symlinks
  (`input`/`output` -> `../../tool-data/<dir>/...`). Every existing path
  convention (`.applications/<dir>/output/...`) keeps working transparently
  through the symlinks — no change to `useAppState` or app code. **Deleting a
  tool now removes only its code and keeps its data.** Pieces:
  `shared/paths.ts` (`TOOL_DATA_DIR`); `main/toolDataMigration.ts`
  (`ensureToolDataLayout` — idempotent boot sweep that migrates pre-split apps +
  `ensureToolDataLayoutForApp` for scaffold/import), called from `index.ts` boot
  and after `miniApps:import`; new `miniApps:delete` IPC (stashes the tool name
  in `tool-data/<dir>/.tool-meta.json`, unlinks the symlinks, then rm's the code
  dir; GCs empty data dirs); `miniApps:export` now `cp`s with `dereference:true`
  so zips carry real data; the scaffold (`manage_mini_app.mjs`) creates the
  split layout + symlinks. ToolsPage/MiniAppsTab delete via the new IPC.
- **Browse saved data in-app.** New `toolData:list`/`toolData:delete` IPCs +
  `toolDataAPI` (preload/types). ToolsPage grew a "Saved data" section (shown
  when a deleted tool left files) with Reveal-in-Finder, an inline recursive
  file list, an in-page `FileViewer` modal, and Delete-data. CSS in App.css
  (`toolsSection__note`, `savedFilesList*`, `savedFileViewer*`).
- Verified: `tsc --noEmit` clean; smoke test boots clean + exits 0; jest green
  except the pre-existing `fileMonitorIntegration` failure; and a standalone
  harness exercising the REAL migration module + REAL scaffold script confirmed
  all 12 assertions incl. the core guarantee (delete code → data survives in
  tool-data, readable through the symlink). Note: boot migration wasn't
  exercised against a live app (none present in dev workspace) — covered by the
  harness instead.

**Done & verified:**
- Boots clean, `tsc --noEmit` clean, smoke-test exits 0.
- Podman fully removed; agent server + kernel gateway run as host processes.
- Install wrapper rewritten for host (runtime-tested with missing-env cases).
- Mini-app MCP publishing wired end-to-end (not yet exercised with a real app).
- Dead-code cleanup: ~80k lines of dropped integrations, no-op IPCs, vestigial
  debug UI, stale skills (google-drive, grant-finder), podman-warn hook.
- Login-shell PATH resolution for packaged builds (`shellPath.ts`, wired into
  `buildSubprocessEnv`, npm probe, python discovery). Ledger: BUGS.md.
- Renamed product to **Acabox** (was Academia Coscientist / clawdbox): app
  name, bundle id, userData dir, protocol declaration, UI strings, analytics
  event_type (`AcaboxEvent`), logging service tag, cookie-store salt. The
  userData move means first launch after the rename bootstraps a fresh
  venv/npm-site/workspace/DB.
- Development moved to `https://github.com/iliasacademia/acabox`.
- **Removed academia login entirely.** No welcome-gated academia session, QR
  auth, deep-link scheme, or credential gateway. The Claude API key comes from
  the user: `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` env (dev via `.env.local`)
  or the Settings screen (stored in settings.json). Resolved into the in-memory
  credential store at boot (`resolveApiKey`/`loadCredentialsIntoStore` in
  `index.ts`), before the agent starts. Renderer always boots straight into
  the app shell — no key gate (onboarding removed entirely, see below);
  Settings has an `ApiKeySettings` section. Analytics
  stays gated off (no academia egress). The academia backend client
  (`apiClient`, `academia:fetch`) is kept but optional — used only by mini-apps,
  degrades to 401 if invoked without a session.

**Command Desk shell implemented (2026-07-23).** The Home design from
`docs/design/design_handoff_acabox_home/` is now the app shell + home screen.
Verified live via CDP screenshots (rail expand/collapse, nav, composer focus,
fonts, real chats/files data). Key facts:
- New components in `src/cobuilding/renderer/components/command-desk/`
  (ChromeBar, Rail, StatusBar, CommandDesk, useHomeData, MSymbol) + all styles
  and design tokens in `src/cobuilding/renderer/commandDesk.css`.
- Shell layout: ChromeBar (real title bar — main window is now
  `titleBarStyle: 'hiddenInset'`) → rail + content column → docked
  GlobalComposer (rewritten to spec) → status bar. Legacy tabs (Chats, Tools,
  Files, Debug, Settings) render unrestyled inside the new shell — restyling
  them is future work with no design spec yet.
- Fonts self-hosted (`renderer/assets/fonts/`, woff2 webpack asset rule):
  DM Sans, IBM Plex Mono, Material Symbols. Old screens now get real DM Sans
  (previously silently fell back to system fonts). Mini-app tool icons stay
  lucide (manifests name lucide icons); everything else uses Material Symbols.
- The old briefings Home (`HomePage.tsx`) moved to a new "Activity" nav tab.
- Real data: chats via `sessionsAPI`, drive card via `files:findByExtension`
  (handler now also returns `size` + absolute `path`), tools via
  `miniAppsAPI`; app version via webpack `process.env.APP_VERSION` define.
- Status bar shows real host stats via `stats:get` IPC
  (`main/systemStats.ts`): CPU% (os.cpus() delta), memory (Activity-Monitor
  formula via vm_stat: anonymous − purgeable + wired + compressed), disk
  (statfs on homedir, decimal units to match Finder), running-agent count,
  app uptime. Nothing in the status bar is mocked.
- Dev menu bar says "Acabox": `scripts/rename-dev-electron.js` (runs in
  prestart) rewrites CFBundleName/DisplayName of the dev
  `node_modules/electron/dist/Electron.app` and ad-hoc re-signs it;
  idempotent, self-heals a stale signature, re-applies after npm install.
  Packaged builds were already named via packagerConfig.
- Superseded 2026-07-28: the RUNNING/SLEEPING tab-open heuristic is gone — see
  the tool-status entries at the top of Status, where the **host-side** job
  registry now lets a tool report state with no viewer mounted, and cancel
  exists. Still deferred: per-job progress, notifications, and ⌘K opens the
  chats list instead of a real command palette.
- Tool archiving (2026-07-23): `archived: true`/`archivedAt` in the app's
  manifest.json (travels with the folder on export). `miniApps:setArchived`
  IPC + preload; Tools page grew an "Archived" section (hidden when empty)
  with dimmed rows + Restore/Delete; Archive lives in each active row's
  Settings panel next to Delete. Archived apps are filtered out of the home
  grid, rail badge, and pinned list (`activeApps` in index.tsx); ToolsPage
  got an `onAppsChanged` callback so archive/delete/import refresh the shell
  immediately. Verified end-to-end via CDP (archive → Archived section, badge
  7→8, manifest round-trip, restore).
- Manifest write race FIXED (2026-07-23): opening a tool fires several
  concurrent read-modify-writes on the same manifest.json (miniApps:touch,
  tool:opened, sessions:findForApp); fs.writeFile truncates in place, so a
  torn read parsed as "no manifest" and tool:opened rewrote it from scratch —
  observed live destroying name/description/icon (and would destroy
  archived). All manifest writers now go through `main/manifestIO.ts`:
  atomic temp-file+rename writes and per-path serialized update queues
  (touch, setArchived, tool:opened, findForApp, manifest migration).
- Home tools grid (2026-07-23): section renamed "Instruments" → "Tools" and
  it now shows the same inventory as the Tools page — real mini-apps first,
  then the pre-built tools (shared source of truth:
  `renderer/components/availableTools.ts`, extracted from ToolsPage's
  hardcoded stub list). Pre-built cards navigate to the Tools page where
  their real actions live; rail Tools badge counts apps + pre-built. Note:
  several pre-built entries target dropped features (Grant Finder,
  Peer Review→Word overlay) or are pure placeholders (Literature Synthesis,
  Paper Monitor, Citation Alerts alert "placeholder for now") — candidates
  for the next removal/re-point pass alongside the writing_agent hazard.

**Design unification Phase A done (2026-07-23).** All legacy screens
(Chats list, Tools, Files, Activity, Settings, modals/dropdowns) restyled
into the Command Desk language via a palette sweep (warm/tan hexes → design
tokens, Gupter → DM Sans) across App.css + component CSS, plus targeted
rewrites (mono section labels/eyebrows, 8px card radii, blue primary/XS
buttons, pale-blue hovers). Verified via CDP screenshots of every tab.
Also removed per user directive ("no mocks in prod"): the blinking-cursor
motif, and ToolsPage's fabricated stub timestamps/statuses ("ran this
morning · 4 items" etc. — only the real Reactions enabled-state remains).
Phase B (chat thread, mini-app viewer chrome, onboarding — screens needing
real design decisions) is briefed in `docs/design/phase-b-design-brief.md`,
to be run through the design tool; implement its handoffs when they land.

**Design unification Phase B done (2026-07-23).** The three Phase-B handoff
screens (`docs/design/design_handoff_acabox_phase_b/`) are implemented and
verified live via CDP screenshots. All styles in
`renderer/phaseB.css` (zero new tokens; `cd*` classes off commandDesk.css).
- **Chat view** — new `command-desk/ChatHeader.tsx` (back · title · mono
  model meta · GENERATING chip · Open-tool when the chat owns a mini-app,
  found by scanning `.applications/*/manifest.json` for `chatSessionId` ·
  rename · delete) + a full rewrite of `assistant-ui/thread.tsx` into the
  Command Desk language: 760px centered column, right-aligned user bubbles
  with attachment chips + timestamps, plain assistant blocks with a mono
  meta line (`N TOOL CALLS · HH:MM`), day separators, working indicator
  (`THINKING…`/`WORKING — …`), streaming heartbeat dot (CSS `::after`, not a
  cursor), empty state ("Where to?" + profile-seeded chips), jump-to-latest
  pill. `turnAnchor` default flipped `top`→`bottom` so short threads bottom-
  anchor with no phantom scroll/stray pill. Markdown restyled in
  `.cdAsst .auiMd`. Message `createdAt` now threaded through
  `historyMessageConverter` so timestamps/day-separators are real.
- **Tool-call cards** — `assistant-ui/tool-fallback.tsx` rewritten as
  instrument readouts (status dot · MSymbol · mono name · key args · right
  meta · chevron; error tint + auto-expand). Name/icon/args mapping in
  `assistant-ui/tool-card-display.ts`. `progressStore` gained
  `useToolFinalElapsed` for completed-card durations.
- **Tool viewer** — new `command-desk/ToolWorkspace.tsx` (tab bar with
  per-tool status dots + close/middle-click, viewer header, drag-resizable
  320–560 chat side panel persisted to localStorage, collapsed 44px strip
  with vertical label + unread dot, more-menu). `MiniAppViewer.tsx` header
  restyled + first-boot dependency interstitial and build-error state
  redesigned to spec; live per-tool status flows through new
  `toolStatusStore.ts`. Replaces the old react-resizable-panels layout in
  `index.tsx`.
- **Onboarding** — new `command-desk/Onboarding.tsx` is a single 5-step
  component (welcome · API key + validation error · workspace dirs with
  read-only toggles · live scanning · scan review) rendered in the chrome +
  `StatusBar firstRun` frame, no rail. Replaces WelcomeScreen /
  ApiKeyOnboarding / WorkspaceOnboarding / ScanningProgress /
  ScanResultsReview (all deleted) and the `App()` step machine in
  `index.tsx` (now a 3-state boot gate). Esc-to-stop wired via `EscStopsRun`.
  **Superseded:** onboarding was removed entirely later the same day — see
  "Onboarding flow removed" below.
- Deleted with their screens: the 5 onboarding components + CSS,
  `assistant-ui/overlay-file-picker.tsx`,
  `assistant-ui/find-and-replace-suggestion.tsx`, and ~700 lines of stale
  thread/message/tool CSS from App.css. `chat-composer.tsx` is now the
  narrow side-panel composer only (attach + model picker live in the docked
  GlobalComposer). `tsc --noEmit` clean; jest green except the pre-existing
  `fileMonitorIntegration` failure (fails identically on a clean tree).
- Known gap (not a mock): per-directory FILES·SIZE meta in onboarding step 3
  is omitted — the workspace-directory API doesn't expose counts, and
  fabricating them would violate "no mocks in prod"; needs a new stat IPC.

**Model lineup refreshed (2026-07-23; Opus 5 added 2026-07-24).** Chat picker
(`ModelSelector.tsx`) now offers Fable 5 / Opus 5 / Opus 4.8 / Sonnet 5 /
Haiku 4.5 (**default now `claude-opus-5`**; stale localStorage selections
sanitized on init). Agent-server default also bumped to `claude-opus-5`
(`AgentInfrastructureController.ts`); mini-app proxy allowlist
(`ANTHROPIC_ALLOWED_MODELS` in `main/index.ts`) extended with the new IDs,
old ones kept. Opus 5 is same-priced as Opus 4.8 ($5/$25), 1M context, same
API surface (adaptive thinking only, no `budget_tokens`, effort defaults
`high`), no data-retention requirement — a clean drop-in; verified as the
exact API ID `claude-opus-5` against the live models doc. Decision:
**Claude-only** — no LiteLLM / Cloudflare gateway / multi-provider; the
Agent SDK harness is Claude-specific, and `ANTHROPIC_BASE_URL` already
exists as the power-user proxy hook. Caveat: Fable 5 needs 30-day org data
retention (400s on ZDR) and may return `stop_reason: refusal` on bio/cyber-
adjacent content. **Models are a hardcoded list in three places — there is
no auto-discovery**; adding a model is a manual 3-edit change (picker
array + agent-server default + proxy allowlist).

**Suggested-tasks feature fully removed (2026-07-23).** Per user directive
(simplify; remove unneeded upstream features), the entire "suggested tasks"
vertical is gone: the quick + in-depth task-suggestion scan agents
(`directoryScanner/agents/taskSuggestion.ts`), the hourly
BriefingsController re-scan cycle (was ≤$5 of Sonnet per hour on the user's
API key), the `suggested-tasks` MCP server (host handlers + agent-server
relay + allowedTools + workspace skill), the notification bell UI +
`notifications` DB writes (`NotificationsController`/`notificationsRepository`
deleted; DB migration v26 left in place, table now orphaned/harmless), the
Home/Tools suggestion cards, the suggestion→tool attribution plumbing
(`tool:setThreadAttribution`, renderer pending-attribution queue;
`tool.created` now always `creation_source: 'chat'`), and the dead
`paper`/`citation`/`grant` briefing card branches (no producers since the
fork). What remains: the initial workspace scan runs the research-profile +
file-tagging agents only; briefings are now only `writing_agent` manuscript
cards (from file tagging); the chat agent's `mcp__notification__show_notification`
desktop-toast tool is unchanged. `BriefingsController` shrank to just
`runInitialWorkspaceScan`. Verified: tsc clean, smoke test exits 0 with all
boot-healthy signals, stale skill auto-pruned from the workspace on boot.

**FIXED (2026-07-23): "Not logged in · Please run /login" on chat turns.**
Root cause: the bundled Claude Code binary only honors an env
`ANTHROPIC_API_KEY` when the key is "approved" — interactive Claude prompts
and stores the key's LAST 20 CHARS in `customApiKeyResponses.approved` of
`.claude.json` (CLAUDE_CONFIG_DIR). Headless SDK runs can never answer that
prompt, so any user-supplied key was refused (reproduced with the raw binary;
approval-entry format verified from the binary: `RS(H){return H.slice(-20)}`).
Fix: `shared/claudeConfigApproval.ts` (`ensureApiKeyApproved`) writes the
approval before every SDK invocation — called in `agent-server/index.ts`
startQuery() and `directoryScanner/shared.ts` buildCommonQueryOptions() (the
scanner had the same latent bug). Verified end-to-end: real chat turn
round-tripped ("Reply with exactly: ACABOX WORKS" → "ACABOX WORKS",
is_error:false) and title generation named the session.
Also fixed in the same pass: TitleGen crashed post-save on a dead upstream
`require('../../server/events/wordPollEventBus')` (removed), and its failure
log printed the RAW API KEY into cobuilding.log (now `hasApiKey=` boolean;
existing log files scrubbed). "A real chat turn" can move out of the
"NOT yet tested" list below.

**Brand "B-box" mark + app icon implemented (2026-07-23).** The new logo
(rounded blue `#0645b1` tile, white B-box glyph that reads as **B** and as a
box + prompt-wedge) replaces the old academia/`play_arrow` marks everywhere.
Sources of truth are three SVGs in `src/assets/brand/` (mark-master for ≥64px,
optically-corrected mark-small for ≤32px, glyph-template for the menu bar) plus
`acabox-wordmark.svg` (the only sanctioned lockup). `scripts/gen-icons.mjs`
(Node + `@resvg/resvg-js`, a new dev dep, + macOS `iconutil`) rasterizes each
size DIRECTLY from SVG — small classes from the small master, ≥64px from the
large master — and emits, into `src/assets/icons/`: `dock-icon.icns` (all 10
size classes), `dock-icon.png` (1024 master, for the tray/dock compositor),
and `trayTemplate.png`/`@2x` (menu-bar template image). Rerun with
`node scripts/gen-icons.mjs` whenever the mark changes. In-app: new
`AcaboxMark` component (renderer/components/command-desk) renders the mark as an
`<img>`; swapped into the rail chip (28px), chrome bar (16px), and onboarding
step 1 badge (48px master). `tray.ts` now uses the glyph as an `isTemplate`
menu-bar image (auto light/dark/tint); the old pixel-compositing tray helper
and the stale `tray.icns` were removed (dev dock icon still cyan-tinted).
Verified: tsc clean, dev smoke test boots all services + tray created, `.icns`
round-trips to all 10 sizes, and the three in-app placements were screenshotted
in real Chromium (real CSS + SVGs) and look correct. Caveat: `prune:false`
means `@resvg/resvg-js` ships in packaged builds as dead weight (dev-only tool,
never required at runtime) — negligible next to the other bundled devDeps.

**Onboarding flow removed (2026-07-23).** Per user directive ("we don't need
onboarding for acabox"), the first-run onboarding is gone entirely; the app
always boots straight into the Command Desk shell.
- Main boot (`main/index.ts`): if `loadActiveWorkspace()` finds nothing, it
  creates a **blank workspace** (zero shared directories) via
  `workspaceController.create([], apiKey)` — so an active workspace is now a
  boot invariant. The user adds folders (Settings → Workspace directories)
  and the API key (Settings → Account) afterwards.
- Deleted: `command-desk/Onboarding.tsx` + its entire CSS block in
  `phaseB.css`, the renderer `App()` boot gate (now: fetch workspace →
  ChatView), `StatusBar`'s `firstRun` prop, the `debug:restartOnboarding`
  IPC (main/preload/types), the `workspaces:create` IPC (main/preload/types;
  workspace creation is main-boot-only now), and
  `WorkspaceController.deactivateAll` / `deactivateAllWorkspaces` (dead).
- Settings "Restart onboarding" row replaced by **"Rescan workspace"**
  (runs `scannerAPI.start()` — still the only trigger for the
  research-profile + file-tagging scan, which used to run in onboarding
  step 4; it silently no-ops without directories or an API key).
- Hard reset (Debug tab) now wipes and **relaunches the app** via
  `app.relaunch()` + `app.quit()` inside `debug:hardResetWorkspace`; boot
  then creates a fresh blank workspace.
- `thread.tsx`'s setup progress bar reused onboarding CSS classes — renamed
  to `.cdProgressBar`/`.cdProgressBar__fill` (kept in phaseB.css).
- Verified: tsc clean, smoke test exits 0, jest green except the
  pre-existing `fileMonitorIntegration` failure. The fresh-install path
  (no workspace row → blank workspace auto-created) is code-reviewed but
  not runtime-tested against a virgin userData dir.

**NOT yet tested at runtime (highest priority next):**
- A real chat turn — agent doing Bash/Read/Write against a shared dir.
- `.applications/install pip <pkg>` against a real venv.
- Mini-app build → iframe load → bridge tool calls.
- Notebook → kernel gateway → Python execution.
- A mini-app that publishes an MCP the agent then calls.
- Production package launch: **now tested & working** (2026-07-24). `npm run
  package`/`make` produce an app that boots (window + agent server). It is
  ad-hoc signed via the forge `postPackage` hook (see below); a *downloaded*
  copy is still quarantined → "unidentified developer" (right-click → Open)
  until Developer-ID + notarization. Full chat/mini-app/notebook flows in the
  packaged build remain to be exercised.

## Known hazards (design constraints, not bugs)

- **Read-only directories are advisory only.** The agent is told via
  `workspaceDirectoriesGuidance` text, but `Write`/`Edit` still hit the
  filesystem. Real enforcement would need a PreToolUse hook that checks the
  DB read-only flag.
- ~~**`findFreePort` probes the wrong interface — dev can hijack prod's agent
  server.**~~ **FIXED 2026-07-28** — see the Status entry. The probe now binds
  `127.0.0.1` (`main/freePort.ts`, extracted so it is unit-testable), and
  `/health` echoes a per-app-run instance token that `isAgentServerHealthy()`
  requires before adopting a server. Note the rule that matters if this is
  ever touched again: the probe must perform **exactly** the bind the server
  performs, not a stricter one — measured on macOS, wildcard and loopback
  binds do not collide in *either* direction, so "probe the wildcard to be
  safe" is not conservative, it is just wrong.
- **Mid-session directory changes don't refresh agent context** — new dirs
  only surface to the next chat session (guidance is set at session create).
- **ContainerTests debug panel is stale** — it runs old container commands
  (`ls /data`, `R --version`); failures there are cosmetic.
- **Requires system Python 3.9+ and npm on PATH** for Python/npm mini-app
  deps. No bundled Python yet (python-build-standalone is a future option).
- **Auto-update runs on GitHub Releases now (was CloudFront).** `updater.ts`
  uses `electron-updater`'s **github** provider (`iliasacademia/acabox-releases`,
  overridable via `ACABOX_UPDATE_OWNER`/`ACABOX_UPDATE_REPO`), default channel
  (`latest-mac.yml`). `npm run release` (`scripts/release.mjs`) builds →
  generates metadata (`scripts/generate-update-manifest.js`) → `gh release
  create`. The public releases repo
  `iliasacademia/acabox-releases` is set up. **Detection is confirmed working**
  (2026-07-27): the production log shows `[UPDATER] Configured GitHub Releases
  feed` → `[UPDATER] No update available.` on a real v0.1.1 install, i.e. the
  feed is fetched, `latest-mac.yml` parsed, and versions compared. Note
  `app-update.yml` omits `updaterCacheDirName`, so electron-updater logs an
  error and falls back to `app.name` — cosmetic, one-line fix if it ever
  matters. `setFeedURL` means the yml is only consulted for that cache dir.
  Two gotchas for the record: a brand-new release repo must be **seeded with
  one commit** before `gh release create` works (empty repo → 422 "Repository
  is empty"; done once); and **Squirrel.Mac auto-*install* needs a Developer
  ID** — which is why the install step is no longer Squirrel's (see
  `main/selfUpdater.ts` and the Status entry). The underlying constraint still
  governs any return to Squirrel:
  Concretely: `codesign -d -r- /Applications/Acabox.app` →
  `designated => cdhash H"…"`, i.e. the ad-hoc DR is a hash of that exact
  build. Squirrel.Mac validates the downloaded bundle against the **running**
  app's designated requirement, and a new build always has a different cdhash,
  so it can never satisfy it. Not fixable in config — the DR has to be
  identity-based. Everything for signing is already wired (forge.config reads
  `APPLE_IDENTITY` → `osxSign` with hardenedRuntime + `entitlements.plist`, and
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` → `osxNotarize`; the
  ad-hoc `postPackage` hook self-disables); what's missing is only the cert
  (`security find-identity -v -p codesigning` → 0 valid identities). **The
  first signed release still cannot update the ad-hoc installs** — the running
  build's DR is a cdhash regardless of how the new one is signed — so one
  manual reinstall is unavoidable at that transition. Untested under hardened
  runtime: the agent server spawns with `ELECTRON_RUN_AS_NODE=1`; the
  `RunAsNode` fuse is `true` and the entitlements cover jit /
  unsigned-executable-memory / disable-library-validation /
  allow-dyld-environment-variables, so it should survive — confirm
  `[HostProcess] Agent server healthy` on the first signed build.
  Only **arm64** is built; Intel Macs get nothing, and adding an x64 build
  would clobber `latest-mac.yml` in the same release (`release.mjs` writes one
  manifest per run and does not merge). There is a silent check-on-launch (10s
  after ready) plus the tray "Check for Updates…" manual path.
- **No Anthropic API key = no agent.** With login and onboarding gone, a
  fresh install boots straight to the Command Desk with no key prompt; chat
  and scans fail until a key is set (env or Settings → Account). Surfaced as
  "No Anthropic API key configured. Add one in Settings." — not a crash.
  (Until 2026-07-27 this was only true of the *scan* path: chat ran the turn
  anyway and the user got Claude Code's own "Not logged in · Please run
  /login". Fixed — see the Status entry.) There is no first-run nudge toward
  Settings; candidate for a small banner if this trips real users.
- **`academia:fetch` is unauthenticated now.** Mini-apps that call it (the old
  grant-finder bridge) get 401s since there's no session. Core features don't
  use it. Kept as an optional path, not removed.
- **Analytics is gated off** (no login flips the auth gate), so `track()` is a
  no-op and nothing is posted to academia. `coscientistAnalytics` +
  `apiClient`/`apiCall` are kept but dormant; re-enable against a fork-owned
  backend if ever wanted.
- **`writing_agent` briefings target the dropped Word overlay.** File tagging
  still creates "review your manuscript intro" cards (one Haiku call per
  manuscript found during a scan), and clicking them calls
  `fileMonitorAPI.openFile(..., 'com.microsoft.Word')` + overlay docking —
  a flow from the upstream Word-overlay feature this fork nominally dropped.
  Candidate for the next removal pass (or re-point at an in-app chat flow);
  parts of the overlay plumbing evidently still exist.
