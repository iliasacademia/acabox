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

## Status (last updated 2026-07-23)

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
  `index.ts`), before the agent starts. Renderer boots straight in when a key
  exists (gate = `auth:getApiKeyStatus`), else shows the key-entry screen
  (`ApiKeyOnboarding`); Settings has an `ApiKeySettings` section. Analytics
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
- Still deferred: tool run-status lifecycle (cards show RUNNING only while
  the tool's tab is open, SLEEPING otherwise; busy/crashed/progress states
  dormant), ⌘K opens the chats list instead of a real command palette.
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

**Model lineup refreshed (2026-07-23).** Chat picker (`ModelSelector.tsx`)
now offers Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5 (default Opus 4.8;
stale localStorage selections sanitized on init). Agent-server default
bumped to `claude-opus-4-8` (`AgentInfrastructureController.ts`); mini-app
proxy allowlist (`ANTHROPIC_ALLOWED_MODELS` in `main/index.ts`) extended
with the new IDs, old ones kept. Decision: **Claude-only** — no LiteLLM /
Cloudflare gateway / multi-provider; the Agent SDK harness is
Claude-specific, and `ANTHROPIC_BASE_URL` already exists as the power-user
proxy hook. Caveat: Fable 5 needs 30-day org data retention (400s on ZDR)
and may return `stop_reason: refusal` on bio/cyber-adjacent content.

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

**NOT yet tested at runtime (highest priority next):**
- A real chat turn — agent doing Bash/Read/Write against a shared dir.
- `.applications/install pip <pkg>` against a real venv.
- Mini-app build → iframe load → bridge tool calls.
- Notebook → kernel gateway → Python execution.
- A mini-app that publishes an MCP the agent then calls.
- Production package (`npm run package`) launch.

## Known hazards (design constraints, not bugs)

- **Read-only directories are advisory only.** The agent is told via
  `workspaceDirectoriesGuidance` text, but `Write`/`Edit` still hit the
  filesystem. Real enforcement would need a PreToolUse hook that checks the
  DB read-only flag.
- **`findFreePort` race** — check-then-bind window; rare "agent failed to
  become healthy" on port contention.
- **Mid-session directory changes don't refresh agent context** — new dirs
  only surface to the next chat session (guidance is set at session create).
- **ContainerTests debug panel is stale** — it runs old container commands
  (`ls /data`, `R --version`); failures there are cosmetic.
- **Requires system Python 3.9+ and npm on PATH** for Python/npm mini-app
  deps. No bundled Python yet (python-build-standalone is a future option).
- **No release feed yet.** The auto-updater now points at an `/acabox` channel
  (was `/cobuild`, the ORIGINAL app's channel — it would have offered the other
  product as an "update"). Until an Acabox feed exists, packaged-build update
  checks 404 harmlessly.
- **No Anthropic API key = no agent.** With login gone, the app boots but chat
  and scans fail until a key is set (env or Settings). This is surfaced as
  "No Anthropic API key configured. Add one in Settings." — not a crash.
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
