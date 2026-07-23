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
  `pkill -9 -f "Desktop-app-without-container/node_modules/electron"`.

## Status (last updated 2026-07-22)

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
- **`cobuilding-agent://` deep-link scheme is shared with the original
  Coscientist app.** The academia.edu QR-auth flow constructs those URLs, so
  the scheme can't be renamed client-side; whichever app launched most
  recently receives the callback. Fallback: manual 6-digit code entry.
- **Analytics event_type is now `AcaboxEvent`** — the academia.edu backend
  registers event classes per type, so events are likely dropped server-side
  (fail-safe) until/unless a backend class is added. This is intentional: it
  stops fork events polluting the original app's dashboards.
- **Vestigial upstream CI/build files still present** (recommended for
  deletion, kept pending owner sign-off): `buildspec.yml`, `sign-app.js`,
  `test-cleanup.sh`, `.github/workflows/build.yml`,
  `scripts/reset-{downloads,dev}.sh`, `scripts/cleanup-old-paths.sh`. The
  GitHub workflow would overwrite the ORIGINAL app's S3 update manifests if
  upstream secrets were ever configured on this repo.
