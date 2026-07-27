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

## Status (last updated 2026-07-27)

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
- **Release command.** `npm run release` (`scripts/release.mjs`): builds
  (`make:sign` if `APPLE_IDENTITY` set, else `make`), reuses
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
- Still deferred: tool run-status lifecycle (cards show RUNNING only while
  the tool's tab is open, SLEEPING otherwise; busy/crashed/progress states
  dormant), ⌘K opens the chats list instead of a real command palette.
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
- **`findFreePort` probes the wrong interface — dev can hijack prod's agent
  server.** `findFreePort` (containerService.ts:36) binds `0.0.0.0:<port>` to
  test availability, but the agent server binds `127.0.0.1:<port>`. On macOS
  the wildcard bind *succeeds* while 127.0.0.1 is occupied, so with the
  packaged app running on 23200 a dev instance picks 23200 too, its
  `isAgentServerHealthy()` GET hits the **packaged app's** agent server, logs
  "[HostProcess] Agent server already healthy", and drives it — wrong
  workspace, wrong API key, wrong channel. Reproduced 2026-07-27 (a keyless
  dev boot happily served a chat turn using the packaged app's key). Fix is
  one word: probe `127.0.0.1` instead of `0.0.0.0`. Same root cause as the
  old "check-then-bind race" note; the race is real too but secondary.
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
  is empty"; done once); and **macOS auto-*install* needs a Developer ID**.
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
