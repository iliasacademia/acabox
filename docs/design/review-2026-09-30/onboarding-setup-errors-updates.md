# Acabox review — First run, prerequisites, API key, folders, permissions, updates, crash/privacy, distribution

Reader: onboarding/setup/errors/updates. Read-only review of the repo at
`/Users/iliasbeshimov/Documents/Dev Folders/Acabox` (v0.1.27, `main` clean). All paths below
are relative to `src/cobuilding/` unless they start with a root-level name (`README.md`,
`forge.config.js`, `scripts/`, `docs/`). Nothing was run; "unverified" marks claims that rest on
reading code plus known macOS behaviour rather than on a live run.

Audience lens throughout: a scientist who can describe what they want, cannot read code,
never opens Terminal, and cannot debug a build.

---

## 0. Executive summary

The product's hard parts (agent, tools, proxy, sharing, search) are far more finished than its
first five minutes. A stock Mac with nothing installed can **chat and analyse files**, but it
**cannot build a single tool**: the scaffold is a `node` script and the "already installed"
React/Plotly packages are installed by `npm` — neither ships with macOS, neither is bundled, and
nothing in the app says so. Before that, the user has to survive a macOS 15 Gatekeeper dance
that the docs still describe with the pre-Sequoia "right-click → Open", a Keychain prompt with
no explanation, an app that silently probes `python3` on every launch (which on a Mac without
Command Line Tools pops Apple's "install the developer tools?" dialog), and an API-key field at
the bottom of Settings that offers no link, no validation and no idea of what a key costs.

Data safety is the other headline: the agent has `Bash`/`Write`/`Edit` auto-approved with no
permission prompt and writable symlinks into the user's research folders; there is no trash,
no undo, no backup of user files, and the agent is told that read-only folders "will fail" when
in fact nothing enforces them. Privacy is undocumented in-product (zero user-facing words about
what leaves the machine), and crash reporting is a build-time coin flip nobody can see.

---

## 1. Boot sequence, as the code actually runs

`main/index.ts:881` `app.whenReady()`:

1. `:914-917` encrypt legacy plaintext secrets (safeStorage).
2. `:923-931` resolve the API key (env → settings). With none: **log line only** —
   `'[Auth] No Anthropic API key configured — user must add one in Settings'`. No UI state is set.
3. `:937` `refreshModels(bootCreds)` — background `GET /v1/models` to Anthropic (if a key exists).
4. `:959-961` analytics init — gated off, no-op (`main/coscientistAnalytics.ts:8-9`).
5. `:994-1015` DB init; if no workspace, `'[APP] No active workspace — creating a blank one.'`
   (`:1013-1014`) — a workspace is a boot invariant, so the app always lands on Home.
6. `:1152` `provisionWorkspace` (skills/hooks/CLAUDE.md render, caught so a failure cannot
   prevent the window). `:1162` `createMainWindow()`.
7. `:1221-1223` updater + tray; `:1252` global shortcut `Alt+Shift+A` (quick chat);
   `:1267` scheduler. A fatal startup error shows a native dialog
   `'Acabox - Startup Error' / 'The application failed to start…Check the log file for details: <path>'`
   (`:1276-1280`) — correct, but the log path is a developer answer.

The agent infrastructure (API proxy, agent server, hosted MCP, **eager Python venv bootstrap**)
is started by the **renderer**: `SetupBanner` mounts (`renderer/index.tsx:1123`), calls
`window.containerAPI.ensureSetup()` (`components/SetupBanner.tsx:77`), which runs
`container:ensureSetup` (`main/index.ts:1640-1650`) → `containerService.start()` →
`agentInfrastructure.start()` → `backgroundBuilder.startWatching()`.

Quit (`main/index.ts:3560-3583`): if tools are working, a native dialog
`'1 tool is still working.' / 'This work will keep running in the background and finish on its
own. Acabox will show you what happened the next time you open it.'` with
`Quit / Stop them and quit / Cancel`. Good plain-language copy; teardown correctly lives on
`will-quit` (`main/appTeardown.ts`).

---

## 2. The non-technical scientist, end to end

### 2.1 Download → Gatekeeper

- The build is **ad-hoc signed** (`forge.config.js:197-206` `postPackage` hook,
  `codesign --force --deep --sign -`), not notarized. `scripts/release.mjs:63-68` prints the
  expectation: `'Fresh downloads: quarantined, so first launch needs right-click → Open.'`
  The root CLAUDE.md repeats "right-click → Open" in several places.
- **Stale for the target OS.** Since macOS 15 Sequoia, right-click → Open no longer bypasses
  Gatekeeper for unsigned/unnotarized apps. The user sees a blocking sheet ("Apple could not
  verify… is free of malware", `Done` / `Move to Trash`), must then go to System Settings →
  Privacy & Security → scroll to "Open Anyway", authenticate, and re-open. None of this is on the
  release page: `scripts/release.mjs:144` creates the release with `--notes 'Acabox ${version}'`
  — the notes are literally the version string. The dmg (`forge.config.js:224-229`) carries no
  README. A scientist who sees "Move to Trash" will very plausibly click it.
- Only `arm64` is built (`release.mjs:46`, CLAUDE.md Known hazards). An Intel Mac user downloads
  a dmg that will not launch, with no label saying so.
- If the user runs Acabox from the dmg or `~/Downloads` instead of dragging to `/Applications`,
  it runs App-Translocated; everything works until the first update, which refuses with
  `'Acabox is running from a temporary location. Move it to /Applications and reopen it.'`
  (`main/selfUpdater.ts:100`) — and only after they click Download (`:276-279`); the boot
  preflight merely logs (`main/updater.ts:139-143`).

### 2.2 First launch

- **Keychain prompt before any UI.** CLAUDE.md (Conventions, 2026-08-05) root-caused that
  Chromium's OSCrypt keychain init runs before `whenReady` and, because every ad-hoc build has a
  new signature, macOS asks for Keychain authorization ("Acabox wants to use your confidential
  information stored in 'Acabox Safe Storage'…"). The user has no idea what this is. If they
  click Deny, see §2.8 for what breaks.
- Then the window: `Command desk` + date (`command-desk/CommandDesk.tsx:85-86`), a search button
  `Search chats, tools, files… ⌘K`, section `Tools — 0 of 0` with one card
  `Build a new tool / Describe it below — ACABOX scaffolds it` (`:147-148`), `Jump back in`:
  `No chats yet — start one below.` (`:164`), and `Drive — ~/workspace-data` (`:180`; the
  label is the basename of the internal workspace path, `renderer/index.tsx:1072`,
  `shared/paths.ts:9` `WORKSPACE_DATA_DIR = 'workspace-data'`) with
  `No files yet — share a folder in Settings.` (`:185`). The status bar shows
  `CPU 12% · MEM 9.1/16 GiB · DISK … · AGENTS 0 LIVE` (`command-desk/StatusBar.tsx:70-77`) and
  the chrome bar `ACABOX · V0.1.27 … STARTING/HEALTHY` (`command-desk/ChromeBar.tsx:38-46`).
- Composer placeholder: `'What are we building? — describe a tool, paste a repo, or ask'`
  (`components/GlobalComposer.tsx:74`). The empty chat says `Where to?` /
  `Describe a tool, paste a repo, or drop files — it takes it from there.`
  (`assistant-ui/thread.tsx:147-148`) with chips `Turn a script into an app`,
  `What's in my folders?`, `Build a PDF → BibTeX tool` (`:99-108`). "Paste a repo", "scaffolds",
  "script", "BibTeX" are developer vocabulary; two of three chips presume the user has code.
- **No first-run nudge of any kind.** Grep of `renderer/index.tsx` for `hasKey|No Anthropic|
  firstRun|welcome` finds nothing; CLAUDE.md Known hazards admits "There is no first-run nudge
  toward Settings". `SetupBanner` cannot help: it only renders on an error (§2.6).
- The rail exposes a **Debug** button to every user (`command-desk/Rail.tsx:103`,
  `title="Debug"`; no `isPackaged` gating anywhere in Rail/index). Inside: Logs, Kernels,
  Observations, File Monitor, Storage (with a Podman section), API Key, Scanned Files,
  Telemetry (buttons that throw test errors), Export, and **Hard Reset** with
  `Yes, Delete Everything` (`debug/HardResetDebug.tsx:79`).
- `Alt+Shift+A` is registered as a **system-wide** shortcut (`main/index.ts:1252`). On a Mac
  keyboard Option+Shift+A types `Å`; while Acabox runs, typing Å in any app opens the Acabox
  quick-chat window instead. Minor, but real for anyone writing Scandinavian names.

### 2.3 Getting and entering an API key

- The user's first message is refused with the one sentence
  `'No Anthropic API key configured. Add one in Settings.'` (`main/index.ts:486`, refused at
  `:2244-2247`, rendered as the message error). Nothing before that tells them a key is needed.
- Settings is `DirectoryPermissions.tsx`. The key lives in the **last** section, `Account`
  (`:365-397`), **below** `Rescan workspace`, after Workspace directories, System prompt,
  About you, Connectors, Claude Design, APIs and Sharing. A scientist told "Add one in Settings"
  scrolls past seven sections of vocabulary (`Connectors`, `Claude Design`, `APIs`, `Sharing`,
  `System prompt … Saved to .academia/SOUL.md` at `:236`) to find it.
- `components/ApiKeySettings.tsx:58`: `'No API key set. Paste one below to use Acabox.'`,
  placeholder `sk-ant-...` (`:79`), a second field `'Base URL (optional — defaults to
  api.anthropic.com)'` (`:80`), button `Save key` (`:89`). There is **no link** to the
  Anthropic Console anywhere in the product (grep `console.anthropic|platform.claude.com|
  Get an API key` → 0 hits), no mention that a key requires an Anthropic account with a prepaid
  balance, no pricing explanation, and no path for someone who already pays for a Claude
  subscription (the fork removed login; the SDK's OAuth login is not exposed —
  `skills/acabox/SKILL.md:278` "Requires an Anthropic API key (Settings → Account)").
- **No validation.** `auth:setApiKey` (`main/index.ts:2737-2771`) trims, rejects empty, saves,
  pushes to the agent, and returns `Saved.`. No format check, no test request. A pasted
  Console *organization id*, an OpenAI key, or a key with no billing all say `Saved.`. The
  verdict only arrives on the first chat turn: a 401 is translated to
  `'Your Anthropic API key was rejected. Update it in Settings and try again.'`
  (`main/agentSession.ts:822`, gated by `isAuthError` `:35-39` which requires "401"). Any
  other API failure — a 400 "credit balance is too low" on a key with no billing, a 429, a 529
  — is passed through **raw**: `agent-server/index.ts:751` → `agentSession.ts:1399
  emitError(errorMsg)` → `thread.tsx:346 <ErrorPrimitive.Message/>`. (Exact wording of the SDK's
  error text not verified live.) For the audience, "credit balance" from a product that never
  mentioned money is exactly the confusing moment.
- `auth:getApiKey` (`main/index.ts:2719-2722`) returns the **full plaintext key** to the
  renderer; masking happens client-side (`ApiKeySettings.tsx:20`). Connector/API secrets were
  deliberately kept off IPC (CLAUDE.md "Secrets never cross IPC"); the Anthropic key was not.
  Low user impact, inconsistent with the stated boundary.
- Inline styles reference tokens that do not exist in the design system
  (`var(--border-color, #555)`, `var(--error-color, …)` at `ApiKeySettings.tsx:78,81,105`) —
  the same class of defect CLAUDE.md fixed in `ClaudeDesignSettings` on 2026-09-23.

### 2.4 Adding folders

- `Workspace directories` → `Local folders` → `No local directories added.` → `Add folder`
  (`DirectoryPermissions.tsx:209-228`). The picker is a bare `showOpenDialog` with
  `['openDirectory','createDirectory']` and no title/message (`main/ipc/workspaceIpc.ts:28`) —
  nothing says what "sharing" means (the AI can read **and change** files here).
- **Only folders under the home directory are allowed**: `'Workspace directory must be within
  your home directory.'` (`main/controllers/WorkspaceController.ts:190-191`). An external SSD
  (`/Volumes/LabData`), a NAS share, or a lab server mount cannot be added at all. For many
  scientists that is where the data is. The sensitive-dir refusal reads `'Cannot create a
  workspace in a sensitive directory.'` (`:196`) — wrong verb for "Add folder".
- Read-only toggle: a lock button labelled `Read only` / `Editable` (`DirectoryPermBadge.tsx:24`),
  no tooltip, no sentence explaining the consequence. It is **advisory** (CLAUDE.md Known
  hazards). Worse, the agent is told two contradictory things: `agentSession.ts:591`
  `'- Name/ (read only) — make a copy inside the workspace before editing; direct edits will
  fail.'` (false — nothing fails) vs `skills/acabox/SKILL.md:271-273` `'Read-only folders are
  advisory… Nothing enforces it for you.'` The user, meanwhile, sees a padlock and reasonably
  believes it locks.
- Remove uses `window.confirm('Are you sure you want to remove this directory from your
  workspace?')` (`:117`). The 10-folder cap (`shared/paths.ts:12`) simply hides the button
  (`:222`) with no message.
- **macOS folder-access prompts.** `forge.config.js:143-145` sets
  `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` /
  `NSDownloadsFolderUsageDescription` = `'Acabox needs access to your Desktop/Documents/
  Downloads to manage workspace files.'`. The prompt appears the first time Acabox *or any of
  its child processes* (the agent's Bash, python, esbuild) touches the folder — i.e. typically
  **mid-turn**, while the agent is waiting; a Deny gives the agent `EPERM` and it will try
  workarounds. "Manage workspace files" does not tell the user why a chat app wants Documents.
  And because grants are keyed to the signature, **every update re-prompts** (CLAUDE.md,
  dictation entry).
- Folders added mid-conversation do not reach the running chat
  (`skills/acabox/SKILL.md:274-275`, CLAUDE.md Known hazards); the UI does not say "start a new
  chat".

### 2.5 First message

- Agent startup is shown as spinner text `'Starting agent service...'` / `'Waiting for
  agent...'` (`main/agentSession.ts:519-550`), with a 5-minute cap ending in
  `'Agent failed to start. Check the Debug panel for details.'` (`:526`). "Agent service" and
  "Debug panel" are developer words.
- With zero shared folders the agent gets no directory guidance at all (`agentSession.ts:587`
  only when `dirs.length > 0`); a question like "what's in my folders?" (one of the three
  chips) is answered against an empty workspace. Nothing in the UI connects the chip to "share a
  folder first".
- **The first scan never runs by itself.** The only trigger is `scanner:start`
  (`main/index.ts:1397`) from Settings → Account → a button labelled `Rescan` (`:392`) under
  `Rescan workspace / Re-scan your folders to refresh your research profile and file tags.`
  (`:371-374`) — "Re-scan" for something that has never scanned, disabled with 0 folders, no
  cost shown. The scan costs real money: research profile on `claude-sonnet-4-6` with
  `maxBudgetUsd: 2` (`main/directoryScanner/agents/researchProfile.ts:35-38`), file tagging on
  `claude-haiku-4-5-20251001` in batches (`agents/fileTagging.ts:39,125,430,580`), plus one
  Haiku call per manuscript producing `writing_agent` briefing cards that target the dropped
  Word overlay (CLAUDE.md Known hazards). So the "About you" profile and `Where to?` grounding
  stay empty unless the user finds a mislabelled button — and if they do, nothing told them it
  would spend a few dollars.

### 2.6 Python is missing (the stock-Mac case) — and the Command Line Tools dialog

- `main/pythonSetup.ts:60-85` `findSystemPython()` execs `python3` then `python` under the
  login-shell PATH. On a Mac without Xcode Command Line Tools, `/usr/bin/python3` is Apple's
  stub; **executing it shows the GUI dialog "The 'python3' command requires the command line
  developer tools. Would you like to install the tools now?"** (a multi-GB download) and exits
  non-zero. The code knows (`:82` `/* not in PATH, or a CLT stub that exits non-zero */`) but
  still runs it. (Dialog behaviour is Apple's documented shim behaviour; not reproduced here.)
- When does it run? **At every launch**, fire-and-forget:
  `main/controllers/AgentInfrastructureController.ts:550` `void ensurePythonVenv()` inside
  `start()`, which the renderer triggers on mount (§1). Result: a Python-less user gets Apple's
  developer-tools dialog on top of Acabox every time they open it, with no explanation, until
  they either install CLT (which "fixes" it by supplying Python 3.9) or install Python.
- The only user-actionable text — `'Install Python 3 via Homebrew (brew install python) or from
  python.org, then restart Acabox.'` (`:159`, `PythonSetupError.userActionable` `:90`) — is
  **read by nobody**: grep `userActionable` across `src/cobuilding` finds only its declaration.
  It reaches the log, or the agent as tool output via `packageInstaller.ts:280-282`
  (`'Python environment not available: …'`), so the user hears about Homebrew second-hand from
  the chat. The same applies to `git`, `make`, `gcc` — all CLT stubs on a stock Mac; any agent
  `git` command pops the same dialog.
- Where Python actually matters: notebooks/kernels (every tool's "Run"), pip installs. The
  kernel gateway start error `'Kernel gateway exited before becoming healthy … Is jupyter
  installed in <venv>?'` (`main/containerService.ts:1030-1033`) is kept in
  `lastKernelGatewayError`; how it is shown at tool-run time was not traced.
- `SetupBanner` cannot carry any of this: its stages are Podman-era
  (`'install-podman'`, `'download'`, `'pull'` at `SetupBanner.tsx:40-62`), `ensureSetup()` is a
  no-op (`containerService.ts:1077-1080`), and `makeSetupProgress` (`main/index.ts:443`) emits
  nothing. Its only live path is `Setup error <raw message> [Retry]` (`:110-118`) — e.g.
  `'Agent server failed to become healthy within 15s'` (`containerService.ts:578`) — with a
  stale `isPermissionError` check for `'Gatekeeper'|'quarantine'` (`:91`) and a hint about
  `System Settings > Privacy & Security`. `thread.tsx:124-133` still has
  `'Setting up environment… This may take a few minutes on first launch.'` for a state that
  never occurs, and `MiniAppViewer.tsx:707-708` shows `'Waiting for container...'`.

### 2.7 First tool build — needs Node.js, and the app never says so

- esbuild **is** bundled (`forge.config.js:70-95,118`; `miniAppBuilder.ts:63-75`). Good.
- But the scaffold is `node .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs`
  (`skills/manage-mini-application/SKILL.md:28-29`). The agent's subprocess PATH is venv bin +
  npm-site bin + the login-shell PATH (`containerService.ts:98-113`); there is no bundled
  `node` and no shim (grep `node-shim|ELECTRON_RUN_AS_NODE` → only the agent-server spawn,
  `:493`). macOS ships no Node. On a stock Mac, Step 1 of every tool fails with
  `node: command not found` (exit 127).
- Even with Node present: `SKILL.md:120-123` tells the agent `'Available packages (already
  installed — import them directly, no wrapper call needed): react, react-dom, react-plotly.js,
  lucide-react'`. **Nothing installs them.** Grep for `react` in `main/` → 0 hits;
  `syncMiniAppAssets` copies only `_bridge`/`_vendor` (`main/skills.ts:255-275`);
  the scaffold deliberately installs nothing (`manage_mini_app.mjs:360-367`). They reach the
  shared prefix only via `npm install -g --prefix` (`packageInstaller.ts:287-294`) — which,
  with no npm, throws `'npm is not installed. Install Node.js (https://nodejs.org or "brew
  install node") and try again.'` (`:290`). The dev and production `npm-site` on this machine
  contain react/react-dom/react-plotly.js/plotly.js/lucide-react because the agent installed
  them at some point; CLAUDE.md (2026-09-09) records the dev npm-site missing `lucide-react`
  and every tool failing to mount. A fresh install's first esbuild run ends in
  `Could not resolve "react"` → the `BUILD FAILED` card (`MiniAppViewer.tsx:443`, `:585-589`
  `'Build failed. / The rebundle didn't come up. Full output:'`) with
  `Send to chat — let it fix itself` (`:598`) — which it cannot, because the fix is "install
  Node.js".
- Nothing user-facing states the prerequisite. `README.md:13-20` lists Node/Python/Rust as
  **developer** prerequisites (Rust is build-only; `:20` still says `'An Academia.edu account
  (used for sign-in and Claude credentials)'` — login was removed). CLAUDE.md Known hazards says
  "Requires system Python 3.9+ and npm on PATH for Python/npm mini-app deps", which understates
  it: Node is needed to scaffold at all.
- Net: **"vibecoding" is unavailable to the target user until they install a developer runtime
  by hand**, and the first sign is a red BUILD FAILED screen quoting esbuild.

### 2.8 An update arrives

- 10 s after launch, a silent GitHub check (`main/updater.ts:148`). If newer: a 400×200
  window titled `Update Available` (`:40-67`) with `'Update v0.1.28 is available.'`,
  `Download & Restart` / `Cancel` (`renderer/update.tsx:60-64`), system-ui font, hard-coded
  `#4a9eff` buttons — outside the Command Desk design, no release notes (the release has
  none, §2.1), no download size (~190 MB), no "Later/Skip this version". Cancel → it returns
  next launch.
- Manual `Check for Updates...` in the tray (`main/tray.ts:32-40`): success shows a dialog
  (`updater.ts:107-119`), but an **error (offline, GitHub down) shows nothing** — the `error`
  handler only logs and sends to an update window that does not exist (`:124-128`); the menu
  label flips back after 5 s. The user learns nothing.
- Install path (`selfUpdater.ts`): download, sha512, `ditto`, validate, detached swap script,
  `app.quit()`. Solid. Failures surface in the update window as `'Update error: <message>'`.
- **After** the swap the app has a new ad-hoc signature, so on relaunch: the Keychain prompt
  again, and every TCC grant (Documents/Desktop/Downloads, microphone, speech) is re-asked
  (CLAUDE.md Known hazards). If the user denies the Keychain prompt — plausible for someone who
  has seen it three times with no explanation — `safeStorage.decryptString` throws,
  `decryptSecret` returns `''` (`main/secretStore.ts:74-82`), `getCustomAnthropicKey()` returns
  null, and the next message is refused with `'No Anthropic API key configured. Add one in
  Settings.'` although the key is on disk. Re-entering it then stores plaintext with only a
  log warning (`:51-61`). Mechanism-level finding; not run.

### 2.9 Other permission prompts the user will meet

- Microphone + Speech Recognition on first mic press — good strings
  (`forge.config.js:148-149`: `'…Audio is transcribed on this Mac and never leaves it.'`,
  `'…Audio is not sent to Apple or to Anthropic.'`). These two sentences are the **only**
  privacy copy in the product.
- Screenshot: system picker, no permission (`main/screenshotHost.ts:63-71`); below macOS 15:
  `'Capturing outside Acabox needs macOS 15 or later.'` (`:161`).
- Accessibility: the Rust file monitor (`rust/file-monitor-mac/src/main.rs:17-22` watches
  Word/Excel/PowerPoint/Preview; `:310-315` prompts for Accessibility and exits) is **not**
  auto-started — only from the Debug tab (`main/index.ts:1822`). Good. But its Word-overlay
  call sites survive: clicking a `.docx` in Files **opens Microsoft Word and docks the dropped
  overlay** instead of the in-app viewer (`renderer/index.tsx:759-764`
  `fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word')`; also `FilesTab.tsx:951`,
  `BriefingHistory.tsx:140`).

---

## 3. Data safety — what the agent can destroy, and what protects the user

- Auto-approved: `Bash, Read, Write, Edit, Glob, Grep, Agent, WebSearch, WebFetch…`
  (`shared/agentAllowedTools.ts:43-48`); "there is no `canUseTool` handler anywhere in Acabox"
  (`:11-16`). User folders are **writable symlinks** in the agent's cwd
  (`containerService.ts:200-255`).
- **No trash, no undo, no backup for user files.** `shell.trashItem|moveItemToTrash` appears
  nowhere in `main/` (grep). `<userData>/workspace-file-backups/` backs up **only**
  `settings.json` and the hook scripts (`main/skills.ts:88-95,120-127`). The skills trash is
  for skills. `main/migrateWorkspaceFiles.ts` only moves two legacy dirs. A `rm -rf
  MyResearch/old_runs` or an in-place `Edit` of a manuscript is permanent unless the user runs
  Time Machine.
- The agent's rules (`src/cobuilding/CLAUDE.md`) contain **no instruction** to confirm before
  deleting or overwriting user files (grep `delete|trash|confirm|destructive` → only `:29`,
  about the tool code dir). Read-only is advisory and mis-described to the agent (§2.4).
- Hard Reset (`main/ipc/debug.ts:573-605`) `rmSync`s the workspace dir; Node's `rmSync` unlinks
  symlinks rather than following them, so user folders survive — correct. But the UI list
  (`HardResetDebug.tsx:63-70`: chats, briefings, calendar, `.applications/`, `.academia/`)
  omits `tool-data/` — every tool's saved results are wiped too — and it sits one click deep in
  a tab every user can open.
- Good: deleting a tool keeps its data (`tool-data/`), manifests are written atomically,
  transcripts are reclaimed, the quit dialog never kills work silently.

---

## 4. Privacy — what leaves the machine, and what the user is told (nothing)

Egress found in code:

| Destination | When | Evidence |
|---|---|---|
| Anthropic API | every chat turn, title generation, scans, mini-app model calls via proxy | agent-server, `directoryScanner/*`, `main/apiProxy.ts` |
| Anthropic `GET /v1/models` | at boot (with key), on key save, 6 h cache | `main/index.ts:937`, `:2760`, `main/modelCatalog.ts` |
| GitHub (`iliasacademia/acabox-releases`) | 10 s after every launch + manual; update download | `main/updater.ts:148`, `selfUpdater.ts:287` |
| Arbitrary web | `WebSearch`/`WebFetch` auto-approved; skills hit PubMed/UniProt/etc. | `shared/agentAllowedTools.ts:47` |
| Configured HTTP APIs / MCP connectors | when the user adds them | Settings → APIs / Connectors |
| Cloudflare Workers (sharing) | only when the user configures site/API/token | `components/SharingSettings.tsx:98-99` |
| Sentry | **only if `SENTRY_DSN` was in the build environment** | `main/sentry.ts:29`, `webpack.plugins.js:14` |
| Claude Code CLI's own telemetry / Statsig / error reporting / update check | default behaviour; **no opt-out env is set** (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` → 0 hits) | grep `src/cobuilding` |

- **Crash reporting is a build-time coin flip.** `npm run make` does not load `.env.local`
  (`package.json` scripts: only `start` uses `dotenv`), and no `.env.local` exists in this
  checkout, so whether v0.1.27 ships with Sentry depends on the shell that ran the release.
  If it did: per-install id as Sentry user, release/environment tags, uncaught exceptions,
  `tracesSampleRate: 0.1`, session tracking (`main/sentry.ts:31-48`) — with no notice and no
  opt-out. Debug → Telemetry even offers buttons to throw test errors (`debug/TelemetryDebug.tsx`).
- `coscientistAnalytics.ts` (auth-gated off) and the `DATADOG_*`/`FULLSTORY_*`/
  `ONBOARDING_V2_ENABLED` defines (`webpack.plugins.js:12-17`) are dormant upstream residue.
- **In-product privacy text: none.** Grep of the renderer for `privacy|telemetry|crash report|
  leaves your|stays on your` finds only `SetupBanner`'s permission hint and the Debug tab. A
  scientist pointing this at unpublished data is told nothing about what Anthropic receives
  (every file the agent reads goes into the prompt), nor that web search is on by default.

---

## 5. Dead weight and stale guidance (candidates to delete or fix)

| Item | Why | Evidence |
|---|---|---|
| `components/SetupBanner.tsx`, `renderer/setupStore.ts` | Podman-era stages/strings; `ensureSetup` is a no-op; only a raw-error path is live | §2.6 |
| `components/ContainerTests.tsx` | unmounted anywhere; runs `ls /data` | grep: no importer |
| `debug/StorageDebug.tsx:54-59` | "Podman Binaries / VM Images / VM State" section | file |
| `renderer/grant-finder-entry.tsx`, `prebuilt-apps/grantFinder/` | grant finder was dropped; still packaged via `extraResource` (`forge.config.js:119`) | files |
| `components/FocusEditor.tsx`, `ReactionsSidebar.tsx`, `HomePage.tsx`, `BriefingHistory.tsx` | none imported by the app (`HomePage` has no importer; `BriefingHistory` only via it) | grep |
| Word-overlay call sites | `.docx` click launches Word + overlay docking | `renderer/index.tsx:759-764`, `FilesTab.tsx:951` |
| Rust file monitor + `activityQuery` | watches Office/Preview via Accessibility for the dropped overlay; only Debug can start it | `main.rs:17-22`, `main/index.ts:1822` |
| `writing_agent` briefings | one Haiku call per manuscript producing cards that open Word | CLAUDE.md Known hazards |
| `docs/AUTO_UPDATER.md`, `docs/FEED_SERVER.md` | describe S3/CloudFront + beta channel that no longer exist | heads |
| `docs/ARCHITECTURE.md`, `docs/AGENTS.md` | "Academia Electron", Word selection native module | heads |
| `README.md:13-20`, `:55` | developer prereqs presented as prerequisites; Academia account; points at `scripts/build-signed.sh`, superseded by `release.mjs` | file |
| `coscientistAnalytics.ts` + Datadog/Fullstory defines | permanently gated off | §4 |
| `renderer/update.html|tsx` | keep the window, but it needs the design system, notes, size, "Later" | §2.8 |
| Debug tab in the rail | developer surface (Hard Reset, Telemetry test throws, raw logs) exposed to end users | `Rail.tsx:103` |
| `Alt+Shift+A` global shortcut | steals Option+Shift+A (`Å`) system-wide | `main/index.ts:1252` |
| `MiniAppViewer.tsx:707-708` `'Waiting for container...'`, `thread.tsx:124-133` | copy for states that cannot occur | files |

---

## 6. What a first-run checklist / guided setup must include

Ordered by the moment the user hits it; every item is "real state or hidden" (no mocks):

1. **Before download (release page / dmg README):** Apple Silicon only; macOS 15 Gatekeeper
   steps with the exact "Open Anyway" path; "drag to Applications first"; what the Keychain
   prompt is and that clicking Allow is safe; that updates will re-ask for folder/mic access.
2. **Key step, in-app, on Home when `hasKey` is false:** one card — "Acabox runs on your own
   Anthropic account" → link to the Console API Keys page → "you'll need a small prepaid
   balance; a typical chat costs cents" → paste → **validate with one request that costs no
   model tokens** (`GET /v1/models` already exists in `modelCatalog.ts`) → "Key works" /
   "Rejected" / "No billing on this key". Say that a Claude.ai subscription is **not** a key.
3. **Folders step:** "Choose a folder Acabox may read and change" with the two consequences
   spelled out (reads go to Anthropic; edits are permanent — recommend a copy or Time Machine);
   heads-up that macOS will ask for Documents/Desktop access; external drives either allowed or
   explicitly explained as not yet supported.
4. **Optional tooling, detected without side effects:** "To *run* analyses, Acabox needs Python
   3.9+ (found: /opt/homebrew/bin/python3 3.12 ✓ / not found → Install from python.org)";
   "To *build* tools, Acabox needs Node.js (found ✓ / not found → nodejs.org)". Never execute
   `/usr/bin/python3` to find out; check known install locations and `xcode-select -p`.
5. **Privacy line + toggle:** what leaves the machine (table in §4), crash-report opt-in, web
   search on/off.
6. **First scan, opt-in with the price:** "Build my research profile — about N files, roughly
   $X, 1–3 minutes" (N from the folder, $X from the known per-batch cost).
7. **Done → one suggested first message** grounded in the shared folder, not "paste a repo".

---

## 7. Gaps (problems found), with severity for this audience

See the structured summary for the compressed list. Full list with evidence:

1. **HIGH · missing-feature — First tool build needs Node.js/npm; nothing bundles or says so.**
   `SKILL.md:28-29` (scaffold is `node …mjs`), `:120-123` (react "already installed" — false
   on a fresh machine), `packageInstaller.ts:290`, `containerService.ts:98-113` (no node on
   PATH), `forge.config.js` (esbuild bundled, node not). Outcome: BUILD FAILED with esbuild
   output and a "let it fix itself" button that cannot.
2. **HIGH · bug — Launch-time `python3` probe pops Apple's Command Line Tools installer on a
   stock Mac, every launch, unexplained.** `pythonSetup.ts:60-85,82`,
   `AgentInfrastructureController.ts:550`; the actionable message (`:159`) is read by no UI
   (`userActionable` has no consumer).
3. **HIGH · stale-guidance — Gatekeeper instructions ("right-click → Open") are wrong for
   macOS 15+, and the release carries no notes or install steps.** `release.mjs:63-68,144`;
   CLAUDE.md. Fresh users meet "Move to Trash".
4. **HIGH · risk — Agent can delete/overwrite research files with no confirmation, trash, undo
   or backup; read-only is advisory and mis-described to the agent as enforced.**
   `agentAllowedTools.ts:43-48,11-16`; no `trashItem` in `main/`; `skills.ts:88-95`
   (backups cover settings/hooks only); `agentSession.ts:591` vs `skills/acabox/SKILL.md:271`.
5. **HIGH · ux-friction — API key: no link to get one, no billing/pricing explanation, no
   validation, buried last in Settings under "Rescan", raw non-401 API errors.**
   `ApiKeySettings.tsx:58-89`, `DirectoryPermissions.tsx:365-397`, `index.ts:2737-2771`,
   `agentSession.ts:822,1399`, grep (no Console link).
6. **HIGH · missing-feature — No first-run state at all: no key prompt, no folder prompt, no
   prerequisite check; the user discovers everything by being refused.** `renderer/index.tsx`
   (grep), CLAUDE.md Known hazards.
7. **MEDIUM · risk — Privacy undocumented: nothing in-product says what goes to Anthropic, that
   web search/fetch are on, whether crash reports ship, or what the bundled CLI sends.** §4;
   `sentry.ts:29`; no `DISABLE_TELEMETRY`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
8. **MEDIUM · missing-feature — Folders outside the home directory (external drives, NAS)
   cannot be added.** `WorkspaceController.ts:190-191`; wrong-verb error at `:196`.
9. **MEDIUM · ux-friction — Update window: unprompted, off-design, no notes/size/"Later";
   manual check shows nothing on error; translocation refusal only after Download; every
   update re-triggers Keychain + TCC prompts.** `updater.ts:40-67,124-128,148`,
   `update.tsx:60-64`, `selfUpdater.ts:100,276-279`.
10. **MEDIUM · risk — A denied Keychain prompt after an update silently blanks the stored key
    ("No Anthropic API key configured") and re-saving falls back to plaintext.**
    `secretStore.ts:51-61,74-82` (mechanism; not run).
11. **MEDIUM · ux-friction — First scan is manual, mislabelled "Rescan", hidden under Account,
    costs a few dollars with no estimate.** `DirectoryPermissions.tsx:371-392`,
    `index.ts:1397`, `researchProfile.ts:35-38`, `fileTagging.ts:39`.
12. **MEDIUM · jargon — Home/composer/empty-chat copy assumes a developer** ("paste a repo",
    "scaffolds", "Turn a script into an app", "BibTeX", `Drive — ~/workspace-data`,
    `AGENTS 0 LIVE`, "System prompt … Saved to .academia/SOUL.md", "Base URL").
    `GlobalComposer.tsx:74`, `thread.tsx:100-108,148`, `CommandDesk.tsx:148,180`,
    `StatusBar.tsx:77`, `DirectoryPermissions.tsx:236`, `ApiKeySettings.tsx:80`.
13. **MEDIUM · ux-friction — macOS folder-access prompts fire mid-turn from child processes
    with the vague reason "to manage workspace files", and re-fire after every update.**
    `forge.config.js:143-145`.
14. **MEDIUM · dead-code — Debug tab (Hard Reset "Yes, Delete Everything", Telemetry test
    throws, Podman storage section) is exposed to every user.** `Rail.tsx:103`,
    `HardResetDebug.tsx:63-79`, `StorageDebug.tsx:54-59`.
15. **LOW · dead-code — SetupBanner/setupStore (Podman), ContainerTests, grant finder entry +
    prebuilt app, FocusEditor/ReactionsSidebar/HomePage/BriefingHistory, Word-overlay call
    sites, Rust file monitor, S3/CloudFront docs, README prerequisites and Academia account
    line, analytics + Datadog/Fullstory defines.** §5.
16. **LOW · bug — Clicking a `.docx` in Files opens Microsoft Word and the dropped overlay
    instead of the in-app viewer.** `renderer/index.tsx:759-764`.
17. **LOW · ux-friction — `Alt+Shift+A` global hotkey hijacks typing `Å` in every app.**
    `main/index.ts:1252`.
18. **LOW · risk — Full API key crosses IPC to the renderer.** `index.ts:2719-2722`.
19. **LOW · stale-guidance — Hard Reset list omits `tool-data/` (results are wiped too).**
    `HardResetDebug.tsx:63-70`, `ipc/debug.ts:577-580`.
20. **LOW · ux-friction — Intel Macs get an arm64-only dmg with no label.** `release.mjs:46`.

---

## 8. Ideas (each with model calls per use and effort)

1. **Zero-install tool building.** Ship a `node` shim on the subprocess PATH that execs
   `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (the app already does this for the agent
   server, `containerService.ts:493`), and vendor react/react-dom/react-plotly.js/plotly.js/
   lucide-react as a prebuilt tarball seeded into `npm-site` at provisioning (or as esbuild
   aliases to `_vendor/`). Removes the Node.js prerequisite for scaffolding and the first build.
   **0 model calls; M.** (npm is still needed for *extra* packages — say so at that moment.)
2. **Bundle Python** via python-build-standalone (CLAUDE.md already names it) so "Run" works on
   a stock Mac and the CLT dialog can never appear. **0 model calls; L.**
   Interim **S** fix: never execute `python3` from PATH at launch; probe known absolute
   locations and `xcode-select -p` first, defer the probe to first notebook use, and show the
   `userActionable` text in the tool viewer with a python.org link.
3. **Key setup card on Home (shown only while `hasKey` is false) + validation on save** using
   `GET /v1/models` (already implemented, no tokens), with the three verdicts and a Console
   link; move `Account` to the top of Settings. **0 model calls; S.**
4. **Plain-language API errors**: map `credit balance`/`billing`, `rate_limit`, `overloaded`
   to one sentence each with the next step. **0 model calls; S.**
5. **Safety net for user files**: PreToolUse hook that routes `rm` to the macOS Trash
   (`osascript`/`trash`), snapshots any file under a shared folder before `Edit`/`Write` into
   `<userData>/file-backups/<chat>/`, surfaces "Changed by Claude · Restore" on the Files tab,
   and actually enforces read-only (the Known hazard) by denying writes under read-only roots.
   **0 model calls; M.**
6. **Privacy page in Settings**: the §4 table as static text, a crash-reports toggle (default
   off until shown), web search on/off, and set `DISABLE_TELEMETRY=1` /
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the agent-server env. **0 model calls; S.**
7. **Allow folders anywhere except a sensitive denylist** (`/System`, `~/Library/Keychains`,
   `.ssh`…); add `NSRemovableVolumesUsageDescription`. **0 model calls; S.**
8. **Update UX**: Command Desk styling, release notes from the GitHub release body (give
   `release.mjs` a notes file), download size, "Later"; show the translocation warning at boot
   with a "Move to Applications" action; tell the user before relaunch that macOS will re-ask
   for Keychain/folder access. **0 model calls; S-M.** Long-term: a Developer ID removes the
   Gatekeeper dance, the Keychain/TCC churn, and lets Squirrel replace `selfUpdater.ts`.
   **0 model calls; L (process, not code).**
9. **Scan as an opt-in with a price**: rename to "Build my research profile", show file count
   and a cost estimate computed from batch sizes, run it from the Home card. **The scan itself
   is ~1 Sonnet + N/batch Haiku calls (already the case); the UX change is 0; S.**
10. **Hide Debug** behind a Settings toggle or `--debug`; move Export out to Settings.
    **0; S.**
11. **Delete the dead weight in §5** and fix README/docs. **0; S-M.**
12. **Copy pass for non-coders** on Home/composer/empty chat/Settings labels. **0; S.**

---

## 9. Open questions / not verified here

- Was `SENTRY_DSN` present when v0.1.27 was built? (Decides whether crash reports ship today.)
- What does the bundled Claude Code CLI send in SDK mode with no opt-out env (Statsig,
  Sentry, update check)?
- Exact dialog text and flow of macOS 15/26 Gatekeeper for this ad-hoc bundle on a fresh Mac.
- Whether `execFile('python3')` from a GUI app shows Apple's CLT dialog (expected yes; not run).
- Whether a denied Keychain prompt after an update really blanks the key (mechanism clear).
- How a kernel-gateway start failure (`lastKernelGatewayError`) is shown when a tool's Run
  button is pressed without Python.
- Whether `.docx` → Word routing happens for users without Word installed (error vs no-op).
